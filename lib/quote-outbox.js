// ============================================================
// Quanto · Offline quote outbox
// ============================================================
// Queues quotes/statuses that could not reach D1 (offline) and drains
// them on reconnect (planes/v5-cloud-sync.md §7). The local history
// (lib/history.js) stays the per-PC source of truth; this is only the
// cloud-sync buffer, so a temporary outage never loses a quote and the
// next successful sync uploads it.
//
//   File: <userData>/cache/outbox.json
//   Shape: { quotes: [ <cloud flat quote> … ], statuses: [ {id,status,ts} … ],
//            fullQuotes: [ <full reopenable quote> … ] }
//
// Two quote lanes, on purpose:
//   - `quotes`     — the legacy flat-row mirror lane (drained by uploadQuote);
//                    it carries only the stat columns, NOT the reopenable
//                    payload, so it cannot rebuild the step-2 builder.
//   - `fullQuotes` — the Phase B lane: a full reopenable quote (opt + result +
//                    totals + customer …) so a save queued while offline is
//                    NOT lossy. A queued CREATE has a provisional id
//                    (PP-PENDING-<uuid>) that the drain reconciles into a real
//                    PP-YYYY-NNNN id; an EDIT already carries its real id.
//
// This is a store, so fs lives here (one place per concern —
// ARCHITECTURE.md §3); main-process only. Writes are atomic
// (.tmp + rename as the commit point), mirroring lib/catalog-cache.js.
//
// Idempotency: re-uploading a quote is safe because uploadQuote keys on
// the client UUID (INSERT OR IGNORE — lib/cloud-quotes.js). So a failed
// item simply stays queued and a later flush retries it without risk of
// duplication.
//
// User-facing throw messages stay in Spanish (CLAUDE.md §6).
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EMPTY = () => ({ quotes: [], statuses: [], fullQuotes: [] });

/**
 * Absolute path of the outbox file inside the given userData directory.
 * @param {string} userDataDir
 * @returns {string}
 */
function outboxPathFor(userDataDir) {
  return path.join(userDataDir, 'cache', 'outbox.json');
}

/**
 * Reads the outbox. Returns the empty shape when the file does not
 * exist (nothing queued yet). Throws a Spanish error on corruption —
 * never silently treated as data (a swallowed corruption would drop
 * queued quotes). Callers that must not crash (flushOutbox) catch it.
 *
 * @param {string} userDataDir
 * @returns {{quotes: object[], statuses: object[]}}
 */
function readOutbox(userDataDir) {
  const filePath = outboxPathFor(userDataDir);
  if (!fs.existsSync(filePath)) return EMPTY();
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (raw === '') return EMPTY();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Cola de presupuestos dañada: ' + filePath, { cause: err });
  }
  if (
    parsed === null || typeof parsed !== 'object' ||
    !Array.isArray(parsed.quotes) || !Array.isArray(parsed.statuses)
  ) {
    throw new Error('Cola de presupuestos dañada: ' + filePath);
  }
  // `fullQuotes` is additive (Phase B): an ABSENT key is tolerated
  // (back-compat with a pre-B outbox) and defaulted to [], but a
  // present-but-wrong-typed one is corruption (a consumer iterating it
  // would crash), the same class of failure the quotes/statuses checks
  // above catch.
  if (parsed.fullQuotes === undefined) {
    parsed.fullQuotes = [];
  } else if (!Array.isArray(parsed.fullQuotes)) {
    throw new Error('Cola de presupuestos dañada: ' + filePath);
  }
  return parsed;
}

/**
 * Writes the outbox atomically: sibling `.tmp` + rename, so an
 * interrupted write never leaves a half-written queue. Creates the
 * parent directory on first write.
 *
 * @param {string} userDataDir
 * @param {{quotes: object[], statuses: object[]}} outbox
 */
