// ============================================================
// Quanto · PDF quote line builder (pure, ex-VAT, rows that close)
// ============================================================
// Turns a stored/priced quote `result` into the presentation lines the
// PDF templates render: one row per article (bundle components are
// itemized when the result carries their distributed prices), one row
// per addon extra, and per-size large-size surcharge rows — all in NET
// (ex-VAT) money.
//
// Row arithmetic closes by construction: the ex-VAT unit price is
// derived first (2 decimals) and each subtotal is exactly qty × unit,
// so the multiplication a customer checks on a printed row is always
// right. The totals block foots by making `base` the sum of the rows
// and letting the IVA line absorb the rounding drift against the
// stored VAT-inc total (`vat = total − base`): the total the customer
// pays is never touched, and line prices are never stretched to match
// a stored base — an inconsistent stored quote shows its real numbers
// (and an off-looking IVA line) instead of plausible invented prices.
//
// The VAT rate is derived from the quote itself (`vat / sale_base`), so
// each quote stays internally consistent regardless of the current
// config VAT. No cfg, no fs, no DOM. Returns raw numbers — the template
// layer owns euro formatting. User-facing strings stay Spanish.
// ============================================================

'use strict';

// Must match round2 in renderer/calculo.js: both sides of the pipeline
// round the same amounts, and a divergent convention would price the
// same line differently than the persisted split.
function round2(n) {
  return Math.round(n * 100) / 100;
}

function vatRate(result) {
  const base = typeof result.sale_base === 'number' ? result.sale_base : 0;
  const vat = typeof result.vat === 'number' ? result.vat : 0;
  return base > 0 ? vat / base : 0;
}

function withSides(concept, sides) {
  return sides ? `${concept} (${sides}c)` : concept;
}

/**
 * @param {object} result priced/stored quote result (calculo.js shape)
 * @returns {{items:Array, surcharge_lines:Array, surcharge_line:object|null,
 *            extras_lines:Array, extras_line:object|null,
 *            totals:{base:number,vat:number,total:number}}}
 */
