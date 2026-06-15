// ============================================================
// PackPrice · Cloud quotes data access (upload, status, stats rows)
// ============================================================
// Reads/writes the quote tables of the customer's own D1 database
// (quotes / quote_items / quote_addons — db/migrations/0001_init.sql)
// over the injected D1 client. Quotes are historical records, so
// uploads are idempotent (INSERT OR IGNORE by the client-generated
// UUID PK): re-running an upload from the offline outbox can never
// duplicate a quote.
//
// Pure module: the D1 client is injected, no fs, no Electron — the
// outbox (lib/quote-outbox.js) owns persistence and the bootstrap
// (lib/cloud-bootstrap.js) owns the client + settings. The statistics
// are computed by a separate pure aggregator (lib/stats.js); here we
// only fetch the raw rows (no GROUP BY — there is no Worker).
//
// User-facing throw messages stay in Spanish (CLAUDE.md §6).
// ============================================================

'use strict';

// The valid quote statuses — exactly the CHECK constraint in
// db/migrations/0001_init.sql (quotes.status).
const QUOTE_STATUSES = ['pending', 'accepted', 'rejected'];

// Cloudflare D1 caps bound parameters at 100 per query; multi-row
// INSERTs and the IN (...) filters chunk to stay under it (mirrors
// lib/cloud-catalog.js).
const MAX_BOUND_PARAMS = 100;

// The quotes-table columns, in a fixed order so the INSERT statement is
// deterministic (matches db/migrations/0001_init.sql; status/status_ts
// keep their DB defaults on a fresh upload).
const QUOTE_COLUMNS = [
  'id', 'ts', 'user', 'client_name', 'client_phone', 'valid_until',
  'pack_id', 'tier', 'total_units', 'qty_3xl', 'qty_4xl', 'qty_5xl',
  'total_vat_inc', 'sale_base', 'margin_pct', 'target_margin',
  'pvp_deviation_pct', 'catalog_version'
];

// Returns `value` unless it is null/undefined, in which case `fallback`.
// Neutral name: it routes both string (client_name/phone) and numeric
// (sizes, optional margins) fields, so it must not read as numbers-only.
function valueOr(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

// Required NOT NULL quote columns (db/migrations/0001_init.sql), split by
// the primitive type the column expects. status/status_ts keep their DB
// defaults on a fresh upload, and the optional fields (sizes default 0,
// target_margin/pvp_deviation_pct default null) are not listed here.
const REQUIRED_STRING_FIELDS = [
  'id', 'ts', 'user', 'client_name', 'client_phone', 'valid_until', 'pack_id', 'tier'
];
const REQUIRED_NUMBER_FIELDS = [
  'total_units', 'total_vat_inc', 'sale_base', 'margin_pct', 'catalog_version'
];

/**
 * Defense-in-depth: validates a built quote row before it is sent to D1,
 * so a malformed quote fails fast (a clear Spanish error) instead of
 * tripping a NOT NULL/type constraint at the server. The thrown error is
 * deliberately a plain Error with NO network flag, so cloud-bootstrap
 * surfaces it as { ok:false } and never queues it (a permanently-bad
 * quote must not poison the outbox).
 *
 * @param {object} row - a row from buildQuoteRows().quote
 * @throws {Error} Spanish error naming the offending field
 */
function validateQuoteRow(row) {
  if (row === null || typeof row !== 'object') {
    throw new Error('Presupuesto no válido: faltan datos obligatorios');
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof row[field] !== 'string' || row[field] === '') {
      throw new Error(`Presupuesto no válido: falta el campo obligatorio «${field}»`);
    }
  }
  for (const field of REQUIRED_NUMBER_FIELDS) {
    if (typeof row[field] !== 'number' || !Number.isFinite(row[field])) {
      throw new Error(`Presupuesto no válido: el campo «${field}» debe ser numérico`);
    }
  }
}

/**
 * Maps a renderer/outbox quote object to the three row shapes the D1
 * quote tables expect. The client name/phone may arrive either nested
 * under `customer` (the local-history shape, lib/history.js) or flat as
 * `client_name`/`client_phone`. Optional fields are tolerated: sizes
 * default to 0, target_margin / pvp_deviation_pct default to null, and
 * a quote with no lines yields empty items/addons arrays.
 *
 * @param {object} quote
 * @returns {{quote: object, items: object[], addons: object[]}}
 */
