/** Database timestamps are UTC Unix seconds; public boolean fields are decoded. */
export type IcpStatus = 'pending' | 'qualified' | 'rejected';
export type IntentScore = 1 | 2 | 3 | 4 | 5;
export type IcpResult =
  | { icp_fit: true; intent_score: IntentScore }
  | { icp_fit: false; intent_score: null };
export type IcpContact = Pick<Contact, 'id' | 'headline' | 'company'>;
export type MessageStatus = 'drafted' | 'queued' | 'sent' | 'failed' | 'cancelled';
export const OPT_OUT_TEXT = 'Reply STOP to opt out.';
export const CONNECTION_NOTE_MAX_LENGTH = 299;
export type DraftContact = Pick<Contact, 'id' | 'name' | 'headline' | 'company' | 'source_post_url'>;

export interface Contact {
  id: string;
  linkedin_url: string;
  name: string | null;
  headline: string | null;
  company: string | null;
  source_post_url: string;
  collected_at: number;
  retention_expires_at: number;
  icp_status: IcpStatus;
  intent_score: IntentScore | null;
  icp_evaluation_id: string | null;
  suppressed: boolean;
  source: string | null;
  reaction_type: string | null;
}

export type ProvenanceField = 'linkedin_url' | 'name' | 'headline' | 'company' | 'source_post_url' | 'reaction_type';
export interface Provenance {
  contact_id: string;
  field_name: string;
  source: string;
  collected_at: number;
}
export interface Message {
  id: string;
  contact_id: string;
  draft_text: string;
  status: MessageStatus;
  sent_at: number | null;
  compliance_checked: boolean;
}
export interface SuppressionEntry {
  linkedin_url: string;
  reason: string;
  added_at: number;
}
export interface NewContact {
  id?: string;
  linkedin_url: string;
  name?: string | null;
  headline?: string | null;
  company?: string | null;
  source_post_url: string;
  source?: string | null;
  reaction_type?: string | null;
  collected_at: number;
  /** Required policy decision; always measured from collected_at. */
  retention_seconds: number;
  /** Source for every supplied external field; generated fields need no provenance. */
  sources: Partial<Record<ProvenanceField, string>>;
}

type ContactRow = Omit<Contact, 'suppressed'> & { suppressed: 0 | 1 };
type MessageRow = Omit<Message, 'compliance_checked'> & { compliance_checked: 0 | 1 };
const decodeContact = (row: ContactRow): Contact => ({ ...row, suppressed: row.suppressed === 1 });
const decodeMessage = (row: MessageRow): Message => ({ ...row, compliance_checked: row.compliance_checked === 1 });
const nowSeconds = () => Math.floor(Date.now() / 1000);

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected a UTC Unix timestamp in seconds');
  return value;
}

