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
