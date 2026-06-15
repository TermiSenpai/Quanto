// ============================================================
// PackPrice · Statistics view mapping (pure, renderer)
// ============================================================
// The Statistics screen (UI-UX §2.7) gets a fully-computed `stats`
// object from main (lib/stats.js aggregates; the renderer only paints).
// This module is the pure adapter layer between that object and the
// chart helpers (renderer/charts.js): it shapes each chart's input,
// formats the KPI tiles, decides whether a period is genuinely empty,
// and turns a period choice into an ISO {from,to} range. No DOM, no
// charts library, no IPC — same input → same output — so the mapping
// is testable in plain Node while the SVG-injection glue stays in
// app.js (the untested-renderer norm).
// ============================================================

'use strict';

// --- formatters (Spanish UI; data-only, no DOM) ---

/** "12.000,00 €" — es-ES grouping, two decimals. */
function eur(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/** "32 %" — a fraction in [0,1] rendered as a whole-ish percentage. */
function pct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '—';
  return (n * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' %';
}

/** Rounds a fraction to a whole percentage number for chart axes. */
function pctNum(fraction) {
  const n = Number(fraction);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * A period is empty when there are no quotes at all in it: the safe
 * signal to show the explanatory empty state instead of misleading
 * zero charts (§2.7). We key off the breakdown arrays (each is built
 * only from real quotes) plus the count-bearing KPIs.
 */
export function isEmptyStats(stats) {
  if (!stats) return true;
  const arrays = [
    stats.byPack, stats.weekly, stats.byTier, stats.topProducts,
    stats.topAddons, stats.conversionByPack, stats.marginByPack,
    stats.specialSizes, stats.pvpDeviationHistogram
  ];
  const anyRows = arrays.some(a => Array.isArray(a) && a.length > 0);
  const anyTotals = Number(stats.totalQuoted) > 0 || Number(stats.totalUnits) > 0;
  return !anyRows && !anyTotals;
}

/**
 * The six KPI tiles (UI-UX §2.7). The margin tile carries `good` so the
 * caller can tint it green (≥ target) or amber (below) — text + tone,
 * never colour alone (§2.8: the value is always shown).
 */
export function kpiTiles(stats) {
  const s = stats || {};
  return [
    { label: 'Total presupuestado', value: eur(s.totalQuoted) },
    { label: 'Total aceptado', value: eur(s.totalAccepted) },
    { label: 'Tasa de conversión', value: pct(s.conversionPct) },
    { label: 'Unidades totales', value: String(Math.round(Number(s.totalUnits) || 0)) },
    { label: 'Ticket medio', value: eur(s.avgTicket) },
    {
      label: 'Margen real medio',
      value: pct(s.avgMarginPct),
      sub: `Objetivo ${pct(s.targetMarginPct)}`,
      good: Number(s.avgMarginPct) >= Number(s.targetMarginPct)
    }
  ];
}

// --- chart inputs (each returns the shape charts.js expects) ---

/** byPack → horizontal bars by total quoted (€). */
export function packUsageBars(stats) {
  return (stats && Array.isArray(stats.byPack) ? stats.byPack : [])
    .map(p => ({ label: p.name, value: p.total }));
}

/** conversionByPack → grouped bars (pending / accepted / rejected). */
export function conversionGroups(stats) {
  return (stats && Array.isArray(stats.conversionByPack) ? stats.conversionByPack : [])
    .map(p => ({
      label: p.name,
      bars: [
        { name: 'Pendiente', value: p.pending },
        { name: 'Aceptado', value: p.accepted },
        { name: 'Rechazado', value: p.rejected }
      ]
    }));
}

/** weekly → two line series (quoted vs accepted) over the week index. */
export function weeklySeries(stats) {
  const weekly = stats && Array.isArray(stats.weekly) ? stats.weekly : [];
  return [
    { name: 'Presupuestado', points: weekly.map((w, i) => ({ x: i, y: w.quoted })) },
    { name: 'Aceptado', points: weekly.map((w, i) => ({ x: i, y: w.accepted })) }
  ];
}

/** byTier → vertical bars (count of quotes per tier). */
export function tierBars(stats) {
  return (stats && Array.isArray(stats.byTier) ? stats.byTier : [])
    .map(t => ({ label: t.tier, value: t.count }));
}

/** marginByPack → grouped bars (real vs target), as whole percentages. */
export function marginGroups(stats) {
  return (stats && Array.isArray(stats.marginByPack) ? stats.marginByPack : [])
    .map(m => ({
      label: m.name,
      bars: [
        { name: 'Real', value: pctNum(m.realMarginPct) },
        { name: 'Objetivo', value: pctNum(m.targetPct) }
      ]
    }));
}

/** pvpDeviationHistogram → histogram buckets {label,count}. */
export function deviationBuckets(stats) {
  return (stats && Array.isArray(stats.pvpDeviationHistogram) ? stats.pvpDeviationHistogram : [])
    .map(b => ({ label: b.bucketLabel, count: b.count }));
}

/** topProducts → horizontal bars (qty ordered to suppliers). */
export function topProductBars(stats) {
  return (stats && Array.isArray(stats.topProducts) ? stats.topProducts : [])
    .map(p => ({ label: p.name, value: p.qty }));
}

/** topAddons → horizontal bars (qty). */
export function topAddonBars(stats) {
  return (stats && Array.isArray(stats.topAddons) ? stats.topAddons : [])
    .map(a => ({ label: a.label, value: a.qty }));
}

/**
 * specialSizes → vertical bars, one per (pack × size) with a non-zero
 * count. Flattening keeps every special-size column on one axis so the
 * internal cost of large sizes reads at a glance (§2.7). The pack name
 * prefixes the bar only when there is more than one pack, to avoid
 * needless repetition with a single pack.
 */
export function specialSizeBars(stats) {
  const rows = stats && Array.isArray(stats.specialSizes) ? stats.specialSizes : [];
  const multi = rows.length > 1;
  const bars = [];
  for (const r of rows) {
    const prefix = multi ? `${r.name} · ` : '';
    bars.push({ label: `${prefix}3XL`, value: r.q3xl });
    bars.push({ label: `${prefix}4XL`, value: r.q4xl });
    bars.push({ label: `${prefix}5XL`, value: r.q5xl });
  }
  return bars;
}

// --- period → ISO date range ---

const DAY_MS = 86400000;

/**
 * Resolves a period choice to inclusive ISO {from,to} bounds for
 * getStats. `to` is the end of "now"'s day (or the chosen end day) so a
 * quote saved earlier today is still counted. The "season" window is a
 * generous ~180 days (a workshop's busy stretch) — there is no fixed
 * season calendar, so we use a wide trailing window rather than guess.
 *
 * @param {string} period  'season' | '30d' | 'year' | 'range'
 * @param {Date}   [now]   reference now (defaults to new Date())
 * @param {{from?:string,to?:string}} [custom]  explicit dates for 'range'
 * @returns {{ from: string, to: string }} ISO strings
 */
export function rangeForPeriod(period, now = new Date(), custom = {}) {
  const ref = now instanceof Date ? now : new Date(now);

  if (period === 'range' && custom && custom.from && custom.to) {
    // The date inputs give plain YYYY-MM-DD; extend "to" to the day's end
    // so same-day quotes fall inside the inclusive bound.
    return {
      from: new Date(`${custom.from}T00:00:00.000`).toISOString(),
      to: new Date(`${custom.to}T23:59:59.999`).toISOString()
    };
  }

  const to = new Date(ref.getTime());
  to.setHours(23, 59, 59, 999);

  let backDays;
  if (period === '30d') backDays = 30;
  else if (period === 'year') backDays = 366;
  else backDays = 180; // season (and the 'range' fallback)

  const from = new Date(ref.getTime() - backDays * DAY_MS);
  from.setHours(0, 0, 0, 0);

  return { from: from.toISOString(), to: to.toISOString() };
}
