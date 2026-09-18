import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { beforeEach, afterEach, test } from "node:test";
import { URL as NodeURL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { Database, type Contact } from "../src/db.ts";
import { handleUnipileWebhook, type ReplyEnvironment } from "../src/replies.ts";

let mf: Miniflare;
let env: ReplyEnvironment;
let db: Database;
let contact: Contact;
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: "2026-09-17",
      d1Databases: { DB: "reply-tests" },
    }),
  );
  const binding = (await mf.getD1Database("DB")) as unknown as D1Database;
  const directory = new NodeURL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(new NodeURL(file, directory), "utf8");
    await binding.batch(
      unstable_splitSqlQuery(sql).map((statement) =>
        binding.prepare(statement),
      ),
    );
  }
  env = {
    DB: binding,
    UNIPILE_ACCOUNT_ID: "account-test",
    UNIPILE_WEBHOOK_SECRET: "a".repeat(32),
    OPENAI_API_KEY: "test-key",
    GHL_WEBHOOK_URL: "https://ghl.example.test/inbound/secret",
  };
  db = new Database(binding);
  contact = await db.createContact({
    linkedin_url: "https://www.linkedin.com/in/jane",
    name: "Jane Doe",
    company: "Example",
    source_post_url: "https://www.linkedin.com/posts/example",
    collected_at: Math.floor(Date.now() / 1000),
    retention_seconds: 86400,
    source: "apify_post_engagement",
    sources: {
      linkedin_url: "apify_post_engagement",
      name: "apify_post_engagement",
      company: "apify_post_engagement",
      source_post_url: "apify_post_engagement",
    },
  });
  await binding
    .prepare(
      "INSERT INTO contact_provider_ids (account_id, provider_id, contact_id) VALUES (?, ?, ?)",
    )
    .bind("account-test", "provider-jane", contact.id)
    .run();
});
afterEach(async () => {
  await mf?.dispose();
});

function request(
  message = "Can we schedule a demo?",
  extra: Record<string, unknown> = {},
) {
  return new Request("https://worker.test/webhooks/unipile", {
    method: "POST",
    headers: { "Unipile-Auth": env.UNIPILE_WEBHOOK_SECRET! },
    body: JSON.stringify({
      event: "message_received",
      message_id: "message-1",
      account_id: "account-test",
      account_type: "LINKEDIN",
      account_info: { user_id: "self" },
      message,
      sender: {
        attendee_provider_id: "provider-jane",
        attendee_profile_url: contact.linkedin_url,
      },
      ...extra,
    }),
  });
}
function model(classification: unknown) {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: JSON.stringify({ classification }) },
        ],
      },
    ],
  });
}
const neverFetch: typeof fetch = async () => {
  assert.fail("Must not make an API call");
};
async function ledger() {
  return env.DB.prepare("SELECT * FROM reply_events").first<
    Record<string, unknown>
  >();
}

test("all required opt-out keywords bypass missing LLM/GHL config and event IDs", async () => {
  delete env.OPENAI_API_KEY;
  delete env.GHL_WEBHOOK_URL;
  for (const text of [
    "STOP",
    "please unsubscribe",
    "Not Interested",
    "remove me",
  ]) {
    const response = await handleUnipileWebhook(
      request(text, { message_id: null }),
      env,
      neverFetch,
    );
    assert.deepEqual(await response.json(), { opted_out: true });
  }
  assert.ok(await db.getSuppression(contact.linkedin_url));
  assert.ok(
    await db.getSuppression("https://www.linkedin.com/in/provider-jane"),
  );
  assert.equal(await ledger(), null);
});

test("interested reply posts contact JSON once and persists delivery across duplicates", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (String(input).startsWith("https://api.openai.com/")) {
      assert.equal(body.store, false);
      assert.equal(body.text.format.strict, true);
      assert.equal(
        JSON.parse(body.input[0].content).reply,
        "Can we schedule a demo?",
      );
      return model("interested");
    }
    assert.equal(String(input), env.GHL_WEBHOOK_URL);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(body.contact_id, contact.id);
    assert.equal(body.linkedin_url, contact.linkedin_url);
    assert.equal(body.company, "Example");
    assert.equal(body.collected_at, contact.collected_at);
    assert.equal(body.retention_expires_at, contact.retention_expires_at);
    assert.equal(body.classification, "interested");
    assert.equal(body.unipile_message_id, "message-1");
    assert.equal(
      new Headers(init?.headers).get("Idempotency-Key"),
      body.event_id,
    );
    assert.equal(body.reply, undefined);
    return new Response(null, { status: 204 });
  };
  assert.deepEqual(
    await (await handleUnipileWebhook(request(), env, fetcher)).json(),
    {
      classification: "interested",
      handoff: "delivered",
    },
  );
  assert.equal((await ledger())?.status, "delivered");
  assert.ok((await ledger())?.delivered_at);
  assert.equal(
    (await handleUnipileWebhook(request(), env, neverFetch)).status,
    200,
  );
  assert.equal(calls, 2);
});

