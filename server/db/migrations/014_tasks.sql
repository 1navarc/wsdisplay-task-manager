-- Tasks system with email linking and assignment
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'open',
    priority TEXT DEFAULT 'medium',

    -- Assignment
    created_by UUID REFERENCES users(id),
    assigned_to UUID REFERENCES users(id),

    -- Email linking
    conversation_id UUID,
    email_subject TEXT,
    email_from TEXT,

    -- Google Tasks sync
    google_task_id TEXT,
    google_task_synced_at TIMESTAMPTZ,

    -- Dates
    due_date TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
