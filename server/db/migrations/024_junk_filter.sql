-- Migration 024: Junk-mail filter (manual blocklist + heuristic possible-spam tag)
--
-- Two layers of protection so cold-pitch / marketing emails stop polluting
-- the Command Center metrics, attention queue, Customer 360, patterns, etc.
--
--   junk_status = NULL            → clean, included everywhere (default)
--   junk_status = 'blocked'       → manually blocklisted sender / domain → HIDDEN
--                                    from all downstream queries
--   junk_status = 'possible_spam' → matched a heuristic (no-reply, list-unsubscribe,
--                                    marketing keywords). Visible with a warning
--                                    badge so you can confirm or unflag.
--
-- The blocklist table is per-pattern (an email or a domain) and is the single
-- source of truth that the bulk-scan service uses to (re-)tag rows. Reversible:
-- removing a blocklist entry + rerunning scan clears the tag.

-- ---------------------------------------------------------------------------
-- Per-thread / per-message status column
-- ---------------------------------------------------------------------------
ALTER TABLE email_archive_threads
    ADD COLUMN IF NOT EXISTS junk_status TEXT,
    ADD COLUMN IF NOT EXISTS junk_reason TEXT,
    ADD COLUMN IF NOT EXISTS junk_marked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS junk_marked_by TEXT;  -- 'manual', 'blocklist', 'heuristic:<rule>'

CREATE INDEX IF NOT EXISTS idx_eat_junk_status
    ON email_archive_threads(mailbox_email, junk_status);

ALTER TABLE email_archive_messages
    ADD COLUMN IF NOT EXISTS junk_status TEXT,
    ADD COLUMN IF NOT EXISTS junk_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_eam_junk_status
    ON email_archive_messages(mailbox_email, junk_status);

-- ---------------------------------------------------------------------------
-- Blocklist table — manual entries the user adds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_blocklist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_email TEXT,                       -- NULL = applies to all mailboxes
    pattern TEXT NOT NULL,                    -- normalized email or domain (lowercase)
    pattern_kind TEXT NOT NULL,               -- 'email' | 'domain'
    reason TEXT,                              -- free-text note
    added_by_user_id UUID,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    threads_matched INTEGER DEFAULT 0,        -- last bulk-scan count
    last_scan_at TIMESTAMPTZ,
    UNIQUE(mailbox_email, pattern)
);

CREATE INDEX IF NOT EXISTS idx_blocklist_pattern_kind
    ON email_archive_blocklist(pattern_kind, pattern);

-- ---------------------------------------------------------------------------
-- Run-tracking row for bulk scans (so the UI can show progress on big sweeps)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_junk_scan_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_email TEXT,                       -- NULL = all
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'running',            -- running | done | failed
    threads_scanned INTEGER DEFAULT 0,
    threads_blocked INTEGER DEFAULT 0,        -- newly tagged 'blocked'
    threads_possible_spam INTEGER DEFAULT 0,  -- newly tagged 'possible_spam'
    threads_cleared INTEGER DEFAULT 0,        -- previously tagged but no longer matching
    last_error TEXT,
    started_by_user_id UUID
);

CREATE INDEX IF NOT EXISTS idx_junk_scan_runs_started
    ON email_archive_junk_scan_runs(started_at DESC);
