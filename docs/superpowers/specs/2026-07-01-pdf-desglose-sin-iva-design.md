# PDF Quote Rework — Itemized, Ex-VAT — Design

**Date:** 2026-07-01 · **Revised:** 2026-07-06 (owner-approved: rows close
instead of reconciling to `sale_base`; uniform weight basis; custom-template
contract break assumed and documented — see §3.2, §3.1 and §6).
**Status:** Approved (owner), implemented.
**Plan:** `docs/superpowers/plans/2026-07-01-pdf-desglose-sin-iva.md`

---

## 1. Summary

The exported PDF quotes change how prices are presented. Requested by the owner:

1. **Itemize extras** — one line per addon instead of a single collapsed
   "Extras opcionales" line.
2. **Unit price without extras** — the article's unit price never folds in the
   addon extras (they are their own lines).
3. **Remove "precio medio por persona"** — a head-count is not known for an
   order, so the per-person figure is dropped from the PDF.
4. **Show ex-VAT unit price + quantity instead of PVP** — the unit-price column
   is the net (sin IVA) price, not the VAT-included PVP.
5. **Line subtotal ex-VAT** ("Subtotal sin IVA").
6. **Order total VAT-included** ("Total con IVA").
7. **Itemize every article, even for a bundle pack** — a bundle pack (e.g.
   "Pack Peña") lists each garment (camiseta, sudadera…) as its own line.

Applies to **the 6 built-in templates + the settings preview**.

### Decisions (confirmed with the owner)

| Topic | Decision |
|---|---|
| Bundle article breakdown | **Itemize each article**, distributing the pack price across them so the lines **sum exactly to the pack total**. |
| Distribution weight (rev. 2026-07-06) | **One basis per bundle**: standalone catalog price (`product.prices[sidesKey][tier]`) × quantity when **every** component has one; else internal garment cost **for all**; else equal per-unit split. Never mix retail and cost scales in one bundle. |
| Row arithmetic (rev. 2026-07-06) | **Every printed row closes**: ex-VAT unit first (2 decimals), `subtotal = qty × unit` exactly. The totals block foots with `base = Σ rows` and `IVA = total − base` (the IVA line absorbs the rounding drift; the charged total is untouched). Replaces the original "reconcile Σ to `sale_base`" rule, which made `qty × unit ≠ subtotal` visible on customer-facing rows. |
| Template scope | **All 6 built-ins + the preview.** |
| Totals wording | "Subtotal (sin IVA)" / "IVA" / "Total (IVA incl.)". |

---

## 2. Current state (anchors)

- **Pricing** — `renderer/calculo.js` `calculatePack(cfg, packId, opt)` returns a
  `result` with a `breakdown` array (all money **VAT-included**):
  - *bundle* pack → **one** row `{ model, name, quantity(=packs), sides,
    unit_price(=bundle price/pack), subtotal, components: [{model,name,quantity}] }`
    — the `components` carry **name + quantity only, no per-article price**.
  - *components* pack → **one row per component**
    `{ model, name, quantity, sides, unit_price, subtotal }`.
  - plus `subtotal` (garments), `surcharges`, `extras_no_vat`, `extras_vat_inc`,
    `extras_detail: {addonId: qty}`, `total_vat_inc`, `sale_base`, `vat`.
- **PDF render** — `renderer/app.js` `exportPdf({quote, company, quote_settings})`
  → `main.js` `pdf:export` → `lib/pdf-templates.js` `renderQuote(quote, {company,
  quoteSettings, brand, templateChoice})`. **`pdf-templates.js` has no access to
  `cfg`** (no VAT rate, no addon labels).
- **`buildQuoteContext`** flattens the quote; `buildLineItems` builds the table
  rows and currently reads **`line.price`** — but `calculatePack` emits
  **`unit_price`**. In production the unit-price column therefore renders "—"
  (the test fixture masks it by using `price:`). This is a **latent bug** fixed
  by this rework.
- The six templates render `PVP unitario`/`PVP` (VAT-inc), a `has_per_person`
  line, and a single `has_extras` "Extras opcionales (sin IVA)" line.
- **Bundle components have `prices` tables** in the real catalog and the fixture
  (BEAGLE/CLASICA/URBAN), so standalone-price weighting is reliable.

---

## 3. Architecture

The itemization needs two kinds of information that live in different places:

- **Price facts** (per-article bundle prices, addon labels/prices) need `cfg` →
  they are produced in `calculo.js` at pricing time and stored in the `result`,
  making the quote **self-describing** (the pattern components-mode already
  follows: each line carries `name` + `unit_price`).
