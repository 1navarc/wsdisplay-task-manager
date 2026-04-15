const { GoogleGenerativeAI } = require('@google/generative-ai');
const { pool } = require('../config/database');

let genAI = null;

function getGenAI() {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY environment variable not set');
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

// Register pgvector type with pg driver (call once at startup)
async function initVectorSupport() {
  try {
    const client = await pool.connect();
    try {
      const pgvector = require('pgvector/pg');
      await pgvector.registerTypes(client);
      console.log('pgvector types registered');
    } finally {
      client.release();
    }
  } catch (err) {
    // Non-fatal: vectors can be passed as JSON strings '[0.1, 0.2, ...]'
    console.log('pgvector type registration skipped (will use JSON strings):', err.message);
  }
}

// Generate embedding for text using Gemini gemini-embedding-001
async function embedText(text) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({ model: 'gemini-embedding-001' });
  const result = await model.embedContent(text.slice(0, 10000));
  return result.embedding.values;
}

// Classify an email into categories
async function classifyEmail(subject, bodyText) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  });

  const prompt = `Classify this customer email into exactly ONE category.

Categories:
- order_status: Questions about order status, tracking, delivery dates, where's my order
- shipping: Shipping methods, rates, international shipping, address changes
- returns: Return requests, exchanges, refund status, damaged items
- billing: Invoice questions, payment issues, credit memos, pricing disputes
- product_question: Product specs, availability, compatibility, recommendations
- complaint: Complaints, negative experiences, escalation requests
- general: General inquiries, account questions, anything that doesn't fit above

Email Subject: ${subject || '(no subject)'}
Email Body: ${(bodyText || '').slice(0, 4000)}

Return JSON: { "category": "one_of_the_above", "confidence": 0.0_to_1.0, "reasoning": "brief explanation" }`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { category: 'general', confidence: 0.3, reasoning: 'Failed to parse AI response' };
  }
}

// Search knowledge base by semantic similarity
async function searchKnowledgeBase(queryText, limit = 5) {
  // Hybrid search: vector similarity + keyword text search
  const embedding = await embedText(queryText);

  // Vector search
  const vectorResult = await pool.query(
    `SELECT DISTINCT ON (title) id, title, content, category, source_type,
            1 - (embedding <=> $1::vector) AS similarity
     FROM knowledge_base_articles
     WHERE is_published = true AND embedding IS NOT NULL
     ORDER BY title, embedding <=> $1::vector
     LIMIT 80`,
    [JSON.stringify(embedding)]
  );

  // Keyword/phrase search — find articles that contain key phrases from the query
  // Extract 2-3 word phrases and important single words
  const queryLower = queryText.toLowerCase();
  const phrases = [];
  // Common product phrases to search for
  const productPhrases = [
    'table throw', 'table runner', 'banner stand', 'retractable banner', 'roll up banner',
    'pop up', 'popup', 'light box', 'lightbox', 'fabric display', 'canopy tent',
    'outdoor banner', 'indoor banner', 'hanging banner', 'skybox', 'trade show booth',
    'ez tube', 'ez extend', 'silver step', 'silverstep', 'econo roll', 'falcon flag',
    'one choice', 'stretch table', 'fitted table', 'backlit table', 'round table throw',
    'literature stand', 'snap frame', 'display stand', 'lumiere', 'origami truss',
    'showbird', 'modco', 'qseg', 'sego', 'mammoth', 'tahoe', 'wallbox', 'cabo'
  ];
  for (const phrase of productPhrases) {
    if (queryLower.includes(phrase)) phrases.push(phrase);
  }

  let keywordResults = [];
  if (phrases.length > 0) {
    const phrasePattern = phrases.join('|');
    // Use vector similarity for keyword-matched articles too (instead of hardcoded 0.85)
    const kwResult = await pool.query(
      `SELECT DISTINCT ON (title) id, title, content, category, source_type,
              CASE WHEN embedding IS NOT NULL THEN 1 - (embedding <=> $2::vector) ELSE 0.5 END AS similarity
       FROM knowledge_base_articles
       WHERE is_published = true AND (
         LOWER(title) ~ $1
       )
       ORDER BY title
       LIMIT 20`,
      [phrasePattern, JSON.stringify(embedding)]
    );
    keywordResults = kwResult.rows;
  }

  // Merge: vector results + keyword results (dedup by id)
  const seenIds = new Set();
  const allResults = [];
  for (const r of vectorResult.rows) {
    if (!seenIds.has(r.id)) { allResults.push(r); seenIds.add(r.id); }
  }
  for (const r of keywordResults) {
    if (!seenIds.has(r.id)) { allResults.push(r); seenIds.add(r.id); }
  }

  // Sort by similarity desc
  allResults.sort((a, b) => b.similarity - a.similarity);

  // Extract brand prefix from title for dedup
  function getBrand(title) {
    const parts = title.split(' - ');
    return parts[0].replace(/ \(Part \d+\)/, '').trim();
  }

  // Pick diverse results: max 2 CSV articles per brand, max 3 spec sheets
  const brandCounts = {};
  const diverse = [];
  for (const r of allResults) {
    if (r.similarity < 0.55) break; // Skip results below 55% similarity
    const brand = getBrand(r.title);
    const count = brandCounts[brand] || 0;
    const maxPerBrand = r.source_type === 'csv' ? 2 : 3;
    if (count < maxPerBrand) {
      diverse.push(r);
      brandCounts[brand] = count + 1;
      if (diverse.length >= limit) break;
    }
  }

  return diverse;
}

