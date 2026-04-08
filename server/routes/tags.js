const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// List all tags with usage count
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT t.*, COUNT(ct.conversation_id)::int AS usage_count
     FROM tags t
     LEFT JOIN conversation_tags ct ON ct.tag_id = t.id
     GROUP BY t.id
     ORDER BY t.name`
  );
  res.json(result.rows);
});

// Create a new tag
router.post('/', requireAuth, async (req, res) => {
  const { name, color } = req.body;
  const result = await pool.query('INSERT INTO tags (id,name,color) VALUES ($1,$2,$3) RETURNING *',
    [require('uuid').v4(), name, color || '#6b7280']);
  res.json(result.rows[0]);
});

// Update a tag (supervisor, manager)
router.put('/:id', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { name, color } = req.body;
    const result = await pool.query(
      'UPDATE tags SET name = COALESCE($1, name), color = COALESCE($2, color) WHERE id = $3 RETURNING *',
      [name, color, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tag not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a tag (supervisor, manager)
router.delete('/:id', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    await pool.query('DELETE FROM conversation_tags WHERE tag_id=$1', [req.params.id]);
    await pool.query('DELETE FROM tags WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add a tag to a conversation
router.post('/conversations/:convId/tags', requireAuth, async (req, res) => {
  try {
    let { tag_id, name, color } = req.body;

    // If no tag_id but a name is given, find or create the tag
    if (!tag_id && name) {
      const existing = await pool.query('SELECT * FROM tags WHERE LOWER(name)=LOWER($1)', [name]);
      if (existing.rows.length > 0) {
        tag_id = existing.rows[0].id;
      } else {
        const created = await pool.query(
          'INSERT INTO tags (id,name,color) VALUES ($1,$2,$3) RETURNING *',
          [require('uuid').v4(), name, color || '#6b7280']
        );
        tag_id = created.rows[0].id;
      }
    }

    if (!tag_id) {
      return res.status(400).json({ error: 'tag_id or name is required' });
    }

    // Check if already linked
    const check = await pool.query(
      'SELECT 1 FROM conversation_tags WHERE conversation_id=$1 AND tag_id=$2',
      [req.params.convId, tag_id]
    );
    if (check.rows.length > 0) {
      return res.json({ ok: true, message: 'Tag already assigned' });
    }

    await pool.query(
      'INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1,$2)',
      [req.params.convId, tag_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove a tag from a conversation
router.delete('/conversations/:convId/tags/:tagId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM conversation_tags WHERE conversation_id=$1 AND tag_id=$2',
      [req.params.convId, req.params.tagId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
