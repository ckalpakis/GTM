import { Database, normalizeLinkedInUrl } from './db';

export const APIFY_ACTOR = 'api-ninja~linkedin-post-reactions-scraper';
export const ENGAGEMENT_SOURCE = 'apify_post_engagement';
const API = 'https://api.apify.com/v2';
const PAGE_SIZE = 100;
const TIMEOUT_MS = 10 * 60 * 1000;

export interface SourcingEnvironment {
  DB: D1Database;
  APIFY_TOKEN?: string;
  CONTACT_RETENTION_SECONDS?: string;
}

export interface SourceResult {
  runId: string;
  datasetId: string;
  fetched: number;
  inserted: number;
  /** Suppressed or already collected; original retention is unchanged. */
  skipped: number;
  invalid: number;
}

interface Dependencies {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseRun(value: unknown) {
  const run = object(object(value)?.data);
  if (!run || typeof run.id !== 'string' || !run.id || typeof run.status !== 'string') {
    throw new Error('Invalid Apify run response');
  }
  return { id: run.id, status: run.status, datasetId: run.defaultDatasetId };
}

function postUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
    !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) ||
    !/^\/(?:posts\/[^/]+\/?|feed\/update\/urn:li:(?:activity|share|ugcPost):\d+\/?)$/.test(url.pathname)) {
    throw new Error('Expected a public LinkedIn post URL');
  }
  url.protocol = 'https:';
  url.hostname = 'www.linkedin.com';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function parseReactor(value: unknown) {
  const row = object(value);
  if (!row || typeof row.reactorProfileUrl !== 'string' ||
      typeof row.reactionType !== 'string' || !row.reactionType.trim()) return null;
  const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
  try {
    return {
      linkedin_url: normalizeLinkedInUrl(row.reactorProfileUrl),
      name: text(row.reactorName),
      headline: text(row.reactorHeadline),
      reaction_type: row.reactionType.trim(),
    };
  } catch { return null; }
}

/** Bind Worker configuration once, then call sourceFromPost(postUrl). */
export function createPostSource(env: SourcingEnvironment, dependencies: Dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const db = new Database(env.DB);

  return async function sourceFromPost(input: string): Promise<SourceResult> {
    const url = postUrl(input);
    const token = env.APIFY_TOKEN?.trim();
    if (!token) throw new Error('APIFY_TOKEN is required');
    const retention = Number(env.CONTACT_RETENTION_SECONDS);
    if (!Number.isSafeInteger(retention) || retention <= 0 ||
        !Number.isSafeInteger(Math.floor(now() / 1000) + retention)) {
      throw new Error('CONTACT_RETENTION_SECONDS must be a positive integer');
    }
    const deadline = now() + TIMEOUT_MS;
    let runId: string | undefined;
    const checkDeadline = () => {
      if (now() >= deadline) throw new Error(`Apify sourcing timed out${runId ? ` (run ${runId})` : ''}`);
    };

    async function request(path: string, init: RequestInit = {}): Promise<unknown> {
      // Never retry the run-creation POST: an ambiguous response could create two paid runs.
      const attempts = init.method === 'POST' ? 1 : 3;
      for (let attempt = 0; attempt < attempts; attempt++) {
        checkDeadline();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(65_000, deadline - now()));
        let retry = false;
        try {
          const response = await fetcher(`${API}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            signal: controller.signal,
            redirect: 'error',
          });
          retry = response.status === 429 || response.status >= 500;
          if (!response.ok) {
            await response.body?.cancel();
            // Do not include response bodies or credentials in errors.
            throw new Error(`Apify HTTP ${response.status}${runId ? ` (run ${runId})` : ''}`);
          }
          return await response.json();
        } catch (error) {
          checkDeadline();
          if (!retry || attempt === attempts - 1) {
            if (error instanceof Error && error.message.startsWith('Apify HTTP ')) throw error;
            throw new Error(`Apify request failed${runId ? ` (run ${runId})` : ''}`);
          }
        } finally {
          clearTimeout(timer);
        }
        await sleep(1000 * 2 ** attempt);
      }
      throw new Error('Apify retries exhausted');
    }

    // Bound the remote run as well as this invocation's wait. All reaction types are requested.
    let run = parseRun(await request(`/actors/${APIFY_ACTOR}/runs?timeout=540`, {
      method: 'POST',
      body: JSON.stringify({
        postUrls: [{ url }],
        reactionTypes: ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'],
        parseAll: true,
      }),
    }));
    runId = run.id;
    while (run.status !== 'SUCCEEDED') {
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
        throw new Error(`Apify run ${runId} ended with ${run.status}`);
      }
      if (!['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(run.status)) {
        throw new Error(`Unexpected Apify run status (run ${runId})`);
      }
      checkDeadline();
      const wait = Math.min(60, Math.max(1, Math.floor((deadline - now()) / 1000)));
      run = parseRun(await request(`/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${wait}`));
      if (run.id !== runId) throw new Error('Apify returned a different run ID');
      if (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(run.status)) await sleep(1000);
    }
    if (typeof run.datasetId !== 'string' || !run.datasetId) {
      throw new Error(`Apify run ${runId} has no dataset`);
    }
    const result: SourceResult = { runId, datasetId: run.datasetId, fetched: 0, inserted: 0, skipped: 0, invalid: 0 };
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const items = await request(`/datasets/${encodeURIComponent(result.datasetId)}/items?format=json&offset=${offset}&limit=${PAGE_SIZE}`);
      if (!Array.isArray(items)) throw new Error(`Invalid Apify dataset response (run ${runId})`);
      for (const item of items) {
        checkDeadline();
        result.fetched++;
        const reactor = parseReactor(item);
        if (!reactor) { result.invalid++; continue; }
        const contact = await db.importContact({
          ...reactor,
          source_post_url: url,
          source: ENGAGEMENT_SOURCE,
          collected_at: Math.floor(now() / 1000),
          retention_seconds: retention,
          sources: {
            linkedin_url: ENGAGEMENT_SOURCE,
            name: ENGAGEMENT_SOURCE,
            headline: ENGAGEMENT_SOURCE,
            source_post_url: ENGAGEMENT_SOURCE,
            reaction_type: ENGAGEMENT_SOURCE,
          },
        });
        if (contact) result.inserted++;
        else result.skipped++;
      }
      if (items.length < PAGE_SIZE) break;
    }
    return result;
  };
}
