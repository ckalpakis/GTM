import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { URL as NodeURL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { Database, normalizeLinkedInUrl, OPT_OUT_TEXT } from '../src/db.ts';
import type { NewContact } from '../src/db.ts';
import worker from '../src/index.ts';
import { APIFY_ACTOR, createPostSource, ENGAGEMENT_SOURCE } from '../src/sourcing.ts';
import { createIcpScorer } from '../src/icp.ts';
import { createMessageDrafter } from '../src/drafting.ts';

let mf: Miniflare;
let binding: D1Database;
let db: Database;
let counter = 0;
const now = () => Math.floor(Date.now() / 1000);

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'test-worker',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-09-17',
      d1Databases: { DB: 'test-outbound-agent' },
    }],
  }));
  binding = await mf.getD1Database('DB') as unknown as D1Database;
  for (const file of ['0001_initial_schema.sql', '0002_compliance_guards.sql', '0003_contact_engagement_source.sql', '0004_icp_scoring_gate.sql']) {
    const sql = await readFile(new NodeURL(`../migrations/${file}`, import.meta.url), 'utf8');
    await binding.batch(unstable_splitSqlQuery(sql).map(statement => binding.prepare(statement)));
  }
  // Exercise the table-rebuild migration with real historical rows, not just an empty schema.
  await binding.prepare(`
    INSERT INTO contacts (id, linkedin_url, source_post_url, collected_at, retention_expires_at, icp_status, intent_score)
    VALUES ('migration-contact', 'https://www.linkedin.com/in/migration-contact', 'https://www.linkedin.com/posts/example',
      unixepoch(), unixepoch() + 86400, 'qualified', 3)
  `).run();
  for (const status of ['draft', 'queued', 'sent', 'failed', 'cancelled']) {
    await binding.prepare(`INSERT INTO messages VALUES (?, 'migration-contact', ?, ?, ?, ?)`)
      .bind(`migration-${status}`, `Historical note. ${OPT_OUT_TEXT}`, status,
        status === 'sent' ? now() : null, ['queued', 'sent'].includes(status) ? 1 : 0).run();
  }
  const migration = await readFile(new NodeURL('../migrations/0005_drafted_message_status.sql', import.meta.url), 'utf8');
  await binding.batch(unstable_splitSqlQuery(migration).map(statement => binding.prepare(statement)));
  const sendMigration = await readFile(new NodeURL('../migrations/0006_send_attempts.sql', import.meta.url), 'utf8');
  await binding.batch(unstable_splitSqlQuery(sendMigration).map(statement => binding.prepare(statement)));
  db = new Database(binding);
});

after(async () => { await mf?.dispose(); });

function contact(overrides: Partial<NewContact> = {}) {
  return db.createContact({
    linkedin_url: `https://www.linkedin.com/in/test-${++counter}`,
    name: "Jane O'Connor",
    source_post_url: 'https://www.linkedin.com/posts/example',
    collected_at: now(),
    retention_seconds: 86400,
    sources: { linkedin_url: 'apify:test', name: 'apify:test', source_post_url: 'apify:test' },
    ...overrides,
  });
}