// Load training rules and examples from database
async function loadTrainingContext(category) {
  try {
    const rules = await pool.query(
      `SELECT rule_type, content, example_email, example_response FROM ai_training_rules
       WHERE is_active = true AND (email_category = $1 OR email_category = 'all')
       ORDER BY priority DESC, created_at DESC`,
      [category || 'all']
    );

    let context = '';
    const instructions = rules.rows.filter(r => r.rule_type === 'instruction');
    const examples = rules.rows.filter(r => r.rule_type === 'example');

    if (instructions.length > 0) {
      context += '\n\nCUSTOM RULES FROM YOUR TEAM (MUST FOLLOW):\n';
      instructions.forEach((r, i) => { context += `${i + 1}. ${r.content}\n`; });
    }

    if (examples.length > 0) {
      context += '\n\nEXAMPLE GOOD RESPONSES (match this style and detail level):\n';
      examples.forEach((r, i) => {
        context += `\nExample ${i + 1}:\n`;
        if (r.example_email) context += `Customer email: ${r.example_email.slice(0, 300)}\n`;
        if (r.example_response) context += `Ideal response:\n${r.example_response.slice(0, 1500)}\n`;
      });
    }

    return context;
  } catch (err) {
    console.error('Failed to load training rules:', err.message);
    return '';
  }
}

