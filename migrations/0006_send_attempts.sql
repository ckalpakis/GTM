-- Counts survive contact/message retention cleanup. No message text or profile URLs
-- are stored here; foreign keys become NULL when personal data expires.
CREATE TABLE send_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  send_day TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'dispatching', 'succeeded', 'failed', 'unknown', 'cancelled')),
  error_code TEXT,
  UNIQUE (account_id, contact_id)
) STRICT;
CREATE INDEX send_attempts_daily_idx ON send_attempts(account_id, send_day);

CREATE TABLE contact_provider_ids (
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, provider_id),
  UNIQUE (account_id, contact_id)
) STRICT;

-- The reservation and this transition are a single atomic statement/transaction.
CREATE TRIGGER send_attempts_queue_message
AFTER INSERT ON send_attempts
BEGIN
  UPDATE messages SET status = 'queued', compliance_checked = 1 WHERE id = NEW.message_id;
END;

CREATE TRIGGER messages_lock_attempted_text
BEFORE UPDATE OF draft_text, contact_id ON messages
WHEN (NEW.draft_text <> OLD.draft_text OR NEW.contact_id <> OLD.contact_id)
  AND EXISTS (SELECT 1 FROM send_attempts WHERE message_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Attempted message content is immutable');
END;

-- A reply/opt-out can arrive while Unipile is responding. Recording an already
-- acknowledged send is historical bookkeeping, not new permission to send.
DROP TRIGGER messages_check_contact_update;
CREATE TRIGGER messages_check_contact_update
BEFORE UPDATE ON messages
WHEN NEW.status = 'queued' AND NOT EXISTS (
  SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id
    AND c.suppressed = 0 AND c.retention_expires_at > unixepoch()
    AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = c.linkedin_url)
)
BEGIN
  SELECT RAISE(ABORT, 'Contact is suppressed, expired, or missing');
END;

DROP TRIGGER messages_require_icp_update;
CREATE TRIGGER messages_require_icp_update
BEFORE UPDATE ON messages
WHEN NEW.status = 'queued' AND NOT EXISTS (
  SELECT 1 FROM contacts WHERE id = NEW.contact_id
    AND icp_status = 'qualified' AND intent_score BETWEEN 1 AND 5
)
BEGIN
  SELECT RAISE(ABORT, 'Message requires a positive ICP fit');
END;

CREATE TRIGGER messages_require_send_receipt
BEFORE UPDATE OF status ON messages
WHEN NEW.status = 'sent' AND OLD.status <> 'sent' AND NOT EXISTS (
  SELECT 1 FROM send_attempts WHERE message_id = NEW.id AND status = 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'Sending requires a successful provider response');
END;

CREATE TRIGGER messages_no_direct_sent_insert
BEFORE INSERT ON messages WHEN NEW.status = 'sent'
BEGIN
  SELECT RAISE(ABORT, 'Sending requires a successful provider response');
END;