test('contact + provenance round trip; boolean decoding and original retention', async () => {
  const row = await contact();
  assert.equal(row.suppressed, false);
  assert.equal(row.retention_expires_at, row.collected_at + 86400);
  assert.equal((await db.getProvenance(row.id)).length, 3);
  await db.updateQualification(row.id, 'qualified', 4);
  assert.equal((await db.getContact(row.id))?.retention_expires_at, row.retention_expires_at);
  assert.equal((await db.getContact(row.id))?.name, "Jane O'Connor");
  await assert.rejects(binding.prepare('UPDATE contacts SET collected_at = collected_at + 1 WHERE id = ?')
    .bind(row.id).run(), /immutable/);
  await assert.rejects(binding.prepare('UPDATE contacts SET retention_expires_at = retention_expires_at + 1 WHERE id = ?')
    .bind(row.id).run(), /immutable/);
  await assert.rejects(contact({ linkedin_url: row.linkedin_url }), /Duplicate contact/);
  await assert.rejects(binding.prepare(`
    INSERT OR REPLACE INTO contacts (id, linkedin_url, source_post_url, collected_at, retention_expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(row.id, row.linkedin_url, row.source_post_url, now(), now() + 999999).run(), /Duplicate contact/);
});

test('missing provenance is rejected before any contact is inserted', async () => {
  await assert.rejects(contact({ id: 'missing-provenance', sources: {} }), /Missing provenance/);
  assert.equal(await db.getContact('missing-provenance'), null);
});

test('suppression survives cleanup, cannot be changed, and applies on recollection', async () => {
  const row = await contact({ collected_at: now() - 100, retention_seconds: 1 });
  await db.suppress(row.linkedin_url, 'STOP reply');
  const suppression = await db.getSuppression(row.linkedin_url);
  await db.suppress(row.linkedin_url, 'duplicate');
  assert.deepEqual(await db.getSuppression(row.linkedin_url), suppression);
  await assert.rejects(binding.prepare('DELETE FROM suppression_list WHERE linkedin_url = ?')
    .bind(row.linkedin_url).run(), /permanent/);
  await assert.rejects(binding.prepare('UPDATE suppression_list SET reason = ? WHERE linkedin_url = ?')
    .bind('changed', row.linkedin_url).run(), /immutable/);
  await binding.prepare('INSERT OR REPLACE INTO suppression_list VALUES (?, ?, ?)')
    .bind(row.linkedin_url, 'replacement', now()).run();
  assert.deepEqual(await db.getSuppression(row.linkedin_url), suppression);
  await db.createDraft(row.id, 'Hello');
  assert.equal(await db.deleteExpiredContacts(), 1);
  assert.equal(await db.getContact(row.id), null);
  assert.deepEqual(await db.getProvenance(row.id), []);
  assert.deepEqual(await db.listMessages(row.id), []);
  assert.deepEqual(await db.getSuppression(row.linkedin_url), suppression);
  const recollected = await contact({ linkedin_url: row.linkedin_url });
  assert.equal(recollected.suppressed, true);
  await assert.rejects(binding.prepare('UPDATE contacts SET suppressed = 0 WHERE id = ?')
    .bind(recollected.id).run(), /reversed/);
});

test('queue requires opt-out text; suppression cancels queued messages', async () => {
  const row = await contact();
  await db.updateQualification(row.id, 'qualified', 3);
  const message = await db.createDraft(row.id, 'Hello Jane');
  assert.equal(message.compliance_checked, false);
  assert.ok(message.draft_text.endsWith(OPT_OUT_TEXT));
  assert.equal(await db.queueReviewedMessage(message.id), true);
  assert.equal((await db.getSendableMessage(message.id))?.compliance_checked, true);
  await assert.rejects(binding.prepare('UPDATE messages SET draft_text = ? WHERE id = ?')
    .bind('Edited message', message.id).run(), /unchecked draft/);
  await db.suppress(row.linkedin_url, 'STOP');
  assert.equal((await db.getMessage(message.id))?.status, 'cancelled');
  assert.equal(await db.getSendableMessage(message.id), null);
  const suppressedDraft = await db.createDraft(row.id, 'Hello again');
  await assert.rejects(db.queueReviewedMessage(suppressedDraft.id), /suppressed/);
});

test('raw SQL cannot queue missing opt-out text or an unchecked message', async () => {
  const row = await contact();
  await db.updateQualification(row.id, 'qualified', 3);
  for (const [text, checked] of [['No opt-out', 1], [OPT_OUT_TEXT, 0]]) {
    await assert.rejects(binding.prepare(`
      INSERT INTO messages (id, contact_id, draft_text, status, compliance_checked)
      VALUES (?, ?, ?, 'queued', ?)
    `).bind(crypto.randomUUID(), row.id, text, checked).run(), /CHECK constraint/);
  }
});

test('expired contacts cannot queue and direct suppression flags are permanent', async () => {
  const expired = await contact({ collected_at: now() - 100, retention_seconds: 1 });
  await db.updateQualification(expired.id, 'qualified', 3);
  const draft = await db.createDraft(expired.id, 'Hello');
  await assert.rejects(db.queueReviewedMessage(draft.id), /expired/);
  const active = await contact();
  await binding.prepare('UPDATE contacts SET suppressed = 1 WHERE id = ?').bind(active.id).run();
  assert.ok(await db.getSuppression(active.linkedin_url));
});

test('identity normalization prevents common URL variants from evading suppression', async () => {
  const url = 'http://uk.linkedin.com/in/JANE-DOE/?trk=example#profile';
  assert.equal(normalizeLinkedInUrl(url), 'https://www.linkedin.com/in/jane-doe');
  await db.suppress(url, 'Opted out');
  assert.ok(await db.getSuppression('https://linkedin.com/in/jane-doe'));
  assert.throws(() => normalizeLinkedInUrl('https://linkedin.com.evil.example/in/jane'));
});

test('health endpoint checks the migrated D1 database', async () => {
  const response = await worker.fetch(new Request('https://example.test/health'), { DB: binding, DAILY_SEND_CAP: '0', MAX_SENDS_PER_RUN: '0' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

const post = 'https://www.linkedin.com/posts/example-activity-123456789';
const reactor = (slug: string) => ({
  reactorName: 'Jane Doe', reactorHeadline: 'Founder',
  reactorProfileUrl: `https://www.linkedin.com/in/${slug}/?trk=example`, reactionType: 'LIKE',
});
const runResponse = (status: string) => Response.json({ data: {
  id: 'run-test', status, defaultDatasetId: 'dataset-test',
} });
function sourcing(fetcher: typeof fetch, time = Date.now) {
  return createPostSource({ DB: binding, APIFY_TOKEN: 'fake-token', CONTACT_RETENTION_SECONDS: '86400' }, {
    fetch: fetcher, now: time, sleep: async () => {},
  });
}

test('Apify polling, pagination, field mapping, suppression, duplicates and provenance', async () => {
  await db.suppress('https://linkedin.com/in/apify-suppressed', 'Opted out');
  const existing = await contact({ linkedin_url: 'https://linkedin.com/in/apify-existing' });
  let calls = 0;
  const collectedAt = now();
  const sourceFromPost = sourcing(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-token');
    assert.equal(url.searchParams.has('token'), false);
    calls++;
    switch (calls) {
      case 1:
        assert.equal(url.pathname, `/v2/actors/${APIFY_ACTOR}/runs`);
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)).postUrls, [{ url: post }]);
        assert.equal(JSON.parse(String(init?.body)).parseAll, true);
        return runResponse('READY');
      case 2:
        assert.equal(url.pathname, '/v2/actor-runs/run-test');
        assert.equal(url.searchParams.get('waitForFinish'), '60');
        return runResponse('RUNNING');
      case 3: return runResponse('SUCCEEDED');
      case 4:
        assert.equal(url.pathname, '/v2/datasets/dataset-test/items');
        assert.equal(url.searchParams.get('offset'), '0');
        return Response.json([
          reactor('apify-new'), reactor('apify-suppressed'), reactor('apify-existing'),
          {}, { ...reactor('bad'), reactorProfileUrl: 'https://evil.example/in/bad' },
          ...Array.from({ length: 95 }, () => reactor('apify-new')),
        ]);
      case 5:
        assert.equal(url.searchParams.get('offset'), '100');
        return Response.json([{ ...reactor('apify-last'), reactorHeadline: null }]);
      default: throw new Error('Unexpected API request');
    }
  }, () => collectedAt * 1000);
  const result = await sourceFromPost(`${post}?trk=tracking`);
  assert.deepEqual(result, { runId: 'run-test', datasetId: 'dataset-test', fetched: 101, inserted: 2, skipped: 97, invalid: 2 });
  assert.equal(calls, 5);
  assert.equal(await db.findContactByLinkedInUrl('https://linkedin.com/in/apify-suppressed'), null);
  assert.deepEqual(await db.getContact(existing.id), existing);
  const row = await db.findContactByLinkedInUrl('https://linkedin.com/in/apify-new');
  assert.ok(row);
  assert.equal(row.name, 'Jane Doe');
  assert.equal(row.headline, 'Founder');
  assert.equal(row.reaction_type, 'LIKE');
  assert.equal(row.source, ENGAGEMENT_SOURCE);
  assert.equal(row.source_post_url, post);
  assert.equal(row.collected_at, collectedAt);
  assert.equal(row.retention_expires_at, collectedAt + 86400);
  const provenance = await db.getProvenance(row.id);
  assert.equal(provenance.length, 5);
  assert.ok(provenance.every(field => field.source === ENGAGEMENT_SOURCE && field.collected_at === collectedAt));
});

