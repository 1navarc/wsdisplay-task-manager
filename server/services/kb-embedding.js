const { pool } = require('../config/database');
const { embedText } = require('./ai-service');

// Embed a single knowledge base article
async function embedArticle(articleId) {
  const result = await pool.query('SELECT id, title, content FROM knowledge_base_articles WHERE id = $1', [articleId]);
  if (result.rows.length === 0) throw new Error('Article not found');

  const article = result.rows[0];
  const text = `${article.title}\n\n${article.content}`;
  const embedding = await embedText(text);

  await pool.query(
    'UPDATE knowledge_base_articles SET embedding = $1 WHERE id = $2',
    [JSON.stringify(embedding), articleId]
  );

  return { id: articleId, title: article.title, embedded: true };
}

// Embed all articles that don't have embeddings yet
async function embedAllArticles() {
  const result = await pool.query(
    'SELECT id, title FROM knowledge_base_articles WHERE embedding IS NULL'
  );

  const results = [];
  for (let i = 0; i < result.rows.length; i++) {
    try {
      const r = await embedArticle(result.rows[i].id);
      results.push(r);
      console.log(`Embedded KB article ${i + 1}/${result.rows.length}: ${result.rows[i].title}`);
      // Rate limit: 500ms between embeddings
      if (i < result.rows.length - 1) await new Promise(res => setTimeout(res, 500));
    } catch (err) {
      console.error(`Failed to embed article ${result.rows[i].id}:`, err.message);
      results.push({ id: result.rows[i].id, title: result.rows[i].title, error: err.message });
    }
  }
  return results;
}

// Extract text from a PDF buffer
async function extractTextFromPDF(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return data.text;
}

// Scrape a URL and return plain text
async function scrapeURL(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WSDisplay-KB-Bot/1.0' }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const html = await response.text();
    // Strip HTML tags, scripts, styles
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Chunk long text into smaller pieces for better embedding quality
function chunkText(text, maxChars = 2000, overlap = 200) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxChars;
    // Try to break at sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('. ', end);
      if (lastPeriod > start + maxChars / 2) end = lastPeriod + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
  }
  return chunks;
}

// Create KB article from scraped URL content
async function createArticleFromURL(url, title, category, userId) {
  const text = await scrapeURL(url);
  if (!text || text.length < 50) throw new Error('Insufficient content extracted from URL');

  const chunks = chunkText(text);
  const articles = [];

  for (let i = 0; i < chunks.length; i++) {
    const articleTitle = chunks.length > 1 ? `${title} (Part ${i + 1})` : title;
    const result = await pool.query(
      `INSERT INTO knowledge_base_articles (title, content, category, source_type, source_url, is_published, created_by, chunk_index)
       VALUES ($1, $2, $3, 'url', $4, true, $5, $6)
       RETURNING id`,
      [articleTitle, chunks[i], category || 'general', url, userId, i]
    );
    const articleId = result.rows[0].id;

    // Embed immediately
    try {
      await embedArticle(articleId);
    } catch (err) {
      console.error(`Failed to embed article from URL chunk ${i}:`, err.message);
    }

    articles.push({ id: articleId, title: articleTitle, chunk_index: i });
  }

  return articles;
}

// Create KB article from uploaded PDF
async function createArticleFromPDF(buffer, title, category, userId) {
  const text = await extractTextFromPDF(buffer);
  if (!text || text.length < 50) throw new Error('Insufficient text extracted from PDF');

  const chunks = chunkText(text);
  const articles = [];

  for (let i = 0; i < chunks.length; i++) {
    const articleTitle = chunks.length > 1 ? `${title} (Part ${i + 1})` : title;
    const result = await pool.query(
      `INSERT INTO knowledge_base_articles (title, content, category, source_type, is_published, created_by, chunk_index)
       VALUES ($1, $2, $3, 'pdf', true, $4, $5)
       RETURNING id`,
      [articleTitle, chunks[i], category || 'general', userId, i]
    );
    const articleId = result.rows[0].id;

    try {
      await embedArticle(articleId);
    } catch (err) {
      console.error(`Failed to embed PDF chunk ${i}:`, err.message);
    }

    articles.push({ id: articleId, title: articleTitle, chunk_index: i });
  }

  return articles;
}

module.exports = {
  embedArticle,
  embedAllArticles,
  extractTextFromPDF,
  scrapeURL,
  chunkText,
  createArticleFromURL,
  createArticleFromPDF
};
