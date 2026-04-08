const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/policies', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM sla_policies ORDER BY name');
  res.json(result.rows);
});

router.get('/breaches', requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT c.* FROM conversations c WHERE c.sla_deadline < NOW() AND c.status != 'closed' ORDER BY c.sla_deadline"
  );
  res.json(result.rows);
});

// POST /api/sla/policies - Create SLA policy (manager only)
router.post('/policies', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { name, first_response_hours, resolution_hours, priority } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      'INSERT INTO sla_policies (id, name, first_response_hours, resolution_hours, priority) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [require('uuid').v4(), name, first_response_hours || 4, resolution_hours || 24, priority || 'medium']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sla/policies/:id - Update SLA policy
router.put('/policies/:id', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { name, first_response_hours, resolution_hours, priority } = req.body;
    const result = await pool.query(
      'UPDATE sla_policies SET name = $1, first_response_hours = $2, resolution_hours = $3, priority = $4 WHERE id = $5 RETURNING *',
      [name, first_response_hours, resolution_hours, priority, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Policy not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sla/policies/:id - Delete SLA policy
router.delete('/policies/:id', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM sla_policies WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Policy not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
