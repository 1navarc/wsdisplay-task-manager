/**
 * Email Intelligence routes — manager-only.
 *
 * Endpoints:
 *   GET    /api/intel/attention                 list open attention items
 *   GET    /api/intel/attention/summary         counts by type/severity
 *   POST   /api/intel/attention/:id/dismiss     dismiss item
 *   POST   /api/intel/attention/:id/resolve     mark resolved
 *   POST   /api/intel/attention/:id/snooze      snooze until ISO date
 *   POST   /api/intel/attention/run             trigger detector run now
 *
 *   GET    /api/intel/quality                   per-rep quality summary
 *   GET    /api/intel/quality/worst             worst replies (drill-down)
 *   POST   /api/intel/quality/backfill          start grader backfill run
 *
 *   POST   /api/intel/classify/backfill         start classifier backfill
 *
 *   GET    /api/intel/top-questions             top question/product rows
 *   GET    /api/intel/heatmap                   product × hour heatmap
 *   GET    /api/intel/heatmap/dow               day-of-week × hour
 *
 *   GET    /api/intel/faq-candidates            list FAQ drafts
 *   POST   /api/intel/faq-candidates/run        trigger FAQ suggester run
 *   POST   /api/intel/faq-candidates/:id/review approve | reject | export
 *
 *   GET    /api/intel/training-candidates       list training drafts
 *   POST   /api/intel/training-candidates/run   trigger training suggester
 *   POST   /api/intel/training-candidates/:id/review approve | reject | apply
 */

const express = require('express');
const router = express.Router();

const { requireAuth, requireRole } = require('../middleware/auth');

const classifier = require('../services/email-classifier');
const grader = require('../services/rep-quality-grader');
const attention = require('../services/manager-attention');
const intel = require('../services/email-intelligence');

const mgr = [requireAuth, requireRole('manager')];

/* -------------------------- attention --------------------------- */

