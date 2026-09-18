-- Existing contacts retain NULL for fields that were not collected.
ALTER TABLE contacts ADD COLUMN source TEXT;
ALTER TABLE contacts ADD COLUMN reaction_type TEXT;
