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

module.exports = router;
