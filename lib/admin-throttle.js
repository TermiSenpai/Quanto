// ============================================================
// Quanto · admin password attempt throttle (pure state machine)
// ============================================================
// `auth:verify-admin` compares the password with timingSafeEqual but
// allows unlimited attempts. This module holds a tiny pure state
// machine so the handler can: delay after a few failures, lock after
// many, and reset on success. No persistence — the state lives in the
// main process and resets on restart, which is fine for an internal
// "anti-accidental-click" gate (CLAUDE.md §10).
//
// Pure and dependency-free so the escalation logic is unit-tested in
// isolation; the handler just owns the mutable `state` and the timers.
// ============================================================

'use strict';

// After this many consecutive failures we start delaying the response.
const DELAY_AFTER = 3;
// After this many we lock for a cooldown window.
const LOCK_AFTER = 10;
// Cooldown duration once locked (ms).
const LOCK_MS = 30000;
// Delay applied between DELAY_AFTER and LOCK_AFTER failures (ms).
const DELAY_MS = 1500;

/**
 * Initial throttle state.
 * @returns {{ failures: number, lockedUntil: number }}
 */
function initialThrottleState() {
  return { failures: 0, lockedUntil: 0 };
}

/**
 * Computes the next throttle state and the action the handler must
 * take, given the previous state, whether the attempt was correct,
 * and the current time. Pure: no IO, no Date.now() inside.
 *
 * Returns `{ state, locked, delayMs }`:
 *   - `locked`: true if the attempt must be rejected with a "too many
 *     attempts" error (we are inside the cooldown window).
 *   - `delayMs`: how long the handler should wait before responding
 *     (0 when no throttling applies).
 *
 * Rules:
 *   - If currently locked (now < lockedUntil), reject immediately:
 *     locked=true, the attempt is not even evaluated, failures kept.
 *   - On a correct attempt (when not locked): reset to initial.
 *   - On a wrong attempt: increment failures.
 *       · failures >= LOCK_AFTER  -> set lockedUntil = now + LOCK_MS,
 *         report locked=true.
 *       · failures >= DELAY_AFTER -> delayMs = DELAY_MS.
 *       · otherwise               -> no delay.
 *
 * @param {{ failures: number, lockedUntil: number }} state
 * @param {boolean} wasCorrect
 * @param {number}  now  epoch ms
 * @returns {{ state: {failures:number, lockedUntil:number}, locked: boolean, delayMs: number }}
 */
function nextThrottleState(state, wasCorrect, now) {
  const prev = state || initialThrottleState();

  // Still inside the cooldown window: reject without evaluating.
  if (prev.lockedUntil && now < prev.lockedUntil) {
    return { state: prev, locked: true, delayMs: 0 };
  }

  // Cooldown expired (or never locked). If it had expired, treat the
  // counter as reset so the user gets a fresh batch of attempts.
  const base = (prev.lockedUntil && now >= prev.lockedUntil)
    ? initialThrottleState()
    : { failures: prev.failures, lockedUntil: 0 };

  if (wasCorrect) {
    return { state: initialThrottleState(), locked: false, delayMs: 0 };
  }

  const failures = base.failures + 1;

  if (failures >= LOCK_AFTER) {
    return {
      state: { failures, lockedUntil: now + LOCK_MS },
      locked: true,
      delayMs: 0
    };
  }

  if (failures >= DELAY_AFTER) {
    return {
      state: { failures, lockedUntil: 0 },
      locked: false,
      delayMs: DELAY_MS
    };
  }

  return { state: { failures, lockedUntil: 0 }, locked: false, delayMs: 0 };
}

module.exports = {
  initialThrottleState,
  nextThrottleState,
  DELAY_AFTER,
  LOCK_AFTER,
  LOCK_MS,
  DELAY_MS
};