- **Presentation math** (ex-VAT conversion, cent reconciliation) needs only the
  stored `result` → a new **pure, cfg-free** module derives the VAT rate from the
  quote's own totals and produces the reconciled ex-VAT lines.

```
calculo.js (has cfg)         lib/pdf-lines.js (pure, no cfg)        pdf-templates.js
──────────────────────       ────────────────────────────────      ────────────────
enrich result:               buildPdfLines(result) →                buildQuoteContext
 • bundle components[]         • items[] (ex-VAT unit+subtotal)       calls buildPdfLines,
   get unit_price/subtotal     • surcharge_line (ex-VAT)             drops per_person,
   (distributed, reconciled)   • extras_lines[] (ex-VAT)             keeps legacy fields
 • result.extras_lines[]       • totals {base, vat, total}          6 templates + preview
   {id,name,qty,unit,sub,      derives vat rate = vat/sale_base      render the new shape
    vat_included}              reconciles Σsubtotal_exVAT = base
```

### 3.1 `renderer/calculo.js` — enrich the result (price facts)

- **Bundle distribution.** In the `pricing_mode === 'bundle'` branch, after the
  bundle `subtotal` (VAT-inc) is known, distribute it across the components:
  - weight `w_i = unitWeight_i × quantity_i`, where the `unitWeight` basis is
    **uniform for the whole bundle** (rev. 2026-07-06): standalone catalog
    price `product.prices[sidesKey][tier.id]` when every component has one;
    else `calculateGarmentCost(...).total` for all; else `1` for all.
  - `subtotal_i = round2(bundleSubtotal × w_i / Σw)`, then **largest-remainder
    reconcile** so `Σ subtotal_i === round2(bundleSubtotal)` exactly.
  - `unit_price_i = round2(subtotal_i / quantity_i)`.
  - store these on each `components[i]` as `unit_price` + `subtotal` (VAT-inc,
    consistent with the rest of the breakdown). `quantity`/`name`/`model` stay.
- **Extras itemization.** Add `result.extras_lines`: for each selected addon
  `{ id, name, quantity, unit_price /*VAT-inc*/, subtotal /*VAT-inc*/,
  vat_included }`, derived from `cfg.addons` (label, price, `vat_included`) and
  the addon vat gross-up already used in `calculateAddons`. `extras_detail`
  stays for back-compat (stats/reopen).
- No change to totals (`sale_base`, `vat`, `total_vat_inc`) or to the money the
  customer pays — only added descriptive facts.

### 3.2 `lib/pdf-lines.js` — presentation math (new, pure, tested)

`buildPdfLines(result) → { items, surcharge_lines, surcharge_line,
extras_lines, extras_line, totals }`, all **ex-VAT** where relevant, every
row closing (rev. 2026-07-06):

- **VAT rate** `= result.vat / result.sale_base` (guard `sale_base > 0`, else 0)
  — self-consistent with the stored quote regardless of the current config VAT.
- **Garment/article rows:**
  - bundle **with** `components[].unit_price` → one row per component
    (`concept`, `qty`, ex-VAT `unit`, ex-VAT `subtotal`).
  - bundle **without** (legacy quote) → single pack row (current behavior).
  - components pack → one row per breakdown line (reads `unit_price`, fixes the
    `line.price` bug).
- **Surcharge row** (4XL/5XL) → ex-VAT amount, qty/unit "—".
- **Extras rows** → from `result.extras_lines` (ex-VAT unit + subtotal); legacy
  quote without `extras_lines` but with `extras_no_vat > 0` → single "Extras
  opcionales (sin IVA)" line.
- **Row math (rev. 2026-07-06, replaces reconciliation):** derive the ex-VAT
  unit first — `unit = round2(unitVatInc / (1+rate))` — and make
  `subtotal = round2(qty × unit)` so **every printed row closes** under a
  customer's multiplication. Collapsed rows (no qty) net their amount
  directly. Line prices are **never stretched** to match a stored base: an
  inconsistent stored quote shows its real numbers (and an odd IVA line)
  instead of plausible invented prices.
- **Totals:** `{ base: Σ rows, vat: round2(total − base), total:
  total_vat_inc }` — the IVA line absorbs the per-row rounding drift so the
  block always adds up to the charged total (formatted by the template
  layer). `base` may differ from the stored `sale_base` by a few cents.

Returns numbers (not formatted strings) so `pdf-templates` keeps ownership of
`fmtEur`. Pure: no fs/DOM/Electron; unit-tested for reconciliation, legacy
fallback, and single-rate correctness.

