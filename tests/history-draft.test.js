// ============================================================
// buildQuoteDraft tests (renderer/history.js)
// ============================================================
// Verifies that the draft payload includes every existing field
// AND the new `opt` field added in Phase A (reopen & edit).
// Pure function — no DOM, no IPC.
// ============================================================
import { describe, test, expect } from 'vitest';
import { buildQuoteDraft } from '../renderer/history.js';

const BASE_RESULT = {
  pack: 'crew',
  total_vat_inc: 100.50,
  sale_base: 83.00,
  vat: 17.50,
  total_cost: 60.00,
  margin: 0.28
};

const BASE_CTX = {
  user: 'Alice',
  configVersion: 4,
  packId: 'crew-pack',
  customer: { name: 'ACME', phone: '600000000' }
};

const SAMPLE_OPT = {
  options: {},
  addons: {},
  qty_3xl: 0,
  qty_4xl: 0,
  qty_5xl: 0,
  quantities: { 'camiseta': 10 }
};

describe('buildQuoteDraft', () => {
  test('includes all existing fields', () => {
    const draft = buildQuoteDraft(BASE_RESULT, BASE_CTX);

    expect(draft.user).toBe('Alice');
    expect(draft.config_version).toBe(4);
    expect(draft.pack_id).toBe('crew-pack');
    expect(draft.pack).toBe('crew');
    expect(draft.customer).toEqual({ name: 'ACME', phone: '600000000' });
    expect(draft.result).toBe(BASE_RESULT);
    expect(draft.totals).toEqual({
      total_vat_inc: 100.50,
      sale_base: 83.00,
      vat: 17.50,
      total_cost: 60.00,
      margin: 0.28
    });
  });

  test('includes opt verbatim when provided', () => {
    const draft = buildQuoteDraft(BASE_RESULT, { ...BASE_CTX, opt: SAMPLE_OPT });

    expect(draft.opt).toBe(SAMPLE_OPT);
  });

  test('opt defaults to null when ctx.opt is absent', () => {
    const draft = buildQuoteDraft(BASE_RESULT, BASE_CTX);

    expect(draft.opt).toBeNull();
  });

  test('opt defaults to null when ctx.opt is explicitly undefined', () => {
    const draft = buildQuoteDraft(BASE_RESULT, { ...BASE_CTX, opt: undefined });

    expect(draft.opt).toBeNull();
  });

  test('totals snapshot is independent of extra result fields', () => {
    const result = { ...BASE_RESULT, some_extra: 'ignored' };
    const draft = buildQuoteDraft(result, BASE_CTX);

    expect(Object.keys(draft.totals)).toEqual([
      'total_vat_inc', 'sale_base', 'vat', 'total_cost', 'margin'
    ]);
  });

  test('carries the deposit content (pct + min_amount) and never a payment', () => {
    const draft = buildQuoteDraft(BASE_RESULT, { ...BASE_CTX, deposit: { pct: 0.4, min_amount: 41 } });
    expect(draft.deposit).toEqual({ pct: 0.4, min_amount: 41 });
    expect('deposit_paid' in draft).toBe(false);
  });

  test('deposit is null when the context has none', () => {
    expect(buildQuoteDraft(BASE_RESULT, BASE_CTX).deposit).toBeNull();
  });

  test('drops anything else the deposit context carries (e.g. a payment)', () => {
    const draft = buildQuoteDraft(BASE_RESULT, {
      ...BASE_CTX, deposit: { pct: 0.4, min_amount: 41, paid: { amount: 50 } }
    });
    expect(draft.deposit).toEqual({ pct: 0.4, min_amount: 41 });
  });
});
