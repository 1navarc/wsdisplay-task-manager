-- Migration 006: New features for email assignment, collision detection, comments, SLA, routing, drafts, CSAT, and KB

-- Email Assignments
CREATE TABLE IF NOT EXISTS email_assignments (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL,
  assigned_to INT REFERENCES users(id),
  assigned_by INT REFERENCES users(id),
  assigned_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(conversation_id)
);

-- Collision Tracking
CREATE TABLE IF NOT EXISTS collision_tracking (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL,
  user_id INT NOT NULL REFERENCES users(id),
  action VARCHAR(20) DEFAULT 'viewing',
  started_at TIMESTAMP DEFAULT NOW(),
  last_heartbeat TIMESTAMP DEFAULT NOW()
);

-- Internal Comments
CREATE TABLE IF NOT EXISTS internal_comments (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL,
  user_id INT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  mentioned_users INT[],
  created_at TIMESTAMP DEFAULT NOW()
);

-- SLA Policies
CREATE TABLE IF NOT EXISTS sla_policies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  first_response_minutes INT DEFAULT 240,
  resolution_minutes INT DEFAULT 1440,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- SLA Tracking
CREATE TABLE IF NOT EXISTS sla_tracking (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL,
  sla_policy_id INT REFERENCES sla_policies(id),
  first_response_due TIMESTAMP,
  resolution_due TIMESTAMP,
  first_response_at TIMESTAMP,
  resolved_at TIMESTAMP,
  first_response_breached BOOLEAN DEFAULT false,
  resolution_breached BOOLEAN DEFAULT false
);

-- Routing Rules
CREATE TABLE IF NOT EXISTS routing_rules (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  conditions JSONB NOT NULL,
  action_type VARCHAR(50),
  action_value VARCHAR(255),
  priority INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Shared Drafts
CREATE TABLE IF NOT EXISTS shared_drafts (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL,
  author_id INT REFERENCES users(id),
  content TEXT,
  subject VARCHAR(500),
  status VARCHAR(20) DEFAULT 'draft',
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- CSAT Surveys
CREATE TABLE IF NOT EXISTS csat_surveys (
  id SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL,
  user_id INT REFERENCES users(id),
  rating INT CHECK(rating >= 1 AND rating <= 5),
  feedback TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(conversation_id)
);

-- Knowledge Base Articles
CREATE TABLE IF NOT EXISTS knowledge_base_articles (
  id SERIAL PRIMARY KEY,
  title VARCHAR(500) NOT NULL,
  content TEXT,
  category VARCHAR(100),
  tags TEXT[],
  is_published BOOLEAN DEFAULT true,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add columns to conversations table if they don't exist
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_to INT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'normal';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sla_policy_id INT;

-- Insert default SLA policy
INSERT INTO sla_policies (name, first_response_minutes, resolution_minutes, is_active)
VALUES ('Standard', 240, 1440, true)
ON CONFLICT DO NOTHING;
