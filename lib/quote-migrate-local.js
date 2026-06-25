// ============================================================
// Quanto · One-time migration of per-PC quotes → shared store
// ============================================================
// Pure migration logic for B5: a PC upgrading from a pre-Phase-B build
// still has its quotes in the legacy per-PC presupuestos.json. On boot
// they must be pushed into the shared store (file folder or D1) exactly
// once, idempotently, never blocking boot.
//
// This module is logic-only: it does NOT touch fs or the network. The
// `putIfAbsent` adapter (bound to the active backend) is injected by the
// caller (main.js), mirroring how lib/cloud-bootstrap.js injects its
// deps. The backends preserve the quote's EXISTING id and skip when an
// entry with that id already exists, so re-runs and multi-PC boots can
// never duplicate a quote.
// ============================================================

'use strict';

// A human quote id is PP-YYYY-NNNN (mirrors lib/quote-repo-file.js isValidId,
// which the caller passes in; this is the inline fallback so the module has
// no cross-import). A structurally-invalid entry — null / non-object / bad id
// — can NEVER be written by the id-preserving adapters, so it is a PERMANENT
// skip, not a transient failure.
const ID_RE = /^PP-\d{4}-\d+$/;
function defaultIsValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Splits the legacy quotes into the ones worth attempting (a real object
 * with a valid id) and the structurally-invalid ones. The invalid set is a
 * PERMANENT skip: the id-preserving adapter would only ever throw on it,
 * which — if counted as `failed` — would wedge the migration into endless
 * retry (the source is never renamed, a warning logs every boot). A
 * genuinely malformed entry is preserved in the .bak-pre-shared backup, so
 * dropping it from the attempt loses nothing.
 *
 * @param {object[]} localQuotes
 * @param {(id: any) => boolean} [isValidId] - id guard (defaults to the PP-…
 *   shape; the caller passes lib/quote-repo-file.js isValidId to stay DRY)
 * @returns {{ migratable: object[], invalid: object[] }}
 */
function partitionMigratableQuotes(localQuotes, isValidId = defaultIsValidId) {
  const migratable = [];
  const invalid = [];
  for (const q of Array.isArray(localQuotes) ? localQuotes : []) {
    if (q && typeof q === 'object' && !Array.isArray(q) && isValidId(q.id)) {
      migratable.push(q);
    } else {
      invalid.push(q);
    }
  }
  return { migratable, invalid };
}

/**
 * Pushes each local quote into the shared store via the injected
 * `putIfAbsent` adapter and returns a tally.
 *
 * `putIfAbsent(quote)` must return (or resolve to) `{ migrated: boolean }`:
 *   - true  → the entry was newly inserted,
 *   - false → an entry with that id already existed (idempotent skip).
 * If it THROWS for an entry, that entry is counted as `failed` and the
 * error is collected (never swallowed — CLAUDE.md hard rule §4); the
 * batch keeps going so one bad entry can't strand the rest. A summary
 * with `failed > 0` signals the caller NOT to rename/delete the source
 * (so a transient failure is retried next boot — already-migrated ids
 * are skipped).
 *
 * @param {object[]} localQuotes - the legacy per-PC quotes (each carries a human id)
 * @param {(quote: object) => Promise<{migrated: boolean}> | {migrated: boolean}} putIfAbsent
 * @returns {Promise<{total:number, migrated:number, skipped:number, failed:number, errors:Array<{id:string, message:string}>}>}
 */
async function migrateLocalQuotes(localQuotes, putIfAbsent) {
  const summary = { total: 0, migrated: 0, skipped: 0, failed: 0, errors: [] };
  if (!Array.isArray(localQuotes)) return summary;
  summary.total = localQuotes.length;

  for (const quote of localQuotes) {
    try {
      const res = await putIfAbsent(quote);
      if (res && res.migrated) summary.migrated += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ id: quote && quote.id, message: err && err.message });
    }
  }

  return summary;
}

module.exports = { migrateLocalQuotes, partitionMigratableQuotes };