test('Apify terminal failures never fetch or ingest the dataset', async () => {
  for (const status of ['FAILED', 'ABORTED', 'TIMED-OUT']) {
    let calls = 0;
    await assert.rejects(sourcing(async () => { calls++; return runResponse(status); })(post), new RegExp(status));
    assert.equal(calls, 1);
  }
});

test('Apify API failures redact bodies and do not retry run creation', async () => {
  let calls = 0;
  await assert.rejects(sourcing(async () => {
    calls++;
    return new Response('fake-token private data', { status: 500 });
  })(post), error => error instanceof Error && error.message === 'Apify HTTP 500');
  assert.equal(calls, 1);
});

test('Apify retries transient GET failures and handles an empty dataset', async () => {
  let calls = 0;
  const result = await sourcing(async () => {
    calls++;
    if (calls === 1) return runResponse('SUCCEEDED');
    if (calls === 2) return new Response('', { status: 429 });
    return Response.json([]);
  })(post);
  assert.equal(result.fetched, 0);
  assert.equal(calls, 3);
});

test('Apify input, configuration and malformed responses fail explicitly', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(sourcing(fetcher)('https://example.com/posts/123'), /LinkedIn post/);
  await assert.rejects(createPostSource({ DB: binding }, { fetch: fetcher })(post), /APIFY_TOKEN/);
  await assert.rejects(createPostSource({ DB: binding, APIFY_TOKEN: 'fake' }, { fetch: fetcher })(post), /RETENTION/);
  assert.equal(calls, 0);
  await assert.rejects(sourcing(fetcher)(post), /Invalid Apify run/);
  let datasetCalls = 0;
  await assert.rejects(sourcing(async () => ++datasetCalls === 1 ? runResponse('SUCCEEDED') : Response.json({ items: [] }))(post), /Invalid Apify dataset/);
});

