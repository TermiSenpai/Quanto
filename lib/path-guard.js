// ============================================================
// PackPrice · IPC path allow-list
// ============================================================
// Several IPC handlers receive a filesystem path from the renderer
// and pass it straight to `fs`. A compromised renderer could ask
// main to read or overwrite arbitrary files. This module constrains
// renderer-supplied paths to a "blessed" set of config paths plus
// the sidecar files that legitimately live next to a config:
//
//   - the config.js itself (read/write/info/exists)
//   - its sibling `audit.log`        (audit:list)
//   - any file under its `backups/`  (future restore flows)
//
// The blessed set is the union of:
//   - the default candidate config path(s),
//   - the path stored in settings `config_path`,
//   - any path the user picks via the native dialog this session.
//
// The matcher is pure (allowed set in, candidate in → boolean) so it
// is unit-tested without Electron. main.js owns the mutable set and
// `assertConfigPathAllowed`, which throws a Spanish error on reject.
// ============================================================

'use strict';

const path = require('path');

/**
 * Normalizes a path for comparison: resolves to absolute and, on
 * Windows (case-insensitive FS), lowercases it. UNC paths and drive
 * letters both normalize cleanly through path.resolve.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizeForCompare(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Decides whether `candidate` is allowed given the blessed set of
 * config paths. A candidate is allowed when, for some blessed config
 * path C, it is:
 *   - C itself, OR
 *   - <dir(C)>/audit.log, OR
 *   - any file under <dir(C)>/backups/
 *
 * Pure: no IO. Symlinks are not resolved (we compare lexical resolved
 * paths); on this internal LAN tool with a trusted NAS that is an
 * acceptable trade-off and keeps the check non-blocking.
 *
 * @param {Iterable<string>} blessedConfigPaths
 * @param {string} candidate
 * @returns {boolean}
 */
function isPathAllowed(blessedConfigPaths, candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false;

  let cand;
  try {
    cand = normalizeForCompare(candidate);
  } catch (_) {
    return false;
  }

  for (const blessed of blessedConfigPaths) {
    if (typeof blessed !== 'string' || blessed === '') continue;
    let configPath;
    try {
      configPath = normalizeForCompare(blessed);
    } catch (_) {
      continue;
    }

    if (cand === configPath) return true;

    const dir = path.dirname(configPath);
    const auditPath = normalizeForCompare(path.join(dir, 'audit.log'));
    if (cand === auditPath) return true;

    const backupsDir = normalizeForCompare(path.join(dir, 'backups'));
    // Inside the backups/ directory (prefix match on the separator
    // boundary so `backups-evil` does not slip through).
    if (cand === backupsDir) return true;
    if (cand.startsWith(backupsDir + path.sep)) return true;
  }

  return false;
}

module.exports = {
  isPathAllowed,
  normalizeForCompare
};
