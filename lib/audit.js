// ============================================================
// PackPrice · Append-only audit log for admin config changes
// ============================================================
// Each successful `config:write` appends one JSON Lines record
// to <NAS>/audit.log next to the config.js. The file is plain
// text — one JSON object per line — so it is greppable from any
// shell and survives partial writes (each line is its own atom).
//
// Why JSON Lines:
//   - Append-only: O(1) writes, no parse-rewrite of the whole file.
//   - Recoverable: a corrupt line only loses that line.
//   - Easy to ship to ELK/Loki later if the workshop ever grows.
//
// Schema per record:
//   {
//     "ts":       "2026-05-11T14:32:00.000Z",  // ISO 8601 UTC
//     "usuario":  "Alberto",                    // who saved
//     "app_version": "2.0.0-beta",              // for forensics
//     "cambios":  [                             // list from lib/diff.js
//       { "path": "parametros.iva", "before": 0.21, "after": 0.23, "kind": "change" }
//     ]
//   }
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_FILE_NAME = 'audit.log';

/**
 * Returns the audit log path next to the given config.js path.
 *
 * @param {string} configPath absolute path to config.js
 * @returns {string}
 */
function auditPathFor(configPath) {
  return path.join(path.dirname(configPath), AUDIT_FILE_NAME);
}

/**
 * Appends one entry to the audit log. No-op when `changes` is empty
 * (we never want noisy entries with zero diff).
 *
 * @param {string} configPath  path to config.js (audit lives next to it)
 * @param {object} entry
 * @param {string} entry.usuario
 * @param {string} [entry.app_version]
 * @param {Array}  entry.cambios            output of diffObjects
 * @param {string} [entry.ts]               override timestamp (testing)
 * @returns {{ written: boolean, path: string }}
 */
function appendAuditEntry(configPath, entry) {
  if (!entry || !Array.isArray(entry.cambios) || entry.cambios.length === 0) {
    return { written: false, path: auditPathFor(configPath) };
  }
  const filePath = auditPathFor(configPath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const record = {
    ts: entry.ts || new Date().toISOString(),
    usuario: typeof entry.usuario === 'string' ? entry.usuario : 'desconocido',
    app_version: entry.app_version || null,
    cambios: entry.cambios
  };
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
  return { written: true, path: filePath };
}

/**
 * Reads the last N entries (newest last). Lines that fail to parse
 * are skipped silently — a corrupt line should not bring the viewer
 * down. Returns oldest-to-newest within the slice.
 *
 * @param {string} configPath
 * @param {number} [limit=200]
 * @returns {Array<object>}
 */
function readRecentEntries(configPath, limit = 200) {
  const filePath = auditPathFor(configPath);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.max(1, limit));
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      // ignore the broken line
    }
  }
  return out;
}

module.exports = {
  appendAuditEntry,
  readRecentEntries,
  auditPathFor,
  AUDIT_FILE_NAME
};
