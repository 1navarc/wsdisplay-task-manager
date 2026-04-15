/**
 * Junk filter — manual blocklist + heuristic possible-spam tagging.
 *
 * Two layers:
 *  1. BLOCKLIST  → user adds an email or domain. Anything matching is
 *                  hard-tagged 'blocked' and HIDDEN from every downstream
 *                  query (metrics, attention queue, customer 360, patterns,
 *                  anomalies, ticker).
 *  2. HEURISTICS → automatic 'possible_spam' label for things that look like
 *                  cold-pitches, marketing, or auto-mailers. Visible with a
 *                  warning so the user can confirm-block or unflag.
 *
 * Reversible by design: status lives on threads/messages, blocklist drives
 * 'blocked' tagging. Removing a blocklist entry + rerunning scan clears the
 * tag. 'possible_spam' tag clears if the heuristic stops matching.
 */

const { pool } = require('../config/database');

// ---------- Heuristic patterns ----------
//
// Each rule returns either null (no match) or a short reason string. Order
// doesn't matter — we run them all and the first match becomes the reason.
//
// Designed to catch obvious solicitation without false-positiving real
// customer threads. Conservative on purpose; user can confirm-block via
// the UI to add the sender to the manual blocklist.

const NOREPLY_LOCAL_RE = /^(no[-_.]?reply|donotreply|do[-_.]?not[-_.]?reply|mailer|mail|news(letter)?|notif(y|ication)|updates?|info|hello|team|support|automated|auto)@/i;

const SOLICITATION_KEYWORDS = [
    // Cold sales / outreach
    'quick question', 'a moment of your time', 'is this still a priority',
    'circling back', 'just following up', 'wanted to reach out', 'reaching out',
    'thought you might be interested', 'demo', 'partnership opportunity',
    'introduce myself', 'we help companies', 'we work with',
    // Marketing / promo
    'unsubscribe', 'manage your preferences', 'view in browser', 'view this email',
    'limited time offer', 'special offer', 'discount code', '% off',
    'new arrivals', 'shop now', 'buy now', 'free trial', 'sign up free',
    // Lead-gen / SEO services
    'seo services', 'web design services', 'website redesign', 'rank higher',
    'first page of google', 'guest post', 'backlink', 'link exchange',
    // Generic vendor pitches
    'lower your costs', 'save money on', 'merchant services',
    'business loan', 'cash advance', 'credit card processing',
];

const BULK_SENDER_DOMAINS = [
    // Common ESPs / bulk-mail relays. Real customer mail almost never comes from these.
    'mailchimp.com', 'mailchimpapp.com', 'sendgrid.net', 'sendgrid.com',
    'amazonses.com', 'mandrillapp.com', 'sparkpostmail.com',
    'constantcontact.com', 'ccsend.com', 'mlsend.com', 'mailgun.org',
    'klaviyomail.com', 'klaviyo.com', 'campaign-archive.com',
    'hubspotemail.net', 'hubspot.com', 'pardot.com',
    'list-manage.com', 'createsend1.com', 'cmail19.com', 'cmail20.com',
];

