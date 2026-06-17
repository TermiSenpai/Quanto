# First-Run Catalog Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the default-catalog seeding on first run with a dedicated, step-by-step wizard where the user builds the whole catalog from blank (costs → tiers → suppliers → products → packs → addons → company), in both file and cloud modes.

**Architecture:** A new renderer module (`renderer/catalog-wizard.js`) drives an ordered set of steps that **reuse the existing admin editor render/mutation functions** (`renderAdminTabContent`, `updateConfigFromInput`, `executeAdminAction` in `renderer/admin.js`). The wizard starts from an empty-but-schema-shaped config fetched from main (`config:empty`), gates each step on per-step minimum checks (`renderer/wizard-validation.js`), and persists only at the end — file mode writes the assembled config atomically (`config:create`), cloud mode seeds D1 from it (`catalog:seed-initial`). `buildDefaultConfig()` and the seeded business constants are removed; `config.default.js` now exports only `SCHEMA_VERSION` and `buildEmptyConfig()`.

**Tech Stack:** Electron (main = Node, renderer = vanilla JS/HTML/CSS, no framework), CommonJS in `lib/`+main, ES modules in `renderer/`, Vitest tests, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-16-first-run-catalog-wizard-design.md`

---

## File structure

**Created:**
- `renderer/wizard-validation.js` — pure per-step minimum checks. **Renderer ESM module** (the wizard runs in the renderer, which can only `import` ESM peers — it cannot `require` `lib/` CommonJS). Self-contained: derives parameter keys from `Object.keys(cfg.parameters)`, no `config.default.js` import.
- `renderer/catalog-wizard.js` — ESM: the wizard stepper, reuse glue, persistence.
- `tests/wizard-validation.test.js` — unit tests for the validators (ESM import, like `tests/calculo.test.js`).
- `tests/fixtures/config-v4-full.js` — the former default catalog, kept as a TEST fixture (`buildFullConfigV4()`), so tests still have a complete v4 catalog after the product loses its default.

**Renderer module convention (verified):** `index.html` loads only `<script type="module" src="app.js">`; every other renderer file (`admin.js`, `calculo.js`, `format.js`, …) is an ESM `import`ed from there. `admin.js` already `export`s `renderAdminTabContent`, `updateConfigFromInput`, and `executeAdminAction` (no change needed). New renderer files must use `export`/`import` and be reached via an `import` in `app.js`, NOT a new `<script>` tag.

**Modified:**
- `config.default.js` — drop `buildDefaultConfig` + business constants; add `SCHEMA_VERSION`, `PARAMETER_KEYS`, `buildEmptyConfig`.
- `main.js` — new IPC `config:empty`, `config:create`, `catalog:seed-initial`; remove `config:create-default`/`createDefaultConfigFile`; migrate off `buildDefaultConfig` (version + password fallback).
- `lib/cloud-bootstrap.js` — `deps.buildDefaultConfig` → `deps.schemaVersion`; `provision()` stops seeding; add `seedInitial()`.
- `preload.js` — expose `getEmptyConfig`, `createConfig`, `seedInitialCatalog`; drop `createDefaultConfig`.
- `renderer/index.html` — add `#catalog-wizard` screen with step containers + progress + nav; load `catalog-wizard.js`.
- `renderer/app.js` — call the wizard in the local flow (after settings saved) and cloud flow (after provision); remove the old "create with defaults" dialog.
- `tests/config-default.test.js`, `tests/cloud-bootstrap.test.js` — update to the new exports/behavior.
- Docs: `CLAUDE.md`, `PLAN_Calculadora.md`, `ARCHITECTURE.md`, `docs/UI-UX.md`, `docs/PRD.md`.

---

## Task 1: `config.default.js` → empty-config builder + version constant

**Files:**
- Modify: `config.default.js` (full rewrite of exports; keep file path/name)
- Test: `tests/config-default.test.js`

- [ ] **Step 1: Rewrite the failing test** (`tests/config-default.test.js`)

Replace the file's contents with:

```js
'use strict';

const { describe, it, expect } = require('vitest');
const {
  SCHEMA_VERSION,
  PARAMETER_KEYS,
  buildEmptyConfig
} = require('../config.default');
const { validateConfigSchema } = require('../lib/config-schema');

describe('config.default (empty-config builder)', () => {
  it('exposes the v4 schema version', () => {
    expect(SCHEMA_VERSION).toBe('4.0.0');
  });

  it('no longer exports buildDefaultConfig (no default catalog)', () => {
    // eslint-disable-next-line global-require
    const mod = require('../config.default');
    expect(mod.buildDefaultConfig).toBeUndefined();
  });

  it('buildEmptyConfig has the full v4 shape with EMPTY collections', () => {
    const cfg = buildEmptyConfig();
    expect(cfg.version).toBe('4.0.0');
    expect(cfg.suppliers).toEqual({});
    expect(cfg.products).toEqual({});
    expect(cfg.packs).toEqual({});
    expect(cfg.addons).toEqual({});
    expect(cfg.tiers).toEqual([]);
    expect(cfg.company).toBeTypeOf('object');
    expect(cfg.quote_settings).toBeTypeOf('object');
  });

  it('buildEmptyConfig nulls every cost parameter', () => {
    const cfg = buildEmptyConfig();
    expect(PARAMETER_KEYS.length).toBeGreaterThan(0);
    for (const key of PARAMETER_KEYS) {
      expect(cfg.parameters[key], `parameters.${key}`).toBeNull();
    }
  });

  it('buildEmptyConfig keeps a non-empty admin.password (schema compat)', () => {
    // The admin gate is removed (v5) but validateAdmin still requires a
    // non-empty password; we keep a dead placeholder until it is migrated.
    expect(typeof buildEmptyConfig().admin.password).toBe('string');
    expect(buildEmptyConfig().admin.password.length).toBeGreaterThan(0);
  });

  it('buildEmptyConfig is NOT yet valid (empty catalog), but becomes valid once minimal data is added', () => {
    expect(() => validateConfigSchema(buildEmptyConfig())).toThrow();

    const cfg = buildEmptyConfig();
    for (const key of PARAMETER_KEYS) cfg.parameters[key] = 1;
    cfg.parameters.vat = 0.21;
    cfg.parameters.waste_pct = 0.10;
    cfg.parameters.default_target_margin = 0.35;
    cfg.parameters.price_rounding_ending = 0.95;
    cfg.tiers = [{ id: 'T1', label: 'Único', from: 1, to: null, time_reduction: 0 }];
    cfg.suppliers = { SUP: { name: 'Prov', web: '', notes: '' } };
    cfg.products = {
      P: {
        name: 'Camiseta', category: 'tshirt', extra_cost_3xl: 0.4, target_margin: 0.35,
        suppliers: [{ supplier: 'SUP', ref: '', price: 2, min_order: 0, is_default: true }],
        prices: { two_sides: { T1: 9.95 }, one_side: { T1: 8.95 } }
      }
    };
    cfg.packs = {
      shirts: {
        name: 'Solo camisetas', description: '', icon: 'i-tshirt',
        pricing_mode: 'components', min_total: 1, target_margin: 0.35,
        options: [{ id: 'sides', label: 'Caras', values: [
          { id: 'one_side', label: '1 cara', sides: 1 },
          { id: 'two_sides', label: '2 caras', sides: 2 }
        ] }],
        components: [{ id: 'shirt', label: 'Camiseta', product: 'P' }]
      }
    };
    expect(() => validateConfigSchema(cfg)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/config-default.test.js`
