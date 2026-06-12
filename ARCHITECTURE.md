# ARCHITECTURE.md — PackPrice

The technical reference for PackPrice: how the system is structured, the design
patterns it commits to, the invariants that must never break, and how it is
allowed to grow. `CLAUDE.md` is the short operating manual and points here for
depth. `AGENTS.md` describes *how to work* on this code with Claude Code.

> **Operative, not aspirational.** If the code diverges from this document,
> fix the code or fix this document — never leave a silent gap. Every rule here
> exists to keep a tiny app (2–3 users, one workshop, one NAS) cheap to own for
> years. Optimise for **deletability and readability**, not for cleverness.

---

## 1. System context

PackPrice is an **Electron desktop app** that prices DTF (Direct-to-Film)
textile customization packs. Each workshop PC runs a portable `.exe`; all PCs
share one `config.js` on the company NAS.

```
┌─────────────────────────────────────────────────────────────┐
│  Workshop LAN (no public internet, no telemetry, no backend) │
│                                                               │
│   PC-A ──┐                                                    │
│   PC-B ──┼──►  \\172.26.0.154\Paep\Packs\config.js  (truth)   │
│   PC-C ──┘                      └─ backups\         (safety)  │
│                                                               │
│   each PC also keeps local, per-machine state in %APPDATA%    │
└─────────────────────────────────────────────────────────────┘
```

- **No multi-tenant, no auth server, no network API.** The NAS file *is* the backend.
- **Business data lives in data, not code** (see §6).
- The full business model is specified in `PLAN_Calculadora.md` (source of truth
  for numbers and pricing rules).

---

## 2. Process model & trust boundary

Electron splits the app into two processes. The boundary between them is the
**single most important security and architecture line in the codebase**.

| Process | Runtime | Trust | Responsibilities |
|---|---|---|---|
| **main** | Node.js | trusted | filesystem (NAS + `%APPDATA%`), native dialogs, IPC handlers, config read/write, backups, audit, logging, PDF export |
| **renderer** | Chromium | **untrusted** | UI, DOM events, pure calculation, formatting. **No Node, no `fs`, no `ipcRenderer`.** |
| **preload** | Node (isolated) | bridge | the *only* surface the renderer can call; whitelists a narrow API onto `window.packprice` via `contextBridge` |

```
renderer (Chromium)                preload                 main (Node)
─────────────────────              ────────                ───────────
window.packprice.readConfig(path)
        │  contextBridge call
        ▼
                          ipcRenderer.invoke('config:read', …)
                                   │  IPC
                                   ▼
                                              ipcMain.handle('config:read', …)
                                                       │ fs / NAS / validate
                                                       ▼
        ◄───────────────────────  { ok, config } / { ok:false, error }
```

### Hard invariants (never weaken without a documented debate in `CLAUDE.md`)

- `contextIsolation: true`
- `nodeIntegration: false`
- CSP `default-src 'self'` (see `renderer/index.html`); no inline/external scripts
- `sandbox: false` is tolerated **only** because `preload.js` uses `require`. If
  preload is refactored to drop `require`, flip it to `true`.
- The renderer **never** imports `fs`, `path`, `crypto`, `vm`, or `ipcRenderer`.
- `preload.js` exposes **named functions only** — never `ipcRenderer`, never `fs`,
  never a generic `invoke(channel, …)` passthrough. Each exposed function is an
  attack surface; keep the list minimal and explicit.

This is the **Ports & Adapters (Hexagonal)** pattern: the renderer is the
application core, `preload.js` is the port, and `main.js`'s IPC handlers are the
adapters that talk to the outside world (filesystem, OS dialogs).

---

## 3. Module map & layering

