// ============================================================
// Quanto · File-backend quote repository
// ============================================================
// CRUD over a per-folder store: one <id>.json per quote.
// The folder lives next to config.js:
//   path.join(path.dirname(configPath), 'presupuestos')
//
// This module is main-process only. The renderer NEVER imports it.
//
// Design mirrors lib/history.js conventions:
//   - Atomic writes (.tmp → rename)
//   - PP-YYYY-NNNN ids, per-year counter, wx-flag exclusive create
//   - MAX_QUOTE_BYTES cap (re-exported from lib/history.js)
//   - Spanish user-facing error messages; English code/comments
//   - Injectable `now` for deterministic tests
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MAX_QUOTE_BYTES } = require('./history');

const ID_PREFIX = 'PP';
// Bound the retry loop when EEXIST collisions stack up (astronomically
// unlikely in practice; acts as a safety net).
const MAX_ID_RETRIES = 20;

// ── id helpers ────────────────────────────────────────────────

/**
 * Scans the folder for existing PP-YYYY-NNNN filenames and returns the
 * next sequential id for the given year. Pure: given the same folder
 * state it always returns the same result.
 *
 * @param {string} folder
 * @param {number} year
 * @returns {string}  e.g. 'PP-2026-0004'
 */
function nextIdForYear(folder, year) {
  const prefix = `${ID_PREFIX}-${year}-`;
  let max = 0;
  let entries;
  try {
    entries = fs.readdirSync(folder);
  } catch (_) {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const stem = entry.slice(0, -5); // strip .json
    if (!stem.startsWith(prefix)) continue;
    const tail = stem.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(4, '0');
}

// ── size / serialization guards ───────────────────────────────

function assertValidDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('El presupuesto debe ser un objeto.');
  }
}

function serializeOrThrow(obj) {
  let s;
  try {
    s = JSON.stringify(obj, null, 2);
  } catch (_) {
    throw new Error('El presupuesto no se puede serializar.');
  }
  if (s === undefined || Buffer.byteLength(s, 'utf-8') > MAX_QUOTE_BYTES) {
    throw new Error('El presupuesto es demasiado grande.');
  }
  return s;
}

// ── public API ────────────────────────────────────────────────

/**
 * Creates a new quote in `folder`. Assigns a PP-YYYY-NNNN id using
 * the exclusive `wx` flag so two concurrent creates for the same id
 * never collide. On EEXIST, recomputes the next id and retries up to
 * MAX_ID_RETRIES times.
 *
 * @param {string} folder
 * @param {object} draft   everything except id/date/version/updated_at
 * @param {object} [opts]
 * @param {Date}   [opts.now]  injectable for tests
 * @returns {object}  the saved quote
 */
function createQuote(folder, draft, opts = {}) {
  assertValidDraft(draft);
  const serializedDraft = serializeOrThrow(draft); // size check on draft
  void serializedDraft; // we'll re-serialize the full record below

  const now = opts.now || new Date();
  const isoNow = now.toISOString();
  const year = now.getFullYear();

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }

  for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
    const id = nextIdForYear(folder, year);
    const filePath = path.join(folder, `${id}.json`);
    const record = {
      id,
      date: isoNow,
      version: 1,
      updated_at: isoNow,
      ...draft,
    };
    const body = serializeOrThrow(record); // full-record size check
    try {
      fs.writeFileSync(filePath, body, { flag: 'wx', encoding: 'utf-8' });
      return record;
    } catch (err) {
      if (err.code === 'EEXIST') {
        // Another writer grabbed this id; loop and try the next one.
        continue;
      }
      throw err;
    }
  }
  throw new Error('No se pudo asignar un identificador único al presupuesto.');
}

/**
 * Reads a quote by id.
 *
 * @param {string} folder
 * @param {string} id
 * @returns {{ quote: object, mtime: number, sha256: string } | null}
 */
function getQuote(folder, id) {
  const filePath = path.join(folder, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath);
  const mtime = fs.statSync(filePath).mtimeMs;
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const quote = JSON.parse(raw.toString('utf-8'));
  return { quote, mtime, sha256 };
}

