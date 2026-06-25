// ============================================================
// Quanto · Cloud quotes data access (upload, status, stats rows)
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

// ============================================================
// Phase B · full reopenable quotes (quote_payloads table)
// ============================================================
// The flat `quotes` row (above) keeps feeding stats and owns the
// authoritative status/status_ts. The `quote_payloads` table
// (db/migrations/0002_quote_payloads.sql) stores the full reopenable
// JSON (opt + result + totals + customer …) plus an optimistic-
// concurrency `version`. saveFullQuote writes both; updateFullQuote
// guards the payload UPDATE with WHERE version = expectedVersion and
// then refreshes the flat stat columns so statistics stay correct.

// Human-id prefix, mirroring the file backend (lib/quote-repo-file.js).
const QUOTE_ID_PREFIX = 'PP';

// The flat stat columns updateFullQuote refreshes from the new payload,
// in a fixed order so the UPDATE is deterministic. status/status_ts are
// deliberately excluded — they are owned by updateQuoteStatus and stay
// authoritative on the flat row.
const STAT_COLUMNS = [
  'ts', 'user', 'client_name', 'client_phone', 'valid_until',
  'pack_id', 'tier', 'total_units', 'qty_3xl', 'qty_4xl', 'qty_5xl',
  'total_vat_inc', 'sale_base', 'margin_pct', 'target_margin',
  'pvp_deviation_pct', 'catalog_version'
];

/**
 * Creates (first save) a full quote: the flat `quotes` row (INSERT OR
 * IGNORE on the human-id PK, exactly like uploadQuote) plus the full
 * reopenable payload (INSERT OR REPLACE, version 1). Idempotent on the
 * human-id PK, so an outbox retry of the SAME quote is a harmless no-op
 * rather than a duplicate. Edits go through updateFullQuote (which owns
 * the version guard) — this is why the payload version is always 1 here.
 *
 * Cross-device id-collision retry is NOT handled here (that is B7, via
 * nextCloudQuoteId + a claiming insert): saveFullQuote assumes the id is
 * already assigned and only needs to be idempotent against its own retry.
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} quote - the canonical reopenable quote (CLAUDE.md §9)
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO-8601 timestamp for quote_payloads.updated_at
 * @returns {Promise<{ok: boolean, id: string}>}
 */
async function saveFullQuote(client, quote, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const { quote: row, items, addons } = buildQuoteRows(quote);
  // Validate BEFORE any network call (fail-fast, non-network error) so a
  // malformed quote never poisons the offline outbox — same contract as
  // uploadQuote.
  validateQuoteRow(row);
  await insertRows(client, 'quotes', QUOTE_COLUMNS, [row]);
  await insertRows(client, 'quote_items', ['quote_id', 'product_id', 'sides', 'qty'], items);
  await insertRows(client, 'quote_addons', ['quote_id', 'addon_id', 'qty'], addons);
  await client.query(
    'INSERT OR REPLACE INTO quote_payloads (quote_id, payload, version, updated_at) VALUES (?, ?, 1, ?)',
    [row.id, JSON.stringify(quote), now]
  );
  return { ok: true, id: row.id };
}

/**
 * Reads a full reopenable quote: the JSON payload from quote_payloads,
 * with the authoritative status/status_ts overlaid from the flat
 * `quotes` row (the flat row is the source of truth for status — it is
 * what updateQuoteStatus mutates). Returns null when the payload row is
 * absent. A corrupt payload throws a Spanish error (no silent swallow).
 *
 * @param {object} client - D1 client
 * @param {string} id - the human quote id (PP-YYYY-NNNN)
 * @returns {Promise<object|null>}
 */