/** Keep contact and suppression lookups on the same canonical identity. */
export function normalizeLinkedInUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) ||
      url.username || url.password || url.port) {
    throw new Error('Expected a LinkedIn profile URL');
  }
  const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
  if (!match?.[1]) throw new Error('Expected a LinkedIn /in/ profile URL');
  const slug = decodeURIComponent(match[1]).toLowerCase();
  if (!slug || /[\s/\\?#]/.test(slug)) throw new Error('Invalid LinkedIn profile identifier');
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

export class Database {
  constructor(private readonly db: D1Database) {}

  async getContact(id: string): Promise<Contact | null> {
    const row = await this.db.prepare('SELECT * FROM contacts WHERE id = ?1').bind(id).first<ContactRow>();
    return row ? decodeContact(row) : null;
  }

  async findContactByLinkedInUrl(url: string): Promise<Contact | null> {
    const row = await this.db.prepare('SELECT * FROM contacts WHERE linkedin_url = ?1')
      .bind(normalizeLinkedInUrl(url)).first<ContactRow>();
    return row ? decodeContact(row) : null;
  }

  /** Atomic insert plus field provenance. Duplicate identities fail without extending retention. */
  async createContact(input: NewContact): Promise<Contact> {
    const contact = await this.insertContact(input, false);
    if (!contact) throw new Error('Contact disappeared after creation');
    return contact;
  }

  /** Suppression/duplicate checks execute in the same transaction as the insert. */
  async importContact(input: NewContact): Promise<Contact | null> {
    // A fresh ID ensures skipped inserts cannot attach provenance to an existing row.
    return this.insertContact({ ...input, id: crypto.randomUUID() }, true);
  }

  private async insertContact(input: NewContact, skipExisting: boolean): Promise<Contact | null> {
    const collectedAt = timestamp(input.collected_at);
    if (!Number.isSafeInteger(input.retention_seconds) || input.retention_seconds <= 0) {
      throw new Error('retention_seconds must be a positive integer');
    }
    const expiresAt = timestamp(collectedAt + input.retention_seconds);
    const id = input.id ?? crypto.randomUUID();
    const url = normalizeLinkedInUrl(input.linkedin_url);
    const fields: Record<ProvenanceField, string | null> = {
      linkedin_url: url,
      name: input.name ?? null,
      headline: input.headline ?? null,
      company: input.company ?? null,
      source_post_url: input.source_post_url,
      reaction_type: input.reaction_type ?? null,
    };
    const statements = [this.db.prepare(`
      INSERT INTO contacts (id, linkedin_url, name, headline, company, source_post_url,
        collected_at, retention_expires_at, source, reaction_type)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
      ${skipExisting ? `WHERE NOT EXISTS (SELECT 1 FROM suppression_list WHERE linkedin_url = ?2)
        AND NOT EXISTS (SELECT 1 FROM contacts WHERE linkedin_url = ?2)` : ''}
    `).bind(id, url, fields.name, fields.headline, fields.company,
      fields.source_post_url, collectedAt, expiresAt, input.source ?? null, fields.reaction_type)];
    for (const field of Object.keys(fields) as ProvenanceField[]) {
      if (fields[field] === null) continue;
      const source = input.sources[field]?.trim();
      if (!source) throw new Error(`Missing provenance source for ${field}`);
      statements.push(this.db.prepare(`
        INSERT INTO provenance (contact_id, field_name, source, collected_at)
        SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM contacts WHERE id = ?1)
      `).bind(id, field, source, collectedAt));
    }
    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes === 0) return null;
    const contact = await this.getContact(id);
    if (!contact) throw new Error('Contact disappeared after creation');
    return contact;
  }

  async getProvenance(contactId: string): Promise<Provenance[]> {
    return (await this.db.prepare('SELECT * FROM provenance WHERE contact_id = ?1 ORDER BY field_name')
      .bind(contactId).all<Provenance>()).results;
  }

  async updateQualification(id: string, status: IcpStatus, score: number | null): Promise<boolean> {
    if (status === 'qualified' && (score === null || !Number.isInteger(score) || score < 1 || score > 5)) {
      throw new Error('Qualified contacts require an integer intent_score between 1 and 5');
    }
    // A failed binary fit always wins over any supplied score.
    const storedScore = status === 'qualified' ? score : null;
    const result = await this.db.prepare(`
      UPDATE contacts SET icp_status = ?2, intent_score = ?3, icp_evaluation_id = NULL WHERE id = ?1
    `).bind(id, status, storedScore).run();
    return result.meta.changes > 0;
  }

  /** Invalidate prior approval before awaiting an external scoring call. */
  async beginIcpEvaluation(contact: IcpContact, evaluationId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE contacts SET icp_status = 'pending', intent_score = NULL, icp_evaluation_id = ?2
      WHERE id = ?1 AND headline IS ?3 AND company IS ?4
        AND suppressed = 0 AND retention_expires_at > unixepoch()
        AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = contacts.linkedin_url)
    `).bind(contact.id, evaluationId, contact.headline, contact.company).run();
    return result.meta.changes > 0;
  }

  /** Commit only the latest evaluation, provided its input and eligibility still match. */
  async finishIcpEvaluation(contact: IcpContact, evaluationId: string, decision: IcpResult): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE contacts SET icp_status = ?3, intent_score = ?4, icp_evaluation_id = NULL
      WHERE id = ?1 AND icp_evaluation_id = ?2 AND headline IS ?5 AND company IS ?6
        AND suppressed = 0 AND retention_expires_at > unixepoch()
        AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = contacts.linkedin_url)
    `).bind(contact.id, evaluationId, decision.icp_fit ? 'qualified' : 'rejected',
      decision.icp_fit ? decision.intent_score : null, contact.headline, contact.company).run();
    return result.meta.changes > 0;
  }

  async getMessage(id: string): Promise<Message | null> {
    const row = await this.db.prepare('SELECT * FROM messages WHERE id = ?1').bind(id).first<MessageRow>();
    return row ? decodeMessage(row) : null;
  }

  async listMessages(contactId: string): Promise<Message[]> {
    const result = await this.db.prepare('SELECT * FROM messages WHERE contact_id = ?1 ORDER BY id')
      .bind(contactId).all<MessageRow>();
    return result.results.map(decodeMessage);
  }

  /** Drafts always include an opt-out path; they remain unchecked until reviewed. */
  async createDraft(contactId: string, text: string): Promise<Message> {
    if (!text.trim()) throw new Error('Draft text must not be empty');
    const id = crypto.randomUUID();
    const draft = text.includes(OPT_OUT_TEXT) ? text.trim() : `${text.trim()}\n\n${OPT_OUT_TEXT}`;
    const row = await this.db.prepare(`
      INSERT INTO messages (id, contact_id, draft_text, status, compliance_checked)
      VALUES (?1, ?2, ?3, 'drafted', 0) RETURNING *
    `).bind(id, contactId, draft).first<MessageRow>();
    if (!row) throw new Error('Draft was not created');
    return decodeMessage(row);
  }

  /** Save the complete connection note only if its original contact data is still current. */
  async saveConnectionNote(contact: DraftContact, text: string): Promise<Message> {
    if (!text.trim() || text.length > CONNECTION_NOTE_MAX_LENGTH || !text.endsWith(OPT_OUT_TEXT)) {
      throw new Error('Connection note must be under 300 characters and include the opt-out path');
    }
    const row = await this.db.prepare(`
      INSERT INTO messages (id, contact_id, draft_text, status, compliance_checked)
      SELECT ?1, id, ?2, 'drafted', 0 FROM contacts
      WHERE id = ?3 AND name IS ?4 AND headline IS ?5 AND company IS ?6 AND source_post_url = ?7
        AND suppressed = 0 AND retention_expires_at > unixepoch()
        AND icp_status <> 'rejected'
        AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = contacts.linkedin_url)
      RETURNING *
    `).bind(crypto.randomUUID(), text, contact.id, contact.name, contact.headline,
      contact.company, contact.source_post_url).first<MessageRow>();
    if (!row) throw new Error('Contact changed or is no longer eligible for drafting');
    return decodeMessage(row);
  }

  /** Approval is explicit; both ICP fit and message compliance are required. */
  async queueReviewedMessage(id: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE messages SET status = 'queued', compliance_checked = 1
      WHERE id = ?1 AND status = 'drafted'
        AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = messages.contact_id
          AND c.icp_status = 'qualified' AND c.intent_score BETWEEN 1 AND 5)
    `).bind(id).run();
    return result.meta.changes > 0;
  }

  /** Recheck immediately before sending; a queued message is not a permanent authorization. */
  async getSendableMessage(id: string): Promise<Message | null> {
    const row = await this.db.prepare(`
      SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id
      WHERE m.id = ?1 AND m.status = 'queued' AND m.compliance_checked = 1
        AND instr(m.draft_text, ?2) > 0 AND c.suppressed = 0
        AND c.retention_expires_at > unixepoch()
        AND c.icp_status = 'qualified' AND c.intent_score BETWEEN 1 AND 5
        AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = c.linkedin_url)
    `).bind(id, OPT_OUT_TEXT).first<MessageRow>();
    return row ? decodeMessage(row) : null;
  }

  async getSuppression(url: string): Promise<SuppressionEntry | null> {
    return this.db.prepare('SELECT * FROM suppression_list WHERE linkedin_url = ?1')
      .bind(normalizeLinkedInUrl(url)).first<SuppressionEntry>();
  }

  /** Permanent and idempotent. Triggers suppress contacts and cancel pending messages atomically. */
  async suppress(url: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('Suppression reason must not be empty');
    await this.db.prepare(`
      INSERT INTO suppression_list (linkedin_url, reason, added_at) VALUES (?1, ?2, ?3)
      ON CONFLICT (linkedin_url) DO NOTHING
    `).bind(normalizeLinkedInUrl(url), reason.trim(), nowSeconds()).run();
  }

  /** Uses the immutable collected_at + retention_seconds deadline; never last activity. */
  async deleteExpiredContacts(limit = 100, cutoff = nowSeconds()): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1–1000');
    timestamp(cutoff);
    const result = await this.db.prepare(`
      DELETE FROM contacts WHERE id IN (
        SELECT id FROM contacts WHERE retention_expires_at <= ?2
        ORDER BY retention_expires_at, id LIMIT ?1
      ) RETURNING id
    `).bind(limit, cutoff).all<{ id: string }>();
    return result.results.length;
  }

  async hasExpiredContacts(cutoff = nowSeconds()): Promise<boolean> {
    timestamp(cutoff);
    return await this.db.prepare('SELECT id FROM contacts WHERE retention_expires_at <= ?1 LIMIT 1')
      .bind(cutoff).first<{ id: string }>() !== null;
  }
}
