const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /api/settings/:key - Get a setting value
router.get('/:key', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM app_settings WHERE key = $1', [req.params.key]);
    if (result.rows.length === 0) return res.json({ value: null });
    res.json({ value: result.rows[0].value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/:key - Set a setting value
router.put('/:key', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { value } = req.body;
    const result = await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
       RETURNING *`,
      [req.params.key, JSON.stringify(value)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
