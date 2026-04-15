-- Phase-3 features: rep roster, review queue, real-time alerts, conflict resolution,
-- and weekly/monthly digest support.

-- ============================================================================
-- 1. Rep roster - map raw email addresses to display names + per-rep config
-- ============================================================================
CREATE TABLE IF NOT EXISTS rep_roster (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role VARCHAR(40) DEFAULT 'rep',       -- rep | manager | admin | other
    is_active BOOLEAN DEFAULT true,
    sla_hours_override NUMERIC,           -- null = use global SLA
    receives_alerts BOOLEAN DEFAULT false, -- true = gets real-time high-severity pings
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rep_roster_active ON rep_roster(is_active);
CREATE INDEX IF NOT EXISTS idx_rep_roster_alerts ON rep_roster(receives_alerts) WHERE receives_alerts = true;

-- ============================================================================
-- 2. Review queue - track which ingested entries are pending human approval
-- ============================================================================
-- ai_training_rules.status + knowledge_base_articles.status already exist (018).
-- We just need to add reviewer columns and let the service default to 'pending_review'.
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);
ALTER TABLE ai_training_rules ADD COLUMN IF NOT EXISTS review_decision VARCHAR(20); -- approved | rejected | edited

ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id);
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS review_decision VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_tr_status ON ai_training_rules(status);
CREATE INDEX IF NOT EXISTS idx_kb_status ON knowledge_base_articles(status);

-- ============================================================================
-- 3. Real-time alert log - audit trail of alerts we've sent
-- ============================================================================
CREATE TABLE IF NOT EXISTS metrics_alert_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID REFERENCES email_metrics_runs(id) ON DELETE SET NULL,
    flag_id UUID REFERENCES email_metrics_flags(id) ON DELETE SET NULL,
    flag_type VARCHAR(40),
    severity VARCHAR(10),
    gmail_thread_id TEXT,
    subject TEXT,
    recipients TEXT[],
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    send_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_log_sent ON metrics_alert_log(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_log_flag ON metrics_alert_log(flag_id);

-- ============================================================================
-- 4. Real-time alert config (stored in app_settings as JSONB)
-- ============================================================================
INSERT INTO app_settings (key, value)
SELECT 'realtime_alerts_config', '{
  "enabled": false,
  "severities": ["high"],
  "flag_types": ["slow_first_response", "unanswered", "negative_sentiment", "repeat_problem"],
  "extra_recipients": [],
  "send_from_mailbox": "info@sdsign.com",
  "cooldown_minutes": 30,
  "use_rep_roster_alert_list": true
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'realtime_alerts_config');

-- ============================================================================
-- 5. Review-queue config - whether new ingestions default to pending_review
-- ============================================================================
INSERT INTO app_settings (key, value)
SELECT 'review_queue_config', '{
  "require_review_for_ingestion": true,
  "require_review_for_facts": true,
  "require_review_for_qa": true,
  "auto_approve_after_days": null
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'review_queue_config');

-- ============================================================================
-- 6. Weekly + monthly digest config (reuses daily-report template)
-- ============================================================================
INSERT INTO app_settings (key, value)
SELECT 'weekly_report_config', '{
  "enabled": false,
  "recipients": [],
  "send_from_mailbox": "info@sdsign.com",
  "day_of_week": 1,
  "send_time": "08:00",
  "timezone": "America/Los_Angeles",
  "include_rep_leaderboard": true,
  "include_categories": true,
  "include_flags": true,
  "top_n_categories": 12,
  "period_hours": 168
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'weekly_report_config');

INSERT INTO app_settings (key, value)
SELECT 'monthly_report_config', '{
  "enabled": false,
  "recipients": [],
  "send_from_mailbox": "info@sdsign.com",
  "day_of_month": 1,
  "send_time": "08:00",
  "timezone": "America/Los_Angeles",
  "include_rep_leaderboard": true,
  "include_categories": true,
  "include_flags": true,
  "top_n_categories": 15,
  "period_hours": 720
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'monthly_report_config');