```
packs app/
├── main.js                 ← main process: IPC handlers + filesystem orchestration
├── preload.js              ← the port: window.packprice.* whitelist
├── config.default.js       ← default config seed (ONLY used to bootstrap a missing config.js)
│
├── lib/                    ← pure, testable, framework-free modules (CommonJS, English)
│   ├── config-parser.js    ← extract/serialize the JSON block of config.js (legacy ES identifiers)
│   ├── config-schema.js    ← strict v4 schema validation, dotted-path errors (EN)
│   ├── config-store.js     ← read+migrate+validate, atomic write (.tmp+rename) (EN)
│   ├── migrations.js       ← migrateConfig (v2→v3→v4) / Quote / Settings, normalizeAuditEntry (EN)
│   ├── path-guard.js       ← IPC path allow-list (isPathAllowed)             (EN)
│   ├── diff.js             ← flat object diff for audit + admin preview      (EN)
│   ├── audit.js            ← append-only audit log writer/reader             (EN)
│   ├── history.js          ← local quote history store                       (EN)
│   ├── pdf-template.js     ← quote → HTML for printToPDF                      (EN)
│   └── logger.js           ← electron-log wrapper                            (EN)
│
├── renderer/               ← UI + pure calculation (no Node)
│   ├── index.html          ← single page; screens toggled via .hidden
│   ├── app.js              ← orchestration: DOM events, IPC calls (legacy ES)
│   ├── calculo.js          ← PURE v4 pricing: calculatePack + helpers (EN identifiers)
│   ├── admin.js            ← admin editor / catalog builder (data-cfg-path driven, EN)
│   ├── admin-extras.js     ← audit log rendering                      (EN)
│   ├── history.js          ← quote history UI                         (EN)
│   ├── format.js           ← DOM/format helpers                       (legacy ES)
│   └── styles.css          ← design tokens in :root, BEM-lite classes
│
└── tests/                  ← Vitest, English. One file per lib/renderer module.
```

### Dependency rule (enforced, not optional)

Dependencies point **inward and downward only**:

```
renderer/app.js ──► renderer/calculo.js ──► (CFG object, pure)
       │
       └──► window.packprice ──► preload.js ──► main.js ──► lib/*
                                                     │
                                                     └──► lib/* never require Electron, fs is fine only where noted
```

- `lib/*` modules are **pure where they can be**: `config-schema.js`, `diff.js`,
  `pdf-template.js`, `migrations.js`, `path-guard.js` must not touch `fs`,
  Electron, or globals. `audit.js`, `history.js`, `logger.js`, `config-store.js`
  may touch `fs` (they are stores) but must not import Electron UI.
- `renderer/calculo.js` depends **only** on a `cfg` object passed in. No DOM,
  no globals beyond the injected config. This is what makes pricing testable.
- `main.js` is the only file allowed to wire `lib/*` to the filesystem and IPC.
- **No circular dependencies.** If two modules need each other, a third concept
  is hiding — extract it.

---

## 4. Design patterns in use

These are the patterns the codebase commits to. Use them; don't invent parallel
ones for the same job.

### 4.1 Pure functions for all domain calculation

The pricing engine (`renderer/calculo.js`, schema v4) is a set of **pure**
functions: `(cfg, input) → plain result object`. No DOM reads, no global
mutation, no `Date.now()` inside the math.

- `getTier(cfg, quantity)` — the volume tier, or `null` if below the first tier.
- `calculateGarmentCost(cfg, productId, sides, tier, totalForShipping)` — the
  real internal cost of one finished garment (supplier base + DTF + pressing +
  waste + labor + overhead + prorated shipping).
- `calculateAddons(cfg, selection)` — optional configurable extras, returning the
  ex-VAT subtotal and the VAT-inclusive total.
- `recommendedPrice(cfg, costPerUnit, targetMargin)` — suggested PVP (§6).
- `calculatePack(cfg, packId, opt)` — **the one generic pack calculator.** It
  replaced the four old hard-coded calculators (crew/single/mixed/custom). It is
  driven entirely by the config: it reads the pack's `pricing_mode`, resolves the
  selected `options` (sides/hood/…), expands components into priced lines, applies
  3XL/4XL/5XL, and returns the full quote. A validation failure returns
  `{ error }` with a Spanish message rather than throwing.

> **Why:** pricing is the part a bug hurts most (wrong money). Pure functions are
> trivially unit-testable without Electron or a DOM, and the test cases in
> `tests/calculo.test.js` pin exact euro amounts from `PLAN_Calculadora.md`.

**Rule:** a new pack is **data, not code** — add an entry to `cfg.packs` with a
`pricing_mode` and declared `options`/`components`. Only genuinely new pricing
behavior touches `calculatePack`, and then it stays generic. Never reach into the
DOM from a calculation function.

### 4.2 Ports & Adapters at the IPC boundary

Covered in §2. To add a new main-process capability:

1. `ipcMain.handle('<resource>:<action>', …)` in `main.js`.
2. Expose a named wrapper in `preload.js` (`window.packprice.<verb>`).
3. Call `await window.packprice.<verb>(…)` from the renderer.

Never shortcut this by widening the preload surface.

### 4.3 Repository pattern for persistence

Every persisted artifact is reached through a small module with a verb API, not
through scattered `fs` calls:

