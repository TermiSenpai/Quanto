// ============================================================
// Quanto · Quote-store pure helpers
// ============================================================
// Small, side-effect-free helpers shared by main.js's quote-repo
// selector (the uniform backend façade routing the quotes:* IPC), and
// by both quote backends (lib/quote-repo-file.js, lib/quote-repo-cloud.js):
// normalizeDepositPaid validates the paid-deposit ("señal") fact and
// withoutDepositPaid strips it from an inbound draft (it is workflow,
// set only via setDepositPaid — never smuggled in on create/edit).
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

/**
 * Validates the paid-deposit ("señal") fact both backends persist —
 * design 2026-09-04 §4.1. `null`/`undefined` mean "not paid" and pass
 * through as null. Otherwise `amount` must be a finite number > 0
 * (rounded to cents), `at` a parsable ISO timestamp and `by` a string
 * or null. Throws a Spanish error BEFORE any IO so a bad amount never
 * reaches a file or D1.
 *
 * @param {{amount:number, at:string, by?:(string|null)} | null | undefined} paid
 * @returns {{amount:number, at:string, by:(string|null)} | null}
 */
function normalizeDepositPaid(paid) {
  if (paid === null || paid === undefined) return null;
  if (typeof paid !== 'object' || Array.isArray(paid)) {
    throw new Error('La señal debe ser un objeto o null.');
  }
  const amount = Number(paid.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('El importe de la señal debe ser un número mayor que cero.');
  }
  if (typeof paid.at !== 'string' || Number.isNaN(Date.parse(paid.at))) {
    throw new Error('La fecha de la señal no es válida.');
  }
  const by = typeof paid.by === 'string' && paid.by.trim() ? paid.by.trim() : null;
  return { amount: Math.round(amount * 100) / 100, at: paid.at, by };
}

/**
 * The payment is workflow (written only by setDepositPaid), so a draft can
 * never smuggle it in on create or edit. Returns the same object when
 * there is nothing to strip.
 *
 * @param {object} draft
 * @returns {object}
 */
function withoutDepositPaid(draft) {
  if (!draft || typeof draft !== 'object' || draft.deposit_paid === undefined) return draft;
  const copy = { ...draft };
  delete copy.deposit_paid;
  return copy;
}

module.exports = {
  PENDING_ID_PREFIX,
  quotesFolder,
  isPendingId,
  newPendingId,
  normalizeDepositPaid,
  withoutDepositPaid,
};