function classifyMessageHeuristic(msg) {
    const fromEmail = (msg.from_email || '').toLowerCase();
    const fromName = (msg.from_name || '').toLowerCase();
    const subject = (msg.subject || '').toLowerCase();
    const body = (msg.body_text_clean || msg.snippet || '').toLowerCase();
    const fromDomain = fromEmail.includes('@') ? fromEmail.split('@')[1] : '';

    // 1. Bulk-mail relay
    for (const d of BULK_SENDER_DOMAINS) {
        if (fromDomain === d || fromDomain.endsWith('.' + d)) {
            return `bulk-mailer (${d})`;
        }
    }

    // 2. No-reply / mailer-style local-part
    if (NOREPLY_LOCAL_RE.test(fromEmail)) {
        // Soften: if the rest of the body has actual customer-style content
        // (an order ref, a "hi <name>" addressed to OUR people), don't flag.
        // For now we only flag when the subject ALSO looks marketing-ish or
        // the body contains an unsubscribe footer.
        if (/unsubscribe|manage your preferences|view in browser/i.test(body)
            || /(\d+%\s*off|sale|newsletter|special offer|deals?)/i.test(subject)) {
            return `no-reply mailer (${fromEmail.split('@')[0]})`;
        }
    }

    // 3. Solicitation keyword in subject (more specific than body)
    for (const kw of SOLICITATION_KEYWORDS) {
        if (subject.includes(kw)) {
            return `marketing keyword in subject ("${kw}")`;
        }
    }

    // 4. Multiple solicitation keywords in body — single hit can false-positive
    let bodyHits = 0;
    let firstBodyHit = null;
    for (const kw of SOLICITATION_KEYWORDS) {
        if (body.includes(kw)) {
            bodyHits++;
            if (!firstBodyHit) firstBodyHit = kw;
            if (bodyHits >= 2) break;
        }
    }
    if (bodyHits >= 2) {
        return `marketing keywords in body ("${firstBodyHit}" + ${bodyHits - 1} more)`;
    }

    return null;
}

// ---------- Blocklist matching ----------

function normalizePattern(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    if (s.includes('@')) return { kind: 'email', value: s };
    // strip leading @ or http(s)://
    let domain = s.replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain.includes('.')) return null;
    return { kind: 'domain', value: domain };
}

function matchBlocklist(customerEmail, blocklist) {
    if (!customerEmail) return null;
    const email = customerEmail.toLowerCase();
    const domain = email.includes('@') ? email.split('@')[1] : '';
    for (const b of blocklist) {
        if (b.pattern_kind === 'email' && b.pattern === email) return b;
        if (b.pattern_kind === 'domain' && (domain === b.pattern || domain.endsWith('.' + b.pattern))) return b;
    }
    return null;
}

// ---------- Blocklist CRUD ----------

async function listBlocklist({ mailboxEmail = null } = {}) {
    const r = await pool.query(
        `SELECT * FROM email_archive_blocklist
          WHERE mailbox_email IS NULL OR mailbox_email = $1
          ORDER BY added_at DESC`,
        [mailboxEmail]
    );
    return r.rows;
}

async function addBlocklistEntry({ mailboxEmail = null, pattern, reason = null, addedByUserId = null, applyImmediately = true }) {
    const norm = normalizePattern(pattern);
    if (!norm) throw new Error(`Invalid pattern "${pattern}" — must be an email or a domain.`);
    const r = await pool.query(
        `INSERT INTO email_archive_blocklist
            (mailbox_email, pattern, pattern_kind, reason, added_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (mailbox_email, pattern) DO UPDATE
            SET reason = COALESCE(EXCLUDED.reason, email_archive_blocklist.reason),
                added_by_user_id = COALESCE(EXCLUDED.added_by_user_id, email_archive_blocklist.added_by_user_id)
         RETURNING *`,
        [mailboxEmail, norm.value, norm.kind, reason, addedByUserId]
    );
    const row = r.rows[0];
    if (applyImmediately) {
        const swept = await applyBlocklistEntry(row);
        row.threads_matched = swept;
    }
    return row;
}

/**
 * Immediately tag every existing thread that matches a single blocklist entry
 * as 'blocked'. Skips threads the user manually marked. Cheaper than a full
 * bulk scan because we only run blocklist match for ONE entry, no heuristic.
 * Returns the count of newly-blocked threads.
 */