| Artifact | Module | Location | API shape |
|---|---|---|---|
| Business config | `config:*` handlers + `config-parser.js` | NAS `config.js` | read / write / force-write / info |
| Quote history | `lib/history.js` | per-PC JSON | `save` / `list` / `search` / `get` / `delete` |
| Audit log | `lib/audit.js` | NAS append-only | `appendAuditEntry` / `readRecentEntries` |
| Local settings | `settings:*` handlers | `%APPDATA%` JSON | read / write |

**Rule:** no business logic does raw `fs.readFileSync` on these paths. Go through
the module. New persistence → new module with the same verb-style API.

### 4.4 Migration / Adapter layer (the anti-tech-debt keystone)

When persisted schema changes, **all version handling lives in one place** —
`lib/migrations.js` — invoked at the moment data *enters* the system (on read).
No `if (v2) … else …` branches scattered through the code.

```
read(file) ──► migrate*(raw) ──► validate ──► [if changed: backup+write back] ──► hand v-latest to the rest of the app
```

Contract for every migrator:

- **Idempotent:** `migrate(migrate(x)) === migrate(x)`. Detect by `version`
  (config), by presence of new-shape keys (quotes, settings), or by shape (audit).
- **Backup before write:** tagged backup (e.g. `pre-v3-migration`) distinct from
  routine backups.
- **Atomic:** backup → write; a failed write leaves the original intact.
- **Logged:** one structured `logger.info` line per real migration.
- **Lazy:** runs the first time a PC opens an old-format file; no human step.
- **Chainable forward:** `migrateConfig` does exactly this — a v2 config is
  mapped to v3 (`mapConfigV2ToV3`) and then to v4 (`migrateConfigV3ToV4`); a v3
  config skips straight to the v4 step; a v4 config is returned by identity.

The v3→v4 step is the substantive one: `roly_models` → `products` (each with its
own price table, `suppliers[]` and `extra_cost_3xl`), the fixed `extra_*_eur`
parameters → configurable `addons`, the dropped `buffer_3xl_eur_pack`, and pack
`type` (`crew`/`single`/`mixed`/`custom`) → `pricing_mode` + declared
`options`/`components` (with `maps_product` for the crew pack's hood→garment
swap). See `migrateConfigV3ToV4` in `lib/migrations.js`.

This is how the project keeps technical debt from compounding: old shapes are
normalized at the door and **nobody downstream knows they ever existed**. See
`planes/migracion-codigo-ingles.md` (v2→v3) and
`planes/v4-configurabilidad-total.md` (v3→v4) for the canonical examples.

### 4.5 Append-only audit log

`audit.log` on the NAS is **append-only, one JSON object per line**. It is never
rewritten (rewriting would defeat tamper-evidence). When the field schema
evolves, the **reader** normalizes both shapes in memory (`normalizeAuditEntry`);
**writes** always use the latest shape. The file is naturally bi-modal and that
is acceptable.

### 4.6 Conflict detection (optimistic concurrency)

Two admins can edit on different PCs. Before any admin write, main compares the
file's `mtime + sha256` against what the editor loaded. Mismatch → the user is
asked to resolve, never silently overwritten. **Do not remove this check.** If it
feels intrusive, improve the UX around it.

### 4.7 Fail-fast in main, clear message in renderer

- `main.js` throws `Error` (message in Spanish — it reaches the user verbatim).
  The IPC wrapper converts it to `{ ok: false, error: e.message }`.
- The renderer surfaces it via a native dialog (`showError`/`mostrarError`).
  **Never** swallow an error to "keep things from breaking." The only tolerated
  silent failure is documented and non-blocking (e.g. backup creation).

---

## 5. Data flow (end to end)

**A price calculation:**

```
user input (DOM)
  → app.js gathers a plain input object
  → calculo.js pure function (cfg, input) → result object
  → app.js renders result + (optionally) saves quote / exports PDF
```

**An admin config edit:**

```
admin.js collects edits via data-cfg-path
  → window.packprice.writeConfig({ path, newConfig, expectedInfo })
  → main: re-read current file → compare mtime+sha256 (conflict check)
  → diff old vs new (lib/diff.js)
  → backup current → write new (atomic) → append audit entry (lib/audit.js)
  → return ok / conflict
```

**App start:**

```
read settings (%APPDATA%) → resolve config path
  → read config from NAS → migrate → validate schema → strip admin password
  → hand CFG to renderer → render welcome or main screen
```

---

## 6. Business data lives outside code

