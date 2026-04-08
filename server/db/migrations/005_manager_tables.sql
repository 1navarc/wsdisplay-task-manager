ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'Agent';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  sla_response_minutes INTEGER DEFAULT 240,
  sla_resolution_minutes INTEGER DEFAULT 1440,
  color VARCHAR(20) DEFAULT '#2563EB',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  joined_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, team_id)
);

CREATE TABLE IF NOT EXISTS email_tickets (
  id SERIAL PRIMARY KEY,
  gmail_message_id VARCHAR(255) UNIQUE,
  subject TEXT,
  from_email VARCHAR(255),
  from_name VARCHAR(255),
  assigned_to INTEGER REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  priority VARCHAR(10) DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
  status VARCHAR(10) DEFAULT 'open' CHECK(status IN ('open','pending','resolved','reopened')),
  label VARCHAR(100),
  received_at TIMESTAMP NOT NULL,
  first_response_at TIMESTAMP,
  resolved_at TIMESTAMP,
  reopened_count INTEGER DEFAULT 0,
  exchange_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES email_tickets(id),
  event_type VARCHAR(20) NOT NULL CHECK(event_type IN ('received','assigned','replied','resolved','reopened','label_changed','priority_changed','note_added')),
  performed_by INTEGER REFERENCES users(id),
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_labels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  color VARCHAR(20) DEFAULT '#6B7280',
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO teams (name, description, sla_response_minutes, sla_resolution_minutes, color) VALUES
  ('General', 'General support inquiries', 240, 1440, '#6B7280'),
  ('Billing', 'Payment and billing issues', 120, 480, '#059669'),
  ('Technical', 'Technical support', 240, 1440, '#2563EB'),
  ('Shipping', 'Shipping and delivery', 180, 720, '#D97706'),
  ('Returns', 'Returns and exchanges', 240, 1440, '#DC2626')
ON CONFLICT (name) DO NOTHING;

INSERT INTO ticket_labels (name, color) VALUES
  ('Billing', '#059669'), ('Technical', '#2563EB'), ('Shipping', '#D97706'),
  ('Returns', '#DC2626'), ('Account', '#7C3AED'), ('General', '#6B7280'),
  ('Urgent', '#EF4444'), ('VIP', '#F59E0B')
ON CONFLICT (name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_tickets_received ON email_tickets(received_at);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON email_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON email_tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tickets_team ON email_tickets(team_id);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);
