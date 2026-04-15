/**
 * Email Embeddings Service
 *
 * Generates Gemini embeddings for a slice of archived messages so they can
 * be searched semantically. Default behavior keeps embeddings off — the user
 * picks a slice (filter), sees the predicted cost, and clicks "Embed slice"
 * to run it. Once embedded, semantic search is instant for that slice.
 *
 * Costs are tracked on the email_archive_runs row (run_type = 'embed_slice').
 */

const { pool } = require('../config/database');
const { getGenAI } = require('./ai-service');

const MODEL = 'gemini-embedding-001';
const DIMS = 768;
// Approximate cost per 1M input tokens for gemini-embedding-001.
// Adjust if the price changes.
const PRICE_PER_M_INPUT = 0.025;

function tokensApprox(text) {
  // Cheap approximation: ~4 chars per token.
  return Math.ceil((text || '').length / 4);
}

async function isPgvectorAvailable() {
  try {
    const r = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    return r.rows.length > 0;
  } catch { return false; }
}

/**
 * Build the SQL WHERE/params for a filter snapshot (subset of archive search filters).
 * Only fields that affect *which messages* to embed.
 */
function buildSliceWhere(filters, params = []) {
  const where = ['m.body_text_clean IS NOT NULL', "length(m.body_text_clean) > 20"];
  if (filters.mailboxes && filters.mailboxes.length) {
    params.push(filters.mailboxes);
    where.push(`m.mailbox_email = ANY($${params.length}::text[])`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`m.sent_at >= $${params.length}::timestamptz`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`m.sent_at <= $${params.length}::timestamptz`);
  }
  if (filters.customer_email) {
    params.push(filters.customer_email.toLowerCase());
    where.push(`(m.from_email = $${params.length} OR EXISTS (
      SELECT 1 FROM email_archive_threads t WHERE t.id = m.thread_id AND t.customer_email = $${params.length}
    ))`);
  }
  if (filters.customer_domain) {
    params.push(filters.customer_domain.toLowerCase());
    where.push(`EXISTS (
      SELECT 1 FROM email_archive_threads t WHERE t.id = m.thread_id AND t.customer_domain = $${params.length}
    )`);
  }
  if (filters.rep_email) {
    params.push(filters.rep_email.toLowerCase());
    where.push(`m.rep_email = $${params.length}`);
  }
  if (filters.label) {
    params.push(filters.label);
    where.push(`$${params.length} = ANY(m.label_ids)`);
  }
  return { where, params };
}