test('Apify wait has a deadline and identifies the unfinished run', async () => {
  let time = Date.now();
  let calls = 0;
  await assert.rejects(sourcing(async () => {
    calls++;
    time += 601_000;
    return runResponse('RUNNING');
  }, () => time)(post), /timed out \(run run-test\)/);
  assert.equal(calls, 1);
});

test('concurrent imports deduplicate atomically without resetting retention', async () => {
  const input: NewContact = {
    linkedin_url: 'https://linkedin.com/in/concurrent-import', source_post_url: post,
    collected_at: now(), retention_seconds: 86400,
    sources: { linkedin_url: ENGAGEMENT_SOURCE, source_post_url: ENGAGEMENT_SOURCE },
  };
  const results = await Promise.all([db.importContact(input), db.importContact(input)]);
  assert.equal(results.filter(Boolean).length, 1);
  const row = results.find(Boolean)!;
  assert.equal((await db.getProvenance(row.id)).length, 2);
  await db.suppress(input.linkedin_url, 'STOP');
  assert.equal(await db.importContact(input), null);
});

function icpResponse(decision: unknown) {
  return Response.json({ status: 'completed', output: [{
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(decision) }],
  }] });
}
function scorer(fetcher: typeof fetch) {
  return createIcpScorer({
    DB: binding, OPENAI_API_KEY: 'fake-openai-key',
    ICP_CRITERIA: 'Founders of B2B software companies; exclude students.',
  }, fetcher);
}

test('ICP sends only headline/company, stores a fit, and permits reviewed queueing', async () => {
  const row = await contact({ headline: 'Founder', company: 'B2B software', sources: {
    linkedin_url: 'test', name: 'test', source_post_url: 'test', headline: 'test', company: 'test',
  } });
  const draft = await db.createDraft(row.id, 'Hello');
  assert.equal(await db.queueReviewedMessage(draft.id), false);
  const result = await scorer(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fake-openai-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.match(body.instructions, /Founders of B2B software/);
    assert.deepEqual(JSON.parse(body.input[0].content), { headline: row.headline, company: row.company });
    return icpResponse({ icp_fit: true, intent_score: 1 });
  })(row);
  assert.deepEqual(result, { icp_fit: true, intent_score: 1 });
  const saved = await db.getContact(row.id);
  assert.equal(saved?.icp_status, 'qualified');
  assert.equal(saved?.intent_score, 1);
  assert.equal(saved?.retention_expires_at, row.retention_expires_at);
  assert.equal(await db.queueReviewedMessage(draft.id), true);
  assert.ok(await db.getSendableMessage(draft.id));
});

