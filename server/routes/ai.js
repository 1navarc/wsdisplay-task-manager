const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { pool } = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { processNewMessage, searchKnowledgeBase } = require('../services/ai-service');
const { embedArticle, embedAllArticles, createArticleFromURL, createArticleFromPDF } = require('../services/kb-embedding');

// Manually trigger AI processing for a conversation
router.post('/process/:conversationId', requireAuth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const io = req.app.get('io');

    // Get latest message ID
    const msgResult = await pool.query(
      'SELECT id FROM messages WHERE conversation_id = $1 ORDER BY sent_at DESC LIMIT 1',
      [conversationId]
    );
    const messageId = msgResult.rows[0]?.id || null;

    // Fire and forget
    processNewMessage(conversationId, messageId, io)
      .catch(err => console.error('Manual AI process error:', err.message));

    res.json({ success: true, message: 'AI processing started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get AI-generated drafts for a conversation
router.get('/drafts/:conversationId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, content, subject, ai_sources, ai_category, created_at, status
       FROM shared_drafts
       WHERE conversation_id = $1 AND is_ai_generated = true AND status != 'rejected'
       ORDER BY created_at DESC`,
      [req.params.conversationId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept an AI draft (mark as accepted, ready for user to edit/send)
router.post('/drafts/:id/accept', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE shared_drafts SET status = 'accepted', updated_by = $1, updated_at = NOW()
       WHERE id = $2 AND is_ai_generated = true
       RETURNING id, content, subject`,
      [req.session.userId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject/dismiss an AI draft
router.post('/drafts/:id/reject', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE shared_drafts SET status = 'rejected', updated_by = $1, updated_at = NOW()
       WHERE id = $2 AND is_ai_generated = true
       RETURNING id`,
      [req.session.userId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View AI processing log for a conversation
router.get('/log/:conversationId', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM ai_processing_log WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.conversationId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search knowledge base (for testing/debugging)
router.get('/kb/search', requireAuth, async (req, res) => {
  try {
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });
    const results = await searchKnowledgeBase(q, parseInt(limit) || 5);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search wsdisplay.com product catalog live
router.get('/products/search', requireAuth, async (req, res) => {
  try {
    const { q, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

    const maxResults = parseInt(limit) || 10;
    const apiUrl = `https://www.wsdisplay.com/api/cacheable/items?c=1030411&country=US&currency=USD&custitem_f3_hide_item=F&fieldset=search&include=facets&language=en&limit=${maxResults}&n=2&offset=0&pricelevel=5&q=${encodeURIComponent(q)}&use_pcv=F`;

    const response = await fetch(apiUrl, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    });

    if (!response.ok) throw new Error('Website search failed: ' + response.status);
    const data = await response.json();

    // Transform into clean product cards
    const products = (data.items || []).map(item => {
      const price = item.onlinecustomerprice || item.pricelevel1 || null;
      const imageUrl = item.itemimages_detail?.urls?.[0]?.url || '';
      const productUrl = item.urlcomponent ? `https://www.wsdisplay.com/${item.urlcomponent}` : 'https://www.wsdisplay.com';
      const specSheet = item.custitem_itemtemplate || '';

      // Build shipping info
      const shipsFrom = [];
      if (item.custitem_avlb_from_ca) shipsFrom.push('CA');
      if (item.custitem_avlb_from_pa) shipsFrom.push('PA');
      if (item.custitem_avlb_from_pfc) shipsFrom.push('PFC');

      // Volume pricing
      const priceTiers = item.onlinecustomerprice_detail?.priceschedule || [];

      return {
        id: item.internalid,
        sku: item.itemid,
        name: item.displayname || item.storedisplayname2 || '',
        description: item.storedescription || '',
        category: item.class || '',
        price: price,
        priceFormatted: price ? `$${price.toFixed(2)}` : 'Contact for pricing',
        priceTiers: priceTiers.map(t => ({
          min: t.minimumquantity,
          max: t.maximumquantity,
          price: t.price,
          formatted: t.price_formatted
        })),
        imageUrl,
        productUrl,
        specSheet,
        turnaround: (item.custitem_turn_around_options || '').replace(/&nbsp;/g, '').trim() || '~2 business days',
        shipsFrom: shipsFrom.join(', ') || 'Contact for availability',
        inStock: item.isinstock,
        freeShipping: item.custitem_free_ground_shipping || false
      };
    });

    res.json({ total: data.total || 0, products });
  } catch (err) {
    console.error('Product search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Embed a specific KB article
router.post('/kb/embed/:articleId', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const result = await embedArticle(parseInt(req.params.articleId));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Embed all un-embedded KB articles
router.post('/kb/embed-all', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const results = await embedAllArticles();
    res.json({ success: true, processed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload PDF and create KB article(s)
router.post('/kb/upload-pdf', requireAuth, requireRole('supervisor', 'manager'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { title, category } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const articles = await createArticleFromPDF(req.file.buffer, title, category, req.session.userId);
    res.json({ success: true, articles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scrape URL and create KB article(s)
router.post('/kb/scrape-url', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { url, title, category } = req.body;
    if (!url || !title) return res.status(400).json({ error: 'URL and title are required' });

    const articles = await createArticleFromURL(url, title, category, req.session.userId);
    res.json({ success: true, articles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk import KB articles from JSON (for seeding from scraped data)
router.post('/kb/bulk-import', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { articles } = req.body;
    if (!articles || !Array.isArray(articles)) return res.status(400).json({ error: 'articles array is required' });

    const results = [];
    for (const article of articles) {
      try {
        const result = await pool.query(
          `INSERT INTO knowledge_base_articles (title, content, category, source_type, source_url, is_published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6)
           RETURNING id`,
          [article.title, article.content, article.category || 'general', article.source_type || 'url', article.url || null, req.session.userId]
        );
        results.push({ id: result.rows[0].id, title: article.title, status: 'created' });
      } catch (err) {
        results.push({ title: article.title, status: 'error', error: err.message });
      }
    }

    // Trigger embedding for all new articles (async)
    embedAllArticles().catch(err => console.error('Bulk embed error:', err.message));

    res.json({ success: true, imported: results.filter(r => r.status === 'created').length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AI REVIEW QUEUE =====

// Get AI-sent messages for review (with conversation context)
router.get('/review-queue', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.id, m.conversation_id, m.from_email, m.to_email, m.subject,
             m.body_text, m.body_html, m.sent_at, m.is_ai_generated,
             c.subject as conv_subject, c.from_email as customer_email, c.from_name as customer_name,
             c.ai_category,
             (SELECT COUNT(*) FROM ai_draft_feedback f WHERE f.draft_id::text = m.id::text) as feedback_count
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.is_ai_generated = true
      ORDER BY m.sent_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== FEEDBACK =====

// Submit feedback on an AI draft
router.post('/feedback/:draftId', requireAuth, async (req, res) => {
  try {
    const { helpful, issues, comment, idealResponse, saveAsExample, conversationId } = req.body;
    const result = await pool.query(
      `INSERT INTO ai_draft_feedback (draft_id, conversation_id, user_id, helpful, issues, comment, ideal_response, save_as_example)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.params.draftId, conversationId, req.session.userId, helpful, issues || [], comment, idealResponse, saveAsExample || false]
    );

    // If saveAsExample and idealResponse provided, create a training example
    if (saveAsExample && idealResponse) {
      // Get the original email context from the conversation
      const convResult = await pool.query(
        `SELECT c.subject, m.body_text, m.from_email FROM conversations c
         JOIN messages m ON m.conversation_id = c.id
         WHERE c.id = $1 ORDER BY m.sent_at DESC LIMIT 1`,
        [conversationId]
      );
      const conv = convResult.rows[0];
      await pool.query(
        `INSERT INTO ai_training_rules (rule_type, email_category, content, example_email, example_response, created_by)
         VALUES ('example', 'all', $1, $2, $3, $4)`,
        [
          `Example for: ${conv?.subject || 'email'}`,
          conv ? `From: ${conv.from_email}\nSubject: ${conv.subject}\n${(conv.body_text || '').slice(0, 500)}` : '',
          idealResponse,
          req.session.userId
        ]
      );
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get feedback stats (full dashboard)
router.get('/training/stats', requireAuth, async (req, res) => {
  try {
    // Overall stats
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE helpful = true) as helpful_count,
        COUNT(*) FILTER (WHERE helpful = false) as not_helpful_count,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as this_week,
        COUNT(*) FILTER (WHERE helpful = true AND created_at > NOW() - INTERVAL '7 days') as helpful_this_week,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND helpful = false) as not_helpful_this_week
      FROM ai_draft_feedback
    `);

    // Top issues
    const issues = await pool.query(`
      SELECT unnest(issues) as issue, COUNT(*) as count
      FROM ai_draft_feedback WHERE helpful = false
      GROUP BY issue ORDER BY count DESC
    `);

    // AI emails sent (total + this week)
    const emailStats = await pool.query(`
      SELECT
        COUNT(*) as total_ai_emails,
        COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days') as ai_emails_this_week,
        COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '24 hours') as ai_emails_today
      FROM messages WHERE is_ai_generated = true
    `);

    // Trend: daily stats for last 14 days
    const trend = await pool.query(`
      SELECT
        DATE(created_at) as day,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE helpful = true) as helpful,
        COUNT(*) FILTER (WHERE helpful = false) as not_helpful
      FROM ai_draft_feedback
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at)
      ORDER BY day
    `);

    // Per-category breakdown
    const categoryStats = await pool.query(`
      SELECT
        COALESCE(c.ai_category, 'uncategorized') as category,
        COUNT(DISTINCT m.id) as total_emails,
        COUNT(DISTINCT f.id) as total_feedback,
        COUNT(DISTINCT f.id) FILTER (WHERE f.helpful = true) as helpful,
        COUNT(DISTINCT f.id) FILTER (WHERE f.helpful = false) as not_helpful
      FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN ai_draft_feedback f ON f.conversation_id = m.conversation_id
      WHERE m.is_ai_generated = true
      GROUP BY COALESCE(c.ai_category, 'uncategorized')
      ORDER BY total_emails DESC
    `);

    // Training rules count
    const rulesCount = await pool.query(`
      SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active
      FROM ai_training_rules
    `);

    // KB article count
    const kbCount = await pool.query(`
      SELECT COUNT(*) as total, COUNT(embedding) as embedded
      FROM knowledge_base_articles
    `);

    res.json({
      ...stats.rows[0],
      topIssues: issues.rows,
      emailStats: emailStats.rows[0],
      trend: trend.rows,
      categoryStats: categoryStats.rows,
      rulesCount: rulesCount.rows[0],
      kbCount: kbCount.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== TRAINING RULES =====

// List training rules
router.get('/training/rules', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, u.name as created_by_name FROM ai_training_rules r
       LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.priority DESC, r.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create training rule
router.post('/training/rules', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { ruleType, emailCategory, content, exampleEmail, exampleResponse, priority } = req.body;
    if (!content) return res.status(400).json({ error: 'Content is required' });
    const result = await pool.query(
      `INSERT INTO ai_training_rules (rule_type, email_category, content, example_email, example_response, priority, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [ruleType || 'instruction', emailCategory || 'all', content, exampleEmail, exampleResponse, priority || 0, req.session.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update training rule
router.put('/training/rules/:id', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    const { content, emailCategory, priority, isActive } = req.body;
    const result = await pool.query(
      `UPDATE ai_training_rules SET
        content = COALESCE($1, content),
        email_category = COALESCE($2, email_category),
        priority = COALESCE($3, priority),
        is_active = COALESCE($4, is_active),
        updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [content, emailCategory, priority, isActive, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete training rule
router.delete('/training/rules/:id', requireAuth, requireRole('supervisor', 'manager'), async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_training_rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract training examples from sent Gmail conversations
router.post('/training/extract', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { mailbox_email, max_threads, rep_emails, search_query, page_token } = req.body;
    const email = mailbox_email || 'info@modco.com';
    const limit = Math.min(max_threads || 50, 500);
    const allowedSenders = rep_emails || []; // Only include replies from these senders

    // Get Gmail client using existing OAuth tokens
    const { getGmailClient } = require('../services/gmail-sync');
    const gmail = await getGmailClient(pool, email);

    // Build Gmail search query
    let gmailQuery = search_query || 'in:sent -from:mailer-daemon';
    // If rep emails specified, add from: filter to Gmail query
    if (allowedSenders.length > 0 && !search_query) {
      const fromFilter = allowedSenders.map(e => `from:${e}`).join(' OR ');
      gmailQuery = `in:sent (${fromFilter}) -from:mailer-daemon`;
    }

    console.log(`Training extraction: query="${gmailQuery}", limit=${limit}`);

    // Fetch sent message threads with pagination support
    const listParams = {
      userId: 'me',
      q: gmailQuery,
      maxResults: Math.min(limit, 100) // Gmail API max per page
    };
    if (page_token) listParams.pageToken = page_token;

    const sentList = await gmail.users.messages.list(listParams);

    if (!sentList.data.messages || sentList.data.messages.length === 0) {
      return res.json({ examples: [], message: 'No sent messages found' });
    }

    const pairs = [];
    for (const msgRef of sentList.data.messages.slice(0, limit)) {
      try {
        // Get the full thread for this sent message
        const msg = await gmail.users.messages.get({ userId: 'me', id: msgRef.id, format: 'full' });
        const threadId = msg.data.threadId;
        const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });

        const messages = thread.data.messages || [];
        if (messages.length < 2) continue; // Need at least a customer email + our reply

        // Find customer message (inbound) and our reply (outbound)
        for (let i = 0; i < messages.length - 1; i++) {
          const headers = messages[i].payload?.headers || [];
          const nextHeaders = messages[i + 1].payload?.headers || [];

          const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
          const nextFromHeader = nextHeaders.find(h => h.name.toLowerCase() === 'from')?.value || '';
          const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';

          const isCustomerMsg = !fromHeader.includes(email);
          const isOurReply = nextFromHeader.includes(email);

          // Check if the reply was sent by one of the selected reps
          // Gmail "from" header on shared mailboxes often shows the mailbox email,
          // so also check X-Google-Original-From or Sender headers
          const origFrom = nextHeaders.find(h => h.name.toLowerCase() === 'x-google-original-from')?.value || '';
          const senderHeader = nextHeaders.find(h => h.name.toLowerCase() === 'sender')?.value || '';
          const actualSender = origFrom || senderHeader || nextFromHeader;

          // If rep filter is set, only include replies from selected reps
          const repMatch = allowedSenders.length === 0 || allowedSenders.some(repEmail =>
            actualSender.toLowerCase().includes(repEmail.toLowerCase()) ||
            nextFromHeader.toLowerCase().includes(repEmail.toLowerCase())
          );

          if (isCustomerMsg && isOurReply && repMatch) {
            // Extract body text from both
            const customerBody = extractGmailBody(messages[i]);
            const replyBody = extractGmailBody(messages[i + 1]);

            if (customerBody.length > 10 && replyBody.length > 10) {
              // Extract rep name from the From header
              const repNameMatch = actualSender.match(/^([^<]+)</);
              const repName = repNameMatch ? repNameMatch[1].trim() : actualSender;

              pairs.push({
                subject: subject.replace(/^(Re:\s*)+/i, '').trim(),
                customerEmail: customerBody.slice(0, 500),
                repResponse: replyBody.slice(0, 2000),
                repName: repName,
                repEmail: actualSender,
                date: new Date(parseInt(messages[i + 1].internalDate)).toISOString()
              });
            }
          }
        }
      } catch (threadErr) {
        // Skip individual thread errors
        continue;
      }
    }

    res.json({
      total_threads_scanned: sentList.data.messages?.length || 0,
      examples_found: pairs.length,
      examples: pairs.slice(0, 100), // Cap at 100 per batch
      next_page_token: sentList.data.nextPageToken || null,
      query_used: gmailQuery
    });
  } catch (err) {
    console.error('Training extraction error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Use Gemini to curate extracted examples into training rules
router.post('/training/curate', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { examples } = req.body;
    if (!examples || examples.length === 0) return res.status(400).json({ error: 'No examples provided' });

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    });

    const prompt = `You are analyzing customer service email conversations for WS Display (trade show display wholesale company).

Review these customer email + rep response pairs and extract the BEST ones as training examples.

A good training example:
- Has a clear customer question and a helpful, specific answer
- Shows product knowledge (specs, pricing, turnaround, shipping)
- Demonstrates good tone and professionalism
- Includes specific details rather than generic responses

A BAD example to skip:
- Very short or generic responses ("Thanks, let me check")
- Internal/forwarded emails
- Auto-replies or out-of-office messages
- Responses that just say "I'll get back to you"

For each good example, also extract a category: product_question, shipping, returns, billing, warranty, artwork, order_status, or general.

EMAIL PAIRS TO REVIEW:
${examples.map((e, i) => `\n--- Pair ${i + 1} ---\nSubject: ${e.subject}\nCustomer: ${e.customerEmail}\nRep Response: ${e.repResponse}\n`).join('')}

Return JSON array of good examples:
[{
  "category": "the_category",
  "quality_score": 1-10,
  "customer_email_summary": "brief summary of what they asked",
  "example_email": "the customer's key question (cleaned up, 1-3 sentences)",
  "example_response": "the rep's response (cleaned up, keep product details and specifics)",
  "lesson": "what the AI should learn from this example"
}]

Return ONLY the JSON array. Skip bad examples entirely.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    let curated = [];
    try { curated = JSON.parse(text); } catch { curated = []; }

    res.json({
      total_reviewed: examples.length,
      curated_count: curated.length,
      curated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save curated examples as training rules
router.post('/training/save', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const { examples } = req.body;
    if (!examples || examples.length === 0) return res.status(400).json({ error: 'No examples provided' });

    let saved = 0;
    for (const ex of examples) {
      await pool.query(
        `INSERT INTO ai_training_rules (rule_type, email_category, content, example_email, example_response, is_active, created_by)
         VALUES ('example', $1, $2, $3, $4, true, $5)`,
        [
          ex.category || 'all',
          ex.lesson || 'Training example from sent emails',
          ex.example_email || '',
          ex.example_response || '',
          req.session?.userId || null
        ]
      );
      saved++;
    }

    res.json({ saved, message: `${saved} training examples saved` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List current training rules
router.get('/training/rules', requireAuth, async (req, res) => {
  try {
    const rules = await pool.query(
      'SELECT id, rule_type, email_category, content, example_email, example_response, is_active, created_at FROM ai_training_rules ORDER BY created_at DESC'
    );
    res.json(rules.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a training rule
router.delete('/training/rules/:id', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    await pool.query('DELETE FROM ai_training_rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function extractGmailBody(message) {
  const parts = message.payload?.parts || [];
  let body = '';

  // Try to get text/plain first
  const textPart = parts.find(p => p.mimeType === 'text/plain');
  if (textPart && textPart.body?.data) {
    body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
  } else if (message.payload?.body?.data) {
    body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
  } else {
    // Try HTML part and strip tags
    const htmlPart = parts.find(p => p.mimeType === 'text/html');
    if (htmlPart && htmlPart.body?.data) {
      body = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  // Clean up quoted replies
  body = body.split(/\n\s*On .* wrote:/)[0]; // Remove quoted text
  body = body.split(/\n\s*-{2,}\s*Original/)[0]; // Remove forwarded headers
  return body.trim();
}

// ===== KNOWLEDGE BASE MANAGEMENT =====

// List all KB articles
router.get('/kb/articles', requireAuth, async (req, res) => {
  try {
    const { category, search, limit, offset } = req.query;
    let query = `SELECT id, title, category, source_type, source_url, is_published, created_at,
                        LENGTH(content) AS content_length,
                        CASE WHEN embedding IS NOT NULL THEN true ELSE false END AS has_embedding
                 FROM knowledge_base_articles WHERE 1=1`;
    const params = [];
    if (category) { params.push(category); query += ` AND category = $${params.length}`; }
    if (search) { params.push('%' + search + '%'); query += ` AND (title ILIKE $${params.length} OR content ILIKE $${params.length})`; }
    query += ' ORDER BY created_at DESC';
    query += ` LIMIT ${parseInt(limit) || 50} OFFSET ${parseInt(offset) || 0}`;
    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) AS total FROM knowledge_base_articles WHERE 1=1';
    const countParams = [];
    if (category) { countParams.push(category); countQuery += ` AND category = $${countParams.length}`; }
    if (search) { countParams.push('%' + search + '%'); countQuery += ` AND (title ILIKE $${countParams.length} OR content ILIKE $${countParams.length})`; }
    const countResult = await pool.query(countQuery, countParams);

    res.json({ articles: result.rows, total: parseInt(countResult.rows[0].total) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single KB article content
router.get('/kb/articles/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM knowledge_base_articles WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete KB article
router.delete('/kb/articles/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_base_articles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== UNANSWERED QUESTIONS =====

// Get all unanswered questions (deduplicated by conversation — only latest per conversation)
router.get('/unanswered', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (apl.conversation_id)
              apl.id AS log_id, apl.conversation_id, apl.result, apl.created_at,
              c.subject, c.from_email, c.from_name, c.gmail_thread_id, c.mailbox_id, c.status AS conv_status,
              m.body_text, m.body_html
       FROM ai_processing_log apl
       JOIN conversations c ON apl.conversation_id = c.id
       LEFT JOIN messages m ON apl.message_id = m.id
       WHERE apl.action = 'needs_answer'
       AND apl.status = 'flagged'
       AND COALESCE(c.status, 'open') != 'deleted'
       ORDER BY apl.conversation_id, apl.created_at DESC`
    );
    // Re-sort by created_at descending after dedup
    result.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(result.rows.slice(0, 100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get unanswered count (deduplicated by conversation to match list)
router.get('/unanswered/count', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(DISTINCT apl.conversation_id) AS count FROM ai_processing_log apl
       JOIN conversations c ON apl.conversation_id = c.id
       WHERE apl.action = 'needs_answer' AND apl.status = 'flagged'
       AND COALESCE(c.status, 'open') != 'deleted'`
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit answer for an unanswered question
router.post('/unanswered/:logId/answer', requireAuth, async (req, res) => {
  try {
    const { logId } = req.params;
    const { answer, question } = req.body;
    if (!answer) return res.status(400).json({ error: 'Answer is required' });

    // Get the log entry
    const logEntry = await pool.query(
      `SELECT apl.*, c.subject, c.from_email, c.gmail_thread_id, c.mailbox_id
       FROM ai_processing_log apl
       JOIN conversations c ON apl.conversation_id = c.id
       WHERE apl.id = $1`,
      [logId]
    );
    if (logEntry.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const entry = logEntry.rows[0];

    // 1. Save to knowledge base
    const kbTitle = question || entry.subject || 'Customer Question';
    const kbResult = await pool.query(
      `INSERT INTO knowledge_base_articles (title, content, category, source_type, is_published, created_by)
       VALUES ($1, $2, 'customer_qa', 'manual', true, $3)
       RETURNING id`,
      [kbTitle, answer, req.user.id]
    );

    // 2. Generate embedding for the new KB article
    try {
      await embedArticle(kbResult.rows[0].id);
    } catch (e) { console.error('Embed error:', e.message); }

    // 3. Send auto-reply to customer
    const { sendGmailReply } = require('../services/gmail-sync');
    const mbResult = await pool.query('SELECT email FROM mailboxes WHERE id = $1', [entry.mailbox_id]);
    const mailboxEmail = mbResult.rows[0]?.email;

    if (mailboxEmail) {
      // Use AI to compose a proper email using the answer
      const { generateDraftReply } = require('../services/ai-service');
      const customerQuestion = question || entry.result?.question || entry.subject;
      const composedReply = await generateDraftReply(
        {
          subject: entry.subject,
          fromEmail: entry.from_email,
          fromName: entry.result?.from_name || entry.from_email,
          latestMessage: customerQuestion,
          conversationHistory: ''
        },
        [{ title: 'Answer from team', content: answer, similarity: 1.0 }],
        entry.result?.category || 'general'
      );
      const htmlBody = composedReply.draft;

      await sendGmailReply(pool, mailboxEmail, entry.from_email, `Re: ${entry.subject}`, htmlBody, entry.gmail_thread_id);

      // Insert message record
      const { v4: uuidv4 } = require('uuid');
      await pool.query(
        `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_html, body_text, direction, sent_at, gmail_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'outbound', NOW(), $8)`,
        [uuidv4(), entry.conversation_id, mailboxEmail, entry.from_email, `Re: ${entry.subject}`, htmlBody, answer, entry.gmail_thread_id]
      );
    }

    // 4. Mark as answered
    await pool.query(
      `UPDATE ai_processing_log SET status = 'answered', result = result || $2::jsonb WHERE id = $1`,
      [logId, JSON.stringify({ answered_by: req.user.id, answered_at: new Date().toISOString(), kb_article_id: kbResult.rows[0].id })]
    );

    res.json({ success: true, kb_article_id: kbResult.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss an unanswered question
router.post('/unanswered/:logId/dismiss', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE ai_processing_log SET status = 'dismissed' WHERE id = $1`,
      [req.params.logId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== TRAINING INGESTION (mailbox -> knowledge base) =====
const trainingIngest = require('../services/training-ingestion');

// Get / save filter config
router.get('/ingestion/config', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const config = await trainingIngest.getFilterConfig();
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/ingestion/config', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const saved = await trainingIngest.saveFilterConfig(req.body || {});
    res.json(saved);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start a run. Body can override filters for this run only (not saved).
router.post('/ingestion/runs', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const runId = await trainingIngest.startRun({
      startedByUserId: req.session.userId,
      filterOverrides: req.body && req.body.filterOverrides ? req.body.filterOverrides : null,
    });
    res.json({ run_id: runId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List recent runs
router.get('/ingestion/runs', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const rows = await trainingIngest.listRuns(parseInt(req.query.limit) || 20);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get one run's status (polled by UI)
router.get('/ingestion/runs/:id/status', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const row = await trainingIngest.getRunStatus(req.params.id);
    if (!row) return res.status(404).json({ error: 'Run not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get the per-thread log for a run
router.get('/ingestion/runs/:id/log', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const rows = await trainingIngest.getRunLog(req.params.id, parseInt(req.query.limit) || 500);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cancel a running run
router.post('/ingestion/runs/:id/cancel', requireAuth, requireRole('manager'), async (req, res) => {
  try {
    const was = trainingIngest.requestCancel(req.params.id);
    await pool.query(
      `UPDATE training_ingestion_runs SET cancel_requested = true WHERE id = $1`,
      [req.params.id]
    );
    res.json({ cancel_requested: true, was_in_memory: was });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
