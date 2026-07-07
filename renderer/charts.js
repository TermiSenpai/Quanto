// ============================================================
// Quanto · SVG chart helpers (pure, renderer)
// ============================================================
// Hand-rolled, dependency-free SVG charting for the Statistics screen
// (UI-UX §2.7). CLAUDE.md rule 9 forbids chart libraries — three simple
// chart shapes do not justify a runtime dependency — so each function
// here builds an SVG by hand and returns a self-contained `<svg>…</svg>`
// STRING. The renderer injects that string into the DOM in Task 5C; this
// module never touches the DOM, window or the network, which keeps it a
// trivially testable pure unit (same input → same string).
//
// WHY everything is escaped: chart labels come from the catalog (cfg) and
// from D1 rows — i.e. user-controlled data. Dropped raw into an SVG
// `<text>` they would be an XSS vector, so every label/series name passes
// through escapeXml() before it reaches the markup.
//
// WHY empty-state instead of an empty axis: a period with no data (or
// all-zero values) must show a friendly "Sin datos" message, never a
// broken axis, NaN coordinates or a misleading flat-zero chart (§2.7).
// Every division by a max/length is guarded for that reason.
// ============================================================

'use strict';

// Default canvas + inner padding (room for axis labels). Callers may
// override width/height via opts; the rest is derived so charts scale.
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 220;
const PAD = { top: 24, right: 16, bottom: 36, left: 48 };

// Fallback palette (token mirror) for items that don't carry their own
// colour. These match styles.css --pack-color-1…6 / accent / status so
// charts look native even when the caller doesn't pass colors[].
const DEFAULT_COLORS = [
  '#3D7BD9', '#1FA86A', '#D98A1F', '#7C5CD9', '#0EA5A8', '#DC2867'
];
const AXIS_COLOR = '#C8CDD6';
const TEXT_COLOR = '#5A6270';
const EMPTY_TEXT = 'Sin datos';
// Danger tone (mirrors styles.css --danger) for a negative bar that carries
// no explicit colour — a loss reads as a loss, not just another category.
const DANGER_COLOR = '#D24D4D';

/**
 * Computes a zero-baseline signed value axis for bar charts. Negative data
 * (e.g. a loss-making pack's realMarginPct) MUST render — a `<rect>` with a
 * negative height/width is silently dropped by Chromium, so we instead draw
 * every bar with POSITIVE dimensions from a zero line that we place inside
 * the plot according to the data range.
 *
 * The domain spans [min(0,…), max(0,…)] so zero is always on the axis:
 *   - all-positive data ⇒ min=0, baseline at the bottom (geometry unchanged
 *     vs. the old code: a full-positive chart looks identical);
 *   - any negative value ⇒ the baseline lifts off the edge and negatives draw
 *     toward the far side (down for vertical, left for horizontal).
 *
 * @param {number[]} values
 * @param {number} extent  plot height (vertical) or width (horizontal)
 * @returns {{ min:number, max:number, span:number, zeroOffset:number,
 *            lengthFor:(v:number)=>number }}
 *   zeroOffset is the distance of the zero line from the plot's start edge;
 *   lengthFor(v) returns the always-positive bar length for value v.
 */
function signedScale(values, extent) {
  let dataMin = 0;
  let dataMax = 0;
  for (const v of values) {
    const f = finite(v);
    if (f < dataMin) dataMin = f;
    if (f > dataMax) dataMax = f;
  }
  // span is 0 only when every value is 0 → all bars collapse to length 0.
  const span = dataMax - dataMin;
  // Distance from the data-min edge up to the zero line.
  const zeroOffset = span > 0 ? (0 - dataMin) / span * extent : 0;
  const lengthFor = (v) => {
    if (span <= 0) return 0;
    return Math.abs(finite(v)) / span * extent;
  };
  return { min: dataMin, max: dataMax, span, zeroOffset, lengthFor };
}

/**
 * Escapes a value for safe inclusion in SVG text/attributes. Labels come
 * from cfg/D1 (untrusted), so `<`, `>`, `&`, `"` and `'` are entity-encoded
 * — a label containing `<script>` becomes `&lt;script&gt;`. Non-strings are
 * coerced; null/undefined collapse to '' so "undefined" never leaks out.
 *
 * @param {*} value
 * @returns {string}
 */
