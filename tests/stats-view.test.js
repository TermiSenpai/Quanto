// ============================================================
// Statistics view mapping (renderer/stats-view.js)
// ============================================================
// Pure adapters that turn the computeStats() object (lib/stats.js)
// into the chart-ready inputs and the accessible "Ver como tabla"
// rows the Statistics screen renders (UI-UX §2.7). No DOM, no charts
// library, no IPC — just stats in, plain data out — so the mapping
// (KPI formatting, chart series shapes, table rows, the empty-period
// decision) is pinned here, while the SVG itself is tested in
// charts.test.js and the DOM glue stays the untested-renderer norm.
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  isEmptyStats,
  kpiTiles,
  packUsageBars,
  conversionGroups,
  weeklySeries,
  tierBars,
  marginGroups,
  deviationBuckets,
  topProductBars,
  topAddonBars,
  specialSizeBars,
  rangeForPeriod
} from '../renderer/stats-view.js';

// A small but representative stats fixture (the shape computeStats emits).
const STATS = {
  totalQuoted: 12000,
  totalAccepted: 8000,
  conversionPct: 0.5,
  totalUnits: 340,
  avgTicket: 600,
  avgMarginPct: 0.32,
  targetMarginPct: 0.30,
  byPack: [
    { packId: 'pena', name: 'Pack peña', count: 10, units: 200, total: 8000 },
    { packId: 'urban', name: 'Urban', count: 6, units: 140, total: 4000 }
  ],
  conversionByPack: [
    { packId: 'pena', name: 'Pack peña', pending: 2, accepted: 6, rejected: 2 }
  ],
  weekly: [
    { weekIso: '2026-W20', quoted: 3000, accepted: 1500 },
    { weekIso: '2026-W21', quoted: 5000, accepted: 3500 }
  ],
  byTier: [
    { tier: 'T1', count: 4, units: 60 },
    { tier: 'T2', count: 8, units: 280 }
  ],
  marginByPack: [
    { packId: 'pena', name: 'Pack peña', realMarginPct: 0.34, targetPct: 0.30 }
  ],
  pvpDeviationHistogram: [
    { bucketLabel: '0%', count: 5 },
    { bucketLabel: '-10%', count: 2 }
  ],
  topProducts: [
    { productId: 'beagle', name: 'Beagle', qty: 120 },
    { productId: 'urban', name: 'Urban Sweat', qty: 80 }
  ],
  topAddons: [
    { addonId: 'name', label: 'Nombre', qty: 40 }
  ],
  specialSizes: [
    { packId: 'pena', name: 'Pack peña', q3xl: 3, q4xl: 2, q5xl: 1 }
  ]
};

const EMPTY = {
  totalQuoted: 0, totalAccepted: 0, conversionPct: 0, totalUnits: 0,
  avgTicket: 0, avgMarginPct: 0, targetMarginPct: 0.3,
  byPack: [], conversionByPack: [], weekly: [], byTier: [],
  marginByPack: [], pvpDeviationHistogram: [], topProducts: [],
  topAddons: [], specialSizes: []
};

describe('isEmptyStats', () => {
  test('a stats object with quotes is not empty', () => {
    expect(isEmptyStats(STATS)).toBe(false);
  });
  test('all-zero KPIs + empty arrays → empty', () => {
    expect(isEmptyStats(EMPTY)).toBe(true);
  });
  test('null/undefined → empty (never throws)', () => {
    expect(isEmptyStats(null)).toBe(true);
    expect(isEmptyStats(undefined)).toBe(true);
  });
});

describe('kpiTiles', () => {
  test('returns the six KPIs with formatted labels', () => {
    const tiles = kpiTiles(STATS);
    expect(tiles).toHaveLength(6);
    const byLabel = Object.fromEntries(tiles.map(t => [t.label, t.value]));
    expect(byLabel['Total presupuestado']).toContain('€');
    expect(byLabel['Total aceptado']).toContain('€');
    expect(byLabel['Tasa de conversión']).toContain('%');
    expect(byLabel['Unidades totales']).toBe('340');
    expect(byLabel['Ticket medio']).toContain('€');
    // Margin tile carries a tone flag (green when ≥ target).
    const margin = tiles.find(t => t.label === 'Margen real medio');
    expect(margin.value).toContain('%');
    expect(margin.good).toBe(true);
  });
  test('margin below target flags not-good', () => {
    const tiles = kpiTiles({ ...STATS, avgMarginPct: 0.20, targetMarginPct: 0.30 });
    const margin = tiles.find(t => t.label === 'Margen real medio');
    expect(margin.good).toBe(false);
  });
});

describe('packUsageBars', () => {
  test('maps byPack to horizontal-bar items by total', () => {
    const bars = packUsageBars(STATS);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ label: 'Pack peña', value: 8000 });
  });
  test('empty byPack → []', () => {
    expect(packUsageBars(EMPTY)).toEqual([]);
  });
});

