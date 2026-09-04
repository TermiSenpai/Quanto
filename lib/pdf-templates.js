// ============================================================
// Quanto · Built-in PDF quote templates + render pipeline
// ============================================================
// Six self-contained, A4, offline-safe quote templates written in
// the QWeb-style engine syntax (lib/template-engine.js):
//
//   clasica     — serif, centered, double-rule, black & white
//   moderna     — dark band + accent stripe, mono numbers, brand color
//   compacta    — condensed grayscale, half-page
//   detallada   — logo box + per-line desc + extras + per-person price
//   corporativa — angled color ribbons + numbered table + colored footer
//   formulario  — EMPRESA/CLIENTE boxes + bordered grid + legal lines
//
// They are DIGITAL quotes: no signature blocks — each closes with a
// phone/email confirmation note built from DATA. Every user-visible
// text (conditions, notes) is data from quote_settings/company, never
// fixed template copy. The color templates (moderna, corporativa)
// consume {{brand.color}} / {{brand.dark}} / {{brand.soft}}.
//
// buildQuoteContext flattens a stored/draft quote into the flat context
// the templates render against; brandColors derives the dark/soft tints
// from a base hex (fallback to the app accent); renderQuote selects a
// template (built-in id or a provided custom {html}) and renders it.
//
// Pure module — no fs, no Electron, no DOM. The engine HTML-escapes
// every value, so a malicious client name can never inject markup.
// User-facing strings stay in Spanish (CLAUDE.md §2).
// ============================================================

'use strict';

const { render } = require('./template-engine');
const { buildPdfLines } = require('./pdf-lines');

// The app's brand accent, reused as the fallback when a company has no
// (or an invalid) brand_color. Mirrors --accent-primary in styles.css.
const APP_ACCENT = '#3D7BD9';

const DEFAULT_TEMPLATE_ID = 'clasica';