// Generate a draft reply using conversation context and KB articles
async function generateDraftReply(conversationContext, kbArticles, category) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
  });

  // Load training rules and examples
  const trainingContext = await loadTrainingContext(category);

  let kbContext = '';
  if (kbArticles && kbArticles.length > 0) {
    kbContext = '\n\nPRODUCT & KNOWLEDGE BASE DATA — USE THIS IN YOUR RESPONSE:\n' +
      kbArticles.map((a, i) => `[${i + 1}] ${a.title}:\n${a.content}`).join('\n\n');
  }

  // Map brands/products to their website URLs
  const productUrls = {
    'silverstep': 'https://www.wsdisplay.com/Retractable-Banner-Stands/silverstep-retractable-banner-stand',
    'econo roll': 'https://www.wsdisplay.com/Retractable-Banner-Stands/econo-roll-retractable-banner-stand',
    'silverwing': 'https://www.wsdisplay.com/Retractable-Banner-Stands/silverwing-retractable-banner-stand',
    'steppy': 'https://www.wsdisplay.com/Retractable-Banner-Stands/steppy-retractable-banner-stand',
    'cinch': 'https://www.wsdisplay.com/Retractable-Banner-Stands/cinch-retractable-banner-stand',
    'doublestep': 'https://www.wsdisplay.com/Retractable-Banner-Stands/doublestep-24in-and-36in',
    'maui': 'https://www.wsdisplay.com/Retractable-Banner-Stands/maui-retractable-banner-stand',
    'retractable banner': 'https://www.wsdisplay.com/Retractable-Banner-Stands',
    'roll up banner': 'https://www.wsdisplay.com/Retractable-Banner-Stands',
    'banner stand': 'https://www.wsdisplay.com/Retractable-Banner-Stands',
    'aspen': 'https://www.wsdisplay.com/resort-collection/aspen-fabric-frames',
    'vail': 'https://www.wsdisplay.com/resort-collection/vail-fabric-frames',
    'big sky': 'https://www.wsdisplay.com/resort-collection/big-sky-frame-display',
    'modco': 'https://www.wsdisplay.com/resort-collection/modco-modular-displays',
    'sego': 'https://www.wsdisplay.com/Fabric-Light-Box/SEGO',
    'showbird': 'https://www.wsdisplay.com/Fabric-Light-Box/showbird-modular-lightbox',
    'qseg': 'https://www.wsdisplay.com/QSEG-Quick-Wall-Displays',
    'qseg connectors': 'https://www.wsdisplay.com/QSEG-Quick-Wall-Displays/QSEG-Connectors',
    'qseg frame': 'https://www.wsdisplay.com/QSEG-Quick-Wall-Displays',
    'qseg templates': 'https://www.wsdisplay.com/QSEG-Quick-Wall-Displays',
    'ez tube': 'https://www.wsdisplay.com/fabric-displays/Fabric-Tube-Display/EZ-Tube-Display',
    'ez extend': 'https://www.wsdisplay.com/fabric-displays/EZ-Extend-Fabric-Displays',
    'falcon flag': 'https://www.wsdisplay.com/flags-outdoor-displays/outdoor-flag/falcon-flag',
    'table throw': 'https://www.wsdisplay.com/table-throw',
    'table throws': 'https://www.wsdisplay.com/table-throw',
    'stretch table': 'https://www.wsdisplay.com/table-throw',
    'fitted table': 'https://www.wsdisplay.com/table-throw',
    'table runner': 'https://www.wsdisplay.com/table-throw',
    'canopy tent': 'https://www.wsdisplay.com/flags-outdoor-displays/Canopy',
    'canopy': 'https://www.wsdisplay.com/flags-outdoor-displays/Canopy',
    'tent': 'https://www.wsdisplay.com/flags-outdoor-displays/Canopy',
    'casita': 'https://www.wsdisplay.com/flags-outdoor-displays/Canopy/one-choice-casita-canopy-tents',
    'cabo': 'https://www.wsdisplay.com/trade-show-booths/cabo-booths',
    'one choice': 'https://www.wsdisplay.com/One-Choice-Products',
    'trade show booth': 'https://www.wsdisplay.com/trade-show-booths',
    'fabric display': 'https://www.wsdisplay.com/fabric-displays',
    'flag': 'https://www.wsdisplay.com/flags-outdoor-displays',
    'outdoor': 'https://www.wsdisplay.com/flags-outdoor-displays',
    'light box': 'https://www.wsdisplay.com/Fabric-Light-Box',
    'backwall': 'https://www.wsdisplay.com/resort-collection',
    'canvas': 'https://www.wsdisplay.com/home-goods',
  };
  const urlMap = Object.entries(productUrls).map(([k,v]) => `${k} = ${v}`).join('\n');

  const prompt = `You are a sales rep for WS Display (wsdisplay.com), a wholesale trade show display company.

Write a clean HTML email reply. Output ONLY HTML tags — no markdown, no ** characters, no plain text.
Use this base style for all paragraphs: style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;line-height:1.6;"

STEP 1: DETERMINE THE CUSTOMER'S INTENT
Read the customer's message and classify it as one of:
A) PRODUCT INQUIRY — they want product recommendations, pricing, or options
B) INFORMATION REQUEST — they want warranty info, spec sheets, policies, shipping details, turnaround times, artwork requirements, or other specific information
C) ORDER/ACCOUNT ISSUE — they have a question about an existing order, tracking, returns, billing, or their account
D) GENERAL — greetings, thank you, or other general communication

STEP 2: RESPOND BASED ON INTENT

=== FOR INTENT A (PRODUCT INQUIRY) ===
List 3-5 matching products in this table format:

<table style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="padding:16px 0;border-bottom:1px solid #e5e5e5;">
<strong style="font-size:14px;color:#222;">Option 1: [Product Name]</strong><br>
<span style="font-size:15px;color:#222;font-weight:600;">$X,XXX.00</span><br>
<span style="font-size:13px;color:#555;">[Dimensions] &bull; [Sided] &bull; [Package Type]</span><br>
<span style="font-size:13px;color:#555;">Turnaround: ~X business days &bull; Ships from: [CA/PA/PFC]</span><br>
<a href="[product URL]" style="display:inline-block;margin-top:10px;padding:9px 20px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;box-shadow:0 2px 4px rgba(37,99,235,0.35),inset 0 1px 0 rgba(255,255,255,0.2);border:1px solid #1e40af;">&#128722; View Product</a>
<a href="[spec sheet URL]" style="display:inline-block;margin-top:10px;margin-left:8px;padding:9px 20px;background:linear-gradient(180deg,#ffffff,#f1f5f9);color:#1d4ed8;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;border:1px solid #cbd5e1;box-shadow:0 2px 4px rgba(0,0,0,0.1),inset 0 1px 0 rgba(255,255,255,0.8);">&#128196; Spec Sheet</a>
<a href="[template URL]" style="display:inline-block;margin-top:10px;margin-left:8px;padding:9px 20px;background:linear-gradient(180deg,#ffffff,#f1f5f9);color:#1d4ed8;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;border:1px solid #cbd5e1;box-shadow:0 2px 4px rgba(0,0,0,0.1),inset 0 1px 0 rgba(255,255,255,0.8);">&#127912; Templates</a>
</td></tr>
</table>

Product URL rules — PRIORITY ORDER:
1. If a product in the data below has a "Product URL:" field, use THAT exact URL. These are verified links.
2. Otherwise match by brand/product name from this list:
${urlMap}
3. If no match, use https://www.wsdisplay.com
CRITICAL URL RULES:
- Never guess or construct URLs. Only use URLs from the product data or the mapping above. A wrong link is worse than a generic link.
- Never link to generic pages like "Templates page" or "Downloads page" — always link to the SPECIFIC product category or product page.
- When discussing a specific product (e.g. QSEG connectors), link to that product's page, not the entire category.
- Use the most specific URL available from the mapping above.

BUTTON & LINK RULES:
- ALWAYS include the "View Product" button for every product listed.
- Include the "Spec Sheet" button if a Spec Sheet URL is available in the product data (skip if "N/A" or missing).
- Include the "Templates" button if a Templates URL is available in the product data (skip if "N/A" or missing).
- For Intent B responses (info requests about a specific product), ALSO include product link buttons at the end of your answer so the customer can easily access the product page, spec sheets, and templates.
- Omit any button whose URL is not available — never use placeholder or generic URLs for buttons.

=== FOR INTENT B (INFORMATION REQUEST) ===
Answer the question directly using the knowledge base data below. Include specific details like:
- Warranty: type (1-Year or Lifetime), what it covers, how to file a claim, contact returns@wsdisplay.com
- Spec sheets: provide the direct link if available in the product data
- Shipping: carrier (UPS), cutoff times (3PM PT CA, Noon PT PA), free shipping programs
- Turnaround: standard times, rush options, proof approval deadlines
- Artwork: file formats (PDF preferred), resolution (125 DPI), color mode (CMYK)
- Returns: 30 days for hardware, no returns on graphics, contact returns@wsdisplay.com

If the knowledge base has the answer, give it clearly. If not, say you'll check with the team and follow up.

=== FOR INTENT C (ORDER/ACCOUNT ISSUE) ===
Acknowledge their concern, provide any info you can from the knowledge base, and direct them to:
- Order status: My Account → Review orders / track packages
- Missing items: Call 800-640-9544, press 1
- Returns: Email returns@wsdisplay.com
- Billing: Call 800-640-9544, press 1

=== FOR INTENT D (GENERAL) ===
Reply conversationally and helpfully.

STRICT RULES:
1. Output ONLY HTML. No markdown.
2. ANSWER THE ACTUAL QUESTION. Do NOT list product options if they asked about warranty, specs, shipping, or policies.
3. Only list product options for Intent A (product inquiries).
4. Only recommend products that match what the customer asked about. Never substitute unrelated products.
5. If no matching products exist in the data, say "Let me check on the best options and get back to you shortly."
6. Use the customer's actual name — never write "[Name]" literally.
7. Keep it clean, professional, and concise.
8. If they ask about a specific product's specs/warranty/details and the info is in the knowledge base, answer with specifics.
9. Always end with a closing: Best regards, WS Display Team, www.wsdisplay.com
10. Omit Spec Sheet or Templates buttons if their URLs are not available — but ALWAYS include the View Product button.
11. NEVER say "let me check with the team" or "I'll follow up" if the answer IS in the knowledge base data below. Always use available product data first — materials, dimensions, weights, fabric types, printing methods, etc. Only defer to the team if the info truly isn't available.
12. Include product specifications like material type, fabric weight, print method, and dimensions when they are available in the knowledge base data.

CONVERSATION HISTORY (most recent at bottom):
${conversationContext.conversationHistory || 'No previous messages'}

LATEST CUSTOMER MESSAGE (reply to THIS):
From: ${conversationContext.fromName || 'Customer'} <${conversationContext.fromEmail}>
Subject: ${conversationContext.subject}
Message: ${(conversationContext.latestMessage || '').slice(0, 3000)}

IMPORTANT: If we already replied to this customer in the conversation history above, acknowledge what was discussed and build on it. Do not repeat the same information.
${trainingContext}
${kbContext}

Write the HTML email now:`;

  const result = await model.generateContent(prompt);
  const draft = result.response.text();
  const sources = (kbArticles || []).map(a => ({ id: a.id, title: a.title, similarity: a.similarity }));
  return { draft, sources };
}