function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Coerces a value to a finite number, defaulting non-finite (NaN, ±∞,
 * non-numeric) inputs to `fallback`. Keeps "NaN"/"Infinity" out of the SVG.
 *
 * @param {*} n
 * @param {number} [fallback=0]
 * @returns {number}
 */
function finite(n, fallback = 0) {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Rounds a coordinate to 2 decimals (compact, deterministic markup) and
 * guarantees a finite result so no NaN reaches an x/y attribute.
 *
 * @param {number} n
 * @returns {number}
 */
function r(n) {
  return Math.round(finite(n) * 100) / 100;
}

// Resolves canvas size from opts, clamping to sane positive numbers.
function resolveSize(opts) {
  const width = Math.max(80, Math.round(finite(opts.width, DEFAULT_WIDTH)));
  const height = Math.max(60, Math.round(finite(opts.height, DEFAULT_HEIGHT)));
  return { width, height };
}

// Opens the root <svg> with a viewBox + accessible <desc> (§2.8).
function openSvg(width, height, desc) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img">` +
    `<desc>${escapeXml(desc)}</desc>`
  );
}

// Centered empty-state message used by every chart when there is no data.
function emptyState(width, height, desc) {
  return (
    openSvg(width, height, desc || EMPTY_TEXT) +
    `<text x="${r(width / 2)}" y="${r(height / 2)}" text-anchor="middle" ` +
    `font-size="13" fill="${TEXT_COLOR}">${EMPTY_TEXT}</text>` +
    '</svg>'
  );
}

// Picks a per-item colour: explicit item/opts colour first, else palette.
function pickColor(explicit, colors, index) {
  if (explicit) return escapeXml(explicit);
  const palette = Array.isArray(colors) && colors.length ? colors : DEFAULT_COLORS;
  return escapeXml(palette[index % palette.length]);
}

/**
 * Horizontal bar chart — pack usage / top products (UI-UX §2.7).
 *
 * @param {{ label?: *, value?: number, color?: string }[]} items
 * @param {{ width?: number, height?: number, colors?: string[],
 *           desc?: string }} [opts]
 * @returns {string} self-contained `<svg>…</svg>`
 */
export function barChartH(items, opts = {}) {
  const { width, height } = resolveSize(opts);
  const list = Array.isArray(items) ? items : [];
  const desc = opts.desc || 'Gráfico de barras horizontales';
  if (list.length === 0) return emptyState(width, height, desc);

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const band = plotH / list.length;
  const barH = Math.max(2, band * 0.6);

  // Zero-baseline signed x axis: positives grow right of zero, negatives left,
  // both with positive width. For all-positive data zero sits at PAD.left so
  // the geometry is identical to the previous max-based layout.
  const scale = signedScale(list.map((it) => it && it.value), plotW);
  const zeroX = PAD.left + scale.zeroOffset;

  let body = openSvg(width, height, desc);
  // Draw the zero line only when there is a negative region to separate.
  if (scale.min < 0) {
    body +=
      `<line x1="${r(zeroX)}" y1="${r(PAD.top)}" x2="${r(zeroX)}" ` +
      `y2="${r(PAD.top + plotH)}" stroke="${AXIS_COLOR}" stroke-width="1"/>`;
  }
  list.forEach((it, i) => {
    const value = finite(it && it.value);
    const len = scale.lengthFor(value); // always >= 0
    // Negative bars start len to the left of zero; positives start at zero.
    const x = value < 0 ? zeroX - len : zeroX;
    const y = PAD.top + i * band + (band - barH) / 2;
    const explicit = (it && it.color) || (value < 0 ? DANGER_COLOR : null);
    const color = pickColor(explicit, opts.colors, i);
    const label = escapeXml(it && it.label);
    body +=
      `<rect x="${r(x)}" y="${r(y)}" width="${r(len)}" height="${r(barH)}" ` +
      `fill="${color}" rx="2">` +
      `<title>${label}: ${escapeXml(value)}</title></rect>`;
    // Category label to the left of the axis.
    body +=
      `<text x="${r(PAD.left - 6)}" y="${r(y + barH / 2)}" text-anchor="end" ` +
      `dominant-baseline="middle" font-size="11" fill="${TEXT_COLOR}">${label}</text>`;
    // Value at the bar end (right end for positives, left end for negatives),
    // clamped to the plot so the text x never goes off-canvas.
    const valX = value < 0 ? Math.max(PAD.left, x - 4) : x + len + 4;
    const anchor = value < 0 ? 'end' : 'start';
    body +=
      `<text x="${r(valX)}" y="${r(y + barH / 2)}" text-anchor="${anchor}" ` +
      `dominant-baseline="middle" font-size="11" fill="${TEXT_COLOR}">${escapeXml(value)}</text>`;
  });
  body += '</svg>';
  return body;
}