function writeOutbox(userDataDir, outbox) {
  const filePath = outboxPathFor(userDataDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(outbox, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Appends a quote to the queue.
 * @param {string} userDataDir
 * @param {object} quote - the cloud quote shape (lib/cloud-quotes.js)
 */
function enqueueQuote(userDataDir, quote) {
  const outbox = readOutbox(userDataDir);
  outbox.quotes.push(quote);
  writeOutbox(userDataDir, outbox);
}

/**
 * Appends a status change to the queue.
 * @param {string} userDataDir
 * @param {{id: string, status: string, ts: string}} entry
 */
function enqueueStatus(userDataDir, { id, status, ts }) {
  const outbox = readOutbox(userDataDir);
  outbox.statuses.push({ id, status, ts });
  writeOutbox(userDataDir, outbox);
}

/**
 * Appends a FULL reopenable quote to the queue (Phase B). Unlike
 * enqueueQuote (the flat-row mirror), this preserves the whole payload
 * (opt + result + totals + customer …) so a save buffered while offline
 * can be rebuilt and reopened after it drains. A queued CREATE carries a
 * provisional id (PP-PENDING-<uuid>); an EDIT carries its real id.
 *
 * @param {string} userDataDir
 * @param {object} quote - the full reopenable quote (CLAUDE.md §9)
 */
function enqueueFullQuote(userDataDir, quote) {
  const outbox = readOutbox(userDataDir);
  outbox.fullQuotes.push(quote);
  writeOutbox(userDataDir, outbox);
}

/**
 * Empties the queue.
 * @param {string} userDataDir
 */
function clearOutbox(userDataDir) {
  writeOutbox(userDataDir, EMPTY());
}

/**
 * Drains the queue against the cloud: uploads queued quotes and applies
 * queued statuses, removing each on success. A failing item stays
 * queued (don't lose it) and a later flush retries it — UUID idempotency
 * (INSERT OR IGNORE) makes the retry safe. A corrupt outbox is tolerated:
 * the flush never crashes boot; it returns the Spanish error instead.
 *
 * @param {string} userDataDir
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} deps
 * @param {(client: object, quote: object) => Promise<any>} deps.uploadQuote
 * @param {(client: object, args: {id,status,now}) => Promise<any>} deps.updateQuoteStatus
 * @param {(quote: object) => Promise<any>} [deps.drainFullQuote] - re-saves a
 *   full reopenable quote (Phase B fullQuotes lane). Receives the queued quote
 *   (the client is already bound by the caller). Optional: when absent, the
 *   fullQuotes lane is left untouched (kept for a later flush that injects it).
 * @param {() => string} [deps.now] - ISO timestamp for an applied status (fallback only)
 * @returns {Promise<{uploaded: number, statusesApplied: number, fullQuotesDrained: number, remaining: number, error?: string}>}
 */
async function flushOutbox(userDataDir, client, deps) {
  let outbox;
  try {
    outbox = readOutbox(userDataDir);
  } catch (err) {
    // Corrupt queue: never crash the sync. Surface the cause so it is
    // logged, not silently swallowed (hard rule §4).
    return { uploaded: 0, statusesApplied: 0, fullQuotesDrained: 0, remaining: 0, error: err.message };
  }

  const now = deps.now || (() => new Date().toISOString());
  const keptQuotes = [];
  const keptStatuses = [];
  const keptFullQuotes = [];
  let uploaded = 0;
  let statusesApplied = 0;
  let fullQuotesDrained = 0;

  for (const quote of outbox.quotes) {
    try {
      await deps.uploadQuote(client, quote);
      uploaded++;
    } catch (_) {
      // Stays queued for the next flush (idempotent retry).
      keptQuotes.push(quote);
    }
  }

  for (const entry of outbox.statuses) {
    try {
      await deps.updateQuoteStatus(client, { id: entry.id, status: entry.status, now: entry.ts || now() });
      statusesApplied++;
    } catch (_) {
      keptStatuses.push(entry);
    }
  }

  // Phase B fullQuotes lane: best-effort, kept-on-failure like the other
  // two. When no drainer is injected the whole lane is preserved (a flush
  // without the callback must not drop a full quote).
  if (typeof deps.drainFullQuote === 'function') {
    for (const quote of outbox.fullQuotes) {
      try {
        await deps.drainFullQuote(quote);
        fullQuotesDrained++;
      } catch (_) {
        keptFullQuotes.push(quote);
      }
    }
  } else {
    keptFullQuotes.push(...outbox.fullQuotes);
  }

  writeOutbox(userDataDir, { quotes: keptQuotes, statuses: keptStatuses, fullQuotes: keptFullQuotes });
  return {
    uploaded,
    statusesApplied,
    fullQuotesDrained,
    remaining: keptQuotes.length + keptStatuses.length + keptFullQuotes.length
  };
}

module.exports = {
  outboxPathFor,
  readOutbox,
  enqueueQuote,
  enqueueStatus,
  enqueueFullQuote,
  clearOutbox,
  flushOutbox
};