test("neutral and semantic rejection are classified without GHL calls", async () => {
  delete env.GHL_WEBHOOK_URL;
  for (const classification of ["neutral", "not interested"]) {
    const fetcher: typeof fetch = async (input) => {
      assert.equal(String(input), "https://api.openai.com/v1/responses");
      return model(classification);
    };
    const response = await handleUnipileWebhook(
      request("Thanks for asking.", { message_id: classification }),
      env,
      fetcher,
    );
    assert.deepEqual(await response.json(), {
      classification,
      handoff: "ignored",
    });
  }
});

test("invalid, refused and failed classifications never deliver and can be retried", async () => {
  for (const payload of [
    model("invalid"),
    model(["interested"]),
    Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    }),
    new Response("secret provider details", { status: 500 }),
  ]) {
    const response = await handleUnipileWebhook(
      request(),
      env,
      async () => payload,
    );
    assert.equal(response.status, 503);
    assert.equal((await ledger())?.status, "pending");
    assert.equal((await ledger())?.classification, null);
  }
  assert.equal(
    (await handleUnipileWebhook(request(), env, async () => model("neutral")))
      .status,
    200,
  );
});

test("missing GHL URL preserves classification for a retry after configuration", async () => {
  const configuredUrl = env.GHL_WEBHOOK_URL!;
  delete env.GHL_WEBHOOK_URL;
  assert.equal(
    (
      await handleUnipileWebhook(request(), env, async () =>
        model("interested"),
      )
    ).status,
    503,
  );
  assert.equal((await ledger())?.status, "classified");
  env.GHL_WEBHOOK_URL = configuredUrl;
  const response = await handleUnipileWebhook(request(), env, async (input) => {
    assert.equal(String(input), configuredUrl);
    return new Response("ok");
  });
  assert.equal(response.status, 200);
  assert.equal((await ledger())?.status, "delivered");
});

test("concurrent webhook deliveries classify and hand off only once", async () => {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const first = handleUnipileWebhook(request(), env, async (input) => {
    calls++;
    if (String(input).includes("openai.com")) {
      started();
      await gate;
      return model("interested");
    }
    return new Response("ok");
  });
  await entered;
  try {
    assert.equal(
      (await handleUnipileWebhook(request(), env, neverFetch)).status,
      503,
    );
  } finally {
    release();
  }
  assert.equal((await first).status, 200);
  assert.equal(calls, 2);
});

test("opt-out edit during classification suppresses before dedup and blocks handoff", async () => {
  let calls = 0;
  const result = await handleUnipileWebhook(request(), env, async () => {
    calls++;
    const optOut = await handleUnipileWebhook(
      request("remove me", { event: "message_edited" }),
      env,
      neverFetch,
    );
    assert.deepEqual(await optOut.json(), { opted_out: true });
    return model("interested");
  });
  assert.deepEqual(await result.json(), {
    ignored: true,
    reason: "ineligible_contact",
  });
  assert.equal(calls, 1);
  assert.equal((await ledger())?.status, "ignored");
});

test("unconfirmed GHL responses and network failures are held without automatic resend", async () => {
  for (const failure of ["http", "network"]) {
    const event = request("Please share pricing", { message_id: failure });
    const response = await handleUnipileWebhook(event, env, async (input) => {
      if (String(input).includes("openai.com")) return model("interested");
      if (failure === "network") throw new Error("Network failed");
      return new Response("Unavailable", { status: 503 });
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      classification: "interested",
      handoff: "unknown",
    });
    const duplicate = await handleUnipileWebhook(
      request("Please share pricing", { message_id: failure }),
      env,
      neverFetch,
    );
    assert.equal(
      ((await duplicate.json()) as { handoff: string }).handoff,
      "unknown",
    );
  }
});

test("unknown senders, own messages, edits and suppressed contacts do not invoke AI", async () => {
  for (const extra of [
    { sender: { attendee_provider_id: "unknown" } },
    { sender: { attendee_provider_id: "self" } },
    { event: "message_edited" },
  ])
    assert.equal(
      (await handleUnipileWebhook(request("Hello", extra), env, neverFetch))
        .status,
      200,
    );
  await db.suppress(contact.linkedin_url, "Opt-out");
  assert.equal(
    (await handleUnipileWebhook(request(), env, neverFetch)).status,
    200,
  );
});

test("reply records cascade on contact removal and suppression stays permanent", async () => {
  await handleUnipileWebhook(request(), env, async () => model("neutral"));
  await db.suppress(contact.linkedin_url, "Opt-out");
  await env.DB.prepare("DELETE FROM contacts WHERE id = ?")
    .bind(contact.id)
    .run();
  assert.equal(await ledger(), null);
  assert.ok(await db.getSuppression(contact.linkedin_url));
});

test("expired classification lease can be recovered without stranding a reply", async () => {
  await env.DB.prepare(
    `INSERT INTO reply_events
    (id, account_id, message_id, contact_id, status, lease_token, lease_expires_at, received_at)
    VALUES ('old-event', 'account-test', 'message-1', ?, 'processing', 'old-token', 0, 0)`,
  )
    .bind(contact.id)
    .run();
  assert.equal(
    (await handleUnipileWebhook(request(), env, async () => model("neutral")))
      .status,
    200,
  );
  assert.equal((await ledger())?.classification, "neutral");
});
