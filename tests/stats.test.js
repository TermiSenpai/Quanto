// ============================================================
// Tests · lib/stats.js (pure statistics aggregator)
// ============================================================
// PURE, deterministic, no I/O, no Date.now(). A small fixture of raw
// D1 rows ({ quotes, items, addons }) pins every aggregate UI-UX §2.7
// needs; the empty case proves the KPIs zero out with no NaN / division
// by zero. Names are resolved from cfg; unknown/archived ids fall back
// to the id.
// ============================================================

import { describe, test, expect } from 'vitest';
import { computeStats, isoWeek } from '../lib/stats.js';
import { buildFullConfigV4 as buildDefaultConfig } from './fixtures/config-v4-full.js';

const cfg = (() => { const c = buildDefaultConfig(); delete c.admin; return c; })();

// Three quotes across two ISO weeks, two packs, mixed statuses.
//   q1  crew_full  T1  accepted   week 2026-W24   total 600
//   q2  crew_full  T2  rejected   week 2026-W24   total 400
//   q3  tshirts_only T1 pending   week 2026-W25   total 200
const QUOTES = [
  {
    id: 'q1', ts: '2026-06-08T10:00:00.000Z', user: 'A',
    client_name: 'C1', client_phone: 'p', valid_until: 'v',
    pack_id: 'crew_full', tier: 'T1', total_units: 24,
    qty_3xl: 2, qty_4xl: 1, qty_5xl: 0,
    total_vat_inc: 600, sale_base: 500, margin_pct: 0.40, target_margin: 0.35,
    pvp_deviation_pct: -0.05, status: 'accepted', status_ts: 't', catalog_version: 7
  },
  {
    id: 'q2', ts: '2026-06-09T10:00:00.000Z', user: 'A',
    client_name: 'C2', client_phone: 'p', valid_until: 'v',
    pack_id: 'crew_full', tier: 'T2', total_units: 30,
    qty_3xl: 0, qty_4xl: 0, qty_5xl: 1,
    total_vat_inc: 400, sale_base: 340, margin_pct: 0.30, target_margin: 0.35,
    pvp_deviation_pct: -0.15, status: 'rejected', status_ts: 't', catalog_version: 7
  },
  {
    id: 'q3', ts: '2026-06-15T10:00:00.000Z', user: 'B',
    client_name: 'C3', client_phone: 'p', valid_until: 'v',
    pack_id: 'tshirts_only', tier: 'T1', total_units: 12,
    qty_3xl: 0, qty_4xl: 0, qty_5xl: 0,
    total_vat_inc: 200, sale_base: 170, margin_pct: 0.38, target_margin: 0.35,
    pvp_deviation_pct: null, status: 'pending', status_ts: null, catalog_version: 7
  }
];

const ITEMS = [
  { quote_id: 'q1', product_id: 'BEAGLE', sides: 'two_sides', qty: 24 },
  { quote_id: 'q1', product_id: 'CLASICA', sides: 'two_sides', qty: 24 },
  { quote_id: 'q2', product_id: 'BEAGLE', sides: 'one_side', qty: 30 },
  { quote_id: 'q3', product_id: 'BEAGLE', sides: 'two_sides', qty: 12 }
];

const ADDONS = [
  { quote_id: 'q1', addon_id: 'name', qty: 24 },
  { quote_id: 'q2', addon_id: 'name', qty: 10 },
  { quote_id: 'q3', addon_id: 'short_sleeve', qty: 12 }
];

const stats = computeStats({ quotes: QUOTES, items: ITEMS, addons: ADDONS }, cfg);

describe('isoWeek', () => {
  test('formats an ISO week as yyyy-Www, zero-padded', () => {
    // 2026-06-08 is a Monday → ISO week 24 of 2026.
    expect(isoWeek('2026-06-08T10:00:00.000Z')).toBe('2026-W24');
    expect(isoWeek('2026-06-15T00:00:00.000Z')).toBe('2026-W25');
    // First days of January can belong to the previous ISO year.
    expect(isoWeek('2027-01-01T12:00:00.000Z')).toBe('2026-W53');
  });
});

