-- AI Email Assistant: pgvector, knowledge base embeddings, AI classification & drafts
CREATE EXTENSION IF NOT EXISTS vector;

-- Create knowledge_base_articles if it doesn't exist (originally from migration 006)
CREATE TABLE IF NOT EXISTS knowledge_base_articles (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    category VARCHAR(100),
    tags TEXT[],
    is_published BOOLEAN DEFAULT false,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add embedding column to knowledge_base_articles table (3072 dims for gemini-embedding-001)
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS embedding vector(3072);
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'manual';
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE knowledge_base_articles ADD COLUMN IF NOT EXISTS chunk_index INTEGER DEFAULT 0;
-- Note: pgvector HNSW/IVFFlat indexes limited to 2000 dims, sequential scan is fine for <1000 articles

-- AI classification on conversations
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_category VARCHAR(100);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_confidence REAL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_processed_at TIMESTAMPTZ;

-- Create shared_drafts if it doesn't exist (originally from migration 006)
CREATE TABLE IF NOT EXISTS shared_drafts (
    id SERIAL PRIMARY KEY,
    conversation_id UUID,
    author_id UUID,
    content TEXT,
    subject TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    updated_by UUID,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Extend shared_drafts for AI-generated drafts
ALTER TABLE shared_drafts ADD COLUMN IF NOT EXISTS is_ai_generated BOOLEAN DEFAULT false;
ALTER TABLE shared_drafts ADD COLUMN IF NOT EXISTS ai_sources JSONB;
ALTER TABLE shared_drafts ADD COLUMN IF NOT EXISTS ai_category VARCHAR(100);

-- AI processing audit log
CREATE TABLE IF NOT EXISTS ai_processing_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID,
    message_id UUID,
    action VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'started',
    result JSONB,
    error_message TEXT,
    processing_time_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_log_conversation ON ai_processing_log(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_status ON ai_processing_log(status);
CREATE INDEX IF NOT EXISTS idx_ai_log_created ON ai_processing_log(created_at DESC);
