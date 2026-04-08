const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const multer = require('multer');
const nodemailer = require('nodemailer');

// Multer setup for screenshot upload (memory storage, convert to base64)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Email notification helper
async function sendFeedbackNotification(feedback, userName) {
  try {
    const typeLabels = { bug: 'Bug Report', feedback: 'Feedback', feature_request: 'Feature Request' };
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.SMTP_USER || process.env.GMAIL_USER,
        pass: process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.GMAIL_USER || 'noreply@wsdisplay.com',
      to: 'info@modco.com',
      subject: `[WSDisplay Feedback] New ${typeLabels[feedback.type] || feedback.type} from ${userName}`,
      html: `
        <h2>New Feedback Submitted</h2>
        <p><strong>Type:</strong> ${typeLabels[feedback.type] || feedback.type}</p>
        <p><strong>From:</strong> ${userName}</p>
        <p><strong>Content:</strong></p>
        <p>${feedback.content}</p>
        ${feedback.screenshot_url ? '<p><em>Screenshot attached to submission</em></p>' : ''}
      `
    });
  } catch (err) {
    console.error('Feedback email notification error:', err.message);
    // Don't fail the request if email fails
  }
}

// POST /api/feedback - Create new feedback
router.post('/', requireAuth, async (req, res) => {
  try {
    const { type, content, screenshot } = req.body;
    const userId = req.session.userId;

    if (!type || !content) {
      return res.status(400).json({ error: 'Type and content are required' });
    }

    const validTypes = ['bug', 'feedback', 'feature_request'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid feedback type' });
    }

    const result = await pool.query(
      `INSERT INTO feedback (user_id, type, content, screenshot_url)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, type, content, screenshot || null]
    );

    // Get user name for email notification
    const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const userName = userResult.rows[0]?.name || 'Unknown User';

    // Send email notification (non-blocking)
    sendFeedbackNotification(result.rows[0], userName);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Create feedback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/feedback - List all feedback
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    const result = await pool.query(`
      SELECT
        f.*,
        u.name AS author_name,
        u.email AS author_email,
        EXISTS(SELECT 1 FROM feedback_votes fv WHERE fv.feedback_id = f.id AND fv.user_id = $1) AS user_voted
      FROM feedback f
      LEFT JOIN users u ON f.user_id = u.id
      ORDER BY f.vote_count DESC, f.created_at DESC
    `, [userId]);

    // Get responses for all feedback items
    const feedbackIds = result.rows.map(r => r.id);
    let responsesMap = {};

    if (feedbackIds.length > 0) {
      const responsesResult = await pool.query(`
        SELECT
          fr.*,
          u.name AS author_name
        FROM feedback_responses fr
        LEFT JOIN users u ON fr.user_id = u.id
        WHERE fr.feedback_id = ANY($1)
        ORDER BY fr.created_at ASC
      `, [feedbackIds]);

      responsesResult.rows.forEach(r => {
        if (!responsesMap[r.feedback_id]) responsesMap[r.feedback_id] = [];
        responsesMap[r.feedback_id].push(r);
      });
    }

    const feedbackWithResponses = result.rows.map(f => ({
      ...f,
      responses: responsesMap[f.id] || []
    }));

    res.json(feedbackWithResponses);
  } catch (err) {
    console.error('List feedback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/feedback/:id/vote - Toggle vote
router.post('/:id/vote', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    // Check if already voted
    const existing = await pool.query(
      'SELECT 1 FROM feedback_votes WHERE feedback_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (existing.rows.length > 0) {
      // Remove vote
      await pool.query(
        'DELETE FROM feedback_votes WHERE feedback_id = $1 AND user_id = $2',
        [id, userId]
      );
      await pool.query(
        'UPDATE feedback SET vote_count = vote_count - 1, updated_at = NOW() WHERE id = $1',
        [id]
      );
    } else {
      // Add vote
      await pool.query(
        'INSERT INTO feedback_votes (feedback_id, user_id) VALUES ($1, $2)',
        [id, userId]
      );
      await pool.query(
        'UPDATE feedback SET vote_count = vote_count + 1, updated_at = NOW() WHERE id = $1',
        [id]
      );
    }

    const updated = await pool.query('SELECT vote_count FROM feedback WHERE id = $1', [id]);
    res.json({
      vote_count: updated.rows[0]?.vote_count || 0,
      user_voted: existing.rows.length === 0 // toggled: was not voted, now is
    });
  } catch (err) {
    console.error('Toggle vote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/feedback/:id/respond - Add response
router.post('/:id/respond', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.session.userId;

    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const result = await pool.query(
      `INSERT INTO feedback_responses (feedback_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, userId, content]
    );

    // Get author name
    const userResult = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    const response = {
      ...result.rows[0],
      author_name: userResult.rows[0]?.name || 'Unknown'
    };

    res.json(response);
  } catch (err) {
    console.error('Add response error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/feedback/:id/status - Update status (supervisor, manager)
router.patch('/:id/status', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['open', 'in_progress', 'completed', 'dismissed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      'UPDATE feedback SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/feedback/upload - Handle screenshot upload
router.post('/upload', requireAuth, upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${req.file.mimetype};base64,${base64}`;

    res.json({ url: dataUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