// Main orchestrator: process a new inbound message
async function processNewMessage(conversationId, messageId, io) {
  const startTime = Date.now();

  async function log(action, status, result, error) {
    try {
      await pool.query(
        `INSERT INTO ai_processing_log (conversation_id, message_id, action, status, result, error_message, processing_time_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [conversationId, messageId, action, status, result ? JSON.stringify(result) : null, error || null, Date.now() - startTime]
      );
    } catch (e) { console.error('AI log error:', e.message); }
  }

  try {
    // Load conversation and latest message + conversation history
    const convResult = await pool.query(
      `SELECT c.*, m.body_text, m.body_html, m.from_email, m.from_name
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       WHERE c.id = $1
       ORDER BY m.sent_at DESC LIMIT 1`,
      [conversationId]
    );

    // Load conversation history (last 5 messages for context)
    const historyResult = await pool.query(
      `SELECT from_email, body_text, direction, sent_at
       FROM messages WHERE conversation_id = $1
       ORDER BY sent_at DESC LIMIT 5`,
      [conversationId]
    );

    if (convResult.rows.length === 0) {
      await log('load', 'error', null, 'Conversation not found');
      return;
    }

    const conv = convResult.rows[0];

    // Skip deleted conversations entirely
    if (conv.status === 'deleted') {
      await log('process', 'skipped', { reason: 'Conversation is deleted' });
      return;
    }

    const bodyText = conv.body_text || conv.body_html?.replace(/<[^>]*>/g, ' ') || '';

    // Build conversation history context
    const history = historyResult.rows.reverse().map(m => {
      const text = m.body_text?.replace(/<[^>]*>/g, ' ').slice(0, 300) || '';
      return `[${m.direction === 'outbound' ? 'WS Display' : m.from_email}]: ${text}`;
    }).join('\n');

    // Step 1: Classify
    let classification;
    try {
      classification = await classifyEmail(conv.subject, bodyText);
      await pool.query(
        'UPDATE conversations SET ai_category = $1, ai_confidence = $2, ai_processed_at = NOW() WHERE id = $3',
        [classification.category, classification.confidence, conversationId]
      );
      await log('classify', 'success', classification);
    } catch (err) {
      await log('classify', 'error', null, err.message);
      classification = { category: 'general', confidence: 0 };
    }

    // Step 2: Search knowledge base AND wsdisplay.com product catalog
    let kbArticles = [];
    const isInfoRequest = ['returns', 'shipping', 'billing', 'order_status', 'general'].includes(classification.category)
      || /warranty|return|ship|policy|spec sheet|artwork|template|turnaround|rush|payment|tax|pick.?up|track/i.test(bodyText);
    try {
      const searchQuery = `${conv.subject || ''} ${bodyText.slice(0, 500)}`;
      // For info requests, search KB more heavily (FAQs, policies); for product queries, use website
      kbArticles = await searchKnowledgeBase(searchQuery, isInfoRequest ? 12 : 6);

      // Also search wsdisplay.com for live product data
      try {
        const rawText = ((conv.subject || '') + ' ' + bodyText.slice(0, 300)).toLowerCase();
        // Remove common filler words to extract product-relevant terms
        const stopWords = ['do','you','have','the','for','can','please','hi','hello','hey','thanks','thank','could','would','like','want','need','looking','about','what','how','any','some','get','send','me','my','your','our','this','that','with','from','are','was','were','will','been','being','has','had','also','just','more','most','very','really','much','well','here','there','where','when','which','who','whom','why','into','over','after','before','under','between','out','off','above','below','again','further','then','once','each','every','both','few','other','another','such','only','own','same','than','too','should','might','shall','must','may','let','know','give','spec','sheet','price','pricing','information','info','details','question'];
        const terms = rawText
          .replace(/[^a-zA-Z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 1 && !stopWords.includes(w))
          .slice(0, 8)
          .join(' ');

        // Also try the subject as a separate search
        const subjectTerms = (conv.subject || '').replace(/^Re:\s*/i, '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();

        const searchQueries = [terms, subjectTerms].filter(q => q.length > 2);
        let allWebProducts = [];

        for (const q of searchQueries) {
          const apiUrl = `https://www.wsdisplay.com/api/cacheable/items?c=1030411&country=US&currency=USD&custitem_f3_hide_item=F&fieldset=search&include=facets&language=en&limit=6&n=2&offset=0&pricelevel=5&q=${encodeURIComponent(q)}&use_pcv=F`;
          try {
            const prodResp = await fetch(apiUrl, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (prodResp.ok) {
              const prodData = await prodResp.json();
              const websiteProducts = (prodData.items || []).map(item => {
                const price = item.onlinecustomerprice || item.pricelevel1 || null;
                const shipsFrom = [];
                if (item.custitem_avlb_from_ca) shipsFrom.push('CA');
                if (item.custitem_avlb_from_pa) shipsFrom.push('PA');
                if (item.custitem_avlb_from_pfc) shipsFrom.push('PFC');
                const productUrl = item.urlcomponent ? `https://www.wsdisplay.com/${item.urlcomponent}` : 'https://www.wsdisplay.com';
                return {
                  title: `Website Product: ${item.displayname || item.storedisplayname2 || ''}`,
                  content: `Product: ${item.displayname || ''}\nSKU: ${item.itemid || ''}\nPrice: ${price ? '$' + price.toFixed(2) : 'Contact for pricing'}\nCategory: ${item.class || ''}\nDescription: ${item.storedescription || ''}\nTurnaround: ${(item.custitem_turn_around_options || '').replace(/&nbsp;/g, '').trim() || '~2 business days'}\nShips from: ${shipsFrom.join(', ') || 'Contact for availability'}\nProduct URL: ${productUrl}\nSpec Sheet: ${item.custitem_itemtemplate || 'N/A'}\nIn Stock: ${item.isinstock ? 'Yes' : 'No'}`,
                  category: 'product',
                  source_type: 'website',
                  similarity: 0.9
                };
              });
              allWebProducts.push(...websiteProducts);
              console.log(`Found ${websiteProducts.length} products from wsdisplay.com for: "${q}"`);
            }
          } catch (fetchErr) {
            console.log(`Website search failed for "${q}":`, fetchErr.message);
          }
        }

        // Deduplicate by product name
        const seen = new Set();
        const uniqueProducts = allWebProducts.filter(p => {
          if (seen.has(p.title)) return false;
          seen.add(p.title);
          return true;
        });

        // Prepend website products — they're more accurate and current
        kbArticles = [...uniqueProducts.slice(0, 8), ...kbArticles];
        console.log(`Total ${uniqueProducts.length} unique products from wsdisplay.com`);
      } catch (webErr) {
        console.log('Website product search failed (non-fatal):', webErr.message);
      }

      await log('search_kb', 'success', { articles_found: kbArticles.length, titles: kbArticles.map(a => a.title) });
    } catch (err) {
      await log('search_kb', 'error', null, err.message);
    }

    // Step 3: Check AI settings for this mailbox
    let aiMode = 'draft';
    try {
      const settingsResult = await pool.query("SELECT value FROM app_settings WHERE key = 'ai_settings'");
      if (settingsResult.rows.length > 0) {
        const aiSettings = settingsResult.rows[0].value;
        // Check per-mailbox setting first, then fall back to global
        if (aiSettings.mailboxes && aiSettings.mailboxes[conv.mailbox_id]) {
          aiMode = aiSettings.mailboxes[conv.mailbox_id];
        } else if (aiSettings.mode) {
          aiMode = aiSettings.mode;
        }
      }
    } catch (e) { /* default to draft */ }

    // Skip if AI is off for this mailbox
    if (aiMode === 'off') {
      await log('process', 'skipped', { reason: 'AI disabled for this mailbox' });
      return;
    }

    // Step 4: Generate draft reply
    try {
      const context = {
        subject: conv.subject,
        fromEmail: conv.from_email,
        fromName: conv.from_name,
        latestMessage: bodyText,
        conversationHistory: history || ''
      };

      const { draft, sources } = await generateDraftReply(context, kbArticles, classification.category);

      // Detect if AI doesn't know the answer
      const draftLower = (draft || '').toLowerCase();
      const uncertainPhrases = ['let me check', 'follow up', 'get back to you', 'check with', "don't have that information", 'i will find out', 'i\'ll look into', 'check on this', 'confirm with', 'reach out to our', 'check with our', 'i\'ll get'];
      const hasUncertainLanguage = uncertainPhrases.some(phrase => draftLower.includes(phrase));
      const hasLowKbConfidence = !kbArticles || kbArticles.length === 0 || kbArticles.every(a => a.similarity < 0.6);
      const needsAnswer = hasUncertainLanguage || hasLowKbConfidence;

      if (needsAnswer) {
        // Check if this conversation already has a needs_answer entry (flagged, answered, or dismissed)
        const existingFlag = await pool.query(
          `SELECT id FROM ai_processing_log WHERE conversation_id = $1 AND action = 'needs_answer' LIMIT 1`,
          [conversationId]
        );
        if (existingFlag.rows.length > 0) {
          console.log(`Skipping needs_answer for conversation ${conversationId} — already flagged`);
        } else {
        // Extract the customer's question for the unanswered queue
        const questionText = bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
        await log('needs_answer', 'flagged', {
          question: questionText,
          reason: hasUncertainLanguage ? 'uncertain_language' : 'low_kb_confidence',
          category: classification.category,
          from_email: conv.from_email,
          from_name: conv.from_name,
          subject: conv.subject,
          mailbox_id: conv.mailbox_id
        });
        }
      }

      // Determine if we should auto-send
      const complexCategories = ['returns', 'complaint', 'billing'];
      const isComplex = complexCategories.includes(classification.category);
      const shouldAutoSend = aiMode === 'auto' || (aiMode === 'auto_simple' && !isComplex);

      if (shouldAutoSend) {
        // Auto-send the reply via Gmail
        try {
          const { sendGmailReply } = require('./gmail-sync');
          // Get the mailbox email address
          const mbResult = await pool.query('SELECT email FROM mailboxes WHERE id = $1', [conv.mailbox_id]);
          const mailboxEmail = mbResult.rows[0]?.email;

          if (mailboxEmail) {
            await sendGmailReply(pool, mailboxEmail, conv.from_email, `Re: ${conv.subject}`, draft, conv.gmail_thread_id);

            // Insert message record
            const { v4: uuidv4 } = require('uuid');
            const msgId = uuidv4();
            await pool.query(
              `INSERT INTO messages (id, conversation_id, from_email, to_email, subject, body_html, body_text, direction, sent_at, gmail_thread_id, is_ai_generated)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'outbound', NOW(), $8, true)`,
              [msgId, conversationId, mailboxEmail, conv.from_email, `Re: ${conv.subject}`, draft, draft, conv.gmail_thread_id]
            );

            await log('auto_send', 'success', { to: conv.from_email, category: classification.category, sources_count: sources.length });
            console.log(`AI auto-sent reply to ${conv.from_email} for conversation ${conversationId}`);
          }
        } catch (sendErr) {
          await log('auto_send', 'error', null, sendErr.message);
          // Fall back to draft if send fails
          await pool.query(
            `INSERT INTO shared_drafts (conversation_id, author_id, content, subject, status, is_ai_generated, ai_sources, ai_category)
             VALUES ($1, NULL, $2, $3, 'ai_draft', true, $4, $5)`,
            [conversationId, draft, `Re: ${conv.subject}`, JSON.stringify(sources), classification.category]
          );
        }
      } else {
        // Insert as AI draft for review
        const draftResult = await pool.query(
          `INSERT INTO shared_drafts (conversation_id, author_id, content, subject, status, is_ai_generated, ai_sources, ai_category)
           VALUES ($1, NULL, $2, $3, 'ai_draft', true, $4, $5)
           RETURNING id`,
          [conversationId, draft, `Re: ${conv.subject}`, JSON.stringify(sources), classification.category]
        );

        await log('generate_draft', 'success', { draft_id: draftResult.rows[0].id, sources_count: sources.length, mode: aiMode });

        // Notify via socket if available
        if (io) {
          io.to('conv:' + conversationId).emit('ai:draft-ready', {
            conversationId,
            draftId: draftResult.rows[0].id,
            category: classification.category
          });
        }
      }
    } catch (err) {
      await log('generate_draft', 'error', null, err.message);
    }

  } catch (err) {
    console.error('AI processNewMessage error:', err.message);
    await log('process', 'error', null, err.message);
  }
}

module.exports = {
  initVectorSupport,
  embedText,
  classifyEmail,
  searchKnowledgeBase,
  generateDraftReply,
  processNewMessage,
  getGenAI
};
