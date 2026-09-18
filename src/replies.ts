import { Database, normalizeLinkedInUrl } from './db';
import { processReply, type ReplyEnvironment } from './reply-processing';
export type { ReplyEnvironment } from './reply-processing';

/** This check must precede every AI classification of replies, including retries. */
export function isOptOutReply(text: string): boolean {
  return /\b(?:stop|unsubscribe|opt[ -]?out|remove\s+me|do\s+not\s+contact|don't\s+contact|not\s+interested|no\s+thanks)\b/i
    .test(text.normalize('NFKC').replace(/[’‘]/g, "'"));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function handleUnipileWebhook(request: Request, env: ReplyEnvironment, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.UNIPILE_WEBHOOK_SECRET || env.UNIPILE_WEBHOOK_SECRET.length < 32) return new Response('Unavailable', { status: 503 });
  if (request.headers.get('Unipile-Auth') !== env.UNIPILE_WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
  let event: Record<string, unknown> | null;
  try {
    const body = await request.text();
    if (body.length > 64_000) return new Response('Too large', { status: 413 });
    event = object(JSON.parse(body));
  } catch { return new Response('Invalid JSON', { status: 400 }); }
  if (!env.UNIPILE_ACCOUNT_ID || !event || event.account_id !== env.UNIPILE_ACCOUNT_ID || event.account_type !== 'LINKEDIN') {
    return new Response('Invalid account', { status: 400 });
  }
  if (event.event !== 'message_received' && event.event !== 'message_edited') return Response.json({ ignored: true });
  const sender = object(event.sender);
  const account = object(event.account_info);
  const providerId = sender?.attendee_provider_id;
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(providerId) ||
      typeof account?.user_id !== 'string' || typeof event.message !== 'string') {
    return new Response('Invalid message event', { status: 400 });
  }
  if (providerId === account.user_id) return Response.json({ ignored: true });
  // Evaluate before contact lookup, event deduplication, or LLM configuration checks.
  const optedOut = isOptOutReply(event.message);
  const db = new Database(env.DB);
  const providerUrl = normalizeLinkedInUrl(`https://www.linkedin.com/in/${providerId}`);
  const urls = new Set<string>([providerUrl]);
  // Suppress the stable provider identity immediately, even for unknown contacts.
  if (optedOut) await db.suppress(providerUrl, 'LinkedIn reply opt-out');
  const contact = await env.DB.prepare(`SELECT c.id, c.linkedin_url FROM contact_provider_ids p
    JOIN contacts c ON c.id = p.contact_id WHERE p.account_id = ?1 AND p.provider_id = ?2`)
    .bind(env.UNIPILE_ACCOUNT_ID, providerId).first<{ id: string; linkedin_url: string }>();
  if (contact) urls.add(contact.linkedin_url);
  if (typeof sender?.attendee_profile_url === 'string') {
    // Ignore malformed optional profile URLs; the provider ID and known mapping still suppress.
    try { urls.add(normalizeLinkedInUrl(sender.attendee_profile_url)); }
    catch { /* optional field */ }
  }
  if (optedOut) {
    for (const url of urls) await db.suppress(url, 'LinkedIn reply opt-out');
    return Response.json({ opted_out: true });
  }
  // Edits can add an opt-out, but must not generate another lead handoff.
  if (event.event === 'message_edited' || !event.message.trim()) return Response.json({ ignored: true });
  if (typeof event.message_id !== 'string' || !event.message_id.trim() || event.message_id.length > 512) {
    return new Response('Missing or invalid message_id', { status: 400 });
  }
  let resolved = contact ? await db.getContact(contact.id) : null;
  if (!resolved) {
    for (const url of urls) {
      resolved = await db.findContactByLinkedInUrl(url);
      if (resolved) break;
    }
  }
  if (!resolved) return Response.json({ ignored: true, reason: 'unknown_contact' });
  return processReply(env, resolved, providerUrl, event.message_id, event.message, fetcher);
}
