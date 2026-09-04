// ============================================================
// Tests · lib/quote-store-helpers.js
// ============================================================
// Pure helpers shared by main.js's quote-repo selector.
// ============================================================

import { describe, test, expect } from 'vitest';
import path from 'node:path';
import {
  PENDING_ID_PREFIX,
  quotesFolder,
  isPendingId,
  newPendingId,
  normalizeDepositPaid,
  withoutDepositPaid,
} from '../lib/quote-store-helpers.js';

describe('quotesFolder', () => {
  test('points at a "presupuestos" folder next to config.js', () => {
    expect(quotesFolder(path.join('Z:', 'Packs', 'config.js')))
      .toBe(path.join('Z:', 'Packs', 'presupuestos'));
  });

  test('works for a UNC NAS path', () => {
    const cfg = '\\\\172.26.0.154\\Paep\\Packs\\config.js';
    expect(quotesFolder(cfg)).toBe(path.join(path.dirname(cfg), 'presupuestos'));
  });
});

describe('isPendingId', () => {
  test('true only for the provisional prefix', () => {
    expect(isPendingId(PENDING_ID_PREFIX + 'abc')).toBe(true);
    expect(isPendingId('PP-2026-0001')).toBe(false);
    expect(isPendingId('')).toBe(false);
    expect(isPendingId(null)).toBe(false);
    expect(isPendingId(42)).toBe(false);
  });
});

describe('newPendingId', () => {
  test('stamps the provisional prefix on an injected uuid', () => {
    expect(newPendingId(() => 'fixed-uuid')).toBe('PP-PENDING-fixed-uuid');
  });

  test('is recognised by isPendingId and is NOT a real PP-YYYY-NNNN id', () => {
    const id = newPendingId(() => 'xyz');
    expect(isPendingId(id)).toBe(true);
    expect(/^PP-\d{4}-\d+$/.test(id)).toBe(false);
  });
});

describe('normalizeDepositPaid', () => {
  const AT = '2026-09-04T10:00:00.000Z';

  test('null/undefined mean "not paid" and pass through as null', () => {
    expect(normalizeDepositPaid(null)).toBeNull();
    expect(normalizeDepositPaid(undefined)).toBeNull();
  });

  test('rounds the amount to cents and blanks an empty `by`', () => {
    expect(normalizeDepositPaid({ amount: 120.006, at: AT, by: '  ' }))
      .toEqual({ amount: 120.01, at: AT, by: null });
    expect(normalizeDepositPaid({ amount: '121', at: AT, by: 'Mostrador' }))
      .toEqual({ amount: 121, at: AT, by: 'Mostrador' });
  });

  test('rejects a non-positive or non-numeric amount with a Spanish error', () => {
    expect(() => normalizeDepositPaid({ amount: 0, at: AT })).toThrow(/importe/i);
    expect(() => normalizeDepositPaid({ amount: -5, at: AT })).toThrow(/importe/i);
    expect(() => normalizeDepositPaid({ amount: 'x', at: AT })).toThrow(/importe/i);
  });

  test('rejects a missing or unparsable timestamp', () => {
    expect(() => normalizeDepositPaid({ amount: 10 })).toThrow(/fecha/i);
    expect(() => normalizeDepositPaid({ amount: 10, at: 'ayer' })).toThrow(/fecha/i);
  });

  test('rejects a non-object', () => {
    expect(() => normalizeDepositPaid(5)).toThrow(/objeto/i);
    expect(() => normalizeDepositPaid([1])).toThrow(/objeto/i);
  });
});

describe('withoutDepositPaid', () => {
  test('returns the same draft when it carries no payment', () => {
    const d = { user: 'a' };
    expect(withoutDepositPaid(d)).toBe(d);
  });

  test('drops deposit_paid from a copy, leaving the input untouched', () => {
    const d = { user: 'a', deposit_paid: { amount: 1 } };
    const out = withoutDepositPaid(d);
    expect(out).toEqual({ user: 'a' });
    expect(d.deposit_paid).toEqual({ amount: 1 });
  });
});
