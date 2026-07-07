# Per-Field Help Descriptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a short curated explanation under each catalog field (what it is + how to calculate it), so a non-expert can fill the admin editor and the first-run wizard. Long texts are truncated with "…" and the full text shows on mouse hover.

**Architecture:** A new pure ESM module `renderer/field-help.js` holds a Spanish help dictionary keyed by field name. The admin editor render functions (`renderer/admin.js`) — which the wizard reuses verbatim — render the help as a `<small class="field__hint field__hint--clamp" title="<full>">…</small>` under each relevant field. A CSS class clamps it to 2 lines with an ellipsis; the native `title` attribute provides the full-text hover tooltip (zero JS). No schema change.

**Tech Stack:** Vanilla JS (ESM renderer), CSS, Vitest, pnpm. No new deps.

**Decision (from brainstorming):** Curated help in code (not a user-editable field). Visible, clamped to ~2 lines with "…", full text on hover via native `title`.

---

## File structure

- Create: `renderer/field-help.js` — `FIELD_HELP` map + `fieldHelp(key)` (pure, testable).
- Create: `tests/field-help.test.js` — coverage of key fields + unknown-key behavior.
- Modify: `renderer/admin.js` — import `fieldHelp`; add a local `helpHint(key)` markup helper; inject under fields in the parameter/product/supplier/addon/tier/pack renderers.
- Modify: `renderer/styles.css` — `.field__hint--clamp` (2-line ellipsis + `cursor: help`).

---

## Task 1: `renderer/field-help.js` — curated help dictionary

**Files:**
- Create: `renderer/field-help.js`
- Test: `tests/field-help.test.js`

- [ ] **Step 1: Write the failing test** (`tests/field-help.test.js`)

```js
import { describe, it, expect } from 'vitest';
import { fieldHelp, FIELD_HELP } from '../renderer/field-help.js';

describe('field-help', () => {
  it('returns help text for the cost fields a non-expert needs', () => {
    for (const key of ['extra_cost_3xl', 'waste_pct', 'dtf_eur_meter',
                       'dtf_meters_one_side', 'dtf_meters_two_sides',
                       'default_target_margin', 'time_reduction', 'vat_included']) {
      expect(typeof fieldHelp(key)).toBe('string');
      expect(fieldHelp(key).length).toBeGreaterThan(10);
    }
  });

  it('returns empty string for unknown keys', () => {
    expect(fieldHelp('no_such_field')).toBe('');
    expect(fieldHelp(undefined)).toBe('');
  });

  it('every help entry is a non-empty plain string (no HTML tags)', () => {
    for (const [key, text] of Object.entries(FIELD_HELP)) {
      expect(text, key).toBeTypeOf('string');
      expect(text.trim().length, key).toBeGreaterThan(0);
      expect(text.includes('<'), key).toBe(false); // rendered via textContent/esc, keep it plain
    }
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm vitest run tests/field-help.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `renderer/field-help.js`**

```js
// ============================================================
// Quanto - Curated field help (what each field is + how to set it)
// ============================================================
// Pure ESM module: a Spanish help dictionary keyed by field name, used by
// the admin editor (and the first-run wizard, which reuses those renderers)
// to show a short explanation under each field. Plain strings only — the
// renderer escapes them and clamps the display with CSS; the full text shows
// on hover via the native `title` attribute.
// ============================================================

