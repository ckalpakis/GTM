import { Database } from './db';

export const RETENTION_CRON = '17 3 * * *'; // Daily at 03:17 UTC.
export interface RetentionOptions {
  batchSize?: number;
  maxBatches?: number;
}
export interface RetentionResult {
  deleted: number;
  batches: number;
  cutoff: number;
  hasMore: boolean;
}

/** Deletes only contacts; FK cascades remove dependent data, never suppression entries. */
export async function cleanupExpiredContacts(
  env: { DB: D1Database }, options: RetentionOptions = {},
): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('batchSize must be 1–1000');
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new Error('maxBatches must be 1–100');
  }
  // A fixed UTC cutoff keeps the set bounded even if sourcing runs concurrently.
  // Deadlines were computed at insertion from collected_at and cannot be extended.
  const cutoff = Math.floor(Date.now() / 1000);
  const db = new Database(env.DB);
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const count = await db.deleteExpiredContacts(batchSize, cutoff);
    batches++;
    deleted += count;
    if (count < batchSize) return { deleted, batches, cutoff, hasMore: false };
  }
  // No OFFSET: each batch selects the oldest remaining expired rows.
  return { deleted, batches, cutoff, hasMore: await db.hasExpiredContacts(cutoff) };
}