Expected: FAIL — `buildEmptyConfig`/`SCHEMA_VERSION`/`PARAMETER_KEYS` are not exported yet.

- [ ] **Step 3: Preserve the old default catalog as a TEST fixture**

Before deleting anything, move the business constants out of `config.default.js` into a new test fixture so the cloud tests keep a real catalog. Create `tests/fixtures/config-v4-full.js`:

```js
'use strict';
// The catalog that used to be config.default.js's buildDefaultConfig().
// Kept ONLY as a test fixture (the product no longer ships a default).
// Copy the pre-edit PARAMETERS, SUPPLIERS, PRODUCTS, TIERS, ADDONS, PACKS,
// COMPANY, QUOTE_SETTINGS objects verbatim from the current config.default.js
// (git show HEAD:config.default.js), then expose them as one builder.

const VERSION = '4.0.0';
const ADMIN_PASSWORD_DEFAULT = 'fuzfuz2026';
const DEFAULT_TARGET_MARGIN = 0.35;

/* eslint-disable */
const PARAMETERS = { /* paste the full object from config.default.js */ };
const SUPPLIERS = { /* paste */ };
const PRODUCTS = { /* paste */ };
const TIERS = { /* paste — note: in config.default.js TIERS is the source array */ };
const ADDONS = { /* paste */ };
const PACKS = { /* paste */ };
const COMPANY = { /* paste */ };
const QUOTE_SETTINGS = { /* paste */ };
/* eslint-enable */

function buildFullConfigV4(meta = {}) {
  return {
    version: VERSION,
    updated_at: meta.updated_at || '01/01/2026, 0:00:00',
    modified_by: meta.modified_by || 'fixture',
    admin: { password: ADMIN_PASSWORD_DEFAULT },
    parameters: JSON.parse(JSON.stringify(PARAMETERS)),
    suppliers: JSON.parse(JSON.stringify(SUPPLIERS)),
    products: JSON.parse(JSON.stringify(PRODUCTS)),
    tiers: JSON.parse(JSON.stringify(TIERS)),
    addons: JSON.parse(JSON.stringify(ADDONS)),
    packs: JSON.parse(JSON.stringify(PACKS)),
    company: JSON.parse(JSON.stringify(COMPANY)),
    quote_settings: JSON.parse(JSON.stringify(QUOTE_SETTINGS))
  };
}

module.exports = { buildFullConfigV4 };
```

> This is a verbatim move of the existing constants (which already include the DTF `0.30`/`0.60` per-side edit). Use `git show HEAD:config.default.js` to copy each object exactly. Do not hand-retype.

- [ ] **Step 4: Rewrite `config.default.js`**

Replace the entire file with:

```js
// ============================================================
// Quanto - Config bootstrap (empty scaffold + schema version)
// ============================================================
// There is NO default catalog. A fresh install builds its whole
// catalog from blank through the first-run wizard (renderer/
// catalog-wizard.js). This module only provides:
//   - SCHEMA_VERSION : the v4 schema tag stamped into new configs and
//                      the cloud migration ledger.
//   - PARAMETER_KEYS : the cost parameters the wizard's "Costes" step
//                      must fill (buildEmptyConfig nulls them all).
//   - buildEmptyConfig(meta): a schema-SHAPED but EMPTY config — the
//     in-memory scaffold the wizard fills. It is NOT valid until the
//     wizard adds the required minimums (≥1 tier/supplier/product/pack).
//
// Used in the main process (main.js). The renderer receives the empty
// scaffold over IPC (`config:empty`), already renderer-shaped
// (has_password instead of the raw password).
// ============================================================

'use strict';

const SCHEMA_VERSION = '4.0.0';

// Dead-code compatibility: the admin password gate is removed (CLAUDE.md
// §9 / v5), but validateConfigSchema still requires a non-empty
// admin.password (or has_password=true). We keep a placeholder purely to
// satisfy the schema until the admin-password field is migrated out. It
// grants no access — the editor opens directly.
const ADMIN_PASSWORD_PLACEHOLDER = 'quanto';

// Every cost parameter the user fills in the wizard's "Costes" step.
const PARAMETER_KEYS = [
  'labor_eur_hour', 'vat', 'waste_pct', 'overhead_eur_garment',
  'surcharge_4xl_eur', 'surcharge_5xl_eur', 'roly_shipping_eur_bundle',
  'garments_per_bundle', 'dtf_eur_meter', 'dtf_meters_two_sides',
  'dtf_meters_one_side', 'pressing_eur_side', 'minutes_two_sides_base',
  'minutes_one_side_base', 'default_target_margin', 'price_rounding_ending'
];

function blankParameters() {
  const p = {};
  for (const k of PARAMETER_KEYS) p[k] = null;
  return p;
}

/**
 * Returns a fresh, schema-SHAPED but EMPTY v4 configuration: blank cost
 * parameters and empty suppliers/products/tiers/packs/addons. It is the
 * scaffold the first-run wizard fills; it carries no business numbers and
 * does NOT pass validateConfigSchema until the wizard adds the minimums.
 *
 * @param {object} [meta] - optional { modified_by, updated_at }
 * @returns {object} config object ready to be filled
 */
function buildEmptyConfig(meta = {}) {
  return {
    version:     SCHEMA_VERSION,
    updated_at:  meta.updated_at || new Date().toLocaleString('es-ES'),
    modified_by: meta.modified_by || 'sistema (alta)',
    admin:       { password: ADMIN_PASSWORD_PLACEHOLDER },
    parameters:  blankParameters(),
    suppliers:   {},
    products:    {},
    tiers:       [],
    addons:      {},
    packs:       {},
    company: {
      name: '', tax_id: '', address: '', phone: '', email: '', web: '',
      pdf_template: 'clasica', brand_color: '#3D7BD9'
    },
    quote_settings: {
      validity_days: 30,
      terms: 'Precios IVA incluido. Validez 30 días desde la fecha de emisión.'
    }
  };
}

module.exports = {
  SCHEMA_VERSION,
  ADMIN_PASSWORD_PLACEHOLDER,
  PARAMETER_KEYS,
  buildEmptyConfig
};
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `pnpm vitest run tests/config-default.test.js`
Expected: PASS (all assertions).

- [ ] **Step 6: Repoint `tests/cloud-bootstrap.test.js` at the fixture (keep the suite green)**

`cloud-bootstrap.test.js` imports `buildDefaultConfig` from `config.default.js`, which no longer exists. Without touching `lib/cloud-bootstrap.js` yet (that's Task 2), make the test load the fixture so the file still runs:

- Change line 19 from `import { buildDefaultConfig } from '../config.default.js';` to:
  ```js
  import { buildFullConfigV4 as buildDefaultConfig } from './fixtures/config-v4-full.js';
  ```
  (Aliasing to `buildDefaultConfig` means the rest of the test file — `expectedConfig`, the `disassemble(buildDefaultConfig())` calls, and the `buildDefaultConfig` dep at line 84 — keeps working unchanged. `lib/cloud-bootstrap.js` still expects a `buildDefaultConfig` dep until Task 2.)

> Note: `tests/fixtures/config-v4-full.js` is CommonJS (`module.exports`). This test file uses ESM `import`; Vitest interops named exports from CJS, so `import { buildFullConfigV4 }` works. If the repo's other fixtures are imported differently (check how `config-v3.js` is imported in the suite), match that style.

- [ ] **Step 7: Run the full suite — it must be green**

Run: `pnpm test`
Expected: PASS (all files). If `cloud-bootstrap.test.js` fails to resolve the fixture, fix the import style to match the existing fixture imports before committing.

- [ ] **Step 8: Commit**

```bash
git add config.default.js tests/config-default.test.js tests/fixtures/config-v4-full.js tests/cloud-bootstrap.test.js
git commit -m "feat(config): replace default catalog with buildEmptyConfig + SCHEMA_VERSION"
```

---

## Task 2: Migrate `main.js` + `cloud-bootstrap.js` off `buildDefaultConfig`

This task only rewires existing seed/version usages; the new IPC handlers come in Tasks 4–5. After this task `buildDefaultConfig` is referenced nowhere.

**Files:**
- Modify: `main.js:31` (import), `main.js:108` (deps), `main.js:~398` (password fallback)
- Modify: `lib/cloud-bootstrap.js:104,116,124,304` (deps + provision seeding)
- Test: `tests/cloud-bootstrap.test.js`

- [ ] **Step 1: Update the cloud-bootstrap test to the new contract**

In `tests/cloud-bootstrap.test.js` (after Task 1 it imports `buildFullConfigV4 as buildDefaultConfig` and the `makeBootstrap(client, overrides)` factory returns `{ bootstrap, created }`):

1a. In `makeBootstrap` (around line 84) change the dep key:
```js
    // was: buildDefaultConfig,
    schemaVersion: '4.0.0',
