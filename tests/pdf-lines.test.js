// ============================================================
// Tests · lib/pdf-lines.js — ex-VAT presentation lines that close
// ============================================================
// buildPdfLines turns a priced/stored quote `result` into the rows the
// PDF templates render: itemized articles (bundle components when they
// carry distributed prices), itemized extras and per-size surcharges —
// all NET (ex-VAT). Two invariants replace the old reconciliation:
// every row closes (subtotal = qty × unit, checkable by the customer)
// and the totals block foots (base = Σ rows, vat = total − base, so the
// IVA line absorbs the rounding drift against the charged total).
// ============================================================

import { describe, test, expect } from 'vitest';
import { buildPdfLines } from '../lib/pdf-lines.js';

const round2 = (n) => Math.round(n * 100) / 100;
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const allRows = (out) => [...out.items, ...out.surcharge_lines, ...out.extras_lines];

describe('buildPdfLines — components pack', () => {
  const result = {
    pricing_mode: 'components',
    pack: 'Pack mixto',
    breakdown: [
      { model: 'CLASICA', name: 'Sin capucha', quantity: 5, sides: 2, unit_price: 14.95, subtotal: 74.75 },
      { model: 'URBAN',   name: 'Con capucha', quantity: 7, sides: 2, unit_price: 16.95, subtotal: 118.65 }
    ],
    subtotal: 193.40, surcharges: 11, extras_no_vat: 7.5, extras_vat_inc: 9.075,
    total_vat_inc: 213.475, sale_base: 176.43, vat: 37.05,
    qty_4xl: 2, qty_5xl: 1
  };

  test('one item row per breakdown line, ex-VAT unit first', () => {
    const out = buildPdfLines(result);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].concept).toContain('Sin capucha');
    expect(out.items[0].qty).toBe(5);
    // 14.95 / 1.21 ≈ 12.36 net; the subtotal is exactly 5 × 12.36
    expect(out.items[0].unit).toBe(12.36);
    expect(out.items[0].subtotal).toBe(61.80);
  });

  test('every row with a quantity closes: subtotal === qty × unit', () => {
    const out = buildPdfLines(result);
    expect(allRows(out).length).toBeGreaterThan(0);
    for (const row of allRows(out)) {
      if (row.qty > 0) expect(row.subtotal).toBe(round2(row.qty * row.unit));
    }
  });

  test('legacy surcharge (no surcharge_lines) collapses to one ex-VAT row', () => {
    const out = buildPdfLines(result);
    expect(out.surcharge_lines).toHaveLength(1);
    expect(out.surcharge_line).not.toBeNull();
    expect(out.surcharge_line.qty).toBeNull();
    expect(out.surcharge_line.unit).toBeNull();
    expect(out.surcharge_line.subtotal).toBeCloseTo(9.09, 2);
  });

  test('itemizes surcharge per size when the result carries surcharge_lines', () => {
    const withSizes = {
      ...result,
      surcharge_lines: [
        { size: '4XL', quantity: 2, unit_price: 3, subtotal: 6 },
        { size: '5XL+', quantity: 1, unit_price: 5, subtotal: 5 }
      ]
    };
    const out = buildPdfLines(withSizes);
    expect(out.surcharge_lines).toHaveLength(2);
    expect(out.surcharge_lines[0].concept).toMatch(/4XL/);
    expect(out.surcharge_lines[0].qty).toBe(2);
    // unit = round2(3 / 1.21) = 2.48; the row closes at 2 × 2.48
    expect(out.surcharge_lines[0].unit).toBeCloseTo(2.48, 2);
    expect(out.surcharge_lines[0].subtotal).toBe(round2(2 * out.surcharge_lines[0].unit));
    // the collapsed line (custom-template back-compat) sums the itemized ones
    const sumItemized = out.surcharge_lines.reduce((s, l) => s + l.subtotal, 0);
    expect(out.surcharge_line.subtotal).toBeCloseTo(round2(sumItemized), 2);
  });

  test('legacy extras collapse to one line when no extras_lines', () => {
    const out = buildPdfLines(result);
    expect(out.extras_lines).toHaveLength(1);
    expect(out.extras_lines[0].subtotal).toBeCloseTo(7.5, 2);
  });

  test('extras_line (custom-template back-compat) sums the extras rows', () => {
    const out = buildPdfLines(result);
    expect(out.extras_line).not.toBeNull();
    expect(out.extras_line.concept).toBe('Extras opcionales (sin IVA)');
    expect(out.extras_line.subtotal).toBeCloseTo(round2(sum(out.extras_lines, r => r.subtotal)), 2);
  });

  test('totals foot: base = Σ rows, vat = total − base', () => {
    const out = buildPdfLines(result);
    expect(out.totals.base).toBe(round2(sum(allRows(out), r => r.subtotal)));
    expect(out.totals.vat).toBe(round2(out.totals.total - out.totals.base));
    expect(out.totals).toEqual({ base: 176.46, vat: 37.02, total: 213.48 });
  });
});