### 3.3 `lib/pdf-templates.js` — context + templates

- `buildQuoteContext` calls `buildPdfLines(result)` and formats:
  - `items[]` → `{ concept, description, qty, unit, subtotal }` (unit/subtotal
    ex-VAT, formatted).
  - `surcharge_line`, `extras_lines[]` (formatted).
  - `totals` `{ base, vat, total }` (as today, now labeled ex-VAT/VAT/VAT-inc).
- **Drop** the per-person computation from the built-ins; **keep** the legacy
  context fields (`per_person`, `has_per_person`, `extras_line`, `has_extras`)
  populated so **custom cloud templates don't break**.
- **6 templates + preview:**
  - table header → `Concepto · Cantidad · Precio unit. (sin IVA) · Subtotal
    (sin IVA)` (compact variants may abbreviate: `P. unit. s/IVA`, `Subt.`).
  - totals rows → `Subtotal (sin IVA)` · `IVA` · `Total (IVA incl.)`.
  - replace the single `{{#if has_extras}}` row with a `{{#each extras_lines}}`
    loop (concept, qty, unit, subtotal).
  - remove the `{{#if has_per_person}}` blocks.

---

## 4. Data flow (worked example — Pack Peña, bundle, T1, 12 packs, 2 sides)

- bundle price/pack `25.95` (VAT-inc) → `subtotal = 311.40`.
- weights: Camiseta `11.99×12 = 143.88`, Sudadera `14.95×12 = 179.40`; Σ`323.28`.
- Camiseta `subtotal = 311.40×143.88/323.28 = 138.60` → unit `11.55`.
- Sudadera `subtotal = 311.40×179.40/323.28 = 172.80` → unit `14.40`
  (largest-remainder ensures `138.60 + 172.80 = 311.40`).
- ex-VAT (rate `54.04/257.36 = 21%`): Camiseta unit `11.55/1.21 → 9.55`,
  subtotal `12 × 9.55 = 114.60`; Sudadera unit `14.40/1.21 → 11.90`, subtotal
  `12 × 11.90 = 142.80` — both rows close exactly.
- Table: two garment lines (qty, ex-VAT unit, ex-VAT subtotal); totals Subtotal
  `257.40` (Σ rows) / IVA `54.00` (= 311.40 − 257.40, absorbs the 4-cent
  rounding drift vs the stored `54.04`) / Total `311.40`.

---

## 5. Testing

Per hard rule §7 (tests ship with calc/schema changes):

- **`tests/pdf-lines.test.js`** (new): reconciliation to `sale_base`;
  bundle-with-components itemization; legacy bundle fallback (single line);
  extras itemization + legacy fallback; surcharge ex-VAT; VAT-rate derivation;
  `sale_base === 0` guard.
- **`tests/calculo.test.js`** (extend): bundle `components[]` carry
  `unit_price`/`subtotal` that sum exactly to the bundle subtotal; weighting by
  standalone price; `extras_lines` shape and gross-up.
- **`tests/pdf-templates.test.js`** (update): new headers, no per-person,
  itemized extras rows, ex-VAT unit/subtotal; keep the XSS-escaping and
  balanced-tag probes; update `SAMPLE_MIXED_QUOTE` to use `unit_price` and add a
  bundle-with-components sample.

`pnpm test` green.

---

## 6. Compatibility & non-goals

- **Legacy saved quotes** (already persisted, no new fields): degrade gracefully
  — bundle → single pack line; extras → single collapsed line. New quotes are
  fully itemized.
- **Custom cloud templates** (rev. 2026-07-06): the legacy context **keys**
  survive but three **semantics change**, accepted by the owner (beta, no
  known custom templates in the wild) and to be noted in the release devlog:
  - `items[].unit`/`items[].subtotal` are now **ex-VAT** (were VAT-inc PVP) —
    a custom template with a hard-coded "PVP unitario" header shows net
    prices until its header is updated.
  - `surcharge_line` and `extras_line` both derive from the **same ex-VAT
    rows the table shows** (before: surcharge was VAT-inc, extras raw net —
    two conventions), so custom templates always foot with the table.
  - `per_person`/`has_per_person` keep working for bundle quotes even though
    they are now itemized into one row per article (single-bundle detection
    replaces the old `items.length === 1` test).
- **No config-schema change** (the additions live in the quote `result`, not the
  persisted config) → **no migration** needed.
- **Non-goals:** no "pack discount" line, no re-pricing of historical quotes, no
  change to what the customer pays, no new dependencies.
