// ============================================================
// Quanto · Pure statistics aggregator
// ============================================================
// computeStats({ quotes, items, addons }, cfg) → every indicator the
// Estadísticas screen (docs/UI-UX §2.7) renders. There is no Worker:
// lib/cloud-quotes.js fetchStatsData brings the raw rows (filtered by
// date) and this PURE, deterministic function does all the aggregation
// in memory (the workshop's volume fits comfortably). The renderer only
// paints the result via renderer/charts.js.
//
// Purity: no I/O, no Date.now(), no `new Date()` without arguments. The
// only Date use is `new Date(ts)` to PARSE the timestamp a quote already
// carries — fully determined by the input, so the same rows always yield
// the same stats. Names are resolved from cfg; an archived/unknown id
// falls back to the id itself (quotes outlive catalog edits — FK-free by
// design, db/migrations/0001_init.sql).
//
// Week-bucket convention: ISO 8601 week date, `yyyy-Www` (e.g.
// 2026-W24). The ISO year can differ from the calendar year for the
// first/last days of January/December (e.g. 2027-01-01 → 2026-W53), which
// is correct and keeps weeks contiguous across year boundaries.
// ============================================================

'use strict';

// ---- ISO week helpers (pure: derive from the quote's own ts) ----

/**
 * ISO 8601 week-numbering: returns { year, week } for a timestamp.
 * Thursday-anchored — the ISO week belongs to the year of its Thursday.
 * Computed in UTC so the bucket is deterministic regardless of the host
 * timezone.
 *
 * @param {string} ts - ISO-8601 timestamp
 * @returns {{year: number, week: number}}
 */
function isoWeekParts(ts) {
  const d = new Date(ts);
  // Work on a UTC copy at midnight to avoid DST/timezone drift.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weekday: Monday=1 … Sunday=7.
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  // Shift to the Thursday of this week: the ISO year is that Thursday's year.
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { year: isoYear, week };
}

/**
 * ISO week label `yyyy-Www`, zero-padded to two week digits.
 * @param {string} ts
 * @returns {string}
 */
