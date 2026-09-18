-- Rebuild the status CHECK without losing existing messages or send safeguards.
-- External triggers must be removed briefly while the messages table is replaced.
DROP TRIGGER contacts_persist_suppression_update;
DROP TRIGGER contacts_icp_cancel_queue;

CREATE TABLE messages_new (
  id TEXT PRIMARY KEY NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  draft_text TEXT NOT NULL CHECK (length(trim(draft_text)) > 0),
  status TEXT NOT NULL DEFAULT 'drafted'
    CHECK (status IN ('drafted', 'queued', 'sent', 'failed', 'cancelled')),
  sent_at INTEGER CHECK (sent_at >= 0),
  compliance_checked INTEGER NOT NULL DEFAULT 0 CHECK (compliance_checked IN (0, 1)),
  CHECK ((status = 'sent' AND sent_at IS NOT NULL) OR
         (status <> 'sent' AND sent_at IS NULL)),
  CHECK (status NOT IN ('queued', 'sent') OR (
    compliance_checked = 1 AND instr(draft_text, 'Reply STOP to opt out.') > 0
  ))
) STRICT;

INSERT INTO messages_new (id, contact_id, draft_text, status, sent_at, compliance_checked)
SELECT id, contact_id, draft_text, CASE WHEN status = 'draft' THEN 'drafted' ELSE status END,
  sent_at, CASE WHEN status = 'draft' THEN 0 ELSE compliance_checked END
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_contact_idx ON messages(contact_id);
CREATE INDEX messages_status_idx ON messages(status);

CREATE TRIGGER contacts_persist_suppression_update
AFTER UPDATE OF suppressed ON contacts
WHEN NEW.suppressed = 1 AND OLD.suppressed = 0
BEGIN
  INSERT INTO suppression_list (linkedin_url, reason, added_at)
  VALUES (NEW.linkedin_url, 'Contact suppressed', unixepoch())
  ON CONFLICT (linkedin_url) DO NOTHING;
  UPDATE messages SET status = 'cancelled', compliance_checked = 0
  WHERE contact_id = NEW.id AND status IN ('drafted', 'queued', 'failed');
END;

CREATE TRIGGER contacts_icp_cancel_queue
AFTER UPDATE OF icp_status ON contacts
WHEN NEW.icp_status <> 'qualified'
BEGIN
  UPDATE messages SET status = 'cancelled', compliance_checked = 0
  WHERE contact_id = NEW.id AND status = 'queued';
END;

CREATE TRIGGER messages_check_contact_insert
BEFORE INSERT ON messages
WHEN NEW.status IN ('queued', 'sent') AND NOT EXISTS (
  SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id
    AND c.suppressed = 0 AND c.retention_expires_at > unixepoch()
    AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = c.linkedin_url)
)
BEGIN
  SELECT RAISE(ABORT, 'Contact is suppressed, expired, or missing');
END;

CREATE TRIGGER messages_check_contact_update
BEFORE UPDATE ON messages
WHEN NEW.status IN ('queued', 'sent') AND NOT EXISTS (
  SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id
    AND c.suppressed = 0 AND c.retention_expires_at > unixepoch()
    AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.linkedin_url = c.linkedin_url)
)
BEGIN
  SELECT RAISE(ABORT, 'Contact is suppressed, expired, or missing');
END;

CREATE TRIGGER messages_edit_requires_review
BEFORE UPDATE OF draft_text, contact_id ON messages
WHEN (NEW.draft_text <> OLD.draft_text OR NEW.contact_id <> OLD.contact_id)
  AND (NEW.status <> 'drafted' OR NEW.compliance_checked <> 0)
BEGIN
  SELECT RAISE(ABORT, 'Edited messages must return to unchecked draft status');
END;

CREATE TRIGGER messages_require_icp_insert
BEFORE INSERT ON messages
WHEN NEW.status IN ('queued', 'sent') AND NOT EXISTS (
  SELECT 1 FROM contacts WHERE id = NEW.contact_id
    AND icp_status = 'qualified' AND intent_score BETWEEN 1 AND 5
)
BEGIN
  SELECT RAISE(ABORT, 'Message requires a positive ICP fit');
END;

CREATE TRIGGER messages_require_icp_update
BEFORE UPDATE ON messages
WHEN NEW.status IN ('queued', 'sent') AND NOT EXISTS (
  SELECT 1 FROM contacts WHERE id = NEW.contact_id
    AND icp_status = 'qualified' AND intent_score BETWEEN 1 AND 5
)
BEGIN
  SELECT RAISE(ABORT, 'Message requires a positive ICP fit');
END;
