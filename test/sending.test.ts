import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { beforeEach, afterEach, test } from 'node:test';
import { URL as NodeURL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { Database } from '../src/db.ts';
import { candidateNotes } from '../src/drafting.ts';
import { checkMessageCompliance } from '../src/compliance.ts';
import { SendStore } from '../src/send-store.ts';
import { createMessageSender, type SendingEnvironment } from '../src/sending.ts';
import { handleUnipileWebhook, isOptOutReply } from '../src/replies.ts';
import worker from '../src/index.ts';

let mf: Miniflare;
let binding: D1Database;
let db: Database;
let env: SendingEnvironment;

beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-09-17', d1Databases: { DB: 'sending-tests' },
  }));
  binding = await mf.getD1Database('DB') as unknown as D1Database;
  const directory = new NodeURL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    const sql = await readFile(new NodeURL(file, directory), 'utf8');
    await binding.batch(unstable_splitSqlQuery(sql).map(statement => binding.prepare(statement)));
  }
  db = new Database(binding);
  env = {
    DB: binding, UNIPILE_DSN: 'https://api1.unipile.com:13111', UNIPILE_API_KEY: 'test-key',
    UNIPILE_ACCOUNT_ID: 'account-test', UNIPILE_WEBHOOK_SECRET: 'a'.repeat(32),
    DAILY_SEND_CAP: '10', MAX_SENDS_PER_RUN: '3',
  };
});
afterEach(async () => { await mf?.dispose(); });

async function draft() {
  const id = crypto.randomUUID();
  const source = 'apify_post_engagement';
  const contact = await db.createContact({
    id, linkedin_url: `https://www.linkedin.com/in/${id}`, name: 'Jane Doe',
    source_post_url: 'https://www.linkedin.com/posts/example', source, reaction_type: 'LIKE',
    collected_at: Math.floor(Date.now() / 1000), retention_seconds: 86400,
    sources: { linkedin_url: source, name: source, source_post_url: source, reaction_type: source },
  });
  await db.updateQualification(id, 'qualified', 3);
  const message = await db.createDraft(id, candidateNotes(contact)[0]!);
  return { contact, message };
}

function api(send: (body: Record<string, string>) => Promise<Response> = async () =>
  Response.json({ object: 'UserInvitationSent', invitation_id: 'invitation-test' })): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, env.UNIPILE_DSN);
    assert.equal(new Headers(init?.headers).get('X-API-KEY'), 'test-key');
    if (init?.method === 'POST') {
      assert.equal(url.pathname, '/api/v1/users/invite');
      const body = JSON.parse(String(init.body));
      assert.equal(body.account_id, 'account-test');
      assert.ok(body.provider_id.startsWith('provider-'));
      return send(body);
    }
    assert.equal(url.searchParams.get('account_id'), 'account-test');
    assert.equal(url.searchParams.get('notify'), 'false');
    return Response.json({ provider_id: `provider-${url.pathname.split('/').at(-1)}` });
  };
}

test('compliance refuses invented claims, missing provenance, suppression and non-fits', async () => {
  const { contact, message } = await draft();
  assert.equal((await checkMessageCompliance(binding, message.id)).ok, true);
  const invented = await db.createDraft(contact.id, 'Great meeting you yesterday!');
  assert.deepEqual(await checkMessageCompliance(binding, invented.id), { ok: false, reason: 'ungrounded' });
  await binding.prepare("DELETE FROM provenance WHERE contact_id = ? AND field_name = 'source_post_url'").bind(contact.id).run();
  assert.deepEqual(await checkMessageCompliance(binding, message.id), { ok: false, reason: 'ungrounded' });
  await db.updateQualification(contact.id, 'rejected', null);
  assert.deepEqual(await checkMessageCompliance(binding, message.id), { ok: false, reason: 'icp' });
  await db.suppress(contact.linkedin_url, 'STOP');
  assert.deepEqual(await checkMessageCompliance(binding, message.id), { ok: false, reason: 'suppressed' });
});

