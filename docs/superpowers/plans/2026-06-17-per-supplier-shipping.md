# Per-Supplier Shipping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move shipping cost from the two GLOBAL parameters (`roly_shipping_eur_bundle`, `garments_per_bundle`) to PER-SUPPLIER fields (`shipping_eur_bundle`, `garments_per_bundle`; free = 0). In a quote, each supplier's shipping is prorated across only ITS garments. Works in both file and cloud (D1) storage.

**Architecture:** A coordinated schema evolution v4.0 → **v4.1**. `lib/config-schema.js` validates shipping on suppliers (not parameters). The pricing engine (`renderer/calculo.js`) groups order garments by each product's default supplier and prorates that supplier's bundle shipping over its own count. An idempotent `migrateConfigV4_0ToV4_1` moves the old global params into every supplier and drops the globals (runs on every config read; file mode backs up before writes). The cloud path gets an additive SQL migration (`db/migrations/0002…`) adding two supplier columns, with both directions of `lib/catalog-assembler.js` mapping them. The admin supplier editor gains the two fields (the wizard reuses it); the two global parameter inputs are removed.

**Tech Stack:** Electron; CommonJS in `lib/`/`main`, ESM in `renderer/`; Cloudflare D1 (SQL migrations); Vitest; pnpm. No new deps.

**Decision (from brainstorming):** Per-bundle cost per supplier, grouped by supplier (preserves the current Roly bundle model).

**Post-wizard reality (already merged to develop):** `config.default.js` is the empty scaffold exporting `SCHEMA_VERSION`, `PARAMETER_KEYS`, `buildEmptyConfig` (its `suppliers` is `{}`). The full catalog (incl. the ROLY supplier and the global shipping params) lives in `tests/fixtures/config-v4-full.js` (`buildFullConfigV4`), imported by many tests as `buildDefaultConfig` via alias.

---

## File structure

- Modify: `lib/config-schema.js` — drop shipping from `REQUIRED_PARAMETERS`; validate `shipping_eur_bundle`/`garments_per_bundle` on each supplier.
- Modify: `config.default.js` — drop the 2 shipping keys from `PARAMETER_KEYS`; bump `SCHEMA_VERSION` to `'4.1.0'`.
- Modify: `tests/fixtures/config-v4-full.js` — add shipping to ROLY; drop the 2 global params; `VERSION = '4.1.0'`.
- Modify: `renderer/calculo.js` — per-supplier shipping grouping; `calculateGarmentCost` takes a precomputed `shippingPerGarment`.
- Modify: `lib/migrations.js` — add `migrateConfigV4_0ToV4_1`; chain it in `migrateConfig`.
- Create: `db/migrations/0002_add_supplier_shipping.sql` — `ALTER TABLE suppliers ADD …`.
- Modify: `lib/catalog-assembler.js` — map the 2 supplier fields in `disassemble` + `assemble`.
- Modify: `renderer/admin.js` — supplier editor fields; `addSupplier` defaults; remove the 2 global parameter inputs.
- Modify: tests — `config-schema.test.js`, `config-default.test.js`, `calculo.test.js`, `migrations.test.js`, `catalog-assembler.test.js`, `cloud-catalog.test.js`.
- Modify: docs — `CLAUDE.md`, `ARCHITECTURE.md`, `PLAN_Calculadora.md`.

---

## Task 1 (FOUNDATION, coupled): schema + scaffold + fixture + engine

Shipping's location (parameters → suppliers) is referenced by the schema, the empty scaffold, the test fixture, AND the engine simultaneously — so they change together to keep the suite green. Migration of OLD configs is Task 2.

**Files:**
- Modify: `lib/config-schema.js`, `config.default.js`, `renderer/calculo.js`, `tests/fixtures/config-v4-full.js`
- Test: `tests/config-schema.test.js`, `tests/config-default.test.js`, `tests/calculo.test.js`

