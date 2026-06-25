// ============================================================
// Quanto · Cloud-backend quote repository façade
// ============================================================
// The cloud-mode parallel of lib/quote-repo-file.js: it exposes the
// SAME interface and return shapes, but takes an injected D1 `client`
// instead of a `folder`, and is backed by the customer's own D1
// database via the lib/cloud-quotes.js ops.
//
// This module is ORCHESTRATION ONLY — it contains NO raw SQL. All
// quotes/quote_payloads SQL lives in lib/cloud-quotes.js (one place per
// concern — ARCHITECTURE.md §3). A later task (B4b) writes the main.js
// selector that routes the quotes:* IPC to either backend uniformly,
// and owns offline/outbox handling; here we just talk to the client and
// let errors propagate (no silent swallow — CLAUDE.md hard rule §4).
//
// This module is main-process only. The renderer NEVER imports it.
//
// User-facing throw messages stay in Spanish (CLAUDE.md §6).
// ============================================================

'use strict';

const {
  tryClaimFullQuote,
  getFullQuote,
  listFullQuotes,
  updateFullQuote,
  deleteFullQuote,
  updateQuoteStatus,
  nextCloudQuoteId,
} = require('./cloud-quotes');

// Bound the id-claim retry loop when cross-device collisions stack up
// (astronomically unlikely in practice; the cloud parallel of the file
// backend's MAX_ID_RETRIES safety net).
const MAX_ID_RETRIES = 20;

// Quote ids reach this module via the renderer-facing quotes:* IPC and are
// interpolated into D1 statements as bound params. Validate the shape so a
// malicious/buggy id is treated as "absent" rather than reaching the client
// (mirrors lib/quote-repo-file.js's isValidId — same regex).
const ID_RE = /^PP-\d{4}-\d+$/;
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function assertValidDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('El presupuesto debe ser un objeto.');
  }
}

// Reads a version number from an `expected` conflict token. The token may be
// a number (the opaque cloud token), an object carrying `version`, or null.
function versionFrom(expected) {
  if (expected === null || expected === undefined) return undefined;
  if (typeof expected === 'number') return expected;
  if (typeof expected === 'object' && typeof expected.version === 'number') {
    return expected.version;
  }
  return undefined;
}

/**
 * Creates a new quote. Assigns a fresh PP-YYYY-NNNN id with collision-safe
 * retry — the cloud parallel of the file backend's exclusive `wx` create:
 * nextCloudQuoteId computes the next id, tryClaimFullQuote atomically claims
 * it (INSERT OR IGNORE on the payload PK), and on a lost race (another device
 * grabbed the id) we recompute and retry up to MAX_ID_RETRIES.
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} draft - everything except id/date/version/updated_at
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO-8601 timestamp, injectable for tests
 * @returns {Promise<object>} the saved quote (id, date, version:1, updated_at + draft)
 */
async function createQuote(client, draft, opts = {}) {
  assertValidDraft(draft);

  const isoNow = opts.now || new Date().toISOString();
  const year = new Date(isoNow).getFullYear();

  for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
    const id = await nextCloudQuoteId(client, year);
    const record = {
      ...draft,
      id,
      date: isoNow,
      version: 1,
      updated_at: isoNow,
    };
    const { claimed } = await tryClaimFullQuote(client, record, { now: isoNow });
    if (claimed) return record;
    // Lost the race for this id (another device claimed it); recompute + retry.
  }
  throw new Error('No se pudo asignar un identificador único al presupuesto.');
}

/**
 * Reads a quote by id. Returns { quote, version } — the version is the cloud
 * conflict token (also present inside quote.version). The file backend returns
 * { quote, mtime, sha256 }; main.js (B4b) normalizes both into an opaque token.
 *
 * @param {object} client - D1 client
 * @param {string} id
 * @returns {Promise<{ quote: object, version: number } | null>}
 */
async function getQuote(client, id) {
  if (!isValidId(id)) return null; // shape guard: treat a bad id as absent
  const quote = await getFullQuote(client, id);
  if (!quote) return null;
  return { quote, version: quote.version };
}

/**
 * Lists all quotes as renderer-friendly list rows, newest-first. Reads only
 * the flat `quotes` columns (no payload fetch): the history list renders from
 * id/date/user/customer.name/pack/total/status alone.
 *
 * @param {object} client - D1 client
 * @returns {Promise<object[]>}
 */
