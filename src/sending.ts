import { checkMessageCompliance } from './compliance';
import { Database } from './db';
import { SendStore } from './send-store';
import { createUnipileClient, UnipileError, type UnipileEnvironment } from './unipile';

export interface SendingEnvironment extends UnipileEnvironment {
  DB: D1Database;
  DAILY_SEND_CAP?: string;
  MAX_SENDS_PER_RUN?: string;
  UNIPILE_WEBHOOK_SECRET?: string;
}

export interface SendSummary {
  attempted: number;
  sent: number;
  blocked: number;
  failed: number;
  uncertain: number;
  stopped: 'disabled' | 'empty' | 'daily_cap' | 'run_cap' | 'time_limit' | 'provider_error';
}

function cap(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

export function createMessageSender(env: SendingEnvironment, fetcher: typeof fetch = fetch) {
  return async function sendQueuedMessages(): Promise<SendSummary> {
    const dailyCap = cap(env.DAILY_SEND_CAP, 'DAILY_SEND_CAP');
    const runCap = cap(env.MAX_SENDS_PER_RUN, 'MAX_SENDS_PER_RUN');
    const result: SendSummary = { attempted: 0, sent: 0, blocked: 0, failed: 0, uncertain: 0, stopped: 'empty' };
    if (dailyCap === 0 || runCap === 0) return { ...result, stopped: 'disabled' };
    if (!env.UNIPILE_WEBHOOK_SECRET || env.UNIPILE_WEBHOOK_SECRET.length < 32) {
      throw new Error('A UNIPILE_WEBHOOK_SECRET of at least 32 characters is required for the STOP reply handler');
    }
    const client = createUnipileClient(env, fetcher);
    const store = new SendStore(env.DB);
    const db = new Database(env.DB);
    const deadline = Date.now() + 10 * 60 * 1000;
    // Bound scanning too, so permanently invalid drafts cannot occupy an entire cron invocation.
    const scanLimit = Math.min(1000, Math.max(50, runCap * 5));
    if (await store.usedToday(client.accountId) >= dailyCap) return { ...result, stopped: 'daily_cap' };
    const ids = await store.candidates(client.accountId, scanLimit);
    for (const id of ids) {
      if (result.attempted >= runCap) { result.stopped = 'run_cap'; break; }
      if (Date.now() >= deadline) { result.stopped = 'time_limit'; break; }
      if (await store.usedToday(client.accountId) >= dailyCap) { result.stopped = 'daily_cap'; break; }
      let check = await checkMessageCompliance(env.DB, id);
      if (!check.ok) {
        result.blocked++;
        if (check.reason !== 'icp' && check.reason !== 'status') await store.cancelDraft(id);
        continue;
      }
      let providerId: string;
      try { providerId = await client.resolveProfile(check.contact.linkedin_url); }
      catch { result.stopped = 'provider_error'; break; }
      // The provider ID may have opted out using its opaque profile URL instead of the vanity URL.
      if (await db.getSuppression(`https://www.linkedin.com/in/${providerId}`)) {
        await db.suppress(check.contact.linkedin_url, 'Opt-out for resolved LinkedIn identity');
        result.blocked++;
        continue;
      }
      await store.mapProvider(client.accountId, providerId, check.contact.id);
      check = await checkMessageCompliance(env.DB, id);
      if (!check.ok) { result.blocked++; continue; }
      const attemptId = await store.reserve(client.accountId, dailyCap, check.message, check.contact);
      if (!attemptId) {
        if (await store.usedToday(client.accountId) >= dailyCap) { result.stopped = 'daily_cap'; break; }
        continue; // Another cron run claimed it, or its data changed.
      }
      result.attempted++;
      // Last persisted check immediately before the provider call. No network I/O between this and invite().
      const finalCheck = await checkMessageCompliance(env.DB, id);
      if (!finalCheck.ok || !await store.beginDispatch(attemptId, finalCheck.message, finalCheck.contact, providerId)) {
        await store.finish(attemptId, 'cancelled', 'eligibility_changed');
        result.blocked++;
        continue;
      }
      try {
        await client.invite(providerId, finalCheck.message.draft_text);
      } catch (error) {
        const uncertain = !(error instanceof UnipileError) || error.uncertain;
        await store.finish(attemptId, uncertain ? 'unknown' : 'failed', error instanceof UnipileError ? error.code : 'request_failed');
        if (uncertain) result.uncertain++;
        else result.failed++;
        result.stopped = 'provider_error';
        break;
      }
      // Keep outside the provider try/catch: a DB failure after acceptance must never be treated as a retryable send.
      await store.finish(attemptId, 'succeeded');
      result.sent++;
    }
    if (result.stopped === 'empty' && result.attempted >= runCap) result.stopped = 'run_cap';
    return result;
  };
}
