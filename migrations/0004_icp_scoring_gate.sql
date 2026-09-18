-- An evaluation token prevents late responses from overwriting a newer decision.
ALTER TABLE contacts ADD COLUMN icp_evaluation_id TEXT;

-- Previous scores used a different scale; re-evaluate rather than reinterpret them.
UPDATE contacts SET icp_status = CASE WHEN icp_status = 'rejected' THEN 'rejected' ELSE 'pending' END,
  intent_score = NULL;
UPDATE messages SET status = 'cancelled', compliance_checked = 0
WHERE status = 'queued';

CREATE TRIGGER contacts_icp_result_insert
BEFORE INSERT ON contacts
WHEN NOT (
  (NEW.icp_status = 'qualified' AND NEW.intent_score IS NOT NULL AND NEW.intent_score BETWEEN 1 AND 5)
  OR (NEW.icp_status IN ('pending', 'rejected') AND NEW.intent_score IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'ICP qualification requires a 1-5 score; other statuses require NULL');
END;

CREATE TRIGGER contacts_icp_result_update
BEFORE UPDATE ON contacts
WHEN NOT (
  (NEW.icp_status = 'qualified' AND NEW.intent_score IS NOT NULL AND NEW.intent_score BETWEEN 1 AND 5)
  OR (NEW.icp_status IN ('pending', 'rejected') AND NEW.intent_score IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'ICP qualification requires a 1-5 score; other statuses require NULL');
END;

CREATE TRIGGER contacts_icp_cancel_queue
AFTER UPDATE OF icp_status ON contacts
WHEN NEW.icp_status <> 'qualified'
BEGIN
  UPDATE messages SET status = 'cancelled', compliance_checked = 0
  WHERE contact_id = NEW.id AND status = 'queued';
END;

CREATE TRIGGER contacts_icp_profile_changed
AFTER UPDATE OF headline, company ON contacts
WHEN NEW.headline IS NOT OLD.headline OR NEW.company IS NOT OLD.company
BEGIN
  UPDATE contacts SET icp_status = 'pending', intent_score = NULL, icp_evaluation_id = NULL
  WHERE id = NEW.id;
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
