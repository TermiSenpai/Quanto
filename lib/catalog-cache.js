// ============================================================
// PackPrice · Local catalog cache store
// ============================================================
// Persists the last good cloud catalog to disk
// (%APPDATA%\packprice\cache\catalog.json — the caller owns the
// path) so the app can start read-only when Cloudflare is
// unreachable (planes/v5-cloud-sync.md §7). Payload shape:
//   { fetchedAt, catalogVersion, entities }
// where `entities` is the lib/catalog-assembler.js disassemble shape.
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
 * @throws {Error} Spanish message with cause when the JSON is invalid
 */
function readCache(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Caché de catálogo dañada: ' + filePath, { cause: err });
  }
}

/**
 * Writes the cached catalog atomically: sibling `.tmp` + rename, so
 * an interrupted write never leaves a half-written cache behind.
 * Creates the parent directory on first write.
 *
 * @param {string} filePath
 * @param {{fetchedAt: string, catalogVersion: number, entities: object}} payload
 */
function writeCache(filePath, { fetchedAt, catalogVersion, entities }) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify({ fetchedAt, catalogVersion, entities }, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

module.exports = { readCache, writeCache };
