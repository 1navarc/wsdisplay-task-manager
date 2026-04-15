const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('combined'));

// Run database migrations
async function runMigrations(pool) {
  try {
    // Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Seed tracking records for migrations 001-013 (already applied via auto-run blocks)
    const alreadyApplied = [
      '001_initial_schema.sql', '002_mailbox_tokens.sql', '005_manager_tables.sql',
      '006_new_features.sql', '007_unique_constraints.sql', '008_feedback.sql',
      '009_notifications.sql', '010_settings.sql', '011_signatures_and_snooze.sql',
      '012_fix_mailbox_types.sql', '013_roles.sql'
    ];
    for (const name of alreadyApplied) {
      await pool.query('INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    }

    const fs = require('fs');
    const path = require('path');
    const migrationsDir = path.join(__dirname, 'db/migrations');

    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await pool.query('SELECT id FROM migrations WHERE name = $1', [file]);
      if (applied.rows.length === 0) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await pool.query(sql);
        await pool.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
        console.log(`Applied migration: ${file}`);
      }
    }
  } catch (err) {
    console.error('Migration error:', err.message);
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const { pool } = require('./config/database');
const sessionMiddleware = session({
  store: new pgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'wsdisplay-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7*24*60*60*1000 }
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
app.use('/api/manager', require('./routes/manager-dashboard'));
app.use('/api/features', require('./routes/features'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/command-center', require('./routes/command-center'));
app.use('/api/archive', require('./routes/archive'));
app.use('/api/intel', require('./routes/intelligence'));

// Gmail webhook
app.post('/api/gmail/webhook', require('./routes/gmail-webhook'));
app.use('/api/gmail', require('./routes/gmail-sync'));
app.use('/api/twilio', require('./routes/twilio'));

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

// Auto-run migration 005 at startup
const fs = require('fs');
const pathModule = require('path');
const migrationFile = pathModule.join(__dirname, 'db', 'migrations', '005_manager_tables.sql');
if (fs.existsSync(migrationFile)) {
  const { pool } = require('./config/database');
  const migrationSQL = fs.readFileSync(migrationFile, 'utf8');
  pool.query(migrationSQL)
    .then(() => console.log('Migration 005_manager_tables applied successfully'))
    .catch(err => console.log('Migration 005 note:', err.message));
}


// Auto-run migration 006 at startup
const migrationFile006 = pathModule.join(__dirname, 'db', 'migrations', '006_new_features.sql');
if (fs.existsSync(migrationFile006)) {
  const { pool: pool006 } = require('./config/database');
  const migrationSQL006 = fs.readFileSync(migrationFile006, 'utf8');
  pool006.query(migrationSQL006)
    .then(() => console.log('Migration 006_new_features applied successfully'))
    .catch(err => console.log('Migration 006 note:', err.message));
}

// Auto-run migration 007 at startup
const migrationFile007 = pathModule.join(__dirname, 'db', 'migrations', '007_unique_constraints.sql');
if (fs.existsSync(migrationFile007)) {
  pool.query(fs.readFileSync(migrationFile007, 'utf8'))
    .then(() => console.log('Migration 007_unique_constraints applied successfully'))
    .catch(err => console.log('Migration 007 note:', err.message));
}

// Auto-run migration 008 at startup
const migrationFile008 = pathModule.join(__dirname, 'db', 'migrations', '008_feedback.sql');
if (fs.existsSync(migrationFile008)) {
  pool.query(fs.readFileSync(migrationFile008, 'utf8'))
    .then(() => console.log('Migration 008_feedback applied successfully'))
    .catch(err => console.log('Migration 008 note:', err.message));
}

// Auto-run migration 009 at startup
const migrationFile009 = pathModule.join(__dirname, 'db', 'migrations', '009_notifications.sql');
if (fs.existsSync(migrationFile009)) {
  pool.query(fs.readFileSync(migrationFile009, 'utf8'))
    .then(() => console.log('Migration 009_notifications applied successfully'))
    .catch(err => console.log('Migration 009 note:', err.message));
}

// Auto-run migration 010 at startup
const migrationFile010 = pathModule.join(__dirname, 'db', 'migrations', '010_settings.sql');
if (fs.existsSync(migrationFile010)) {
  pool.query(fs.readFileSync(migrationFile010, 'utf8'))
    .then(() => console.log('Migration 010_settings applied successfully'))
    .catch(err => console.log('Migration 010 note:', err.message));
}

// Auto-run migration 011 at startup
const migrationFile011 = pathModule.join(__dirname, 'db', 'migrations', '011_signatures_and_snooze.sql');
if (fs.existsSync(migrationFile011)) {
  pool.query(fs.readFileSync(migrationFile011, 'utf8'))
    .then(() => console.log('Migration 011_signatures_and_snooze applied successfully'))
    .catch(err => console.log('Migration 011 note:', err.message));
}

// Auto-run migration 012 at startup
const migrationFile012 = pathModule.join(__dirname, 'db', 'migrations', '012_fix_mailbox_types.sql');
if (fs.existsSync(migrationFile012)) {
  pool.query(fs.readFileSync(migrationFile012, 'utf8'))
    .then(() => console.log('Migration 012_fix_mailbox_types applied successfully'))
    .catch(err => console.log('Migration 012 note:', err.message));
}

// Auto-run migration 013 at startup (roles)
const migrationFile013 = pathModule.join(__dirname, 'db', 'migrations', '013_roles.sql');
if (fs.existsSync(migrationFile013)) {
  pool.query(fs.readFileSync(migrationFile013, 'utf8'))
    .then(() => console.log('Migration 013_roles applied successfully'))
    .catch(err => console.log('Migration 013 note:', err.message));
}

// Auto-sync Gmail every 2 minutes (server-side, works even when app is closed)
cron.schedule('*/2 * * * *', async () => {
  try {
    const { syncAllMailboxes } = require('./services/gmail-sync');
    const synced = await syncAllMailboxes(pool);
    if (synced > 0) {
      console.log(`Auto-sync: ${synced} new messages`);
      if (io) io.emit('conversation:updated', {});
    }
  } catch (err) {
    // Ignore sync errors during startup
  }
});

// Auto-unsnooze cron - every minute, unsnooze conversations whose snoozed_until has passed
cron.schedule('* * * * *', async () => {
  try {
    const result = await pool.query(
      "UPDATE conversations SET is_snoozed = false, snoozed_until = NULL WHERE is_snoozed = true AND snoozed_until < NOW() RETURNING id"
    );
    if (result.rows.length > 0) {
      console.log(`Auto-unsnoozed ${result.rows.length} conversation(s)`);
      if (io) {
        result.rows.forEach(row => io.emit('conversation:updated', { id: row.id }));
      }
    }
  } catch (err) {
    // Ignore errors during early startup when table may not exist yet
  }
});

// Run migrations then start server
runMigrations(pool).then(async () => {
  // Initialize pgvector support for AI features
  try {
    const { initVectorSupport } = require('./services/ai-service');
    await initVectorSupport();
  } catch (err) {
    console.error('AI service init (non-fatal):', err.message);
  }
  // Initialize daily email report scheduler (reads app_settings, sets cron)
  try {
    const { initDailyReportScheduler } = require('./services/daily-report');
    initDailyReportScheduler();
  } catch (err) {
    console.error('Daily report scheduler init (non-fatal):', err.message);
  }
  // Email Archive: resume any orphaned runs from a prior server restart,
  // then auto-start backfill (if configured) and schedule hourly delta sync.
  try {
    const archive = require('./services/email-archive');
    // 1) Resume orphaned runs first
    archive.resumeIncompleteRuns().catch(e => console.warn('archive resume:', e.message));
    // 2) Hourly delta sync for every connected mailbox
    cron.schedule('0 * * * *', async () => {
      try {
        const r = await archive.deltaSyncAll();
        const total = r.reduce((acc, x) => acc + (x.newMessages || 0), 0);
        if (total > 0) console.log(`[archive] hourly delta sync: ${total} new messages across mailboxes`);
      } catch (e) {
        console.warn('archive delta cron:', e.message);
      }
    });
    // 3) Auto-start backfill once on startup if configured
    setTimeout(async () => {
      try {
        const cfg = await archive.getConfig();
        if (cfg.auto_start_backfill_on_deploy) {
          console.log('[archive] auto-starting backfill on deploy');
          await archive.backfillAll({ years: cfg.backfill_years });
        }
      } catch (e) {
        console.warn('archive auto-start:', e.message);
      }
    }, 30_000); // wait 30s after boot to let DB warm up
  } catch (err) {
    console.error('Email archive init (non-fatal):', err.message);
  }

  // Email Intelligence: classifier + grader + attention + nightly suggesters
  try {
    const classifier = require('./services/email-classifier');
    const grader = require('./services/rep-quality-grader');
    const attention = require('./services/manager-attention');
    const intel = require('./services/email-intelligence');

    // Classifier every 5 minutes — picks up newly-archived inbound messages
    cron.schedule('*/5 * * * *', () => {
      classifier.cronTick().catch(e => console.warn('[classifier cron]', e.message));
    });
    // Quality grader every 5 minutes — grades newly-archived outbound rep replies
    cron.schedule('*/5 * * * *', () => {
      grader.cronTick().catch(e => console.warn('[grader cron]', e.message));
    });
    // Attention scanner every 15 minutes
    cron.schedule('*/15 * * * *', () => {
      attention.runAll().catch(e => console.warn('[attention cron]', e.message));
    });
    // Nightly FAQ + Training suggesters at 4am
    cron.schedule('0 4 * * *', () => {
      intel.runFaqSuggester({}).catch(e => console.warn('[faq cron]', e.message));
      intel.runTrainingSuggester({}).catch(e => console.warn('[training cron]', e.message));
    });
    console.log('[intel] crons scheduled (classify/5m, grade/5m, attention/15m, suggest 04:00)');
  } catch (err) {
    console.error('Email intelligence init (non-fatal):', err.message);
  }

  server.listen(PORT, () => console.log('WSDisplay Email API running on port ' + PORT));
}).catch(err => {
  console.error('Failed to run migrations:', err);
  server.listen(PORT, () => console.log('WSDisplay Email API running on port ' + PORT));
});