test('false ICP fit overrides any score and cancels an existing queued message', async () => {
  const row = await contact();
  await db.updateQualification(row.id, 'qualified', 5);
  const draft = await db.createDraft(row.id, 'Hello');
  await db.queueReviewedMessage(draft.id);
  const result = await scorer(async () => {
    assert.equal((await db.getContact(row.id))?.icp_status, 'pending');
    assert.equal(await db.getSendableMessage(draft.id), null);
    return icpResponse({ icp_fit: false, intent_score: 99 });
  })(row);
  assert.deepEqual(result, { icp_fit: false, intent_score: null });
  assert.equal((await db.getContact(row.id))?.icp_status, 'rejected');
  assert.equal((await db.getContact(row.id))?.intent_score, null);
  assert.equal((await db.getMessage(draft.id))?.status, 'cancelled');
  const next = await db.createDraft(row.id, 'Another draft');
  assert.equal(await db.queueReviewedMessage(next.id), false);
  await assert.rejects(binding.prepare("UPDATE messages SET status = 'queued', compliance_checked = 1 WHERE id = ?")
    .bind(next.id).run(), /positive ICP fit/);
  await assert.rejects(binding.prepare('UPDATE contacts SET intent_score = 5 WHERE id = ?')
    .bind(row.id).run(), /other statuses require NULL/);
});

test('pending contacts cannot bypass the ICP gate through direct SQL', async () => {
  const row = await contact();
  await assert.rejects(binding.prepare(`
    INSERT INTO messages (id, contact_id, draft_text, status, compliance_checked)
    VALUES (?, ?, ?, 'queued', 1)
  `).bind(crypto.randomUUID(), row.id, OPT_OUT_TEXT).run(), /positive ICP fit/);
  await assert.rejects(db.updateQualification(row.id, 'qualified', 6), /between 1 and 5/);
  await db.updateQualification(row.id, 'rejected', 100);
  assert.equal((await db.getContact(row.id))?.intent_score, null);
});

test('invalid ICP output, refusal and incomplete responses leave contacts unqualified', async () => {
  const invalid = [
    { icp_fit: 'true', intent_score: 5 }, { intent_score: 5 },
    ...[null, 0, 6, 2.5, '5'].map(intent_score => ({ icp_fit: true, intent_score })),
  ];
  for (const decision of invalid) {
    const row = await contact();
    await assert.rejects(scorer(async () => icpResponse(decision))(row));
    assert.equal((await db.getContact(row.id))?.icp_status, 'pending');
    assert.equal((await db.getContact(row.id))?.intent_score, null);
  }
  for (const response of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not JSON' }] }] },
  ]) {
    const row = await contact();
    await assert.rejects(scorer(async () => Response.json(response))(row));
    assert.equal((await db.getContact(row.id))?.icp_status, 'pending');
  }
});

test('ICP HTTP and transport failures are redacted and invalidate previous approval', async () => {
  for (const status of [401, 429, 500]) {
    const row = await contact();
    await db.updateQualification(row.id, 'qualified', 5);
    await assert.rejects(scorer(async () => new Response('secret response body', { status }))(row),
      error => error instanceof Error && error.message === `OpenAI ICP HTTP ${status}`);
    assert.equal((await db.getContact(row.id))?.icp_status, 'pending');
  }
  await assert.rejects(scorer(async () => { throw new Error('fake-openai-key'); })(await contact()),
    error => error instanceof Error && error.message === 'OpenAI ICP request failed');
});

test('ICP requires explicit criteria and skips suppressed, expired and stale contacts', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return icpResponse({ icp_fit: true, intent_score: 5 }); };
  const row = await contact();
  await assert.rejects(createIcpScorer({ DB: binding, OPENAI_API_KEY: 'fake' }, fetcher)(row), /ICP_CRITERIA/);
  await assert.rejects(createIcpScorer({ DB: binding, ICP_CRITERIA: 'test' }, fetcher)(row), /OPENAI_API_KEY/);
  await assert.rejects(scorer(fetcher)({ ...row, headline: 'stale input' }), /stale/);
  await db.suppress(row.linkedin_url, 'STOP');
  await assert.rejects(scorer(fetcher)(row), /suppressed/);
  const expired = await contact({ collected_at: now() - 100, retention_seconds: 1 });
  await assert.rejects(scorer(fetcher)(expired), /expired/);
  assert.equal(calls, 0);
});

