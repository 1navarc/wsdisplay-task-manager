-- NetSuite integration
-- Single-row config table (id=1) holds connection credentials.
-- Field mapping table is rep-visible and configurable by managers.

CREATE TABLE IF NOT EXISTS netsuite_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN DEFAULT FALSE,
  account_id TEXT,
  consumer_key TEXT,
  consumer_secret TEXT,
  token_id TEXT,
  token_secret TEXT,
  base_url TEXT,                  -- optional override; otherwise derived from account_id
  default_match_strategy TEXT DEFAULT 'exact_then_domain',
  cache_ttl_seconds INTEGER DEFAULT 300,
  last_test_at TIMESTAMP,
  last_test_status TEXT,
  last_test_message TEXT,
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (id = 1)
);
INSERT INTO netsuite_config (id, enabled) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;

-- Field mapping: section + NetSuite field path + display label + ordering
CREATE TABLE IF NOT EXISTS netsuite_field_mapping (
  id SERIAL PRIMARY KEY,
  section TEXT NOT NULL CHECK (section IN ('customer','order','invoice')),
  ns_field TEXT NOT NULL,         -- e.g. "companyname", "phone", "balance"
  display_label TEXT NOT NULL,    -- e.g. "Company"
  display_order INTEGER DEFAULT 0,
  is_visible BOOLEAN DEFAULT TRUE,
  format_hint TEXT,               -- 'currency', 'date', 'phone', 'link', etc.
  created_at TIMESTAMP DEFAULT NOW()
);

-- Default field mapping for a fresh install
INSERT INTO netsuite_field_mapping (section, ns_field, display_label, display_order, format_hint)
SELECT * FROM (VALUES
  ('customer'::text, 'companyname', 'Company',          10, NULL),
  ('customer',       'entityid',    'NS ID',            20, NULL),
  ('customer',       'email',       'Primary email',    30, NULL),
  ('customer',       'phone',       'Phone',            40, 'phone'),
  ('customer',       'category',    'Category',         50, NULL),
  ('customer',       'salesrep',    'Sales rep',        60, NULL),
  ('customer',       'datecreated', 'Customer since',   70, 'date'),
  ('customer',       'balance',     'A/R balance',      80, 'currency'),
  ('order',          'tranid',      'Order #',          10, NULL),
  ('order',          'trandate',    'Date',             20, 'date'),
  ('order',          'status',      'Status',           30, NULL),
  ('order',          'total',       'Total',            40, 'currency'),
  ('order',          'shipaddress', 'Ship to',          50, NULL),
  ('invoice',        'tranid',      'Invoice #',        10, NULL),
  ('invoice',        'duedate',     'Due',              20, 'date'),
  ('invoice',        'amountremaining','Open balance',  30, 'currency'),
  ('invoice',        'status',      'Status',           40, NULL)
) AS v(section, ns_field, display_label, display_order, format_hint)
WHERE NOT EXISTS (SELECT 1 FROM netsuite_field_mapping LIMIT 1);

-- Per-conversation override so reps can manually link a different customer
CREATE TABLE IF NOT EXISTS netsuite_customer_link (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,                      -- normalized lowercase sender email
  ns_customer_id TEXT NOT NULL,             -- NetSuite internalid of the customer
  ns_company_name TEXT,
  match_source TEXT,                        -- 'exact', 'domain', 'manual'
  linked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  linked_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(email)
);
CREATE INDEX IF NOT EXISTS idx_ns_link_email ON netsuite_customer_link(email);

-- Lightweight cache so repeated opens of the same email don't hammer NetSuite
CREATE TABLE IF NOT EXISTS netsuite_lookup_cache (
  email TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  cached_at TIMESTAMP DEFAULT NOW()
);
