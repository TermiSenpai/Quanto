// ============================================================
// Quanto · Offline quote-drain decision logic (Phase B)
// ============================================================
// The pure, injectable core of main.js's offline quote handling:
//   - isBackendUnreachable: is an error a transient outage (queue the
//     write / serve the cache) or a real bug (surface it)?
//   - classifyQueuedOp:     is a queued fullQuotes item a CREATE (no real
//     id yet) or an EDIT (already owns its id)?
//   - drainQueuedFullQuote: route a queued item to the RIGHT cloud op on
//     reconnect — a CREATE assigns a real id (+ reconciles the cache); an
//     EDIT goes through the UPDATE path so the edited payload is actually
//     written and `version` bumps. NEVER through create-only saveFullQuote
//     (that no-ops on existing rows → a silently-lost edit).
//
// Kept out of main.js (which can't be unit-tested — Electron) so this
// logic is covered. The cloud ops + cache callbacks are injected.
//
// Main-process only; the renderer NEVER imports it.
// ============================================================

'use strict';

const { isPendingId } = require('./quote-store-helpers');

// fs error codes that mean the path/folder was momentarily UNREACHABLE —
// the NAS dropped, a timeout, a transient lock. These are safe to treat as
// "retry / serve the cache". DELIBERATELY EXCLUDES permission errors
// (EACCES/EPERM): a permission failure is a persistent misconfiguration,
// not an outage — masking it as transient would silently serve stale data
// forever. Those are surfaced + logged at error level by the caller.
const TRANSIENT_FS_CODES = new Set([
  'ENOENT',      // folder/file not present yet (NAS share offline)
  'ENOTDIR',     // a path component vanished (share remounting)
  'EBUSY',       // resource temporarily locked
  'ETIMEDOUT',   // SMB/network timeout
  'ENETUNREACH', // network unreachable
  'EHOSTUNREACH',// host unreachable
  'ECONNREFUSED',// connection refused (share down)
  'ECONNRESET',  // connection reset mid-op
  'ENETDOWN',    // local network down
  'EHOSTDOWN',   // remote host down
  'EIO'          // transient I/O error talking to the share
]);

/**
 * True when `err` means the backend was UNREACHABLE (queue the write /
 * serve the cache), as opposed to a validation/size/conflict/permission
 * bug (surface it).
 *   - Cloud: the structural offline flag a D1ClientError carries (set ONLY
 *     at the fetch-reject site in lib/d1-client.js).
 *   - File:  a TRANSIENT fs error code (NAS down). Permission errors are
 *     NOT transient and return false here.
 *
 * @param {Error & {network?: boolean, code?: string}} err
 * @returns {boolean}
 */
function isBackendUnreachable(err) {
  if (!err) return false;
  if (err.network === true) return true;
  return typeof err.code === 'string' && TRANSIENT_FS_CODES.has(err.code);
}

/**
 * True when an error is a filesystem PERMISSION error (EACCES/EPERM) — a
 * persistent misconfig the caller should log loudly, never silently retry.
 *
 * @param {Error & {code?: string}} err
 * @returns {boolean}
 */
function isPermissionError(err) {
  return Boolean(err && (err.code === 'EACCES' || err.code === 'EPERM'));
}

/**
 * Classifies a queued fullQuotes item as a CREATE or an EDIT. The marker
 * (`__op`) set at enqueue time is authoritative; a pending id is the
 * fallback signal for a CREATE (older queued items, or a create whose
 * marker was dropped). Anything with a real id and no create marker is an
 * EDIT — it must go through the update path on drain.
 *
 * @param {object} quote - the queued full reopenable quote
 * @returns {'create' | 'edit'}
 */
function classifyQueuedOp(quote) {
  if (quote && quote.__op === 'create') return 'create';
  if (quote && quote.__op === 'edit') return 'edit';
  // No marker: a pending id is a create, a real id is an edit.
  return isPendingId(quote && quote.id) ? 'create' : 'edit';
}

// Strips the transient drain-envelope fields (__op + the stamped
// provisional id/version) so the persisted/created quote never carries
// them. Returns a draft suitable for the cloud create.
function toCreateDraft(quote) {
  const { __op, id, version, date, updated_at, ...draft } = quote;
  return draft;
}

// Strips only the transient __op marker (an edit keeps its real id/version).
function stripDrainMarker(quote) {
  const { __op, ...rest } = quote;
  return rest;
}

/**
 * Drains ONE queued full reopenable quote against the cloud on reconnect,
 * routing it to the correct op:
 *   - CREATE (pending id / __op:'create') → deps.createQuote assigns a real
 *     PP-YYYY-NNNN id; the cache's provisional entry is reconciled (dropped
 *     and re-inserted under the real id — no duplicate).
 *   - EDIT (real id / __op:'edit') → deps.replaceQuote with a null token
 *     (force / current-version re-read) so the edited payload is WRITTEN and
 *     `version` bumps. The cache entry is refreshed with the saved quote.
 *
 * Throws on failure (so the outbox keeps the item for a later retry) and on
 * an unexpected EDIT outcome (a missing id during a force-replace) so the
 * problem is never silently swallowed.
 *
 * Residual: at-least-once on the CREATE lane. The CREATE path assigns a
 * fresh PP-YYYY-NNNN id via deps.createQuote and then removes the outbox
 * entry. If the process dies after createQuote commits but before the entry
 * is removed, the next flush re-runs this function and creates a duplicate
 * quote (never a lost one). This is inherent to a no-Worker local queue —
 * mirroring the residual non-atomicity noted on tryClaimFullQuote in
 * lib/cloud-quotes.js. The EDIT lane is idempotent (force-replace
 * on a stable id) and does not share this risk.
 *
 * @param {object} deps
 * @param {(draft: object) => Promise<object>} deps.createQuote - cloud create (assigns id)
 * @param {(id: string, quote: object, token: null) => Promise<{quote?:object,conflict?:boolean}|null>} deps.replaceQuote - cloud update (force)
 * @param {(provisionalId: string, realQuote: object) => void} deps.reconcileCachedQuote
 * @param {(quote: object) => void} deps.upsertCachedQuote
 * @param {object} quote - the queued full reopenable quote
 * @returns {Promise<object>} the saved/created quote
 */
async function drainQueuedFullQuote(deps, quote) {
  const op = classifyQueuedOp(quote);

  if (op === 'create') {
    const provisionalId = quote && quote.id;
    const saved = await deps.createQuote(toCreateDraft(quote));
    deps.reconcileCachedQuote(provisionalId, saved);
    return saved;
  }

  // EDIT: force-update (null token ⇒ current-version re-read) so the edited
  // payload lands and version bumps — never create-only saveFullQuote.
  const edit = stripDrainMarker(quote);
  const res = await deps.replaceQuote(edit.id, edit, null);
  if (res === null) {
    // The quote disappeared from the cloud (e.g. deleted elsewhere) while the
    // edit sat queued. Don't loop forever pretending to retry — fail loudly.
    throw new Error(`No se pudo aplicar la edición en cola: el presupuesto ${edit.id} ya no existe en la nube.`);
  }
  if (res.conflict) {
    // A null token forces (re-reads the current version), so a conflict here
    // is unexpected; surface it so the item stays queued and is investigated.
    throw new Error(`Conflicto inesperado al aplicar la edición en cola del presupuesto ${edit.id}.`);
  }
  deps.upsertCachedQuote(res.quote);
  return res.quote;
}

module.exports = {
  TRANSIENT_FS_CODES,
  isBackendUnreachable,
  isPermissionError,
  classifyQueuedOp,
  drainQueuedFullQuote
};
