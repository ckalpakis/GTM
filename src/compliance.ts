import { Database, type Contact, type Message } from './db';
import { candidateNotes } from './drafting';

export type ComplianceResult =
  | { ok: true; message: Message; contact: Contact }
  | { ok: false; reason: 'missing' | 'suppressed' | 'expired' | 'icp' | 'status' | 'ungrounded' };

/** Re-read persisted facts; never trust an old compliance_checked flag or an LLM verdict. */
export async function checkMessageCompliance(binding: D1Database, messageId: string): Promise<ComplianceResult> {
  const db = new Database(binding);
  const message = await db.getMessage(messageId);
  if (!message) return { ok: false, reason: 'missing' };
  const contact = await db.getContact(message.contact_id);
  if (!contact) return { ok: false, reason: 'missing' };
  if (contact.suppressed || await db.getSuppression(contact.linkedin_url)) return { ok: false, reason: 'suppressed' };
  if (contact.retention_expires_at <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  if (contact.icp_status !== 'qualified' || contact.intent_score === null) return { ok: false, reason: 'icp' };
  if (!['drafted', 'queued'].includes(message.status)) return { ok: false, reason: 'status' };
  // These notes assert an observed reaction. Require sourcing evidence for that assertion.
  const provenance = await db.getProvenance(contact.id);
  const fields = ['linkedin_url', 'source_post_url', 'reaction_type'];
  if (contact.name) fields.push('name');
  if (contact.source !== 'apify_post_engagement' || !contact.reaction_type ||
      !fields.every(field => provenance.some(p => p.field_name === field && p.source === 'apify_post_engagement'))) {
    return { ok: false, reason: 'ungrounded' };
  }
  try {
    // Exact matching also checks the post, greeting, 299-character ceiling and STOP footer.
    if (!candidateNotes(contact).includes(message.draft_text)) return { ok: false, reason: 'ungrounded' };
  } catch { return { ok: false, reason: 'ungrounded' }; }
  return { ok: true, message, contact };
}