Every number a business human might want to change — PVP per tier, margins, cost
parameters, admin password, company details — lives in `config.js` on the NAS,
**not in code**. A price change is a *data* change, never a deploy.

- `config.default.js` is used **only** to seed a missing `config.js` on first run.
  Once `config.js` exists, the code never looks at `config.default.js` again.
- **Corollary:** no domain numbers in `main.js`, `preload.js`, `app.js`, or
  `index.html`. Need one? Add it to `config.default.js` and read from `CFG`.

### Config schema (current — **v4**)

`config.default.js` is the canonical, documented v4 shape. v2/v3 configs are
migrated to v4 on read (§4.4) and never seen downstream.

```js
{
  version: '4.0.0', updated_at, modified_by,
  admin:      { password },                 // stripped before reaching the renderer
  parameters: {
    labor_eur_hour, vat, waste_pct, overhead_eur_garment,
    surcharge_4xl_eur, surcharge_5xl_eur, roly_shipping_eur_bundle,
    garments_per_bundle, dtf_eur_meter, dtf_meters_two_sides,
    dtf_meters_one_side, pressing_eur_side, minutes_two_sides_base,
    minutes_one_side_base,
    default_target_margin,        // fallback target margin for recommendedPrice
    price_rounding_ending         // psychological rounding, e.g. 0.95 → x,95
  },                              // NOTE: no buffer_3xl_eur_pack, no extra_*_eur
  suppliers: { ROLY: { name, web, notes } },          // provider registry
  products:  {                                         // replaces roly_models
    BEAGLE: {
      name, category,                       // category groups + decides addons
      extra_cost_3xl, target_margin,
      suppliers: [ { supplier, ref, price, min_order, is_default } ], // one default
      prices: { two_sides: { T1, T2, T3, T4 }, one_side: { … } }     // sides × tier
    }, …
  },
  tiers:  [ { id, label, from, to, time_reduction } ], // to:null = open-ended
  addons: {                                            // replaces extra_*_eur
    name: { label, price, vat_included, cost, applies_to: ['*'] }, … // applies_to = categories or '*'
  },
  packs: {
    crew_full: {                            // pricing_mode 'bundle'
      name, description, icon, pricing_mode:'bundle', min_total, target_margin,
      options: [ { id, label, values:[{ id, label, sides? }], maps_product? } ],
      components: [ { id, label, product, qty_per_pack } ],
      bundle_prices: { 'without_hood|two_sides': { T1, … }, … } // option-combo × tier
    },
    tshirts_only: {                         // pricing_mode 'components'
      name, …, pricing_mode:'components', min_total,
      options:[ … ], components:[ { id, label, product } ]      // priced from product.prices
    },
    custom: { …, pricing_mode:'components', free_components:true, components:[] }
  },
  company:        { name, tax_id, address, phone, email, web },
  quote_settings: { validity_days, terms }
}
```

**Structural keys → English; user-visible values (`name`, tier `label`, addon
`label`, pack `name`/`description`, `terms`, company data) → stay Spanish**
because they render to the user. The strict validator (`lib/config-schema.js`)
checks every field the engine depends on — including that each product has
exactly one default supplier, that every `prices`/`bundle_prices` cell exists for
every tier and option-combo, that tiers don't overlap, and that
`components`/`maps_product` reference existing products.

> **Per-entry `target_margin`:** products and packs carry a `target_margin`, but
> the engine's `recommendedPrice` currently uses `parameters.default_target_margin`
> as the margin; the admin "Aplicar PVP recomendado" UI passes the per-entry
> override explicitly. Keep this in mind before assuming a stored `target_margin`
> is consulted automatically.

### Pricing rules that live in the engine (not in config)

- **3XL** is an *internal* cost, never billed. Each product has an
  `extra_cost_3xl`; for an order, `calculatePack` adds `qty_3xl × MAX(extra_cost_3xl
  over the products in that order)` to the internal cost. The MAX is deliberately
  conservative: the shop never loses money on the size mix. The old fixed
  `buffer_3xl_eur_pack` is gone.
- **4XL / 5XL** remain *client* surcharges (`surcharge_4xl_eur` /
  `surcharge_5xl_eur`), added to the VAT-inclusive total. `qty_3xl + qty_4xl +
  qty_5xl` is bounded by the order size.
- **Recommended PVP:** `recommendedPrice` = round-up of `cost / (1 −
  target_margin)` to the next price ending in `price_rounding_ending` (0.95 →
  `x,95`). It reports the real margin at the rounded price. The basis is whatever
  cost is passed in (an ex-VAT cost yields an ex-VAT price; no VAT gross-up here).
