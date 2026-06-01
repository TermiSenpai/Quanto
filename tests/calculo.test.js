// ============================================================
// Calculation logic tests (renderer/calculo.js) — v3
// ============================================================
// Covers the cases from PLAN_Calculadora.md and the tier borders.
// Pure functions: they take (cfg, options) and return the result.
// `cfg` is built with buildDefaultConfig (v3).
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  getTier,
  calculateExtras,
  calculateGarmentCost,
  calculateCrewPack,
  calculateSinglePack,
  calculateMixedPack,
  calculateCustomPack
} from '../renderer/calculo.js';
import { buildDefaultConfig } from '../config.default.js';

const CFG = buildDefaultConfig();

// 1-cent tolerance to avoid float fragility.
const EUR = 0.01;

describe('getTier', () => {
  test.each([
    [9,    null],
    [10,   'T1'],
    [24,   'T1'],
    [25,   'T2'],
    [49,   'T2'],
    [50,   'T3'],
    [99,   'T3'],
    [100,  'T4'],
    [9999, 'T4']
  ])('quantity=%i → %s', (qty, expected) => {
    const t = getTier(CFG, qty);
    if (expected === null) {
      expect(t).toBeNull();
    } else {
      expect(t).not.toBeNull();
      expect(t.id).toBe(expected);
    }
  });
});

describe('calculateExtras', () => {
  test('no extras returns zeros', () => {
    const r = calculateExtras(CFG, {});
    expect(r.no_vat).toBe(0);
    expect(r.vat_inc).toBe(0);
  });

  test('applies VAT on top of the VAT-free subtotal', () => {
    // 2 names × 1.5 + 1 short sleeve × 1.5 + 1 long sleeve × 3 = 7.5 (no VAT)
    // with 21% VAT → 9.075
    const r = calculateExtras(CFG, {
      names: 2,
      short_sleeves: 1,
      long_sleeves: 1
    });
    expect(r.no_vat).toBeCloseTo(7.5, 4);
    expect(r.vat_inc).toBeCloseTo(9.075, 4);
  });
});