export const FIELD_HELP = {
  // --- Cost parameters ---
  labor_eur_hour:        'Tarifa interna de mano de obra por hora y persona. No es el sueldo: es el coste real que imputas a una hora de trabajo.',
  vat:                   'Tipo de IVA aplicado al precio de venta. 0,21 = 21%.',
  waste_pct:             'Porcentaje de material que se pierde (mermas, fallos de impresión). 0,10 = 10%. Estímalo registrando prendas perdidas en tus primeros pedidos.',
  overhead_eur_garment:  'Costes indirectos imputados a cada prenda (luz, mantenimiento, packaging). Reparte tus gastos fijos mensuales entre las prendas que produces.',
  surcharge_4xl_eur:     'Recargo que SÍ se factura al cliente por cada prenda en talla 4XL.',
  surcharge_5xl_eur:     'Recargo que SÍ se factura al cliente por cada prenda en talla 5XL o superior.',
  dtf_eur_meter:         'Coste del metro lineal de film DTF (película + tinta). Sácalo de la factura de tu consumible dividido entre los metros del rollo.',
  dtf_meters_one_side:   'Metros de film que consume de media una prenda estampada a 1 cara. Es un promedio (el nesting lo estabiliza); mídelo con tu consumo real.',
  dtf_meters_two_sides:  'Metros de film que consume de media una prenda estampada a 2 caras. Es un promedio; mídelo con tu consumo real.',
  pressing_eur_side:     'Coste de planchar una cara (energía + desgaste de la plancha). Multiplícalo por el nº de caras.',
  minutes_two_sides_base:'Minutos de mano de obra por prenda a 2 caras, antes de aplicar la reducción por volumen del tramo.',
  minutes_one_side_base: 'Minutos de mano de obra por prenda a 1 cara, antes de aplicar la reducción por volumen del tramo.',
  default_target_margin: 'Margen objetivo por defecto para el PVP recomendado. 0,35 = 35% sobre el precio de venta.',
  price_rounding_ending: 'Terminación psicológica del PVP recomendado. 0,95 redondea hacia arriba al siguiente importe acabado en ,95.',

  // --- Product ---
  extra_cost_3xl:        'Coste interno extra que te cobra el proveedor por una prenda 3XL frente a la talla base. NO se factura al cliente; se usa para no perder margen. Es la diferencia (precio 3XL − precio base) de la tarifa del proveedor.',
  target_margin:         'Margen objetivo de este elemento para el PVP recomendado. 0,35 = 35% sobre el precio de venta.',
  supplier_price:        'Precio de compra unitario que te cobra el proveedor por esta prenda (sin IVA).',
  supplier_min_order:    'Pedido mínimo del proveedor para este producto. Informativo.',

  // --- Addon ---
  addon_price:           'Precio que cobras al cliente por cada unidad del complemento.',
  addon_cost:            'Coste interno real del complemento, para que el margen sea honesto.',
  vat_included:          'Marca esta casilla si el precio del complemento YA incluye IVA. Si no, se le añadirá el IVA.',
  applies_to:            'Categorías de producto a las que se puede añadir este complemento (o * para todas).',

  // --- Tier ---
  tier_from:             'Cantidad mínima de unidades para entrar en este tramo de volumen.',
  tier_to:              'Cantidad máxima del tramo. Déjalo vacío en el último tramo para "sin límite superior".',
  time_reduction:        'Reducción del tiempo de fabricación por prenda en este tramo (mejor ritmo y nesting). 0,15 = 15% menos de tiempo.',

  // --- Pack ---
  min_total:             'Unidades mínimas del pedido para poder usar este pack.',
  pricing_mode:          '"bundle": el pack se vende como una unidad con su propia tabla de PVP. "components": cada componente se factura a su propio PVP y el tramo se calcula sobre el total.'
};

/** Returns the help string for a field key, or '' when there is none. */
export function fieldHelp(key) {
  return (key && FIELD_HELP[key]) || '';
}
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `pnpm vitest run tests/field-help.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/field-help.js tests/field-help.test.js
git commit -m "feat(help): curated per-field help dictionary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: CSS — clamp class

**Files:**
- Modify: `renderer/styles.css`

- [ ] **Step 1: Add the clamp style.** Place it next to the existing `.field__hint` / `.hint` rules (grep for `field__hint` to find them). Add:

```css
/* Curated field help: visible but clamped to 2 lines with "…"; the full
   text shows on hover via the native title tooltip (set in admin.js). */
