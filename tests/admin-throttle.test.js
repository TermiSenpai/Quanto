// ============================================================
// Tests · lib/admin-throttle.js
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  initialThrottleState,
  nextThrottleState,
  DELAY_AFTER,
  LOCK_AFTER,
  LOCK_MS,
  DELAY_MS
} from '../lib/admin-throttle.js';

// Drives N consecutive wrong attempts from a starting state at a
// fixed time, returning the final transition result.
function failTimes(n, start = initialThrottleState(), now = 1000) {
  let state = start;
  let last;
  for (let i = 0; i < n; i++) {
    last = nextThrottleState(state, false, now);
    state = last.state;
  }
  return last;
}

describe('nextThrottleState', () => {
  test('no delay or lock for the first few failures', () => {
    const r = failTimes(DELAY_AFTER - 1);
    expect(r.locked).toBe(false);
    expect(r.delayMs).toBe(0);
    expect(r.state.failures).toBe(DELAY_AFTER - 1);
  });

  test('delays once failures reach DELAY_AFTER', () => {
    const r = failTimes(DELAY_AFTER);
    expect(r.locked).toBe(false);
    expect(r.delayMs).toBe(DELAY_MS);
  });

  test('locks once failures reach LOCK_AFTER', () => {
    const r = failTimes(LOCK_AFTER, initialThrottleState(), 5000);
    expect(r.locked).toBe(true);
    expect(r.state.lockedUntil).toBe(5000 + LOCK_MS);
  });

  test('while locked, further attempts are rejected without evaluating', () => {
    const locked = failTimes(LOCK_AFTER, initialThrottleState(), 5000).state;
    // even a "correct" attempt during the cooldown is rejected
    const r = nextThrottleState(locked, true, 5000 + 1000);
    expect(r.locked).toBe(true);
    expect(r.state.lockedUntil).toBe(locked.lockedUntil);
  });

  test('after the cooldown expires, the counter resets', () => {
    const locked = failTimes(LOCK_AFTER, initialThrottleState(), 5000).state;
    // a wrong attempt after expiry counts as the first of a fresh batch
    const r = nextThrottleState(locked, false, 5000 + LOCK_MS + 1);
    expect(r.locked).toBe(false);
    expect(r.delayMs).toBe(0);
    expect(r.state.failures).toBe(1);
    expect(r.state.lockedUntil).toBe(0);
  });

  test('a correct attempt resets everything', () => {
    const after = failTimes(DELAY_AFTER).state;
    const r = nextThrottleState(after, true, 2000);
    expect(r.locked).toBe(false);
    expect(r.delayMs).toBe(0);
    expect(r.state).toEqual(initialThrottleState());
  });

  test('escalation is monotonic: none -> delay -> lock', () => {
    let state = initialThrottleState();
    const delays = [];
    const locks = [];
    for (let i = 1; i <= LOCK_AFTER; i++) {
      const r = nextThrottleState(state, false, 100);
      state = r.state;
      delays.push(r.delayMs);
      locks.push(r.locked);
    }
    // first DELAY_AFTER-1 have no delay, then delay, then eventually lock
    expect(delays[0]).toBe(0);
    expect(delays[DELAY_AFTER - 1]).toBe(DELAY_MS);
    expect(locks[LOCK_AFTER - 1]).toBe(true);
  });
});
