const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM canned_responses ORDER BY title');
  res.json(result.rows);
});

router.post('/', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  const { title, content, shortcut, category } = req.body;
  const result = await pool.query(
    'INSERT INTO canned_responses (id,title,content,shortcut,category,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [require('uuid').v4(), title, content, shortcut, category, req.session.userId]
  );
  res.json(result.rows[0]);
});

// PUT /:id - Update canned response (supervisor, manager)
router.put('/:id', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { title, content, shortcut, category } = req.body;
    const result = await pool.query(
      'UPDATE canned_responses SET title = $1, content = $2, shortcut = $3, category = $4 WHERE id = $5 RETURNING *',
      [title, content, shortcut, category, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Increment use_count
router.post('/:id/use', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE canned_responses SET use_count = COALESCE(use_count, 0) + 1 WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete canned response (supervisor, manager)
router.delete('/:id', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    await pool.query('DELETE FROM canned_responses WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
