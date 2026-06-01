// ============================================================
// Calculation logic tests (renderer/calculo.js) — v4
// ============================================================
// Covers the unified calculatePack engine for every seed pack,
// the tier borders, addons, recommended price and the legacy
// parity case (12 crew packs T1 → 311.40 €). Pure functions:
// they take (cfg, options) and return the result. `cfg` is built
// with buildDefaultConfig (v4).
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  getTier,
  calculateAddons,
  calculateGarmentCost,
  calculatePack,
  recommendedPrice
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

describe('calculateAddons', () => {
  test('no addons returns zeros', () => {
    const r = calculateAddons(CFG, {});
    expect(r.no_vat).toBe(0);
    expect(r.vat_inc).toBe(0);
  });

  test('applies VAT on top of the VAT-free subtotal', () => {
    // 2 names × 1.5 + 1 short_sleeve × 1.5 + 1 long_sleeve × 3 = 7.5 (no VAT)
    // with 21% VAT → 9.075
    const r = calculateAddons(CFG, {
      name: 2,
      short_sleeve: 1,
      long_sleeve: 1
    });
    expect(r.no_vat).toBeCloseTo(7.5, 4);
    expect(r.vat_inc).toBeCloseTo(9.075, 4);
  });

  test('ignores unknown ids and zero quantities', () => {
    const r = calculateAddons(CFG, { name: 0, nope: 5 });
    expect(r.no_vat).toBe(0);
    expect(r.detail).toEqual({});
  });
});

describe('calculatePack — crew bundle (legacy parity §3.1)', () => {
  // 12 packs without_hood, 2 sides → tier T1, price 25.95 → 311.40 €
  test('12 packs without_hood/two_sides T1 = subtotal 311.40 €', () => {
    const r = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' },
      packs: 12
    });
    expect(r.error).toBeUndefined();
    expect(r.tier).toMatch(/10-24/);
    expect(r.unit_price).toBe(25.95);
    expect(r.subtotal).toBeCloseTo(311.40, 2);
    expect(r.total_vat_inc).toBeCloseTo(311.40, 2);
    expect(r.total_quantity).toBe(24); // 12 packs × 2 garments
  });

  test('rejects a quantity below the minimum', () => {
    const r = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' },
      packs: 4 // 8 garments < 10
    });
    expect(r.error).toBeDefined();
  });

  test('changes tier and price when a border is crossed', () => {
    const r13 = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 13
    });
    // 26 garments → T2 → 24.95
    expect(r13.unit_price).toBe(24.95);

    const r50 = calculatePack(CFG, 'crew_full', {
      options: { hood: 'with_hood', sides: 'one_side' }, packs: 50
    });
    // 100 garments → T4 with_hood one_side → 22.95
    expect(r50.unit_price).toBe(22.95);
  });

  test('4XL/5XL surcharges add to the total', () => {
    const base = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12
    });
    const withSurcharge = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12,
      qty_4xl: 2, qty_5xl: 1
    });
    const expectedSurcharge = 2 * 3 + 1 * 5; // 11 €
    expect(withSurcharge.total_vat_inc - base.total_vat_inc).toBeCloseTo(expectedSurcharge, 2);
  });

  test('with_hood maps the sweatshirt component to URBAN', () => {
    const r = calculatePack(CFG, 'crew_full', {
      options: { hood: 'with_hood', sides: 'two_sides' }, packs: 12
    });
    const comp = r.breakdown[0].components.find(c => c.model === 'URBAN');
    expect(comp).toBeDefined();
  });
});

describe('calculatePack — components packs', () => {
  test('tshirts_only T1 two_sides 10 units = 119.90 €', () => {
    const r = calculatePack(CFG, 'tshirts_only', {
      options: { sides: 'two_sides' },
      quantities: { tshirt: 10 }
    });
    expect(r.error).toBeUndefined();
    expect(r.unit_price).toBe(11.99);
    expect(r.total_vat_inc).toBeCloseTo(119.90, 2);
  });

  test('hoodies_mixed: 7 URBAN + 5 CLASICA two_sides T1 = 193.40 €', () => {
    // 5×14.95 + 7×16.95 = 74.75 + 118.65 = 193.40
    const r = calculatePack(CFG, 'hoodies_mixed', {
      options: { sides: 'two_sides' },
      quantities: { classic: 5, urban: 7 }
    });
    expect(r.error).toBeUndefined();
    expect(r.total_quantity).toBe(12);
    expect(r.tier).toMatch(/10-24/);
    expect(r.total_vat_inc).toBeCloseTo(193.40, 2);
    const sumLines = r.breakdown.reduce((s, l) => s + l.subtotal, 0);
    expect(r.subtotal).toBeCloseTo(sumLines, 2);
  });

  test('rejects below the minimum', () => {
    const r = calculatePack(CFG, 'urban_only', {
      options: { sides: 'one_side' }, quantities: { sweatshirt: 9 }
    });
    expect(r.error).toBeDefined();
  });

  test('rejects when all quantities are zero', () => {
    const r = calculatePack(CFG, 'hoodies_mixed', {
      options: { sides: 'two_sides' }, quantities: { classic: 0, urban: 0 }
    });
    expect(r.error).toBeDefined();
  });
});