function buildQuoteRows(quote) {
  const customer = quote.customer || {};
  const row = {
    id: quote.id,
    ts: quote.ts,
    user: quote.user,
    client_name: valueOr(quote.client_name, customer.name),
    client_phone: valueOr(quote.client_phone, customer.phone),
    valid_until: quote.valid_until,
    pack_id: quote.pack_id,
    tier: quote.tier,
    total_units: quote.total_units,
    qty_3xl: valueOr(quote.qty_3xl, 0),
    qty_4xl: valueOr(quote.qty_4xl, 0),
    qty_5xl: valueOr(quote.qty_5xl, 0),
    total_vat_inc: quote.total_vat_inc,
    sale_base: quote.sale_base,
    margin_pct: quote.margin_pct,
    target_margin: valueOr(quote.target_margin, null),
    pvp_deviation_pct: valueOr(quote.pvp_deviation_pct, null),
    catalog_version: quote.catalog_version
  };
  const items = (quote.items || []).map((it) => ({
    quote_id: quote.id, product_id: it.product_id, sides: it.sides, qty: it.qty
  }));
  const addons = (quote.addons || []).map((ad) => ({
    quote_id: quote.id, addon_id: ad.addon_id, qty: ad.qty
  }));
  return { quote: row, items, addons };
}

// Chunked, parameterized INSERT OR IGNORE of uniform rows into a table
// (mirrors lib/cloud-catalog.js seedCatalog). No-op on an empty array.
async function insertRows(client, table, columns, rows) {
  if (rows.length === 0) return;
  const rowsPerChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns.length));
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const chunk = rows.slice(i, i + rowsPerChunk);
    const placeholders = chunk.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', ');
    await client.query(
      `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
      chunk.flatMap((row) => columns.map((col) => row[col]))
    );
  }
}

/**
 * Uploads a quote and its lines, idempotently. INSERT OR IGNORE keys on
 * the UUID PK (quotes.id) and the composite PKs of the line tables, so a
 * re-upload from the outbox is a harmless no-op rather than a duplicate.
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} quote
 * @returns {Promise<{ok: boolean, id: string}>}
 */
async function uploadQuote(client, quote) {
  const { quote: row, items, addons } = buildQuoteRows(quote);
  // Validate BEFORE any network call: a malformed row fails fast with a
  // clear (non-network) error so it surfaces as a failure rather than
  // poisoning the offline outbox (cloud-bootstrap keys enqueue off the
  // structural D1ClientError.network flag, which this error lacks).
  validateQuoteRow(row);
  await insertRows(client, 'quotes', QUOTE_COLUMNS, [row]);
  await insertRows(client, 'quote_items', ['quote_id', 'product_id', 'sides', 'qty'], items);
  await insertRows(client, 'quote_addons', ['quote_id', 'addon_id', 'qty'], addons);
  return { ok: true, id: row.id };
}

/**
 * Marks a quote's status. Validates against QUOTE_STATUSES first (a bad
 * value never reaches D1) and throws a Spanish error otherwise.
 *
 * @param {object} client - D1 client
 * @param {object} args
 * @param {string} args.id - quote UUID
 * @param {string} args.status - pending | accepted | rejected
 * @param {string} args.now - ISO-8601 timestamp for status_ts
 * @returns {Promise<{ok: boolean, id: string, status: string}>}
 */
async function updateQuoteStatus(client, { id, status, now }) {
  if (!QUOTE_STATUSES.includes(status)) {
    throw new Error(`Estado de presupuesto no válido: ${status}`);
  }
  await client.query('UPDATE quotes SET status = ?, status_ts = ? WHERE id = ?', [status, now, id]);
  return { ok: true, id, status };
}

// Reads rows of a child table for a set of quote ids, chunked under the
// bound-param cap. Empty id set → no query, empty result.
async function fetchByQuoteIds(client, table, ids) {
  if (ids.length === 0) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += MAX_BOUND_PARAMS) {
    const chunk = ids.slice(i, i + MAX_BOUND_PARAMS);
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await client.query(`SELECT * FROM ${table} WHERE quote_id IN (${placeholders})`, chunk);
    out.push(...(res.results || []));
  }
  return out;
}

/**
 * Fetches the raw rows the pure aggregator (lib/stats.js) needs: every
 * quote whose ts falls within [from, to], plus the line/addon rows of
 * exactly those quotes. No GROUP BY — the workshop's volume fits in
 * memory and the aggregation is done by a testable pure function.
 *
 * @param {object} client - D1 client
 * @param {object} range
 * @param {string} range.from - inclusive ISO lower bound
 * @param {string} range.to - inclusive ISO upper bound
 * @returns {Promise<{quotes: object[], items: object[], addons: object[]}>}
 */
async function fetchStatsData(client, { from, to }) {
  const quotesRes = await client.query('SELECT * FROM quotes WHERE ts >= ? AND ts <= ?', [from, to]);
  const quotes = quotesRes.results || [];
  const ids = quotes.map((q) => q.id);
  const items = await fetchByQuoteIds(client, 'quote_items', ids);
  const addons = await fetchByQuoteIds(client, 'quote_addons', ids);
  return { quotes, items, addons };
}

module.exports = {
  QUOTE_STATUSES,
  buildQuoteRows,
  validateQuoteRow,
  uploadQuote,
  updateQuoteStatus,
  fetchStatsData
};
