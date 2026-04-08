-- Migration 002: Add OAuth token and mailbox type support
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS refresh_token TEXT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS access_token TEXT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS token_expiry TIMESTAMP;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS mailbox_type VARCHAR(20) DEFAULT 'personal';
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS added_by VARCHAR(255);
