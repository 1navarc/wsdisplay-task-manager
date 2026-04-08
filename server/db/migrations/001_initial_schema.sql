CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  avatar_url TEXT,
  role VARCHAR(20) DEFAULT 'agent',
  google_token JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE mailboxes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mailbox_id UUID REFERENCES mailboxes(id),
  gmail_thread_id VARCHAR(255),
  subject TEXT,
  from_email VARCHAR(255),
  from_name VARCHAR(255),
  status VARCHAR(20) DEFAULT 'open',
  priority VARCHAR(20) DEFAULT 'medium',
  assignee_id UUID REFERENCES users(id),
  is_read BOOLEAN DEFAULT false,
  sla_deadline TIMESTAMP,
  sla_breached BOOLEAN DEFAULT false,
  last_message_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id),
  gmail_message_id VARCHAR(255),
  from_email VARCHAR(255),
  from_name VARCHAR(255),
  to_email VARCHAR(255),
  body_html TEXT,
  body_text TEXT,
  direction VARCHAR(10) DEFAULT 'inbound',
  sent_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE internal_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id),
  user_id UUID REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) UNIQUE NOT NULL,
  color VARCHAR(7) DEFAULT '#6366f1'
);

CREATE TABLE conversation_tags (
  conversation_id UUID REFERENCES conversations(id),
  tag_id UUID REFERENCES tags(id),
  PRIMARY KEY (conversation_id, tag_id)
);

CREATE TABLE canned_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  shortcut VARCHAR(50),
  category VARCHAR(100),
  created_by UUID REFERENCES users(id),
  use_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sla_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  first_response_hours INTEGER DEFAULT 4,
  resolution_hours INTEGER DEFAULT 24,
  priority VARCHAR(20) DEFAULT 'medium',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_conv_mailbox ON conversations(mailbox_id);
CREATE INDEX idx_conv_assignee ON conversations(assignee_id);
CREATE INDEX idx_conv_status ON conversations(status);
CREATE INDEX idx_messages_conv ON messages(conversation_id);