/**
 * Vertical bar chart — tiers / special sizes (UI-UX §2.7).
 *
 * @param {{ label?: *, value?: number, color?: string }[]} items
 * @param {{ width?: number, height?: number, colors?: string[],
 *           desc?: string }} [opts]
 * @returns {string}
 */
export function barChartV(items, opts = {}) {
  const { width, height } = resolveSize(opts);
  const list = Array.isArray(items) ? items : [];
  const desc = opts.desc || 'Gráfico de barras verticales';
  if (list.length === 0) return emptyState(width, height, desc);

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const baseY = PAD.top + plotH;
  const band = plotW / list.length;
  const barW = Math.max(2, band * 0.6);

  // Zero-baseline signed y axis: positives grow up from zero, negatives down,
  // both with positive height. All-positive data keeps zero at the bottom
  // (baseY), so its geometry is identical to the previous layout.
  const scale = signedScale(list.map((it) => it && it.value), plotH);
  const zeroY = baseY - scale.zeroOffset;

  let body = openSvg(width, height, desc);
  // Baseline axis sits at the zero line (bottom when all-positive).
  body +=
    `<line x1="${r(PAD.left)}" y1="${r(zeroY)}" x2="${r(PAD.left + plotW)}" ` +
    `y2="${r(zeroY)}" stroke="${AXIS_COLOR}" stroke-width="1"/>`;
  list.forEach((it, i) => {
    const value = finite(it && it.value);
    const h = scale.lengthFor(value); // always >= 0
    const x = PAD.left + i * band + (band - barW) / 2;
    // Positive bars start h above zero; negative bars start at zero (grow down).
    const y = value < 0 ? zeroY : zeroY - h;
    const explicit = (it && it.color) || (value < 0 ? DANGER_COLOR : null);
    const color = pickColor(explicit, opts.colors, i);
    const label = escapeXml(it && it.label);
    body +=
      `<rect x="${r(x)}" y="${r(y)}" width="${r(barW)}" height="${r(h)}" ` +
      `fill="${color}" rx="2">` +
      `<title>${label}: ${escapeXml(value)}</title></rect>`;
    // Category label below the plot (not the zero line — labels stay aligned).
    body +=
      `<text x="${r(x + barW / 2)}" y="${r(baseY + 14)}" text-anchor="middle" ` +
      `font-size="11" fill="${TEXT_COLOR}">${label}</text>`;
    // Value at the bar's outer end: above positives, below negatives, clamped
    // to the plot so the text y never leaves the canvas.
    const valY = value < 0
      ? Math.min(baseY, y + h + 12)
      : Math.max(PAD.top, y - 4);
    body +=
      `<text x="${r(x + barW / 2)}" y="${r(valY)}" text-anchor="middle" ` +
      `font-size="11" fill="${TEXT_COLOR}">${escapeXml(value)}</text>`;
  });
  body += '</svg>';
  return body;
}

/**
 * Grouped (paired) bars per category — margin real vs target,
 * conversion pending/accepted/rejected (UI-UX §2.7).
 *
 * @param {{ label?: *, bars?: { value?: number, color?: string, name?: * }[] }[]} groups
 * @param {{ width?: number, height?: number, desc?: string }} [opts]
 * @returns {string}
 */
