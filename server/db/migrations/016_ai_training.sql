-- AI Training: feedback on drafts and training rules/examples

CREATE TABLE IF NOT EXISTS ai_draft_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    draft_id INTEGER REFERENCES shared_drafts(id),
    conversation_id UUID,
    user_id UUID REFERENCES users(id),
    helpful BOOLEAN,
    issues TEXT[] DEFAULT '{}',
    comment TEXT,
    ideal_response TEXT,
    save_as_example BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_draft ON ai_draft_feedback(draft_id);
CREATE INDEX IF NOT EXISTS idx_feedback_helpful ON ai_draft_feedback(helpful);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON ai_draft_feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_training_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_type VARCHAR(50) NOT NULL DEFAULT 'instruction',
    email_category VARCHAR(100) DEFAULT 'all',
    content TEXT NOT NULL,
    example_email TEXT,
    example_response TEXT,
    priority INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rules_active ON ai_training_rules(is_active, email_category);