describe('calculatePack — custom (free components)', () => {
  test('mixes any combo at each product price', () => {
    const r = calculatePack(CFG, 'custom', {
      options: { sides: 'two_sides' },
      lines: [
        { product: 'BEAGLE',  quantity: 5 },
        { product: 'CLASICA', quantity: 3 },
        { product: 'URBAN',   quantity: 2 }
      ]
    });
    expect(r.error).toBeUndefined();
    expect(r.total_quantity).toBe(10);
    // T1 two_sides: BEAGLE 11.99, CLASICA 14.95, URBAN 16.95
    // 5×11.99 + 3×14.95 + 2×16.95 = 59.95 + 44.85 + 33.90 = 138.70
    expect(r.subtotal).toBeCloseTo(138.70, 2);
  });

  test('rejects empty lines', () => {
    const r = calculatePack(CFG, 'custom', { options: { sides: 'two_sides' }, lines: [] });
    expect(r.error).toBeDefined();
  });

  test('rejects if total < min', () => {
    const r = calculatePack(CFG, 'custom', {
      options: { sides: 'two_sides' },
      lines: [{ product: 'BEAGLE', quantity: 5 }]
    });
    expect(r.error).toBeDefined();
  });

  test('rejects a line whose product does not exist', () => {
    const r = calculatePack(CFG, 'custom', {
      options: { sides: 'one_side' },
      lines: [
        { product: 'BEAGLE', quantity: 9 },
        { product: 'NOPE',   quantity: 1 }
      ]
    });
    expect(r.error).toMatch(/NOPE/);
  });
});

describe('calculatePack — guards', () => {
  test('unknown pack id returns an error', () => {
    const r = calculatePack(CFG, 'ghost', { options: {}, packs: 12 });
    expect(r.error).toBeDefined();
  });

  test('null tier (below first tier) returns an error, no crash', () => {
    const c = buildDefaultConfig();
    c.packs.tshirts_only.min_total = 5; // pass min but below tier T1 from=10
    const r = calculatePack(c, 'tshirts_only', {
      options: { sides: 'two_sides' }, quantities: { tshirt: 7 }
    });
    expect(r.error).toBeDefined();
  });

  test('large sizes exceeding the order error out', () => {
    const r = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12,
      qty_4xl: 100
    });
    expect(r.error).toBeDefined();
  });

  test('large sizes exactly equal to the order are accepted (boundary)', () => {
    const r = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12,
      qty_4xl: 24
    });
    expect(r.error).toBeUndefined();
  });

  test('missing bundle price for a combo errors with the combo named', () => {
    const c = buildDefaultConfig();
    delete c.packs.crew_full.bundle_prices['without_hood|two_sides'];
    const r = calculatePack(c, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12
    });
    expect(r.error).toMatch(/without_hood\|two_sides/);
  });
});

describe('calculatePack — cost and 3XL', () => {
  test('3XL units raise total_cost (conservative MAX extra)', () => {
    const base = calculatePack(CFG, 'hoodies_mixed', {
      options: { sides: 'two_sides' }, quantities: { classic: 6, urban: 6 }
    });
    const with3xl = calculatePack(CFG, 'hoodies_mixed', {
      options: { sides: 'two_sides' }, quantities: { classic: 6, urban: 6 },
      qty_3xl: 3
    });
    // hoodie extra_cost_3xl = 0.60; 3 × 0.60 = 1.80
    expect(with3xl.total_cost - base.total_cost).toBeCloseTo(1.80, 2);
    // 3XL is a buffer, NOT charged to the client: revenue unchanged.
    expect(with3xl.total_vat_inc).toBeCloseTo(base.total_vat_inc, 2);
  });

  test('3XL uses the MAX extra across heterogeneous products (never under-prices)', () => {
    // crew_full mixes BEAGLE (extra_cost_3xl 0.40) + CLASICA (0.60).
    // The conservative rule charges the MAX (0.60), not the t-shirt's 0.40.
    const base = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12
    });
    const with3xl = calculatePack(CFG, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12, qty_3xl: 3
    });
    expect(with3xl.total_cost - base.total_cost).toBeCloseTo(1.80, 2); // 3 × 0.60 (MAX)
    // and explicitly NOT the cheaper t-shirt rate
    expect(with3xl.total_cost - base.total_cost).not.toBeCloseTo(1.20, 2); // 3 × 0.40
  });

  test('addons add cost and revenue', () => {
    const base = calculatePack(CFG, 'tshirts_only', {
      options: { sides: 'two_sides' }, quantities: { tshirt: 10 }
    });
    const withAddons = calculatePack(CFG, 'tshirts_only', {
      options: { sides: 'two_sides' }, quantities: { tshirt: 10 },
      addons: { name: 10 }
    });
    expect(withAddons.extras_no_vat).toBeCloseTo(15, 2); // 10 × 1.5
    expect(withAddons.total_cost - base.total_cost).toBeCloseTo(2.0, 2); // 10 × 0.20
    expect(withAddons.total_vat_inc).toBeGreaterThan(base.total_vat_inc);
  });
});

