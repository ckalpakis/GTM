import { normalizeLinkedInUrl, type Contact, type Message } from './db';

export class SendStore {
  constructor(private readonly db: D1Database) {}

  async candidates(accountId: string, limit: number): Promise<string[]> {
    const result = await this.db.prepare(`
      SELECT m.id FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE m.status = 'drafted' AND c.icp_status = 'qualified'
        AND NOT EXISTS (SELECT 1 FROM send_attempts a
          WHERE a.message_id = m.id OR (a.account_id = ?1 AND a.contact_id = c.id))
      ORDER BY c.collected_at, m.id LIMIT ?2
    `).bind(accountId, limit).all<{ id: string }>();
    return result.results.map(row => row.id);
  }

  async usedToday(accountId: string): Promise<number> {
    const row = await this.db.prepare(`SELECT count(*) AS used FROM send_attempts
      WHERE account_id = ?1 AND send_day = strftime('%Y-%m-%d', 'now')`)
      .bind(accountId).first<{ used: number }>();
    return row?.used ?? 0;
  }

  async cancelDraft(id: string): Promise<void> {
    await this.db.prepare("UPDATE messages SET status = 'cancelled', compliance_checked = 0 WHERE id = ?1 AND status = 'drafted'")
      .bind(id).run();
  }

  async mapProvider(accountId: string, providerId: string, contactId: string): Promise<void> {
    await this.db.prepare(`INSERT INTO contact_provider_ids (account_id, provider_id, contact_id)
      VALUES (?1, ?2, ?3) ON CONFLICT (account_id, contact_id) DO UPDATE SET provider_id = excluded.provider_id`)
      .bind(accountId, providerId, contactId).run();
  }

  /** Concurrent cron runs serialize this capacity check and reservation in SQLite. */
  async reserve(accountId: string, dailyCap: number, message: Message, contact: Contact): Promise<string | null> {
    const id = crypto.randomUUID();
    const row = await this.db.prepare(`
      INSERT INTO send_attempts (id, account_id, message_id, contact_id, send_day, reserved_at, status)
      SELECT ?1, ?2, m.id, c.id, strftime('%Y-%m-%d', 'now'), unixepoch(), 'reserved'
      FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE m.id = ?3 AND m.status = 'drafted' AND m.draft_text = ?4
        AND c.id = ?5 AND c.name IS ?6 AND c.source_post_url = ?7
        AND c.source = 'apify_post_engagement' AND c.reaction_type IS ?8
        AND c.suppressed = 0 AND c.retention_expires_at > unixepoch()
        AND c.icp_status = 'qualified' AND c.intent_score BETWEEN 1 AND 5
        AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = c.linkedin_url)
        AND NOT EXISTS (SELECT 1 FROM send_attempts a
          WHERE a.message_id = m.id OR (a.account_id = ?2 AND a.contact_id = c.id))
        AND (SELECT count(*) FROM send_attempts WHERE account_id = ?2
          AND send_day = strftime('%Y-%m-%d', 'now')) < ?9
      RETURNING id
    `).bind(id, accountId, message.id, message.draft_text, contact.id, contact.name,
      contact.source_post_url, contact.reaction_type, dailyCap).first<{ id: string }>();
    return row?.id ?? null;
  }

  async beginDispatch(id: string, message: Message, contact: Contact, providerId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE send_attempts SET status = 'dispatching' WHERE id = ?1 AND status = 'reserved'
        AND send_day = strftime('%Y-%m-%d', 'now')
        AND NOT EXISTS (SELECT 1 FROM suppression_list WHERE linkedin_url = ?6)
        AND EXISTS (SELECT 1 FROM messages m JOIN contacts c ON c.id = m.contact_id
          WHERE m.id = send_attempts.message_id AND m.status = 'queued' AND m.compliance_checked = 1
            AND m.draft_text = ?2 AND c.name IS ?3 AND c.source_post_url = ?4
            AND c.source = 'apify_post_engagement' AND c.reaction_type IS ?5
            AND c.suppressed = 0 AND c.retention_expires_at > unixepoch()
            AND c.icp_status = 'qualified' AND c.intent_score BETWEEN 1 AND 5
            AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = c.linkedin_url))
    `).bind(id, message.draft_text, contact.name, contact.source_post_url, contact.reaction_type,
      normalizeLinkedInUrl(`https://www.linkedin.com/in/${providerId}`)).run();
    return result.meta.changes === 1;
  }

  async finish(id: string, status: 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string | null = null): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE send_attempts SET status = ?2, error_code = ?3
        WHERE id = ?1 AND status IN ('reserved', 'dispatching')`).bind(id, status, code),
      this.db.prepare(`UPDATE messages SET status = ?2,
        sent_at = CASE WHEN ?2 = 'sent' THEN unixepoch() ELSE NULL END,
        compliance_checked = CASE WHEN ?2 = 'sent' THEN 1 ELSE 0 END
        WHERE id = (SELECT message_id FROM send_attempts WHERE id = ?1 AND status = ?3)
          AND status <> 'sent'`).bind(id, status === 'succeeded' ? 'sent' : status === 'cancelled' ? 'cancelled' : 'failed', status),
    ]);
  }
}
