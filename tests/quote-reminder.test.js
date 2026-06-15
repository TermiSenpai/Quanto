// ============================================================
// Startup quote reminder derivation (renderer/quote-reminder.js)
// ============================================================
// Pure helper behind the dismissible startup banner (UI-UX §2.7):
// from the local quote history + "now" it counts how many quotes are
// still waiting for an answer (pending/none and older than 7 days) and
// how many expire within the coming week (valid_until in the next 7
// days, not yet accepted/rejected). No DOM, no IPC — data in, counts
// out — so the thresholds and boundaries are pinned here.
// ============================================================
import { describe, test, expect } from 'vitest';
import { computeReminder } from '../renderer/quote-reminder.js';

// A fixed "now" keeps every boundary assertion deterministic.
const NOW = '2026-06-13T12:00:00.000Z';

// Builds a quote at `daysAgo` days before NOW, expiring `validInDays`
// days after NOW (omit validInDays for no valid_until).
function quoteAgo(daysAgo, status, validInDays) {
  const ms = Date.parse(NOW);
  const date = new Date(ms - daysAgo * 86400000).toISOString();
  const q = { id: 'q', date, status };
  if (validInDays !== undefined) {
    q.valid_until = new Date(ms + validInDays * 86400000).toISOString();
  }
  return q;
}

describe('computeReminder', () => {
  test('empty/invalid input → zero counts (never throws)', () => {
    expect(computeReminder([], NOW)).toEqual({ pendingOld: 0, expiringSoon: 0 });
    expect(computeReminder(null, NOW)).toEqual({ pendingOld: 0, expiringSoon: 0 });
    expect(computeReminder(undefined, NOW)).toEqual({ pendingOld: 0, expiringSoon: 0 });
  });

  test('pendingOld: pending quote older than 7 days counts', () => {
    const r = computeReminder([quoteAgo(8, 'pending')], NOW);
    expect(r.pendingOld).toBe(1);
  });

  test('pendingOld: a quote with no status is treated as pending', () => {
    const r = computeReminder([quoteAgo(10, undefined)], NOW);
    expect(r.pendingOld).toBe(1);
  });

  test('pendingOld boundary: exactly 7 days old does NOT count (strictly older)', () => {
    const r = computeReminder([quoteAgo(7, 'pending')], NOW);
    expect(r.pendingOld).toBe(0);
  });

  test('pendingOld: just over 7 days counts', () => {
    // 7 days + 1 hour ago.
    const date = new Date(Date.parse(NOW) - (7 * 86400000 + 3600000)).toISOString();
    const r = computeReminder([{ id: 'q', date, status: 'pending' }], NOW);
    expect(r.pendingOld).toBe(1);
  });

  test('pendingOld excludes accepted/rejected even when old', () => {
    const r = computeReminder([
      quoteAgo(30, 'accepted'),
      quoteAgo(30, 'rejected')
    ], NOW);
    expect(r.pendingOld).toBe(0);
  });

  test('expiringSoon: valid_until within the next 7 days counts', () => {
    const r = computeReminder([quoteAgo(2, 'pending', 3)], NOW);
    expect(r.expiringSoon).toBe(1);
  });

  test('expiringSoon boundary: exactly 7 days ahead still counts (within the week)', () => {
    const r = computeReminder([quoteAgo(2, 'pending', 7)], NOW);
    expect(r.expiringSoon).toBe(1);
  });

  test('expiringSoon: more than 7 days ahead does NOT count', () => {
    const r = computeReminder([quoteAgo(2, 'pending', 8)], NOW);
    expect(r.expiringSoon).toBe(0);
  });

  test('expiringSoon: already-expired quote (valid_until in the past) does NOT count', () => {
    const r = computeReminder([quoteAgo(2, 'pending', -1)], NOW);
    expect(r.expiringSoon).toBe(0);
  });

  test('expiringSoon excludes accepted/rejected (decision already made)', () => {
    const r = computeReminder([
      quoteAgo(1, 'accepted', 3),
      quoteAgo(1, 'rejected', 3)
    ], NOW);
    expect(r.expiringSoon).toBe(0);
  });

  test('expiringSoon: no valid_until → not counted', () => {
    const r = computeReminder([quoteAgo(1, 'pending')], NOW);
    expect(r.expiringSoon).toBe(0);
  });

  test('a single quote can be counted in both buckets', () => {
    // Old AND expiring within the week.
    const r = computeReminder([quoteAgo(9, 'pending', 2)], NOW);
    expect(r.pendingOld).toBe(1);
    expect(r.expiringSoon).toBe(1);
  });

  test('mixed history sums each bucket independently', () => {
    const r = computeReminder([
      quoteAgo(10, 'pending'),       // old pending
      quoteAgo(20, undefined),       // old, no status
      quoteAgo(1, 'pending', 4),     // expiring soon
      quoteAgo(1, 'accepted', 2),    // excluded everywhere
      quoteAgo(2, 'pending')         // recent, no expiry → neither
    ], NOW);
    expect(r.pendingOld).toBe(2);
    expect(r.expiringSoon).toBe(1);
  });

  test('a malformed date is ignored (never NaN/throws)', () => {
    const r = computeReminder([
      { id: 'q', date: 'not-a-date', status: 'pending' },
      { id: 'q2', date: NOW, status: 'pending', valid_until: 'nope' }
    ], NOW);
    expect(r).toEqual({ pendingOld: 0, expiringSoon: 0 });
  });
});
