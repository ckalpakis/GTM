-- Reply metadata follows the contact's original retention window. No reply text is stored.
CREATE TABLE reply_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  classification TEXT CHECK (classification IN ('interested', 'neutral', 'not interested')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'processing', 'classified', 'dispatching', 'delivered', 'ignored', 'unknown')),
  lease_token TEXT,
  lease_expires_at INTEGER,
  received_at INTEGER NOT NULL,
  delivered_at INTEGER,
  error_code TEXT,
  UNIQUE (account_id, message_id)
) STRICT;
CREATE INDEX reply_events_contact ON reply_events(contact_id);
