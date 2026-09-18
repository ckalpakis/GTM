# Project: outbound-agent

Building a DIY replica of TryGTM (LinkedIn outbound automation) for Steel Scale Systems.

Stack: Cloudflare Workers + TypeScript, D1 for storage, Cron Triggers for scheduling.
Sourcing: Apify actor "linkedin-post-reactions-scraper" (cookieless, no LinkedIn login).
Sending: Unipile API (connected LinkedIn account, self-managed pacing).
LLM: OpenAI/Grok API for drafting and reply classification.
Output: push interested/booked contacts to GoHighLevel via webhook.

Compliance rules that must never be bypassed:

- Every outbound message needs an unsubscribe/opt-out path before it can send.
- Suppression list entries are permanent and exempt from any cleanup job.
- Opt-out keyword check runs before any AI classification of a reply.
- Retention timer is computed from when a contact was collected, not last touched.
