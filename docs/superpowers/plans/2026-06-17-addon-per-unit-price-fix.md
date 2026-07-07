# Addon Per-Unit Price Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The headline per-unit price ("PVP por pack" / "PVP medio") must include the chosen addons (complementos) per unit, IVA included, so it reflects what the customer actually pays per person — not just the base pack price.

**Architecture:** The pure pricing engine (`renderer/calculo.js`) already folds addons into `total_vat_inc` but not into the per-unit headline. We add two derived fields to the result — `extras_vat_inc` (addon subtotal, IVA inc) and `unit_price_with_extras` (base per-unit + addons per-unit) — computed and unit-tested in the engine. The renderer then displays `unit_price_with_extras` in the two headline spots. The line-item `unit_price` (used in the breakdown and the PDF) is **unchanged**; 4XL/5XL surcharges stay a separate line.

**Tech Stack:** Vanilla JS (ESM renderer), Vitest, pnpm. No new deps.

**Decision (from brainstorming):** "PVP base + complementos/ud" — the headline shows base + addons per unit (IVA inc); size surcharges remain separate.

---

## File structure

- Modify: `renderer/calculo.js` — add `extras_vat_inc` + `unit_price_with_extras` to the `calculatePack` result.
- Modify: `renderer/app.js` — use `unit_price_with_extras` in the two headline spots (preview meta + result hero stat).
- Test: `tests/calculo.test.js` — assert the two new fields for a bundle pack and a components pack with addons.

---

## Task 1: Engine — expose `extras_vat_inc` and `unit_price_with_extras`

**Files:**
- Modify: `renderer/calculo.js` (in `calculatePack`, near the final `return {...}` around lines 388–418)
- Test: `tests/calculo.test.js`

- [ ] **Step 1: Write the failing tests** — add to `tests/calculo.test.js` (use the existing imports/fixture in that file; it already imports `calculatePack` and builds a `cfg`). Append this `describe` block:

```js
describe('addons reflected in the per-unit headline', () => {
  // Reuse the same cfg builder the other calculo tests use in this file.
  // (If the file exposes a helper like `makeConfig()` / a shared `cfg`, use it;
  //  otherwise import buildFullConfigV4 from the fixture as the other tests do.)
  it('bundle pack: extras_vat_inc and unit_price_with_extras include the addon per pack', () => {
    const cfg = buildFullConfigV4();
    // A bundle pack id present in the catalog (the crew pack). Confirm the id
    // by reading cfg.packs; the seed uses 'pena'.
    const packId = 'pena';
    const anyAddonId = Object.keys(cfg.addons)[0];
    const vat = cfg.parameters.vat;
    const addon = cfg.addons[anyAddonId];

    const base = calculatePack(cfg, packId, {
      options: bundleOptionsFor(cfg, packId), packs: 10
    });
    const withAddon = calculatePack(cfg, packId, {
      options: bundleOptionsFor(cfg, packId), packs: 10,
      addons: { [anyAddonId]: 10 }   // one addon unit per pack
    });

    expect(base.extras_vat_inc).toBe(0);
    // unit_price_with_extras == unit_price when there are no addons
    expect(base.unit_price_with_extras).toBeCloseTo(base.unit_price, 2);

    // Addon contributes price*(1+vat) per pack (unless vat_included).
    const perPackInc = addon.vat_included ? addon.price : addon.price * (1 + vat);
    expect(withAddon.extras_vat_inc).toBeCloseTo(10 * perPackInc, 2);
    expect(withAddon.unit_price_with_extras)
      .toBeCloseTo(withAddon.unit_price + perPackInc, 2);
  });

  it('components pack: unit_price_with_extras is the all-in average per garment', () => {
    const cfg = buildFullConfigV4();
    const packId = 'shirts';        // single-component "solo camisetas" pack (confirm id in cfg.packs)
    const anyAddonId = Object.keys(cfg.addons)[0];
    const r = calculatePack(cfg, packId, {
      options: bundleOptionsFor(cfg, packId),
      quantities: componentsQtyFor(cfg, packId, 10),
      addons: { [anyAddonId]: 10 }
    });
    // all-in average == (subtotal + extras_vat_inc) / units
    expect(r.unit_price_with_extras)
      .toBeCloseTo((r.subtotal + r.extras_vat_inc) / r.total_quantity, 2);
    expect(r.extras_vat_inc).toBeGreaterThan(0);
  });
});
```

> **Before writing, READ `tests/calculo.test.js`** to learn how the existing pack tests build options/quantities (they already call `calculatePack` for bundle and components packs — reuse their exact pattern for `options`, `packs`, and `quantities`). Replace the helper placeholders `bundleOptionsFor` / `componentsQtyFor` and the pack ids (`pena`, `shirts`) with the REAL option maps and ids those existing tests use. Do NOT invent a new fixture — mirror the nearest existing pack test. The assertions on `extras_vat_inc` / `unit_price_with_extras` are the new behavior.

- [ ] **Step 2: Run the tests, watch them fail**

Run: `pnpm vitest run tests/calculo.test.js`
Expected: FAIL — `extras_vat_inc` / `unit_price_with_extras` are `undefined`.