describe('computeStats — KPIs', () => {
  test('totals, conversion, units, ticket and margins', () => {
    expect(stats.totalQuoted).toBe(1200);          // 600 + 400 + 200
    expect(stats.totalAccepted).toBe(600);         // only q1 accepted
    expect(stats.conversionPct).toBeCloseTo(1 / 3, 6); // 1 accepted / 3 total
    expect(stats.totalUnits).toBe(66);             // 24 + 30 + 12
    expect(stats.avgTicket).toBe(400);             // 1200 / 3
    // Value-weighted margin: Σ(margin·sale_base) / Σ(sale_base). A small
    // quote can't swing the KPI as much as a big job.
    //   (0.40·500 + 0.30·340 + 0.38·170) / (500 + 340 + 170)
    expect(stats.avgMarginPct).toBeCloseTo(
      (0.40 * 500 + 0.30 * 340 + 0.38 * 170) / (500 + 340 + 170), 6
    );
    expect(stats.targetMarginPct).toBe(cfg.parameters.default_target_margin);
  });
});

describe('computeStats — byPack', () => {
  test('count, units and total per pack, name from cfg', () => {
    const crew = stats.byPack.find((p) => p.packId === 'crew_full');
    expect(crew).toEqual({
      packId: 'crew_full', name: cfg.packs.crew_full.name,
      count: 2, units: 54, total: 1000
    });
    const tshirts = stats.byPack.find((p) => p.packId === 'tshirts_only');
    expect(tshirts).toEqual({
      packId: 'tshirts_only', name: cfg.packs.tshirts_only.name,
      count: 1, units: 12, total: 200
    });
  });
});

describe('computeStats — conversionByPack', () => {
  test('pending/accepted/rejected counts per pack', () => {
    const crew = stats.conversionByPack.find((p) => p.packId === 'crew_full');
    expect(crew).toMatchObject({ packId: 'crew_full', pending: 0, accepted: 1, rejected: 1 });
    const tshirts = stats.conversionByPack.find((p) => p.packId === 'tshirts_only');
    expect(tshirts).toMatchObject({ packId: 'tshirts_only', pending: 1, accepted: 0, rejected: 0 });
  });
});

describe('computeStats — weekly', () => {
  test('quoted vs accepted totals per ISO week, sorted ascending', () => {
    expect(stats.weekly).toEqual([
      { weekIso: '2026-W24', quoted: 1000, accepted: 600 },
      { weekIso: '2026-W25', quoted: 200, accepted: 0 }
    ]);
  });
});

describe('computeStats — byTier', () => {
  test('count and units per tier', () => {
    const t1 = stats.byTier.find((t) => t.tier === 'T1');
    expect(t1).toEqual({ tier: 'T1', count: 2, units: 36 }); // q1 + q3
    const t2 = stats.byTier.find((t) => t.tier === 'T2');
    expect(t2).toEqual({ tier: 'T2', count: 1, units: 30 }); // q2
  });
});

describe('computeStats — marginByPack', () => {
  test('value-weighted real margin vs target per pack', () => {
    const crew = stats.marginByPack.find((p) => p.packId === 'crew_full');
    // Weighted by sale_base: (0.40·500 + 0.30·340) / (500 + 340).
    expect(crew.realMarginPct).toBeCloseTo(
      (0.40 * 500 + 0.30 * 340) / (500 + 340), 6
    );
    expect(crew.targetPct).toBeCloseTo(0.35, 6);
  });
});

describe('computeStats — pvpDeviationHistogram', () => {
  test('buckets the pvp deviation, ignoring null deviations', () => {
    // q1 = -5%, q2 = -15%, q3 = null (skipped). Two quotes counted.
    const total = stats.pvpDeviationHistogram.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(2);
    expect(stats.pvpDeviationHistogram.every((b) => typeof b.bucketLabel === 'string')).toBe(true);
  });
});

