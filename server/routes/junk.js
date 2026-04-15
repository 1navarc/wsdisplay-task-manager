/**
 * Junk-filter routes — manager-only.
 *
 * Endpoints:
 *   GET    /api/junk/stats               counts (clean / blocked / possible_spam) + last scan
 *   GET    /api/junk/blocklist           list manual blocklist entries
 *   POST   /api/junk/blocklist           add an email/domain to blocklist
 *                                          body: { pattern, reason?, mailboxEmail? }
 *   DELETE /api/junk/blocklist/:id       remove a blocklist entry
 *
 *   POST   /api/junk/scan                run a bulk scan now
 *                                          body: { mailboxEmail? }
 *
 *   GET    /api/junk/possible-spam       list threads currently tagged 'possible_spam'
 *   POST   /api/junk/threads/:id/block   manually mark a thread as 'blocked' (and add
 *                                          its sender to blocklist if requested)
 *                                          body: { reason?, alsoBlocklist?: 'email'|'domain' }
 *   POST   /api/junk/threads/:id/clear   clear junk_status on a thread (false-positive)
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const junk = require('../services/junk-filter');

const mgr = [requireAuth, requireRole('manager')];

// --------- stats ---------
router.get('/stats', ...mgr, async (req, res) => {
    try {
        const stats = await junk.getStats({ mailboxEmail: req.query.mailbox || null });
        res.json(stats);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --------- blocklist CRUD ---------
router.get('/blocklist', ...mgr, async (req, res) => {
    try {
        const rows = await junk.listBlocklist({ mailboxEmail: req.query.mailbox || null });
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/blocklist', ...mgr, async (req, res) => {
    try {
        const { pattern, reason, mailboxEmail } = req.body || {};
        if (!pattern) return res.status(400).json({ error: 'pattern required' });
        const row = await junk.addBlocklistEntry({
            pattern,
            reason: reason || null,
            mailboxEmail: mailboxEmail || null,
            addedByUserId: req.session && req.session.userId || null,
        });
        res.json(row);
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/blocklist/:id', ...mgr, async (req, res) => {
    try {
        await junk.removeBlocklistEntry(req.params.id);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --------- bulk scan ---------
router.post('/scan', ...mgr, async (req, res) => {
    try {
        const result = await junk.runBulkScan({
            mailboxEmail: (req.body && req.body.mailboxEmail) || null,
            startedByUserId: req.session && req.session.userId || null,
        });
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --------- possible-spam review ---------
router.get('/possible-spam', ...mgr, async (req, res) => {
    try {
        const rows = await junk.listPossibleSpam({
            mailboxEmail: req.query.mailbox || null,
            limit: parseInt(req.query.limit) || 100,
        });
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --------- per-thread mark / clear ---------
router.post('/threads/:id/block', ...mgr, async (req, res) => {
    try {
        const { reason, alsoBlocklist } = req.body || {};
        const tr = await pool.query(
            `SELECT customer_email, mailbox_email FROM email_archive_threads WHERE id = $1`,
            [req.params.id]
        );
        if (!tr.rows.length) return res.status(404).json({ error: 'thread not found' });

        await junk.markThread(req.params.id, { status: 'blocked', reason: reason || 'manual block' });

        let added = null;
        if (alsoBlocklist && tr.rows[0].customer_email) {
            const customerEmail = tr.rows[0].customer_email;
            const pattern = alsoBlocklist === 'domain' && customerEmail.includes('@')
                ? customerEmail.split('@')[1]
                : customerEmail;
            added = await junk.addBlocklistEntry({
                pattern,
                reason: reason || `manually added from thread ${req.params.id}`,
                mailboxEmail: tr.rows[0].mailbox_email || null,
                addedByUserId: req.session && req.session.userId || null,
            });
        }
        res.json({ ok: true, blocklist_entry: added });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/threads/:id/clear', ...mgr, async (req, res) => {
    try {
        await junk.clearThread(req.params.id);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
