const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+18449480242';

function getTwilioClient() {
  if (!TWILIO_AUTH_TOKEN) throw new Error('TWILIO_AUTH_TOKEN not configured');
  const twilio = require('twilio');
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Store conversation context in memory (keyed by phone number)
const conversationContext = new Map();
const CONTEXT_TTL = 30 * 60 * 1000; // 30 minutes

function getContext(phone) {
  const ctx = conversationContext.get(phone);
  if (ctx && Date.now() - ctx.lastActive < CONTEXT_TTL) {
    ctx.lastActive = Date.now();
    return ctx;
  }
  const newCtx = { messages: [], lastActive: Date.now(), handedOff: false, conversationId: null };
  conversationContext.set(phone, newCtx);
  return newCtx;
}

// POST /api/twilio/webhook — receives incoming SMS and WhatsApp messages
router.post('/webhook', async (req, res) => {
  try {
    const { Body, From, To, NumMedia, MessageSid, ProfileName } = req.body;
    const isWhatsApp = (From || '').startsWith('whatsapp:');
    const customerPhone = (From || '').replace('whatsapp:', '');
    const customerName = ProfileName || customerPhone;
    const message = (Body || '').trim();

    console.log(`Twilio ${isWhatsApp ? 'WhatsApp' : 'SMS'} from ${customerPhone}: ${message}`);

    if (!message) {
      return sendTwilioReply(res, 'Hi! I\'m the WS Display product assistant. Ask me about any of our trade show displays, banner stands, table throws, flags, or other products. How can I help?');
    }

    // Get conversation context
    const ctx = getContext(customerPhone);
    ctx.messages.push({ role: 'customer', text: message, time: Date.now() });

    // Check if handed off to a rep
    if (ctx.handedOff) {
      // Save message to the conversation in the app for the rep to see
      if (ctx.conversationId) {
        await saveMessageToConversation(ctx.conversationId, customerPhone, customerName, message, 'inbound', isWhatsApp);
        notifyReps(req, ctx.conversationId, customerName, message);
      }
      return sendTwilioReply(res, '');  // Empty — rep will reply through the app
    }

    // Check for handoff triggers
    const wantsHuman = /speak.*(person|human|agent|rep|someone)|talk.*(person|human|agent|rep|someone)|transfer|connect me|real person|live agent|help me/i.test(message);
    if (wantsHuman) {
      ctx.handedOff = true;
      // Create/update conversation in the app
      ctx.conversationId = await createSmsConversation(customerPhone, customerName, ctx, isWhatsApp);
      notifyReps(req, ctx.conversationId, customerName, 'Customer requested to speak with a team member');
      return sendTwilioReply(res, 'Let me connect you with a team member. Someone will reply shortly — you\'ll receive their response right here via text.');
    }

    // AI response — search products and answer
    const aiReply = await generateAiTextReply(message, ctx);
    ctx.messages.push({ role: 'ai', text: aiReply, time: Date.now() });

    // Save to conversation in the app (create if first message)
    if (!ctx.conversationId) {
      ctx.conversationId = await createSmsConversation(customerPhone, customerName, ctx, isWhatsApp);
    } else {
      await saveMessageToConversation(ctx.conversationId, customerPhone, customerName, message, 'inbound', isWhatsApp);
    }
    await saveMessageToConversation(ctx.conversationId, TWILIO_PHONE_NUMBER, 'WS Display AI', aiReply, 'outbound', isWhatsApp);

    return sendTwilioReply(res, aiReply);
  } catch (err) {
    console.error('Twilio webhook error:', err);
    return sendTwilioReply(res, 'Sorry, I\'m having trouble right now. Please try again or call us at 800-640-9544.');
  }
});

// POST /api/twilio/send — send a message from the app (rep reply)
router.post('/send', async (req, res) => {
  try {
    const { to, body, conversationId, isWhatsApp } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });

    const client = getTwilioClient();
    const toNumber = isWhatsApp ? `whatsapp:${to}` : to;
    const fromNumber = isWhatsApp ? `whatsapp:${TWILIO_PHONE_NUMBER}` : TWILIO_PHONE_NUMBER;

    const msg = await client.messages.create({
      body: body,
      from: fromNumber,
      to: toNumber
    });

    // Mark as no longer handed off if rep replied
    const ctx = getContext(to);
    ctx.handedOff = false;

    // Save outbound message to conversation
    if (conversationId) {
      await saveMessageToConversation(conversationId, TWILIO_PHONE_NUMBER, 'Rep', body, 'outbound', isWhatsApp);
    }

    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    console.error('Twilio send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate AI reply for text messages
async function generateAiTextReply(message, ctx) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.3, maxOutputTokens: 1000 }
    });

    // Search wsdisplay.com for products
    let productContext = '';
    try {
      const searchTerms = message.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
      if (searchTerms.length > 2) {
        const apiUrl = `https://www.wsdisplay.com/api/cacheable/items?c=1030411&country=US&currency=USD&custitem_f3_hide_item=F&fieldset=search&include=facets&language=en&limit=5&n=2&offset=0&pricelevel=5&q=${encodeURIComponent(searchTerms)}&use_pcv=F`;
        const resp = await fetch(apiUrl, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(6000) });
        if (resp.ok) {
          const data = await resp.json();
          const products = (data.items || []).map(item => {
            const price = item.onlinecustomerprice || item.pricelevel1 || null;
            const shipsFrom = [];
            if (item.custitem_avlb_from_ca) shipsFrom.push('CA');
            if (item.custitem_avlb_from_pa) shipsFrom.push('PA');
            const url = item.urlcomponent ? `https://www.wsdisplay.com/${item.urlcomponent}` : '';
            return `- ${item.displayname || ''}: ${price ? '$' + price.toFixed(2) : 'Contact for pricing'} | ${item.class || ''} | Ships: ${shipsFrom.join(', ') || 'N/A'}${url ? ' | ' + url : ''}`;
          }).join('\n');
          if (products) productContext = `\n\nPRODUCTS FOUND ON WSDISPLAY.COM:\n${products}`;
        }
      }
    } catch (e) {
      // Product search failed, continue without
    }

    // Build conversation history
    const history = ctx.messages.slice(-8).map(m =>
      `${m.role === 'customer' ? 'Customer' : 'You'}: ${m.text}`
    ).join('\n');

    const prompt = `You are the WS Display product assistant, responding via ${ctx.messages.length <= 1 ? 'text message' : 'text conversation'}.
WS Display (wsdisplay.com) is a B2B wholesale supplier of trade show displays, banner stands, table throws, flags, tents, SEG frames, and more.

RULES:
1. Keep responses SHORT — this is SMS/text. Max 3-4 sentences unless listing products.
2. When listing products, use a clean format:
   📦 Product Name
   💰 $X,XXX.00
   📐 Dimensions
   🔗 wsdisplay.com/product-url
3. List max 3 products per message. If more exist, say "Want to see more options?"
4. Include product URLs when available so they can click to view.
5. Be friendly, helpful, and concise.
6. If you can't answer, say "Let me connect you with a team member — one moment!"
7. For warranty: 1-Year or Lifetime depending on product. Contact returns@wsdisplay.com
8. For orders: Call 800-640-9544 or visit wsdisplay.com
9. Don't use HTML — plain text only with emojis for formatting.
10. If they seem frustrated or ask a complex question you can't handle, offer to connect them with a rep.
${productContext}

CONVERSATION:
${history}

Reply to the customer's latest message. Plain text only, no HTML.`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('AI text reply error:', err);
    return 'Thanks for your question! Let me connect you with a team member who can help. Someone will reply shortly.';
  }
}

