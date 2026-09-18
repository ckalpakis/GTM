# Steel Scale outreach desk: first deployment

This repository already used Cloudflare Workers and D1. Keep that stack; Railway,
a second CRM, and a second application are not needed for this release.

## What this release does

- Authenticated operator dashboard at `/`, backed by D1.
- Imports up to 50 researched LinkedIn prospects from JSON, with source URLs,
  dates and business-fit evidence. Imports start pending human review.
- Creates personalized openers, reply drafts and two follow-up drafts using the
  verified event and the most recent 30 recorded conversation turns.
- Records manual sends and incoming replies, pauses/takeover, permanent opt-outs,
  and follow-up due dates (3 business days, then 5 more).
- Optional existing Unipile inbound webhook records incoming replies and drafts a
  response. In draft mode it does not send replies or automatically forward to GHL.
- One explicit handoff button sends the summary and conversation to your GHL
  inbound workflow. Uncertain requests are held for reconciliation, never retried.

This is a usable **manual LinkedIn pilot**, not a deployed autonomous multi-channel
setter. There is no SMS sender, phone validation, SMS consent database, calendar
integration, automatic scraping schedule, or automatic follow-up sending in this
release. The 25/day Monday-Saturday figure is a pilot target displayed in the UI,
not an enforced cap on manual activity. Only actual confirmed manual sends are logged.
The console does not verify that a copied message was really delivered.

## 1. Create the database

Install Node 22+ and run in this repository:

```sh
npm ci
npx wrangler login
npm run db:create
```

Copy the database ID into `wrangler.jsonc`, replacing
`00000000-0000-0000-0000-000000000000`. Do not change the DB binding name.

```sh
npm run db:migrate:remote
```

## 2. Configure secrets

Generate your dashboard token locally:

```sh
openssl rand -hex 32
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CONTACT_RETENTION_SECONDS
```

Store the token in your password manager. For retention choose a period; for example
`2592000` is 30 days. Expiry is measured from original collection, not activity.
The model defaults to `gpt-4.1-mini`; set `OPENAI_MODEL` to a model available in your
API account that supports the Responses API and JSON structured outputs if desired.
Do not assume a ChatGPT subscription supplies API credits or model access.

Keep these checked-in defaults:

```json
{"SETTER_MODE":"draft","DAILY_SEND_CAP":"0","MAX_SENDS_PER_RUN":"0"}
```

Draft mode bypasses the legacy invitation cron even if someone changes the caps.
Contacts enrolled in the desk also cannot enter the legacy invitation queue.

## 3. Set up the GHL handoff

In the Steel Scale Systems subaccount `QIyjNHe4ogZ2NBz9UnTM`, create a separate
workflow with an **Inbound Webhook** trigger. Store that trigger's secret URL:

```sh
npx wrangler secret put GHL_WEBHOOK_URL
```

Map `contact_id` to a dedicated external-ID custom field and deduplicate on it.
Map `name`, `company`, `linkedin_url`, `summary` and `signal_url`. The payload also
contains `event_id`, `stage=human_handoff`, `conversation` and `booked=false`.
Configure your workflow to create a task/notification for Carson and, where your
GHL workflow supports it, create or update the contact/opportunity. An incoming
webhook alone does not automatically create a CRM contact. Do not attach an SMS
blast tag or start your opener workflows from this handoff.

The sender includes an Idempotency-Key, but does not assume GHL honors it. A 2xx
response means the webhook was accepted, not that its actions finished or a call
was booked. An `unknown` or stuck `dispatching` result requires checking GHL logs;
the dashboard deliberately cannot resend it. No private integration token is
required for this one-way handoff. Live two-way CRM sync is not implemented.

## 4. Deploy and test with your own test profile

```sh
npm run typecheck
npm test
npm run build
npm run deploy
```

Open the Worker URL, enter your admin token, and check the connection indicators.
Keep the URL on HTTPS. No actual prospects or credentials are included in the repo.
Import a test record with your own LinkedIn URL, then save evidence, confirm fit,
and draft an opener. Copy it only if you intend to send it manually.

