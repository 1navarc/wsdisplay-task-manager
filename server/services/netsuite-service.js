// NetSuite TBA (Token-Based Auth) client — OAuth 1.0a HMAC-SHA256 signing.
// Used to call SuiteQL via REST: POST /services/rest/query/v1/suiteql

const crypto = require('crypto');
const https = require('https');

function rfc3986(str) {
  return encodeURIComponent(String(str)).replace(/[!*'()]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

function buildBaseUrl(accountId) {
  // NetSuite REST endpoint: <account>.suitetalk.api.netsuite.com (account id with underscores → hyphens)
  const host = String(accountId || '').toLowerCase().replace(/_/g, '-');
  return `https://${host}.suitetalk.api.netsuite.com`;
}

function signRequest({ method, url, accountId, consumerKey, consumerSecret, tokenId, tokenSecret, queryParams = {} }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_token: tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: nonce(),
    oauth_version: '1.0',
  };

  // Combine OAuth + query params for the signature base string
  const allParams = { ...queryParams, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map(k => `${rfc3986(k)}=${rfc3986(allParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    rfc3986(url),
    rfc3986(paramString),
  ].join('&');

  const signingKey = `${rfc3986(consumerSecret)}&${rfc3986(tokenSecret)}`;
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(baseString)
    .digest('base64');

  // Build Authorization header
  const headerParams = {
    realm: accountId,
    ...oauthParams,
    oauth_signature: signature,
  };
  const headerStr = 'OAuth ' + Object.keys(headerParams)
    .map(k => `${rfc3986(k)}="${rfc3986(headerParams[k])}"`)
    .join(', ');

  return headerStr;
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Run a SuiteQL query.
 * @param {object} cfg - { account_id, consumer_key, consumer_secret, token_id, token_secret }
 * @param {string} sql - SuiteQL query string
 * @param {object} opts - { limit?: number, offset?: number }
 */
async function runSuiteQL(cfg, sql, opts = {}) {
  if (!cfg || !cfg.account_id || !cfg.consumer_key || !cfg.token_id) {
    throw new Error('NetSuite is not configured');
  }
  const baseUrl = cfg.base_url || buildBaseUrl(cfg.account_id);
  const path = '/services/rest/query/v1/suiteql';
  const queryParams = {};
  if (opts.limit) queryParams.limit = opts.limit;
  if (opts.offset) queryParams.offset = opts.offset;
  const queryString = Object.keys(queryParams).length
    ? '?' + Object.keys(queryParams).map(k => `${k}=${queryParams[k]}`).join('&')
    : '';
  const fullUrl = baseUrl + path;

  const authHeader = signRequest({
    method: 'POST',
    url: fullUrl,           // signature base url is the path WITHOUT query params for SuiteQL
    accountId: cfg.account_id,
    consumerKey: cfg.consumer_key,
    consumerSecret: cfg.consumer_secret,
    tokenId: cfg.token_id,
    tokenSecret: cfg.token_secret,
    queryParams,
  });

  const body = JSON.stringify({ q: sql });
  const u = new URL(fullUrl + queryString);
  const result = await httpRequest({
    method: 'POST',
    hostname: u.hostname,
    path: u.pathname + u.search,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Prefer': 'transient',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (result.status >= 400) {
    const msg = (result.body && (result.body['o:errorDetails']?.[0]?.detail || result.body.title || result.body.raw))
      || `HTTP ${result.status}`;
    const err = new Error(`NetSuite SuiteQL error: ${msg}`);
    err.status = result.status;
    err.details = result.body;
    throw err;
  }
  return result.body; // { items: [...], hasMore, totalResults, ... }
}

/**
 * Test the connection by running a trivial query.
 */
async function testConnection(cfg) {
  try {
    const result = await runSuiteQL(cfg, 'SELECT 1 AS ok FROM dual', { limit: 1 });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message, status: err.status, details: err.details };
  }
}

/**
 * Find a customer by exact email, with optional domain fallback.
 * Returns { customer, orders, invoices, match_source } or { matched: false }.
 */
async function lookupCustomerByEmail(cfg, email, opts = {}) {
  if (!email) return { matched: false };
  const normalized = String(email).trim().toLowerCase();
  const domain = normalized.includes('@') ? normalized.split('@')[1] : null;

  // 1. Exact email match (primary email or any contact email)
  let matchSource = 'exact';
  let customer = null;
  const exactSql = `
    SELECT id, entityid, companyname, email, phone, category, salesrep, datecreated, balance, daysoverdue, isperson
    FROM customer
    WHERE LOWER(email) = '${normalized.replace(/'/g, "''")}'
    AND isinactive = 'F'
    LIMIT 1
  `;
  const exactRes = await runSuiteQL(cfg, exactSql, { limit: 1 });
  if (exactRes.items && exactRes.items.length) {
    customer = exactRes.items[0];
  }

  // 2. Try contacts table
  if (!customer) {
    const contactSql = `
      SELECT c.id, c.entityid, c.companyname, c.email, c.phone, c.category, c.salesrep, c.datecreated, c.balance, c.daysoverdue, c.isperson
      FROM customer c
      JOIN contact ct ON ct.company = c.id
      WHERE LOWER(ct.email) = '${normalized.replace(/'/g, "''")}'
      AND c.isinactive = 'F'
      LIMIT 1
    `;
    const contactRes = await runSuiteQL(cfg, contactSql, { limit: 1 });
    if (contactRes.items && contactRes.items.length) {
      customer = contactRes.items[0];
    }
  }

  // 3. Domain fallback
  if (!customer && domain && opts.allowDomain !== false) {
    matchSource = 'domain';
    const domainSql = `
      SELECT id, entityid, companyname, email, phone, category, salesrep, datecreated, balance, daysoverdue, isperson
      FROM customer
      WHERE (LOWER(email) LIKE '%@${domain.replace(/'/g, "''")}'
             OR LOWER(emailpreference) LIKE '%@${domain.replace(/'/g, "''")}')
      AND isinactive = 'F'
      ORDER BY datecreated DESC
      LIMIT 1
    `;
    try {
      const domainRes = await runSuiteQL(cfg, domainSql, { limit: 1 });
      if (domainRes.items && domainRes.items.length) {
        customer = domainRes.items[0];
      }
    } catch (e) {
      // Some accounts don't expose emailpreference; retry simpler form
      const simpleSql = `
        SELECT id, entityid, companyname, email, phone, category, salesrep, datecreated, balance, daysoverdue, isperson
        FROM customer
        WHERE LOWER(email) LIKE '%@${domain.replace(/'/g, "''")}'
        AND isinactive = 'F'
        ORDER BY datecreated DESC
        LIMIT 1
      `;
      const simpleRes = await runSuiteQL(cfg, simpleSql, { limit: 1 });
      if (simpleRes.items && simpleRes.items.length) {
        customer = simpleRes.items[0];
      }
    }
  }

  if (!customer) return { matched: false };

  const cid = customer.id;

  // Recent sales orders (last 10)
  let orders = [];
  try {
    const ordersSql = `
      SELECT id, tranid, trandate, status, total
      FROM transaction
      WHERE entity = ${cid}
      AND type = 'SalesOrd'
      ORDER BY trandate DESC, id DESC
    `;
    const ordersRes = await runSuiteQL(cfg, ordersSql, { limit: 10 });
    orders = ordersRes.items || [];
  } catch (e) {
    orders = [];
  }

  // Open invoices (any with amountremaining > 0)
  let invoices = [];
  try {
    const invSql = `
      SELECT t.id, t.tranid, t.trandate, t.duedate, t.status,
             tl.foreignamountunpaid AS amountremaining
      FROM transaction t
      LEFT JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T'
      WHERE t.entity = ${cid}
      AND t.type = 'CustInvc'
      AND t.status NOT IN ('Paid In Full', 'PaidInFull')
      ORDER BY t.duedate ASC NULLS LAST
    `;
    const invRes = await runSuiteQL(cfg, invSql, { limit: 10 });
    invoices = invRes.items || [];
  } catch (e) {
    invoices = [];
  }

  return {
    matched: true,
    match_source: matchSource,
    customer,
    orders,
    invoices,
    customer_url: `https://${String(cfg.account_id).toLowerCase().replace(/_/g, '-')}.app.netsuite.com/app/common/entity/custjob.nl?id=${cid}`,
  };
}

module.exports = {
  runSuiteQL,
  testConnection,
  lookupCustomerByEmail,
  buildBaseUrl,
};
