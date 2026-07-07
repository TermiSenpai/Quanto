# PDF Quote Rework — Itemized, Ex-VAT — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`) syntax.
>
> **Commits:** per CLAUDE.md hard rule §10, do **not** commit/push unless the
> owner asks. The "Commit" steps below are recorded for completeness but during
> this execution are replaced by "run `pnpm test`". Leave the tree for the owner
> to review/commit.

**Goal:** Export PDF quotes that itemize every article (bundle components
distributed to sum exactly to the pack total) and every extra, show net (ex-VAT)
unit price + quantity, ex-VAT line subtotals, a VAT-included total, and drop the
per-person figure — across all 6 built-in templates + the preview.

**Architecture:** Price facts (per-article bundle prices, addon labels/prices)
are computed in `renderer/calculo.js` (has `cfg`) and stored on the quote
`result`, making it self-describing. A new pure `lib/pdf-lines.js` turns that
`result` into reconciled ex-VAT presentation lines (VAT rate derived from the
quote's own totals). `lib/pdf-templates.js` consumes it and the 6 templates +
preview render the new shape.

**Tech Stack:** Node/CommonJS (`lib/`), ES modules (`renderer/`), Vitest, the
in-house QWeb-style template engine (`lib/template-engine.js`).

---

## File structure

- **Create** `lib/pdf-lines.js` — pure line/total builder (ex-VAT, reconciled).
- **Create** `tests/pdf-lines.test.js` — unit tests for the above.
- **Modify** `renderer/calculo.js` — `calculateAddons` returns `lines`; the
  bundle branch distributes the pack price across `components[]`; the result
  gains `extras_lines`.
- **Modify** `tests/calculo.test.js` — bundle distribution + `extras_lines`.
- **Modify** `lib/pdf-templates.js` — `buildQuoteContext` uses `pdf-lines`; drop
  per-person from built-ins; keep legacy context fields; update the 6 templates
  + `LINES_ROWS` + `DEMO_QUOTE`.
- **Modify** `tests/pdf-templates.test.js` — new headers, itemized extras, no
  per-person in rendered built-ins, `unit_price` fixtures.

---

## Task 1: `lib/pdf-lines.js` — pure ex-VAT line builder

**Files:**
- Create: `lib/pdf-lines.js`
- Test: `tests/pdf-lines.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/pdf-lines.test.js
import { describe, test, expect } from 'vitest';
import { buildPdfLines } from '../lib/pdf-lines.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

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

  test('one item row per breakdown line, ex-VAT', () => {
    const out = buildPdfLines(result);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].concept).toContain('Sin capucha');
    expect(out.items[0].qty).toBe(5);
    // 74.75 / 1.21 ≈ 61.78
    expect(out.items[0].subtotal).toBeCloseTo(61.78, 2);
    expect(out.items[0].unit).toBeCloseTo(round2(61.78 / 5), 2);
  });

  test('surcharge row is ex-VAT with no qty/unit', () => {
    const out = buildPdfLines(result);
    expect(out.surcharge_line).not.toBeNull();
    expect(out.surcharge_line.qty).toBeNull();
    expect(out.surcharge_line.unit).toBeNull();
    expect(out.surcharge_line.subtotal).toBeCloseTo(9.09, 2);
  });

  test('legacy extras collapse to one line when no extras_lines', () => {
    const out = buildPdfLines(result);
    expect(out.extras_lines).toHaveLength(1);
    expect(out.extras_lines[0].subtotal).toBeCloseTo(7.5, 2);
  });

  test('all line subtotals sum exactly to sale_base', () => {
    const out = buildPdfLines(result);
    const all = [...out.items, out.surcharge_line, ...out.extras_lines].filter(Boolean);
    expect(round2(sum(all, r => r.subtotal))).toBe(round2(result.sale_base));
  });

  test('totals expose base/vat/total numbers', () => {
    const out = buildPdfLines(result);
    expect(out.totals).toEqual({ base: 176.43, vat: 37.05, total: 213.475 });
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

  test('component subtotals (ex-VAT) sum to sale_base', () => {
    const out = buildPdfLines(result);
    expect(round2(sum(out.items, r => r.subtotal))).toBe(round2(result.sale_base));
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
  });
});

describe('buildPdfLines — itemized extras + edges', () => {
  test('one row per extras_lines entry, ex-VAT', () => {
    const result = {
      pricing_mode: 'components',
      breakdown: [{ model: 'BEAGLE', name: 'Camiseta', quantity: 10, sides: 1, unit_price: 8.99, subtotal: 89.90 }],
      subtotal: 89.90, surcharges: 0,
      extras_no_vat: 12.4, extras_vat_inc: 15.004,
      extras_lines: [
        { id: 'name', name: 'Nombre', quantity: 10, unit_price: 1.815, subtotal: 18.15, vat_included: false }
      ],
      total_vat_inc: 104.904, sale_base: 86.70, vat: 18.20
    };
    const out = buildPdfLines(result);
    expect(out.extras_lines).toHaveLength(1);
    expect(out.extras_lines[0].concept).toBe('Nombre');
    expect(out.extras_lines[0].qty).toBe(10);
    expect(out.extras_lines[0].subtotal).toBeCloseTo(15, 1);
  });

  test('sale_base === 0 does not divide by zero', () => {
    const out = buildPdfLines({ breakdown: [], sale_base: 0, vat: 0, total_vat_inc: 0 });
    expect(out.items).toEqual([]);
    expect(out.totals).toEqual({ base: 0, vat: 0, total: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/pdf-lines.test.js`
Expected: FAIL — `buildPdfLines` not found.

- [ ] **Step 3: Implement `lib/pdf-lines.js`**

```js
// ============================================================
// Quanto · PDF quote line builder (pure, ex-VAT, reconciled)
// ============================================================
// Turns a stored/priced quote `result` into the presentation lines the
// PDF templates render: one row per article (bundle components are
// itemized when the result carries their distributed prices), one row
// per addon extra, and an optional large-size surcharge row — all in NET
// (ex-VAT) money, reconciled to the quote's own `sale_base` so the table
// foots exactly to "Subtotal (sin IVA)".
//
// The VAT rate is derived from the quote itself (`vat / sale_base`), so
// each quote stays internally consistent regardless of the current
// config VAT. No cfg, no fs, no DOM. Returns raw numbers — the template
// layer owns euro formatting. User-facing strings stay Spanish.
// ============================================================

'use strict';

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function vatRate(result) {
  const base = typeof result.sale_base === 'number' ? result.sale_base : 0;
  const vat = typeof result.vat === 'number' ? result.vat : 0;
  return base > 0 ? vat / base : 0;
}

function withSides(concept, sides) {
  return sides ? `${concept} (${sides}c)` : concept;
}

// Adjusts already-cent-rounded `amounts` so their sum equals round2(target),
// spreading the ±cent drift over the largest-magnitude entries first
// (deterministic). Returns a new euro array.
function reconcileToTarget(amounts, target) {
  const cents = amounts.map((a) => Math.round(a * 100));
  let drift = Math.round(target * 100) - cents.reduce((s, c) => s + c, 0);
  if (drift !== 0 && cents.length > 0) {
    const order = cents
      .map((c, i) => ({ i, mag: Math.abs(c) }))
      .sort((a, b) => b.mag - a.mag || a.i - b.i)
      .map((o) => o.i);
    const step = drift > 0 ? 1 : -1;
    let k = 0;
    while (drift !== 0) {
      cents[order[k % order.length]] += step;
      drift -= step;
      k += 1;
    }
  }
  return cents.map((c) => c / 100);
}

/**
 * @param {object} result priced/stored quote result (calculo.js shape)
 * @returns {{items:Array, surcharge_line:object|null, extras_lines:Array,
 *            totals:{base:number,vat:number,total:number}}}
 */
function buildPdfLines(result) {
  const r = result || {};
  const div = 1 + vatRate(r);
  const saleBase = typeof r.sale_base === 'number' ? r.sale_base : 0;

  // 1) Raw entries with VAT-included amounts.
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
        entries.push({ kind: 'item', concept: withSides(c.name || c.model || '—', top.sides), description: '', qty: c.quantity, vatInc: c.subtotal });
      }
    } else {
      entries.push({ kind: 'item', concept: withSides(r.pack || top.name || '—', top.sides), description: '', qty: top.quantity, vatInc: top.subtotal });
    }
  } else if (breakdown.length > 0) {
    for (const d of breakdown) {
      if (d.quantity === 0) continue;
      const vatInc = typeof d.subtotal === 'number' ? d.subtotal : (d.unit_price || 0) * (d.quantity || 0);
      entries.push({ kind: 'item', concept: withSides(d.name || d.model || '—', d.sides), description: d.description || '', qty: d.quantity, vatInc });
    }
  } else if (typeof r.quantity === 'number' && typeof r.unit_price === 'number') {
    const vatInc = typeof r.subtotal === 'number' ? r.subtotal : r.quantity * r.unit_price;
    entries.push({ kind: 'item', concept: r.pack || '—', description: r.tier ? `Tramo ${r.tier}` : '', qty: r.quantity, vatInc });
  }

  // 2) Large-size surcharge (4XL/5XL), VAT-included.
  const surcharges = typeof r.surcharges === 'number' ? r.surcharges : 0;
  if (surcharges > 0) {
    entries.push({ kind: 'surcharge', concept: 'Recargo tallas grandes (4XL/5XL+)', description: '', qty: null, vatInc: surcharges });
  }

  // 3) Extras — itemized if the result carries them, else a collapsed line.
  const extrasLines = Array.isArray(r.extras_lines) ? r.extras_lines : [];
  if (extrasLines.length > 0) {
    for (const e of extrasLines) {
      if (!e.quantity) continue;
      const vatInc = typeof e.subtotal === 'number' ? e.subtotal : (e.unit_price || 0) * (e.quantity || 0);
      entries.push({ kind: 'extra', concept: e.name || e.id || 'Extra', description: '', qty: e.quantity, vatInc });
    }
  } else if (typeof r.extras_no_vat === 'number' && r.extras_no_vat > 0) {
    const vatInc = typeof r.extras_vat_inc === 'number' ? r.extras_vat_inc : r.extras_no_vat * div;
    entries.push({ kind: 'extra', concept: 'Extras opcionales', description: '', qty: null, vatInc });
  }

  // 4) Convert to ex-VAT, reconcile Σ subtotal === sale_base.
  const exVat = entries.map((e) => round2(e.vatInc / div));
  const reconciled = saleBase > 0 ? reconcileToTarget(exVat, saleBase) : exVat;

  const items = [];
  let surchargeLine = null;
  const extras = [];
  entries.forEach((e, i) => {
    const subtotal = reconciled[i];
    const unit = (e.qty && e.qty > 0) ? round2(subtotal / e.qty) : null;
    const row = { concept: e.concept, description: e.description, qty: e.qty == null ? null : e.qty, unit, subtotal };
    if (e.kind === 'item') items.push(row);
    else if (e.kind === 'surcharge') surchargeLine = row;
    else extras.push(row);
  });

  return {
    items,
    surcharge_line: surchargeLine,
    extras_lines: extras,
    totals: {
      base: round2(saleBase),
      vat: round2(typeof r.vat === 'number' ? r.vat : 0),
      total: round2(typeof r.total_vat_inc === 'number' ? r.total_vat_inc : 0)
    }
  };
}

module.exports = { buildPdfLines };
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/pdf-lines.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (deferred per §10 — run `pnpm test` instead)

---

## Task 2: `renderer/calculo.js` — bundle distribution + `extras_lines`

**Files:**
- Modify: `renderer/calculo.js` (`calculateAddons`; the bundle branch; the result)
- Test: `tests/calculo.test.js`

- [ ] **Step 1: Write the failing tests** (append to `tests/calculo.test.js`)

```js
describe('bundle article distribution + extras_lines', () => {
  // uses the shared full-config fixture already imported in this file as CONFIG
  const opt = { options: { hood: 'without_hood', sides: 'two_sides' }, packs: 12 };

  test('bundle components carry per-article prices summing to the bundle subtotal', () => {
    const r = calculatePack(CONFIG, 'crew_full', opt);
    const comps = r.breakdown[0].components;
    expect(comps).toHaveLength(2);
    for (const c of comps) {
      expect(typeof c.unit_price).toBe('number');
      expect(typeof c.subtotal).toBe('number');
    }
    const sum = comps.reduce((s, c) => s + c.subtotal, 0);
    expect(Math.round(sum * 100) / 100).toBe(Math.round(r.subtotal * 100) / 100);
  });

  test('distribution weights the pricier garment higher (sudadera > camiseta)', () => {
    const r = calculatePack(CONFIG, 'crew_full', opt);
    const [camiseta, sudadera] = r.breakdown[0].components;
    expect(sudadera.unit_price).toBeGreaterThan(camiseta.unit_price);
  });

  test('extras_lines lists each selected addon with a VAT-inc unit price', () => {
    const r = calculatePack(CONFIG, 'crew_full', { ...opt, addons: { name: 12 } });
    expect(Array.isArray(r.extras_lines)).toBe(true);
    expect(r.extras_lines).toHaveLength(1);
    const line = r.extras_lines[0];
    expect(line.id).toBe('name');
    expect(line.quantity).toBe(12);
    // addon 'name' price 1.5 ex-VAT → 1.5 * 1.21 = 1.815 VAT-inc
    expect(line.unit_price).toBeCloseTo(1.815, 3);
    expect(line.vat_included).toBe(false);
  });
});
```

> If the fixture is imported under a different name in `tests/calculo.test.js`,
> reuse that name instead of `CONFIG`. Verify the import at the top of the file
> before running.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/calculo.test.js -t "bundle article distribution"`
Expected: FAIL — components lack `unit_price`; `extras_lines` undefined.

- [ ] **Step 3a: `calculateAddons` returns per-addon `lines`**

Replace the loop body + return of `calculateAddons` so it also builds `lines`:

```js
  let noVat = 0;
  let vatInc = 0;
  const detail = {};
  const lines = [];

  for (const [id, qty] of Object.entries(sel)) {
    const n = qty || 0;
    if (n <= 0) continue;
    const addon = addons[id];
    if (!addon) continue;
    detail[id] = n;
    let unitVatInc;
    if (addon.vat_included) {
      unitVatInc = addon.price;
      vatInc += n * addon.price;
      noVat += n * (addon.price / (1 + vat));
    } else {
      unitVatInc = addon.price * (1 + vat);
      noVat += n * addon.price;
      vatInc += n * addon.price * (1 + vat);
    }
    lines.push({
      id,
      name: addon.label || id,
      quantity: n,
      unit_price: unitVatInc,       // VAT-inc; pdf-lines converts to ex-VAT
      subtotal: n * unitVatInc,     // VAT-inc
      vat_included: Boolean(addon.vat_included)
    });
  }

  return { no_vat: noVat, vat_inc: vatInc, detail, lines };
```

- [ ] **Step 3b: Add the bundle-distribution helper** (place near `roundUpToEnding`)

```js
/**
 * Splits a bundle pack's VAT-incl `bundleSubtotal` across its component
 * lines so the customer sees a per-article price. Weight = the article's
 * standalone catalog price (prices[sidesKey][tier]) × quantity; falls back
 * to internal garment cost, then to an equal split. Reconciled to the cent
 * so the parts sum exactly to `bundleSubtotal`.
 *
 * @returns Array aligned to `lines` of { unit_price, subtotal } (VAT-incl).
 */
function distributeBundleSubtotal(cfg, lines, sidesKey, sidesNum, tier, total, bundleSubtotal) {
  const weights = lines.map((l) => {
    const product = cfg.products[l.productId];
    const priceTable = (product.prices || {})[sidesKey] || {};
    let unitWeight = priceTable[tier.id];
    if (!(typeof unitWeight === 'number' && unitWeight > 0)) {
      const cost = calculateGarmentCost(cfg, l.productId, sidesNum, tier, total).total;
      unitWeight = (typeof cost === 'number' && cost > 0) ? cost : 1;
    }
    return unitWeight * (l.quantity || 0);
  });
  const sumW = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map((w) => (sumW > 0
    ? round2(bundleSubtotal * w / sumW)
    : round2(bundleSubtotal / lines.length)));
  const parts = reconcileCents(raw, bundleSubtotal);
  return parts.map((subtotal, i) => ({
    subtotal,
    unit_price: lines[i].quantity > 0 ? round2(subtotal / lines[i].quantity) : 0
  }));
}

// Adjusts cent-rounded `amounts` so their sum equals round2(target),
// spreading the drift over the largest-magnitude entries first.
function reconcileCents(amounts, target) {
  const cents = amounts.map((a) => Math.round(a * 100));
  let drift = Math.round(target * 100) - cents.reduce((s, c) => s + c, 0);
  if (drift !== 0 && cents.length > 0) {
    const order = cents
      .map((c, i) => ({ i, mag: Math.abs(c) }))
      .sort((a, b) => b.mag - a.mag || a.i - b.i)
      .map((o) => o.i);
    const step = drift > 0 ? 1 : -1;
    let k = 0;
    while (drift !== 0) {
      cents[order[k % order.length]] += step;
      drift -= step;
      k += 1;
    }
  }
  return cents.map((c) => c / 100);
}
```

- [ ] **Step 3c: Attach distributed prices in the bundle branch**

In the `pack.pricing_mode === 'bundle'` branch, replace the `breakdown.push({...})`
`components` mapping with the distributed one:

```js
    const parts = distributeBundleSubtotal(cfg, lines, sidesKey, sidesNum, tier, total, subtotal);
    breakdown.push({
      model: packId,
      name: pack.name,
      quantity: packsN,
      sides: sidesNum,
      unit_price: bundlePrice,
      subtotal,
      components: lines.map((l, i) => ({
        model: l.productId,
        name: cfg.products[l.productId].name,
        quantity: l.quantity,
        unit_price: parts[i].unit_price,
        subtotal: parts[i].subtotal
      }))
    });
```

- [ ] **Step 3d: Expose `extras_lines` on the result**

In the returned result object add (next to `extras_detail`):

```js
    extras_detail: addons.detail,
    extras_lines: addons.lines,
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/calculo.test.js`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit** (deferred per §10 — run `pnpm test` instead)

---

## Task 3: `lib/pdf-templates.js` — context + 6 templates + preview

**Files:**
- Modify: `lib/pdf-templates.js`
- Test: `tests/pdf-templates.test.js`

- [ ] **Step 1: Update the failing tests** (see Task 4 for the full test edits — do them first so this task is test-driven).

- [ ] **Step 2: `require` and rewrite the context builder**

At the top, add:

```js
const { buildPdfLines } = require('./pdf-lines');
```

Replace `buildLineItems`/`buildSpecialSizes` usage inside `buildQuoteContext` so
the line/extra/total shaping comes from `buildPdfLines`. Concretely, inside
`buildQuoteContext`, after resolving `result`, replace the block that computes
`items`, `surchargesLine`, `extrasLine`, `totals`, `perPerson` with:

```js
  const lineSrc = {
    ...result,
    sale_base: totals.sale_base ?? result?.sale_base ?? 0,
    vat: totals.vat ?? result?.vat ?? 0,
    total_vat_inc: totals.total_vat_inc ?? result?.total_vat_inc ?? 0
  };
  const lines = buildPdfLines(lineSrc);

  const items = lines.items.map((it) => ({
    concept: it.concept,
    description: it.description || '',
    qty: it.qty == null ? '' : String(it.qty),
    unit: it.unit == null ? '—' : fmtEur(it.unit),
    subtotal: fmtEur(it.subtotal)
  }));
  const surchargesLine = lines.surcharge_line
    ? { concept: lines.surcharge_line.concept, qty: '—', unit: '—', subtotal: fmtEur(lines.surcharge_line.subtotal) }
    : null;
  const extrasLines = lines.extras_lines.map((e) => ({
    concept: e.concept,
    qty: e.qty == null ? '—' : String(e.qty),
    unit: e.unit == null ? '—' : fmtEur(e.unit),
    subtotal: fmtEur(e.subtotal)
  }));

  const totalUnits = result?.total_quantity ?? result?.quantity ?? 0;
  const total = lines.totals.total;
  // Per-person kept in context for custom templates only; built-ins no longer
  // render it (a head-count is unknown for an order).
  const hasPerPerson = items.length === 1 && totalUnits > 0 && total > 0;
  const perPerson = hasPerPerson ? fmtEur(total / totalUnits) : '';

  // Legacy collapsed extras line — kept for custom cloud templates.
  const extrasNoVat = result?.extras_no_vat || 0;
  const legacyExtrasLine = extrasNoVat > 0
    ? { concept: 'Extras opcionales (sin IVA)', qty: '—', unit: '—', subtotal: fmtEur(extrasNoVat) }
    : null;
```

Then update the returned context object so it uses:

```js
    total_units: String(totalUnits || ''),
    items,
    surcharge_line: surchargesLine,
    has_surcharge: Boolean(surchargesLine),
    extras_lines: extrasLines,          // NEW — itemized (built-ins)
    extras_line: legacyExtrasLine,      // legacy collapsed (custom templates)
    has_extras: Boolean(legacyExtrasLine),
    totals: {
      base: fmtEur(lines.totals.base),
      vat: fmtEur(lines.totals.vat),
      total: fmtEur(lines.totals.total)
    },
    per_person: perPerson,
    has_per_person: hasPerPerson,
```

Remove the now-unused `surcharges`/`extras`/`buildLineItems`-based locals. Keep
`buildSpecialSizes`, `special_sizes`, `conditions`, `confirmation`, `brand`,
`company`, `quote`, `client`, `pack`, `tier` exactly as before.

- [ ] **Step 3: Update `LINES_ROWS`** — replace the single `has_extras` row with an each loop:

```js
const LINES_ROWS = `{{#each items}}
        <tr>
          <td>{{this.concept}}</td>
          <td class="num">{{this.qty}}</td>
          <td class="num">{{this.unit}}</td>
          <td class="num">{{this.subtotal}}</td>
        </tr>{{/each}}
      {{#if has_surcharge}}<tr>
          <td>{{surcharge_line.concept}}</td>
          <td class="num">{{surcharge_line.qty}}</td>
          <td class="num">{{surcharge_line.unit}}</td>
          <td class="num">{{surcharge_line.subtotal}}</td>
        </tr>{{/if}}
      {{#each extras_lines}}<tr>
          <td>{{this.concept}}</td>
          <td class="num">{{this.qty}}</td>
          <td class="num">{{this.unit}}</td>
          <td class="num">{{this.subtotal}}</td>
        </tr>{{/each}}`;
```

- [ ] **Step 4: Update each template's header, totals labels, extras loop, and drop per-person**

Per template, apply these exact string edits:

- **CLASICA**: header `PVP unitario`→`Precio unit. (sin IVA)`, `<th class="num">Subtotal</th>`→`<th class="num">Subtotal (sin IVA)</th>`; totals `Base imponible`→`Subtotal (sin IVA)`, `<td>Total</td>`→`<td>Total (IVA incl.)</td>`; delete the `{{#if has_per_person}}…{{/if}}` per-person `<div>`.
- **MODERNA**: header `<th class="num">PVP</th>`→`<th class="num">P. unit. (s/IVA)</th>`, `Subtotal`→`Subtotal (s/IVA)`; totals `Base imponible`→`Subtotal (sin IVA)`, `Total`→`Total (IVA incl.)`; delete the per-person `<div>`.
- **COMPACTA**: header `<th class="num">PVP</th>`→`<th class="num">P.u. s/IVA</th>`, `<th class="num">Subt.</th>`→`<th class="num">Subt. s/IVA</th>`; totals `Base`→`Subtotal s/IVA`, `Total`→`Total c/IVA`. (no per-person present.)
- **DETALLADA**: header `PVP unitario`→`Precio unit. (sin IVA)`, `Subtotal`→`Subtotal (sin IVA)`; replace the `{{#if has_extras}}<tr>…{{/if}}` extras row with the each loop below; totals `Base imponible`→`Subtotal (sin IVA)`, `Total`→`Total (IVA incl.)`; delete the per-person `<div>`.

  ```html
        {{#each extras_lines}}<tr><td>{{this.concept}}</td><td class="num">{{this.qty}}</td><td class="num">{{this.unit}}</td><td class="num">{{this.subtotal}}</td></tr>{{/each}}
  ```

- **CORPORATIVA**: header `<th class="num">PVP</th>`→`<th class="num">P. unit. (s/IVA)</th>`, `Subtotal`→`Subtotal (s/IVA)`; replace the `{{#if has_extras}}<tr>…{{/if}}` extras row with the each loop below; totals `Base imponible`→`Subtotal (sin IVA)`, `Total`→`Total (IVA incl.)`; delete the per-person `<div>`.

  ```html
        {{#each extras_lines}}<tr><td class="idx">+</td><td>{{this.concept}}</td><td class="num">{{this.qty}}</td><td class="num">{{this.unit}}</td><td class="num">{{this.subtotal}}</td></tr>{{/each}}
  ```

- **FORMULARIO**: header `PVP unitario`→`Precio unit. (sin IVA)`, `Subtotal`→`Subtotal (sin IVA)`; totals `Subtotal (base)`→`Subtotal (sin IVA)`, `Total`→`Total (IVA incl.)`. (uses `LINES_ROWS`; no per-person present.)

- [ ] **Step 5: Update `DEMO_QUOTE`** for the preview to exercise bundle itemization + extras + surcharge (consistent VAT-inc numbers):

```js
const DEMO_QUOTE = {
  id: 'PRE-2026-0042',
  date: new Date('2026-06-13T10:00:00').toISOString(),
  user: 'Mostrador',
  config_version: '4.0.0',
  customer: { name: 'Peña El Ejemplo <demo>', phone: '600 123 456', email: 'pena@ejemplo.es' },
  result: {
    pricing_mode: 'bundle',
    pack: 'Pack peña',
    tier: 'T2',
    total_quantity: 25,
    quantity: 25,
    qty_4xl: 2,
    qty_5xl: 1,
    surcharges: 18,
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
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm exec vitest run tests/pdf-templates.test.js`
Expected: PASS.

- [ ] **Step 7: Commit** (deferred per §10 — run `pnpm test` instead)

---

## Task 4: Update `tests/pdf-templates.test.js`

**Files:**
- Modify: `tests/pdf-templates.test.js`

- [ ] **Step 1: Fix `SAMPLE_MIXED_QUOTE` breakdown** — `price:`→`unit_price:` and add `pricing_mode`:

```js
  result: {
    pack: 'Pack mixto sudaderas',
    pricing_mode: 'components',
    tier: '10-24 uds',
    total_quantity: 12,
    quantity: 12,
    breakdown: [
      { model: 'CLASICA', name: 'Sudadera sin capucha', quantity: 5, sides: 2, unit_price: 14.95, subtotal: 74.75 },
      { model: 'URBAN', name: 'Sudadera con capucha', quantity: 7, sides: 2, unit_price: 16.95, subtotal: 118.65 }
    ],
    subtotal: 193.40, surcharges: 11, extras_no_vat: 7.5, extras_vat_inc: 9.075,
    total_vat_inc: 213.475, sale_base: 176.43, vat: 37.05,
    qty_3xl: 1, qty_4xl: 2, qty_5xl: 1
  }
```

- [ ] **Step 2: Add a bundle sample** (below `SAMPLE_MIXED_QUOTE`):

```js
const SAMPLE_BUNDLE_QUOTE = {
  id: 'PP-2026-0100',
  date: '2026-05-11T10:00:00Z',
  customer: { name: 'Peña Bundle', phone: '622 000 000' },
  result: {
    pricing_mode: 'bundle',
    pack: 'Pack Peña (camiseta + sudadera)',
    tier: '10-24 uds',
    total_quantity: 12, quantity: 12,
    unit_price: 25.95, subtotal: 311.40,
    surcharges: 0, extras_no_vat: 0,
    total_vat_inc: 311.40, sale_base: 257.36, vat: 54.04,
    breakdown: [{
      model: 'crew_full', name: 'Pack Peña', quantity: 12, sides: 2, unit_price: 25.95, subtotal: 311.40,
      components: [
        { model: 'BEAGLE',  name: 'Camiseta', quantity: 12, unit_price: 11.55, subtotal: 138.60 },
        { model: 'CLASICA', name: 'Sudadera', quantity: 12, unit_price: 14.40, subtotal: 172.80 }
      ]
    }]
  }
};
```

- [ ] **Step 3: Replace the per-person context test** with itemization + no-per-person-in-HTML tests:

```js
  test('itemizes bundle components as one line each', () => {
    const ctx = buildQuoteContext(SAMPLE_BUNDLE_QUOTE, {});
    expect(ctx.items.length).toBe(2);
    expect(ctx.items[0].concept).toContain('Camiseta');
    expect(ctx.items[1].concept).toContain('Sudadera');
  });

  test('shows ex-VAT unit prices (net), not the VAT-inc PVP', () => {
    const ctx = buildQuoteContext(SAMPLE_MIXED_QUOTE, {});
    // 74.75 / 1.21 / 5 ≈ 12.36 (net), never the 14.95 PVP
    expect(ctx.items[0].unit).not.toMatch(/14[,.]95/);
  });

  test('itemizes extras when the result carries extras_lines', () => {
    const withExtras = {
      ...SAMPLE_MIXED_QUOTE,
      result: {
        ...SAMPLE_MIXED_QUOTE.result,
        extras_lines: [{ id: 'name', name: 'Nombre', quantity: 3, unit_price: 1.815, subtotal: 5.445, vat_included: false }]
      }
    };
    const ctx = buildQuoteContext(withExtras, {});
    expect(ctx.extras_lines.length).toBe(1);
    expect(ctx.extras_lines[0].concept).toBe('Nombre');
  });
```

- [ ] **Step 4: Add a rendered-HTML assertion that per-person is gone** (inside the `renderQuote — every built-in renders clean` loop, after the mixed-quote test):

```js
    test(`'${id}' no longer prints a per-person figure`, () => {
      const html = renderQuote(SAMPLE_CREW_QUOTE, {
        templateId: id, company: { name: 'T' }, quoteSettings: { terms: '' }, brand: brandColors('#3D7BD9')
      });
      expect(html).not.toMatch(/por\s+persona/i);
    });
```

- [ ] **Step 5: Keep the `builds line items for a single-pack result` test** — SAMPLE_CREW_QUOTE has no breakdown, so `buildPdfLines` uses the single-line fallback: `items.length === 1`, concept contains `Pack Peña`, `qty === '12'`. No change needed; verify it still passes.

- [ ] **Step 6: Run the full file**

Run: `pnpm exec vitest run tests/pdf-templates.test.js`
Expected: PASS.

- [ ] **Step 7: Commit** (deferred per §10 — run `pnpm test` instead)

---

## Task 5: Full suite green

- [ ] **Step 1:** Run `pnpm test`. Expected: all suites PASS (incl. `cloud-pdf-templates`, `pdf-gallery`).
- [ ] **Step 2:** If `cloud-pdf-templates.test.js` or `pdf-gallery.test.js` asserted on old headers/per-person/extras, update those assertions to match the new shape (same edits as Task 4). Re-run.
- [ ] **Step 3:** Report the tree state to the owner for review/commit (no commit per §10).

---

## Self-review

- **Spec coverage:** extras itemized (Task 2 `extras_lines` + Task 3 loop); unit
  price without extras (extras are separate lines, article unit from breakdown);
  remove per-person (Task 3 delete blocks + Task 4 HTML assertion); ex-VAT unit +
  qty (Task 1 conversion + Task 3 headers); ex-VAT subtotal (Task 1); VAT-inc
  total (Task 1 totals + Task 3 labels); itemize every article incl. bundle
  (Task 2 distribution + Task 1 bundle path). All 6 templates + preview (Task 3).
- **Placeholder scan:** none.
- **Type consistency:** `buildPdfLines(result) → {items, surcharge_line,
  extras_lines, totals:{base,vat,total}}` used consistently; `extras_lines`
  entries `{id,name,quantity,unit_price,subtotal,vat_included}` from calculo
  match what `buildPdfLines`/context read; `reconcileToTarget`/`reconcileCents`
  same signature `(amounts, target) → number[]`.