// ------------------------------------------------------------
// Formatting helpers (mirror lib/pdf-template.js so the 'clasica'
// built-in renders identically to the legacy single template).
// ------------------------------------------------------------
function fmtEur(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return value.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// 0.4 → "40 %", 0.125 → "12,5 %". MUST match renderer/deposit.js
// formatDepositPct (the renderer cannot import this CommonJS module).
function fmtPct(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '';
  return (fraction * 100).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' %';
}

function addDays(iso, days) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

// ------------------------------------------------------------
// Brand colors
// ------------------------------------------------------------
function normalizeHex(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return '#' + h.toLowerCase();
}

function clamp255(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex2(n) {
  return clamp255(n).toString(16).padStart(2, '0');
}

function mix(channel, target, ratio) {
  return channel + (target - channel) * ratio;
}

/**
 * Derives the brand palette from a base hex. `dark` is the base
 * darkened ~30% (toward black); `soft` is a very light tint (toward
 * white) for backgrounds. Invalid input falls back to the app accent.
 *
 * @param {string} baseHex e.g. '#3D7BD9'
 * @returns {{color:string, dark:string, soft:string}}
 */
function brandColors(baseHex) {
  const hex = normalizeHex(baseHex) || APP_ACCENT.toLowerCase();
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dark = '#'
    + toHex2(mix(r, 0, 0.35)) + toHex2(mix(g, 0, 0.35)) + toHex2(mix(b, 0, 0.35));
  const soft = '#'
    + toHex2(mix(r, 255, 0.88)) + toHex2(mix(g, 255, 0.88)) + toHex2(mix(b, 255, 0.88));
  return { color: hex, dark, soft };
}

// ------------------------------------------------------------
// Context builder
// ------------------------------------------------------------
function buildSpecialSizes(result) {
  if (!result) return '';
  const parts = [];
  if (result.qty_4xl > 0) parts.push(`${result.qty_4xl} × 4XL`);
  if (result.qty_5xl > 0) parts.push(`${result.qty_5xl} × 5XL+`);
  return parts.join(' · ');
}

/**
 * Flattens a quote into the context the templates render against.
 *
 * @param {object} quote   stored/draft quote (lib/history.js shape)
 * @param {object} [options]
 * @param {object} [options.company]
 * @param {object} [options.quoteSettings]
 * @param {object} [options.brand]   brandColors() output
 * @param {string} [options.logoDataUri]
 * @returns {object} the flat render context
 */
function buildQuoteContext(quote, options = {}) {
  const company = options.company || {};
  const quoteSettings = options.quoteSettings || {};
  const brand = options.brand || brandColors(company.brand_color);
  const result = quote && (quote.result || quote);
  const totals = (quote && quote.totals) || result || {};

  // Presentation lines (ex-VAT, rows that close) come from the pure line
  // builder. Prefer explicit stored totals for base/vat/total, else the
  // result's own.
  const lineSrc = {
    ...result,
    sale_base: totals.sale_base ?? result?.sale_base ?? 0,
    vat: totals.vat ?? result?.vat ?? 0,
    total_vat_inc: totals.total_vat_inc ?? result?.total_vat_inc ?? 0
  };
  const lines = buildPdfLines(lineSrc);

  // One formatter for every row shape the templates print (items,
  // surcharges, extras and the collapsed legacy lines).
  const fmtRow = (l) => ({
    concept: l.concept,
    description: l.description || '',
    qty: l.qty == null ? '—' : String(l.qty),
    unit: l.unit == null ? '—' : fmtEur(l.unit),
    subtotal: fmtEur(l.subtotal)
  });
  const items = lines.items.map(fmtRow);
  const surchargeLines = lines.surcharge_lines.map(fmtRow);
  const extrasLines = lines.extras_lines.map(fmtRow);
  // Legacy collapsed lines — kept for custom cloud templates that still
  // reference `surcharge_line`/`extras_line`. Both derive from the same
  // rows the table shows, so a custom template always foots with it.
  const legacySurchargeLine = lines.surcharge_line ? fmtRow(lines.surcharge_line) : null;
  const legacyExtrasLine = lines.extras_line ? fmtRow(lines.extras_line) : null;

  const totalUnits = result?.total_quantity ?? result?.quantity ?? 0;
  const total = lines.totals.total;

  const validityDays = Number.isFinite(quoteSettings.validity_days) ? quoteSettings.validity_days : 30;
  const validUntilIso = addDays(quote?.date, validityDays);

  // Per-person price is kept in the context for custom cloud templates
  // only; the built-ins no longer render it (a head-count is unknown for
  // an order). Meaningful for a single line over known units — including
  // a single bundle pack, whose one line is now itemized per article.
  const singleBundle = result?.pricing_mode === 'bundle'
    && Array.isArray(result?.breakdown) && result.breakdown.length === 1;
  const hasPerPerson = (items.length === 1 || singleBundle) && totalUnits > 0 && total > 0;
  const perPerson = hasPerPerson ? fmtEur(total / totalUnits) : '';

  const specialSizes = buildSpecialSizes(result);
  const conditions = typeof quoteSettings.terms === 'string' ? quoteSettings.terms : '';

  // Deposit ("señal" — design 2026-09-04 §7). The minimum is stored on the
  // quote as content (renderer/deposit.js computes it; 0 % = no minimum)
  // and the payment is workflow; nothing is recomputed here. The two blocks
  // are independent: a quote saved before the feature but marked paid from
  // the history has deposit_paid and no stored minimum.
  const deposit = quote?.deposit;
  const hasDeposit = Boolean(deposit && Number.isFinite(deposit.min_amount) && deposit.min_amount > 0);
  const paid = quote?.deposit_paid;
  const depositPaid = Boolean(paid && Number.isFinite(paid.amount));
  const remaining = depositPaid ? Math.max(0, Math.round((total - paid.amount) * 100) / 100) : 0;

  // The digital-confirmation note (replaces a signature). Data-derived:
  // it points the customer to the company's own contact channels and, when
  // the quote carries a deposit, says what unlocks the order.
  const channel = [company.phone, company.email].filter(Boolean).join(' / ');
  const contact = channel
    ? `confírmelo por teléfono o email (${channel})`
    : 'confírmelo por teléfono o email';
  let confirmation;
  if (depositPaid) {
    confirmation = `Señal de ${fmtEur(paid.amount)} recibida el ${fmtDate(paid.at)}: presupuesto aceptado. Resto pendiente: ${fmtEur(remaining)}. No requiere firma.`;
  } else if (hasDeposit) {
    confirmation = `Presupuesto digital. Para aceptarlo, ${contact} y abone la señal mínima de ${fmtEur(deposit.min_amount)}; el pedido se lanza al recibir la señal. No requiere firma.`;
  } else {
    confirmation = `Presupuesto digital. Para aceptarlo, ${contact}. No requiere firma.`;
  }

  return {
    company: {
      name: company.name || 'Mi Taller DTF',
      tax_id: company.tax_id || '',
      address: company.address || '',
      phone: company.phone || '',
      email: company.email || '',
      web: company.web || ''
    },
    brand,
    logo: options.logoDataUri || '',
    has_logo: Boolean(options.logoDataUri),
    quote: {
      id: quote?.id || '',
      date: fmtDate(quote?.date),
      valid_until: fmtDate(validUntilIso),
      has_valid_until: Boolean(validUntilIso),
      user: quote?.user || '',
      config_version: quote?.config_version || ''
    },
    client: {
      name: (quote?.customer && quote.customer.name) || '',
      phone: (quote?.customer && quote.customer.phone) || '',
      email: (quote?.customer && quote.customer.email) || ''
    },
    pack: result?.pack || '',
    tier: result?.tier || '',
    total_units: String(totalUnits || ''),
    items,
    surcharge_lines: surchargeLines,
    surcharge_line: legacySurchargeLine,
    has_surcharge: Boolean(legacySurchargeLine),
    extras_lines: extrasLines,
    extras_line: legacyExtrasLine,
    has_extras: Boolean(legacyExtrasLine),
    totals: {
      base: fmtEur(lines.totals.base),
      vat: fmtEur(lines.totals.vat),
      total: fmtEur(lines.totals.total)
    },
    per_person: perPerson,
    has_per_person: hasPerPerson,
    special_sizes: specialSizes,
    has_special_sizes: specialSizes.length > 0,
    conditions,
    has_conditions: conditions.length > 0,
    confirmation,
    has_deposit: hasDeposit,
    deposit_pct: hasDeposit ? fmtPct(deposit.pct) : '',
    deposit_min: hasDeposit ? fmtEur(deposit.min_amount) : '',
    deposit_paid: depositPaid,
    deposit_paid_amount: depositPaid ? fmtEur(paid.amount) : '',
    deposit_paid_date: depositPaid ? fmtDate(paid.at) : '',
    deposit_remaining: depositPaid ? fmtEur(remaining) : ''
  };
}

// ============================================================
// The six built-in templates (engine-syntax HTML+CSS strings)
// ============================================================
// Shared fragments keep the six readable without a build step.

const PAGE_RESET = `* { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    @page { size: A4; margin: 18mm 16mm; }`;

// Common line rows used by several templates.
const LINES_ROWS = `{{#each items}}
        <tr>
          <td>{{this.concept}}</td>
          <td class="num">{{this.qty}}</td>
          <td class="num">{{this.unit}}</td>
          <td class="num">{{this.subtotal}}</td>
        </tr>{{/each}}
      {{#each surcharge_lines}}<tr>
          <td>{{this.concept}}</td>
          <td class="num">{{this.qty}}</td>
          <td class="num">{{this.unit}}</td>
          <td class="num">{{this.subtotal}}</td>
        </tr>{{/each}}
      {{#each extras_lines}}<tr>
          <td>{{this.concept}}</td>
          <td class="num">{{this.qty}}</td>
          <td class="num">{{this.unit}}</td>
          <td class="num">{{this.subtotal}}</td>
        </tr>{{/each}}`;

// Deposit rows under the total (design 2026-09-04 §7). Two independent
// {{#if}} blocks: the stored minimum, and the payment with the balance.
const DEPOSIT_ROWS = `{{#if has_deposit}}<tr class="deposit"><td>Señal mínima ({{deposit_pct}})</td><td class="num">{{deposit_min}}</td></tr>{{/if}}
    {{#if deposit_paid}}<tr class="deposit"><td>Señal recibida ({{deposit_paid_date}})</td><td class="num">{{deposit_paid_amount}}</td></tr>
    <tr class="deposit deposit--remaining"><td>Resto pendiente</td><td class="num">{{deposit_remaining}}</td></tr>{{/if}}`;

// ----- 1. Clásica -----------------------------------------------------
const CLASICA = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Presupuesto {{quote.id}}</title>
  <style>
    ${PAGE_RESET}
    html, body { font-family: 'Times New Roman', Georgia, serif; color: #111; font-size: 11pt; line-height: 1.5; }
    .head { text-align: center; border-top: 3px double #111; border-bottom: 3px double #111; padding: 14pt 0; }
    .head .name { font-size: 20pt; font-weight: 700; letter-spacing: 0.02em; }
    .head .meta { font-size: 9.5pt; margin-top: 4pt; color: #333; }
    .doc { text-align: center; margin: 14pt 0 6pt; }
    .doc .label { text-transform: uppercase; letter-spacing: 0.25em; font-size: 9pt; color: #444; }
    .doc .id { font-size: 15pt; font-weight: 700; }
    .doc .dates { font-size: 9.5pt; color: #333; margin-top: 2pt; }
    .client { margin: 10pt 0; text-align: center; font-size: 10.5pt; }
    table.lines { width: 100%; border-collapse: collapse; margin-top: 10pt; }
    table.lines th { border-bottom: 1px solid #111; text-align: left; padding: 6pt 8pt; font-variant: small-caps; font-size: 10pt; }
    table.lines td { padding: 6pt 8pt; border-bottom: 1px solid #ccc; }
    .num { text-align: right; }
    table.totals { width: 55%; margin: 12pt 0 0 auto; border-collapse: collapse; }
    table.totals td { padding: 3pt 8pt; }
    table.totals tr.total td { border-top: 3px double #111; font-size: 13pt; font-weight: 700; padding-top: 8pt; }
    table.totals tr.deposit td { font-size: 10pt; color: #333; padding-top: 4pt; }
    table.totals tr.deposit--remaining td { font-weight: 700; color: #111; }
    .per-person { text-align: right; font-size: 10pt; color: #333; margin-top: 4pt; }
    .conditions { margin-top: 18pt; border-top: 1px solid #111; padding-top: 8pt; font-size: 9pt; color: #333; }
    .conditions h3 { font-size: 9.5pt; font-variant: small-caps; margin: 0 0 3pt; }
    .confirm { margin-top: 12pt; font-size: 9pt; font-style: italic; text-align: center; color: #333; }
  </style>
</head>
<body>
  <div class="head">
    <div class="name">{{company.name}}</div>
    <div class="meta">{{company.tax_id}} {{company.address}} {{company.phone}} {{company.email}} {{company.web}}</div>
  </div>
  <div class="doc">
    <div class="label">Presupuesto</div>
    <div class="id">{{quote.id}}</div>
    <div class="dates">Emitido: {{quote.date}}{{#if quote.has_valid_until}} · Válido hasta: {{quote.valid_until}}{{/if}}</div>
  </div>
  <div class="client">Cliente: <strong>{{client.name}}</strong>{{#if client.phone}} · {{client.phone}}{{/if}}</div>
  <table class="lines">
    <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Precio unit. (sin IVA)</th><th class="num">Subtotal (sin IVA)</th></tr></thead>
    <tbody>
      ${LINES_ROWS}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal (sin IVA)</td><td class="num">{{totals.base}}</td></tr>
    <tr><td>IVA</td><td class="num">{{totals.vat}}</td></tr>
    <tr class="total"><td>Total (IVA incl.)</td><td class="num">{{totals.total}}</td></tr>
    ${DEPOSIT_ROWS}
  </table>  {{#if has_conditions}}<div class="conditions"><h3>Condiciones</h3><p>{{conditions}}</p></div>{{/if}}
  <div class="confirm">{{confirmation}}</div>
</body>
</html>`;

// ----- 2. Moderna -----------------------------------------------------
const MODERNA = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Presupuesto {{quote.id}}</title>
  <style>
    /* CSS-CONTEXT INVARIANT: only brandColors() output (validated hex) may be
       interpolated into CSS. HTML-entity escaping is insufficient for the CSS
       context — never interpolate a raw data value inside <style> or url(). */
    ${PAGE_RESET}
    html, body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a2230; font-size: 11pt; line-height: 1.45; }
    .band { background: {{brand.dark}}; color: #fff; padding: 18pt 20pt; display: flex; justify-content: space-between; align-items: flex-start; }
    .band .name { font-size: 19pt; font-weight: 800; letter-spacing: -0.01em; }
    .band .meta { font-size: 9pt; opacity: 0.85; margin-top: 3pt; }
    .band .doc { text-align: right; }
    .band .doc .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.12em; opacity: 0.8; }
    .band .doc .id { font-family: 'Geist Mono', 'Courier New', monospace; font-size: 16pt; font-weight: 700; }
    .stripe { height: 5pt; background: {{brand.color}}; }
    .body { padding: 16pt 20pt; }
    .client { background: {{brand.soft}}; border-left: 4px solid {{brand.color}}; padding: 8pt 12pt; margin-bottom: 12pt; }
    .client .l { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.1em; color: {{brand.dark}}; }
    table.lines { width: 100%; border-collapse: collapse; }
    table.lines th { background: {{brand.soft}}; color: {{brand.dark}}; text-align: left; padding: 8pt 10pt; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.05em; }
    table.lines td { padding: 8pt 10pt; border-bottom: 1px solid #e6eaf1; }
    .num { text-align: right; font-family: 'Geist Mono', 'Courier New', monospace; font-variant-numeric: tabular-nums; }
    table.totals { width: 50%; margin: 14pt 0 0 auto; border-collapse: collapse; }
    table.totals td { padding: 4pt 10pt; }
    table.totals td.num { font-family: 'Geist Mono', 'Courier New', monospace; }
    table.totals tr.total td { background: {{brand.color}}; color: #fff; font-size: 14pt; font-weight: 800; padding: 8pt 10pt; }
    table.totals tr.deposit td { font-size: 10pt; color: {{brand.dark}}; }
    table.totals tr.deposit--remaining td { font-weight: 700; }
    .per-person { text-align: right; color: {{brand.dark}}; font-weight: 600; margin-top: 6pt; }
    .conditions { margin-top: 18pt; border-top: 2px solid {{brand.soft}}; padding-top: 10pt; font-size: 9pt; color: #5b6577; }
    .conditions h3 { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: {{brand.dark}}; margin: 0 0 4pt; }
    .confirm { margin-top: 12pt; font-size: 8.5pt; color: {{brand.dark}}; }
  </style>
</head>
<body>
  <div class="band">
    <div>
      <div class="name">{{company.name}}</div>
      <div class="meta">{{company.tax_id}} {{company.address}} {{company.phone}} {{company.email}}</div>
    </div>
    <div class="doc">
      <div class="label">Presupuesto</div>
      <div class="id">{{quote.id}}</div>
      <div class="label" style="margin-top:6pt;">{{quote.date}}</div>
    </div>
  </div>
  <div class="stripe"></div>
  <div class="body">
    <div class="client">
      <div class="l">Cliente</div>
      <div><strong>{{client.name}}</strong>{{#if client.phone}} · {{client.phone}}{{/if}}</div>
      {{#if quote.has_valid_until}}<div class="l" style="margin-top:4pt;">Válido hasta {{quote.valid_until}}</div>{{/if}}
    </div>
    <table class="lines">
      <thead><tr><th>Concepto</th><th class="num">Cant.</th><th class="num">P. unit. (s/IVA)</th><th class="num">Subtotal (s/IVA)</th></tr></thead>
      <tbody>
        ${LINES_ROWS}
      </tbody>
    </table>
    <table class="totals">
      <tr><td>Subtotal (sin IVA)</td><td class="num">{{totals.base}}</td></tr>
      <tr><td>IVA</td><td class="num">{{totals.vat}}</td></tr>
      <tr class="total"><td>Total (IVA incl.)</td><td class="num">{{totals.total}}</td></tr>
      ${DEPOSIT_ROWS}
    </table>    {{#if has_conditions}}<div class="conditions"><h3>Condiciones</h3><p>{{conditions}}</p></div>{{/if}}
    <div class="confirm">{{confirmation}}</div>
  </div>
</body>
</html>`;

// ----- 3. Compacta ----------------------------------------------------
const COMPACTA = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Presupuesto {{quote.id}}</title>
  <style>
    ${PAGE_RESET}
    @page { size: A4; margin: 12mm 14mm; }
    html, body { font-family: Arial, Helvetica, sans-serif; color: #222; font-size: 9pt; line-height: 1.3; }
    .head { display: flex; justify-content: space-between; border-bottom: 1.5px solid #222; padding-bottom: 6pt; }
    .head .name { font-size: 13pt; font-weight: 700; }
    .head .meta { font-size: 7.5pt; color: #555; }
    .head .id { font-size: 11pt; font-weight: 700; text-align: right; }
    .head .id small { display: block; font-size: 7pt; font-weight: 400; color: #555; }
    .row { display: flex; justify-content: space-between; font-size: 8pt; color: #555; margin: 5pt 0; }
    table.lines { width: 100%; border-collapse: collapse; }
    table.lines th { background: #efefef; text-align: left; padding: 3pt 6pt; font-size: 7.5pt; text-transform: uppercase; }
    table.lines td { padding: 3pt 6pt; border-bottom: 1px solid #ddd; }
    .num { text-align: right; }
    table.totals { width: 45%; margin: 8pt 0 0 auto; border-collapse: collapse; }
    table.totals td { padding: 2pt 6pt; }
    table.totals tr.total td { border-top: 1.5px solid #222; font-weight: 700; font-size: 10pt; }
    table.totals tr.deposit td { font-size: 8.5pt; color: #444; }
    table.totals tr.deposit--remaining td { font-weight: 700; color: #222; }
    .conditions { margin-top: 10pt; font-size: 7.5pt; color: #666; border-top: 1px solid #ddd; padding-top: 5pt; }
    .confirm { margin-top: 6pt; font-size: 7.5pt; color: #666; }
  </style>
</head>
<body>
  <div class="head">
    <div>
      <div class="name">{{company.name}}</div>
      <div class="meta">{{company.tax_id}} · {{company.phone}} · {{company.email}}</div>
    </div>
    <div class="id">{{quote.id}}<small>{{quote.date}}</small></div>
  </div>
  <div class="row">
    <span>Cliente: <strong>{{client.name}}</strong>{{#if client.phone}} · {{client.phone}}{{/if}}</span>
    {{#if quote.has_valid_until}}<span>Válido hasta {{quote.valid_until}}</span>{{/if}}
  </div>
  <table class="lines">
    <thead><tr><th>Concepto</th><th class="num">Cant.</th><th class="num">P.u. s/IVA</th><th class="num">Subt. s/IVA</th></tr></thead>
    <tbody>
      ${LINES_ROWS}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal s/IVA</td><td class="num">{{totals.base}}</td></tr>
    <tr><td>IVA</td><td class="num">{{totals.vat}}</td></tr>
    <tr class="total"><td>Total c/IVA</td><td class="num">{{totals.total}}</td></tr>
    ${DEPOSIT_ROWS}
  </table>  {{#if has_conditions}}<div class="conditions">{{conditions}}</div>{{/if}}
  <div class="confirm">{{confirmation}}</div>
</body>
</html>`;

// ----- 4. Detallada ---------------------------------------------------
const DETALLADA = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Presupuesto {{quote.id}}</title>
  <style>
    ${PAGE_RESET}
    html, body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a2230; font-size: 11pt; line-height: 1.5; }
    .head { display: flex; gap: 20pt; align-items: flex-start; padding-bottom: 12pt; border-bottom: 2px solid #1a2230; }
    .logo-box { width: 110px; min-height: 70px; border: 1px solid #c8cfdb; border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .logo-box img { max-width: 100%; max-height: 70px; object-fit: contain; }
    .logo-box .ph { font-size: 8pt; color: #98a1ad; }
    .head .name { font-size: 18pt; font-weight: 700; }
    .head .meta { font-size: 9.5pt; color: #5b6577; margin-top: 3pt; }
    .head .doc { margin-left: auto; text-align: right; }
    .head .doc .id { font-size: 15pt; font-weight: 700; font-family: 'Courier New', monospace; }
    .head .doc .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #5b6577; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16pt; margin: 14pt 0; }
    .card { border: 1px solid #d4dae3; border-radius: 6px; padding: 8pt 12pt; }
    .card h3 { margin: 0 0 4pt; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #5b6577; }
    table.lines { width: 100%; border-collapse: collapse; margin-top: 6pt; }
    table.lines th { background: #f4f6fa; text-align: left; padding: 8pt 10pt; font-size: 8.5pt; text-transform: uppercase; color: #5b6577; border-bottom: 2px solid #c8cfdb; }
    table.lines td { padding: 8pt 10pt; border-bottom: 1px solid #e6eaf1; vertical-align: top; }
    table.lines td .desc { font-size: 8.5pt; color: #98a1ad; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    table.totals { width: 55%; margin: 14pt 0 0 auto; border-collapse: collapse; }
    table.totals td { padding: 4pt 10pt; }
    table.totals tr.total td { border-top: 2px solid #1a2230; font-size: 14pt; font-weight: 700; padding-top: 8pt; }
    table.totals tr.deposit td { font-size: 10pt; color: #5b6577; }
    table.totals tr.deposit--remaining td { font-weight: 700; color: #1a2230; }
    .extras-note, .per-person { margin-top: 6pt; font-size: 9.5pt; color: #5b6577; text-align: right; }
    .conditions { margin-top: 18pt; border-top: 1px solid #d4dae3; padding-top: 10pt; font-size: 9pt; color: #5b6577; }
    .conditions h3 { font-size: 8.5pt; text-transform: uppercase; color: #1a2230; margin: 0 0 4pt; }
    .confirm { margin-top: 12pt; padding: 8pt 12pt; background: #f4f6fa; border-radius: 6px; font-size: 9pt; color: #5b6577; }
  </style>
</head>
<body>
  <div class="head">
    <div class="logo-box">{{#if has_logo}}<img src="{{logo}}" alt="">{{else}}<span class="ph">{{company.name}}</span>{{/if}}</div>
    <div>
      <div class="name">{{company.name}}</div>
      <div class="meta">{{company.tax_id}}{{#if company.address}} · {{company.address}}{{/if}}<br>{{company.phone}}{{#if company.email}} · {{company.email}}{{/if}}{{#if company.web}} · {{company.web}}{{/if}}</div>
    </div>
    <div class="doc">
      <div class="label">Presupuesto</div>
      <div class="id">{{quote.id}}</div>
    </div>
  </div>
  <div class="grid">
    <div class="card"><h3>Cliente</h3><p><strong>{{client.name}}</strong>{{#if client.phone}}<br>{{client.phone}}{{/if}}{{#if client.email}}<br>{{client.email}}{{/if}}</p></div>
    <div class="card"><h3>Datos</h3><p>Emitido: {{quote.date}}{{#if quote.has_valid_until}}<br>Válido hasta: {{quote.valid_until}}{{/if}}{{#if quote.user}}<br>Preparado por: {{quote.user}}{{/if}}</p></div>
  </div>
  <table class="lines">
    <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Precio unit. (sin IVA)</th><th class="num">Subtotal (sin IVA)</th></tr></thead>
    <tbody>
      {{#each items}}<tr>
          <td>{{this.concept}}{{#if this.description}}<div class="desc">{{this.description}}</div>{{/if}}</td>
          <td class="num">{{this.qty}}</td>
          <td class="num">{{this.unit}}</td>
          <td class="num">{{this.subtotal}}</td>
        </tr>{{/each}}
      {{#each surcharge_lines}}<tr><td>{{this.concept}}</td><td class="num">{{this.qty}}</td><td class="num">{{this.unit}}</td><td class="num">{{this.subtotal}}</td></tr>{{/each}}
      {{#each extras_lines}}<tr><td>{{this.concept}}</td><td class="num">{{this.qty}}</td><td class="num">{{this.unit}}</td><td class="num">{{this.subtotal}}</td></tr>{{/each}}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal (sin IVA)</td><td class="num">{{totals.base}}</td></tr>
    <tr><td>IVA</td><td class="num">{{totals.vat}}</td></tr>
    <tr class="total"><td>Total (IVA incl.)</td><td class="num">{{totals.total}}</td></tr>
    ${DEPOSIT_ROWS}
  </table>  {{#if has_conditions}}<div class="conditions"><h3>Condiciones</h3><p>{{conditions}}</p></div>{{/if}}
  <div class="confirm">{{confirmation}}</div>
</body>
</html>`;

// ----- 5. Corporativa -------------------------------------------------
const CORPORATIVA = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Presupuesto {{quote.id}}</title>
  <style>
    /* CSS-CONTEXT INVARIANT: only brandColors() output (validated hex) may be
       interpolated into CSS. HTML-entity escaping is insufficient for the CSS
       context — never interpolate a raw data value inside <style> or url(). */
    ${PAGE_RESET}
    html, body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #20262e; font-size: 11pt; line-height: 1.45; }
    .ribbon { background: linear-gradient(105deg, {{brand.dark}} 0%, {{brand.color}} 70%, {{brand.color}} 100%); color: #fff; padding: 20pt; transform: skewY(-1.2deg); transform-origin: top left; margin-bottom: 14pt; }
    .ribbon-inner { transform: skewY(1.2deg); display: flex; justify-content: space-between; align-items: flex-start; }
    .ribbon .name { font-size: 20pt; font-weight: 800; }
    .ribbon .meta { font-size: 9pt; opacity: 0.9; margin-top: 3pt; }
    .ribbon .doc { text-align: right; }
    .ribbon .doc .id { font-size: 16pt; font-weight: 700; }
    .ribbon .doc .label { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.85; }
    .client { padding: 0 4pt; margin-bottom: 10pt; font-size: 10.5pt; }
    .client .l { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.1em; color: {{brand.color}}; }
    table.lines { width: 100%; border-collapse: collapse; }
    table.lines th { background: {{brand.color}}; color: #fff; text-align: left; padding: 8pt 10pt; font-size: 8.5pt; text-transform: uppercase; }
    table.lines th.idx, table.lines td.idx { text-align: center; width: 26px; }
    table.lines td { padding: 8pt 10pt; border-bottom: 1px solid {{brand.soft}}; }
    table.lines tr:nth-child(even) td { background: {{brand.soft}}; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    table.totals { width: 50%; margin: 14pt 0 0 auto; border-collapse: collapse; }
    table.totals td { padding: 4pt 10pt; }
    table.totals tr.total td { background: {{brand.dark}}; color: #fff; font-size: 14pt; font-weight: 800; padding: 8pt 10pt; }
    table.totals tr.deposit td { font-size: 10pt; color: {{brand.dark}}; }
    table.totals tr.deposit--remaining td { font-weight: 700; }
    .per-person { text-align: right; color: {{brand.dark}}; font-weight: 600; margin-top: 6pt; }
    .conditions { margin-top: 16pt; font-size: 9pt; color: #5b6577; }
    .conditions h3 { color: {{brand.color}}; font-size: 8.5pt; text-transform: uppercase; margin: 0 0 4pt; }
    .footer { margin-top: 16pt; background: {{brand.color}}; color: #fff; padding: 10pt 14pt; border-radius: 4px; font-size: 9pt; }
  </style>
</head>
<body>
  <div class="ribbon">
    <div class="ribbon-inner">
      <div>
        <div class="name">{{company.name}}</div>
        <div class="meta">{{company.tax_id}} · {{company.phone}} · {{company.email}}</div>
      </div>
      <div class="doc">
        <div class="label">Presupuesto</div>
        <div class="id">{{quote.id}}</div>
        <div class="label" style="margin-top:4pt;">{{quote.date}}</div>
      </div>
    </div>
  </div>
  <div class="client">
    <span class="l">Cliente</span> <strong>{{client.name}}</strong>{{#if client.phone}} · {{client.phone}}{{/if}}{{#if quote.has_valid_until}} · Válido hasta {{quote.valid_until}}{{/if}}
  </div>
  <table class="lines">
    <thead><tr><th class="idx">#</th><th>Concepto</th><th class="num">Cant.</th><th class="num">P. unit. (s/IVA)</th><th class="num">Subtotal (s/IVA)</th></tr></thead>
    <tbody>
      {{#each items}}<tr>
          <td class="idx">{{@index}}</td>
          <td>{{this.concept}}</td>
          <td class="num">{{this.qty}}</td>
          <td class="num">{{this.unit}}</td>
          <td class="num">{{this.subtotal}}</td>
        </tr>{{/each}}
      {{#each surcharge_lines}}<tr><td class="idx">+</td><td>{{this.concept}}</td><td class="num">{{this.qty}}</td><td class="num">{{this.unit}}</td><td class="num">{{this.subtotal}}</td></tr>{{/each}}
      {{#each extras_lines}}<tr><td class="idx">+</td><td>{{this.concept}}</td><td class="num">{{this.qty}}</td><td class="num">{{this.unit}}</td><td class="num">{{this.subtotal}}</td></tr>{{/each}}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal (sin IVA)</td><td class="num">{{totals.base}}</td></tr>
    <tr><td>IVA</td><td class="num">{{totals.vat}}</td></tr>
    <tr class="total"><td>Total (IVA incl.)</td><td class="num">{{totals.total}}</td></tr>
    ${DEPOSIT_ROWS}
  </table>  {{#if has_conditions}}<div class="conditions"><h3>Condiciones</h3><p>{{conditions}}</p></div>{{/if}}
  <div class="footer">{{confirmation}}</div>
</body>
</html>`;

// ----- 6. Formulario --------------------------------------------------
const FORMULARIO = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Presupuesto {{quote.id}}</title>
  <style>
    ${PAGE_RESET}
    html, body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 10pt; line-height: 1.4; }
    .title { text-align: center; font-size: 14pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; border: 2px solid #000; padding: 6pt; margin-bottom: 10pt; }
    .boxes { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #000; }
    .box { padding: 6pt 8pt; }
    .box + .box { border-left: 1px solid #000; }
    .box h3 { margin: 0 0 4pt; font-size: 8.5pt; text-transform: uppercase; border-bottom: 1px solid #000; padding-bottom: 2pt; }
    .docline { display: flex; justify-content: space-between; border: 1px solid #000; border-top: 0; padding: 4pt 8pt; font-size: 9pt; }
    table.lines { width: 100%; border-collapse: collapse; margin-top: 10pt; }
    table.lines th, table.lines td { border: 1px solid #000; padding: 5pt 7pt; }
    table.lines th { background: #e8e8e8; text-align: left; font-size: 8.5pt; text-transform: uppercase; }
    .num { text-align: right; }
    table.totals { width: 45%; margin: 0 0 0 auto; border-collapse: collapse; }
    table.totals td { border: 1px solid #000; padding: 4pt 8pt; }
    table.totals tr.total td { font-weight: 700; font-size: 12pt; }
    table.totals tr.deposit td { font-size: 10pt; }
    table.totals tr.deposit--remaining td { font-weight: 700; }
    .legal { margin-top: 12pt; font-size: 8pt; color: #222; }
    .legal h3 { font-size: 8.5pt; text-transform: uppercase; margin: 0 0 3pt; }
    .confirm { margin-top: 8pt; border: 1px solid #000; padding: 6pt 8pt; font-size: 8.5pt; }
  </style>
</head>
<body>
  <div class="title">Presupuesto</div>
  <div class="boxes">
    <div class="box">
      <h3>Empresa</h3>
      <div><strong>{{company.name}}</strong></div>
      <div>{{company.tax_id}}</div>
      <div>{{company.address}}</div>
      <div>{{company.phone}}{{#if company.email}} · {{company.email}}{{/if}}</div>
    </div>
    <div class="box">
      <h3>Cliente</h3>
      <div><strong>{{client.name}}</strong></div>
      <div>{{client.phone}}</div>
      <div>{{client.email}}</div>
    </div>
  </div>
  <div class="docline">
    <span>Nº: <strong>{{quote.id}}</strong></span>
    <span>Fecha: {{quote.date}}</span>
    {{#if quote.has_valid_until}}<span>Válido hasta: {{quote.valid_until}}</span>{{/if}}
  </div>
  <table class="lines">
    <thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Precio unit. (sin IVA)</th><th class="num">Subtotal (sin IVA)</th></tr></thead>
    <tbody>
      ${LINES_ROWS}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal (sin IVA)</td><td class="num">{{totals.base}}</td></tr>
    <tr><td>IVA</td><td class="num">{{totals.vat}}</td></tr>
    <tr class="total"><td>Total (IVA incl.)</td><td class="num">{{totals.total}}</td></tr>
    ${DEPOSIT_ROWS}
  </table>  {{#if has_conditions}}<div class="legal"><h3>Condiciones</h3><p>{{conditions}}</p></div>{{/if}}
  <div class="confirm">{{confirmation}}</div>
</body>
</html>`;

const BUILTIN_TEMPLATES = [
  { id: 'clasica', name: 'Clásica', html: CLASICA },
  { id: 'moderna', name: 'Moderna', html: MODERNA },
  { id: 'compacta', name: 'Compacta', html: COMPACTA },
  { id: 'detallada', name: 'Detallada', html: DETALLADA },
  { id: 'corporativa', name: 'Corporativa', html: CORPORATIVA },
  { id: 'formulario', name: 'Formulario', html: FORMULARIO }
];

const BUILTIN_BY_ID = Object.fromEntries(BUILTIN_TEMPLATES.map(t => [t.id, t]));

// ------------------------------------------------------------
// Gallery / preview helpers (Task 6B)
// ------------------------------------------------------------

/**
 * The built-in templates as id+name only, for the settings gallery
 * (sent to the renderer over pdf:list-templates — the renderer can't
 * require this CommonJS module directly). No html payload.
 *
 * @returns {Array<{id:string, name:string}>}
 */
function listBuiltinTemplates() {
  return BUILTIN_TEMPLATES.map(t => ({ id: t.id, name: t.name }));
}

// A small, representative demo quote for the settings preview. It exercises
// the parts a user wants to judge a template by: an itemized bundle (each
// article on its own line with an ex-VAT unit price), itemized extras, a
// special-size surcharge, and editable conditions. The client name carries
// markup to prove the engine escapes values (XSS guarantee) — never rendered
// as live HTML. Numbers are internally consistent (VAT-incl parts foot to the
// totals). Pure data, no I/O.
const DEMO_QUOTE = {
  id: 'PRE-2026-0042',
  date: new Date('2026-06-13T10:00:00').toISOString(),
  user: 'Mostrador',
  config_version: '4.0.0',
  customer: { name: 'Peña El Ejemplo <demo>', phone: '600 123 456', email: 'pena@ejemplo.es' },
  deposit: { pct: 0.4, min_amount: 264 }, // 659.90 × 0.4 = 263.96 → 264 (unpaid: the common case)
  result: {
    pricing_mode: 'bundle',
    pack: 'Pack peña',
    tier: 'T2',
    total_quantity: 25,
    quantity: 25,
    qty_4xl: 2,
    qty_5xl: 1,
    surcharges: 18,
    surcharge_lines: [
      { size: '4XL', quantity: 2, unit_price: 4, subtotal: 8 },
      { size: '5XL+', quantity: 1, unit_price: 10, subtotal: 10 }
    ],
    extras_no_vat: 15,
    extras_vat_inc: 18.15,
    extras_detail: { name: 10 },
    extras_lines: [
      { id: 'name', name: 'Nombre', quantity: 10, unit_price: 1.815, subtotal: 18.15, vat_included: false }
    ],
    unit_price: 24.95,
    subtotal: 623.75,
    total_vat_inc: 659.90,
    sale_base: 545.37,
    vat: 114.53,
    breakdown: [{
      model: 'crew_full', name: 'Pack peña', quantity: 25, sides: 2,
      unit_price: 24.95, subtotal: 623.75,
      components: [
        { model: 'BEAGLE',  name: 'Camiseta DTF', quantity: 25, unit_price: 10.99, subtotal: 274.75 },
        { model: 'CLASICA', name: 'Sudadera DTF', quantity: 25, unit_price: 13.96, subtotal: 349.00 }
      ]
    }]
  }
};

/**
 * Renders the demo quote with the chosen template + brand color, for the
 * settings preview iframe (Task 6B). Same render path as a real export,
 * so what the user previews is what they get. The caller (main) passes a
 * pre-sanitized custom template when previewing a custom one.
 *
 * @param {object} [options]
 * @param {string} [options.templateId]
 * @param {{html:string}} [options.custom]
 * @param {string} [options.brandColor] - hex; derived into the brand palette
 * @param {object} [options.company]
 * @param {object} [options.quoteSettings]
 * @returns {string} the rendered HTML document
 */
function renderPreview(options = {}) {
  const company = options.company || {
    name: 'Mi Taller DTF', tax_id: 'B-12345678',
    address: 'Calle Ejemplo 1, Ciudad', phone: '900 000 000',
    email: 'taller@ejemplo.es', web: 'www.ejemplo.es'
  };
  const quoteSettings = options.quoteSettings || {
    validity_days: 30,
    terms: 'Precios con IVA incluido. Validez 30 días. Producción 7-10 días laborables tras confirmación.'
  };
  return renderQuote(DEMO_QUOTE, {
    templateId: options.templateId,
    custom: options.custom,
    company,
    quoteSettings,
    brand: brandColors(options.brandColor)
  });
}

/**
 * Renders a quote to a complete HTML document.
 *
 * Template selection:
 *   - options.custom.html  → render that custom template (already
 *     sanitized by the caller in main; never sanitized here).
 *   - options.templateId   → a built-in id; unknown/missing falls back
 *     to 'clasica'.
 *
 * @param {object} quote
 * @param {object} [options]
 * @param {string} [options.templateId]
 * @param {{html:string}} [options.custom]
 * @param {object} [options.company]
 * @param {object} [options.quoteSettings]
 * @param {object} [options.brand]
 * @param {string} [options.logoDataUri]
 * @returns {string} the rendered HTML document
 */
function renderQuote(quote, options = {}) {
  const ctx = buildQuoteContext(quote, options);
  let templateStr;
  if (options.custom && typeof options.custom.html === 'string') {
    templateStr = options.custom.html;
  } else {
    const tpl = BUILTIN_BY_ID[options.templateId] || BUILTIN_BY_ID[DEFAULT_TEMPLATE_ID];
    templateStr = tpl.html;
  }
  return render(templateStr, ctx);
}

module.exports = {
  BUILTIN_TEMPLATES,
  APP_ACCENT,
  DEFAULT_TEMPLATE_ID,
  DEMO_QUOTE,
  brandColors,
  buildQuoteContext,
  renderQuote,
  renderPreview,
  listBuiltinTemplates
};