router.get('/attention', ...mgr, async (req, res) => {
  try {
    const { severity, item_type, limit } = req.query;
    const rows = await attention.listOpen({
      severity, item_type,
      limit: Math.min(parseInt(limit, 10) || 100, 500),
    });
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/attention/summary', ...mgr, async (req, res) => {
  try { res.json({ summary: await attention.summary() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/attention/:id/dismiss', ...mgr, async (req, res) => {
  try {
    const item = await attention.dismissItem(req.params.id, req.session.userId, req.body?.reason);
    res.json({ item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/attention/:id/resolve', ...mgr, async (req, res) => {
  try {
    const item = await attention.resolveItem(req.params.id, req.session.userId);
    res.json({ item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/attention/:id/snooze', ...mgr, async (req, res) => {
  try {
    const { until } = req.body || {};
    if (!until) return res.status(400).json({ error: 'until required' });
    const item = await attention.snoozeItem(req.params.id, until);
    res.json({ item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/attention/run', ...mgr, async (req, res) => {
  try {
    // Async-fire so HTTP returns quickly
    attention.runAll().catch(e => console.warn('attention runAll:', e.message));
    res.json({ started: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --------------------------- quality ---------------------------- */

router.get('/quality', ...mgr, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    res.json({ rows: await intel.repQualitySummary({ days }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/quality/worst', ...mgr, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const repEmail = req.query.rep_email || null;
    res.json({ rows: await intel.worstReplies({ days, repEmail, limit }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/quality/backfill', ...mgr, async (req, res) => {
  try {
    const out = await grader.runBackfill({
      mailbox: req.body?.mailbox || null,
      userId: req.session.userId,
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------- classifier --------------------------- */

router.post('/classify/backfill', ...mgr, async (req, res) => {
  try {
    const out = await classifier.runBackfill({
      mailbox: req.body?.mailbox || null,
      userId: req.session.userId,
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/classify/pending', ...mgr, async (req, res) => {
  try {
    res.json({ pending: await classifier.pendingCount(req.query.mailbox || null) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ----------------------- top questions / heatmap ----------------- */

router.get('/summary', ...mgr, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    res.json(await intel.summary({ days }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sentiment', ...mgr, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    res.json(await intel.sentimentMix({ days, mailbox: req.query.mailbox || null }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/top-questions', ...mgr, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
    res.json({
      rows: await intel.topQuestions({
        days, limit,
        productLine: req.query.product_line || null,
        mailbox: req.query.mailbox || null,
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/heatmap', ...mgr, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    res.json({
      rows: await intel.productHourHeatmap({ days, mailbox: req.query.mailbox || null }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/heatmap/dow', ...mgr, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
    res.json({
      rows: await intel.dowHourHeatmap({ days, mailbox: req.query.mailbox || null }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------ FAQ candidates ------------------------ */

router.get('/faq-candidates', ...mgr, async (req, res) => {
  try {
    res.json({
      rows: await intel.listFaqCandidates({
        status: req.query.status || 'pending',
        limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/faq-candidates/run', ...mgr, async (req, res) => {
  try {
    const out = await intel.runFaqSuggester({ userId: req.session.userId });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/faq-candidates/:id/review', ...mgr, async (req, res) => {
  try {
    const { action, note } = req.body || {};
    if (!['approve','reject','export'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve|reject|export' });
    }
    const row = await intel.reviewFaqCandidate(req.params.id, action, req.session.userId, note);
    res.json({ row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --------------------- Training candidates ---------------------- */

router.get('/training-candidates', ...mgr, async (req, res) => {
  try {
    res.json({
      rows: await intel.listTrainingCandidates({
        status: req.query.status || 'pending',
        limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/training-candidates/run', ...mgr, async (req, res) => {
  try {
    const out = await intel.runTrainingSuggester({ userId: req.session.userId });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/training-candidates/:id/review', ...mgr, async (req, res) => {
  try {
    const { action, note } = req.body || {};
    if (!['approve','reject','apply'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve|reject|apply' });
    }
    const row = await intel.reviewTrainingCandidate(req.params.id, action, req.session.userId, note);
    res.json({ row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ===========================================================================
 * Customer Intelligence — type-ahead + 360 profile
 * ======================================================================== */

const customerIntel = require('../services/customer-intel');

// In-memory cache for next-best-action AI calls (keyed by type|key)
// 10-min TTL keeps the panel snappy on repeated lookups + caps Gemini cost
const _cust_aicache = new Map();
function _cust_cacheGet(k) {
  const v = _cust_aicache.get(k);
  if (v && (Date.now() - v.t) < 10 * 60 * 1000) return v.data;
  return null;
}
function _cust_cacheSet(k, data) {
  _cust_aicache.set(k, { t: Date.now(), data });
  // Cap cache size
  if (_cust_aicache.size > 200) {
    const first = _cust_aicache.keys().next().value;
    _cust_aicache.delete(first);
  }
}

// GET /api/intel/customer/search?q=acme&limit=12
router.get('/customer/search', ...mgr, async (req, res) => {
  try {
    const q = (req.query.q || '').toString();
    const limit = Math.min(parseInt(req.query.limit) || 12, 30);
    const results = await customerIntel.searchCandidates({ q, limit });
    res.json({ q, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intel/customer/profile?type=domain&key=acme.com[&with_ai=1]
router.get('/customer/profile', ...mgr, async (req, res) => {
  try {
    const { type, key } = req.query;
    if (!type || !key) return res.status(400).json({ error: 'type and key required' });
    const profile = await customerIntel.getProfile({ type, key: String(key) });
    if (!profile.found) return res.json(profile);

    if (req.query.with_ai === '1') {
      const cacheKey = `${type}|${String(key).toLowerCase()}`;
      let ai = _cust_cacheGet(cacheKey);
      if (!ai) {
        ai = await customerIntel.generateNextBestAction(profile);
        _cust_cacheSet(cacheKey, ai);
      }
      profile.ai = ai;
    }
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/intel/customer/refresh-ai — force a fresh next-best-action regen
router.post('/customer/refresh-ai', ...mgr, async (req, res) => {
  try {
    const { type, key } = req.body || {};
    if (!type || !key) return res.status(400).json({ error: 'type and key required' });
    const profile = await customerIntel.getProfile({ type, key });
    if (!profile.found) return res.json(profile);
    const ai = await customerIntel.generateNextBestAction(profile);
    _cust_cacheSet(`${type}|${String(key).toLowerCase()}`, ai);
    res.json({ ai });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