async function applyBlocklistEntry(entry) {
    if (!entry || !entry.id) return 0;
    const tag = `blocklist:${entry.id}`;
    const reason = `blocklist match: ${entry.pattern_kind}=${entry.pattern}`;
    let upd;
    if (entry.pattern_kind === 'email') {
        upd = await pool.query(
            `UPDATE email_archive_threads
                SET junk_status='blocked',
                    junk_reason=$1,
                    junk_marked_at=NOW(),
                    junk_marked_by=$2
              WHERE LOWER(customer_email) = $3
                AND (junk_marked_by IS NULL OR junk_marked_by NOT LIKE 'manual%')
                AND ($4::text IS NULL OR mailbox_email = $4)
                AND junk_status IS DISTINCT FROM 'blocked'`,
            [reason, tag, entry.pattern, entry.mailbox_email]
        );
    } else {
        // Domain match — sender's email ends with @<domain> or @<sub>.<domain>
        upd = await pool.query(
            `UPDATE email_archive_threads
                SET junk_status='blocked',
                    junk_reason=$1,
                    junk_marked_at=NOW(),
                    junk_marked_by=$2
              WHERE (LOWER(customer_email) LIKE '%@' || $3
                  OR LOWER(customer_email) LIKE '%.' || $3)
                AND (junk_marked_by IS NULL OR junk_marked_by NOT LIKE 'manual%')
                AND ($4::text IS NULL OR mailbox_email = $4)
                AND junk_status IS DISTINCT FROM 'blocked'`,
            [reason, tag, entry.pattern, entry.mailbox_email]
        );
    }
    const matched = upd.rowCount || 0;
    await pool.query(
        `UPDATE email_archive_blocklist
            SET threads_matched = COALESCE(threads_matched, 0) + $2,
                last_scan_at = NOW()
          WHERE id = $1`,
        [entry.id, matched]
    );
    return matched;
}

async function removeBlocklistEntry(id) {
    await pool.query(`DELETE FROM email_archive_blocklist WHERE id = $1`, [id]);
}

/**
 * Group currently-flagged 'possible_spam' threads by sender domain (or full
 * sender email for free-mail senders). Powers the "easy dismissal" view.
 */
async function listPossibleSpamGrouped({ mailboxEmail = null, limit = 5000 } = {}) {
    const where = mailboxEmail
        ? `WHERE junk_status = 'possible_spam' AND mailbox_email = $1`
        : `WHERE junk_status = 'possible_spam'`;
    const params = mailboxEmail ? [mailboxEmail, limit] : [limit];
    const limitParam = mailboxEmail ? '$2' : '$1';
    // Pull raw rows; group in JS so we can compute "block domain" vs "block email" cleanly
    const r = await pool.query(
        `SELECT id, mailbox_email, gmail_thread_id, subject, customer_email,
                customer_domain, last_msg_at, message_count, junk_reason
           FROM email_archive_threads
           ${where}
           ORDER BY last_msg_at DESC NULLS LAST
           LIMIT ${limitParam}`,
        params
    );
    const groups = new Map();
    for (const t of r.rows) {
        const email = (t.customer_email || '').toLowerCase();
        const domain = email.includes('@') ? email.split('@')[1] : '';
        // Group key: domain for known bulk/marketing TLDs, otherwise full email
        // (so info@zzpromos.com / info@gettent.com group together as their domain;
        //  but bob@gmail.com / sue@gmail.com stay separate because gmail is shared)
        const FREE_MAIL = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com','live.com','me.com','msn.com','ymail.com']);
        const groupBy = FREE_MAIL.has(domain) ? email : (domain || email);
        if (!groups.has(groupBy)) {
            groups.set(groupBy, {
                key: groupBy,
                kind: FREE_MAIL.has(domain) ? 'email' : 'domain',
                domain,
                sample_email: email,
                threads: [],
            });
        }
        groups.get(groupBy).threads.push(t);
    }
    return Array.from(groups.values())
        .map(g => ({ ...g, count: g.threads.length, latest: g.threads[0]?.last_msg_at }))
        .sort((a, b) => b.count - a.count);
}

// ---------- Manual per-thread mark / unmark ----------

async function markThread(threadId, { status, reason }) {
    if (status && !['blocked', 'possible_spam'].includes(status)) {
        throw new Error(`Invalid status "${status}"`);
    }
    await pool.query(
        `UPDATE email_archive_threads
            SET junk_status = $2,
                junk_reason = $3,
                junk_marked_at = NOW(),
                junk_marked_by = 'manual'
          WHERE id = $1`,
        [threadId, status, reason || null]
    );
}

async function clearThread(threadId) {
    await pool.query(
        `UPDATE email_archive_threads
            SET junk_status = NULL,
                junk_reason = NULL,
                junk_marked_at = NOW(),
                junk_marked_by = 'manual:clear'
          WHERE id = $1`,
        [threadId]
    );
}

