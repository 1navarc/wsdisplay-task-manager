const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Legacy fallback token for info@modco.com
const LEGACY_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

async function getGmailClient(pool, emailAddress) {
  // Try to get token from DB first
  let refreshToken = null;
  if (pool) {
    try {
      const result = await pool.query(
        'SELECT refresh_token FROM mailboxes WHERE email = $1 AND is_active = true',
        [emailAddress]
      );
      if (result.rows.length > 0 && result.rows[0].refresh_token) {
        refreshToken = result.rows[0].refresh_token;
      }
    } catch (err) {
      console.error(`Error getting token for ${emailAddress}:`, err.message);
    }
  }

  // Fallback to legacy token for info@modco.com
  if (!refreshToken && emailAddress === 'info@modco.com') {
    refreshToken = LEGACY_REFRESH_TOKEN;
  }

  if (!refreshToken) {
    throw new Error(`No refresh token found for ${emailAddress}. Please connect this mailbox via OAuth.`);
  }

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Round-robin auto-assignment: picks the agent with the fewest open assigned conversations
async function autoAssign(pool, convId) {
  try {
    const agents = await pool.query(
      `SELECT u.id, u.name, COUNT(c.id) AS open_count
       FROM users u
       LEFT JOIN conversations c ON c.assignee_id = u.id AND c.status = 'open'
       WHERE u.role IN ('agent', 'admin')
       GROUP BY u.id, u.name
       ORDER BY open_count ASC, u.name ASC
       LIMIT 1`
    );
    if (agents.rows.length > 0) {
      await pool.query('UPDATE conversations SET assignee_id = $1 WHERE id = $2', [agents.rows[0].id, convId]);
      console.log(`Auto-assigned conversation to ${agents.rows[0].name}`);
    }
  } catch (err) {
    console.error('Auto-assign error:', err.message);
  }
}

async function syncMailbox(pool, mailboxId, emailAddress) {
  console.log(`Syncing mailbox: ${emailAddress}`);
  const gmail = await getGmailClient(pool, emailAddress);

  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 50,
    q: 'in:inbox OR in:sent'
  });

  const messages = response.data.messages || [];
  let synced = 0;

  for (const msg of messages) {
    try {
      const exists = await pool.query(
        `SELECT m.id FROM messages m
         JOIN conversations c ON m.conversation_id = c.id
         WHERE m.gmail_message_id = $1 AND c.mailbox_id = $2`,
        [msg.id, mailboxId]
      );
      if (exists.rows.length > 0) continue;

      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const headers = full.data.payload.headers;
      const getHeader = (name) => {
        const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };

      const subject = getHeader('Subject');
      const from = getHeader('From');
      const to = getHeader('To');
      const date = getHeader('Date');
      const threadId = full.data.threadId;

      // Extract body - check payload.body directly first, then recurse into parts
      let bodyText = '';
      let bodyHtml = '';
      const payload = full.data.payload;
      // Some messages (especially sent) have body directly on payload
      if (payload.body && payload.body.data) {
        const decoded = Buffer.from(payload.body.data, 'base64').toString();
        if (payload.mimeType === 'text/html') bodyHtml = decoded;
        else bodyText = decoded;
      }
      // Recurse into parts for multipart messages
      const extractBody = (part) => {
        if (!part) return;
        if (part.mimeType === 'text/plain' && part.body && part.body.data && !bodyText) {
          bodyText = Buffer.from(part.body.data, 'base64').toString();
        }
        if (part.mimeType === 'text/html' && part.body && part.body.data && !bodyHtml) {
          bodyHtml = Buffer.from(part.body.data, 'base64').toString();
        }
        if (part.parts) part.parts.forEach(extractBody);
      };
      if (payload.parts) payload.parts.forEach(extractBody);
      // Fallback: if we have snippet but no body
      if (!bodyText && !bodyHtml && full.data.snippet) {
        bodyText = full.data.snippet;
      }

      // Find or create conversation (use advisory lock to prevent duplicates)
      let convResult = await pool.query(
        'SELECT id FROM conversations WHERE gmail_thread_id = $1 AND mailbox_id = $2',
        [threadId, mailboxId]
      );

      let convId;
      let isNew = false;
      if (convResult.rows.length === 0) {
        const { v4: uuidv4 } = require('uuid');
        convId = uuidv4();
        const fromName = from.replace(/<.*>/, '').trim() || from;
        const fromEmail = from.match(/<(.+)>/) ? from.match(/<(.+)>/)[1] : from;
        try {
          await pool.query(
            `INSERT INTO conversations (id, mailbox_id, gmail_thread_id, subject, from_email, from_name, status, priority, last_message_at, is_read)
             VALUES ($1, $2, $3, $4, $5, $6, 'open', 'normal', $7, false)`,
            [convId, mailboxId, threadId, subject, fromEmail, fromName, date ? new Date(date) : new Date()]
          );
          isNew = true;
        } catch (dupErr) {
          // Race condition: another sync already created this conversation
          convResult = await pool.query(
            'SELECT id FROM conversations WHERE gmail_thread_id = $1 AND mailbox_id = $2',
            [threadId, mailboxId]
          );
          if (convResult.rows.length > 0) convId = convResult.rows[0].id;
          else throw dupErr;
        }
        if (isNew) {
          // Auto-assign new conversation to agent with fewest open conversations
          await autoAssign(pool, convId);
        }
      } else {
        convId = convResult.rows[0].id;
      }

      // Insert message
      const { v4: uuidv4 } = require('uuid');
      const msgId = uuidv4();
      const fromEmail = from.match(/<(.+)>/) ? from.match(/<(.+)>/)[1] : from;
      await pool.query(
        `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_text, body_html, sent_at, gmail_message_id, gmail_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [msgId, convId, fromEmail, to, subject, bodyText, bodyHtml, date ? new Date(date) : new Date(), msg.id, threadId]
      );

      // Update conversation last_message_at
      await pool.query(
        'UPDATE conversations SET last_message_at = $1 WHERE id = $2',
        [date ? new Date(date) : new Date(), convId]
      );

      // AI processing for inbound messages (fire-and-forget)
      // Only process if:
      //   1) message is from external sender (not our mailbox)
      //   2) not an auto-responder (check email headers)
      //   3) we haven't auto-replied OR generated a draft for this conversation recently (24h window)
      //   4) the latest message in the conversation is from the customer (not from us)
      //   5) conversation hasn't had too many AI replies (loop cap)
      if (fromEmail !== emailAddress) {
        try {
          // Check for auto-responder / out-of-office / mailing list headers
          const autoSubmitted = getHeader('Auto-Submitted');
          const xAutoResponse = getHeader('X-Auto-Response-Suppress');
          const xAutoreply = getHeader('X-Autoreply');
          const xAutoGenerated = getHeader('X-Auto-Generated');
          const precedence = getHeader('Precedence');
          const returnPath = getHeader('Return-Path');

          const isAutoResponse = (
            (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') ||
            xAutoResponse ||
            xAutoreply ||
            xAutoGenerated ||
            ['bulk', 'junk', 'list'].includes((precedence || '').toLowerCase()) ||
            returnPath === '<>' || returnPath === ''
          );

          if (isAutoResponse) {
            console.log(`Skipping AI for conversation ${convId} — auto-responder detected (Auto-Submitted: ${autoSubmitted}, Precedence: ${precedence})`);
          } else {
            // GLOBAL per-email rate limit: max 10 auto-sends to any single email address in 24h
            // This catches loops even when each reply creates a new conversation/thread
            // Check both the conversation from_email and the message from_email to be thorough
            const globalEmailLimit = await pool.query(
              `SELECT COUNT(*) AS cnt FROM ai_processing_log apl
               JOIN conversations c ON apl.conversation_id = c.id
               WHERE (c.from_email = $1 OR c.from_email ILIKE $2)
               AND apl.action = 'auto_send'
               AND apl.status = 'success'
               AND apl.created_at > NOW() - INTERVAL '24 hours'`,
              [fromEmail, '%' + fromEmail + '%']
            );
            const globalSendCount = parseInt(globalEmailLimit.rows[0].cnt, 10);

            // Skip if conversation is deleted
            const convStatus = await pool.query('SELECT status FROM conversations WHERE id = $1', [convId]);
            const isDeleted = convStatus.rows.length > 0 && convStatus.rows[0].status === 'deleted';

            // Check if we've already processed this conversation recently (2h window to prevent loops)
            const recentActivity = await pool.query(
              `SELECT id FROM ai_processing_log
               WHERE conversation_id = $1
               AND action IN ('auto_send', 'generate_draft')
               AND status = 'success'
               AND created_at > NOW() - INTERVAL '2 hours'`,
              [convId]
            );

            // Cap total AI auto-sends per conversation to prevent runaway loops
            const totalAutoSends = await pool.query(
              `SELECT COUNT(*) AS cnt FROM ai_processing_log
               WHERE conversation_id = $1
               AND action = 'auto_send'
               AND status = 'success'`,
              [convId]
            );
            const autoSendCount = parseInt(totalAutoSends.rows[0].cnt, 10);

            // Also check if the most recent message in this thread is from US (outbound) — don't reply to our own replies
            const lastMsg = await pool.query(
              `SELECT from_email, is_ai_generated FROM messages
               WHERE conversation_id = $1
               ORDER BY sent_at DESC LIMIT 1`,
              [convId]
            );
            const lastMsgFromUs = lastMsg.rows.length > 0 && lastMsg.rows[0].from_email === emailAddress;
            const lastMsgIsAi = lastMsg.rows.length > 0 && lastMsg.rows[0].is_ai_generated;

            if (isDeleted) {
              console.log(`Skipping AI for conversation ${convId} — conversation is deleted`);
            } else if (globalSendCount >= 10) {
              console.log(`Skipping AI for conversation ${convId} — global rate limit: already sent ${globalSendCount} auto-replies to ${fromEmail} in 24h`);
            } else if (autoSendCount >= 3) {
              console.log(`Skipping AI for conversation ${convId} — loop cap reached (${autoSendCount} auto-sends)`);
            } else if (recentActivity.rows.length > 0) {
              console.log(`Skipping AI for conversation ${convId} — already processed in last 24 hours`);
            } else if (lastMsgFromUs || lastMsgIsAi) {
              console.log(`Skipping AI for conversation ${convId} — last message is from us or AI-generated`);
            } else {
              const { processNewMessage } = require('./ai-service');
              processNewMessage(convId, msgId, null)
                .catch(err => console.error('AI processing error:', err.message));
            }
          }
        } catch (aiErr) {
          // AI service not available, skip silently
        }
      }

      synced++;
    } catch (err) {
      console.error(`Error syncing message ${msg.id}:`, err.message);
    }
  }

  // Update last_synced_at
  try {
    await pool.query('UPDATE mailboxes SET last_synced_at = NOW() WHERE id = $1', [mailboxId]);
  } catch(e) {}

  console.log(`Synced ${synced} new messages for ${emailAddress}`);
  return synced;
}

async function syncAllMailboxes(pool) {
  // Exclude training-only mailboxes from sync
  const result = await pool.query("SELECT id, email FROM mailboxes WHERE is_active = true AND COALESCE(mailbox_type, '') != 'training'");
  let total = 0;

  // Fallback: if no active mailboxes with is_active, try all
  let mailboxes = result.rows;
  if (mailboxes.length === 0) {
    const fallback = await pool.query('SELECT id, email FROM mailboxes');
    mailboxes = fallback.rows;
  }

  for (const mailbox of mailboxes) {
    try {
      const count = await syncMailbox(pool, mailbox.id, mailbox.email);
      total += count;
    } catch (err) {
      console.error(`Error syncing ${mailbox.email}:`, err.message);
    }
  }
  return total;
}

async function sendGmailReply(pool, emailAddress, to, subject, body, threadId) {
  const gmail = await getGmailClient(pool, emailAddress);

  const rawMessage = [
    `From: ${emailAddress}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    body
  ].join('\r\n');

  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const params = {
    userId: 'me',
    requestBody: { raw: encodedMessage }
  };

  if (threadId) params.requestBody.threadId = threadId;

  const result = await gmail.users.messages.send(params);
  return result.data;
}

module.exports = { getGmailClient, syncMailbox, syncAllMailboxes, sendGmailReply, autoAssign };