- **Margin:** `margin_pct` is computed over the **net base** (`sale_base =
  total_vat_inc / (1 + vat)`), not over the VAT-inclusive total.

### Adding a config field

1. Add it to `config.default.js`.
2. Document it in `PLAN_Calculadora.md`.
3. If existing NAS configs lack it: add a code fallback **or** migrate the file
   via `lib/migrations.js` (§4.4). Prefer migration for anything beyond a trivial
   default.

### Reading config safely

`config.js` is parsed by **scanning for its JSON block and `JSON.parse`-ing it**
— never `eval`, `new Function`, `require`, or `vm`. `vm` is *not* a security
boundary; using it to parse an external file is an RCE door. Every freshly read
config must pass `validateConfigSchema` before reaching the renderer.

---

## 7. Security model

| Invariant | Why |
|---|---|
| `contextIsolation: true` | isolate renderer from main |
| `nodeIntegration: false` | renderer cannot call Node |
| CSP `default-src 'self'`, `script-src 'self'` | block external/inline scripts |
| narrow `preload.js` surface | each exposed fn is attack surface; no `fs`/`ipcRenderer` leak |
| IPC path allow-list (`lib/path-guard.js`) | filesystem IPC only touches blessed paths (config + per-PC settings), never arbitrary user paths |
| `settings:write` / `quotes:save` input validation | reject malformed payloads at the IPC boundary |
| admin-password verify rate-limit | throttle/lock repeated `auth:verify-admin` attempts |
| no `eval`/`Function`/`vm`/dynamic `require` on user paths | prevent RCE via config |
| schema validation on every read | bad data fails fast, never produces `NaN` prices |
| atomic config write (`.tmp` + rename) | an interrupted write leaves the original intact |
| backup before every admin write | recoverable from corruption or bad edit |
| conflict check before write | no silent overwrite of another user's edit |
| `admin.password` stored in plaintext | it is **anti-accidental-click**, *not* security (documented in `PLAN_Calculadora.md` §7.1). Admin password is stripped before config reaches the renderer. |

**Threat posture:** the app runs on a trusted LAN with trusted users. The real
risks are (a) a malformed/hostile `config.js` reaching code execution, and (b)
data loss. Both are mitigated above. Do not add auth, crypto, or hardening that
the threat model doesn't justify — that is its own kind of debt.

> **Accepted deferral — CSP `style-src 'unsafe-inline'`.** The CSP keeps
> `style-src 'self' 'unsafe-inline'` because the UI uses inline `style="..."`
> attributes pervasively. Tightening it would require sweeping the markup for an
> offline LAN app whose script surface is already locked down (`script-src
> 'self'`, no external origins). This is a conscious trade-off, not an oversight;
> revisit it if the UI is ever reworked.

**Never** sign the `.exe` with a borrowed or expired certificate. Publishing
is owner-sanctioned since 2026-06-12 (public GitHub repo, `.exe` on Releases —
see the debate in `CLAUDE.md` §2); what must **never** be published: secrets,
tokens, the real NAS `config.js`, or any customer's D1 data.

---

## 8. Coding conventions (architecture-level)

- `'use strict';` at the top of every own `.js`.
- `const` by default, `let` only when reassigning, **never** `var`.
- CommonJS `require/exports` (Electron without a bundler); ES module syntax only
  where a file is renderer-loaded and already uses it.
- **Code in English** — identifiers, functions, comments, JSDoc, IPC channels,
  filenames. **User-visible strings in Spanish** (UI, error dialogs, PDF text).
  Legacy Spanish identifiers are migrated progressively, never in a big-bang.
- IPC channels: `<resource>:<action>` in kebab-case, English
  (`config:read`, `quotes:save`, `pdf:export`). Legacy Spanish channels stay
  alive until the renderer migration retires them.
- HTML ids in `kebab-case`; `data-*` to bind config paths; CSS tokens in `:root`,
  BEM-lite class names — no utility-first frameworks.
- Comments explain **why**, never **what**. Three similar lines beat a premature
  abstraction.

---

## 9. Testing strategy

