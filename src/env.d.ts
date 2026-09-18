// Secrets/configuration are optional at startup; sourcing validates them before any API call.
interface Env {
  APIFY_TOKEN?: string;
  CONTACT_RETENTION_SECONDS?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  ICP_CRITERIA?: string;
  UNIPILE_DSN?: string;
  UNIPILE_API_KEY?: string;
  UNIPILE_ACCOUNT_ID?: string;
  UNIPILE_WEBHOOK_SECRET?: string;
  GHL_WEBHOOK_URL?: string;
}

declare namespace Cloudflare {
  interface Env {
    APIFY_TOKEN?: string;
    CONTACT_RETENTION_SECONDS?: string;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    ICP_CRITERIA?: string;
    UNIPILE_DSN?: string;
    UNIPILE_API_KEY?: string;
    UNIPILE_ACCOUNT_ID?: string;
    UNIPILE_WEBHOOK_SECRET?: string;
    GHL_WEBHOOK_URL?: string;
  }
}