/**
 * Lists all quotes in the folder, sorted newest-first by `date`.
 * Corrupt JSON files are skipped and logged (never crash the list).
 *
 * @param {string} folder
 * @param {object} [opts]
 * @param {Function} [opts.log]  default: console.warn
 * @returns {object[]}
 */
function listQuotes(folder, opts = {}) {
  const log = opts.log || console.warn;
  let entries;
  try {
    entries = fs.readdirSync(folder);
  } catch (_) {
    return [];
  }
  const quotes = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(folder, entry);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      quotes.push(parsed);
    } catch (err) {
      log(`[quote-repo-file] Archivo de presupuesto corrupto omitido: ${entry} — ${err.message}`);
    }
  }
  return quotes.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/**
 * Substring search over id, user, customer.name, customer.phone.
 * Case-insensitive. Empty query returns all (sorted newest-first).
 *
 * @param {string} folder
 * @param {string} query
 * @param {object} [opts]  forwarded to listQuotes (e.g. { log })
 * @returns {object[]}
 */
function searchQuotes(folder, query, opts = {}) {
  const all = listQuotes(folder, opts);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter(quote => {
    const haystack = [
      quote.id,
      quote.user,
      quote.customer?.name,
      quote.customer?.phone,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Replaces an existing quote. Pins id + date from the stored file,
 * bumps version, sets updated_at to now. Preserves workflow fields
 * (status, status_ts, cloud_id) from the stored entry (same logic as
 * lib/history.js replaceQuote).
 *
 * Conflict detection: if `expected` ({ mtime, sha256 }) is supplied,
 * re-reads the file and compares; if it changed → returns
 * { conflict: true } without writing.
 *
 * @param {string} folder
 * @param {string} id
 * @param {object} draft
 * @param {{ mtime?: number, sha256?: string } | null} expected
 *   conflict token from getQuote; pass null to skip the check
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @returns {{ quote: object } | { conflict: true } | null}
 *   null when the id is not found
 */
function replaceQuote(folder, id, draft, expected, opts = {}) {
  assertValidDraft(draft);
  const filePath = path.join(folder, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  // Conflict check
  if (expected) {
    const raw = fs.readFileSync(filePath);
    const currentMtime = fs.statSync(filePath).mtimeMs;
    const currentSha = crypto.createHash('sha256').update(raw).digest('hex');
    const mtimeChanged = expected.mtime !== undefined && currentMtime !== expected.mtime;
    const shaChanged = expected.sha256 !== undefined && currentSha !== expected.sha256;
    if (mtimeChanged || shaChanged) {
      return { conflict: true };
    }
  }

  // Read existing to pin identity + workflow fields
  const raw = fs.readFileSync(filePath, 'utf-8');
  const existing = JSON.parse(raw);
  const now = opts.now || new Date();

  const merged = {
    ...draft,
    // Pin identity
    id: existing.id,
    date: existing.date,
    // Pin workflow fields from existing (they may be undefined)
    status: existing.status,
    status_ts: existing.status_ts,
    cloud_id: existing.cloud_id,
    // Bump revision
    version: (Number.isFinite(existing.version) ? existing.version : 1) + 1,
    updated_at: now.toISOString(),
  };

  // Handle status: if existing had none, fall back to the draft's value
  if (merged.status === undefined) {
    if (draft.status !== undefined) merged.status = draft.status;
    else delete merged.status;
  }
  if (merged.status_ts === undefined) delete merged.status_ts;
  if (merged.cloud_id === undefined) delete merged.cloud_id;

  const body = serializeOrThrow(merged);

  // Atomic overwrite via .tmp + rename
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, body, 'utf-8');
  fs.renameSync(tmpPath, filePath);

  return { quote: merged };
}

/**
 * Deletes a quote by id. Returns the removed quote or null.
 *
 * @param {string} folder
 * @param {string} id
 * @returns {object | null}
 */
function deleteQuote(folder, id) {
  const filePath = path.join(folder, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const quote = JSON.parse(raw);
  fs.unlinkSync(filePath);
  return quote;
}

module.exports = {
  MAX_QUOTE_BYTES,
  createQuote,
  getQuote,
  listQuotes,
  searchQuotes,
  replaceQuote,
  deleteQuote,
};