// ---------- Bulk scan ----------
//
// Walks every thread (optionally constrained to a mailbox) and:
//  - Tags as 'blocked' anything whose customer_email matches the blocklist
//  - Tags as 'possible_spam' anything whose first inbound message matches a heuristic
//  - Clears tags that no longer apply (so the user can fix mistakes)
//
// Returns counts. Designed to be safely re-runnable.

async function runBulkScan({ mailboxEmail = null, startedByUserId = null } = {}) {
    const runIns = await pool.query(
        `INSERT INTO email_archive_junk_scan_runs (mailbox_email, started_by_user_id)
         VALUES ($1, $2) RETURNING id`,
        [mailboxEmail, startedByUserId]
    );
    const runId = runIns.rows[0].id;

    const counts = { threads_scanned: 0, threads_blocked: 0, threads_possible_spam: 0, threads_cleared: 0 };

    try {
        const blocklist = await listBlocklist({ mailboxEmail });

        // Stream threads in pages so we don't blow up memory on big archives.
        const PAGE = 500;
        let lastId = null;
        // For each thread we read the FIRST inbound message (cheaper than all messages)
        // to run heuristics. Blocklist match only needs customer_email which is on the
        // thread row.
        while (true) {
            const params = mailboxEmail ? [mailboxEmail] : [];
            const idCondition = lastId ? ` AND id > $${params.length + 1}` : '';
            if (lastId) params.push(lastId);
            params.push(PAGE);
            const sql = `
                SELECT id, mailbox_email, customer_email, junk_status, junk_marked_by, subject
                  FROM email_archive_threads
                 WHERE 1=1
                   ${mailboxEmail ? 'AND mailbox_email = $1' : ''}
                   ${idCondition}
                 ORDER BY id
                 LIMIT $${params.length}`;
            const r = await pool.query(sql, params);
            if (!r.rows.length) break;

            for (const t of r.rows) {
                counts.threads_scanned++;
                lastId = t.id;

                // BLOCKLIST first — wins over heuristic
                const block = matchBlocklist(t.customer_email, blocklist);
                if (block) {
                    if (t.junk_status !== 'blocked' || t.junk_marked_by !== `blocklist:${block.id}`) {
                        await pool.query(
                            `UPDATE email_archive_threads
                                SET junk_status='blocked',
                                    junk_reason=$2,
                                    junk_marked_at=NOW(),
                                    junk_marked_by=$3
                              WHERE id=$1`,
                            [t.id, `blocklist match: ${block.pattern_kind}=${block.pattern}`, `blocklist:${block.id}`]
                        );
                        counts.threads_blocked++;
                    }
                    continue;
                }

                // If previously tagged by blocklist but blocklist no longer matches → clear
                if (t.junk_status === 'blocked' && (t.junk_marked_by || '').startsWith('blocklist:')) {
                    await pool.query(
                        `UPDATE email_archive_threads
                            SET junk_status=NULL, junk_reason=NULL,
                                junk_marked_at=NOW(), junk_marked_by='blocklist:cleared'
                          WHERE id=$1`,
                        [t.id]
                    );
                    counts.threads_cleared++;
                }

                // Skip heuristics on threads the user manually marked
                if (t.junk_status && (t.junk_marked_by || '').startsWith('manual')) continue;

                // HEURISTIC — load first inbound message and run rules
                const m = await pool.query(
                    `SELECT from_email, from_name, subject, body_text_clean, snippet
                       FROM email_archive_messages
                      WHERE thread_id = $1 AND direction = 'inbound'
                      ORDER BY sent_at ASC LIMIT 1`,
                    [t.id]
                );
                if (!m.rows.length) continue;

                const reason = classifyMessageHeuristic(m.rows[0]);

                if (reason) {
                    if (t.junk_status !== 'possible_spam'
                        || (t.junk_marked_by || '') !== `heuristic`) {
                        await pool.query(
                            `UPDATE email_archive_threads
                                SET junk_status='possible_spam',
                                    junk_reason=$2,
                                    junk_marked_at=NOW(),
                                    junk_marked_by='heuristic'
                              WHERE id=$1`,
                            [t.id, reason]
                        );
                        counts.threads_possible_spam++;
                    }
                } else if (t.junk_status === 'possible_spam'
                    && (t.junk_marked_by || '') === 'heuristic') {
                    // Was possible_spam by heuristic, no longer matches → clear
                    await pool.query(
                        `UPDATE email_archive_threads
                            SET junk_status=NULL, junk_reason=NULL,
                                junk_marked_at=NOW(), junk_marked_by='heuristic:cleared'
                          WHERE id=$1`,
                        [t.id]
                    );
                    counts.threads_cleared++;
                }
            }

            if (r.rows.length < PAGE) break;
        }

        // Update blocklist match counts
        for (const b of blocklist) {
            const cnt = await pool.query(
                `SELECT COUNT(*)::int AS c FROM email_archive_threads
                  WHERE junk_marked_by = $1`,
                [`blocklist:${b.id}`]
            );
            await pool.query(
                `UPDATE email_archive_blocklist
                    SET threads_matched = $2, last_scan_at = NOW()
                  WHERE id = $1`,
                [b.id, cnt.rows[0].c]
            );
        }

        await pool.query(
            `UPDATE email_archive_junk_scan_runs
                SET status='done', completed_at=NOW(),
                    threads_scanned=$2, threads_blocked=$3,
                    threads_possible_spam=$4, threads_cleared=$5
              WHERE id=$1`,
            [runId, counts.threads_scanned, counts.threads_blocked, counts.threads_possible_spam, counts.threads_cleared]
        );

        return { run_id: runId, ...counts };
    } catch (err) {
        await pool.query(
            `UPDATE email_archive_junk_scan_runs
                SET status='failed', completed_at=NOW(), last_error=$2
              WHERE id=$1`,
            [runId, err.message]
        ).catch(() => {});
        throw err;
    }
}