async function getFullQuote(client, id) {
  const payloadRes = await client.query(
    'SELECT payload, version FROM quote_payloads WHERE quote_id = ?', [id]
  );
  const payloadRow = (payloadRes.results || [])[0];
  if (!payloadRow) return null;

  let quote;
  try {
    quote = JSON.parse(payloadRow.payload);
  } catch (err) {
    throw new Error(`No se pudo leer el presupuesto «${id}»: datos dañados`, { cause: err });
  }

  // Overlay the authoritative version + status from the flat row.
  const flatRes = await client.query(
    'SELECT status, status_ts FROM quotes WHERE id = ?', [id]
  );
  const flatRow = (flatRes.results || [])[0];
  quote.version = payloadRow.version;
  if (flatRow) {
    quote.status = flatRow.status;
    quote.status_ts = flatRow.status_ts;
  }
  return quote;
}

/**
 * Lists quotes from the flat `quotes` columns only — the list view needs
 * id, client_name, total_vat_inc, status and ts, never the full payload.
 *
 * @param {object} client - D1 client
 * @returns {Promise<object[]>}
 */
async function listFullQuotes(client) {
  const res = await client.query(
    'SELECT id, client_name, total_vat_inc, status, ts FROM quotes ORDER BY ts DESC'
  );
  return res.results || [];
}

/**
 * Edits an existing full quote with optimistic concurrency. The payload
 * UPDATE is guarded by WHERE version = expectedVersion: if no row matches
 * (changes === 0) another device already edited it → returns
 * { conflict: true } and the flat row is left untouched. On success the
 * payload version bumps to expectedVersion + 1 and the flat `quotes`
 * stat columns are refreshed from the new payload so statistics stay
 * correct. The payload UPDATE runs FIRST so a conflict never half-writes.
 *
 * @param {object} client - D1 client
 * @param {string} id - the human quote id
 * @param {object} payload - the new canonical reopenable quote
 * @param {number} expectedVersion - the version the caller last read
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO-8601 timestamp for updated_at
 * @returns {Promise<{quote: object, version: number} | {conflict: true}>}
 */
async function updateFullQuote(client, id, payload, expectedVersion, opts = {}) {
  const now = opts.now || new Date().toISOString();
  // Build + validate the flat row first so a malformed payload fails fast
  // (non-network) before any write touches D1.
  const { quote: row } = buildQuoteRows(payload);
  validateQuoteRow(row);

  const updRes = await client.query(
    'UPDATE quote_payloads SET payload = ?, version = version + 1, updated_at = ? WHERE quote_id = ? AND version = ?',
    [JSON.stringify(payload), now, id, expectedVersion]
  );
  if (((updRes.meta && updRes.meta.changes) || 0) === 0) {
    return { conflict: true };
  }

  // Payload write won; refresh the flat stat columns (status/status_ts
  // are intentionally not touched — they stay authoritative on the row).
  const setClause = STAT_COLUMNS.map((col) => `${col} = ?`).join(', ');
  await client.query(
    `UPDATE quotes SET ${setClause} WHERE id = ?`,
    [...STAT_COLUMNS.map((col) => row[col]), id]
  );

  const nextVersion = expectedVersion + 1;
  return { quote: { ...payload, id, version: nextVersion, updated_at: now }, version: nextVersion };
}

/**
 * Computes the next human quote id (PP-YYYY-NNNN) for a year by reading
 * the existing ids for that year and returning max + 1. Pure-ish helper
 * (one SELECT): the caller (B7) inserts with this id as the PK and
 * retries on a UNIQUE failure — mirroring the file backend's exclusive
 * `wx` create (lib/quote-repo-file.js nextIdForYear).
 *
 * @param {object} client - D1 client
 * @param {number} year
 * @returns {Promise<string>} e.g. 'PP-2026-0004'
 */
async function nextCloudQuoteId(client, year) {
  const prefix = `${QUOTE_ID_PREFIX}-${year}-`;
  const res = await client.query('SELECT id FROM quotes WHERE id LIKE ?', [prefix + '%']);
  let max = 0;
  for (const r of res.results || []) {
    if (typeof r.id !== 'string' || !r.id.startsWith(prefix)) continue;
    const n = parseInt(r.id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(4, '0');
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
  fetchStatsData,
  saveFullQuote,
  getFullQuote,
  listFullQuotes,
  updateFullQuote,
  nextCloudQuoteId
};