test('a late positive ICP result cannot overwrite a newer rejection', async () => {
  const row = await contact();
  let release!: (response: Response) => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const delayed = scorer(async () => {
    started();
    return new Promise<Response>(resolve => { release = resolve; });
  })(row);
  await waiting;
  await scorer(async () => icpResponse({ icp_fit: false, intent_score: null }))(row);
  const rejected = assert.rejects(delayed, /superseded/);
  release(icpResponse({ icp_fit: true, intent_score: 5 }));
  await rejected;
  assert.equal((await db.getContact(row.id))?.icp_status, 'rejected');
});

test('suppression or profile changes during scoring invalidate the response', async () => {
  for (const change of ['suppress', 'profile']) {
    const row = await contact();
    await assert.rejects(scorer(async () => {
      if (change === 'suppress') await db.suppress(row.linkedin_url, 'STOP');
      else await binding.prepare('UPDATE contacts SET headline = ? WHERE id = ?').bind('Changed', row.id).run();
      return icpResponse({ icp_fit: true, intent_score: 5 });
    })(row), /eligibility changed/);
    assert.equal((await db.getContact(row.id))?.icp_status, 'pending');
  }
});

function drafter(fetcher: typeof fetch) {
  return createMessageDrafter({ DB: binding, OPENAI_API_KEY: 'fake-openai-key' }, fetcher);
}
function selectedDraft(init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body));
  const choices: string[] = body.text.format.schema.properties.draft_text.enum;
  return choices[0]!;
}

test('drafted status migration preserves historical messages, indexes and safety triggers', async () => {
  assert.equal((await db.getMessage('migration-draft'))?.status, 'drafted');
  assert.equal((await db.getMessage('migration-draft'))?.compliance_checked, false);
  for (const status of ['queued', 'sent', 'failed', 'cancelled']) {
    const message = await db.getMessage(`migration-${status}`);
    assert.equal(message?.status, status);
    assert.equal(message?.draft_text, `Historical note. ${OPT_OUT_TEXT}`);
    assert.equal(message?.sent_at !== null, status === 'sent');
  }
  const indexes = await binding.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
    .all<{ name: string }>();
  assert.ok(indexes.results.some(index => index.name === 'messages_contact_idx'));
  assert.ok(indexes.results.some(index => index.name === 'messages_status_idx'));
  await db.suppress('https://www.linkedin.com/in/migration-contact', 'STOP');
  assert.equal((await db.getMessage('migration-draft'))?.status, 'cancelled');
  assert.equal((await db.getMessage('migration-queued'))?.status, 'cancelled');
  assert.equal((await db.getMessage('migration-sent'))?.status, 'sent');
  await binding.prepare("DELETE FROM contacts WHERE id = 'migration-contact'").run();
  assert.equal(await db.getMessage('migration-sent'), null);
  assert.ok(await db.getSuppression('https://www.linkedin.com/in/migration-contact'));
});

test('draftMessage saves a personalized grounded note, under 300 characters and unchecked', async () => {
  const row = await contact();
  const message = await drafter(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.match(body.instructions, /Never invent prior contact/);
    assert.equal(JSON.parse(body.input[0].content).source_post_url, row.source_post_url);
    return icpResponse({ draft_text: selectedDraft(init) });
  })(row);
  assert.equal(message.status, 'drafted');
  assert.equal(message.compliance_checked, false);
  assert.equal(message.sent_at, null);
  assert.equal(message.contact_id, row.id);
  assert.match(message.draft_text, /^Hi Jane,/);
  assert.ok(message.draft_text.includes(row.source_post_url));
  assert.ok(message.draft_text.endsWith(OPT_OUT_TEXT));
  assert.ok(message.draft_text.length < 300);
  assert.deepEqual(await db.getMessage(message.id), message);
  assert.deepEqual(await db.getContact(row.id), row);
  assert.equal(await db.queueReviewedMessage(message.id), false); // Pending ICP is still blocked.
});

