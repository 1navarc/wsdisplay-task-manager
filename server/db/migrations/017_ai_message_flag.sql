-- Flag AI-generated messages for training UI
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_ai_generated BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_messages_ai ON messages(is_ai_generated) WHERE is_ai_generated = true;