describe('computeStats — topProducts / topAddons', () => {
  test('quantities aggregated and sorted desc, names from cfg', () => {
    const beagle = stats.topProducts.find((p) => p.productId === 'BEAGLE');
    expect(beagle).toEqual({ productId: 'BEAGLE', name: cfg.products.BEAGLE.name, qty: 66 }); // 24+30+12
    const clasica = stats.topProducts.find((p) => p.productId === 'CLASICA');
    expect(clasica).toEqual({ productId: 'CLASICA', name: cfg.products.CLASICA.name, qty: 24 });
    // Sorted by qty descending.
    expect(stats.topProducts[0].productId).toBe('BEAGLE');

    const name = stats.topAddons.find((a) => a.addonId === 'name');
    expect(name).toEqual({ addonId: 'name', label: cfg.addons.name.label, qty: 34 }); // 24 + 10
  });
});

describe('computeStats — specialSizes', () => {
  test('3XL/4XL/5XL counts per pack', () => {
    const crew = stats.specialSizes.find((p) => p.packId === 'crew_full');
    expect(crew).toEqual({
      packId: 'crew_full', name: cfg.packs.crew_full.name,
      q3xl: 2, q4xl: 1, q5xl: 1  // q1: 2/1/0, q2: 0/0/1
    });
  });
});

describe('computeStats — name fallback for archived/unknown ids', () => {
  test('an unknown pack/product/addon id falls back to the id itself', () => {
    const s = computeStats({
      quotes: [{
        id: 'qx', ts: '2026-06-08T10:00:00.000Z', pack_id: 'GHOST_PACK',
        tier: 'T1', total_units: 5, qty_3xl: 0, qty_4xl: 0, qty_5xl: 0,
        total_vat_inc: 50, sale_base: 40, margin_pct: 0.2, target_margin: 0.35,
        pvp_deviation_pct: null, status: 'pending'
      }],
      items: [{ quote_id: 'qx', product_id: 'GHOST_PROD', sides: 'one_side', qty: 5 }],
      addons: [{ quote_id: 'qx', addon_id: 'GHOST_ADDON', qty: 5 }]
    }, cfg);
    expect(s.byPack[0].name).toBe('GHOST_PACK');
    expect(s.topProducts[0].name).toBe('GHOST_PROD');
    expect(s.topAddons[0].label).toBe('GHOST_ADDON');
  });
});

describe('computeStats — empty input', () => {
  const empty = computeStats({ quotes: [], items: [], addons: [] }, cfg);

  test('KPIs are zeroed with no NaN / divide-by-zero', () => {
    expect(empty.totalQuoted).toBe(0);
    expect(empty.totalAccepted).toBe(0);
    expect(empty.conversionPct).toBe(0);
    expect(empty.totalUnits).toBe(0);
    expect(empty.avgTicket).toBe(0);
    expect(empty.avgMarginPct).toBe(0);
    expect(empty.targetMarginPct).toBe(cfg.parameters.default_target_margin);
    // No KPI is NaN.
    for (const k of ['totalQuoted', 'totalAccepted', 'conversionPct', 'totalUnits', 'avgTicket', 'avgMarginPct']) {
      expect(Number.isNaN(empty[k])).toBe(false);
    }
  });

  test('all the breakdown arrays are empty', () => {
    expect(empty.byPack).toEqual([]);
    expect(empty.conversionByPack).toEqual([]);
    expect(empty.weekly).toEqual([]);
    expect(empty.byTier).toEqual([]);
    expect(empty.marginByPack).toEqual([]);
    expect(empty.pvpDeviationHistogram).toEqual([]);
    expect(empty.topProducts).toEqual([]);
    expect(empty.topAddons).toEqual([]);
    expect(empty.specialSizes).toEqual([]);
  });
});

describe('computeStats — purity', () => {
  test('does not mutate the input rows', () => {
    const snapshot = JSON.stringify({ quotes: QUOTES, items: ITEMS, addons: ADDONS });
    computeStats({ quotes: QUOTES, items: ITEMS, addons: ADDONS }, cfg);
    expect(JSON.stringify({ quotes: QUOTES, items: ITEMS, addons: ADDONS })).toBe(snapshot);
  });
});
