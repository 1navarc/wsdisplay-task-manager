const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const ns = require('../services/netsuite-service');

// ============================================================================
// CONFIG (manager-only)
// ============================================================================

// GET current config — secrets are returned as masked indicators only.
router.get('/settings', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM netsuite_config WHERE id = 1');
    const cfg = r.rows[0] || {};
    res.json({
      enabled: !!cfg.enabled,
      account_id: cfg.account_id || '',
      base_url: cfg.base_url || '',
      default_match_strategy: cfg.default_match_strategy || 'exact_then_domain',
      cache_ttl_seconds: cfg.cache_ttl_seconds || 300,
      // Mask secrets — indicate whether they're set, never return values
      consumer_key_set: !!cfg.consumer_key,
      consumer_secret_set: !!cfg.consumer_secret,
      token_id_set: !!cfg.token_id,
      token_secret_set: !!cfg.token_secret,
      last_test_at: cfg.last_test_at,
      last_test_status: cfg.last_test_status,
      last_test_message: cfg.last_test_message,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST settings — accepts any subset of fields. Empty strings clear nothing;
// to clear a secret, send the literal string '__CLEAR__'.
router.post('/settings', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const body = req.body || {};
    const fields = ['enabled', 'account_id', 'consumer_key', 'consumer_secret',
                    'token_id', 'token_secret', 'base_url', 'default_match_strategy',
                    'cache_ttl_seconds'];
    const updates = [];
    const values = [];
    let i = 1;
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        let v = body[f];
        if (v === '__CLEAR__') v = null;
        if (typeof v === 'string') v = v.trim();
        if (f === 'enabled') v = !!v;
        if (f === 'cache_ttl_seconds') v = parseInt(v, 10) || 300;
        updates.push(`${f} = $${i++}`);
        values.push(v);
      }
    }
    if (!updates.length) return res.json({ ok: true, nochange: true });
    updates.push(`updated_at = NOW()`);
    updates.push(`updated_by = $${i++}`);
    values.push(req.session.userId);
    await pool.query(
      `UPDATE netsuite_config SET ${updates.join(', ')} WHERE id = 1`,
      values
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('NetSuite settings save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /test — runs a trivial SuiteQL query against the configured account.
router.post('/test', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM netsuite_config WHERE id = 1');
    const cfg = r.rows[0];
    if (!cfg) return res.status(400).json({ ok: false, error: 'No config' });
    const out = await ns.testConnection(cfg);
    await pool.query(
      `UPDATE netsuite_config SET last_test_at = NOW(), last_test_status = $1, last_test_message = $2 WHERE id = 1`,
      [out.ok ? 'ok' : 'error', out.ok ? 'Connection successful' : (out.error || 'Failed')]
    );
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// FIELD MAPPING (manager-only for writes; everyone reads to render the panel)
// ============================================================================

router.get('/field-mapping', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, section, ns_field, display_label, display_order, is_visible, format_hint FROM netsuite_field_mapping ORDER BY section, display_order, id'
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/field-mapping', requireAuth, requireRole('manager'), async (req, res) => {
  // Body: { mappings: [{id?, section, ns_field, display_label, display_order, is_visible, format_hint}, ...] }
  try {
    const { mappings } = req.body || {};
    if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });
    const validSections = ['customer', 'order', 'invoice'];

    await pool.query('BEGIN');
    try {
      // Replace strategy: delete all + reinsert. Simple and matches how the UI saves.
      await pool.query('DELETE FROM netsuite_field_mapping');
      for (const m of mappings) {
        if (!m || !validSections.includes(m.section) || !m.ns_field || !m.display_label) continue;
        await pool.query(
          `INSERT INTO netsuite_field_mapping (section, ns_field, display_label, display_order, is_visible, format_hint)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [m.section, m.ns_field.trim(), m.display_label.trim(),
           parseInt(m.display_order, 10) || 0,
           m.is_visible !== false,
           m.format_hint || null]
        );
      }
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('NetSuite field mapping save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CUSTOMER LOOKUP (any authed user)
// ============================================================================

// GET /customer?email=...&conv_id=...&refresh=1
router.get('/customer', requireAuth, async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    const refresh = req.query.refresh === '1';
    if (!email) return res.status(400).json({ error: 'email is required' });

    const cfgR = await pool.query('SELECT * FROM netsuite_config WHERE id = 1');
    const cfg = cfgR.rows[0];
    if (!cfg || !cfg.enabled || !cfg.account_id || !cfg.consumer_key || !cfg.token_id) {
      return res.json({ enabled: false });
    }

    // 1. Check manual override
    const overrideR = await pool.query(
      'SELECT ns_customer_id, ns_company_name, match_source FROM netsuite_customer_link WHERE email = $1',
      [email]
    );
    const override = overrideR.rows[0] || null;

    // 2. Cache check
    if (!refresh) {
      const ttl = cfg.cache_ttl_seconds || 300;
      const cacheR = await pool.query(
        `SELECT payload, cached_at FROM netsuite_lookup_cache
         WHERE email = $1 AND cached_at > NOW() - INTERVAL '1 second' * $2`,
        [email, ttl]
      );
      if (cacheR.rows.length) {
        return res.json({ ...cacheR.rows[0].payload, _cached: true });
      }
    }

    // 3. Live lookup
    let result;
    if (override) {
      // Build payload directly from the linked customer id
      const sql = `SELECT id, entityid, companyname, email, phone, category, salesrep, datecreated, balance, daysoverdue, isperson FROM customer WHERE id = ${parseInt(override.ns_customer_id,10)}`;
      const cust = await ns.runSuiteQL(cfg, sql, { limit: 1 });
      if (!cust.items || !cust.items.length) {
        result = { matched: false };
      } else {
        const customer = cust.items[0];
        const orders = (await ns.runSuiteQL(cfg,
          `SELECT id, tranid, trandate, status, total FROM transaction WHERE entity = ${customer.id} AND type = 'SalesOrd' ORDER BY trandate DESC, id DESC`,
          { limit: 10 }
        )).items || [];
        const invoices = (await ns.runSuiteQL(cfg,
          `SELECT t.id, t.tranid, t.trandate, t.duedate, t.status, tl.foreignamountunpaid AS amountremaining FROM transaction t LEFT JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' WHERE t.entity = ${customer.id} AND t.type = 'CustInvc' AND t.status NOT IN ('Paid In Full','PaidInFull') ORDER BY t.duedate ASC NULLS LAST`,
          { limit: 10 }
        )).items || [];
        result = {
          matched: true,
          match_source: 'manual',
          customer, orders, invoices,
          customer_url: `https://${String(cfg.account_id).toLowerCase().replace(/_/g,'-')}.app.netsuite.com/app/common/entity/custjob.nl?id=${customer.id}`
        };
      }
    } else {
      const allowDomain = (cfg.default_match_strategy || 'exact_then_domain') !== 'exact_only';
      result = await ns.lookupCustomerByEmail(cfg, email, { allowDomain });
    }

    // 4. Cache
    if (result && result.matched) {
      await pool.query(
        `INSERT INTO netsuite_lookup_cache (email, payload, cached_at) VALUES ($1, $2, NOW())
         ON CONFLICT (email) DO UPDATE SET payload = EXCLUDED.payload, cached_at = NOW()`,
        [email, result]
      );
    }

    res.json({ enabled: true, ...result });
  } catch (err) {
    console.error('NetSuite customer lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /link — manually link an email to a NetSuite customer id (rep can do this)
router.post('/link', requireAuth, async (req, res) => {
  try {
    const { email, ns_customer_id, ns_company_name } = req.body || {};
    if (!email || !ns_customer_id) return res.status(400).json({ error: 'email and ns_customer_id required' });
    const normalized = email.trim().toLowerCase();
    await pool.query(
      `INSERT INTO netsuite_customer_link (email, ns_customer_id, ns_company_name, match_source, linked_by)
       VALUES ($1, $2, $3, 'manual', $4)
       ON CONFLICT (email) DO UPDATE SET ns_customer_id = EXCLUDED.ns_customer_id, ns_company_name = EXCLUDED.ns_company_name, linked_by = EXCLUDED.linked_by, linked_at = NOW()`,
      [normalized, String(ns_customer_id), ns_company_name || null, req.session.userId]
    );
    // Bust the cache
    await pool.query('DELETE FROM netsuite_lookup_cache WHERE email = $1', [normalized]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /search — manager-tools customer search by name/email/id, used by the link picker
router.post('/search', requireAuth, async (req, res) => {
  try {
    const { q } = req.body || {};
    if (!q || q.length < 2) return res.json({ items: [] });
    const cfgR = await pool.query('SELECT * FROM netsuite_config WHERE id = 1');
    const cfg = cfgR.rows[0];
    if (!cfg || !cfg.enabled) return res.json({ items: [] });
    const term = q.replace(/'/g, "''");
    const sql = `
      SELECT id, entityid, companyname, email, phone
      FROM customer
      WHERE (LOWER(companyname) LIKE LOWER('%${term}%')
             OR LOWER(email) LIKE LOWER('%${term}%')
             OR LOWER(entityid) LIKE LOWER('%${term}%'))
      AND isinactive = 'F'
      ORDER BY datecreated DESC
    `;
    const r = await ns.runSuiteQL(cfg, sql, { limit: 20 });
    res.json({ items: r.items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