describe('calculateGarmentCost', () => {
  test('BEAGLE 2 sides T1, batch 10 is positive and reasonable', () => {
    const t1 = getTier(CFG, 10);
    const r = calculateGarmentCost(CFG, 'BEAGLE', 2, t1, 10);
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

  test('uses the default supplier price', () => {
    const c = buildDefaultConfig();
    c.products.BEAGLE.suppliers = [
      { supplier: 'ROLY', ref: 'X', price: 1.7325, min_order: 0, is_default: false },
      { supplier: 'ROLY', ref: 'Y', price: 99, min_order: 0, is_default: true }
    ];
    const t1 = getTier(c, 10);
    const expensive = calculateGarmentCost(c, 'BEAGLE', 2, t1, 10).total;
    const cheap = calculateGarmentCost(CFG, 'BEAGLE', 2, t1, 10).total;
    expect(expensive).toBeGreaterThan(cheap + 90);
  });
});

describe('recommendedPrice', () => {
  test('cost 10, margin 0.35 → 15.95', () => {
    const r = recommendedPrice(CFG, 10, 0.35);
    // 10 / 0.65 = 15.3846 → round up to next x.95 → 15.95
    expect(r.price).toBeCloseTo(15.95, 2);
    expect(r.raw_price).toBeCloseTo(15.3846, 3);
  });

  test('a value already ending at .95 is kept', () => {
    const r = recommendedPrice(CFG, 10.3675, 0.35); // 10.3675/0.65 = 15.95
    expect(r.price).toBeCloseTo(15.95, 2);
  });

  test('a value just above .95 rolls to the next integer .95', () => {
    const r = recommendedPrice(CFG, 10.4, 0.35); // 10.4/0.65 = 16.0 → 16.95
    expect(r.price).toBeCloseTo(16.95, 2);
  });

  test('defaults to the config target margin when none is passed', () => {
    const r = recommendedPrice(CFG, 10);
    expect(r.price).toBeCloseTo(15.95, 2); // default 0.35
  });

  test('margin >= 1 yields Infinity without crashing', () => {
    const r = recommendedPrice(CFG, 10, 1);
    expect(r.price).toBe(Infinity);
    expect(r.margin_pct).toBe(0);
  });

  test('reports the real margin at the rounded price', () => {
    const r = recommendedPrice(CFG, 10, 0.35);
    expect(r.margin).toBeCloseTo(5.95, 2); // 15.95 - 10
    expect(r.margin_pct).toBeCloseTo(5.95 / 15.95, 4);
  });
});

describe('totals internal coherence', () => {
  test('base + VAT == total VAT inc', () => {
    const r = calculatePack(CFG, 'crew_full', {
      options: { hood: 'with_hood', sides: 'two_sides' }, packs: 15,
      qty_4xl: 1, qty_5xl: 1
    });
    expect(r.sale_base + r.vat).toBeCloseTo(r.total_vat_inc, EUR);
  });

  test('margin + total_cost + vat == total VAT inc', () => {
    const r = calculatePack(CFG, 'crew_full', {
      options: { hood: 'with_hood', sides: 'two_sides' }, packs: 15
    });
    expect(r.margin + r.total_cost + r.vat).toBeCloseTo(r.total_vat_inc, EUR);
  });

  test('margin_pct equals margin / sale_base', () => {
    const r = calculatePack(CFG, 'hoodies_mixed', {
      options: { sides: 'two_sides' }, quantities: { classic: 5, urban: 7 }
    });
    expect(r.margin_pct).toBeCloseTo(r.margin / r.sale_base, 6);
  });
});
