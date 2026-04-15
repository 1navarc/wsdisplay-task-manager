-- Migration 023: AI Classification, Manager Attention, Rep Quality, FAQ + Training Candidates
--
-- Builds on top of migration 022 (email_archive_*). Adds:
--   * Per-message AI classification (product line, question type, sentiment,
--     complaint flag, manager-escalation flag)
--   * Per-rep-message AI quality grading (tone/completeness/accuracy/follow-through)
--   * Manager attention items queue (auto-generated, dismiss/resolve workflow)
--   * FAQ candidates queue (AI-drafted Q/A pairs you approve into a website FAQ)
--   * Training candidates queue (AI-drafted canned responses you approve into
--     the AI training mailbox)

-- ---------------------------------------------------------------------------
-- CLASSIFICATIONS: one row per archived message, populated by background classifier
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_classifications (
    message_id UUID PRIMARY KEY REFERENCES email_archive_messages(id) ON DELETE CASCADE,
    mailbox_email TEXT NOT NULL,
    -- Product taxonomy: free-form normalized slug, e.g. "retractable_banner_stand"
    product_line TEXT,
    -- Question type from a fixed taxonomy (see ALLOWED_QUESTION_TYPES in classifier)
    question_type TEXT,
    -- Sentiment: positive | neutral | negative
    sentiment TEXT,
    -- True if message has clear complaint signal (separate from sentiment)
    is_complaint BOOLEAN DEFAULT false,
    -- True if customer asked for manager / escalation / supervisor
    asks_for_manager BOOLEAN DEFAULT false,
    -- True if it's a damage-in-transit / quality-claim
    is_damage_claim BOOLEAN DEFAULT false,
    -- Short AI-extracted summary of the question (1-2 sentence canonical form)
    canonical_question TEXT,
    -- Free-form keywords AI thought were important (helps grouping)
    keywords TEXT[],
    -- Confidence 0..1 (rough, from prompt response)
    confidence NUMERIC(3,2),
    classified_at TIMESTAMPTZ DEFAULT NOW(),
    model TEXT DEFAULT 'gemini-2.5-flash',
    -- Cost tracking
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_eac_mailbox ON email_archive_classifications(mailbox_email);
CREATE INDEX IF NOT EXISTS idx_eac_product ON email_archive_classifications(product_line);
CREATE INDEX IF NOT EXISTS idx_eac_qtype ON email_archive_classifications(question_type);
CREATE INDEX IF NOT EXISTS idx_eac_complaint ON email_archive_classifications(is_complaint) WHERE is_complaint = true;
CREATE INDEX IF NOT EXISTS idx_eac_escalation ON email_archive_classifications(asks_for_manager) WHERE asks_for_manager = true;
CREATE INDEX IF NOT EXISTS idx_eac_damage ON email_archive_classifications(is_damage_claim) WHERE is_damage_claim = true;
CREATE INDEX IF NOT EXISTS idx_eac_classified_at ON email_archive_classifications(classified_at DESC);
CREATE INDEX IF NOT EXISTS idx_eac_keywords ON email_archive_classifications USING GIN (keywords);

-- ---------------------------------------------------------------------------
-- REP QUALITY GRADES: one row per outbound rep message
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_archive_rep_grades (
    message_id UUID PRIMARY KEY REFERENCES email_archive_messages(id) ON DELETE CASCADE,
    mailbox_email TEXT NOT NULL,
    rep_email TEXT,
    rep_key TEXT,
    rep_name TEXT,
    -- 1..5 each
    tone_score INTEGER CHECK (tone_score BETWEEN 1 AND 5),
    completeness_score INTEGER CHECK (completeness_score BETWEEN 1 AND 5),
    accuracy_score INTEGER CHECK (accuracy_score BETWEEN 1 AND 5),
    followthrough_score INTEGER CHECK (followthrough_score BETWEEN 1 AND 5),
    overall_score NUMERIC(3,2), -- avg of the four
    -- Free-text strengths/weaknesses for coaching
    strengths TEXT,
    weaknesses TEXT,
    coaching_note TEXT,
    graded_at TIMESTAMPTZ DEFAULT NOW(),
    model TEXT DEFAULT 'gemini-2.5-flash',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_earg_rep_email ON email_archive_rep_grades(rep_email);
CREATE INDEX IF NOT EXISTS idx_earg_rep_key ON email_archive_rep_grades(rep_key);
CREATE INDEX IF NOT EXISTS idx_earg_overall ON email_archive_rep_grades(overall_score);
CREATE INDEX IF NOT EXISTS idx_earg_graded_at ON email_archive_rep_grades(graded_at DESC);

-- ---------------------------------------------------------------------------
-- MANAGER ATTENTION ITEMS: queue of things needing manager review
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manager_attention_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Type of attention: complaint | escalation | repeat_complaint | sla_breach | low_quality_reply
    item_type TEXT NOT NULL,
    severity TEXT DEFAULT 'medium', -- low | medium | high | critical
    mailbox_email TEXT,
    customer_email TEXT,
    customer_domain TEXT,
    rep_email TEXT,
    rep_name TEXT,
    -- Reference to source content
    thread_id UUID REFERENCES email_archive_threads(id) ON DELETE CASCADE,
    message_id UUID REFERENCES email_archive_messages(id) ON DELETE CASCADE,
    gmail_thread_id TEXT,
    -- Display
    title TEXT NOT NULL,        -- e.g. "Customer asked for a manager"
    summary TEXT,               -- 1-3 sentence summary AI/system extracted
    snippet TEXT,               -- short excerpt from the source message
    -- Workflow
    status TEXT DEFAULT 'open', -- open | dismissed | resolved | snoozed
    snoozed_until TIMESTAMPTZ,
    dismissed_by UUID REFERENCES users(id),
    dismissed_at TIMESTAMPTZ,
    dismiss_reason TEXT,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    -- Provenance
    detected_at TIMESTAMPTZ DEFAULT NOW(),
    -- Dedupe key so we don't surface the same complaint twice
    dedupe_key TEXT UNIQUE,
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_mai_status ON manager_attention_items(status, severity, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_mai_type ON manager_attention_items(item_type, status);
CREATE INDEX IF NOT EXISTS idx_mai_thread ON manager_attention_items(thread_id);
CREATE INDEX IF NOT EXISTS idx_mai_customer ON manager_attention_items(customer_email);

-- ---------------------------------------------------------------------------
-- FAQ CANDIDATES: AI-drafted Q/A pairs from clusters of similar customer questions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faq_candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_line TEXT,
    question_type TEXT,
    -- Canonical question (rewritten plain English version)
    question TEXT NOT NULL,
    -- Drafted answer (synthesized from how reps actually answered similar questions)
    suggested_answer TEXT NOT NULL,
    -- How many source emails support this candidate
    source_count INTEGER DEFAULT 0,
    -- Sample source message ids (up to 10)
    source_message_ids UUID[],
    -- Status workflow
    status TEXT DEFAULT 'pending', -- pending | approved | rejected | exported
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    -- Provenance
    drafted_at TIMESTAMPTZ DEFAULT NOW(),
    drafted_by_model TEXT DEFAULT 'gemini-2.5-flash',
    -- Optional priority/score if multiple candidates per question type
    score NUMERIC(5,2)
);

CREATE INDEX IF NOT EXISTS idx_faqc_status ON faq_candidates(status, drafted_at DESC);
CREATE INDEX IF NOT EXISTS idx_faqc_product ON faq_candidates(product_line);
CREATE INDEX IF NOT EXISTS idx_faqc_qtype ON faq_candidates(question_type);

-- ---------------------------------------------------------------------------
-- AI TRAINING CANDIDATES: drafted canned responses for the AI training mailbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_training_candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_line TEXT,
    question_type TEXT,
    -- Trigger pattern (a question phrased in the customer's typical voice)
    trigger_question TEXT NOT NULL,
    -- The canned response AI proposes
    suggested_response TEXT NOT NULL,
    -- Variables/placeholders detected (e.g. {{customer_name}}, {{order_number}})
    placeholders TEXT[],
    -- Volume signal
    matched_email_count INTEGER DEFAULT 0,
    source_message_ids UUID[],
    -- Status workflow
    status TEXT DEFAULT 'pending', -- pending | approved | rejected | applied
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    applied_at TIMESTAMPTZ,
    review_note TEXT,
    -- Provenance
    drafted_at TIMESTAMPTZ DEFAULT NOW(),
    drafted_by_model TEXT DEFAULT 'gemini-2.5-flash',
    score NUMERIC(5,2)
);

CREATE INDEX IF NOT EXISTS idx_tc_status ON ai_training_candidates(status, drafted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tc_product ON ai_training_candidates(product_line);
CREATE INDEX IF NOT EXISTS idx_tc_qtype ON ai_training_candidates(question_type);

-- ---------------------------------------------------------------------------
-- CLASSIFIER + GRADER + ATTENTION RUNS (progress-bar tracking)
-- Reuses the email_archive_runs table — adds new run_type values:
--   'classify_backfill', 'grade_backfill', 'faq_suggest', 'training_suggest'
-- Add cost-tracking columns for the new run types.
-- ---------------------------------------------------------------------------
ALTER TABLE email_archive_runs
  ADD COLUMN IF NOT EXISTS classify_input_tokens  BIGINT       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS classify_output_tokens BIGINT       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS classify_cost_usd      NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade_input_tokens     BIGINT       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade_output_tokens    BIGINT       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade_cost_usd         NUMERIC(10,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suggest_input_tokens   BIGINT       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suggest_output_tokens  BIGINT       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suggest_cost_usd       NUMERIC(10,6) DEFAULT 0;

-- ---------------------------------------------------------------------------
-- CONFIG: classifier and quality-grader settings
-- ---------------------------------------------------------------------------
INSERT INTO app_settings (key, value)
SELECT 'email_intelligence_config', '{
  "enable_classifier": true,
  "enable_quality_grader": true,
  "enable_attention_detection": true,
  "classifier_cron": "*/5 * * * *",
  "grader_cron": "*/5 * * * *",
  "attention_cron": "*/15 * * * *",
  "faq_suggester_cron": "0 4 * * *",
  "training_suggester_cron": "0 4 * * *",
  "classifier_batch_size": 30,
  "grader_batch_size": 30,
  "model": "gemini-2.5-flash",
  "quality_grade_all_outbound": true,
  "complaint_threshold": "high",
  "repeat_complaint_window_days": 60,
  "low_quality_threshold": 2.5,
  "faq_min_cluster_size": 5,
  "training_min_cluster_size": 10,
  "skip_subjects": ["out of office", "auto-reply", "automatic reply", "delivery status notification"]
}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'email_intelligence_config');
