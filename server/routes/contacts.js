const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// GET /api/contacts/:email/profile - Get contact profile
router.get('/:email/profile', requireAuth, async (req, res) => {
  try {
    const email = req.params.email;

    // Get total conversations and date range
    const statsResult = await pool.query(
      `SELECT
        COUNT(*) as total_conversations,
        MIN(c.created_at) as first_contact,
        MAX(c.last_message_at) as last_contact
      FROM conversations c
      WHERE c.from_email = $1`,
      [email]
    );

    const stats = statsResult.rows[0] || {};

    // Get tags used across their conversations
    const tagsResult = await pool.query(
      `SELECT DISTINCT t.name
       FROM tags t
       JOIN conversation_tags ct ON t.id = ct.tag_id
       JOIN conversations c ON ct.conversation_id = c.id
       WHERE c.from_email = $1
       ORDER BY t.name
       LIMIT 10`,
      [email]
    );

    // Get recent conversation subjects
    const subjectsResult = await pool.query(
      `SELECT subject FROM conversations
       WHERE from_email = $1
       ORDER BY last_message_at DESC
       LIMIT 5`,
      [email]
    );

    // Get sender name from most recent conversation
    const nameResult = await pool.query(
      `SELECT from_name FROM conversations
       WHERE from_email = $1 AND from_name IS NOT NULL AND from_name != ''
       ORDER BY last_message_at DESC
       LIMIT 1`,
      [email]
    );

    res.json({
      email: email,
      name: nameResult.rows[0] ? nameResult.rows[0].from_name : null,
      total_conversations: parseInt(stats.total_conversations) || 0,
      first_contact: stats.first_contact || null,
      last_contact: stats.last_contact || null,
      tags_used: tagsResult.rows.map(r => r.name),
      recent_subjects: subjectsResult.rows.map(r => r.subject)
    });
  } catch (err) {
    console.error('Error fetching contact profile:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