describe('conversionGroups', () => {
  test('maps to grouped bars with pending/accepted/rejected', () => {
    const groups = conversionGroups(STATS);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Pack peña');
    const names = groups[0].bars.map(b => b.name);
    expect(names).toEqual(['Pendiente', 'Aceptado', 'Rechazado']);
    expect(groups[0].bars.map(b => b.value)).toEqual([2, 6, 2]);
  });
});

describe('weeklySeries', () => {
  test('returns two named series with point arrays', () => {
    const series = weeklySeries(STATS);
    expect(series).toHaveLength(2);
    expect(series[0].name).toBe('Presupuestado');
    expect(series[1].name).toBe('Aceptado');
    expect(series[0].points.map(p => p.y)).toEqual([3000, 5000]);
    expect(series[1].points.map(p => p.y)).toEqual([1500, 3500]);
  });
});

describe('tierBars', () => {
  test('maps byTier to vertical bars (count)', () => {
    const bars = tierBars(STATS);
    expect(bars.map(b => b.label)).toEqual(['T1', 'T2']);
    expect(bars.map(b => b.value)).toEqual([4, 8]);
  });
});

describe('marginGroups', () => {
  test('paired real vs target bars per pack, as percentages', () => {
    const groups = marginGroups(STATS);
    expect(groups[0].label).toBe('Pack peña');
    const bars = groups[0].bars;
    expect(bars.map(b => b.name)).toEqual(['Real', 'Objetivo']);
    // Percent points (×100), rounded.
    expect(bars[0].value).toBe(34);
    expect(bars[1].value).toBe(30);
  });
});

describe('deviationBuckets', () => {
  test('maps histogram buckets to {label,count}', () => {
    const buckets = deviationBuckets(STATS);
    expect(buckets).toEqual([
      { label: '0%', count: 5 },
      { label: '-10%', count: 2 }
    ]);
  });
});

describe('topProductBars / topAddonBars', () => {
  test('product bars use name + qty', () => {
    const bars = topProductBars(STATS);
    expect(bars[0]).toMatchObject({ label: 'Beagle', value: 120 });
  });
  test('addon bars use label + qty', () => {
    const bars = topAddonBars(STATS);
    expect(bars[0]).toMatchObject({ label: 'Nombre', value: 40 });
  });
});

describe('specialSizeBars', () => {
  test('flattens 3XL/4XL/5XL per pack into labelled bars', () => {
    const bars = specialSizeBars(STATS);
    // One pack × three sizes = three bars.
    expect(bars).toHaveLength(3);
    expect(bars.map(b => b.value)).toEqual([3, 2, 1]);
    expect(bars[0].label).toContain('3XL');
  });
});

describe('rangeForPeriod', () => {
  const NOW = new Date('2026-06-13T12:00:00.000Z');

  test('30d → from is 30 days before the reference day', () => {
    const { from, to } = rangeForPeriod('30d', NOW);
    // "to" is the end of the reference day; "from" is start-of-day 30 days
    // earlier. Compare the day-start of "from" to 30 days before the
    // reference's day-start so the within-day spans don't skew the count.
    const refDayStart = new Date('2026-06-13T00:00:00.000').getTime();
    expect(Date.parse(from)).toBe(refDayStart - 30 * 86400000);
    expect(Date.parse(to)).toBeGreaterThan(Date.parse(from));
  });

  test('year → from is at least ~365 days before to', () => {
    const { from, to } = rangeForPeriod('year', NOW);
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    expect(days).toBeGreaterThanOrEqual(365);
  });

  test('season → a wide window ending at "to" (non-empty ISO bounds)', () => {
    const { from, to } = rangeForPeriod('season', NOW);
    expect(Date.parse(from)).toBeLessThan(Date.parse(to));
  });

  test('range with explicit dates covers the chosen days inclusively', () => {
    const { from, to } = rangeForPeriod('range', NOW, { from: '2026-01-01', to: '2026-03-31' });
    // Bounds parse to the start-of-day of "from" and end-of-day of "to"
    // in local time (the inputs are plain dates). Compare against locally
    // constructed boundaries so the assertion is timezone-agnostic.
    expect(Date.parse(from)).toBe(new Date('2026-01-01T00:00:00.000').getTime());
    expect(Date.parse(to)).toBe(new Date('2026-03-31T23:59:59.999').getTime());
    // A same-day quote at noon on the end date falls within the range.
    const sameDayNoon = new Date('2026-03-31T12:00:00.000').getTime();
    expect(sameDayNoon).toBeLessThanOrEqual(Date.parse(to));
  });

  test('range without dates falls back to the season window (no crash)', () => {
    const r = rangeForPeriod('range', NOW, {});
    expect(Date.parse(r.from)).toBeLessThan(Date.parse(r.to));
  });
});