test('invented prior contact, incorrect post, missing opt-out and overlong output are not saved', async () => {
  for (const draft_text of [
    `Great meeting you yesterday! ${post}. ${OPT_OUT_TEXT}`,
    `Following up on our chat about ${post}. ${OPT_OUT_TEXT}`,
    `Your post about AI was amazing. ${post}. ${OPT_OUT_TEXT}`,
    `Hi Jane, I saw your reaction on https://www.linkedin.com/posts/wrong. ${OPT_OUT_TEXT}`,
    'Hi Jane, open to connecting?',
    'x'.repeat(300),
  ]) {
    const row = await contact();
    await assert.rejects(drafter(async () => icpResponse({ draft_text }))(row), /grounded wording/);
    assert.deepEqual(await db.listMessages(row.id), []);
  }
});

test('draft length includes footer and whitespace: 299 allowed, 300 rejected', async () => {
  const row = await contact();
  const text = 'x'.repeat(299 - OPT_OUT_TEXT.length) + OPT_OUT_TEXT;
  assert.equal((await db.saveConnectionNote(row, text)).draft_text.length, 299);
  await assert.rejects(db.saveConnectionNote(row, `x${text}`), /under 300/);
});

test('long source URLs fail before an LLM call; missing names receive a neutral greeting', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_, init) => {
    calls++;
    return icpResponse({ draft_text: selectedDraft(init) });
  };
  const long = await contact({ source_post_url: `https://www.linkedin.com/posts/${'x'.repeat(300)}` });
  await assert.rejects(drafter(fetcher)(long), /too long/);
  const invalid = await contact({ source_post_url: 'https://example.com/posts/test' });
  await assert.rejects(drafter(fetcher)(invalid), /valid source LinkedIn post/);
  assert.equal(calls, 0);
  const unnamed = await contact({ name: null });
  assert.match((await drafter(fetcher)(unnamed)).draft_text, /^Hi, /);
});

test('LLM errors, refusals, malformed and incomplete drafting responses save nothing', async () => {
  const responses = [
    new Response('secret body', { status: 429 }),
    Response.json({ status: 'incomplete', output: [] }),
    Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }),
    Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'invalid JSON' }] }] }),
    icpResponse({ draft_text: null }),
  ];
  for (const response of responses) {
    const row = await contact();
    await assert.rejects(drafter(async () => response)(row), error =>
      error instanceof Error && !error.message.includes('secret body'));
    assert.deepEqual(await db.listMessages(row.id), []);
  }
  const row = await contact();
  await assert.rejects(drafter(async () => { throw new Error('fake-openai-key'); })(row),
    error => error instanceof Error && error.message === 'OpenAI draft request failed');
});

test('drafting skips suppressed, rejected, expired or stale contacts before calling the LLM', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_, init) => { calls++; return icpResponse({ draft_text: selectedDraft(init) }); };
  const suppressed = await contact();
  await db.suppress(suppressed.linkedin_url, 'STOP');
  const rejected = await contact();
  await db.updateQualification(rejected.id, 'rejected', null);
  const expired = await contact({ collected_at: now() - 100, retention_seconds: 1 });
  const stale = { ...await contact(), name: 'Different name' };
  for (const row of [suppressed, rejected, expired, stale]) {
    await assert.rejects(drafter(fetcher)(row), /missing, stale, suppressed, rejected, or expired/);
  }
  await assert.rejects(createMessageDrafter({ DB: binding }, fetcher)(stale), /OPENAI_API_KEY/);
  assert.equal(calls, 0);
});

test('draft insert rechecks suppression, rejection and data changes after generation', async () => {
  for (const change of ['suppress', 'reject', 'post']) {
    const row = await contact();
    await assert.rejects(drafter(async (_, init) => {
      if (change === 'suppress') await db.suppress(row.linkedin_url, 'STOP');
      else if (change === 'reject') await db.updateQualification(row.id, 'rejected', null);
      else await binding.prepare('UPDATE contacts SET source_post_url = ? WHERE id = ?')
        .bind('https://www.linkedin.com/posts/new-post', row.id).run();
      return icpResponse({ draft_text: selectedDraft(init) });
    })(row), /no longer eligible/);
    assert.deepEqual(await db.listMessages(row.id), []);
  }
});