// ---------- Stats for the UI ----------

async function getStats({ mailboxEmail = null } = {}) {
    const where = mailboxEmail ? `WHERE mailbox_email = $1` : '';
    const params = mailboxEmail ? [mailboxEmail] : [];
    const r = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE junk_status IS NULL)::int          AS clean_threads,
            COUNT(*) FILTER (WHERE junk_status = 'blocked')::int      AS blocked_threads,
            COUNT(*) FILTER (WHERE junk_status = 'possible_spam')::int AS possible_spam_threads,
            COUNT(*)::int                                             AS total_threads
           FROM email_archive_threads
           ${where}`,
        params
    );
    const lastRun = await pool.query(
        `SELECT * FROM email_archive_junk_scan_runs ORDER BY started_at DESC LIMIT 1`
    );
    return { ...r.rows[0], last_run: lastRun.rows[0] || null };
}

async function listPossibleSpam({ mailboxEmail = null, limit = 100 } = {}) {
    const where = mailboxEmail
        ? `WHERE junk_status = 'possible_spam' AND mailbox_email = $1`
        : `WHERE junk_status = 'possible_spam'`;
    const params = mailboxEmail ? [mailboxEmail, limit] : [limit];
    const limitParam = mailboxEmail ? '$2' : '$1';
    const r = await pool.query(
        `SELECT id, mailbox_email, gmail_thread_id, subject, customer_email,
                customer_domain, last_msg_at, message_count, junk_reason, junk_marked_at
           FROM email_archive_threads
           ${where}
           ORDER BY last_msg_at DESC NULLS LAST
           LIMIT ${limitParam}`,
        params
    );
    return r.rows;
}

module.exports = {
    listBlocklist,
    addBlocklistEntry,
    applyBlocklistEntry,
    removeBlocklistEntry,
    markThread,
    clearThread,
    runBulkScan,
    getStats,
    listPossibleSpam,
    listPossibleSpamGrouped,
    // Exposed for re-use in real-time ingest path
    classifyMessageHeuristic,
    matchBlocklist,
    normalizePattern,
};