```

1b. The provision test (around lines 412–415) currently asserts a seed happened:
```js
    expect(res).toEqual({ ok: true, databaseId: 'db-new', seeded: true });
```
Change it to expect NO seed (provision only migrates):
```js
    expect(res).toEqual({ ok: true, databaseId: 'db-new', seeded: false });
```

1c. Add a `seedInitial` test next to the provision test, reusing that test's `client` (the one wired into `makeBootstrap` that supports the write/seed path) and the same kind of cloud `settings` object the `loadCatalog` tests pass to the bootstrap:

```js
it('seedInitial seeds the catalog from the provided config', async () => {
  const { bootstrap } = makeBootstrap(client);   // same client the provision test builds
  const settings = CLOUD_SETTINGS;               // reuse the settings object loadCatalog tests use
  const r = await bootstrap.seedInitial(settings, {
    config: buildDefaultConfig(),                // = buildFullConfigV4(), a complete v4 catalog
    user: 'Tester'
  });
  expect(r.ok).toBe(true);
  expect(r.seeded).toBe(true);
});
```

> Match the real local names in this file: use whatever the provision test calls its write-capable `client`, and whatever the load tests call their settings object (e.g. a `CLOUD_SETTINGS`/`settings` constant). Do not invent new fakes — reuse the existing ones. `seedInitial` internally calls `clientFromSettings(settings)` → `createClient(opts)`, which `makeBootstrap` overrides to return `client`, so the same fake client is exercised.

- [ ] **Step 2: Run the cloud-bootstrap tests to see them fail**

Run: `pnpm vitest run tests/cloud-bootstrap.test.js`
Expected: FAIL — `seedInitial` undefined and provision still seeds.

- [ ] **Step 3: Edit `lib/cloud-bootstrap.js`**

3a. Change the dependency from `buildDefaultConfig` to `schemaVersion`. Replace the JSDoc + destructuring (around lines 102–118):

```js
 * @param {string} deps.schemaVersion - v4 schema tag (config.default SCHEMA_VERSION), stamped into the migration ledger
```
and in the factory parameter list replace `buildDefaultConfig,` with `schemaVersion,`.

3b. Replace line 124:

```js
  // The cfg `version` is the v4 schema tag (e.g. '4.0.0'), not the
  // catalog_version counter — same value the file mode writes.
  const configVersion = schemaVersion;
```

3c. In `provision()` remove the seeding (lines 302–305). Replace:

```js
        // Seed only a base with an empty catalog; seedCatalog itself
        // no-ops on populated data, so a teammate's catalog is safe.
        const { seeded } = await seedCatalog(client, disassemble(buildDefaultConfig()), { user, now });
        return { ok: true, databaseId: db.uuid, seeded };
```
with:

```js
        // No seeding here: a fresh install builds its catalog through the
        // first-run wizard, which then calls seedInitial() with the user's
        // own catalog. Provision only ensures the DB + migrated schema.
        return { ok: true, databaseId: db.uuid, seeded: false };