- [ ] **Step 1: Update the fixture** `tests/fixtures/config-v4-full.js`:
  - In its `PARAMETERS` object, DELETE the lines `roly_shipping_eur_bundle: 5.90,` and `garments_per_bundle: 40,`.
  - In its `SUPPLIERS` object, change `ROLY: { name: 'Roly', web: '', notes: '' }` to:
    ```js
    ROLY: { name: 'Roly', web: '', notes: '', shipping_eur_bundle: 5.90, garments_per_bundle: 40 }
    ```
  - Change `const VERSION = '4.0.0';` to `const VERSION = '4.1.0';`.

- [ ] **Step 2: Update `config.default.js`:**
  - In `PARAMETER_KEYS`, remove `'roly_shipping_eur_bundle'` and `'garments_per_bundle'` (leaving 14 keys).
  - Change `const SCHEMA_VERSION = '4.0.0';` to `const SCHEMA_VERSION = '4.1.0';`.

- [ ] **Step 3: Update `tests/config-default.test.js`** to the new expectations:
  - The version assertion `expect(SCHEMA_VERSION).toBe('4.0.0')` → `'4.1.0'`; and `cfg.version` `'4.0.0'` → `'4.1.0'`.
  - The "nulls every cost parameter" test still iterates `PARAMETER_KEYS` — no change needed, but ensure no test asserts the presence of the two removed keys. The "becomes valid once minimal data is added" test builds a minimal cfg: its `suppliers` must now include shipping, e.g. `cfg.suppliers = { SUP: { name: 'Prov', web: '', notes: '', shipping_eur_bundle: 0, garments_per_bundle: 40 } };` and its `cfg.parameters` no longer needs the two shipping keys (they're gone from PARAMETER_KEYS).

- [ ] **Step 4: Update `lib/config-schema.js`:**
  - In `REQUIRED_PARAMETERS` (around lines 22–39), remove `'roly_shipping_eur_bundle',` and `'garments_per_bundle',`.
  - In `validateParameters` (around lines 128–130), remove the `garments_per_bundle >= 1` check (those keys are no longer parameters).
  - In `validateSuppliers` (around lines 153–162), inside the per-supplier loop, after the `name` check add:
    ```js
    if (!Number.isFinite(supplier.shipping_eur_bundle) || supplier.shipping_eur_bundle < 0) {
      errors.push(`"${path}.shipping_eur_bundle" debe ser un número >= 0 (recibido: ${describe(supplier.shipping_eur_bundle)}).`);
    }
    if (!Number.isFinite(supplier.garments_per_bundle) || supplier.garments_per_bundle < 1) {
      errors.push(`"${path}.garments_per_bundle" debe ser un número >= 1 (recibido: ${describe(supplier.garments_per_bundle)}).`);
    }
    ```
    (`describe` is already used in this file.)

- [ ] **Step 5: Update `tests/config-schema.test.js`** — find tests that (a) assert the two shipping keys are required parameters (remove/repoint them), and (b) build a valid config: ensure their suppliers carry `shipping_eur_bundle`/`garments_per_bundle`. Add a focused test:
  ```js
  it('rejects a supplier without shipping fields', () => {
    const cfg = buildFullConfigV4();
    delete cfg.suppliers.ROLY.shipping_eur_bundle;
    const errs = collectErrors(cfg); // use this file's existing error-collecting helper
    expect(errs.some(e => /shipping_eur_bundle/.test(e))).toBe(true);
  });
  ```
  (Use the file's real helper for collecting validation errors — read the file; it may call `validateConfigSchema` in a try/catch or a `validateConfigShape`-style returner.)

- [ ] **Step 6: Update the engine `renderer/calculo.js`:**

  6a. Add a helper next to `defaultSupplierPrice` (around line 47):
  ```js
  /** Returns the default supplier id for a product (the is_default entry,
   *  or the first supplier as a fallback), or undefined. */
  function defaultSupplierId(product) {
    const suppliers = Array.isArray(product.suppliers) ? product.suppliers : [];
    const def = suppliers.find(s => s && s.is_default) || suppliers[0];
    return def ? def.supplier : undefined;
  }
  ```

  6b. Change `calculateGarmentCost` (lines 105–132) so the 5th parameter is the precomputed `shippingPerGarment` instead of `totalGarmentsForShipping`. Replace the signature + the shipping block:
  ```js
  export function calculateGarmentCost(cfg, productId, sides, tier, shippingPerGarment) {
    const product = cfg.products[productId];
    if (!product) {
      throw new Error(`Producto desconocido: ${productId}.`);
    }
    const p = cfg.parameters;

    const baseProduct = defaultSupplierPrice(product) || 0;
    const dtfMeters = (sides === 2) ? p.dtf_meters_two_sides : p.dtf_meters_one_side;
    const dtf = dtfMeters * p.dtf_eur_meter;
    const pressing = sides * p.pressing_eur_side;

    const ship = shippingPerGarment || 0;
    const subtotalPreWaste = baseProduct + ship + dtf + pressing;
    const waste = subtotalPreWaste * p.waste_pct;

    const baseMinutes = (sides === 2) ? p.minutes_two_sides_base : p.minutes_one_side_base;
    const realMinutes = baseMinutes * (1 - tier.time_reduction);
    const labor = (realMinutes / 60) * p.labor_eur_hour;

    const overhead = p.overhead_eur_garment;

    return {
      total: baseProduct + ship + dtf + pressing + waste + labor + overhead
    };
  }
  ```

  6c. In `calculatePack`, AFTER `lines` is built and validated (each line has `productId`+`quantity`) and BEFORE the cost loop (around line 363), compute per-supplier shipping:
  ```js
  // Per-supplier shipping: group the order's garments by each product's
  // default supplier, then prorate that supplier's bundle shipping across
  // only its own garments (ceil(n / garments_per_bundle) × eur_bundle / n).
  const garmentsBySupplier = {};
  for (const l of lines) {
    const supId = defaultSupplierId(cfg.products[l.productId]);
    garmentsBySupplier[supId] = (garmentsBySupplier[supId] || 0) + l.quantity;
  }
  const shippingPerGarmentBySupplier = {};
  for (const [supId, n] of Object.entries(garmentsBySupplier)) {
    const sup = (cfg.suppliers && cfg.suppliers[supId]) || {};
    const eurBundle = Number.isFinite(sup.shipping_eur_bundle) ? sup.shipping_eur_bundle : 0;
    const perBundle = Number.isFinite(sup.garments_per_bundle) ? sup.garments_per_bundle : 1;
    const bundles = Math.ceil(n / perBundle);
    shippingPerGarmentBySupplier[supId] = n > 0 ? (bundles * eurBundle) / n : 0;
  }
  ```
  Then in the cost loop (the `for (const l of lines)` that calls `calculateGarmentCost`, around line 365–367), pass the per-supplier shipping:
  ```js
  for (const l of lines) {
    const product = cfg.products[l.productId];
    const supId = defaultSupplierId(product);
    const shippingPerGarment = shippingPerGarmentBySupplier[supId] || 0;
    const unitCost = calculateGarmentCost(cfg, l.productId, sidesNum, tier, shippingPerGarment).total;
    garmentsCost += l.quantity * unitCost;
    if (Number.isFinite(product.extra_cost_3xl) && product.extra_cost_3xl > maxExtra3xl) {
      maxExtra3xl = product.extra_cost_3xl;
    }
  }
  ```

- [ ] **Step 7: Update `tests/calculo.test.js`** — the direct `calculateGarmentCost` test(s) now pass a precomputed `shippingPerGarment` (5th arg) instead of a garment count. For a single-supplier order of N garments with the ROLY fixture (5.90 €/bundle, 40/bundle), the expected per-garment shipping is `Math.ceil(N/40) * 5.90 / N`. Update each call + recompute the expected `total`. Also add an end-to-end check that an order is unchanged vs. the old global behavior when there's ONE supplier (the math is identical), e.g. assert a known pack total still matches the documented figure (the `PLAN_Calculadora.md` crew-pack case). READ the existing shipping-related assertions and update the numbers; do not weaken them.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS. If a test outside the listed files asserts `roly_shipping_eur_bundle`/`garments_per_bundle` as a parameter or the `4.0.0` version, update it to the new shape (grep `roly_shipping_eur_bundle`, `garments_per_bundle`, `'4.0.0'` across `tests/`).

- [ ] **Step 9: Commit**

```bash
git add lib/config-schema.js config.default.js renderer/calculo.js tests/fixtures/config-v4-full.js tests/config-schema.test.js tests/config-default.test.js tests/calculo.test.js
git commit -m "feat(shipping): per-supplier bundle shipping (schema+engine+fixture, v4.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Migration v4.0 → v4.1 (move global shipping into suppliers)

Real configs (customer #1's NAS file; provisioned D1) are v4.0 with global shipping. `migrateConfig` runs on every read — it must move shipping into suppliers idempotently.

**Files:**
- Modify: `lib/migrations.js`
- Test: `tests/migrations.test.js`

- [ ] **Step 1: Write the failing tests** — add to `tests/migrations.test.js`:
```js
const { migrateConfig, migrateConfigV4_0ToV4_1 } = require('../lib/migrations');

describe('v4.0 -> v4.1 (per-supplier shipping)', () => {
  function v40() {
    return {
      version: '4.0.0', admin: { password: 'x' },
      parameters: { vat: 0.21, roly_shipping_eur_bundle: 5.90, garments_per_bundle: 40 },
      suppliers: { ROLY: { name: 'Roly', web: '', notes: '' } },
      products: {}, tiers: [], addons: {}, packs: {}, company: {}, quote_settings: {}
    };
  }

  it('moves the global shipping params into every supplier and drops the globals', () => {
    const out = migrateConfigV4_0ToV4_1(v40());
    expect(out.version).toBe('4.1.0');
    expect(out.parameters.roly_shipping_eur_bundle).toBeUndefined();
    expect(out.parameters.garments_per_bundle).toBeUndefined();
    expect(out.suppliers.ROLY.shipping_eur_bundle).toBe(5.90);
    expect(out.suppliers.ROLY.garments_per_bundle).toBe(40);
  });

  it('is idempotent: a 4.1 config with no global shipping is returned unchanged', () => {
    const already = migrateConfigV4_0ToV4_1(v40());
    const again = migrateConfigV4_0ToV4_1(already);
    expect(again).toBe(already); // same reference, no re-write
  });

  it('migrateConfig chains v3->v4->v4.1', () => {
    const out = migrateConfig(v40());
    expect(out.version).toBe('4.1.0');
    expect(out.suppliers.ROLY.shipping_eur_bundle).toBe(5.90);
  });

  it('does not clobber a supplier that already carries shipping', () => {
    const cfg = v40();
    cfg.suppliers.ROLY.shipping_eur_bundle = 9.99;
    cfg.suppliers.ROLY.garments_per_bundle = 50;
    const out = migrateConfigV4_0ToV4_1(cfg);
    expect(out.suppliers.ROLY.shipping_eur_bundle).toBe(9.99);
    expect(out.suppliers.ROLY.garments_per_bundle).toBe(50);
  });
});
```
> Also UPDATE the existing "already v4 returns same reference" test in this file (if present): it must use a `version: '4.1.0'` config (a `4.0.0` config now gets migrated to a NEW object). And the existing `suppliers registry has ROLY` test (`expect(v4.suppliers.ROLY).toEqual({ name:'Roly', web:'', notes:'' })`) must now expect the shipping fields too: `{ name:'Roly', web:'', notes:'', shipping_eur_bundle: <old global>, garments_per_bundle: <old global> }` — confirm what the v3→v4 fixture's global shipping values are and use them.

- [ ] **Step 2: Run, watch fail**

Run: `pnpm vitest run tests/migrations.test.js`
Expected: FAIL — `migrateConfigV4_0ToV4_1` undefined.

- [ ] **Step 3: Implement in `lib/migrations.js`:**
  Add the function (near `migrateConfigV3ToV4`):
  ```js
  /**
   * v4.0 -> v4.1: shipping moves from the global parameters into each
   * supplier. Idempotent: a 4.1 config with no leftover global shipping is
   * returned unchanged (same reference). A supplier that already carries
   * shipping is not overwritten.
   */
  function migrateConfigV4_0ToV4_1(cfg) {
    const params = isPlainObject(cfg.parameters) ? cfg.parameters : {};
    const hasGlobalShipping = params.roly_shipping_eur_bundle !== undefined
                           || params.garments_per_bundle !== undefined;
    const isPre41 = typeof cfg.version === 'string' && /^4\.0\./.test(cfg.version);
    if (!hasGlobalShipping && !isPre41) return cfg; // already migrated

    const eurBundle = Number.isFinite(params.roly_shipping_eur_bundle) ? params.roly_shipping_eur_bundle : 0;
    const garmentsPerBundle = Number.isFinite(params.garments_per_bundle) ? params.garments_per_bundle : 40;

    const newParams = { ...params };
    delete newParams.roly_shipping_eur_bundle;
    delete newParams.garments_per_bundle;

    const suppliers = {};
    for (const [id, s] of Object.entries(isPlainObject(cfg.suppliers) ? cfg.suppliers : {})) {
      suppliers[id] = {
        ...s,
        shipping_eur_bundle: Number.isFinite(s.shipping_eur_bundle) ? s.shipping_eur_bundle : eurBundle,
        garments_per_bundle: Number.isFinite(s.garments_per_bundle) ? s.garments_per_bundle : garmentsPerBundle
      };
    }
    return { ...cfg, version: '4.1.0', parameters: newParams, suppliers };
  }
  ```
  Change `migrateConfig` to chain it (replace the early `if (/^4\./…) return raw;`):
  ```js
  function migrateConfig(raw) {
    if (!isPlainObject(raw)) {
      throw new Error('Config inválido: se esperaba un objeto.');
    }
    let v4;
    if (typeof raw.version === 'string' && /^4\./.test(raw.version)) {
      v4 = raw;
    } else {
      const v3 = (typeof raw.version === 'string' && /^3\./.test(raw.version))
        ? raw
        : mapConfigV2ToV3(raw);
      v4 = migrateConfigV3ToV4(v3);
    }
    return migrateConfigV4_0ToV4_1(v4);
  }
  ```
  Export `migrateConfigV4_0ToV4_1` in `module.exports`.

- [ ] **Step 4: Run the suite** — `pnpm test` → green (update any other test that assumed `migrateConfig` of a 4.0 config returns it unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/migrations.js tests/migrations.test.js
git commit -m "feat(migrations): v4.0->v4.1 moves global shipping into suppliers (idempotent)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Cloud — SQL migration + assembler mapping

**Files:**
- Create: `db/migrations/0002_add_supplier_shipping.sql`
- Modify: `lib/catalog-assembler.js`
- Test: `tests/catalog-assembler.test.js`, `tests/cloud-catalog.test.js`

- [ ] **Step 1: Create the additive SQL migration** `db/migrations/0002_add_supplier_shipping.sql`:
```sql
-- v4.1: shipping moves from global parameters to per-supplier fields.
-- Additive columns on the suppliers table (nullable; the app fills them).
ALTER TABLE suppliers ADD COLUMN shipping_eur_bundle REAL;
ALTER TABLE suppliers ADD COLUMN garments_per_bundle INTEGER;
```
> Match the exact header/comment style of `db/migrations/0001_init.sql`. The migration runner applies files in numeric order via the `schema_migrations` ledger, so existing provisioned DBs pick up `0002` on next provision/load (additive, with the bootstrap's pre-migration backup).

- [ ] **Step 2: Write the failing assembler test** — in `tests/catalog-assembler.test.js`, the round-trip test (`assemble(disassemble(cfg))`) now uses the fixture whose ROLY carries shipping (from Task 1), so it should already exercise the fields once the assembler maps them. Add an explicit assertion + update the manual entity test:
  - Update the manual `suppliers:` row (around lines 110–112) to include the new columns:
    ```js
    suppliers: [{ id: 'sup1', name: 'Proveedor', web: null, notes: null, shipping_eur_bundle: 5.9, garments_per_bundle: 40 }],
    ```
  - Add:
    ```js
    test('round-trips supplier shipping fields', () => {
      const cfg = buildFullConfigV4();
      const rebuilt = assemble(disassemble(cfg), { /* same opts the existing round-trip test passes */ });
      expect(rebuilt.suppliers.ROLY.shipping_eur_bundle).toBe(cfg.suppliers.ROLY.shipping_eur_bundle);
      expect(rebuilt.suppliers.ROLY.garments_per_bundle).toBe(cfg.suppliers.ROLY.garments_per_bundle);
    });
    ```
    (Reuse the exact options object the existing round-trip test passes to `assemble`.)

- [ ] **Step 3: Run, watch fail** — `pnpm vitest run tests/catalog-assembler.test.js` → FAIL (shipping fields dropped by the assembler).

- [ ] **Step 4: Update `lib/catalog-assembler.js`:**
  - In `disassemble` (supplier map, ~lines 46–48):
    ```js
    const suppliers = Object.entries(cfg.suppliers).map(([id, s]) => ({
      id, name: s.name, web: s.web ?? null, notes: s.notes ?? null,
      shipping_eur_bundle: s.shipping_eur_bundle ?? null,
      garments_per_bundle: s.garments_per_bundle ?? null
    }));
    ```
  - In `assemble` (supplier reconstruction, ~lines 177–180):
    ```js
    const suppliers = {};
    for (const s of entities.suppliers) {
      suppliers[s.id] = {
        name: s.name,
        ...(s.web != null && { web: s.web }),
        ...(s.notes != null && { notes: s.notes }),
        ...(s.shipping_eur_bundle != null && { shipping_eur_bundle: s.shipping_eur_bundle }),
        ...(s.garments_per_bundle != null && { garments_per_bundle: s.garments_per_bundle })
      };
    }
    ```

- [ ] **Step 5: Confirm the cloud read selects the new columns.** Read `lib/cloud-catalog.js` (the fetch/read path that builds `entities.suppliers`). If it uses `SELECT *` the columns flow automatically; if it lists columns explicitly for suppliers, add `shipping_eur_bundle, garments_per_bundle`. `seedCatalog` infers columns from row keys, so once `disassemble` emits them the seed INSERT includes them — confirm `tests/cloud-catalog.test.js`'s seed assertion still passes (it compares inserted rows to `entities`).

- [ ] **Step 6: Run the suite** — `pnpm test` → green.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0002_add_supplier_shipping.sql lib/catalog-assembler.js tests/catalog-assembler.test.js tests/cloud-catalog.test.js
git commit -m "feat(cloud): supplier shipping columns + assembler mapping (v4.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Admin UI — supplier editor fields, add-supplier defaults, remove global params

**Files:**
- Modify: `renderer/admin.js`

The wizard reuses these renderers, so this also updates the first-run Proveedores step.

- [ ] **Step 1: Supplier editor fields.** In `renderSupplierEditor` (around lines 261–276), add two number inputs inside the `<div class="admin-grid">`, after Notas:
```js
      <label>Envío · €/bulto
        <input type="number" step="0.01" min="0" value="${esc(s.shipping_eur_bundle ?? '')}" data-cfg-path="suppliers.${esc(id)}.shipping_eur_bundle">
      </label>
      <label>Prendas por bulto
        <input type="number" step="1" min="1" value="${esc(s.garments_per_bundle ?? '')}" data-cfg-path="suppliers.${esc(id)}.garments_per_bundle">
      </label>
```

- [ ] **Step 2: `addSupplier` defaults.** Find the add-supplier creator (the function `executeAdminAction` routes `'add-supplier'` to — grep `add-supplier` / `addSupplier` in `renderer/admin.js`). Ensure a newly created supplier includes the shipping fields so it's schema-valid, e.g.:
```js
  cfg.suppliers[id] = { name: '', web: '', notes: '', shipping_eur_bundle: 0, garments_per_bundle: 40 };
```
(Match the existing object shape it created; just add the two fields.)

- [ ] **Step 3: Remove the global parameter inputs.** In `PARAMETER_GROUPS` (around lines 54–59), DELETE the two items `{ key: 'roly_shipping_eur_bundle', … }` and `{ key: 'garments_per_bundle', … }`. Rename the group title `'Tiempos y envío'` → `'Tiempos'` (envío now lives per supplier).

- [ ] **Step 4: Verify** — `node --check renderer/admin.js` (ESM) and `pnpm test` → green.

- [ ] **Step 5: Manual smoke (real machine)** — `pnpm dev`: in the admin supplier editor (and the wizard Proveedores step) the two shipping fields appear; a new supplier starts at 0 €/bulto, 40/bulto; the global "Envío proveedor (€/bulto)" / "Prendas por bulto" inputs are gone from Parameters. A quote with one supplier yields the same totals as before; a quote mixing two suppliers prorates each supplier's shipping over its own garments.

- [ ] **Step 6: Commit**

```bash
git add renderer/admin.js
git commit -m "feat(admin): per-supplier shipping fields; drop global shipping params

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`, `ARCHITECTURE.md`, `PLAN_Calculadora.md`

- [ ] **Step 1: CLAUDE.md** — add a 2026-06-17 documented debate: shipping moves from global parameters to per-supplier (`shipping_eur_bundle`/`garments_per_bundle`), schema v4.0 → v4.1 with an idempotent `migrateConfigV4_0ToV4_1` + additive cloud migration `0002`; proration is per-supplier (bundle model preserved). Note the schema-version bump to 4.1.0.

- [ ] **Step 2: ARCHITECTURE.md** — update the config-shape/§6 supplier description (suppliers now carry shipping), the calculation section (per-supplier shipping proration in `calculatePack`; `calculateGarmentCost`'s 5th arg is now `shippingPerGarment`), the migration list (add v4.0→v4.1), and the cloud schema note (suppliers columns + migration 0002).

- [ ] **Step 3: PLAN_Calculadora.md** — in §2.1 (parameters) and §4.2 (real garment cost), state that shipping is per-supplier now (each supplier's `€/bulto` + `prendas/bulto`), prorated across that supplier's garments; remove the implication of a single global Roly shipping. Update the `envío_prorrateado` formula to be per-supplier.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md PLAN_Calculadora.md
git commit -m "docs: per-supplier shipping (schema v4.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Definition of done
- `pnpm test` green across all changed modules (schema, engine, migration, assembler, cloud).
- File + cloud both carry shipping on suppliers; a real v4.0 config (file or D1) migrates idempotently to v4.1 on read, with shipping moved into every supplier and the globals removed.
- A single-supplier order reproduces the previous totals; a mixed-supplier order prorates each supplier's bundle shipping over its own garments.
- Admin + wizard show the two supplier fields; the global shipping inputs are gone.
- Hard rules: schema change ships with backup + idempotent migration (§5) and tests (§7); no new deps (§9); no domain numbers added to code (shipping values live in config).
- GUI smoke (mixed-supplier quote) verified on a real machine — cannot be run in the sandbox.
```
