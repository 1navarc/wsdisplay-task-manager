#!/bin/bash
set -e
echo "=== Generating WSDisplay Email Application ==="
cd ~/wsdisplay-email

# Dockerfile
cat > Dockerfile << 'EOF'
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server/index.js"]
EOF

# .dockerignore
cat > .dockerignore << 'EOF'
node_modules
.env
.git
EOF

# server/index.js - Main entry point
cat > server/index.js << 'EOF'
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'wsdisplay-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24*60*60*1000 }
});
app.use(sessionMiddleware);

// Share session with socket.io
io.engine.use(sessionMiddleware);

// Make io accessible to routes
app.set('io', io);

// Health check
app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));

// API Routes
app.use('/auth', require('./routes/auth'));
app.use('/api/mailboxes', require('./routes/mailboxes'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/tags', require('./routes/tags'));
app.use('/api/canned-responses', require('./routes/canned-responses'));
app.use('/api/sla', require('./routes/sla'));
app.use('/api/analytics', require('./routes/analytics'));

// Gmail webhook
app.post('/api/gmail/webhook', require('./routes/gmail-webhook'));

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/auth')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

// Socket.IO
require('./socket')(io);

// SLA check cron - every minute
const { checkSLAs } = require('./services/sla-engine');
cron.schedule('* * * * *', () => checkSLAs(io));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('WSDisplay Email API running on port ' + PORT));
EOF

# server/config/database.js
cat > server/config/database.js << 'EOF'
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || '/cloudsql/' + process.env.CLOUD_SQL_CONNECTION_NAME,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'wsdisplay_email',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20
});
pool.on('error', (err) => console.error('Database pool error:', err));

const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

module.exports = { pool, transaction };
EOF

# server/config/gmail.js
cat > server/config/gmail.js << 'EOF'
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

const createOAuth2Client = () => new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback'
);

const createGmailClient = (tokens) => {
  const auth = createOAuth2Client();
  auth.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth });
};

module.exports = { SCOPES, createOAuth2Client, createGmailClient };
EOF

# server/middleware/auth.js
cat > server/middleware/auth.js << 'EOF'
const { pool } = require('../config/database');

const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

const requireAdmin = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows[0] || result.rows[0].role !== 'admin') {
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

module.exports = { requireAuth, requireAdmin, loadUser };
EOF

echo "=== Core files created ==="
