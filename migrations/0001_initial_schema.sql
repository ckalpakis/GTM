-- All timestamps are UTC Unix seconds. SQLite represents booleans as 0/1.
CREATE TABLE contacts (
  id TEXT PRIMARY KEY NOT NULL,
  linkedin_url TEXT NOT NULL UNIQUE,
  name TEXT,
  headline TEXT,
  company TEXT,
  source_post_url TEXT NOT NULL,
  collected_at INTEGER NOT NULL CHECK (collected_at >= 0),
  retention_expires_at INTEGER NOT NULL CHECK (retention_expires_at > collected_at),
  icp_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (icp_status IN ('pending', 'qualified', 'rejected')),
  intent_score INTEGER CHECK (intent_score BETWEEN 0 AND 100),
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1))
) STRICT;

CREATE TABLE provenance (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL CHECK (length(trim(field_name)) > 0),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  collected_at INTEGER NOT NULL CHECK (collected_at >= 0),
  PRIMARY KEY (contact_id, field_name)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  draft_text TEXT NOT NULL CHECK (length(trim(draft_text)) > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'queued', 'sent', 'failed', 'cancelled')),
  sent_at INTEGER CHECK (sent_at >= 0),
  compliance_checked INTEGER NOT NULL DEFAULT 0 CHECK (compliance_checked IN (0, 1)),
  CHECK ((status = 'sent' AND sent_at IS NOT NULL) OR
         (status <> 'sent' AND sent_at IS NULL)),
  -- This exact footer is also exported by src/db.ts. Changes need a migration.
  CHECK (status NOT IN ('queued', 'sent') OR (
    compliance_checked = 1 AND
    instr(draft_text, 'Reply STOP to opt out.') > 0
  ))
) STRICT;

-- Deliberately independent of contacts: deletion of personal data must not
-- erase the durable record that prevents future outreach.
CREATE TABLE suppression_list (
  linkedin_url TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  added_at INTEGER NOT NULL CHECK (added_at >= 0)
) STRICT;

CREATE INDEX contacts_retention_idx ON contacts(retention_expires_at);
CREATE INDEX contacts_icp_idx ON contacts(icp_status, suppressed);
CREATE INDEX messages_contact_idx ON messages(contact_id);
CREATE INDEX messages_status_idx ON messages(status);
