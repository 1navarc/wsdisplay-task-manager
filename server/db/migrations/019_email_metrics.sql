-- Email Metrics & Insights: rep response times, problem categorization, management flags
-- Run-based model (same pattern as training_ingestion_runs): configure filter, kick off a
-- run, poll status, render results. Rep stats and category stats are stored as JSONB on
-- the run row since they're small aggregates read as a single snapshot.

CREATE TABLE IF NOT EXISTS email_metrics_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mailbox_email TEXT NOT NULL,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'running', -- running | complete | failed | cancelled
    total_threads INTEGER DEFAULT 0,
    processed_count INTEGER DEFAULT 0,
    skipped_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    flags_created INTEGER DEFAULT 0,
    total_input_tokens BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,
    total_cost_usd NUMERIC(10,6) DEFAULT 0,
    current_status_line TEXT,
    filter_snapshot JSONB,
    -- Aggregated results (populated at completion; updated incrementally during run)
    rep_stats JSONB,      -- [{rep_email, threads_first_responder, first_response_ms_avg, first_response_ms_median, first_response_ms_p90, ongoing_response_ms_avg, ongoing_reply_count}]
    category_stats JSONB, -- [{category, thread_count, example_thread_ids[], example_subjects[], avg_first_response_ms}]
    summary JSONB,        -- {total_threads, answered_threads, unanswered_threads, overall_first_response_avg_ms, overall_first_response_median_ms, negative_sentiment_count}
    started_by_user_id UUID REFERENCES users(id),
    cancel_requested BOOLEAN DEFAULT false,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_metrics_runs_started ON email_metrics_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_metrics_runs_status ON email_metrics_runs(status);

-- One row per flagged item for the Management Attention list.
-- Thread-level flags: slow_first_response | unanswered | negative_sentiment
-- Category-level flag: repeat_problem (gmail_thread_id = null, details has thread ids)
CREATE TABLE IF NOT EXISTS email_metrics_flags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID REFERENCES email_metrics_runs(id) ON DELETE CASCADE,
    flag_type VARCHAR(40) NOT NULL,
    severity VARCHAR(10) DEFAULT 'medium', -- low | medium | high
    gmail_thread_id TEXT,
    thread_subject TEXT,
    thread_date TIMESTAMPTZ,
    rep_email TEXT,
    customer_email TEXT,
    reason TEXT,
    details JSONB,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_metrics_flags_run ON email_metrics_flags(run_id);
CREATE INDEX IF NOT EXISTS idx_email_metrics_flags_type ON email_metrics_flags(flag_type);
CREATE INDEX IF NOT EXISTS idx_email_metrics_flags_severity ON email_metrics_flags(severity, created_at DESC);

-- Default filter config stored in app_settings
INSERT INTO app_settings (key, value)
SELECT 'email_metrics_config', '{
  "mailbox_email": "info@sdsign.com",
  "date_range_days": 7,
  "date_from": null,
  "date_to": null,
  "excluded_domains": ["wsdisplay.com", "modco.com"],
  "rep_whitelist": [],
  "first_response_sla_hours": 4,
  "unanswered_alert_hours": 24,
  "business_hours_only": false,
  "business_hours_start": "08:00",
  "business_hours_end": "18:00",
  "repeat_problem_threshold": 3,
  "max_threads": 1000,
  "enable_ai_categorization": true,
  "enable_sentiment_analysis": true,
  "subject_exclude_keywords": ["out of office", "auto-reply", "automatic reply"]
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'email_metrics_config');
