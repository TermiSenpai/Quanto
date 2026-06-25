// ============================================================
// Quanto · Quote-store pure helpers
// ============================================================
// Small, side-effect-free helpers shared by main.js's quote-repo
// selector (the uniform backend façade routing the quotes:* IPC).
// Kept out of main.js so they are unit-testable without Electron.
//
// Main-process only (it is required from main and the cloud drain);
// the renderer NEVER imports it.
// ============================================================

'use strict';

const path = require('node:path');

// A provisional id stamped on a quote CREATED while offline: it cannot
// call the backend's id allocator, so it gets a clearly-not-real id the
// cache/renderer can display until the outbox drain assigns the real
// PP-YYYY-NNNN one. The prefix is deliberately distinct from the real
// `PP-YYYY-NNNN` shape so isValidId (lib/quote-repo-*.js) treats it as
// "not a real id" and a human reading the list sees it is pending.
const PENDING_ID_PREFIX = 'PP-PENDING-';

/**
 * The quotes folder lives next to config.js (file mode):
 *   path.join(path.dirname(configPath), 'presupuestos')
 * Pure; mirrors the path convention lib/quote-repo-file.js documents.
 *
 * @param {string} cfgPath - the config.js path from settings.config_path
 * @returns {string}
 */
function quotesFolder(cfgPath) {
  return path.join(path.dirname(cfgPath), 'presupuestos');
}

/**
 * True when `id` is a provisional offline-create id (PP-PENDING-…), i.e.
 * a quote that still needs a real id assigned on the next successful sync.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isPendingId(id) {
  return typeof id === 'string' && id.startsWith(PENDING_ID_PREFIX);
}

/**
 * Builds a fresh provisional id. Injectable randomness keeps it testable.
 *
 * @param {() => string} [uuid] - a uuid source (defaults to crypto.randomUUID)
 * @returns {string} e.g. 'PP-PENDING-3f1c…'
 */
function newPendingId(uuid) {
  const gen = uuid || (() => require('node:crypto').randomUUID());
  return PENDING_ID_PREFIX + gen();
}

module.exports = { PENDING_ID_PREFIX, quotesFolder, isPendingId, newPendingId };
