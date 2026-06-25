// ============================================================
// Quanto · Per-PC quote cache mirror
// ============================================================
// Persists the last good backend read to disk
// (<userData>/cache/quotes.json) so the history list loads fast
// and shows a last-known view when the backend is briefly
// unreachable (planes/v5-cloud-sync.md §7). Cache payload shape:
//   { fetchedAt, list, payloads }
// where `list` is an array of lightweight list rows (id, customer,
// total, status, date/ts) and `payloads` is a map keyed by quote
// id → the full reopenable quote record (avoids a round-trip on
// reopen when the cache is warm).
//
// This is NOT a write buffer — offline writes go through the
// outbox (lib/quote-outbox.js). This is a read mirror only.
//
// This is a store, so fs lives here (one place per concern —
// ARCHITECTURE.md §3); main-process only. Writes are atomic
// (.tmp + rename as the commit point), mirroring lib/catalog-cache.js
// and lib/quote-outbox.js.
//
// User-facing throw messages stay in Spanish (CLAUDE.md §6).
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Absolute path of the quote cache file inside the given userData directory.
 * Exported so callers and tests can locate the file without reimplementing
 * the path convention (mirrors outboxPathFor in lib/quote-outbox.js).
 *
 * @param {string} userDataDir
 * @returns {string}
 */
function quoteCachePathFor(userDataDir) {
  return path.join(userDataDir, 'cache', 'quotes.json');
}

/**
 * Writes the quote cache atomically: sibling `.tmp` + rename, so an
 * interrupted write never leaves a half-written cache behind.
 * Creates the parent directory on first write.
 *
 * @param {string} userDataDir
 * @param {{ fetchedAt: string, list: object[], payloads: object }} cache
 */
function writeQuoteCache(userDataDir, { fetchedAt, list, payloads }) {
  const filePath = quoteCachePathFor(userDataDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify({ fetchedAt, list, payloads }, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Reads the quote cache.
 * - Returns `null` when the file does not exist or is empty (cache never
 *   written yet, or cleared on purpose).
 * - Throws a Spanish error when the JSON is invalid (with `cause`) or
 *   parses to something that is not a valid cache payload (a corrupt cache
 *   must never be silently treated as an empty list — hard rule §4).
 *
 * Minimal shape check: the payload must be a non-null object with a `list`
 * array. A missing or `{}` `payloads` field is tolerated (optional).
 *
 * @param {string} userDataDir
 * @returns {{ fetchedAt: string, list: object[], payloads: object }|null}
 * @throws {Error} Spanish message when the cache is corrupt or wrong-shaped.
 */
function readQuoteCache(userDataDir) {
  const filePath = quoteCachePathFor(userDataDir);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (raw === '') return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Caché de presupuestos dañada: ' + filePath, { cause: err });
  }

  // Minimal shape check: must be a non-null object with a `list` array.
  // `payloads` is optional — a missing key is tolerated for forward compat.
  const validShape =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray(parsed.list);

  if (!validShape) {
    throw new Error('Caché de presupuestos dañada: ' + filePath);
  }

  return parsed;
}

module.exports = { quoteCachePathFor, writeQuoteCache, readQuoteCache };