function isoWeek(ts) {
  const { year, week } = isoWeekParts(ts);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ---- name resolution (cfg lookups, id fallback) ----

function packName(cfg, packId) {
  return (cfg.packs && cfg.packs[packId] && cfg.packs[packId].name) || packId;
}
function productName(cfg, productId) {
  return (cfg.products && cfg.products[productId] && cfg.products[productId].name) || productId;
}
function addonLabel(cfg, addonId) {
  return (cfg.addons && cfg.addons[addonId] && cfg.addons[addonId].label) || addonId;
}
function packTargetMargin(cfg, packId, fallback) {
  const pack = cfg.packs && cfg.packs[packId];
  const m = pack && pack.target_margin;
  return m === undefined || m === null ? fallback : m;
}

// ---- small numeric helpers (no NaN / divide-by-zero) ----

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function safeDiv(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

// pvp-deviation histogram buckets (fraction; -0.10 = "rebajado un 10%").
// Edges chosen for the «¿cuánto se rebaja a mano?» question (UI-UX §2.7).
const DEVIATION_BUCKETS = [
  { label: '< -20%', min: -Infinity, max: -0.20 },
  { label: '-20%…-10%', min: -0.20, max: -0.10 },
  { label: '-10%…0%', min: -0.10, max: 0 },
  { label: '0%…+10%', min: 0, max: 0.10 },
  { label: '> +10%', min: 0.10, max: Infinity }
];

function deviationBucketLabel(dev) {
  for (const b of DEVIATION_BUCKETS) {
    // Half-open (min, max] except the unbounded ends.
    if (dev > b.min && dev <= b.max) return b.label;
  }
  return DEVIATION_BUCKETS[DEVIATION_BUCKETS.length - 1].label;
}

/**
 * Aggregates raw quote/item/addon rows into the full statistics object.
 *
 * @param {object} data
 * @param {object[]} data.quotes
 * @param {object[]} data.items
 * @param {object[]} data.addons
 * @param {object} cfg - the loaded catalog config (for name resolution + target margin)
 * @returns {object} KPIs + breakdown arrays (see UI-UX §2.7)
 */
function computeStats({ quotes = [], items = [], addons = [] }, cfg = {}) {
  const targetMarginPct = num(
    cfg.parameters && cfg.parameters.default_target_margin
  );

  // ---- KPIs ----
  let totalQuoted = 0;
  let totalAccepted = 0;
  let acceptedCount = 0;
  let totalUnits = 0;
  // The margin KPI is VALUE-WEIGHTED by sale_base, not a simple mean:
  // Σ(margin_pct·sale_base) / Σ(sale_base). «Do we respect the margin?» is
  // a question about money, so a 4-unit quote must not swing the indicator
  // as much as a 200-unit job. (marginWeight is the Σ(sale_base) divisor.)
  let marginWeightedSum = 0;
  let marginWeight = 0;

  // ---- per-key accumulators (insertion order preserved by Map) ----
  const packs = new Map();     // packId → { count, units, total, pending, accepted, rejected, marginWeightedSum, marginWeight, q3xl, q4xl, q5xl }
  const weeks = new Map();     // weekIso → { quoted, accepted }
  const tiers = new Map();     // tier → { count, units }
  const products = new Map();  // productId → qty
  const addonQty = new Map();  // addonId → qty
  const histogram = new Map(DEVIATION_BUCKETS.map((b) => [b.label, 0]));

  for (const q of quotes) {
    const total = num(q.total_vat_inc);
    const units = num(q.total_units);
    const status = q.status || 'pending';
    const marginPct = num(q.margin_pct);
    const saleBase = num(q.sale_base);

    totalQuoted += total;
    totalUnits += units;
    marginWeightedSum += marginPct * saleBase;
    marginWeight += saleBase;
    if (status === 'accepted') { totalAccepted += total; acceptedCount++; }

    // byPack + conversionByPack + marginByPack + specialSizes share one accumulator.
    const pid = q.pack_id;
    if (!packs.has(pid)) {
      packs.set(pid, {
        count: 0, units: 0, total: 0,
        pending: 0, accepted: 0, rejected: 0,
        marginWeightedSum: 0, marginWeight: 0,
        q3xl: 0, q4xl: 0, q5xl: 0
      });
    }
    const pAcc = packs.get(pid);
    pAcc.count++;
    pAcc.units += units;
    pAcc.total += total;
    if (status === 'pending') pAcc.pending++;
    else if (status === 'accepted') pAcc.accepted++;
    else if (status === 'rejected') pAcc.rejected++;
    pAcc.marginWeightedSum += marginPct * saleBase;
    pAcc.marginWeight += saleBase;
    pAcc.q3xl += num(q.qty_3xl);
    pAcc.q4xl += num(q.qty_4xl);
    pAcc.q5xl += num(q.qty_5xl);

    // weekly
    const wk = isoWeek(q.ts);
    if (!weeks.has(wk)) weeks.set(wk, { quoted: 0, accepted: 0 });
    const wAcc = weeks.get(wk);
    wAcc.quoted += total;
    if (status === 'accepted') wAcc.accepted += total;

    // byTier
    const tier = q.tier;
    if (!tiers.has(tier)) tiers.set(tier, { count: 0, units: 0 });
    const tAcc = tiers.get(tier);
    tAcc.count++;
    tAcc.units += units;

    // pvp deviation histogram (null deviation skipped — not "manually discounted")
    if (q.pvp_deviation_pct !== null && q.pvp_deviation_pct !== undefined) {
      const label = deviationBucketLabel(num(q.pvp_deviation_pct));
      histogram.set(label, histogram.get(label) + 1);
    }
  }

  for (const it of items) {
    products.set(it.product_id, (products.get(it.product_id) || 0) + num(it.qty));
  }
  for (const ad of addons) {
    addonQty.set(ad.addon_id, (addonQty.get(ad.addon_id) || 0) + num(ad.qty));
  }

  const totalCount = quotes.length;

  // ---- shape the breakdown arrays ----
  const byPack = [];
  const conversionByPack = [];
  const marginByPack = [];
  const specialSizes = [];
  for (const [packId, a] of packs) {
    const name = packName(cfg, packId);
    byPack.push({ packId, name, count: a.count, units: a.units, total: a.total });
    conversionByPack.push({ packId, name, pending: a.pending, accepted: a.accepted, rejected: a.rejected });
    marginByPack.push({
      packId, name,
      // Value-weighted by sale_base (guarded /0 → 0): the per-pack twin of
      // the avgMarginPct KPI, so a small quote can't skew the pack's margin.
      realMarginPct: safeDiv(a.marginWeightedSum, a.marginWeight),
      targetPct: packTargetMargin(cfg, packId, targetMarginPct)
    });
    specialSizes.push({ packId, name, q3xl: a.q3xl, q4xl: a.q4xl, q5xl: a.q5xl });
  }

  const weekly = [...weeks.entries()]
    .map(([weekIso, a]) => ({ weekIso, quoted: a.quoted, accepted: a.accepted }))
    .sort((x, y) => x.weekIso.localeCompare(y.weekIso));

  const byTier = [...tiers.entries()]
    .map(([tier, a]) => ({ tier, count: a.count, units: a.units }))
    .sort((x, y) => String(x.tier).localeCompare(String(y.tier)));

  // Histogram: only buckets that actually contain quotes (empty input → []).
  const pvpDeviationHistogram = [...histogram.entries()]
    .filter(([, count]) => count > 0)
    .map(([bucketLabel, count]) => ({ bucketLabel, count }));

  const topProducts = [...products.entries()]
    .map(([productId, qty]) => ({ productId, name: productName(cfg, productId), qty }))
    .sort((x, y) => y.qty - x.qty);

  const topAddons = [...addonQty.entries()]
    .map(([addonId, qty]) => ({ addonId, label: addonLabel(cfg, addonId), qty }))
    .sort((x, y) => y.qty - x.qty);

  return {
    // KPIs
    totalQuoted,
    totalAccepted,
    conversionPct: safeDiv(acceptedCount, totalCount),
    totalUnits,
    avgTicket: safeDiv(totalQuoted, totalCount),
    // Value-weighted margin (guarded /0 → 0): Σ(margin·sale_base)/Σ(sale_base).
    avgMarginPct: safeDiv(marginWeightedSum, marginWeight),
    targetMarginPct,
    // breakdowns
    byPack,
    conversionByPack,
    weekly,
    byTier,
    marginByPack,
    pvpDeviationHistogram,
    topProducts,
    topAddons,
    specialSizes
  };
}

module.exports = { computeStats, isoWeek, isoWeekParts };