/** Estimate count + cost for embedding a slice. */
async function estimateSlice(filters) {
  const { where, params } = buildSliceWhere(filters);
  const cr = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(length(m.body_text_clean)), 0)::bigint AS total_chars
       FROM email_archive_messages m
       WHERE ${where.join(' AND ')}
         AND NOT EXISTS (SELECT 1 FROM email_archive_embeddings e WHERE e.message_id = m.id)`,
    params
  );
  const n = cr.rows[0].n || 0;
  const totalChars = Number(cr.rows[0].total_chars || 0);
  const totalTokens = Math.ceil(totalChars / 4);
  const costUsd = (totalTokens / 1_000_000) * PRICE_PER_M_INPUT;
  return {
    message_count: n,
    estimated_tokens: totalTokens,
    estimated_cost_usd: Number(costUsd.toFixed(4)),
    model: MODEL,
  };
}

/** Embed a single text and return the vector array. */
async function embedSingle(text) {
  const ai = getGenAI();
  const model = ai.getGenerativeModel({ model: MODEL });
  const r = await model.embedContent((text || '').slice(0, 10000));
  return r.embedding.values;
}

/**
 * Run an embed-slice job: walks all unembedded messages matching the filter,
 * embeds them in batches, writes vectors to email_archive_embeddings.
 * Tracks progress on a run row of type 'embed_slice'.
 */
async function runEmbedSlice({ filters, userId }) {
  if (!(await isPgvectorAvailable())) {
    throw new Error('pgvector extension is not available on this database');
  }

  const est = await estimateSlice(filters);
  const r0 = await pool.query(
    `INSERT INTO email_archive_runs
       (mailbox_email, run_type, status, total_threads, current_status_line,
        started_by_user_id, filter_snapshot)
     VALUES ($1, 'embed_slice', 'running', $2, $3, $4, $5)
     RETURNING *`,
    [
      (filters.mailboxes && filters.mailboxes[0]) || 'multi',
      est.message_count,
      `Embedding ${est.message_count} messages (~$${est.estimated_cost_usd.toFixed(4)})`,
      userId || null,
      filters,
    ]
  );
  const run = r0.rows[0];
  const runId = run.id;

  // Pull messages in pages, embed, and write vectors.
  const { where, params } = buildSliceWhere(filters);
  const pageSize = 200;
  let lastId = null;
  let processed = 0;
  let totalTokens = 0;
  let errors = 0;
  let cost = 0;
  const start = Date.now();

  // Async background runner so the HTTP request returns quickly.
  (async () => {
    try {
      while (true) {
        // Cancel check
        const cancelled = await pool.query(`SELECT cancel_requested FROM email_archive_runs WHERE id = $1`, [runId]);
        if (cancelled.rows[0] && cancelled.rows[0].cancel_requested) {
          await pool.query(
            `UPDATE email_archive_runs SET status='cancelled', completed_at=NOW(), current_status_line=$2 WHERE id=$1`,
            [runId, `Cancelled at ${processed}/${est.message_count}`]
          );
          return;
        }

        const pageParams = [...params];
        let cursorClause = '';
        if (lastId) {
          pageParams.push(lastId);
          cursorClause = ` AND m.id > $${pageParams.length}::uuid`;
        }
        const q = `SELECT m.id, m.body_text_clean
                     FROM email_archive_messages m
                    WHERE ${where.join(' AND ')}
                      AND NOT EXISTS (SELECT 1 FROM email_archive_embeddings e WHERE e.message_id = m.id)
                      ${cursorClause}
                    ORDER BY m.id
                    LIMIT ${pageSize}`;
        const r = await pool.query(q, pageParams);
        const rows = r.rows;
        if (!rows.length) break;

        for (const row of rows) {
          try {
            const vec = await embedSingle(row.body_text_clean);
            await pool.query(
              `INSERT INTO email_archive_embeddings (message_id, mailbox_email, embedding, model)
               SELECT $1, mailbox_email, $2::vector, $3
                 FROM email_archive_messages WHERE id = $1
               ON CONFLICT (message_id) DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, embedded_at = NOW()`,
              [row.id, JSON.stringify(vec), MODEL]
            );
            const tk = tokensApprox(row.body_text_clean);
            totalTokens += tk;
            cost += (tk / 1_000_000) * PRICE_PER_M_INPUT;
          } catch (e) {
            errors++;
            if (errors < 10) console.warn('[embed] failed:', e.message);
          }
          processed++;
          lastId = row.id;
          if (processed % 25 === 0) {
            const pct = est.message_count ? (processed / est.message_count) * 100 : 0;
            const elapsed = (Date.now() - start) / 1000;
            const rate = processed / Math.max(elapsed, 1);
            const eta = rate > 0 ? Math.round((est.message_count - processed) / rate) : null;
            await pool.query(
              `UPDATE email_archive_runs
                  SET processed_count=$2, error_count=$3, progress_percent=$4,
                      eta_seconds=$5, embedding_input_tokens=$6, embedding_cost_usd=$7,
                      current_status_line=$8
                WHERE id=$1`,
              [
                runId, processed, errors, Number(pct.toFixed(2)),
                eta, totalTokens, Number(cost.toFixed(6)),
                `Embedding ${processed}/${est.message_count}  ($${cost.toFixed(4)} so far)`,
              ]
            );
          }
        }
      }

      // Try to ensure ivfflat index exists once we have data.
      try {
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_eae_embedding
             ON email_archive_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
        );
      } catch (e) {
        // ivfflat may need ANALYZE first; ignore failure on tiny sets.
      }

      await pool.query(
        `UPDATE email_archive_runs
            SET status='complete', completed_at=NOW(),
                processed_count=$2, error_count=$3, progress_percent=100,
                embedding_input_tokens=$4, embedding_cost_usd=$5,
                current_status_line=$6
          WHERE id=$1`,
        [
          runId, processed, errors,
          totalTokens, Number(cost.toFixed(6)),
          `Done · ${processed} embedded · $${cost.toFixed(4)}`,
        ]
      );
    } catch (e) {
      console.error('[embed] runEmbedSlice error:', e);
      await pool.query(
        `UPDATE email_archive_runs SET status='failed', completed_at=NOW(), last_error=$2 WHERE id=$1`,
        [runId, e.message]
      );
    }
  })().catch(e => console.error('[embed] background error:', e));

  return { run_id: runId, estimate: est };
}

/**
 * Semantic search: embeds the query and returns nearest-neighbor messages.
 * If no embeddings exist yet for the filtered slice, returns empty.
 */
async function semanticSearch({ query, filters, limit = 50 }) {
  if (!(await isPgvectorAvailable())) {
    return { error: 'pgvector unavailable', rows: [] };
  }
  if (!query || !query.trim()) return { rows: [] };

  const qVec = await embedSingle(query);
  const qStr = JSON.stringify(qVec);

  const where = [];
  const params = [qStr];
  if (filters.mailboxes && filters.mailboxes.length) {
    params.push(filters.mailboxes);
    where.push(`e.mailbox_email = ANY($${params.length}::text[])`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`m.sent_at >= $${params.length}::timestamptz`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`m.sent_at <= $${params.length}::timestamptz`);
  }
  if (filters.customer_email) {
    params.push(filters.customer_email.toLowerCase());
    where.push(`(m.from_email = $${params.length} OR t.customer_email = $${params.length})`);
  }
  if (filters.rep_email) {
    params.push(filters.rep_email.toLowerCase());
    where.push(`m.rep_email = $${params.length}`);
  }
  params.push(limit);

  const sql = `
    SELECT m.id AS message_id, m.gmail_message_id, t.gmail_thread_id, t.id AS thread_id,
           m.mailbox_email, m.sent_at, m.from_email, m.from_name, m.subject,
           t.customer_email, m.rep_email, m.rep_name, m.snippet,
           1 - (e.embedding <=> $1::vector) AS similarity
      FROM email_archive_embeddings e
      JOIN email_archive_messages m ON m.id = e.message_id
      JOIN email_archive_threads t ON t.id = m.thread_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.embedding <=> $1::vector
      LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return { rows: r.rows };
}

/** Count of how many messages in the current filter already have embeddings. */
async function sliceCoverage(filters) {
  const { where, params } = buildSliceWhere(filters);
  const r = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(e.message_id)::int AS embedded
       FROM email_archive_messages m
       LEFT JOIN email_archive_embeddings e ON e.message_id = m.id
      WHERE ${where.join(' AND ')}`,
    params
  );
  return r.rows[0];
}

module.exports = {
  isPgvectorAvailable,
  estimateSlice,
  runEmbedSlice,
  semanticSearch,
  sliceCoverage,
  embedSingle,
  MODEL,
  DIMS,
};
