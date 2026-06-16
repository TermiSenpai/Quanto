// ============================================================
// Quanto · Startup quote reminder (pure, renderer)
// ============================================================
// The dismissible startup banner (UI-UX §2.7) nudges the workshop
// about quotes that need attention: ones still waiting for an answer
// for too long, and ones about to expire. This module is the pure
// seam — given the local quote history and "now", it returns the two
// counts the banner shows. No DOM, no IPC, no Date.now (the caller
// passes nowIso), which keeps every threshold testable in plain Node.
//
// Status model: a quote is "open" while its status is 'pending' or
// absent (older local entries predate the status field). 'accepted'
// and 'rejected' are decided — they never remind.
// ============================================================

'use strict';

const DAY_MS = 86400000;
// "Too old without an answer" and "expiring this week" both use a
// 7-day window (UI-UX §2.7). Kept as one constant so the two stay in
// step if the policy changes.
const WINDOW_DAYS = 7;

/**
 * Is a quote still open (waiting for a decision)? Missing/empty status
 * counts as pending so legacy entries (no status field) are included.
 */
function isOpen(quote) {
  const s = quote && quote.status;
  return s === undefined || s === null || s === '' || s === 'pending';
}

/** Parses an ISO/ms timestamp to epoch ms, or null when unparseable. */
function toMs(when) {
  if (when === null || when === undefined || when === '') return null;
  const ms = when instanceof Date ? when.getTime() : Date.parse(when);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Counts the quotes that should trigger the startup reminder.
 *
 *   - pendingOld:    open AND created strictly more than 7 days ago.
 *   - expiringSoon:  open AND valid_until falls within [now, now + 7d]
 *                    (already-expired quotes are past the nudge window,
 *                    so they don't count).
 *
 * Both buckets are independent — a quote can land in neither, one, or
 * both. Malformed/missing dates are skipped, never NaN.
 *
 * @param {Array<object>} quotes  local history entries ({date, status, valid_until})
 * @param {string|number|Date} nowIso  the reference "now"
 * @returns {{ pendingOld: number, expiringSoon: number }}
 */
export function computeReminder(quotes, nowIso) {
  const list = Array.isArray(quotes) ? quotes : [];
  const now = toMs(nowIso);
  if (now === null) return { pendingOld: 0, expiringSoon: 0 };

  const oldThreshold = now - WINDOW_DAYS * DAY_MS;
  const soonThreshold = now + WINDOW_DAYS * DAY_MS;

  let pendingOld = 0;
  let expiringSoon = 0;

  for (const q of list) {
    if (!isOpen(q)) continue;

    const created = toMs(q && q.date);
    // Strictly older than the window (exactly 7 days does not nudge yet).
    if (created !== null && created < oldThreshold) pendingOld++;

    const validUntil = toMs(q && q.valid_until);
    // Within the coming week and not already past (inclusive of the edge).
    if (validUntil !== null && validUntil >= now && validUntil <= soonThreshold) {
      expiringSoon++;
    }
  }

  return { pendingOld, expiringSoon };
}