// Create a new SMS/WhatsApp conversation in the app
async function createSmsConversation(phone, name, ctx, isWhatsApp) {
  try {
    const convId = uuidv4();
    const channel = isWhatsApp ? 'whatsapp' : 'sms';
    const subject = `${isWhatsApp ? 'WhatsApp' : 'SMS'}: ${name || phone}`;

    // Use a dedicated "SMS" mailbox or the first active one
    const mbResult = await pool.query("SELECT id FROM mailboxes WHERE is_active = true ORDER BY created_at LIMIT 1");
    const mailboxId = mbResult.rows[0]?.id;
    if (!mailboxId) throw new Error('No active mailbox');

    await pool.query(
      `INSERT INTO conversations (id, mailbox_id, from_email, from_name, subject, status, priority, last_message_at, created_at, is_read)
       VALUES ($1, $2, $3, $4, $5, 'open', 'normal', NOW(), NOW(), false)`,
      [convId, mailboxId, phone, name || phone, subject]
    );

    // Save all context messages
    for (const msg of ctx.messages) {
      const msgId = uuidv4();
      const fromAddr = msg.role === 'customer' ? phone : TWILIO_PHONE_NUMBER;
      const fromName = msg.role === 'customer' ? (name || phone) : 'WS Display AI';
      await pool.query(
        `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_text, body_html, sent_at, is_ai_generated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [msgId, convId, fromAddr, msg.role === 'customer' ? TWILIO_PHONE_NUMBER : phone,
         subject, msg.text, msg.text, new Date(msg.time), msg.role === 'ai']
      );
    }

    return convId;
  } catch (err) {
    console.error('Create SMS conversation error:', err);
    return null;
  }
}

// Save a single message to an existing conversation
async function saveMessageToConversation(convId, from, fromName, body, direction, isWhatsApp) {
  try {
    const msgId = uuidv4();
    await pool.query(
      `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_text, body_html, sent_at, is_ai_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
      [msgId, convId, from, direction === 'inbound' ? TWILIO_PHONE_NUMBER : from,
       `${isWhatsApp ? 'WhatsApp' : 'SMS'}: ${fromName}`, body, body,
       direction === 'outbound' && fromName === 'WS Display AI']
    );
    await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [convId]);
  } catch (err) {
    console.error('Save SMS message error:', err);
  }
}