```

3d. Add a `seedInitial` method next to `provision` (inside the returned object, after the `provision` method's closing `},`):

```js
    /**
     * catalog:seed-initial → seeds the freshly-provisioned (empty) DB with
     * the catalog the first-run wizard collected. seedCatalog no-ops on
     * already-populated data, so a teammate's catalog is never clobbered.
     * @returns { ok, seeded } | { ok:false, error }
     */
    async seedInitial(settings, { config, user } = {}) {
      try {
        const client = clientFromSettings(settings);
        const { seeded } = await seedCatalog(client, disassemble(config), { user, now });
        return { ok: true, seeded };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
```

> `clientFromSettings` already exists in this module (defined near line 126) and is used by `loadCatalog`/`saveCatalog`; reuse it.

- [ ] **Step 4: Edit `main.js`**

4a. Line 31 — change the import:

```js
const { SCHEMA_VERSION, ADMIN_PASSWORD_PLACEHOLDER, buildEmptyConfig } = require('./config.default');
```

4b. Line ~108 — in the `cloudBootstrap = makeBootstrap({ ... })` deps, replace `buildDefaultConfig,` with:

```js
  schemaVersion: SCHEMA_VERSION,
```

4c. Line ~398 — the password fallback in `prepareConfigForWrite` (the `catch` that sets `currentPassword`). Replace:

```js
    currentPassword = buildDefaultConfig().admin.password;
```
with:

```js
    // No prior file / unreadable: there is no default config anymore. The
    // admin gate is removed; fall back to the dead placeholder the schema
    // still requires.
    currentPassword = ADMIN_PASSWORD_PLACEHOLDER;
```

- [ ] **Step 5: Run the full suite to confirm nothing else referenced the old API**

Run: `pnpm test`
Expected: PASS. (If any other test referenced `buildDefaultConfig`, update it to `buildEmptyConfig`/`SCHEMA_VERSION` per the same intent — search with `grep -rn buildDefaultConfig`.)

- [ ] **Step 6: Verify no stale references remain**

Run: `grep -rn "buildDefaultConfig\|config:create-default\|createDefaultConfig" --include=*.js .`
Expected at this point: only `main.js`'s `createDefaultConfigFile`/`config:create-default` handler and `preload.js`'s `createDefaultConfig` (removed in Task 4) and `renderer/app.js`'s `createDefaultConfig`/`ensureConfigFileReady` (replaced in Task 7). No remaining `buildDefaultConfig`.

- [ ] **Step 7: Commit**

```bash
git add main.js lib/cloud-bootstrap.js tests/cloud-bootstrap.test.js
git commit -m "refactor(cloud): provision no longer seeds; add seedInitial; drop buildDefaultConfig"
```

---

## Task 3: `renderer/wizard-validation.js` — pure per-step minimum checks

**Files:**
- Create: `renderer/wizard-validation.js` (renderer ESM — the wizard imports it; do NOT put it in `lib/`)
- Test: `tests/wizard-validation.test.js` (ESM import, like `tests/calculo.test.js`)

- [ ] **Step 1: Write the failing test** (`tests/wizard-validation.test.js`)

```js
import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEPS,
  parametersComplete,
  stepErrors,
  wizardReady
} from '../renderer/wizard-validation.js';

// A blank config like the one `config:empty` returns: every parameter key
// present but null, all collections empty. (A representative subset of the
// real parameter keys is enough — parametersComplete checks ALL keys present.)
function emptyCfg() {
  return {
    parameters: { labor_eur_hour: null, vat: null, dtf_eur_meter: null, price_rounding_ending: null },
    tiers: [], suppliers: {}, products: {}, packs: {}, addons: {}, company: { name: '' }
  };
}
function withFullParameters(cfg) {
  for (const k of Object.keys(cfg.parameters)) cfg.parameters[k] = 1;
  return cfg;
}

describe('wizard-validation', () => {
  it('lists the steps in dependency order', () => {
    expect(WIZARD_STEPS.map(s => s.id)).toEqual([
      'parameters', 'tiers', 'suppliers', 'products', 'packs', 'addons', 'company'
    ]);
  });

  it('parametersComplete is false until every parameter is a finite number >= 0', () => {
    const cfg = emptyCfg();
    expect(parametersComplete(cfg)).toBe(false);
    withFullParameters(cfg);
    expect(parametersComplete(cfg)).toBe(true);
    cfg.parameters.labor_eur_hour = null;
    expect(parametersComplete(cfg)).toBe(false);
  });

  it('rejects negative or non-numeric parameters', () => {
    const cfg = withFullParameters(emptyCfg());
    cfg.parameters.dtf_eur_meter = -1;
    expect(parametersComplete(cfg)).toBe(false);
  });

  it('treats an empty parameters object as incomplete', () => {
    expect(parametersComplete({ parameters: {} })).toBe(false);
  });

  it('stepErrors(parameters) reports the missing costs', () => {
    const errs = stepErrors(emptyCfg(), 'parameters');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => /coste/i.test(e))).toBe(true);
  });

  it('stepErrors require at least one item for tiers/suppliers/products/packs', () => {
    const cfg = emptyCfg();
    expect(stepErrors(cfg, 'tiers')).toContain('Añade al menos un tramo.');
    expect(stepErrors(cfg, 'suppliers')).toContain('Añade al menos un proveedor.');
    expect(stepErrors(cfg, 'products')).toContain('Añade al menos un producto.');
    expect(stepErrors(cfg, 'packs')).toContain('Añade al menos un pack.');
  });

  it('addons and company steps have no hard minimums', () => {
    const cfg = emptyCfg();
    expect(stepErrors(cfg, 'addons')).toEqual([]);
    expect(stepErrors(cfg, 'company')).toEqual([]);
  });

  it('wizardReady is true only when every step minimum is met', () => {
    const cfg = withFullParameters(emptyCfg());
    expect(wizardReady(cfg)).toBe(false);
    cfg.tiers = [{ id: 'T1' }];        // count-only gate; deep validity is validateConfigSchema's job
    cfg.suppliers = { SUP: {} };
    cfg.products = { P: {} };
    expect(wizardReady(cfg)).toBe(false);
    cfg.packs = { k: {} };
    expect(wizardReady(cfg)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/wizard-validation.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write `renderer/wizard-validation.js`**

```js
// ============================================================
// Quanto - First-run wizard: per-step minimum validation (pure)
// ============================================================
// Renderer ESM module: imported by renderer/catalog-wizard.js and unit-
// tested in isolation (no DOM, no config.default import — it derives the
// parameter keys from the config object the wizard already holds).
//
// These helpers gate "Next" on each step and the final "Finish". They are
// a COUNT-level gate (≥1 tier/supplier/product/pack + every cost filled);
// deep validity is validateConfigSchema's job at persist time. Messages
// are Spanish (shown to the user).
// ============================================================

export const WIZARD_STEPS = [
  { id: 'parameters', label: 'Costes' },
  { id: 'tiers',      label: 'Tramos' },
  { id: 'suppliers',  label: 'Proveedores' },
  { id: 'products',   label: 'Productos' },
  { id: 'packs',      label: 'Packs' },
  { id: 'addons',     label: 'Complementos' },
  { id: 'company',    label: 'Empresa' }
];

/** True when EVERY parameter present on the config is a finite number >= 0.
 *  (config:empty fills all parameter keys with null, so "all present and
 *  finite" means the user has filled them all.) */
export function parametersComplete(cfg) {
  const p = (cfg && cfg.parameters) || {};
  const keys = Object.keys(p);
  return keys.length > 0 && keys.every((k) => Number.isFinite(p[k]) && p[k] >= 0);
}

function count(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).length : 0;
}

/** Spanish messages blocking advance from `stepId`. Empty array = OK. */
export function stepErrors(cfg, stepId) {
  const c = cfg || {};
  switch (stepId) {
    case 'parameters':
      return parametersComplete(c)
        ? []
        : ['Rellena todos los costes con números válidos (mayores o iguales que cero).'];
    case 'tiers':
      return Array.isArray(c.tiers) && c.tiers.length > 0 ? [] : ['Añade al menos un tramo.'];
    case 'suppliers':
      return count(c.suppliers) > 0 ? [] : ['Añade al menos un proveedor.'];
    case 'products':
      return count(c.products) > 0 ? [] : ['Añade al menos un producto.'];
    case 'packs':
      return count(c.packs) > 0 ? [] : ['Añade al menos un pack.'];
    case 'addons':
    case 'company':
      return []; // optional steps
    default:
      return [];
  }
}

/** True when every step's minimum is met (final "Finish" gate). */
export function wizardReady(cfg) {
  return WIZARD_STEPS.every((s) => stepErrors(cfg, s.id).length === 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/wizard-validation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/wizard-validation.js tests/wizard-validation.test.js
git commit -m "feat(wizard): pure per-step minimum validation"
```

---

## Task 4: Main IPC for the empty scaffold + file-mode create

**Files:**
- Modify: `preload.js:26,30` (drop `createDefaultConfig`, add `getEmptyConfig`, `createConfig`)
- Modify: `main.js` — remove `createDefaultConfigFile` (lines ~196–209) and the `config:create-default` handler (lines ~475–490); add `config:empty` and `config:create` handlers
- No new unit test file (the heavy logic is `validateConfigSchema`/`writeConfigAtomic`, already tested); covered by Task 9 smoke.

- [ ] **Step 1: Update `preload.js`**

Replace line 26 (`getDefaultConfigPath`) block's neighbor and the `createDefaultConfig` line. Specifically, change lines 28–30 to:

```js
  // --- Config existence / creation ---
  configExists:        (path)  => ipcRenderer.invoke('config:exists', path),
  // Empty schema-shaped scaffold for the first-run wizard (renderer-shaped:
  // has_password, no raw password). The renderer fills it step by step.
  getEmptyConfig:      ()      => ipcRenderer.invoke('config:empty'),
  // Persist a wizard-built config to a NEW file (validated + atomic + dir-made).
  createConfig:        (data)  => ipcRenderer.invoke('config:create', data),
```

- [ ] **Step 2: Edit `main.js` — remove the default-file creator**

Delete the `createDefaultConfigFile` function (lines ~196–209) and the entire `config:create-default` handler (lines ~475–490).

- [ ] **Step 3: Add the new handlers in `main.js`**

Add, in the config IPC region (e.g. right after the `config:exists` handler near line 471), using the already-imported `stripAdminPassword`, `injectAdminPassword`, `validateConfigSchema`, `writeConfigAtomic`, and the path-bless helper used by the old handler (reuse the SAME bless call the removed `config:create-default` used — copy it verbatim from there before deleting):

```js
// --- Empty scaffold for the first-run wizard (renderer-shaped) ---
ipcMain.handle('config:empty', (event, payload) => {
  const modifiedBy = (payload && (payload.modificadoPor ?? payload.modifiedBy)) || undefined;
  // stripAdminPassword swaps the raw password for has_password=true, the
  // shape the renderer/admin editor expects.
  return stripAdminPassword(buildEmptyConfig({ modified_by: modifiedBy }));
});

// --- Create a NEW config file from the wizard-built config ---
ipcMain.handle('config:create', (event, payload) => {
  const filePath = payload.ruta ?? payload.path;
  const modifiedBy = payload.modificadoPor ?? payload.modifiedBy;
  const rendererCfg = payload.config;
  try {
    if (fs.existsSync(filePath)) {
      return { ok: false, motivo: 'ya_existe', error: 'El archivo ya existe en esa ruta' };
    }
    // Re-attach the (dead) admin password the schema still requires, stamp
    // author/version, validate, then write atomically (creating the dir).
    const full = injectAdminPassword(rendererCfg, ADMIN_PASSWORD_PLACEHOLDER);
    full.version = SCHEMA_VERSION;
    full.updated_at = new Date().toLocaleString('es-ES');
    full.modified_by = modifiedBy || 'sistema (alta)';
    validateConfigSchema(full); // throws a Spanish Error on any problem

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeConfigAtomic(filePath, full);

    // Only after a successful create do we bless the path, so the
    // follow-up read of that same file is allowed (same call the removed
    // config:create-default handler used).
    rememberBlessedConfigPath(filePath);
    const info = getFileInfo(filePath);
    return { ok: true, ruta: filePath, info, config: stripAdminPassword(full) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
```

> `rememberBlessedConfigPath`, `getFileInfo`, `stripAdminPassword`, `writeConfigAtomic`, `injectAdminPassword`, and `validateConfigSchema` are all already defined/imported in `main.js` (the removed `config:create-default` handler used `rememberBlessedConfigPath(r.ruta)` + `getFileInfo(r.ruta)` + `stripAdminPassword(r.config)` at lines 486–488). The returned `info`/`config` mirror the old handler so any caller that read them keeps working; the wizard's `done()` ignores them and re-reads via `loadConfigAndShowApp()`.

- [ ] **Step 4: Sanity-run the suite (no renderer changes yet)**

Run: `pnpm test`
Expected: PASS. (Renderer still calls the removed `createDefaultConfig`; that's wired in Task 7. Tests are main/lib only, so they stay green.)

- [ ] **Step 5: Commit**

```bash
git add preload.js main.js
git commit -m "feat(main): config:empty scaffold + config:create for wizard-built configs"
```

---

## Task 5: Cloud IPC for seeding from the wizard config

**Files:**
- Modify: `preload.js` — add `seedInitialCatalog`
- Modify: `main.js` — add `catalog:seed-initial` handler

- [ ] **Step 1: Update `preload.js`**

In the "Cloud mode (v5)" block, after `provisionCloud`, add:

```js
  // Seed the freshly-provisioned (empty) D1 with the wizard-built catalog.
  // The config is renderer-shaped; main validates it before seeding.
  seedInitialCatalog:  (data) => ipcRenderer.invoke('catalog:seed-initial', data),
```

- [ ] **Step 2: Add the handler in `main.js`**

After the `cloud:provision` handler (near line 589), add:

```js
ipcMain.handle('catalog:seed-initial', async (event, payload) => {
  const settings = readSettings();
  const rendererCfg = (payload && payload.config) || null;
  if (!rendererCfg) return { ok: false, error: 'Falta el catálogo a sembrar.' };
  try {
    // Re-attach the placeholder password + validate before seeding, same
    // guard the file path uses. disassemble() drops the admin section for
    // the cloud tables.
    const full = injectAdminPassword(rendererCfg, ADMIN_PASSWORD_PLACEHOLDER);
    full.version = SCHEMA_VERSION;
    validateConfigSchema(full);
    return await cloudBootstrap.seedInitial(settings, { config: full, user: cloudAuthor(settings) });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
```

> `cloudAuthor(settings)` already exists in `main.js` (defined ~line 601) and is used by `catalog:save`; reuse it.

- [ ] **Step 3: Run the suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add preload.js main.js
git commit -m "feat(cloud): catalog:seed-initial to seed D1 from the wizard catalog"
```

---

## Task 6: Wizard screen markup

**Files:**
- Modify: `renderer/index.html` — add a `#catalog-wizard` screen and load the new script

- [ ] **Step 1: Add the wizard screen markup**

In `renderer/index.html`, after the `#setup-wizard` section (it ends around line 400), add a new top-level screen (a `.pantalla` sibling, hidden by default — match the class used by other screens like `#setup-wizard`):

```html
<!-- First-run CATALOG wizard: build the whole catalog from blank.
     Shown after storage (local/cloud) is ready, before the app. -->
<section id="catalog-wizard" class="pantalla" hidden>
  <div class="wizard-shell">
    <header class="wizard-head">
      <h1 class="wizard-title">Configura tu catálogo</h1>
      <p class="wizard-subtitle">Introduce tus costes y tu catálogo. Nada viene rellenado: todo parte de tu negocio.</p>
      <ol id="catwiz-steps" class="wizard-steps" aria-label="Pasos"></ol>
    </header>

    <!-- The current step's editor renders here (reuses the admin editor). -->
    <div id="catwiz-body" class="wizard-body"></div>

    <!-- Per-step blocking errors. -->
    <p id="catwiz-error" class="form-error" hidden></p>

    <footer class="wizard-nav">
      <button id="btn-catwiz-back" class="btn btn-secondary" type="button">Atrás</button>
      <button id="btn-catwiz-next" class="btn btn-primary" type="button">Siguiente</button>
      <button id="btn-catwiz-finish" class="btn btn-primary" type="button" hidden>Crear catálogo</button>
    </footer>
  </div>
</section>
```

- [ ] **Step 2: (No script tag needed)**

`index.html` loads only `<script type="module" src="app.js">`; every other renderer file is reached via an `import` in `app.js`. The wizard module is wired the same way — Task 7 Step 2a adds `import { startCatalogWizard } from './catalog-wizard.js'` to `app.js`. Do NOT add a separate `<script>` tag.

- [ ] **Step 3: Smoke — the screen exists and is hidden**

Run: `pnpm dev`, open DevTools console, run `document.getElementById('catalog-wizard').hidden` → expect `true`. Close the app.

- [ ] **Step 4: Commit**

```bash
git add renderer/index.html
git commit -m "feat(wizard): add catalog-wizard screen markup"
```

---

## Task 7: Wizard orchestration module + flow wiring

This is the core renderer task. The wizard reuses the admin editor: each step renders one admin "tab" into `#catwiz-body` and rebinds the same mutation handlers.

**Files:**
- Create: `renderer/catalog-wizard.js`
- Modify: `renderer/app.js` — call the wizard from the local + cloud flows; remove `ensureConfigFileReady`'s default-create path

**Prerequisites confirmed (from `renderer/admin.js`):**
- `renderAdminTabContent(cfg, tab, view='list', id=null)` (admin.js:850) returns the HTML string for a tab. Tabs: `'parameters'|'tiers'|'suppliers'|'products'|'addons'|'packs'`.
- `updateConfigFromInput(cfg, input)` (admin.js:876) mutates `cfg` from a changed `[data-cfg-path]` field.
- `executeAdminAction(cfg, dataset)` (admin.js:902) performs add/remove/apply actions from a `[data-action]` button; returns `{ error?, dirty?, id? }`.

> Confirmed: all three are already `export function` in `renderer/admin.js` (`renderAdminTabContent` at line 850, `updateConfigFromInput` at 876, `executeAdminAction` at 902). No change to `admin.js` is needed.

- [ ] **Step 1: Write `renderer/catalog-wizard.js`**

```js
// ============================================================
// Quanto - First-run catalog wizard (renderer)
// ============================================================
// Builds the whole catalog from blank, reusing the admin editor's
// render + mutation functions. The config is held in memory and only
// persisted at the end (file: config:create / cloud: catalog:seed-initial).
// ============================================================

'use strict';

import {
  renderAdminTabContent,
  updateConfigFromInput,
  executeAdminAction
} from './admin.js';
import { WIZARD_STEPS, stepErrors, wizardReady } from './wizard-validation.js';

// Steps that reuse an admin tab (company is a small bespoke form below).
const ADMIN_TAB_STEPS = new Set(['parameters', 'tiers', 'suppliers', 'products', 'packs', 'addons']);

let cfg = null;            // the in-memory config being built
let stepIndex = 0;         // index into WIZARD_STEPS
let view = 'list';         // 'list' | 'editor' for master/detail tabs
let editingId = null;      // current entity id in editor view
let onDone = null;         // async (cfg) => void   persistence callback

function el(id) { return document.getElementById(id); }

/**
 * Entry point. `mode` is 'file' | 'cloud'; `done` persists the finished
 * config and boots the app. Fetches the empty scaffold and shows step 1.
 */
export async function startCatalogWizard({ mode, userName, done }) {
  cfg = await window.packprice.getEmptyConfig({ modificadoPor: userName });
  cfg.company.name = ''; // ensure blank; user fills it in the Empresa step
  stepIndex = 0;
  view = 'list';
  editingId = null;
  onDone = done;
  el('catalog-wizard').dataset.mode = mode;
  bindNav();
  show();
  renderSteps();
  renderStep();
}

function show() {
  // Hide any other first-run screens; reveal the wizard.
  const setup = el('setup-wizard');
  if (setup) setup.hidden = true;
  el('catalog-wizard').hidden = false;
}

let navBound = false;
function bindNav() {
  if (navBound) return;
  navBound = true;
  el('btn-catwiz-back').addEventListener('click', goBack);
  el('btn-catwiz-next').addEventListener('click', goNext);
  el('btn-catwiz-finish').addEventListener('click', finish);

  // Delegated mutation handlers on the wizard body — mirror admin wiring.
  const body = el('catwiz-body');
  body.addEventListener('change', (e) => {
    const input = e.target.closest('[data-cfg-path]');
    if (!input) return;
    updateConfigFromInput(cfg, input);
    refreshGate();
  });
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const r = executeAdminAction(cfg, btn.dataset) || {};
    if (r.error) { showError(r.error); return; }
    // add-* actions return the new id → jump into its editor.
    if (/^add-/.test(btn.dataset.action) && r.id) { view = 'editor'; editingId = r.id; }
    if (/^remove-/.test(btn.dataset.action)) { view = 'list'; editingId = null; }
    if (btn.dataset.action === 'open-editor') { view = 'editor'; editingId = btn.dataset.id; }
    if (btn.dataset.action === 'back-to-list') { view = 'list'; editingId = null; }
    renderStep();
  });
}

function currentStep() { return WIZARD_STEPS[stepIndex]; }

function renderSteps() {
  const ol = el('catwiz-steps');
  ol.innerHTML = WIZARD_STEPS.map((s, i) => {
    const cls = i === stepIndex ? 'is-current' : (i < stepIndex ? 'is-done' : '');
    return `<li class="wizard-steps__dot ${cls}">${s.label}</li>`;
  }).join('');
}

function renderStep() {
  const step = currentStep();
  hideError();
  if (ADMIN_TAB_STEPS.has(step.id)) {
    el('catwiz-body').innerHTML = renderAdminTabContent(cfg, step.id, view, editingId);
  } else if (step.id === 'company') {
    el('catwiz-body').innerHTML = renderCompanyStep(cfg);
  }
  renderSteps();
  refreshGate();
}

// Minimal Empresa form (not part of the admin tabs). Fields carry
// data-cfg-path so updateConfigFromInput handles them uniformly.
function renderCompanyStep(c) {
  const co = c.company || {};
  const field = (key, label, type = 'text') =>
    `<label class="field"><span>${label}</span>
       <input type="${type}" data-cfg-path="company.${key}" value="${(co[key] ?? '')}"></label>`;
  return `<div class="wizard-company">
    <h2>Datos de tu empresa (para el PDF)</h2>
    ${field('name', 'Nombre comercial')}
    ${field('tax_id', 'NIF / CIF')}
    ${field('address', 'Dirección')}
    ${field('phone', 'Teléfono', 'tel')}
    ${field('email', 'Email', 'email')}
    ${field('web', 'Web')}
  </div>`;
}

// Enable/disable Next/Finish from the current step's minimum.
function refreshGate() {
  const errs = stepErrors(cfg, currentStep().id);
  const isLast = stepIndex === WIZARD_STEPS.length - 1;
  el('btn-catwiz-back').disabled = stepIndex === 0;
  el('btn-catwiz-next').hidden = isLast;
  el('btn-catwiz-finish').hidden = !isLast;
  if (isLast) {
    el('btn-catwiz-finish').disabled = !wizardReady(cfg);
  } else {
    el('btn-catwiz-next').disabled = errs.length > 0;
  }
}

function goNext() {
  const errs = stepErrors(cfg, currentStep().id);
  if (errs.length) { showError(errs[0]); return; }
  if (stepIndex < WIZARD_STEPS.length - 1) {
    stepIndex += 1; view = 'list'; editingId = null;
    renderStep();
  }
}

function goBack() {
  if (stepIndex > 0) { stepIndex -= 1; view = 'list'; editingId = null; renderStep(); }
}

async function finish() {
  if (!wizardReady(cfg)) { showError('Faltan datos mínimos en algún paso.'); return; }
  const btn = el('btn-catwiz-finish');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Creando…';
  try {
    await onDone(cfg);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
    btn.disabled = false; btn.textContent = original;
  }
}

function showError(msg) { const e = el('catwiz-error'); e.textContent = msg; e.hidden = false; }
function hideError() { el('catwiz-error').hidden = true; }
```

> The handlers above use action names `open-editor` / `back-to-list`. Confirm the real master/detail action names in `renderAdminTabContent`/`executeAdminAction` (the Explore map references `[data-action="add-*"]`, `[data-back]`, and per-row open). If the real names differ (e.g. a `data-back` attribute instead of `data-action="back-to-list"`, or a row `data-action="edit-<entity>"`), adjust the three string comparisons in the click handler to match — the mechanism (toggle `view`/`editingId`, re-render) stays identical.

- [ ] **Step 2: Wire the LOCAL flow in `renderer/app.js`**

2a. At the top of `app.js`, add the import (match the existing import style; if `app.js` uses `import` for `admin.js`, mirror it):

```js
import { startCatalogWizard } from './catalog-wizard.js';
```

2b. Replace the body of `ensureConfigFileReady` (app.js:382–410) so that a MISSING file no longer offers "create with defaults" — instead it signals the caller to run the wizard. Change the not-exist branch to:

```js
async function ensureConfigFileReady(name, filePath, onError) {
  const exist = await window.packprice.configExists(filePath);
  if (!exist.existe) {
    if (!exist.escribible) {
      onError('No se puede crear el archivo en esa ruta. Comprueba que el NAS está accesible y tienes permisos de escritura.');
      return { ready: false };
    }
    return { ready: false, needsWizard: true };   // brand-new install → wizard
  }
  const r = await window.packprice.readConfig(filePath);
  if (!r.ok) {
    onError(`No se pudo leer el archivo: ${r.error}`);
    return { ready: false };
  }
  return { ready: true };
}
```

2c. Update `startWizardLocal` (app.js:340–381) to consume the new return shape and launch the catalog wizard when needed. Replace the `const ok = await ensureConfigFileReady(...)` block (lines 361–377) with:

```js
    const res = await ensureConfigFileReady(name, filePath, (msg) => {
      el('wiz-local-error').textContent = msg;
      show('wiz-local-error');
    });
    if (!res.ready && !res.needsWizard) return;

    // Persist file mode so a later boot never re-shows the storage chooser.
    SETTINGS = { config_path: filePath, user_name: name, data_source: 'file' };
    const saved = await window.packprice.writeSettings(SETTINGS);
    if (!saved.ok) {
      el('wiz-local-error').textContent = `No se pudo guardar la configuración local: ${saved.error}`;
      show('wiz-local-error');
      return;
    }

    if (res.needsWizard) {
      await startCatalogWizard({
        mode: 'file',
        userName: name,
        done: async (builtCfg) => {
          const created = await window.packprice.createConfig({
            ruta: filePath, config: builtCfg, modificadoPor: name
          });
          if (!created.ok) throw new Error(created.error || 'No se pudo crear el archivo.');
          el('catalog-wizard').hidden = true;
          await loadConfigAndShowApp();
        }
      });
      return; // the wizard's done() boots the app
    }

    hide('setup-wizard');
    await loadConfigAndShowApp();
```

2d. In `cloudProvision` (app.js:523), after a successful provision but BEFORE it boots the app, launch the wizard. Find the success branch (where it currently proceeds to `loadConfigAndShowApp()` / hides the wizard) and replace that success continuation with:

```js
    // Provision succeeded with an EMPTY DB → build the catalog, then seed.
    await startCatalogWizard({
      mode: 'cloud',
      userName: wizardCloud.userName || (SETTINGS && SETTINGS.user_name) || '',
      done: async (builtCfg) => {
        const seeded = await window.packprice.seedInitialCatalog({ config: builtCfg });
        if (!seeded.ok) throw new Error(seeded.error || 'No se pudo crear el catálogo en la nube.');
        el('catalog-wizard').hidden = true;
        await loadConfigAndShowApp();
      }
    });
```

> Read the real `cloudProvision` success branch first; it sets `provisionInFlight`, may persist settings, and calls `loadConfigAndShowApp()`. Keep the settings-persist + `provisionInFlight` reset; only swap the final "boot the app now" for "start the wizard, which boots on done()". Ensure `provisionInFlight` is cleared before awaiting the wizard so the UI is not stuck.

2e. **Second caller of `ensureConfigFileReady`** — the settings "change location" flow (app.js:4701–4708) also calls it and expects a boolean `ok`. Update it to the new `{ ready, needsWizard }` shape and launch the wizard when the chosen folder is empty. Replace the `if (filePath !== SETTINGS.config_path) { ... }` block (lines 4701–4708) with:

```js
  if (filePath !== SETTINGS.config_path) {
    const res = await ensureConfigFileReady(name, filePath, (msg) => {
      window.packprice.showError({ titulo: 'No se pudo usar la carpeta', mensaje: msg });
    });
    if (!res.ready && !res.needsWizard) return;

    if (res.needsWizard) {
      // Pointing at a brand-new empty folder → build its catalog first.
      await window.packprice.writeSettings({ user_name: name, config_path: filePath });
      SETTINGS = await window.packprice.readSettings();
      closeSettings();
      await startCatalogWizard({
        mode: 'file',
        userName: name,
        done: async (builtCfg) => {
          const created = await window.packprice.createConfig({
            ruta: filePath, config: builtCfg, modificadoPor: name
          });
          if (!created.ok) throw new Error(created.error || 'No se pudo crear el archivo.');
          el('catalog-wizard').hidden = true;
          await loadConfigAndShowApp();
        }
      });
      return; // the wizard's done() boots the app
    }
  }
```

> This preserves the existing behavior for an EXISTING `config.js` in the new folder (falls through to the settings write + `loadConfigAndShowApp()` already below at lines 4710–4720). Only the empty-folder case now runs the wizard instead of the removed "create with defaults".

- [ ] **Step 3: Run the full suite (regression guard)**

Run: `pnpm test`
Expected: PASS (no test imports the renderer wizard; this guards against accidental breakage in shared modules).

- [ ] **Step 4: Manual smoke — file mode**

Run: `pnpm dev`. Delete `%APPDATA%\Quanto\` first (clean first run). Pick **Local**, choose an empty temp folder, enter a name, Start. Expect the **catalog wizard** (not the old "create with defaults" dialog). Walk the 7 steps:
- Costes: Next is disabled until all fields are filled.
- Tramos/Proveedores/Productos/Packs: each blocks Next until ≥1 valid item.
- Complementos/Empresa: Next/Finish allowed even if empty (company name optional).
- Finish writes `<folder>/config.js`; the app boots into the calculator with YOUR catalog.
Verify the written `config.js` exists and contains your values (no Roly/BEAGLE defaults).

- [ ] **Step 5: Commit**

```bash
git add renderer/catalog-wizard.js renderer/app.js
git commit -m "feat(wizard): catalog wizard orchestration + file/cloud flow wiring"
```

---

## Task 8: Wizard styles

**Files:**
- Modify: `renderer/styles.css`

- [ ] **Step 1: Add minimal styles**

Reuse existing tokens/classes. Add a small block (place near the existing `.wizard-steps` / `#setup-wizard` rules so wizard styles live together):

```css
#catalog-wizard .wizard-shell { max-width: 880px; margin: 0 auto; padding: 24px; }
#catalog-wizard .wizard-steps { display: flex; gap: 8px; list-style: none; padding: 0; margin: 16px 0; flex-wrap: wrap; }
#catalog-wizard .wizard-steps__dot { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: var(--surface-2, #eef); color: var(--text-muted, #667); }
#catalog-wizard .wizard-steps__dot.is-current { background: var(--brand-500, #3D5AF1); color: #fff; }
#catalog-wizard .wizard-steps__dot.is-done { background: var(--brand-400, #6C82FF); color: #fff; }
#catalog-wizard .wizard-body { margin: 16px 0; }
#catalog-wizard .wizard-nav { display: flex; justify-content: space-between; gap: 12px; margin-top: 16px; }
#catalog-wizard .wizard-company .field { display: block; margin-bottom: 12px; }
#catalog-wizard .wizard-company .field span { display: block; font-size: 13px; color: var(--text-muted, #667); margin-bottom: 4px; }
```

> If the listed CSS variables don't exist, use the literal fallbacks shown (already inlined). Match the surrounding file's formatting.

- [ ] **Step 2: Smoke — visual check**

Run: `pnpm dev`, trigger the wizard (clean first run), confirm the stepper highlights the current step and the layout is readable.

- [ ] **Step 3: Commit**

```bash
git add renderer/styles.css
git commit -m "style(wizard): catalog wizard layout + stepper"
```

---

## Task 9: Cloud smoke + end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Cloud first-run smoke (if cloud credentials are available)**

Run: `pnpm dev`, clean `%APPDATA%\Quanto\`. Pick **Nube**, complete the token + account steps, provision. Expect the **catalog wizard** after provisioning. Build a minimal catalog, Finish → expect `catalog:seed-initial` to succeed and the app to boot reading from D1.

> If no cloud credentials are available in this environment, record that this path was NOT smoke-tested and must be verified on a machine with a Cloudflare token before release (per memory: GUI launch is blocked in the sandbox).

- [ ] **Step 2: Re-run full suite**

Run: `pnpm test`
Expected: PASS (all files).

- [ ] **Step 3: Confirm no defaults leak anywhere**

Run: `grep -rn "BEAGLE\|CLASICA\|URBAN\|Roly\|buildDefaultConfig\|config:create-default" --include=*.js renderer main.js preload.js config.default.js lib`
Expected: no business-catalog constants in `config.default.js`; no `buildDefaultConfig`/`config:create-default` anywhere. (Hits inside `tests/fixtures/` are fine — fixtures keep full catalogs.)

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `PLAN_Calculadora.md`, `ARCHITECTURE.md`, `docs/UI-UX.md`, `docs/PRD.md`

- [ ] **Step 1: CLAUDE.md — add a documented debate**

Under "Documented debates" add (date 2026-06-16):

```markdown
- **2026-06-16 — First run builds the catalog from blank (amends the
  "neutral demo catalog" decision).** There is no default seed anymore.
  `buildDefaultConfig()` and the seeded business constants are removed;
  `config.default.js` exports only `SCHEMA_VERSION` and `buildEmptyConfig()`
  (a schema-shaped, empty, business-number-free scaffold). On first run —
  file mode (no `config.js` at the chosen path) or cloud mode (freshly
  provisioned, empty D1) — a dedicated wizard (`renderer/catalog-wizard.js`)
  walks the user through Costes → Tramos → Proveedores → Productos → Packs →
  Complementos → Empresa, every field blank and required, reusing the admin
  editor's render/mutation functions. The config is held in memory and only
  persisted when it meets the schema minimums (`renderer/wizard-validation.js`):
  file → `config:create` (validated, atomic, backup); cloud → provision
  (no seed) then `catalog:seed-initial`. The demo catalog and any
  "load example" path are dropped. The admin-password placeholder stays as
  dead schema-compat (gate already removed).
```

- [ ] **Step 2: PLAN_Calculadora.md**

In §2 and the relevant roadmap/timeline note that the default seed is gone; a first-run wizard collects the whole catalog. Note that the earlier DTF default (0.30 m/side) is now entered by the user in the wizard, not seeded.

- [ ] **Step 3: ARCHITECTURE.md**

Update §6 (config shape / bootstrap) and the testing list (the `buildDefaultConfig()` structural test becomes a `buildEmptyConfig()` test). Replace references to default seeding with the empty-scaffold + wizard flow.

- [ ] **Step 4: docs/UI-UX.md**

Document the catalog wizard states: step list, per-step gating, blank fields, empty optional steps (addons/company), the Finish gate, and error display.

- [ ] **Step 5: docs/PRD.md**

Add the "build catalog from scratch on first run (no default catalog)" onboarding requirement, in both file and cloud modes.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md PLAN_Calculadora.md ARCHITECTURE.md docs/UI-UX.md docs/PRD.md
git commit -m "docs: first-run catalog wizard replaces default seed"
```

---

## Definition of done

- `pnpm test` green (new tests: `config-default`, `wizard-validation`, updated `cloud-bootstrap`).
- File-mode first run shows the wizard, blocks on per-step minimums, and writes a `config.js` with only the user's data (no Roly/BEAGLE).
- Cloud-mode first run provisions empty, runs the wizard, and seeds D1 from the wizard catalog (or is explicitly recorded as un-smoke-tested if no credentials).
- `grep` confirms `buildDefaultConfig`/`config:create-default`/business constants are gone from product code.
- Hard rules intact: no domain numbers in code (§2), renderer never touches fs (§3 — all persistence via IPC), schema-validated writes (§5), conflict check untouched (§6), tests ship with schema/flow change (§7), no new deps (§9).
- Docs updated (§8): CLAUDE.md debate + the four doc files.
```