test('only confirmed provider success marks the exact drafted note sent', async () => {
  const { message } = await draft();
  let posts = 0;
  const result = await createMessageSender(env, api(async body => {
    posts++;
    assert.equal(body.message, message.draft_text);
    const during = await db.getMessage(message.id);
    assert.equal(during?.status, 'queued');
    assert.equal(during?.sent_at, null);
    assert.equal(during?.compliance_checked, true);
    return Response.json({ object: 'UserInvitationSent', invitation_id: 'receipt' });
  }))();
  assert.equal(result.sent, 1);
  assert.equal(posts, 1);
  const saved = await db.getMessage(message.id);
  assert.equal(saved?.status, 'sent');
  assert.ok(saved?.sent_at);
  assert.equal(saved?.compliance_checked, true);
  await createMessageSender(env, api(async () => { throw new Error('must not resend'); }))();
});

test('daily and per-run caps persist across invocations and record cleanup', async () => {
  const items = await Promise.all([draft(), draft(), draft()]);
  const limited = { ...env, DAILY_SEND_CAP: '2', MAX_SENDS_PER_RUN: '1' };
  let posts = 0;
  const fetcher = api(async () => { posts++; return Response.json({ object: 'UserInvitationSent', invitation_id: 'receipt' }); });
  assert.equal((await createMessageSender(limited, fetcher)()).sent, 1);
  assert.equal((await createMessageSender(limited, fetcher)()).sent, 1);
  const sent = await binding.prepare("SELECT contact_id FROM messages WHERE status = 'sent'").all<{ contact_id: string }>();
  for (const row of sent.results) await binding.prepare('DELETE FROM contacts WHERE id = ?').bind(row.contact_id).run();
  assert.equal((await createMessageSender(limited, fetcher)()).stopped, 'daily_cap');
  assert.equal(posts, 2);
  assert.equal(await new SendStore(binding).usedToday('account-test'), 2);
  assert.ok(items.length === 3);
});

test('overlapping cron invocations cannot exceed one daily slot or send a message twice', async () => {
  await Promise.all([draft(), draft(), draft()]);
  let posts = 0;
  const sender = createMessageSender({ ...env, DAILY_SEND_CAP: '1' }, api(async () => {
    posts++;
    return Response.json({ object: 'UserInvitationSent', invitation_id: 'receipt' });
  }));
  const results = await Promise.all([sender(), sender(), sender()]);
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 1);
  assert.equal(posts, 1);
  assert.equal(await new SendStore(binding).usedToday('account-test'), 1);
});

test('HTTP failures and ambiguous results never mark sent or automatically retry', async () => {
  for (const response of [new Response('', { status: 429 }), new Response('', { status: 500 }), Response.json({})]) {
    const { message } = await draft();
    let posts = 0;
    const sender = createMessageSender(env, api(async () => { posts++; return response; }));
    const result = await sender();
    assert.equal(result.sent, 0);
    assert.equal(result.failed + result.uncertain, 1);
    assert.equal((await db.getMessage(message.id))?.status, 'failed');
    assert.equal((await db.getMessage(message.id))?.sent_at, null);
    await sender();
    assert.equal(posts, 1);
  }
  const { message } = await draft();
  const result = await createMessageSender(env, api(async () => { throw new Error('secret-key'); }))();
  assert.equal(result.uncertain, 1);
  assert.equal((await db.getMessage(message.id))?.status, 'failed');
});

test('suppression or text changes during profile lookup prevent the POST', async () => {
  for (const change of ['suppress', 'text']) {
    const { contact, message } = await draft();
    let posts = 0;
    const fetcher: typeof fetch = async (_, init) => {
      if (init?.method === 'POST') { posts++; throw new Error('must not send'); }
      if (change === 'suppress') await db.suppress(contact.linkedin_url, 'STOP');
      else await binding.prepare("UPDATE messages SET draft_text = 'Great meeting you', compliance_checked = 0 WHERE id = ?")
        .bind(message.id).run();
      return Response.json({ provider_id: `provider-${contact.id}` });
    };
    await createMessageSender(env, fetcher)();
    assert.equal(posts, 0);
    if (change === 'text') await new SendStore(binding).cancelDraft(message.id);
  }
});

test('an acknowledged send is recorded even if STOP arrives while the provider responds', async () => {
  const { contact, message } = await draft();
  const result = await createMessageSender(env, api(async () => {
    await db.suppress(contact.linkedin_url, 'STOP during in-flight request');
    return Response.json({ object: 'UserInvitationSent', invitation_id: 'receipt' });
  }))();
  assert.equal(result.sent, 1);
  assert.equal((await db.getMessage(message.id))?.status, 'sent');
  assert.equal((await db.getContact(contact.id))?.suppressed, true);
});

