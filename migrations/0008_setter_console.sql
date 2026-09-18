-- Conversation content follows the contact's original retention deadline.
CREATE TABLE setter_sessions (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','handoff','stopped')),
  signal TEXT NOT NULL DEFAULT '',
  signal_url TEXT NOT NULL DEFAULT '',
  signal_date TEXT NOT NULL DEFAULT '',
  qualification_evidence TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0,
  draft_text TEXT,
  draft_action TEXT CHECK (draft_action IN ('reply','handoff','stop')),
  summary TEXT NOT NULL DEFAULT '',
  next_follow_up INTEGER,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE setter_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(contact_id, event_id)
) STRICT;
CREATE INDEX setter_turns_contact ON setter_turns(contact_id, id);
CREATE TABLE setter_handoffs (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('dispatching','delivered','unknown')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
-- Enrolling in the console cancels legacy invitation drafts. Console text can never
-- enter the legacy automated invitation queue.
CREATE TRIGGER setter_enrollment AFTER INSERT ON setter_sessions BEGIN
  UPDATE messages SET status = 'cancelled', compliance_checked = 0
    WHERE contact_id = NEW.contact_id AND status IN ('drafted','queued');
END;
CREATE TRIGGER setter_guard_legacy_insert BEFORE INSERT ON messages
WHEN EXISTS (SELECT 1 FROM setter_sessions WHERE contact_id = NEW.contact_id)
BEGIN SELECT RAISE(ABORT, 'Console contacts use manual outreach'); END;
CREATE TRIGGER setter_guard_legacy_queue BEFORE UPDATE OF status ON messages
WHEN NEW.status = 'queued' AND EXISTS (SELECT 1 FROM setter_sessions WHERE contact_id = NEW.contact_id)
BEGIN SELECT RAISE(ABORT, 'Console contacts use manual outreach'); END;
CREATE TRIGGER setter_suppression AFTER UPDATE OF suppressed ON contacts
WHEN NEW.suppressed = 1 BEGIN
  UPDATE setter_sessions SET state = 'stopped', draft_text = NULL, draft_action = NULL,
    next_follow_up = NULL, version = version + 1 WHERE contact_id = NEW.id;
END;
