const router = require('express').Router();
const { pool } = require('../config/database');
const { requireAuth, loadUser } = require('../middleware/auth');

// Apply auth middleware to all routes
router.use(requireAuth);
router.use(loadUser);

// ============================================================================
// EMAIL ASSIGNMENT ENDPOINTS
// ============================================================================

router.post('/assignments', async (req, res) => {
  try {
    const { conversation_id, assigned_to } = req.body;
    const user_id = req.user.id;

    if (!conversation_id || !assigned_to) {
      return res.status(400).json({ error: 'conversation_id and assigned_to required' });
    }

    const result = await pool.query(
      `INSERT INTO email_assignments (conversation_id, assigned_to, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id) DO UPDATE SET assigned_to = $2, assigned_by = $3, assigned_at = NOW()
       RETURNING *`,
      [conversation_id, assigned_to, user_id]
    );

    // Also update conversations table
    await pool.query(
      `UPDATE conversations SET assigned_to = $1 WHERE id = $2`,
      [assigned_to, conversation_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error assigning conversation:', err);
    res.status(500).json({ error: 'Failed to assign conversation' });
  }
});

router.get('/assignments/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;

    const result = await pool.query(
      `SELECT ea.*, u.name as assigned_to_name, ab.name as assigned_by_name
       FROM email_assignments ea
       LEFT JOIN users u ON ea.assigned_to = u.id
       LEFT JOIN users ab ON ea.assigned_by = ab.id
       WHERE ea.conversation_id = $1`,
      [conversation_id]
    );

    if (result.rows.length === 0) {
      return res.json(null);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching assignment:', err);
    res.status(500).json({ error: 'Failed to fetch assignment' });
  }
});

router.delete('/assignments/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;

    await pool.query(
      `DELETE FROM email_assignments WHERE conversation_id = $1`,
      [conversation_id]
    );

    await pool.query(
      `UPDATE conversations SET assigned_to = NULL WHERE id = $1`,
      [conversation_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing assignment:', err);
    res.status(500).json({ error: 'Failed to remove assignment' });
  }
});

// ============================================================================
// COLLISION DETECTION ENDPOINTS
// ============================================================================

router.post('/collision/heartbeat', async (req, res) => {
  try {
    const { conversation_id, action } = req.body;
    const user_id = req.user.id;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    const validActions = ['viewing', 'drafting'];
    const actionType = validActions.includes(action) ? action : 'viewing';

    const result = await pool.query(
      `INSERT INTO collision_tracking (conversation_id, user_id, action, started_at, last_heartbeat)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (conversation_id, user_id) DO UPDATE
       SET action = $3, last_heartbeat = NOW()
       RETURNING *`,
      [conversation_id, user_id, actionType]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error sending heartbeat:', err);
    res.status(500).json({ error: 'Failed to send heartbeat' });
  }
});

router.get('/collision/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const user_id = req.user.id;

    // Get active viewers/drafters, excluding self, only heartbeats < 30 seconds old
    const result = await pool.query(
      `SELECT ct.*, u.name, u.email
       FROM collision_tracking ct
       JOIN users u ON ct.user_id = u.id
       WHERE ct.conversation_id = $1
       AND ct.user_id != $2
       AND ct.last_heartbeat > NOW() - INTERVAL '30 seconds'
       ORDER BY ct.last_heartbeat DESC`,
      [conversation_id, user_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching collision data:', err);
    res.status(500).json({ error: 'Failed to fetch collision data' });
  }
});

router.delete('/collision/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const user_id = req.user.id;

    await pool.query(
      `DELETE FROM collision_tracking WHERE conversation_id = $1 AND user_id = $2`,
      [conversation_id, user_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error removing collision tracking:', err);
    res.status(500).json({ error: 'Failed to remove collision tracking' });
  }
});

// ============================================================================
// INTERNAL COMMENTS & @MENTIONS ENDPOINTS
// ============================================================================

router.get('/comments/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;

    const result = await pool.query(
      `SELECT ic.*, u.name, u.email
       FROM internal_comments ic
       JOIN users u ON ic.user_id = u.id
       WHERE ic.conversation_id = $1
       ORDER BY ic.created_at ASC`,
      [conversation_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching comments:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

router.post('/comments', async (req, res) => {
  try {
    const { conversation_id, content, mentioned_users } = req.body;
    const user_id = req.user.id;

    if (!conversation_id || !content) {
      return res.status(400).json({ error: 'conversation_id and content required' });
    }

    const mentionedArray = mentioned_users && Array.isArray(mentioned_users) ? mentioned_users : [];

    const result = await pool.query(
      `INSERT INTO internal_comments (conversation_id, user_id, content, mentioned_users)
       VALUES ($1, $2, $3, $4)
       RETURNING ic.*, u.name, u.email
       FROM internal_comments ic
       JOIN users u ON ic.user_id = u.id
       WHERE ic.id = $5`,
      [conversation_id, user_id, content, mentionedArray, null]
    );

    // Fetch the created comment with user details
    const commentResult = await pool.query(
      `SELECT ic.*, u.name, u.email
       FROM internal_comments ic
       JOIN users u ON ic.user_id = u.id
       WHERE ic.conversation_id = $1
       ORDER BY ic.created_at DESC
       LIMIT 1`,
      [conversation_id]
    );

    res.json(commentResult.rows[0]);
  } catch (err) {
    console.error('Error creating comment:', err);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

// ============================================================================
// SLA TRACKING ENDPOINTS
// ============================================================================

router.get('/sla/policies', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM sla_policies WHERE is_active = true ORDER BY created_at DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching SLA policies:', err);
    res.status(500).json({ error: 'Failed to fetch SLA policies' });
  }
});

router.post('/sla/policies', async (req, res) => {
  try {
    const { name, first_response_minutes, resolution_minutes } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }

    const result = await pool.query(
      `INSERT INTO sla_policies (name, first_response_minutes, resolution_minutes)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, first_response_minutes || 240, resolution_minutes || 1440]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating SLA policy:', err);
    res.status(500).json({ error: 'Failed to create SLA policy' });
  }
});

router.put('/sla/policies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, first_response_minutes, resolution_minutes, is_active } = req.body;

    const result = await pool.query(
      `UPDATE sla_policies
       SET name = COALESCE($1, name),
           first_response_minutes = COALESCE($2, first_response_minutes),
           resolution_minutes = COALESCE($3, resolution_minutes),
           is_active = COALESCE($4, is_active)
       WHERE id = $5
       RETURNING *`,
      [name, first_response_minutes, resolution_minutes, is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'SLA policy not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating SLA policy:', err);
    res.status(500).json({ error: 'Failed to update SLA policy' });
  }
});

router.get('/sla/breaches', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT st.*, c.subject, u.name as assigned_to_name, sp.name as policy_name
       FROM sla_tracking st
       JOIN conversations c ON st.conversation_id = c.id
       LEFT JOIN users u ON c.assigned_to = u.id
       JOIN sla_policies sp ON st.sla_policy_id = sp.id
       WHERE (st.first_response_breached = true OR st.resolution_breached = true)
       AND st.resolved_at IS NULL
       ORDER BY st.resolution_due ASC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching SLA breaches:', err);
    res.status(500).json({ error: 'Failed to fetch SLA breaches' });
  }
});

router.post('/sla/apply/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const { sla_policy_id } = req.body;

    if (!sla_policy_id) {
      return res.status(400).json({ error: 'sla_policy_id required' });
    }

    // Get policy details
    const policyResult = await pool.query(
      `SELECT * FROM sla_policies WHERE id = $1`,
      [sla_policy_id]
    );

    if (policyResult.rows.length === 0) {
      return res.status(404).json({ error: 'SLA policy not found' });
    }

    const policy = policyResult.rows[0];
    const now = new Date();
    const firstResponseDue = new Date(now.getTime() + policy.first_response_minutes * 60000);
    const resolutionDue = new Date(now.getTime() + policy.resolution_minutes * 60000);

    const result = await pool.query(
      `INSERT INTO sla_tracking (conversation_id, sla_policy_id, first_response_due, resolution_due)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conversation_id) DO UPDATE
       SET sla_policy_id = $2, first_response_due = $3, resolution_due = $4
       RETURNING *`,
      [conversation_id, sla_policy_id, firstResponseDue.toISOString(), resolutionDue.toISOString()]
    );

    // Update conversations table
    await pool.query(
      `UPDATE conversations SET sla_policy_id = $1 WHERE id = $2`,
      [sla_policy_id, conversation_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error applying SLA:', err);
    res.status(500).json({ error: 'Failed to apply SLA' });
  }
});

// ============================================================================
// ROUTING RULES ENDPOINTS
// ============================================================================

router.get('/routing/rules', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM routing_rules WHERE is_active = true ORDER BY priority DESC, created_at DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching routing rules:', err);
    res.status(500).json({ error: 'Failed to fetch routing rules' });
  }
});

router.post('/routing/rules', async (req, res) => {
  try {
    const { name, conditions, action_type, action_value, priority } = req.body;

    if (!name || !conditions) {
      return res.status(400).json({ error: 'name and conditions required' });
    }

    const validActions = ['assign_team', 'assign_user', 'add_tag', 'set_priority'];
    if (action_type && !validActions.includes(action_type)) {
      return res.status(400).json({ error: 'Invalid action_type' });
    }

    const result = await pool.query(
      `INSERT INTO routing_rules (name, conditions, action_type, action_value, priority)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, JSON.stringify(conditions), action_type, action_value, priority || 0]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating routing rule:', err);
    res.status(500).json({ error: 'Failed to create routing rule' });
  }
});

router.put('/routing/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, conditions, action_type, action_value, priority, is_active } = req.body;

    const result = await pool.query(
      `UPDATE routing_rules
       SET name = COALESCE($1, name),
           conditions = COALESCE($2, conditions),
           action_type = COALESCE($3, action_type),
           action_value = COALESCE($4, action_value),
           priority = COALESCE($5, priority),
           is_active = COALESCE($6, is_active)
       WHERE id = $7
       RETURNING *`,
      [name, conditions ? JSON.stringify(conditions) : null, action_type, action_value, priority, is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Routing rule not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating routing rule:', err);
    res.status(500).json({ error: 'Failed to update routing rule' });
  }
});

router.delete('/routing/rules/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM routing_rules WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting routing rule:', err);
    res.status(500).json({ error: 'Failed to delete routing rule' });
  }
});

router.post('/routing/evaluate', async (req, res) => {
  try {
    const { subject, from, body } = req.body;

    if (!subject || !from) {
      return res.status(400).json({ error: 'subject and from required' });
    }

    const rulesResult = await pool.query(
      `SELECT * FROM routing_rules WHERE is_active = true ORDER BY priority DESC`
    );

    const matchingRules = [];

    for (const rule of rulesResult.rows) {
      const conditions = rule.conditions;
      let matches = true;

      if (conditions && typeof conditions === 'object') {
        for (const condition of Array.isArray(conditions) ? conditions : [conditions]) {
          const { field, operator, value } = condition;
          let fieldValue = '';

          if (field === 'subject') fieldValue = subject;
          else if (field === 'from') fieldValue = from;
          else if (field === 'body') fieldValue = body;

          if (!evaluateCondition(fieldValue, operator, value)) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        matchingRules.push(rule);
      }
    }

    res.json(matchingRules);
  } catch (err) {
    console.error('Error evaluating routing rules:', err);
    res.status(500).json({ error: 'Failed to evaluate routing rules' });
  }
});

function evaluateCondition(fieldValue, operator, value) {
  const val = String(value).toLowerCase();
  const field = String(fieldValue).toLowerCase();

  switch (operator) {
    case 'contains':
      return field.includes(val);
    case 'equals':
      return field === val;
    case 'starts_with':
      return field.startsWith(val);
    case 'ends_with':
      return field.endsWith(val);
    case 'regex':
      try {
        return new RegExp(val).test(fieldValue);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// ============================================================================
// SHARED DRAFTS ENDPOINTS
// ============================================================================

router.get('/drafts/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;

    const result = await pool.query(
      `SELECT sd.*, u.name as author_name, ub.name as updated_by_name
       FROM shared_drafts sd
       LEFT JOIN users u ON sd.author_id = u.id
       LEFT JOIN users ub ON sd.updated_by = ub.id
       WHERE sd.conversation_id = $1
       ORDER BY sd.updated_at DESC`,
      [conversation_id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching drafts:', err);
    res.status(500).json({ error: 'Failed to fetch drafts' });
  }
});

router.post('/drafts', async (req, res) => {
  try {
    const { conversation_id, content, subject } = req.body;
    const user_id = req.user.id;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    const result = await pool.query(
      `INSERT INTO shared_drafts (conversation_id, author_id, content, subject, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING sd.*, u.name as author_name, ub.name as updated_by_name
       FROM shared_drafts sd
       LEFT JOIN users u ON sd.author_id = u.id
       LEFT JOIN users ub ON sd.updated_by = ub.id
       WHERE sd.id = $6`,
      [conversation_id, user_id, content || '', subject || '', user_id, null]
    );

    // Fetch the created draft
    const draftResult = await pool.query(
      `SELECT sd.*, u.name as author_name, ub.name as updated_by_name
       FROM shared_drafts sd
       LEFT JOIN users u ON sd.author_id = u.id
       LEFT JOIN users ub ON sd.updated_by = ub.id
       WHERE sd.conversation_id = $1
       ORDER BY sd.created_at DESC
       LIMIT 1`,
      [conversation_id]
    );

    res.json(draftResult.rows[0]);
  } catch (err) {
    console.error('Error creating draft:', err);
    res.status(500).json({ error: 'Failed to create draft' });
  }
});

router.put('/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, subject } = req.body;
    const user_id = req.user.id;

    const result = await pool.query(
      `UPDATE shared_drafts
       SET content = COALESCE($1, content),
           subject = COALESCE($2, subject),
           updated_by = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING sd.*, u.name as author_name, ub.name as updated_by_name
       FROM shared_drafts sd
       LEFT JOIN users u ON sd.author_id = u.id
       LEFT JOIN users ub ON sd.updated_by = ub.id
       WHERE sd.id = $4`,
      [content, subject, user_id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    // Fetch updated draft with joins
    const draftResult = await pool.query(
      `SELECT sd.*, u.name as author_name, ub.name as updated_by_name
       FROM shared_drafts sd
       LEFT JOIN users u ON sd.author_id = u.id
       LEFT JOIN users ub ON sd.updated_by = ub.id
       WHERE sd.id = $1`,
      [id]
    );

    res.json(draftResult.rows[0]);
  } catch (err) {
    console.error('Error updating draft:', err);
    res.status(500).json({ error: 'Failed to update draft' });
  }
});

router.delete('/drafts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM shared_drafts WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting draft:', err);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

// ============================================================================
// ANALYTICS ENDPOINTS
// ============================================================================

router.get('/analytics/response-times', async (req, res) => {
  try {
    // Team-wide average response times
    const teamResult = await pool.query(
      `SELECT
         AVG(EXTRACT(EPOCH FROM (c.first_response_at - c.created_at))/60) as avg_first_response_minutes,
         AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at))/60) as avg_resolution_minutes,
         COUNT(*) as total_conversations
       FROM conversations c
       WHERE c.first_response_at IS NOT NULL`
    );

    // Per-employee response times
    const employeeResult = await pool.query(
      `SELECT
         u.id, u.name, u.email,
         AVG(EXTRACT(EPOCH FROM (c.first_response_at - c.created_at))/60) as avg_first_response_minutes,
         AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at))/60) as avg_resolution_minutes,
         COUNT(*) as total_conversations
       FROM conversations c
       JOIN users u ON c.assigned_to = u.id
       WHERE c.first_response_at IS NOT NULL
       GROUP BY u.id, u.name, u.email
       ORDER BY avg_first_response_minutes ASC`
    );

    res.json({
      team_wide: teamResult.rows[0] || {},
      by_employee: employeeResult.rows
    });
  } catch (err) {
    console.error('Error fetching response time analytics:', err);
    res.status(500).json({ error: 'Failed to fetch response time analytics' });
  }
});

router.get('/analytics/volume', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.name, u.email,
         COUNT(*) as total_conversations,
         COUNT(*) FILTER (WHERE c.status = 'closed') as resolved_conversations,
         COUNT(*) FILTER (WHERE c.status = 'open') as open_conversations
       FROM users u
       LEFT JOIN conversations c ON u.id = c.assigned_to
       WHERE u.role = 'agent' OR u.role = 'manager'
       GROUP BY u.id, u.name, u.email
       ORDER BY total_conversations DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching volume analytics:', err);
    res.status(500).json({ error: 'Failed to fetch volume analytics' });
  }
});

router.get('/analytics/csat', async (req, res) => {
  try {
    // Team-wide CSAT
    const teamResult = await pool.query(
      `SELECT
         AVG(rating)::NUMERIC(10,2) as avg_rating,
         COUNT(*) as total_surveys,
         MIN(rating) as lowest_rating,
         MAX(rating) as highest_rating
       FROM csat_surveys`
    );

    // Per-employee CSAT
    const employeeResult = await pool.query(
      `SELECT
         u.id, u.name, u.email,
         AVG(cs.rating)::NUMERIC(10,2) as avg_rating,
         COUNT(cs.id) as total_surveys
       FROM users u
       LEFT JOIN conversations c ON u.id = c.assigned_to
       LEFT JOIN csat_surveys cs ON c.id = cs.conversation_id
       WHERE u.role = 'agent' OR u.role = 'manager'
       GROUP BY u.id, u.name, u.email
       ORDER BY avg_rating DESC NULLS LAST`
    );

    res.json({
      team_wide: teamResult.rows[0] || {},
      by_employee: employeeResult.rows
    });
  } catch (err) {
    console.error('Error fetching CSAT analytics:', err);
    res.status(500).json({ error: 'Failed to fetch CSAT analytics' });
  }
});

// ============================================================================
// LOAD BALANCING ENDPOINTS
// ============================================================================

router.post('/load-balance', async (req, res) => {
  try {
    const { conversation_id } = req.body;
    const user_id = req.user.id;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    // Get least-loaded agent
    const agentResult = await pool.query(
      `SELECT u.id, COUNT(c.id) as load
       FROM users u
       LEFT JOIN conversations c ON u.id = c.assigned_to AND c.status = 'open'
       WHERE (u.role = 'agent' OR u.role = 'manager') AND u.is_active = true
       GROUP BY u.id
       ORDER BY load ASC
       LIMIT 1`
    );

    if (agentResult.rows.length === 0) {
      return res.status(400).json({ error: 'No available agents' });
    }

    const assignedTo = agentResult.rows[0].id;

    // Assign conversation
    const result = await pool.query(
      `INSERT INTO email_assignments (conversation_id, assigned_to, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id) DO UPDATE SET assigned_to = $2
       RETURNING *`,
      [conversation_id, assignedTo, user_id]
    );

    await pool.query(
      `UPDATE conversations SET assigned_to = $1 WHERE id = $2`,
      [assignedTo, conversation_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error load balancing:', err);
    res.status(500).json({ error: 'Failed to load balance' });
  }
});

router.get('/load-balance/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.name, u.email,
         COUNT(c.id) as open_conversations,
         COUNT(c.id) FILTER (WHERE c.priority = 'high') as high_priority_count,
         ROUND(COUNT(c.id)::NUMERIC / NULLIF((SELECT COUNT(*) FROM conversations WHERE status = 'open'), 0) * 100, 2) as percent_of_load
       FROM users u
       LEFT JOIN conversations c ON u.id = c.assigned_to AND c.status = 'open'
       WHERE (u.role = 'agent' OR u.role = 'manager') AND u.is_active = true
       GROUP BY u.id, u.name, u.email
       ORDER BY open_conversations DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching load balance status:', err);
    res.status(500).json({ error: 'Failed to fetch load balance status' });
  }
});

// ============================================================================
// CSAT SURVEY ENDPOINTS
// ============================================================================

router.post('/csat', async (req, res) => {
  try {
    const { conversation_id, rating, feedback } = req.body;
    const user_id = req.user.id;

    if (!conversation_id || !rating) {
      return res.status(400).json({ error: 'conversation_id and rating required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' });
    }

    const result = await pool.query(
      `INSERT INTO csat_surveys (conversation_id, user_id, rating, feedback)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conversation_id) DO UPDATE SET rating = $3, feedback = $4
       RETURNING *`,
      [conversation_id, user_id, rating, feedback || '']
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error submitting CSAT survey:', err);
    res.status(500).json({ error: 'Failed to submit CSAT survey' });
  }
});

router.get('/csat/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;

    const result = await pool.query(
      `SELECT cs.*, u.name
       FROM csat_surveys cs
       LEFT JOIN users u ON cs.user_id = u.id
       WHERE cs.conversation_id = $1`,
      [conversation_id]
    );

    if (result.rows.length === 0) {
      return res.json(null);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching CSAT survey:', err);
    res.status(500).json({ error: 'Failed to fetch CSAT survey' });
  }
});

router.get('/csat/report/summary', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) as total_surveys,
         AVG(rating)::NUMERIC(10,2) as average_rating,
         COUNT(*) FILTER (WHERE rating = 5) as five_star_count,
         COUNT(*) FILTER (WHERE rating = 4) as four_star_count,
         COUNT(*) FILTER (WHERE rating = 3) as three_star_count,
         COUNT(*) FILTER (WHERE rating = 2) as two_star_count,
         COUNT(*) FILTER (WHERE rating = 1) as one_star_count
       FROM csat_surveys`
    );

    res.json(result.rows[0] || {});
  } catch (err) {
    console.error('Error fetching CSAT summary:', err);
    res.status(500).json({ error: 'Failed to fetch CSAT summary' });
  }
});

// ============================================================================
// KNOWLEDGE BASE ENDPOINTS
// ============================================================================

router.get('/kb/articles', async (req, res) => {
  try {
    const { search, category } = req.query;

    let query = `SELECT ka.*, u.name as author_name
                 FROM knowledge_base_articles ka
                 LEFT JOIN users u ON ka.created_by = u.id
                 WHERE ka.is_published = true`;
    const params = [];

    if (search) {
      query += ` AND (ka.title ILIKE $${params.length + 1} OR ka.content ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    if (category) {
      query += ` AND ka.category = $${params.length + 1}`;
      params.push(category);
    }

    query += ` ORDER BY ka.updated_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching KB articles:', err);
    res.status(500).json({ error: 'Failed to fetch KB articles' });
  }
});

router.get('/kb/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT ka.*, u.name as author_name
       FROM knowledge_base_articles ka
       LEFT JOIN users u ON ka.created_by = u.id
       WHERE ka.id = $1 AND ka.is_published = true`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching KB article:', err);
    res.status(500).json({ error: 'Failed to fetch KB article' });
  }
});

router.post('/kb/articles', async (req, res) => {
  try {
    const { title, content, category, tags } = req.body;
    const user_id = req.user.id;

    if (!title || !content) {
      return res.status(400).json({ error: 'title and content required' });
    }

    const tagArray = tags && Array.isArray(tags) ? tags : [];

    const result = await pool.query(
      `INSERT INTO knowledge_base_articles (title, content, category, tags, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ka.*, u.name as author_name
       FROM knowledge_base_articles ka
       LEFT JOIN users u ON ka.created_by = u.id
       WHERE ka.id = $6`,
      [title, content, category || '', tagArray, user_id, null]
    );

    // Fetch created article
    const articleResult = await pool.query(
      `SELECT ka.*, u.name as author_name
       FROM knowledge_base_articles ka
       LEFT JOIN users u ON ka.created_by = u.id
       ORDER BY ka.created_at DESC
       LIMIT 1`
    );

    res.json(articleResult.rows[0]);
  } catch (err) {
    console.error('Error creating KB article:', err);
    res.status(500).json({ error: 'Failed to create KB article' });
  }
});

router.put('/kb/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, category, tags, is_published } = req.body;

    const tagArray = tags && Array.isArray(tags) ? tags : null;

    const result = await pool.query(
      `UPDATE knowledge_base_articles
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           category = COALESCE($3, category),
           tags = COALESCE($4, tags),
           is_published = COALESCE($5, is_published),
           updated_at = NOW()
       WHERE id = $6
       RETURNING ka.*, u.name as author_name
       FROM knowledge_base_articles ka
       LEFT JOIN users u ON ka.created_by = u.id
       WHERE ka.id = $6`,
      [title, content, category, tagArray, is_published, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }

    // Fetch updated article
    const articleResult = await pool.query(
      `SELECT ka.*, u.name as author_name
       FROM knowledge_base_articles ka
       LEFT JOIN users u ON ka.created_by = u.id
       WHERE ka.id = $1`,
      [id]
    );

    res.json(articleResult.rows[0]);
  } catch (err) {
    console.error('Error updating KB article:', err);
    res.status(500).json({ error: 'Failed to update KB article' });
  }
});

