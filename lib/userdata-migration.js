'use strict';

// One-time, idempotent migration of the per-PC userData folder after the
// PackPrice → Quanto rename (CLAUDE.md §2 brand debate). Electron derives
// `app.getPath('userData')` from the product name, so renaming PackPrice →
// Quanto moves the folder from %APPDATA%\PackPrice to %APPDATA%\Quanto.
// Without this, existing users would lose settings.json (NAS path + cloud
// token), the local quote history (presupuestos.json) and the offline outbox.
//
// Pure of Electron (paths are injected) so it is unit-testable. The legacy
// folder is COPIED, never moved/deleted, so it stays as a safety net.

const fs = require('fs');
const path = require('path');

/**
 * Copies the legacy userData folder into the current one exactly once.
 *
 * Idempotent and conservative: it acts ONLY when the current folder has not
 * been initialized yet (no settings.json) and the legacy folder exists with a
 * settings.json. Any later run, a fresh install, or a same-folder case (e.g.
 * a future rename back) is a no-op.
 *
 * @param {object} opts
 * @param {string} opts.currentDir  Target userData dir (e.g. %APPDATA%\Quanto).
 * @param {string} opts.legacyDir   Legacy userData dir (e.g. %APPDATA%\PackPrice).
 * @param {object} [opts.fsImpl]    Injectable fs (defaults to node:fs).
 * @param {function} [opts.onMigrated] Called with { from, to } on success.
 * @param {function} [opts.onError]    Called with the Error on failure.
 * @returns {boolean} true if a migration was performed.
 */
function migrateLegacyUserData({ currentDir, legacyDir, fsImpl = fs, onMigrated, onError } = {}) {
  try {
    if (!currentDir || !legacyDir) return false;
    // Same folder (Windows FS is case-insensitive): nothing to migrate.
    if (path.resolve(currentDir).toLowerCase() === path.resolve(legacyDir).toLowerCase()) {
      return false;
    }
    // Current PC already running the new brand → don't overwrite its data.
    if (fsImpl.existsSync(path.join(currentDir, 'settings.json'))) return false;
    // Nothing from the old brand to carry over.
    if (!fsImpl.existsSync(path.join(legacyDir, 'settings.json'))) return false;

    fsImpl.cpSync(legacyDir, currentDir, { recursive: true });
    if (onMigrated) onMigrated({ from: legacyDir, to: currentDir });
    return true;
  } catch (err) {
    // Non-blocking: a failed migration must never stop the app from booting.
    // The legacy folder is untouched, so the user can recover manually.
    if (onError) onError(err);
    return false;
  }
}

module.exports = { migrateLegacyUserData };