describe('calculateCrewPack (plan case §3.1)', () => {
  // 12 packs without hood, 2 sides → tier T1, price 25.95 → 311.40 €
  test('12 packs without hood, 2 sides = 311.40 €', () => {
    const r = calculateCrewPack(CFG, {
      quantity: 12,
      hood: 'without',
      sides: 2,
      qty_4xl: 0,
      qty_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.tier).toMatch(/10-24/);
    expect(r.unit_price).toBe(25.95);
    expect(r.total_vat_inc).toBeCloseTo(311.40, 2);
  });

  test('rejects a quantity below the minimum', () => {
    const r = calculateCrewPack(CFG, {
      quantity: 5, hood: 'without', sides: 2, qty_4xl: 0, qty_5xl: 0
    });
    expect(r.error).toBeDefined();
  });

  test('changes tier and price when a border is crossed', () => {
    const r25 = calculateCrewPack(CFG, {
      quantity: 25, hood: 'without', sides: 2, qty_4xl: 0, qty_5xl: 0
    });
    expect(r25.unit_price).toBe(24.95); // T2

    const r100 = calculateCrewPack(CFG, {
      quantity: 100, hood: 'with', sides: 1, qty_4xl: 0, qty_5xl: 0
    });
    expect(r100.unit_price).toBe(22.95); // T4 with_hood one_side
  });

  test('4XL/5XL+ surcharges add to the total', () => {
    const base = calculateCrewPack(CFG, {
      quantity: 12, hood: 'without', sides: 2, qty_4xl: 0, qty_5xl: 0
    });
    const withSurcharge = calculateCrewPack(CFG, {
      quantity: 12, hood: 'without', sides: 2, qty_4xl: 2, qty_5xl: 1
    });
    const expectedSurcharge = 2 * 3 + 1 * 5; // 11 €
    expect(withSurcharge.total_vat_inc - base.total_vat_inc).toBeCloseTo(expectedSurcharge, 2);
  });
});

describe('calculateSinglePack', () => {
  test('tshirts_only T1 two_sides 10 units', () => {
    const r = calculateSinglePack(CFG, 'tshirts_only', {
      quantity: 10, sides: 2, qty_4xl: 0, qty_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.unit_price).toBe(11.99);
    expect(r.total_vat_inc).toBeCloseTo(119.90, 2);
  });

  test('rejects below the minimum', () => {
    const r = calculateSinglePack(CFG, 'urban_only', {
      quantity: 9, sides: 1, qty_4xl: 0, qty_5xl: 0
    });
    expect(r.error).toBeDefined();
  });
});

describe('calculateMixedPack (plan case)', () => {
  // 7 URBAN + 5 CLASICA, T1, 2 sides: 7×16.95 + 5×14.95 = 118.65 + 74.75 = 193.40
  test('7 URBAN + 5 CLASICA, 2 sides = 193.40 €', () => {
    const r = calculateMixedPack(CFG, {
      qty_classic: 5,
      qty_urban: 7,
      sides: 2,
      qty_4xl: 0,
      qty_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.total_quantity).toBe(12);
    expect(r.tier).toMatch(/10-24/);
    expect(r.total_vat_inc).toBeCloseTo(193.40, 2);
  });

  test('rejects if total < min', () => {
    const r = calculateMixedPack(CFG, {
      qty_classic: 4, qty_urban: 4, sides: 2, qty_4xl: 0, qty_5xl: 0
    });
    expect(r.error).toBeDefined();
  });

  test('subtotal = sum of lines', () => {
    const r = calculateMixedPack(CFG, {
      qty_classic: 5, qty_urban: 7, sides: 2, qty_4xl: 0, qty_5xl: 0
    });
    const sumLines = r.breakdown.reduce((s, l) => s + l.subtotal, 0);
    expect(r.subtotal).toBeCloseTo(sumLines, 2);
  });
});

describe('calculateCustomPack', () => {
  test('mixes any combo at its single price', () => {
    const r = calculateCustomPack(CFG, {
      lines: [
        { model: 'BEAGLE',  quantity: 5, sides: 2 },
        { model: 'CLASICA', quantity: 3, sides: 2 },
        { model: 'URBAN',   quantity: 2, sides: 1 }
      ],
      qty_4xl: 0, qty_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.total_quantity).toBe(10);
    // T1: BEAGLE 2s=11.99, CLASICA 2s=14.95, URBAN 1s=14.95
    // 5×11.99 + 3×14.95 + 2×14.95 = 59.95 + 44.85 + 29.90 = 134.70
    expect(r.subtotal).toBeCloseTo(134.70, 2);
  });

  test('rejects empty lines', () => {
    const r = calculateCustomPack(CFG, { lines: [], qty_4xl: 0, qty_5xl: 0 });
    expect(r.error).toBeDefined();
  });

  test('rejects if total < min', () => {
    const r = calculateCustomPack(CFG, {
      lines: [{ model: 'BEAGLE', quantity: 5, sides: 2 }],
      qty_4xl: 0, qty_5xl: 0
    });
    expect(r.error).toBeDefined();
  });

  test('rejects a model without a reference pack', () => {
    const brokenCfg = buildDefaultConfig();
    brokenCfg.roly_models.NUEVO = { name: 'X', ref: 'X', price: 1 };
    const r = calculateCustomPack(brokenCfg, {
      lines: [
        { model: 'BEAGLE', quantity: 9, sides: 1 },
        { model: 'NUEVO',  quantity: 1, sides: 1 }
      ],
      qty_4xl: 0, qty_5xl: 0
    });
    expect(r.error).toMatch(/NUEVO/);
  });
});

describe('calculateGarmentCost', () => {
  test('BEAGLE 2 sides T1, batch 10', () => {
    const t1 = getTier(CFG, 10);
    const r = calculateGarmentCost(CFG, 'BEAGLE', 2, t1, 10);
    // We don't pin an exact value (depends on many params), but the
    // cost must be positive and reasonable (between 1 and 20 €).
    expect(r.total).toBeGreaterThan(1);
    expect(r.total).toBeLessThan(20);
  });

  test('time reduction in T4 lowers the cost vs T1', () => {
    const t1 = getTier(CFG, 10);
    const t4 = getTier(CFG, 100);
    const c1 = calculateGarmentCost(CFG, 'URBAN', 2, t1, 10).total;
    const c4 = calculateGarmentCost(CFG, 'URBAN', 2, t4, 100).total;
    expect(c4).toBeLessThan(c1);
  });
});

describe('calculateTotals internal coherence', () => {
  test('base + VAT == total VAT inc', () => {
    const r = calculateCrewPack(CFG, {
      quantity: 30, hood: 'with', sides: 2, qty_4xl: 1, qty_5xl: 1
    });
    expect(r.sale_base + r.vat).toBeCloseTo(r.total_vat_inc, EUR);
  });

  test('margin + total_cost + vat == total VAT inc', () => {
    const r = calculateCrewPack(CFG, {
      quantity: 30, hood: 'with', sides: 2, qty_4xl: 0, qty_5xl: 0
    });
    expect(r.margin + r.total_cost + r.vat).toBeCloseTo(r.total_vat_inc, EUR);
  });
});
