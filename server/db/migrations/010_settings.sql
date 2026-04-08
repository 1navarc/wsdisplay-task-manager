-- Settings table for app-wide configuration
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add use_count to canned_responses if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'canned_responses' AND column_name = 'use_count'
  ) THEN
    ALTER TABLE canned_responses ADD COLUMN use_count INTEGER DEFAULT 0;
  END IF;
END$$;

-- Add priority column to sla_policies if missing (for the 006 version that uses minutes)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sla_policies' AND column_name = 'priority'
  ) THEN
    ALTER TABLE sla_policies ADD COLUMN priority VARCHAR(20) DEFAULT 'normal';
  END IF;
END$$;