describe('buildPdfLines — bundle pack', () => {
  const result = {
    pricing_mode: 'bundle',
    pack: 'Pack Peña',
    breakdown: [{
      model: 'crew_full', name: 'Pack Peña', quantity: 12, sides: 2,
      unit_price: 25.95, subtotal: 311.40,
      components: [
        { model: 'BEAGLE',  name: 'Camiseta', quantity: 12, unit_price: 11.55, subtotal: 138.60 },
        { model: 'CLASICA', name: 'Sudadera', quantity: 12, unit_price: 14.40, subtotal: 172.80 }
      ]
    }],
    subtotal: 311.40, surcharges: 0, extras_no_vat: 0,
    total_vat_inc: 311.40, sale_base: 257.36, vat: 54.04
  };

  test('itemizes each component (not the pack) when components carry prices', () => {
    const out = buildPdfLines(result);
    expect(out.items).toHaveLength(2);
    expect(out.items.map(i => i.concept.replace(/ \(\d+c\)$/, ''))).toEqual(['Camiseta', 'Sudadera']);
  });

  test('component rows close and sum to the printed base', () => {
    const out = buildPdfLines(result);
    // units: 11.55/1.21 → 9.55, 14.40/1.21 → 11.90; rows = 12 × unit
    expect(out.items[0].unit).toBe(9.55);
    expect(out.items[0].subtotal).toBe(114.60);
    expect(out.items[1].unit).toBe(11.90);
    expect(out.items[1].subtotal).toBe(142.80);
    expect(out.totals.base).toBe(round2(sum(out.items, r => r.subtotal)));
    // the IVA line absorbs the drift against the charged total
    expect(out.totals.vat).toBe(round2(out.totals.total - out.totals.base));
    expect(out.totals.total).toBe(311.40);
  });

  test('legacy bundle without component prices → single pack line', () => {
    const legacy = {
      ...result,
      breakdown: [{ model: 'crew_full', name: 'Pack Peña', quantity: 12, sides: 2, unit_price: 25.95, subtotal: 311.40,
        components: [{ model: 'BEAGLE', name: 'Camiseta', quantity: 12 }, { model: 'CLASICA', name: 'Sudadera', quantity: 12 }] }]
    };
    const out = buildPdfLines(legacy);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].concept).toContain('Pack Peña');
    // still closes: unit = round2(25.95/1.21) = 21.45, subtotal = 12 × 21.45
    expect(out.items[0].unit).toBe(21.45);
    expect(out.items[0].subtotal).toBe(257.40);
  });
});

describe('buildPdfLines — itemized extras + edges', () => {
  test('one row per extras_lines entry, ex-VAT', () => {
    const result = {
      pricing_mode: 'components',
      breakdown: [{ model: 'BEAGLE', name: 'Camiseta', quantity: 10, sides: 1, unit_price: 8.99, subtotal: 89.90 }],
      subtotal: 89.90, surcharges: 0,
      extras_no_vat: 15, extras_vat_inc: 18.15,
      extras_lines: [
        { id: 'name', name: 'Nombre', quantity: 10, unit_price: 1.815, subtotal: 18.15, vat_included: false }
      ],
      total_vat_inc: 108.05, sale_base: 89.30, vat: 18.75
    };
    const out = buildPdfLines(result);
    expect(out.extras_lines).toHaveLength(1);
    expect(out.extras_lines[0].concept).toBe('Nombre');
    expect(out.extras_lines[0].qty).toBe(10);
    // 1.815 / 1.21 = 1.50 exactly — the configured ex-VAT addon price
    expect(out.extras_lines[0].unit).toBe(1.50);
    expect(out.extras_lines[0].subtotal).toBe(15);
  });

  test('sale_base === 0 does not divide by zero', () => {
    const out = buildPdfLines({ breakdown: [], sale_base: 0, vat: 0, total_vat_inc: 0 });
    expect(out.items).toEqual([]);
    expect(out.totals).toEqual({ base: 0, vat: 0, total: 0 });
  });

  test('a quote missing `vat` degrades to gross rows but stays consistent', () => {
    // div = 1: rows keep their stored (VAT-inc) prices — real numbers,
    // never stretched — and the totals block still adds up (vat = 0).
    const out = buildPdfLines({
      pricing_mode: 'components',
      breakdown: [{ model: 'CLASICA', name: 'Sudadera', quantity: 5, unit_price: 14.95, subtotal: 74.75 }],
      total_vat_inc: 74.75, sale_base: 61.78
    });
    expect(out.items[0].unit).toBe(14.95);
    expect(out.items[0].subtotal).toBe(74.75);
    expect(out.totals).toEqual({ base: 74.75, vat: 0, total: 74.75 });
  });

  test('a corrupt sale_base never stretches the rows to match it', () => {
    // The base is whatever the rows really sum to — a stored base that
    // disagrees shows up in the IVA line instead of fabricating prices.
    const out = buildPdfLines({
      pricing_mode: 'components',
      breakdown: [
        { model: 'CLASICA', name: 'Sin capucha', quantity: 5, unit_price: 14.95, subtotal: 74.75 },
        { model: 'URBAN',   name: 'Con capucha', quantity: 7, unit_price: 16.95, subtotal: 118.65 }
      ],
      surcharges: 11, extras_no_vat: 7.5, extras_vat_inc: 9.075,
      total_vat_inc: 213.475, sale_base: 500, vat: 37.05
    });
    for (const row of allRows(out)) {
      expect(row.subtotal).toBeGreaterThan(0);
      if (row.qty > 0) expect(row.subtotal).toBe(round2(row.qty * row.unit));
    }
    expect(out.totals.base).toBe(round2(sum(allRows(out), r => r.subtotal)));
    expect(out.totals.base).not.toBe(500);
  });
});