test('unconfirmed sends cannot be marked sent through a normal status update', async () => {
  const { message } = await draft();
  await assert.rejects(binding.prepare("UPDATE messages SET status = 'sent', sent_at = unixepoch(), compliance_checked = 1 WHERE id = ?")
    .bind(message.id).run(), /successful provider response/);
});

test('zero caps disable cron sends; missing or invalid caps fail closed', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('must not call'); };
  assert.equal((await createMessageSender({ DB: binding, DAILY_SEND_CAP: '0', MAX_SENDS_PER_RUN: '0' }, fetcher)()).stopped, 'disabled');
  await assert.rejects(createMessageSender({ ...env, DAILY_SEND_CAP: '-1' }, fetcher)(), /non-negative/);
  await assert.rejects(createMessageSender({ ...env, UNIPILE_WEBHOOK_SECRET: '' }, fetcher)(), /STOP reply/);
  await worker.scheduled({ cron: '*/15 * * * *' } as ScheduledController, { DB: binding, DAILY_SEND_CAP: '0', MAX_SENDS_PER_RUN: '0' });
  assert.equal(calls, 0);
  const config = await readFile(new NodeURL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.ok(config.includes('*/15 * * * *'));
});

test('UTC daily counters reset by day while previous attempts remain deduplicated', async () => {
  const { message } = await draft();
  await createMessageSender({ ...env, DAILY_SEND_CAP: '1' }, api())();
  await binding.prepare("UPDATE send_attempts SET send_day = strftime('%Y-%m-%d', 'now', '-1 day')").run();
  await draft();
  assert.equal((await createMessageSender({ ...env, DAILY_SEND_CAP: '1' }, api())()).sent, 1);
  assert.equal((await db.getMessage(message.id))?.status, 'sent');
});

function webhook(message: string, senderId: string, authorized = true) {
  return new Request('https://example.test/webhooks/unipile', {
    method: 'POST', headers: { 'Unipile-Auth': authorized ? env.UNIPILE_WEBHOOK_SECRET! : 'wrong' },
    body: JSON.stringify({ event: 'message_received', account_id: 'account-test', account_type: 'LINKEDIN',
      account_info: { user_id: 'account-owner' }, message,
      sender: { attendee_provider_id: senderId, attendee_profile_url: `https://www.linkedin.com/in/${senderId}` } }),
  });
}

test('authenticated STOP webhook suppresses mapped and opaque identities and ignores self messages', async () => {
  const { contact, message } = await draft();
  await new SendStore(binding).mapProvider('account-test', 'provider-jane', contact.id);
  assert.equal((await handleUnipileWebhook(webhook('STOP', 'provider-jane', false), env)).status, 401);
  assert.equal(await db.getSuppression(contact.linkedin_url), null);
  const response = await handleUnipileWebhook(webhook('Please STOP contacting me', 'provider-jane'), env);
  assert.deepEqual(await response.json(), { opted_out: true });
  assert.ok(await db.getSuppression(contact.linkedin_url));
  assert.ok(await db.getSuppression('https://www.linkedin.com/in/provider-jane'));
  assert.equal((await db.getMessage(message.id))?.status, 'cancelled');
  await handleUnipileWebhook(webhook('STOP', 'account-owner'), env);
  assert.equal(await db.getSuppression('https://www.linkedin.com/in/account-owner'), null);
  assert.equal(isOptOutReply('No thanks'), true);
  assert.equal(isOptOutReply('Do not contact me'), true);
  assert.equal(isOptOutReply('Thanks, tell me more'), false);
});

test('opaque profile opt-outs prevent later sends to the same vanity profile', async () => {
  const { contact } = await draft();
  await db.suppress(`https://www.linkedin.com/in/provider-${contact.id}`, 'STOP before import');
  let posts = 0;
  const result = await createMessageSender(env, api(async () => { posts++; throw new Error('must not send'); }))();
  assert.equal(result.sent, 0);
  assert.equal(posts, 0);
  assert.equal((await db.getContact(contact.id))?.suppressed, true);
});