function buildPdfLines(result) {
  const r = result || {};
  const div = 1 + vatRate(r);

  // 1) Raw entries with VAT-included money: the unit price where the
  // quote carries one, plus the line amount for collapsed legacy rows.
  const entries = [];
  const breakdown = Array.isArray(r.breakdown) ? r.breakdown : [];
  const isBundle = r.pricing_mode === 'bundle';

  if (isBundle && breakdown.length > 0) {
    const top = breakdown[0];
    const comps = Array.isArray(top.components) ? top.components : [];
    const itemized = comps.length > 0
      && comps.every((c) => typeof c.unit_price === 'number' && typeof c.subtotal === 'number');
    if (itemized) {
      for (const c of comps) {
        if (!c.quantity) continue;
        entries.push({ kind: 'item', concept: withSides(c.name || c.model || '—', top.sides), description: '', qty: c.quantity, unitVatInc: c.unit_price, vatInc: c.subtotal });
      }
    } else {
      entries.push({ kind: 'item', concept: withSides(r.pack || top.name || '—', top.sides), description: '', qty: top.quantity, unitVatInc: top.unit_price, vatInc: top.subtotal });
    }
  } else if (breakdown.length > 0) {
    for (const d of breakdown) {
      if (d.quantity === 0) continue;
      const unitVatInc = typeof d.unit_price === 'number' ? d.unit_price
        : (typeof d.price === 'number' ? d.price : null); // pre-v4 rows carry `price`
      const vatInc = typeof d.subtotal === 'number' ? d.subtotal : (unitVatInc || 0) * (d.quantity || 0);
      entries.push({ kind: 'item', concept: withSides(d.name || d.model || '—', d.sides), description: d.description || '', qty: d.quantity, unitVatInc, vatInc });
    }
  } else if (typeof r.quantity === 'number' && typeof r.unit_price === 'number') {
    const vatInc = typeof r.subtotal === 'number' ? r.subtotal : r.quantity * r.unit_price;
    entries.push({ kind: 'item', concept: r.pack || '—', description: r.tier ? `Tramo ${r.tier}` : '', qty: r.quantity, unitVatInc: r.unit_price, vatInc });
  }

  // 2) Large-size surcharge (4XL/5XL), VAT-included. Itemized per size when
  // the result carries `surcharge_lines`; else a single collapsed line
  // (legacy quotes priced before the itemization existed).
  const surchargeInput = Array.isArray(r.surcharge_lines) ? r.surcharge_lines : [];
  const surcharges = typeof r.surcharges === 'number' ? r.surcharges : 0;
  if (surchargeInput.length > 0) {
    for (const s of surchargeInput) {
      if (!s.quantity) continue;
      const unitVatInc = typeof s.unit_price === 'number' ? s.unit_price : null;
      const vatInc = typeof s.subtotal === 'number' ? s.subtotal : (unitVatInc || 0) * (s.quantity || 0);
      entries.push({ kind: 'surcharge', concept: `Recargo talla ${s.size}`, description: '', qty: s.quantity, unitVatInc, vatInc });
    }
  } else if (surcharges > 0) {
    entries.push({ kind: 'surcharge', concept: 'Recargo tallas grandes (4XL/5XL+)', description: '', qty: null, unitVatInc: null, vatInc: surcharges });
  }

  // 3) Extras — itemized if the result carries them, else a collapsed line.
  const extrasInput = Array.isArray(r.extras_lines) ? r.extras_lines : [];
  if (extrasInput.length > 0) {
    for (const e of extrasInput) {
      if (!e.quantity) continue;
      const unitVatInc = typeof e.unit_price === 'number' ? e.unit_price : null;
      const vatInc = typeof e.subtotal === 'number' ? e.subtotal : (unitVatInc || 0) * (e.quantity || 0);
      entries.push({ kind: 'extra', concept: e.name || e.id || 'Extra', description: '', qty: e.quantity, unitVatInc, vatInc });
    }
  } else if (typeof r.extras_no_vat === 'number' && r.extras_no_vat > 0) {
    const vatInc = typeof r.extras_vat_inc === 'number' ? r.extras_vat_inc : r.extras_no_vat * div;
    entries.push({ kind: 'extra', concept: 'Extras opcionales', description: '', qty: null, unitVatInc: null, vatInc });
  }

  // 4) Net each row so it closes: unit first (2 decimals), subtotal =
  // qty × unit exactly. Collapsed rows (no qty) net their amount directly.
  const items = [];
  const surchargeRows = [];
  const extras = [];
  for (const e of entries) {
    let unit = null;
    let subtotal;
    if (e.qty && e.qty > 0) {
      const unitVatInc = typeof e.unitVatInc === 'number' ? e.unitVatInc : e.vatInc / e.qty;
      unit = round2(unitVatInc / div);
      subtotal = round2(unit * e.qty);
    } else {
      subtotal = round2(e.vatInc / div);
    }
    const row = { concept: e.concept, description: e.description, qty: e.qty == null ? null : e.qty, unit, subtotal };
    if (e.kind === 'item') items.push(row);
    else if (e.kind === 'surcharge') surchargeRows.push(row);
    else extras.push(row);
  }

  // Single collapsed lines (sum of the itemized rows) — kept for custom
  // cloud templates that still reference `surcharge_line`/`extras_line`.
  const surchargeLine = surchargeRows.length
    ? { concept: 'Recargo tallas grandes (4XL/5XL+)', description: '', qty: null, unit: null, subtotal: round2(surchargeRows.reduce((s, l) => s + l.subtotal, 0)) }
    : null;
  const extrasLine = extras.length
    ? { concept: 'Extras opcionales (sin IVA)', description: '', qty: null, unit: null, subtotal: round2(extras.reduce((s, l) => s + l.subtotal, 0)) }
    : null;

  // 5) Totals: the base is what the table actually shows (Σ rows), the
  // total is what the customer pays (stored), and the IVA line absorbs
  // the per-row rounding drift so the block always adds up.
  const base = round2([...items, ...surchargeRows, ...extras].reduce((s, l) => s + l.subtotal, 0));
  const total = round2(typeof r.total_vat_inc === 'number' ? r.total_vat_inc : 0);
  const vat = round2(total - base);

  return {
    items,
    surcharge_lines: surchargeRows,
    surcharge_line: surchargeLine,
    extras_lines: extras,
    extras_line: extrasLine,
    totals: { base, vat, total }
  };
}

module.exports = { buildPdfLines };