Paste test replies to check conversation flow. Record a send only after actually
sending. Use **Take over** to pause drafts and **Forward handoff to GHL** to test
your own receiving workflow. Test **Do not contact** on a disposable test profile;
that identity remains permanently suppressed even after its contact expires.

For local development use `.dev.vars` (copy the example and fill the required
values), `npm run db:migrate:local`, then `npm run dev`. Never commit `.dev.vars`.

## 5. Daily operation and scraping handoff

Keep existing scraper batches separate. This release does not change their
schedule. Complete the GHL baseline and previous-delivery duplicate checks in the
research process **before** importing. The application deduplicates normalized
LinkedIn URLs only; it does not have your GHL export, business aliases or phones.

Import JSON using the dashboard or authenticated `POST /api/import`:

```json
{
  "rows": [{
    "name": "Example Owner",
    "company": "Example Service Business",
    "linkedin_url": "https://www.linkedin.com/in/example-owner",
    "headline": "Owner",
    "signal": "Announced a second location. Replace with an actually verified fact.",
    "signal_url": "https://example.com/news/second-location",
    "signal_date": "2026-09-18",
    "qualification_evidence": "Replace with business scale, current ownership and profile corroboration sources."
  }]
}
```

The importer accepts 1–50 rows, not arbitrary CSV files. Inspect per-row results;
invalid or duplicate rows do not count as imported. Verify evidence yourself;
the application validates structure, not the truth of the source. Existing
profiles are skipped rather than having their collection date reset. Imports do
not infer buying intent. Human fit approval sets score 1, meaning no explicit
purchase intent established.

Use the list filters for due follow-ups and handoffs. The list shows the newest
500 unexpired contacts. Pause contacts you don't want to continue with. On LinkedIn,
only record a post-acceptance message when it has actually been sent; acceptance
is not automatically detected. Follow-up drafting is blocked until its due date.
The business-day calculation skips Saturday/Sunday, not public holidays; daylight
saving transitions can shift the displayed hour by one hour.

## Optional inbound connection and next automation phase

The existing Unipile webhook remains available. If you already have a permitted
use and connected account, configure it using the README instructions. In draft
mode incoming events only record/draft; the operator sends and forwards handoffs.
Do not interpret availability of a third-party connector as LinkedIn approval.
[LinkedIn prohibits unauthorized automated website activity](https://www.linkedin.com/help/linkedin/answer/a1341387).

To add SMS later, implement a Twilio adapter with signed inbound validation, a
consent ledger, number eligibility, recipient-local sending windows, idempotent
send attempts, delivery callbacks, pause/opt-out rechecks and a real 25-new-contact
daily limit. Use one SMS sender path, not competing GHL and Twilio workflows.
[Twilio requires consent for promotional messaging](https://www.twilio.com/en-us/legal/messaging-policy).
Published phone numbers or LinkedIn acceptance do not establish that consent.

Automatic reply sending should be a separate reviewed change after the draft
pilot proves the prompts and routing. No booking should be marked confirmed
without a calendar event or a manual confirmation from Carson.

## Security and data handling

Admin API uses a high-entropy bearer token held only in browser memory. No CORS or
cookie auth is enabled. Untrusted text is rendered as text, not HTML. Source data
and replies are untrusted input to the model; every generated message remains a
human-reviewed draft. No guarantee is made that model text is perfectly grounded.
The latest 30 conversation turns plus business context go to the configured OpenAI
API (`store:false`); a requested GHL handoff also includes those turns. Do not store
patient, tenant or insurance-client records in this prospecting workspace.

Contact deletion cascades to drafts, transcript and handoff records. Permanent
suppression survives. Do not expose the admin token to prospects or place secrets
in URLs. Rotate it with `wrangler secret put ADMIN_TOKEN` if compromised. This is
a single-operator application; roles, audit-grade operator identity, bulk CSV
exports, business/phone deduplication and automated SMS are future work.
