CREATE TRIGGER suppression_no_delete
BEFORE DELETE ON suppression_list
BEGIN
  SELECT RAISE(ABORT, 'Suppression entries are permanent');
END;

CREATE TRIGGER suppression_no_update
BEFORE UPDATE ON suppression_list
BEGIN
  SELECT RAISE(ABORT, 'Suppression entries are immutable');
END;

-- Reject INSERT OR REPLACE as well; use ON CONFLICT DO NOTHING for duplicates.
CREATE TRIGGER suppression_no_replace
BEFORE INSERT ON suppression_list
WHEN EXISTS (SELECT 1 FROM suppression_list WHERE linkedin_url = NEW.linkedin_url)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- REPLACE deletes then inserts, which could otherwise restart the retention clock.
CREATE TRIGGER contacts_no_replace
BEFORE INSERT ON contacts
WHEN EXISTS (SELECT 1 FROM contacts WHERE id = NEW.id OR linkedin_url = NEW.linkedin_url)
BEGIN
  SELECT RAISE(ABORT, 'Duplicate contact; original retention must be preserved');
END;

CREATE TRIGGER contacts_collection_immutable
BEFORE UPDATE OF collected_at, retention_expires_at, linkedin_url ON contacts
WHEN NEW.collected_at <> OLD.collected_at
  OR NEW.retention_expires_at <> OLD.retention_expires_at
  OR NEW.linkedin_url <> OLD.linkedin_url
BEGIN
  SELECT RAISE(ABORT, 'Contact identity and original retention window are immutable');
END;

CREATE TRIGGER contacts_no_unsuppress
BEFORE UPDATE OF suppressed ON contacts
WHEN NEW.suppressed = 0 AND (OLD.suppressed = 1 OR EXISTS (
  SELECT 1 FROM suppression_list WHERE linkedin_url = NEW.linkedin_url
))
BEGIN
  SELECT RAISE(ABORT, 'Suppression cannot be reversed');
END;

CREATE TRIGGER contacts_check_suppression
AFTER INSERT ON contacts
WHEN EXISTS (SELECT 1 FROM suppression_list WHERE linkedin_url = NEW.linkedin_url)
BEGIN
  UPDATE contacts SET suppressed = 1 WHERE id = NEW.id;
END;

CREATE TRIGGER suppression_sync_contacts
AFTER INSERT ON suppression_list
BEGIN
  UPDATE contacts SET suppressed = 1 WHERE linkedin_url = NEW.linkedin_url;
END;

-- Directly setting the flag must also persist suppression after contact cleanup.
CREATE TRIGGER contacts_persist_suppression_insert
AFTER INSERT ON contacts
WHEN NEW.suppressed = 1
BEGIN
  INSERT INTO suppression_list (linkedin_url, reason, added_at)
  VALUES (NEW.linkedin_url, 'Contact suppressed', unixepoch())
  ON CONFLICT (linkedin_url) DO NOTHING;
END;

CREATE TRIGGER contacts_persist_suppression_update
AFTER UPDATE OF suppressed ON contacts
WHEN NEW.suppressed = 1 AND OLD.suppressed = 0
BEGIN
  INSERT INTO suppression_list (linkedin_url, reason, added_at)
  VALUES (NEW.linkedin_url, 'Contact suppressed', unixepoch())
  ON CONFLICT (linkedin_url) DO NOTHING;
  UPDATE messages SET status = 'cancelled', compliance_checked = 0
  WHERE contact_id = NEW.id AND status IN ('draft', 'queued', 'failed');
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
  AND (NEW.status <> 'draft' OR NEW.compliance_checked <> 0)
BEGIN
  SELECT RAISE(ABORT, 'Edited messages must return to unchecked draft status');
END;