.field__hint--clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: help;
}
```

> Electron is Chromium, so `-webkit-line-clamp` works natively. If a `.field__hint` base class doesn't exist yet, also add a minimal base (`.field__hint { display:block; font-size:12px; color: var(--fg-secondary, #5A6478); margin-top:4px; }`) — but FIRST grep; the codebase already uses `field__hint` (e.g. `renderer/app.js:1665`) and a `.hint` class, so reuse the existing look and only ADD the `--clamp` modifier.

- [ ] **Step 2: Sanity** — `pnpm test` stays green (CSS not loaded by tests). Brace-balance check the added block.

- [ ] **Step 3: Commit**

```bash
git add renderer/styles.css
git commit -m "style(help): 2-line clamp for field help hints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire help into the admin editor renderers

**Files:**
- Modify: `renderer/admin.js`

`admin.js` already exports `esc` and renders fields as `<label>…<input data-cfg-path></label>`. The wizard reuses these renderers, so this lights up help in both places at once.

- [ ] **Step 1: Import + helper.** Near the top imports of `renderer/admin.js`, add:

```js
import { fieldHelp } from './field-help.js';
```
Then add a small markup helper (next to the existing `esc`/helpers):

```js
/** Renders the curated help for a field key as a clamped hint, or '' if none.
 *  The full text lives in the `title` for the hover tooltip. */
function helpHint(key) {
  const text = fieldHelp(key);
  if (!text) return '';
  return `<small class="field__hint field__hint--clamp" title="${esc(text)}">${esc(text)}</small>`;
}
```

- [ ] **Step 2: Parameters** — in `renderAdminParameters` (around lines 187–209), inside the per-item loop, append `${helpHint(it.key)}` to each field's `<label>` (after the `<input>`). The loop key is `it.key`, which already matches the help dictionary keys (`waste_pct`, `dtf_eur_meter`, …):

```js
      html += `
        <label>${esc(it.label)}${it.hint ? ` <span class="hint">${esc(it.hint)}</span>` : ''}
          <input type="number"${stepAttr}${minAttr}${maxAttr} value="${esc(valueAttr)}" data-cfg-path="parameters.${esc(it.key)}">
          ${helpHint(it.key)}
        </label>
      `;
```

- [ ] **Step 3: Product editor** — in `renderProductEditor` (around line 327), add hints to the fields. READ the function to find each field's `<label>`, then append:
  - the `extra_cost_3xl` field → `${helpHint('extra_cost_3xl')}`
  - the `target_margin` field → `${helpHint('target_margin')}`
  - each supplier's price input → `${helpHint('supplier_price')}`
  - each supplier's `min_order` input → `${helpHint('supplier_min_order')}`

- [ ] **Step 4: Addon editor** — in `renderAddonEditor` (around line 504), append:
  - price field → `${helpHint('addon_price')}`
  - cost field → `${helpHint('addon_cost')}`
  - the `vat_included` checkbox label → `${helpHint('vat_included')}`
  - the "Aplica a" section → `${helpHint('applies_to')}`

- [ ] **Step 5: Tier editor** — in `renderAdminTiers` (around line 545), append:
  - the `from` input → `${helpHint('tier_from')}`
  - the `to` input → `${helpHint('tier_to')}`
  - the `time_reduction` input → `${helpHint('time_reduction')}`

- [ ] **Step 6: Pack editor** — in `renderPackEditor` (around line 640), append:
  - the `min_total` field → `${helpHint('min_total')}`
  - the `target_margin` field → `${helpHint('target_margin')}`
  - the `pricing_mode` select → `${helpHint('pricing_mode')}`

> For each, only ADD the `${helpHint('<key>')}` call inside the relevant existing `<label>` (or right after it). Do not restructure the markup. If a field uses a structure where a `<small>` inside `<label>` would break layout, place the hint immediately after the closing `</label>` instead — the CSS works either way.

- [ ] **Step 7: Verify**

Run: `node --check renderer/admin.js` (ESM) and `pnpm test` → green. The wizard reuses these renderers, so no separate wizard change is needed.

- [ ] **Step 8: Manual smoke (real machine)**

`pnpm dev` → open the admin editor (and the first-run wizard). Each annotated field shows a short help line; long ones end in "…" and reveal the full text on hover.

- [ ] **Step 9: Commit**

```bash
git add renderer/admin.js
git commit -m "feat(help): show curated field help in admin editor + wizard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Out of scope (YAGNI)
- A styled (branded) tooltip instead of native `title` — note as a future tweak; the dictionary doesn't change if we upgrade later.
- JS that sets `title` only when the text is actually truncated (`scrollHeight > clientHeight`). The always-on `title` is acceptable per the brainstorming decision.
- A user-editable `description` schema field (explicitly rejected in favor of curated help).

## Definition of done
- `pnpm test` green incl. `field-help.test.js`.
- Help text appears under the annotated fields in BOTH the admin editor and the first-run wizard, clamped to 2 lines with "…", full text on hover.
- No schema change; no new deps.
