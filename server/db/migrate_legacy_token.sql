-- Migrate legacy info@modco.com token
-- Run with: LEGACY_TOKEN='your_token_here'
-- psql -v token="$LEGACY_TOKEN" -f migrate_legacy_token.sql
UPDATE mailboxes
SET refresh_token = :'token',
    is_active = true,
    mailbox_type = 'shared'
WHERE email = 'info@modco.com';