// Notify reps via Socket.IO when a handoff happens
function notifyReps(req, conversationId, customerName, message) {
  const io = req.app.get('io');
  if (io) {
    io.emit('notification', {
      type: 'sms_handoff',
      title: `📱 ${customerName} needs help`,
      message: message.substring(0, 100),
      conversationId
    });
  }
}

// Send TwiML response
function sendTwilioReply(res, message) {
  res.set('Content-Type', 'text/xml');
  if (!message) {
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`);
  }
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ===== ELEVENLABS POST-CALL WEBHOOK =====
// Receives call transcription data after an ElevenLabs voice agent call ends
// and logs it as a conversation in the inbox
router.post('/elevenlabs-webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[ElevenLabs Webhook] Received:', payload?.type);

    // Only process post_call_transcription events
    if (payload?.type !== 'post_call_transcription') {
      console.log('[ElevenLabs Webhook] Ignoring event type:', payload?.type);
      return res.status(200).json({ ok: true });
    }

    const data = payload.data || {};
    const transcript = data.transcript || [];
    const metadata = data.metadata || {};
    const analysis = data.analysis || {};
    const conversationId = data.conversation_id;
    const agentId = data.agent_id;

    // Extract caller info from metadata
    const callerPhone = metadata.system__caller_id || metadata.caller_id || 'Unknown';
    const calledNumber = metadata.system__called_number || TWILIO_PHONE_NUMBER;
    const callDuration = metadata.system__call_duration_secs || 0;
    const startTime = metadata.start_time || new Date().toISOString();

    // Build readable transcript
    let transcriptText = '';
    let transcriptHtml = '';
    for (const msg of transcript) {
      const speaker = msg.role === 'agent' ? 'Agent' : 'Customer';
      const text = msg.message || msg.text || '';
      transcriptText += `${speaker}: ${text}\n`;
      transcriptHtml += `<p><strong>${speaker}:</strong> ${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    }

    // Format duration
    const mins = Math.floor(callDuration / 60);
    const secs = Math.round(callDuration % 60);
    const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    // Build conversation subject and body
    const callerName = callerPhone.replace(/^\+1/, '').replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3');
    const subject = `📞 Call: ${callerName}`;

    const bodyHtml = `
      <div style="font-family: sans-serif; font-size: 14px; color: #333;">
        <div style="background: #f3f4f6; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;">
          <strong>📞 Phone Call</strong><br/>
          <span style="color:#6b7280;">From:</span> ${callerPhone}<br/>
          <span style="color:#6b7280;">Duration:</span> ${durationStr}<br/>
          <span style="color:#6b7280;">Agent:</span> ElevenLabs Voice AI
        </div>
        <div style="border-left: 3px solid #6366f1; padding-left: 16px;">
          <h4 style="margin:0 0 8px; color:#4f46e5;">Transcript</h4>
          ${transcriptHtml || '<p style="color:#9ca3af;">No transcript available</p>'}
        </div>
        ${analysis.evaluation_criteria_results ? `
        <div style="margin-top: 16px; background: #fefce8; border-radius: 8px; padding: 12px 16px;">
          <strong>📊 Call Analysis</strong><br/>
          <pre style="font-size:12px; white-space:pre-wrap;">${JSON.stringify(analysis, null, 2)}</pre>
        </div>` : ''}
      </div>
    `;

    // Find an active mailbox
    const mbResult = await pool.query("SELECT id FROM mailboxes WHERE is_active = true ORDER BY created_at LIMIT 1");
    const mailboxId = mbResult.rows[0]?.id;
    if (!mailboxId) {
      console.error('[ElevenLabs Webhook] No active mailbox found');
      return res.status(200).json({ ok: true, warning: 'No active mailbox' });
    }

    // Create conversation
    const convId = uuidv4();
    await pool.query(
      `INSERT INTO conversations (id, mailbox_id, from_email, from_name, subject, status, priority, last_message_at, created_at, is_read)
       VALUES ($1, $2, $3, $4, $5, 'open', 'normal', NOW(), NOW(), false)`,
      [convId, mailboxId, callerPhone, callerName, subject]
    );

    // Create message with transcript
    const msgId = uuidv4();
    await pool.query(
      `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_text, body_html, sent_at, is_ai_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
      [msgId, convId, callerPhone, calledNumber, subject, transcriptText, bodyHtml, startTime]
    );

    // Notify reps via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('notification', {
        type: 'phone_call',
        title: `📞 Call from ${callerName}`,
        message: `${durationStr} call - transcript logged`,
        conversationId: convId
      });
      io.emit('conversationUpdate', { action: 'new', conversationId: convId });
    }

    console.log(`[ElevenLabs Webhook] Call logged as conversation ${convId} from ${callerPhone} (${durationStr})`);
    res.status(200).json({ ok: true, conversationId: convId });
  } catch (err) {
    console.error('[ElevenLabs Webhook] Error:', err);
    res.status(200).json({ ok: true, error: err.message }); // Always return 200 so ElevenLabs doesn't retry
  }
});

module.exports = router;
