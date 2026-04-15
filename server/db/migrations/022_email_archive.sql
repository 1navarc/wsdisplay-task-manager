-- Migration 022: Multi-mailbox Email Archive with Full-Text + Semantic Search
--
-- Goal: keep a complete local archive of every email across multiple mailboxes
-- (info@sdsign.com, graphics@sdsign.com, info@wsdisplay.com, graphics@wsdisplay.com)
-- so search/filter doesn't re-hit Gmail every time. Mailboxes stay separate via
-- mailbox_email column so they can be filtered/grouped/restricted.
--
-- Pattern follows the run-based model already used by training_ingestion_runs and
-- email_metrics_runs: a run row tracks progress for a backfill or delta sync,
-- the UI polls it for a progress bar, restarts can resume incomplete runs.

-- ---------------------------------------------------------------------------
-- THREADS: one row per Gmail thread per mailbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_threads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_email TEXT NOT NULL,
    gmail_thread_id TEXT NOT NULL,
    subject TEXT,
    customer_email TEXT,
    customer_domain TEXT,
    first_msg_at TIMESTAMPTZ,
    last_msg_at TIMESTAMPTZ,
    message_count INTEGER DEFAULT 0,
    rep_emails TEXT[],          -- distinct rep addresses that sent in this thread
    rep_keys TEXT[],            -- normalized rep identities (Hiver assignee or sig match)
    label_ids TEXT[],
    label_names TEXT[],         -- friendly names (resolved from labels.list)
    has_attachment BOOLEAN DEFAULT false,
    raw_thread JSONB,           -- entire Gmail thread object for re-render fidelity
    synced_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(mailbox_email, gmail_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_eat_mailbox_last ON email_archive_threads(mailbox_email, last_msg_at DESC);
CREATE INDEX IF NOT EXISTS idx_eat_customer_email ON email_archive_threads(customer_email);
CREATE INDEX IF NOT EXISTS idx_eat_customer_domain ON email_archive_threads(customer_domain);
CREATE INDEX IF NOT EXISTS idx_eat_labels ON email_archive_threads USING GIN (label_ids);
CREATE INDEX IF NOT EXISTS idx_eat_label_names ON email_archive_threads USING GIN (label_names);
CREATE INDEX IF NOT EXISTS idx_eat_rep_keys ON email_archive_threads USING GIN (rep_keys);

-- ---------------------------------------------------------------------------
-- MESSAGES: one row per Gmail message; mailbox_email denormalized for filtering
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id UUID REFERENCES email_archive_threads(id) ON DELETE CASCADE,
    mailbox_email TEXT NOT NULL,
    gmail_message_id TEXT NOT NULL,
    sent_at TIMESTAMPTZ,
    direction TEXT,                  -- inbound | outbound | internal
    from_email TEXT,
    from_name TEXT,
    to_emails TEXT[],
    cc_emails TEXT[],
    subject TEXT,
    body_html TEXT,                  -- original HTML (best-effort)
    body_text_clean TEXT,            -- cleaned body, no quoted history (search/display)
    body_text_full TEXT,             -- full plain text including quoted history
    snippet TEXT,                    -- Gmail's auto-snippet
    has_attachment BOOLEAN DEFAULT false,
    label_ids TEXT[],
    rep_email TEXT,                  -- resolved rep identity (Hiver/sig/from)
    rep_key TEXT,
    rep_name TEXT,
    body_search tsvector GENERATED ALWAYS AS (
      to_tsvector('english',
        coalesce(subject,'') || ' ' ||
        coalesce(body_text_clean,'') || ' ' ||
        coalesce(from_email,'') || ' ' ||
        coalesce(from_name,'')
      )
    ) STORED,
    UNIQUE(mailbox_email, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_eam_thread ON email_archive_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_eam_mailbox_sent ON email_archive_messages(mailbox_email, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_eam_from ON email_archive_messages(from_email);
CREATE INDEX IF NOT EXISTS idx_eam_rep_email ON email_archive_messages(rep_email);
CREATE INDEX IF NOT EXISTS idx_eam_rep_key ON email_archive_messages(rep_key);
CREATE INDEX IF NOT EXISTS idx_eam_search ON email_archive_messages USING GIN (body_search);
CREATE INDEX IF NOT EXISTS idx_eam_labels ON email_archive_messages USING GIN (label_ids);

-- ---------------------------------------------------------------------------
-- SYNC STATE: per-mailbox cursor for incremental delta sync
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_sync_state (
    mailbox_email TEXT PRIMARY KEY,
    last_history_id TEXT,
    last_synced_at TIMESTAMPTZ,
    backfill_completed_at TIMESTAMPTZ,
    earliest_archived_at TIMESTAMPTZ,
    latest_archived_at TIMESTAMPTZ,
    total_threads_archived INTEGER DEFAULT 0,
    total_messages_archived INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- RUNS: one row per backfill or delta-sync invocation; powers the progress bar
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_email TEXT NOT NULL,
    run_type TEXT NOT NULL,            -- backfill | delta_sync | embed_slice
    date_from DATE,
    date_to DATE,
    status TEXT DEFAULT 'running',     -- running | complete | failed | cancelled | paused
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    total_threads INTEGER DEFAULT 0,
    processed_count INTEGER DEFAULT 0,
    skipped_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    new_threads INTEGER DEFAULT 0,
    new_messages INTEGER DEFAULT 0,
    current_status_line TEXT,
    current_chunk_label TEXT,          -- e.g. "2024-08" while processing a month chunk
    progress_percent NUMERIC(5,2) DEFAULT 0,
    eta_seconds INTEGER,
    last_error TEXT,
    cancel_requested BOOLEAN DEFAULT false,
    started_by_user_id UUID REFERENCES users(id),
    -- For embed_slice runs, snapshot the filter so user can re-apply it
    filter_snapshot JSONB,
    -- Embed runs: cost tracking
    embedding_input_tokens BIGINT DEFAULT 0,
    embedding_cost_usd NUMERIC(10,6) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ear_mailbox_started ON email_archive_runs(mailbox_email, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ear_status ON email_archive_runs(status);
CREATE INDEX IF NOT EXISTS idx_ear_type_status ON email_archive_runs(run_type, status);

-- ---------------------------------------------------------------------------
-- EMBEDDINGS: pgvector-backed semantic index. Optional - populated by
-- "Embed this slice" button. Each row = one message embedded.
-- Uses 768-d (Gemini gemini-embedding-001 default).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector not available - semantic search will be disabled';
END $$;

-- Use a separate table so the main archive_messages stays lean and only embedded
-- rows pay the storage cost.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $sql$
      CREATE TABLE IF NOT EXISTS email_archive_embeddings (
        message_id UUID PRIMARY KEY REFERENCES email_archive_messages(id) ON DELETE CASCADE,
        mailbox_email TEXT NOT NULL,
        embedded_at TIMESTAMPTZ DEFAULT NOW(),
        embedding vector(768),
        model TEXT DEFAULT 'gemini-embedding-001'
      )
    $sql$;
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_eae_mailbox ON email_archive_embeddings(mailbox_email)';
    -- ivfflat works well for similarity search on hundreds of thousands of rows.
    -- We don't create the index until there's data; skip for now and the service
    -- will create it after the first batch lands.
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SAVED FILTERS: per-user named filter presets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_saved_filters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filter_json JSONB NOT NULL,
    is_shared BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_easf_user ON email_archive_saved_filters(user_id);

-- ---------------------------------------------------------------------------
-- CONFIG: archive defaults stored in app_settings
-- ---------------------------------------------------------------------------
INSERT INTO app_settings (key, value)
SELECT 'email_archive_config', '{
  "mailboxes": [
    "info@sdsign.com",
    "graphics@sdsign.com",
    "info@wsdisplay.com",
    "graphics@wsdisplay.com"
  ],
  "backfill_years": 2,
  "backfill_chunk_months": 1,
  "auto_start_backfill_on_deploy": true,
  "delta_sync_cron": "0 * * * *",
  "max_messages_per_chunk": 5000,
  "subject_exclude_keywords": ["out of office", "auto-reply", "automatic reply"],
  "embedding_model": "gemini-embedding-001",
  "embedding_dimensions": 768,
  "embedding_batch_size": 100
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'email_archive_config');
