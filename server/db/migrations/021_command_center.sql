-- Migration 021: Command Center tables
-- Manager-only page with drill-downs, AI coaching, pattern detection, and notes.

-- Manager notes / journal entries (one per day per manager, but allow multiple)
CREATE TABLE IF NOT EXISTS manager_notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    author_email TEXT,
    note_date DATE NOT NULL DEFAULT CURRENT_DATE,
    body TEXT NOT NULL,
    pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_manager_notes_date ON manager_notes(note_date DESC);

-- Coaching report cards (cached so regeneration is optional)
CREATE TABLE IF NOT EXISTS coaching_report_cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rep_email TEXT NOT NULL,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    period_start DATE,
    period_end DATE,
    strengths JSONB,
    weaknesses JSONB,
    coachable_threads JSONB,
    summary TEXT,
    raw_prompt TEXT,
    generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    sent_at TIMESTAMPTZ,
    sent_to_rep BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_coaching_cards_rep ON coaching_report_cards(rep_email, generated_at DESC);

-- Alert snoozes (temporary silencing)
CREATE TABLE IF NOT EXISTS alert_snoozes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_key TEXT NOT NULL,
    snoozed_until TIMESTAMPTZ NOT NULL,
    snoozed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alert_snoozes_until ON alert_snoozes(snoozed_until);