export function groupedBars(groups, opts = {}) {
  const { width, height } = resolveSize(opts);
  const list = Array.isArray(groups) ? groups : [];
  const desc = opts.desc || 'Gráfico de barras agrupadas';
  // Empty when there are no groups, or no group carries any bar.
  const hasBars = list.some((g) => g && Array.isArray(g.bars) && g.bars.length > 0);
  if (list.length === 0 || !hasBars) return emptyState(width, height, desc);

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const baseY = PAD.top + plotH;
  const groupBand = plotW / list.length;

  // Global zero-baseline signed y scale across EVERY bar of EVERY group, so a
  // loss-making pack (negative realMarginPct) shares the axis with the rest.
  // A negative bar previously produced a negative-height rect that Chromium
  // drops — i.e. the loss vanished exactly when it mattered. Now every bar has
  // a positive height drawn from the zero line; negatives grow downward.
  const allValues = [];
  for (const g of list) {
    const bars = (g && Array.isArray(g.bars)) ? g.bars : [];
    for (const b of bars) allValues.push(b && b.value);
  }
  const scale = signedScale(allValues, plotH);
  const zeroY = baseY - scale.zeroOffset;

  let body = openSvg(width, height, desc);
  body +=
    `<line x1="${r(PAD.left)}" y1="${r(zeroY)}" x2="${r(PAD.left + plotW)}" ` +
    `y2="${r(zeroY)}" stroke="${AXIS_COLOR}" stroke-width="1"/>`;
  list.forEach((g, gi) => {
    const bars = (g && Array.isArray(g.bars)) ? g.bars : [];
    const groupX = PAD.left + gi * groupBand;
    const innerW = groupBand * 0.8;
    const innerX = groupX + (groupBand - innerW) / 2;
    // Guard division: a group with no bars contributes nothing.
    const slot = bars.length > 0 ? innerW / bars.length : innerW;
    const barW = Math.max(2, slot * 0.8);
    bars.forEach((b, bi) => {
      const value = finite(b && b.value);
      const h = scale.lengthFor(value); // always >= 0
      const x = innerX + bi * slot + (slot - barW) / 2;
      // Positive bars start h above zero; negatives start at zero, grow down.
      const y = value < 0 ? zeroY : zeroY - h;
      const explicit = (b && b.color) || (value < 0 ? DANGER_COLOR : null);
      const color = pickColor(explicit, opts.colors, bi);
      const name = escapeXml(b && b.name);
      body +=
        `<rect x="${r(x)}" y="${r(y)}" width="${r(barW)}" height="${r(h)}" ` +
        `fill="${color}" rx="2">` +
        `<title>${name}: ${escapeXml(value)}</title></rect>`;
    });
    // Category label under the group (anchored at the plot bottom).
    body +=
      `<text x="${r(groupX + groupBand / 2)}" y="${r(baseY + 14)}" ` +
      `text-anchor="middle" font-size="11" fill="${TEXT_COLOR}">${escapeXml(g && g.label)}</text>`;
  });
  body += '</svg>';
  return body;
}

// Normalizes a series' points to an array of {x, y} with finite numbers.
// Accepts either [{x, y}, …] or a bare [y, y, …] (x = index).
function normalizePoints(points) {
  const arr = Array.isArray(points) ? points : [];
  return arr.map((p, i) => {
    if (p && typeof p === 'object') {
      return { x: finite(p.x, i), y: finite(p.y) };
    }
    return { x: i, y: finite(p) };
  });
}

/**
 * Line chart — one or more polylines over an x axis. Weekly quoted vs
 * accepted (UI-UX §2.7).
 *
 * @param {{ name?: *, color?: string,
 *           points?: ({x:number,y:number}[]|number[]) }[]} series
 * @param {{ width?: number, height?: number, desc?: string }} [opts]
 * @returns {string}
 */