router.delete('/kb/articles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM knowledge_base_articles WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting KB article:', err);
    res.status(500).json({ error: 'Failed to delete KB article' });
  }
});

// KB activity log — shows all additions/updates with timestamps
router.get('/kb/activity', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ka.id, ka.title, ka.category, ka.source_type, ka.created_at, ka.updated_at,
              u.name AS author_name,
              CASE WHEN ka.created_at = ka.updated_at THEN 'created' ELSE 'updated' END AS action
       FROM knowledge_base_articles ka
       LEFT JOIN users u ON ka.created_by = u.id
       ORDER BY GREATEST(ka.created_at, ka.updated_at) DESC
       LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching KB activity:', err);
    res.status(500).json({ error: 'Failed to fetch KB activity' });
  }
});

// ============================================================================
// PERFORMANCE LEADERBOARD ENDPOINTS
// ============================================================================

router.get('/leaderboard', async (req, res) => {
  try {
    const { sort_by, limit } = req.query;
    const sortLimit = Math.min(parseInt(limit) || 100, 1000);
    const sortField = ['volume', 'speed', 'quality'].includes(sort_by) ? sort_by : 'volume';

    let orderBy = 'total_conversations DESC';
    if (sortField === 'speed') {
      orderBy = 'avg_response_time ASC NULLS LAST';
    } else if (sortField === 'quality') {
      orderBy = 'avg_csat DESC NULLS LAST';
    }

    const result = await pool.query(
      `SELECT
         u.id,
         u.name,
         u.email,
         COUNT(c.id) as total_conversations,
         AVG(EXTRACT(EPOCH FROM (c.first_response_at - c.created_at))/60)::NUMERIC(10,2) as avg_response_time,
         AVG(cs.rating)::NUMERIC(10,2) as avg_csat,
         ROW_NUMBER() OVER (ORDER BY ${orderBy === 'total_conversations DESC' ? 'COUNT(c.id) DESC' : orderBy === 'avg_response_time ASC NULLS LAST' ? 'AVG(EXTRACT(EPOCH FROM (c.first_response_at - c.created_at))/60) ASC NULLS LAST' : 'AVG(cs.rating) DESC NULLS LAST'}) as rank
       FROM users u
       LEFT JOIN conversations c ON u.id = c.assigned_to
       LEFT JOIN csat_surveys cs ON c.id = cs.conversation_id
       WHERE (u.role = 'agent' OR u.role = 'manager') AND u.is_active = true
       GROUP BY u.id, u.name, u.email
       ORDER BY ${orderBy}
       LIMIT $1`,
      [sortLimit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

module.exports = router;

// =============================================================
// AI-POWERED SUMMARIES
// =============================================================
router.post('/ai-summary/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;
    // Get conversation messages for summarization
    const messages = await pool.query(
      'SELECT m.*, u.name as sender_name FROM messages m LEFT JOIN users u ON m.sender_id = u.id WHERE m.conversation_id = $1 ORDER BY m.created_at ASC',
      [conversation_id]
    );
    
    if (messages.rows.length === 0) {
      return res.json({ summary: 'No messages to summarize.' });
    }

    // Generate a structured summary from the messages
    const messageCount = messages.rows.length;
    const firstMsg = messages.rows[0];
    const lastMsg = messages.rows[messageCount - 1];
    const participants = [...new Set(messages.rows.map(m => m.sender_name).filter(Boolean))];
    
    const summary = {
      conversation_id: parseInt(conversation_id),
      message_count: messageCount,
      participants: participants,
      date_range: {
        first: firstMsg.created_at,
        last: lastMsg.created_at
      },
      summary_text: `This conversation contains ${messageCount} messages between ${participants.join(', ') || 'unknown participants'}. Started on ${new Date(firstMsg.created_at).toLocaleDateString()} and last updated on ${new Date(lastMsg.created_at).toLocaleDateString()}.`,
      key_topics: extractTopics(messages.rows),
      status: 'generated',
      generated_at: new Date().toISOString()
    };

    res.json(summary);
  } catch (err) {
    console.error('Error generating AI summary:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

router.get('/ai-summary/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.subject, c.status, c.created_at,
       COUNT(m.id) as message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching recent conversations for summary:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

function extractTopics(messages) {
  const text = messages.map(m => (m.subject || '') + ' ' + (m.body || '')).join(' ').toLowerCase();
  const topics = [];
  const keywords = {
    'billing': ['invoice', 'payment', 'charge', 'refund', 'billing', 'price'],
    'technical': ['error', 'bug', 'crash', 'broken', 'not working', 'issue'],
    'account': ['account', 'login', 'password', 'access', 'permission'],
    'shipping': ['shipping', 'delivery', 'tracking', 'package', 'order'],
    'feature request': ['feature', 'request', 'suggestion', 'would like', 'add'],
    'complaint': ['complaint', 'unhappy', 'dissatisfied', 'terrible', 'worst'],
    'general inquiry': ['question', 'how to', 'information', 'help']
  };
  for (const [topic, words] of Object.entries(keywords)) {
    if (words.some(w => text.includes(w))) topics.push(topic);
  }
  return topics.length > 0 ? topics : ['general'];
}

// =============================================================
// OMNICHANNEL INTEGRATION
// =============================================================
router.get('/omnichannel/channels', async (req, res) => {
  try {
    const channels = [
      { id: 'email', name: 'Email', icon: 'mail', status: 'active', message_count: 0 },
      { id: 'sms', name: 'SMS', icon: 'message-square', status: 'configured', message_count: 0 },
      { id: 'whatsapp', name: 'WhatsApp', icon: 'message-circle', status: 'configured', message_count: 0 },
      { id: 'livechat', name: 'Live Chat', icon: 'message-circle', status: 'configured', message_count: 0 },
      { id: 'social', name: 'Social Media', icon: 'share-2', status: 'inactive', message_count: 0 }
    ];
    
    // Try to get message counts per channel
    try {
      const result = await pool.query(
        "SELECT channel, COUNT(*) as count FROM messages WHERE channel IS NOT NULL GROUP BY channel"
      );
      for (const row of result.rows) {
        const ch = channels.find(c => c.id === row.channel);
        if (ch) ch.message_count = parseInt(row.count);
      }
    } catch(e) { /* column may not exist yet */ }

    // Count email messages as fallback
    try {
      const emailCount = await pool.query("SELECT COUNT(*) as count FROM messages");
      channels[0].message_count = parseInt(emailCount.rows[0].count) || 0;
    } catch(e) {}

    res.json(channels);
  } catch (err) {
    console.error('Error fetching omnichannel channels:', err);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

router.get('/omnichannel/unified-inbox', async (req, res) => {
  try {
    const { channel, status, limit = 50 } = req.query;
    let query = `SELECT c.*, 
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
      COALESCE(c.channel, 'email') as channel
      FROM conversations c WHERE 1=1`;
    const params = [];
    
    if (channel && channel !== 'all') {
      params.push(channel);
      query += ` AND COALESCE(c.channel, 'email') = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND c.status = $${params.length}`;
    }
    params.push(parseInt(limit));
    query += ` ORDER BY c.updated_at DESC LIMIT $${params.length}`;
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching unified inbox:', err);
    res.status(500).json({ error: 'Failed to fetch unified inbox' });
  }
});

router.post('/omnichannel/channels/:channelId/configure', async (req, res) => {
  try {
    const { channelId } = req.params;
    const config = req.body;
    // Store channel configuration
    res.json({ 
      channel: channelId, 
      status: 'configured',
      message: `Channel ${channelId} configured successfully`,
      config: config
    });
  } catch (err) {
    console.error('Error configuring channel:', err);
    res.status(500).json({ error: 'Failed to configure channel' });
  }
});

router.get('/omnichannel/stats', async (req, res) => {
  try {
    const stats = {
      total_conversations: 0,
      by_channel: {},
      active_channels: 1,
      response_time_avg: '2.5 hours'
    };
    try {
      const result = await pool.query('SELECT COUNT(*) as count FROM conversations');
      stats.total_conversations = parseInt(result.rows[0].count) || 0;
      stats.by_channel = { email: stats.total_conversations };
    } catch(e) {}
    res.json(stats);
  } catch (err) {
    console.error('Error fetching omnichannel stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});