async function listQuotes(client) {
  const rows = await listFullQuotes(client);
  const list = rows.map((row) => ({
    id: row.id,
    date: row.ts,
    user: row.user,
    customer: { name: row.client_name },
    total_vat_inc: row.total_vat_inc,
    status: row.status,
    pack_id: row.pack_id,
  }));
  // listFullQuotes orders by ts DESC, but re-sort defensively so the contract
  // (newest-first) holds regardless of the backend's ordering.
  return list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/**
 * Substring search over the list projection (id, user, customer.name).
 * Case-insensitive. Empty query returns all (newest-first). client_phone is
 * not in the list projection, so this matches what is present (the file
 * backend additionally matches customer.phone from the full record).
 *
 * @param {object} client - D1 client
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function searchQuotes(client, query) {
  const all = await listQuotes(client);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter((quote) => {
    const haystack = [
      quote.id,
      quote.user,
      quote.customer && quote.customer.name,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Replaces an existing quote with optimistic concurrency. Pins id + date from
 * the stored record and PRESERVES status/status_ts (edits don't change
 * workflow state — mirrors lib/quote-repo-file.js replaceQuote and
 * lib/history.js); sets updated_at to now; takes the rest from the draft.
 *
 * Conflict detection: the underlying payload UPDATE is guarded by
 * WHERE version = expectedVersion; on a mismatch nothing is written and
 * { conflict: true } is returned.
 *
 * @param {object} client - D1 client
 * @param {string} id
 * @param {object} draft
 * @param {number|{version:number}|null} expected - conflict token from getQuote;
 *   null/absent falls back to the stored record's version
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO-8601 timestamp
 * @returns {Promise<{ quote: object } | { conflict: true } | null>}
 *   null when the id is unknown (or shape-invalid)
 */
async function replaceQuote(client, id, draft, expected, opts = {}) {
  assertValidDraft(draft);
  if (!isValidId(id)) return null; // shape guard: a bad id is "unknown id"

  const existing = await getFullQuote(client, id);
  if (!existing) return null;

  const isoNow = opts.now || new Date().toISOString();
  const merged = {
    ...draft,
    // Pin identity from the stored record
    id: existing.id,
    date: existing.date,
    // Preserve workflow state from the stored record (an edit never changes it)
    status: existing.status,
    status_ts: existing.status_ts,
    updated_at: isoNow,
  };

  const expectedVersion = versionFrom(expected) ?? existing.version;
  // updateFullQuote takes the payload OBJECT (it builds the flat row via
  // buildQuoteRows and JSON-stringifies it internally — lib/cloud-quotes.js).
  const res = await updateFullQuote(client, id, merged, expectedVersion, { now: isoNow });
  if (res.conflict) return { conflict: true };
  merged.version = res.version;
  return { quote: merged };
}

/**
 * Sets a quote's workflow status. The flat `quotes` row is authoritative
 * for status (getFullQuote overlays it onto the payload), so we mutate it
 * directly via updateQuoteStatus — there is no payload `version` bump,
 * mirroring the file backend's setStatus (a status change is workflow, not
 * a content edit). updateQuoteStatus validates the status against
 * QUOTE_STATUSES before any network write.
 *
 * Honors the SAME updated|null contract as lib/quote-repo-file.js setStatus:
 * the guarded UPDATE reports `changes` — 0 means the id is unknown, so we
 * return null (the UPDATE is unguarded by existence, so without this a bad
 * id would falsely report success). On a real change we re-fetch the
 * overlaid quote so the caller gets the full record in both modes.
 *
 * @param {object} client - D1 client
 * @param {string} id
 * @param {string} status - pending | accepted | rejected
 * @param {string} now - ISO-8601 timestamp for status_ts
 * @returns {Promise<object | null>} the updated quote, or null when absent
 */
async function setStatus(client, id, status, now) {
  if (!isValidId(id)) return null; // shape guard: treat a bad id as absent
  const res = await updateQuoteStatus(client, { id, status, now });
  if ((res.changes || 0) === 0) return null; // unknown id → not found
  return getFullQuote(client, id);
}

/**
 * Deletes a quote by id. Reads it first (so the removed quote can be returned),
 * then deletes it across its tables. Returns the removed quote or null when the
 * id is unknown (or shape-invalid).
 *
 * @param {object} client - D1 client
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function deleteQuote(client, id) {
  if (!isValidId(id)) return null; // shape guard: treat a bad id as absent
  const quote = await getFullQuote(client, id);
  if (!quote) return null;
  await deleteFullQuote(client, id);
  return quote;
}

module.exports = {
  createQuote,
  getQuote,
  listQuotes,
  searchQuotes,
  replaceQuote,
  setStatus,
  deleteQuote,
};