- [ ] **Step 3: Add the fields in `renderer/calculo.js`**

In `calculatePack`, after `const addons = calculateAddons(cfg, o.addons);` and after `subtotal`/`topUnitPrice` are final (just before the big `return {`), compute:

```js
  // Per-unit headline including addons (IVA inc). The base per unit is the
  // bundle price per pack, or the average garment PVP for components. Size
  // surcharges (4XL/5XL) are NOT folded in here — they stay a separate line.
  const extrasVatInc = addons.vat_inc;
  const unitsForExtras = (pack.pricing_mode === 'bundle') ? packsN : total;
  const baseUnit = (pack.pricing_mode === 'bundle') ? topUnitPrice : (subtotal / total);
  const unitPriceWithExtras = baseUnit + (unitsForExtras > 0 ? extrasVatInc / unitsForExtras : 0);
```

Then add these two keys to the returned object (next to the existing `extras_no_vat` / `unit_price`):

```js
    extras_vat_inc: extrasVatInc,
    unit_price_with_extras: unitPriceWithExtras,
```

> `packsN`, `total`, `topUnitPrice`, `subtotal`, and `pack` are all already in scope at the return point. `packsN` is 0 for components packs — the `unitsForExtras = total` branch handles that.

- [ ] **Step 4: Run the tests, watch them pass**

Run: `pnpm vitest run tests/calculo.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS (no other test asserts the absence of these new keys).

- [ ] **Step 6: Commit**

```bash
git add renderer/calculo.js tests/calculo.test.js
git commit -m "feat(calculo): expose extras_vat_inc + unit_price_with_extras (addons in per-unit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Renderer — show addons in the per-unit headline

**Files:**
- Modify: `renderer/app.js` — the preview meta line (around lines 1872–1875) and the result-hero stat (around lines 2038–2043).

There is no renderer unit-test harness for the hero in this repo; correctness of the math is covered by Task 1. This task is a focused display swap + a manual smoke.

- [ ] **Step 1: Update the preview "meta" line** (around lines 1872–1875). Replace:

```js
  const priceText = (r.pricing_mode === 'bundle')
    ? `${r.breakdown[0] ? r.breakdown[0].quantity : 0} packs × ${formatEur(r.unit_price)}`
    : (r.unit_price > 0 ? `${quantity} × ${formatEur(r.unit_price)}` : `${quantity} prendas`);
```
with:

```js
  // Per-unit headline includes the chosen addons (unit_price_with_extras).
  // Multi-line components packs (unit_price === 0) keep the bare count.
  const priceText = (r.pricing_mode === 'bundle')
    ? `${r.breakdown[0] ? r.breakdown[0].quantity : 0} packs × ${formatEur(r.unit_price_with_extras)}`
    : (r.unit_price > 0 ? `${quantity} × ${formatEur(r.unit_price_with_extras)}` : `${quantity} prendas`);
```

- [ ] **Step 2: Update the result-hero stat** (around lines 2038–2043). Replace:

```js
  const packsCount = isBundle && r.breakdown[0] ? r.breakdown[0].quantity : quantity;
  const pricePerPack = isBundle
    ? formatEur(r.unit_price)
    : formatEur(r.subtotal / Math.max(1, quantity));
  const quantityLabel = isBundle ? 'Packs' : 'Prendas';
  const priceLabel = isBundle ? 'PVP por pack' : 'PVP medio';
```
with:

```js
  const packsCount = isBundle && r.breakdown[0] ? r.breakdown[0].quantity : quantity;
  // All-in per unit (base + complementos/ud, IVA inc). Engine field; size
  // surcharges stay a separate line.
  const pricePerPack = formatEur(r.unit_price_with_extras);
  const quantityLabel = isBundle ? 'Packs' : 'Prendas';
  const hasExtras = r.extras_vat_inc > 0;
  const priceLabel = (isBundle ? 'PVP por pack' : 'PVP medio') + (hasExtras ? ' (con extras)' : '');
```

- [ ] **Step 3: Sanity-check syntax + suite**

Run: `node --check renderer/app.js` (use `--input-type=module` if needed) and `pnpm test`.
Expected: both OK / green.

- [ ] **Step 4: Manual smoke (real machine — GUI can't launch in the sandbox)**

`pnpm dev`. Build/select a pack (e.g. crew pack, 10 packs). Note the "PVP por pack". Add a complemento priced 1,50 € (sin IVA) with quantity = packs. Expected: the "PVP por pack" rises by ~1,82 € (1,50 × 1,21) and the label shows "(con extras)"; the "Total a facturar" matches. Without addons, the figure equals the base (no "(con extras)").

- [ ] **Step 5: Commit**

```bash
git add renderer/app.js
git commit -m "fix(ui): per-unit headline includes complementos (PVP base + extras/ud)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Definition of done
- `pnpm test` green, with the two new engine assertions.
- Adding a complemento moves the "PVP por pack"/"PVP medio" headline (IVA inc), labelled "(con extras)"; the total still reconciles.
- `unit_price` (line items / PDF) and the 4XL/5XL surcharge line are unchanged.
- No new deps; minimal diff.
