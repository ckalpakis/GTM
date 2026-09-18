import { Database, type Contact } from "./db";
import {
  classifyReply,
  type ReplyClassification,
  type ReplyLlmEnvironment,
} from "./reply-classification";

export interface ReplyEnvironment extends ReplyLlmEnvironment {
  SETTER_MODE?: string;
  DB: D1Database;
  UNIPILE_ACCOUNT_ID?: string;
  UNIPILE_WEBHOOK_SECRET?: string;
  GHL_WEBHOOK_URL?: string;
}
interface ReplyEvent {
  id: string;
  contact_id: string;
  classification: ReplyClassification | null;
  status:
    | "pending"
    | "processing"
    | "classified"
    | "dispatching"
    | "delivered"
    | "ignored"
    | "unknown";
}
const now = () => Math.floor(Date.now() / 1000);

export async function processReply(
  env: ReplyEnvironment,
  contact: Contact,
  providerUrl: string,
  messageId: string,
  text: string,
  fetcher: typeof fetch,
): Promise<Response> {
  const db = new Database(env.DB);
  async function eligible(): Promise<Contact | null> {
    const current = await db.getContact(contact.id);
    if (
      !current ||
      current.suppressed ||
      current.retention_expires_at <= now() ||
      (await db.getSuppression(current.linkedin_url)) ||
      (await db.getSuppression(providerUrl))
    )
      return null;
    return current;
  }
  if (!(await eligible()))
    return Response.json({ ignored: true, reason: "ineligible_contact" });
  await env.DB.prepare(
    `INSERT INTO reply_events (id, account_id, message_id, contact_id, received_at)
    VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (account_id, message_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      env.UNIPILE_ACCOUNT_ID!,
      messageId,
      contact.id,
      now(),
    )
    .run();
  let event = await env.DB.prepare(
    "SELECT * FROM reply_events WHERE account_id = ?1 AND message_id = ?2",
  )
    .bind(env.UNIPILE_ACCOUNT_ID!, messageId)
    .first<ReplyEvent>();
  if (!event || event.contact_id !== contact.id)
    return new Response("Event identity conflict", { status: 409 });
  if (
    ["delivered", "ignored", "dispatching", "unknown"].includes(event.status)
  ) {
    return Response.json({
      classification: event.classification,
      handoff: event.status,
      duplicate: true,
    });
  }
  if (!event.classification) {
    const token = crypto.randomUUID();
    const claimed = await env.DB.prepare(
      `UPDATE reply_events SET status = 'processing', lease_token = ?2,
      lease_expires_at = ?3, error_code = NULL WHERE id = ?1 AND
      (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?4)) RETURNING id`,
    )
      .bind(event.id, token, now() + 60, now())
      .first();
    if (!claimed)
      return new Response("Reply processing in progress", { status: 503 });
    let classification: ReplyClassification;
    try {
      classification = await classifyReply(text, env, fetcher);
    } catch {
      await env.DB.prepare(
        `UPDATE reply_events SET status = 'pending', lease_token = NULL,
        lease_expires_at = NULL, error_code = 'classification_failed' WHERE id = ?1 AND lease_token = ?2`,
      )
        .bind(event.id, token)
        .run();
      return new Response("Reply classification unavailable", { status: 503 });
    }
    const updated = await env.DB.prepare(
      `UPDATE reply_events SET classification = ?3, status = ?4,
      lease_token = NULL, lease_expires_at = NULL WHERE id = ?1 AND lease_token = ?2 RETURNING *`,
    )
      .bind(
        event.id,
        token,
        classification,
        classification === "interested" ? "classified" : "ignored",
      )
      .first<ReplyEvent>();
    if (!updated)
      return new Response("Reply processing superseded", { status: 503 });
    event = updated;
  }
  if (event.classification !== "interested")
    return Response.json({
      classification: event.classification,
      handoff: "ignored",
    });
  const current = await eligible();
  if (!current) {
    await env.DB.prepare(
      "UPDATE reply_events SET status = 'ignored' WHERE id = ?1 AND status = 'classified'",
    )
      .bind(event.id)
      .run();
    return Response.json({ ignored: true, reason: "ineligible_contact" });
  }
  let url: URL;
  try {
    url = new URL(env.GHL_WEBHOOK_URL || "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Invalid URL");
  } catch {
    return new Response("GHL_WEBHOOK_URL is not configured correctly", {
      status: 503,
    });
  }
  // Claim dispatch once, and check suppression/expiry in the same SQL statement.
  const dispatch = await env.DB.prepare(
    `UPDATE reply_events SET status = 'dispatching' WHERE id = ?1
    AND status = 'classified' AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = reply_events.contact_id
      AND c.suppressed = 0 AND c.retention_expires_at > ?2
      AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url IN (c.linkedin_url, ?3))) RETURNING id`,
  )
    .bind(event.id, now(), providerUrl)
    .first();
  if (!dispatch)
    return Response.json({
      ignored: true,
      reason: "already_claimed_or_ineligible",
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let accepted = false;
  try {
    const response = await fetcher(url.toString(), {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": event.id,
      },
      body: JSON.stringify({
        event_id: event.id,
        unipile_message_id: messageId,
        classification: "interested",
        contact_id: current.id,
        linkedin_url: current.linkedin_url,
        name: current.name,
        headline: current.headline,
        company: current.company,
        source: current.source,
        source_post_url: current.source_post_url,
        collected_at: current.collected_at,
        retention_expires_at: current.retention_expires_at,
        icp_status: current.icp_status,
        intent_score: current.intent_score,
      }),
    });
    accepted = response.ok;
    await response.body?.cancel();
  } catch {
    /* Delivery may have happened; never automatically repeat this POST. */
  } finally {
    clearTimeout(timer);
  }
  await env.DB.prepare(
    `UPDATE reply_events SET status = ?2, delivered_at = ?3, error_code = ?4
    WHERE id = ?1 AND status = 'dispatching'`,
  )
    .bind(
      event.id,
      accepted ? "delivered" : "unknown",
      accepted ? now() : null,
      accepted ? null : "handoff_unconfirmed",
    )
    .run();
  if (!accepted) {
    console.error("GoHighLevel handoff requires reconciliation", {
      event_id: event.id,
    });
    return Response.json(
      { classification: "interested", handoff: "unknown" },
      { status: 502 },
    );
  }
  return Response.json({ classification: "interested", handoff: "delivered" });
}
