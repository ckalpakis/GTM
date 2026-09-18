import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { beforeEach, afterEach, test } from 'node:test';
import { URL as NodeURL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { Database } from '../src/db.ts';
import { cleanupExpiredContacts, RETENTION_CRON } from '../src/retention.ts';
import worker from '../src/index.ts';

let mf: Miniflare;
let binding: D1Database;
let db: Database;
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-09-17', d1Databases: { DB: 'retention-tests' },
  }));
  binding = await mf.getD1Database('DB') as unknown as D1Database;
  const directory = new NodeURL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
    const sql = await readFile(new NodeURL(file, directory), 'utf8');
    await binding.batch(unstable_splitSqlQuery(sql).map(statement => binding.prepare(statement)));
  }
  db = new Database(binding);
});
afterEach(async () => { await mf?.dispose(); });

async function contact(expired = true) {
  const id = crypto.randomUUID();
  return db.createContact({ id, linkedin_url: `https://www.linkedin.com/in/${id}`,
    source_post_url: 'https://www.linkedin.com/posts/example',
    collected_at: Math.floor(Date.now() / 1000) - (expired ? 100 : 0), retention_seconds: expired ? 10 : 86400,
    sources: { linkedin_url: 'apify_post_engagement', source_post_url: 'apify_post_engagement' },
  });
}

test('multi-batch cleanup ignores last-touch timestamps and preserves every suppression row', async () => {
  const expired = [];
  for (let i = 0; i < 5; i++) expired.push(await contact());
  const active = await contact(false);
  const first = expired[0]!;
  await db.suppress(first.linkedin_url, 'STOP');
  await db.suppress(active.linkedin_url, 'STOP');
  await db.suppress('https://www.linkedin.com/in/unknown', 'STOP');
  const before = await binding.prepare('SELECT * FROM suppression_list ORDER BY linkedin_url').all();
  // Model a future last-touch column: even a future timestamp cannot extend retention.
  await binding.prepare('ALTER TABLE contacts ADD COLUMN updated_at INTEGER').run();
  await binding.prepare("UPDATE contacts SET headline = 'Recently edited', updated_at = unixepoch() + 864000").run();
  const draft = await db.createDraft(first.id, 'Hello');
  await binding.prepare(`INSERT INTO contact_provider_ids VALUES ('account', 'provider', ?)`)
    .bind(first.id).run();
  await binding.prepare(`INSERT INTO reply_events (id, account_id, message_id, contact_id, received_at)
    VALUES ('reply', 'account', 'received-message', ?, unixepoch())`).bind(first.id).run();
  await binding.prepare(`INSERT INTO send_attempts (id, account_id, contact_id, send_day, reserved_at, status)
    VALUES ('attempt', 'account', ?, '2026-09-17', 1, 'unknown')`).bind(first.id).run();
  const result = await cleanupExpiredContacts({ DB: binding }, { batchSize: 2 });
  assert.equal(result.deleted, 5);
  assert.equal(result.batches, 3);
  assert.equal(result.hasMore, false);
  for (const row of expired) assert.equal(await db.getContact(row.id), null);
  assert.equal((await db.getContact(active.id))?.retention_expires_at, active.retention_expires_at);
  assert.deepEqual((await binding.prepare('SELECT * FROM suppression_list ORDER BY linkedin_url').all()).results, before.results);
  assert.equal(await db.getMessage(draft.id), null);
  for (const table of ['provenance', 'contact_provider_ids', 'reply_events']) {
    assert.equal(await binding.prepare(`SELECT contact_id FROM ${table} WHERE contact_id = ?`).bind(first.id).first(), null);
  }
  assert.deepEqual(await binding.prepare('SELECT contact_id, message_id FROM send_attempts WHERE id = ?').bind('attempt').first(),
    { contact_id: null, message_id: null });
  assert.equal((await cleanupExpiredContacts({ DB: binding })).deleted, 0);
});

test('batch budget reports backlog and the next run resumes without skipping contacts', async () => {
  for (let i = 0; i < 5; i++) await contact();
  const first = await cleanupExpiredContacts({ DB: binding }, { batchSize: 2, maxBatches: 2 });
  assert.equal(first.deleted, 4);
  assert.equal(first.batches, 2);
  assert.equal(first.hasMore, true);
  const second = await cleanupExpiredContacts({ DB: binding }, { batchSize: 1, maxBatches: 1 });
  assert.equal(second.deleted, 1);
  assert.equal(second.hasMore, false);
  await assert.rejects(cleanupExpiredContacts({ DB: binding }, { batchSize: 0 }), /batchSize/);
  await assert.rejects(cleanupExpiredContacts({ DB: binding }, { maxBatches: 101 }), /maxBatches/);
});

test('expiry boundary is inclusive and collection-based deadlines cannot be extended', async () => {
  const row = await contact(false);
  assert.equal(row.retention_expires_at, row.collected_at + 86400);
  await assert.rejects(binding.prepare('UPDATE contacts SET retention_expires_at = retention_expires_at + 1 WHERE id = ?')
    .bind(row.id).run(), /immutable/);
  await assert.rejects(binding.prepare('UPDATE contacts SET collected_at = collected_at + 1 WHERE id = ?')
    .bind(row.id).run(), /immutable/);
  assert.equal(await db.deleteExpiredContacts(100, row.retention_expires_at - 1), 0);
  assert.equal(await db.deleteExpiredContacts(100, row.retention_expires_at), 1);
});

test('cron routes daily cleanup separately from sending and rejects unknown schedules', async () => {
  const row = await contact();
  const env = { DB: binding, DAILY_SEND_CAP: '0', MAX_SENDS_PER_RUN: '0' };
  await worker.scheduled({ cron: '*/15 * * * *' } as ScheduledController, env);
  assert.ok(await db.getContact(row.id));
  // Invalid sending caps would throw if the cleanup schedule accidentally ran the sender.
  await worker.scheduled({ cron: RETENTION_CRON } as ScheduledController,
    { ...env, DAILY_SEND_CAP: '-1' });
  assert.equal(await db.getContact(row.id), null);
  await assert.rejects(worker.scheduled({ cron: 'unknown' } as ScheduledController, env), /Unrecognized/);
  const config = await readFile(new NodeURL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.ok(config.includes(`"${RETENTION_CRON}"`));
});
