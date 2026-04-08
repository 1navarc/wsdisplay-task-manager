CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  type VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  screenshot_url TEXT,
  status VARCHAR(20) DEFAULT 'open',
  vote_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feedback_votes (
  feedback_id UUID REFERENCES feedback(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  PRIMARY KEY (feedback_id, user_id)
);

CREATE TABLE IF NOT EXISTS feedback_responses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  feedback_id UUID REFERENCES feedback(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
