-- Training ingestion: read a mailbox's history and extract knowledge/examples
-- Creates run tracking, per-thread log, conflict tracking, and adds provenance columns

-- Per-run tracking: one row = one "Run Now" execution
CREATE TABLE IF NOT EXISTS training_ingestion_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_email TEXT NOT NULL,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'running', -- running | complete | failed | cancelled
    total_threads INTEGER DEFAULT 0,
    processed_count INTEGER DEFAULT 0,
    skipped_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    qa_created INTEGER DEFAULT 0,
    facts_created INTEGER DEFAULT 0,
    conflicts_created INTEGER DEFAULT 0,
    total_input_tokens BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,
    total_cost_usd NUMERIC(10,6) DEFAULT 0,
    current_status_line TEXT,
    filter_snapshot JSONB,
    started_by_user_id UUID REFERENCES users(id),
    cancel_requested BOOLEAN DEFAULT false,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ing_runs_started ON training_ingestion_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ing_runs_status ON training_ingestion_runs(status);

-- Per-thread action log
CREATE TABLE IF NOT EXISTS training_ingestion_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID REFERENCES training_ingestion_runs(id) ON DELETE CASCADE,
    gmail_thread_id TEXT,
    thread_subject TEXT,
    thread_date TIMESTAMPTZ,
    rep_email TEXT,
    customer_email TEXT,
    action VARCHAR(20), -- processed | skipped | error
    skip_reason TEXT,
    qa_extracted JSONB,
    facts_extracted JSONB,
    conflicts_flagged JSONB,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd NUMERIC(10,6) DEFAULT 0,
    error_message TEXT,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ing_log_run ON training_ingestion_log(run_id);
CREATE INDEX IF NOT EXISTS idx_ing_log_action ON training_ingestion_log(action);
CREATE INDEX IF NOT EXISTS idx_ing_log_thread ON training_ingestion_log(gmail_thread_id);

-- Knowledge conflicts surfaced during ingestion or via ERP mismatch
CREATE TABLE IF NOT EXISTS knowledge_conflicts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product TEXT,
    field TEXT, -- e.g. "price", "lead_time", "material"
    old_value TEXT,
    old_source VARCHAR(30), -- manual | email_ingest | erp | legacy
    old_source_ref TEXT,
    old_created_at TIMESTAMPTZ,
    old_created_by UUID REFERENCES users(id),
    new_value TEXT,
    new_source VARCHAR(30),
    new_source_ref TEXT, -- gmail thread id or run id
    new_created_at TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR(20) DEFAULT 'pending', -- pending | resolved | dismissed
    resolution VARCHAR(20), -- keep_old | keep_new | custom | both_wrong
    resolution_value TEXT,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    run_id UUID REFERENCES training_ingestion_runs(id) ON DELETE SET NULL,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_conflicts_status ON knowledge_conflicts(status, new_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conflicts_product ON knowledge_conflicts(product, field);

-- Add provenance columns to training rules and knowledge base
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual';
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS source_ref TEXT; -- gmail thread id, run id, etc.
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'; -- active | superseded | pending_review
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES ai_training_rules(id);
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS ingestion_run_id UUID REFERENCES training_ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual';
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS superseded_by INTEGER REFERENCES knowledge_base_articles(id);
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS ingestion_run_id UUID REFERENCES training_ingestion_runs(id) ON DELETE SET NULL;

-- Backfill source column from legacy source_type where applicable (knowledge_base_articles)
UPDATE knowledge_base_articles
   SET source = COALESCE(NULLIF(source, ''), source_type, 'manual')
 WHERE source IS NULL OR source = '';

-- Default filter config (stored in app_settings, created by 010_settings.sql)
INSERT INTO app_settings (key, value)
SELECT 'training_ingestion_config', '{
  "mailbox_email": "info@sdsign.com",
  "date_range_days": 90,
  "rep_whitelist": [],
  "min_thread_messages": 2,
  "min_reply_chars": 100,
  "excluded_domains": ["wsdisplay.com", "modco.com"],
  "subject_include_keywords": [],
  "subject_exclude_keywords": ["out of office", "auto-reply", "automatic reply"],
  "body_include_keywords": [],
  "body_exclude_keywords": [],
  "closed_only": false,
  "skip_ai_drafted": true,
  "thumbs_up_only": false,
  "max_threads_per_run": 500
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'training_ingestion_config');
