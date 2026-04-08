const { pool } = require('../config/database');

const requireAuth = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // Load user role into req.user if not already loaded
  if (!req.user) {
    try {
      const result = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [req.session.userId]);
      if (result.rows[0]) {
        req.user = result.rows[0];
      }
    } catch (err) { /* continue without user */ }
  }
  next();
};

/**
 * requireRole(...roles) - Returns middleware that checks if req.user.role is in the allowed roles.
 * Must be used AFTER requireAuth so that req.user is populated.
 * Returns 403 if the user's role is not in the allowed list.
 */
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
};

const requireAdmin = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows[0] || !['admin', 'manager'].includes(result.rows[0].role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

const loadUser = async (req, res, next) => {
  if (req.session && req.session.userId) {
    try {
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
      req.user = result.rows[0];
    } catch (err) { /* continue without user */ }
  }
  next();
};

module.exports = { requireAuth, requireAdmin, requireRole, loadUser };
