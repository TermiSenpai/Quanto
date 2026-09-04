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
const { QUOTE_STATUSES } = require('./cloud-quotes');
const { normalizeDepositPaid, withoutDepositPaid } = require('./quote-store-helpers');

const ID_PREFIX = 'PP';
// Bound the retry loop when EEXIST collisions stack up (astronomically
// unlikely in practice; acts as a safety net).
const MAX_ID_RETRIES = 20;

// Quote ids are interpolated into file paths and reach this module via the
// renderer-facing quotes:* IPC. Validate the shape before building any path
// so a malicious/buggy id like '..\\..\\settings' can never read or unlink a
// file outside the quotes folder (mirrors the spirit of lib/path-guard.js).
const ID_RE = /^PP-\d{4}-\d+$/;
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

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
      ...withoutDepositPaid(draft),
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
 * Idempotently writes a quote that ALREADY has its identity assigned —
 * the one-time migration primitive (B5) for carrying a pre-Phase-B PC's
 * legacy presupuestos.json into the shared folder. Unlike createQuote,
 * it preserves the quote's EXISTING id/date/version/updated_at verbatim
 * (no re-stamping) and writes `<folder>/<id>.json` with the exclusive
 * `wx` flag:
 *   - on success → { migrated: true },
 *   - on EEXIST  → { migrated: false } (an entry with that id is already
 *     in the shared store → idempotent skip, so re-runs and multi-PC
 *     boots never duplicate a quote).
 * A malformed id throws a Spanish error (the migration caller counts it
 * as `failed`); the size cap is enforced too.
 *
 * @param {string} folder
 * @param {object} quote - a full local-history quote (carries id/date/…)
 * @returns {{ migrated: boolean }}
 */
function putQuoteIfAbsent(folder, quote) {
  assertValidDraft(quote);
  if (!isValidId(quote.id)) {
    throw new Error('El presupuesto no tiene un identificador válido.');
  }
  const body = serializeOrThrow(quote); // size cap, before any IO
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }
  const filePath = path.join(folder, `${quote.id}.json`);
  try {
    fs.writeFileSync(filePath, body, { flag: 'wx', encoding: 'utf-8' });
    return { migrated: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { migrated: false };
    throw err;
  }
}

/**
 * Reads a quote by id.
 *
 * @param {string} folder
 * @param {string} id
 * @returns {{ quote: object, mtime: number, sha256: string } | null}
 */
function getQuote(folder, id) {
  if (!isValidId(id)) return null; // traversal guard: treat a bad id as absent
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
 * (status, status_ts, cloud_id, deposit_paid) from the stored entry
 * (same logic as lib/history.js replaceQuote).
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
  if (!isValidId(id)) return null; // traversal guard: a bad id is "unknown id"
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
    ...withoutDepositPaid(draft),
    // Pin identity
    id: existing.id,
    date: existing.date,
    // Pin workflow fields from existing (they may be undefined)
    status: existing.status,
    status_ts: existing.status_ts,
    cloud_id: existing.cloud_id,
    deposit_paid: existing.deposit_paid,
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
  if (merged.deposit_paid === undefined) delete merged.deposit_paid;

  const body = serializeOrThrow(merged);

  // Atomic overwrite via .tmp + rename
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, body, 'utf-8');
  fs.renameSync(tmpPath, filePath);

  return { quote: merged };
}

/**
 * Sets a quote's workflow status WITHOUT bumping its content `version`.
 * A status change is workflow, not a content edit (mirrors lib/history.js
 * updateQuote, which patched status without bumping version), so the
 * optimistic-concurrency token an open editor holds stays valid.
 *
 * Validates `status` against QUOTE_STATUSES (the same set the cloud row's
 * CHECK constraint allows) before any write — a bad status throws a
 * Spanish error and writes nothing. Atomic .tmp + rename overwrite.
 *
 * @param {string} folder
 * @param {string} id
 * @param {object} patch
 * @param {string} patch.status - pending | accepted | rejected
 * @param {string} [patch.status_ts] - ISO-8601 timestamp of the change
 * @returns {object | null}  the updated quote, or null when the id is absent
 */
function setStatus(folder, id, { status, status_ts } = {}) {
  if (!QUOTE_STATUSES.includes(status)) {
    throw new Error(`Estado de presupuesto no válido: ${status}`);
  }
  if (!isValidId(id)) return null; // traversal guard: treat a bad id as absent
  const filePath = path.join(folder, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const quote = JSON.parse(raw);
  quote.status = status;
  if (status_ts !== undefined) quote.status_ts = status_ts;
  // NOTE: version is deliberately NOT bumped — a status change is workflow.

  const body = serializeOrThrow(quote);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, body, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return quote;
}

/**
 * Records (or clears) the paid deposit ("señal") of a quote and flips its
 * workflow status in the SAME atomic write: paid → 'accepted', cleared →
 * 'pending' (design 2026-09-04 §4.1). Like setStatus this is workflow,
 * not a content edit: `version` is NOT bumped, so an open editor's
 * conflict token stays valid. The payment is validated before any IO.
 *
 * @param {string} folder
 * @param {string} id
 * @param {{amount:number, at:string, by?:(string|null)} | null} paid
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO timestamp for status_ts (default: now)
 * @returns {object | null} the updated quote, or null when the id is absent
 */
function setDepositPaid(folder, id, paid, opts = {}) {
  const clean = normalizeDepositPaid(paid); // throws a Spanish error on a bad amount
  if (!isValidId(id)) return null; // traversal guard: treat a bad id as absent
  const filePath = path.join(folder, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  const quote = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (clean) quote.deposit_paid = clean;
  else delete quote.deposit_paid;
  quote.status = clean ? 'accepted' : 'pending';
  quote.status_ts = opts.now || new Date().toISOString();
  // NOTE: version is deliberately NOT bumped — a deposit mark is workflow.

  const body = serializeOrThrow(quote);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, body, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return quote;
}

/**
 * Deletes a quote by id. Returns the removed quote or null.
 *
 * @param {string} folder
 * @param {string} id
 * @returns {object | null}
 */
function deleteQuote(folder, id) {
  if (!isValidId(id)) return null; // traversal guard: treat a bad id as absent
  const filePath = path.join(folder, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const quote = JSON.parse(raw);
  fs.unlinkSync(filePath);
  return quote;
}

module.exports = {
  MAX_QUOTE_BYTES,
  isValidId,
  createQuote,
  putQuoteIfAbsent,
  getQuote,
  listQuotes,
  searchQuotes,
  replaceQuote,
  setStatus,
  setDepositPaid,
  deleteQuote,
};
