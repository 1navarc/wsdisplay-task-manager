-- Migration 011: Email signatures and conversation snooze

-- Add email_signature column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_signature TEXT DEFAULT '';

-- Add snooze columns to conversations
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_snoozed BOOLEAN DEFAULT false;