export function lineChart(series, opts = {}) {
  const { width, height } = resolveSize(opts);
  const list = Array.isArray(series) ? series : [];
  const desc = opts.desc || 'Gráfico de líneas';

  const normalized = list.map((s, i) => ({
    name: s && s.name,
    color: pickColor(s && s.color, opts.colors, i),
    points: normalizePoints(s && s.points)
  }));
  const hasPoints = normalized.some((s) => s.points.length > 0);
  if (normalized.length === 0 || !hasPoints) return emptyState(width, height, desc);

  // Shared x/y domain across all series. Guard every min/max with a
  // fallback so a single point or a flat series can't yield NaN.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of normalized) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) { minX = 0; maxX = 0; }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
  const spanX = maxX - minX || 1; // avoid /0 for a single x
  const spanY = maxY - minY || 1; // avoid /0 for a flat series

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const baseY = PAD.top + plotH;
  const sx = (x) => PAD.left + ((x - minX) / spanX) * plotW;
  const sy = (y) => baseY - ((y - minY) / spanY) * plotH;

  let body = openSvg(width, height, desc);
  // x and y axes.
  body +=
    `<line x1="${r(PAD.left)}" y1="${r(baseY)}" x2="${r(PAD.left + plotW)}" ` +
    `y2="${r(baseY)}" stroke="${AXIS_COLOR}" stroke-width="1"/>`;
  body +=
    `<line x1="${r(PAD.left)}" y1="${r(PAD.top)}" x2="${r(PAD.left)}" ` +
    `y2="${r(baseY)}" stroke="${AXIS_COLOR}" stroke-width="1"/>`;

  normalized.forEach((s) => {
    const coords = s.points.map((p) => `${r(sx(p.x))},${r(sy(p.y))}`).join(' ');
    body +=
      `<polyline points="${coords}" fill="none" stroke="${s.color}" ` +
      `stroke-width="2" stroke-linejoin="round" stroke-linecap="round">` +
      `<title>${escapeXml(s.name)}</title></polyline>`;
    // Point markers with per-value tooltips.
    s.points.forEach((p) => {
      body +=
        `<circle cx="${r(sx(p.x))}" cy="${r(sy(p.y))}" r="2.5" fill="${s.color}">` +
        `<title>${escapeXml(s.name)}: ${escapeXml(p.y)}</title></circle>`;
    });
  });
  body += '</svg>';
  return body;
}

/**
 * Histogram — distribution buckets (PVP deviation, UI-UX §2.7). Like a
 * vertical bar chart but semantically a frequency distribution.
 *
 * @param {{ label?: *, count?: number }[]} buckets
 * @param {{ width?: number, height?: number, color?: string,
 *           desc?: string }} [opts]
 * @returns {string}
 */
export function histogram(buckets, opts = {}) {
  const { width, height } = resolveSize(opts);
  const list = Array.isArray(buckets) ? buckets : [];
  const desc = opts.desc || 'Histograma';
  if (list.length === 0) return emptyState(width, height, desc);

  const max = Math.max(0, ...list.map((b) => Math.max(0, finite(b && b.count))));
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const baseY = PAD.top + plotH;
  const band = plotW / list.length;
  // Histogram bars sit flush (small gap) — distribution, not categories.
  const barW = Math.max(2, band * 0.9);
  const color = escapeXml(opts.color || DEFAULT_COLORS[0]);

  let body = openSvg(width, height, desc);
  body +=
    `<line x1="${r(PAD.left)}" y1="${r(baseY)}" x2="${r(PAD.left + plotW)}" ` +
    `y2="${r(baseY)}" stroke="${AXIS_COLOR}" stroke-width="1"/>`;
  list.forEach((b, i) => {
    // Counts are non-negative by domain; clamp a stray negative to 0 so a bad
    // bucket can never emit a negative-height (non-rendering) rect.
    const cnt = Math.max(0, finite(b && b.count));
    const h = max > 0 ? (cnt / max) * plotH : 0;
    const x = PAD.left + i * band + (band - barW) / 2;
    const y = baseY - h;
    const label = escapeXml(b && b.label);
    body +=
      `<rect x="${r(x)}" y="${r(y)}" width="${r(barW)}" height="${r(h)}" ` +
      `fill="${color}">` +
      `<title>${label}: ${escapeXml(cnt)}</title></rect>`;
    body +=
      `<text x="${r(x + barW / 2)}" y="${r(baseY + 14)}" text-anchor="middle" ` +
      `font-size="10" fill="${TEXT_COLOR}">${label}</text>`;
  });
  body += '</svg>';
  return body;
}