- **Vitest**, one test file per module, in English.
- **Highest-value targets** (test these before anything else):
  1. `getTier` — tier boundaries (9, 10, 24, 25, 49, 50, 99, 100); null below the first tier.
  2. `calculateGarmentCost` — two-sided garment across tiers, with/without reduction.
  3. `calculatePack` (bundle) — the `PLAN_Calculadora.md` case: 12 crew packs no-hood 2-sides → 311.40 €.
  4. `calculatePack` (components) — 7 URBAN + 5 CLASICA T1 → 193.40 €; plus 3XL/4XL/5XL bounds and `margin_pct` over `sale_base`.
  5. `recommendedPrice` — round-up to `x,95` and reported margin at the rounded price.
  6. `buildDefaultConfig()` — structural v4 keys survive refactors.
  7. `config-parser` / `config-schema` — malformed files, missing sections, v4 rules.
  8. `migrations.*` — round-trip v2→v3→v4, idempotency, missing-field errors.
- **Rule:** any change touching calculation or config schema ships with tests.
  Pure functions (§4.1) make this cheap — there is no excuse to skip it.
- E2E (Playwright on the packaged `.exe`) is deferred until the app justifies it.

---

## 10. Scalability & evolution path

The app is built for **2–3 users + one NAS**. These are the *only* sanctioned
growth seams; anything beyond them needs a debate and a `CLAUDE.md` update.

### Cheap, supported by design (data-only, from the admin UI)
- New supplier: add `suppliers.<ID>`.
- New product/garment: add `products.<ID>` (category, suppliers, price table, 3XL).
- New single-product or multi-component pack: add `packs.<id>` with a
  `pricing_mode` and declared `options`/`components`. No code change — the unified
  `calculatePack` handles it. This is the whole point of v4: the catalog is data.

### Needs code (follow the existing pattern)
- A genuinely new *pricing behavior* (e.g. a tiered surcharge that no current
  option models) extends `calculatePack` — but keep it generic and config-driven,
  never a per-pack branch. Add tests pinning the new behavior.

### Bigger seams (each gated on a real trigger)
- **Quote history at scale:** already local per-PC JSON via `lib/history.js`. If
  it grows, the repository API hides the storage swap.
- **Cloud storage (v5 — approved 2026-06-12, in progress):** the catalog (and
  quotes) can live in Cloudflare D1 (normalized tables) in *the customer's
  own account*, accessed **directly over Cloudflare's REST API — no Worker,
  no server-side code**; the app self-provisions the database on first run
  and applies bundled SQL migrations itself (additive-only, automatic
  pre-migration backup + restore fallback). The design keeps every invariant
  above: network only in the main process behind a `lib/config-backend.js`
  interface (adapters: `file` = today's config-store, `d1` = new
  `lib/d1-client.js`, native `fetch`); a pure `lib/catalog-assembler.js`
  converts entities ↔ the same v4 `cfg` object **in both directions** (it is
  also the local↔cloud migrator), so `calculo.js` and `validateConfigSchema`
  are untouched; writes are per-entity diffs (`lib/diff.js`) guarded by
  optimistic version checks (`UPDATE … WHERE version = ?`); offline =
  read-only from an atomic local cache in `%APPDATA%` plus an outbox for
  quotes. Debate in `CLAUDE.md` §2; full plan in `planes/v5-cloud-sync.md`;
  requirements in `docs/PRD.md`. Until the workshop's transition ships, the
  NAS file remains the production source of truth and everything else in
  this document applies unchanged.
- **i18n:** all strings are Spanish today. If ever sold abroad: extract to
  `renderer/i18n/<lang>.json` + a tiny `T(key)` lookup. No i18n framework for ~50
  strings.

**Do not start a bigger seam without a quantifiable trigger.** Premature
generality is the most expensive debt this codebase can take on.

---

## 11. How this keeps technical debt low (the contract)

1. **One place per concern.** Filesystem only in `main.js`. Version handling only
   in `lib/migrations.js`. Persistence only behind repository modules. Pricing
   only in pure functions. When you can name "the one place," debt has nowhere to
   hide.
2. **Normalize at the door.** Old data shapes are migrated on read; downstream
   code only ever sees the latest shape.
3. **Pure core, thin shell.** Business logic is pure and tested; I/O is a thin
   adapter. Bugs concentrate where they're cheapest to catch.
4. **Delete before you add.** Prefer removing a special case to adding an
   abstraction. YAGNI is the default answer.
5. **No silent divergence.** Code and these docs must agree. A drift is a bug.
6. **Reversibility.** Every destructive operation (config write, migration) has a
   backup and a documented rollback before it ships.

If a change makes any of these six harder to state, it is probably the wrong
change — stop and reconsider before writing it.
