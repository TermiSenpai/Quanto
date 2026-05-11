// ============================================================
// PackPrice · PDF template builder
// ============================================================
// Pure module that returns a self-contained HTML string for a
// quote. We load this HTML into a hidden BrowserWindow and call
// `webContents.printToPDF()` from main. No external resources
// (no fonts, no images by URL): everything is inline so the PDF
// is reproducible and offline-safe.
//
// Inputs:
//   quote   — the persisted quote record (lib/history.js shape)
//   options — { empresa, presupuesto, logoDataUri? }
//
// Output: a complete HTML document (string).
// ============================================================

'use strict';

const DEFAULT_EMPRESA = {
  nombre: 'Mi Taller DTF',
  cif: '',
  direccion: '',
  telefono: '',
  email: '',
  web: ''
};

const DEFAULT_PRESUPUESTO = {
  validez_dias: 30,
  condiciones: 'Precios IVA incluido. Validez 30 días desde la fecha de emisión. La aceptación implica conformidad con las condiciones del taller.'
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

function addDays(iso, days) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * Builds the lines table from a calculator result. Handles both
 * single-pack results (cantidad × pvp) and multi-line (mixto /
 * personalizado) results.
 *
 * @param {object} resultado
 * @returns {{rowsHtml: string, subtotal: number}}
 */
function buildLinesHtml(resultado) {
  if (!resultado) return { rowsHtml: '', subtotal: 0 };

  if (Array.isArray(resultado.desglose) && resultado.desglose.length > 0) {
    const rows = resultado.desglose.map(line => `
      <tr>
        <td>${esc(line.nombre || line.modelo || '—')}${line.caras ? ` <span class="muted">(${line.caras}c)</span>` : ''}</td>
        <td class="num">${esc(line.cantidad)}</td>
        <td class="num">${esc(fmtEur(line.pvp))}</td>
        <td class="num">${esc(fmtEur(line.subtotal))}</td>
      </tr>
    `).join('');
    return { rowsHtml: rows, subtotal: resultado.subtotal || 0 };
  }

  // Single-pack shape: pack name + cantidad + pvp_unitario.
  if (typeof resultado.cantidad === 'number' && typeof resultado.pvp_unitario === 'number') {
    const subtotal = resultado.cantidad * resultado.pvp_unitario;
    const row = `
      <tr>
        <td>${esc(resultado.pack || '—')}${resultado.tramo ? ` <span class="muted">${esc(resultado.tramo)}</span>` : ''}</td>
        <td class="num">${esc(resultado.cantidad)}</td>
        <td class="num">${esc(fmtEur(resultado.pvp_unitario))}</td>
        <td class="num">${esc(fmtEur(subtotal))}</td>
      </tr>
    `;
    return { rowsHtml: row, subtotal };
  }

  return { rowsHtml: '', subtotal: 0 };
}

/**
 * Returns the full HTML document for the quote PDF.
 *
 * @param {object} quote
 * @param {object} [options]
 * @param {object} [options.empresa]
 * @param {object} [options.presupuesto]
 * @param {string} [options.logoDataUri] base64 data: URI for the logo
 * @returns {string}
 */
function renderQuoteHtml(quote, options = {}) {
  const empresa = { ...DEFAULT_EMPRESA, ...(options.empresa || {}) };
  const cfgPresupuesto = { ...DEFAULT_PRESUPUESTO, ...(options.presupuesto || {}) };
  const resultado = quote && (quote.resultado || quote);
  const totales = (quote && quote.totales) || resultado || {};

  const total = totales.total_iva_inc ?? resultado?.total_iva_inc ?? 0;
  const base  = totales.base_venta    ?? resultado?.base_venta    ?? 0;
  const iva   = totales.iva           ?? resultado?.iva           ?? 0;

  const recargos = resultado?.recargos || 0;
  const extras = resultado?.extras_sin_iva || 0;

  const { rowsHtml } = buildLinesHtml(resultado);

  const validezIso = addDays(quote?.fecha, cfgPresupuesto.validez_dias);

  const cliente = quote?.cliente || {};
  const logo = options.logoDataUri
    ? `<img src="${esc(options.logoDataUri)}" alt="" class="logo">`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Presupuesto ${esc(quote?.id || '')}</title>
  <style>
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      color: #1a2230;
      font-size: 11pt;
      line-height: 1.45;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      padding-bottom: 12pt;
      border-bottom: 2px solid #1a2230;
    }
    .head .logo {
      max-height: 70px;
      max-width: 200px;
      object-fit: contain;
    }
    .head .empresa-name {
      font-size: 18pt;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .head .empresa-meta {
      color: #5b6577;
      font-size: 10pt;
      margin-top: 2pt;
    }
    .head .doc-meta {
      text-align: right;
      font-size: 10pt;
    }
    .head .doc-meta .label {
      color: #5b6577;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 8.5pt;
    }
    .head .doc-meta .id {
      font-family: 'Courier New', monospace;
      font-size: 16pt;
      font-weight: 700;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20pt;
      margin: 18pt 0 12pt;
    }
    .meta-card {
      border: 1px solid #d4dae3;
      border-radius: 6px;
      padding: 10pt 12pt;
    }
    .meta-card h3 {
      margin: 0 0 4pt;
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #5b6577;
    }
    .meta-card p { margin: 0; }

    table.lines {
      width: 100%;
      border-collapse: collapse;
      margin-top: 14pt;
    }
    table.lines thead th {
      background: #f4f6fa;
      text-align: left;
      padding: 8pt 10pt;
      border-bottom: 2px solid #c8cfdb;
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #5b6577;
    }
    table.lines tbody td {
      padding: 8pt 10pt;
      border-bottom: 1px solid #e6eaf1;
      vertical-align: top;
    }
    table.lines td.num, table.lines th.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .muted { color: #98a1ad; font-weight: normal; }

    .totals {
      margin-top: 16pt;
      width: 60%;
      margin-left: auto;
    }
    .totals tr td {
      padding: 4pt 10pt;
    }
    .totals tr td.label { color: #5b6577; }
    .totals tr.total td {
      border-top: 2px solid #1a2230;
      padding-top: 10pt;
      font-size: 14pt;
      font-weight: 700;
    }
    .totals td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .conditions {
      margin-top: 24pt;
      padding-top: 12pt;
      border-top: 1px solid #d4dae3;
      font-size: 9pt;
      color: #5b6577;
      line-height: 1.5;
    }
    .conditions h3 {
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin: 0 0 4pt;
      color: #1a2230;
    }
    .footer {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      text-align: center;
      font-size: 8pt;
      color: #98a1ad;
      padding: 4pt 0;
    }
  </style>
</head>
<body>
  <header class="head">
    <div>
      ${logo}
      <div class="empresa-name">${esc(empresa.nombre)}</div>
      <div class="empresa-meta">
        ${[empresa.cif, empresa.direccion, empresa.telefono, empresa.email, empresa.web].filter(Boolean).map(esc).join(' · ')}
      </div>
    </div>
    <div class="doc-meta">
      <div class="label">Presupuesto</div>
      <div class="id">${esc(quote?.id || '—')}</div>
      <div class="label" style="margin-top: 6pt;">Emitido</div>
      <div>${esc(fmtDate(quote?.fecha))}</div>
      ${validezIso ? `<div class="label" style="margin-top: 6pt;">Válido hasta</div><div>${esc(fmtDate(validezIso))}</div>` : ''}
    </div>
  </header>

  <section class="meta-grid">
    <div class="meta-card">
      <h3>Cliente</h3>
      <p><strong>${esc(cliente.nombre || '—')}</strong></p>
      ${cliente.contacto ? `<p>${esc(cliente.contacto)}</p>` : ''}
    </div>
    <div class="meta-card">
      <h3>Preparado por</h3>
      <p>${esc(quote?.usuario || '—')}</p>
      ${quote?.config_version ? `<p class="muted">config v${esc(quote.config_version)}</p>` : ''}
    </div>
  </section>

  <table class="lines">
    <thead>
      <tr>
        <th>Concepto</th>
        <th class="num">Cantidad</th>
        <th class="num">PVP unitario</th>
        <th class="num">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
      ${recargos > 0 ? `
      <tr>
        <td>Recargo tallas grandes (4XL/5XL+)</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">${esc(fmtEur(recargos))}</td>
      </tr>` : ''}
      ${extras > 0 ? `
      <tr>
        <td>Extras opcionales (sin IVA)</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">${esc(fmtEur(extras))}</td>
      </tr>` : ''}
    </tbody>
  </table>

  <table class="totals">
    <tr>
      <td class="label">Base imponible</td>
      <td class="num">${esc(fmtEur(base))}</td>
    </tr>
    <tr>
      <td class="label">IVA</td>
      <td class="num">${esc(fmtEur(iva))}</td>
    </tr>
    <tr class="total">
      <td>Total</td>
      <td class="num">${esc(fmtEur(total))}</td>
    </tr>
  </table>

  <section class="conditions">
    <h3>Condiciones</h3>
    <p>${esc(cfgPresupuesto.condiciones)}</p>
  </section>

  <div class="footer">${esc(empresa.nombre)} · Presupuesto ${esc(quote?.id || '')} · ${esc(fmtDate(quote?.fecha))}</div>
</body>
</html>`;
}

module.exports = {
  renderQuoteHtml,
  DEFAULT_EMPRESA,
  DEFAULT_PRESUPUESTO
};
