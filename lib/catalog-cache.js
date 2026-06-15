// ============================================================
// PackPrice · Local catalog cache store
// ============================================================
// Persists the last good cloud catalog to disk
// (%APPDATA%\packprice\cache\catalog.json — the caller owns the
// path) so the app can start read-only when Cloudflare is
// unreachable (planes/v5-cloud-sync.md §7). Payload shape:
//   { fetchedAt, catalogVersion, entities, versions? }
// where `entities` is the lib/catalog-assembler.js disassemble shape
// and the optional `versions` is the per-entity version map the
// renderer echoes back on save (plan 3B item 5).
//
// This is a store, so fs is allowed here (one place per concern —
// ARCHITECTURE.md §3); main-process only, mirrors the atomic-write
// pattern of lib/config-store.js (.tmp + rename as commit point).
// A corrupt cache throws loudly — never silently treated as data.
//
// User-facing throw messages stay in Spanish (CLAUDE.md §6).
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Reads the cached catalog. null when the file does not exist
 * (first cloud boot, or cache never written yet).
 *
 * @param {string} filePath
 * @returns {{fetchedAt: string, catalogVersion: number, entities: object}|null}
 * @throws {Error} Spanish message when the JSON is invalid (with
 *   cause) or parses to something that is not a catalog payload
 */
function readCache(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Caché de catálogo dañada: ' + filePath, { cause: err });
  }
  // Minimal shape check: valid JSON that is not a catalog payload
  // (truncated by hand, foreign file…) is just as corrupt as bad JSON.
  const validShape =
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.entities === 'object' &&
    parsed.entities !== null &&
    typeof parsed.catalogVersion === 'number';
  if (!validShape) {
    throw new Error('Caché de catálogo dañada: ' + filePath);
  }
  return parsed;
}

/**
 * Writes the cached catalog atomically: sibling `.tmp` + rename, so
 * an interrupted write never leaves a half-written cache behind.
 * Creates the parent directory on first write.
 *
 * @param {string} filePath
 * @param {{fetchedAt: string, catalogVersion: number, entities: object, versions?: object}} payload
 */
function writeCache(filePath, { fetchedAt, catalogVersion, entities, versions }) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp';
  // `versions` is optional: when undefined JSON.stringify drops the key,
  // so a versionless write round-trips identically to the legacy shape.
  fs.writeFileSync(tmpPath, JSON.stringify({ fetchedAt, catalogVersion, entities, versions }, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

module.exports = { readCache, writeCache };
