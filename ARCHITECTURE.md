# ARCHITECTURE.md — Quanto

The technical reference for Quanto: how the system is structured, the design
patterns it commits to, the invariants that must never break, and how it is
allowed to grow. `CLAUDE.md` is the short operating manual and points here for
depth. `AGENTS.md` describes *how to work* on this code with Claude Code.

> **Operative, not aspirational.** If the code diverges from this document,
> fix the code or fix this document — never leave a silent gap. Every rule here
> exists to keep a tiny app (2–3 users per company, storage they own) cheap to
> own for years. Optimise for **deletability and readability**, not for
> cleverness.

---

## 1. System context

Quanto is an **Electron desktop app** that prices DTF (Direct-to-Film)
textile customization packs. Each workshop PC runs an installed `.exe`
(per-user NSIS). All PCs of one company share one catalog + quote store through
the storage that company chose (`settings.data_source`): a flat `config.js` on
a PC/NAS path (**file mode**) or Cloudflare D1 in the customer's own account
(**cloud mode**). The two are interchangeable.

```
┌────────────────────────────────────────────────────────────────────┐
│  One company's PCs (per-PC state + caches + outbox in %APPDATA%)    │
│                                                                      │
│  file mode:  PC-A/B/C ──► \\NAS\...\config.js + presupuestos\ (truth)│
│                                    └─ backups\            (safety)  │
│  cloud mode: PC-A/B/C ──► customer's Cloudflare D1        (truth)   │
│              (REST from main; local cache + outbox when offline)     │
└────────────────────────────────────────────────────────────────────┘
```

- **No multi-tenant, no auth server, no server-side code of ours.** The shared
  store (NAS file or the customer's D1) *is* the backend.
- **Internet egress happens only in the main process**, and only for three
  sanctioned things: the customer's own D1 (cloud mode), GitHub Releases
  (auto-update), and opt-out scrubbed error reports. The renderer has no
  network beyond `'self'`.
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
├── config.default.js       ← schema version + empty scaffold (buildEmptyConfig); NO catalog seed
│
├── db/migrations/          ← bundled additive-only SQL migrations for cloud (D1) mode
│
├── lib/                    ← testable CommonJS modules (English), grouped by concern
│   │ · file config backend
│   ├── config-parser.js    ← extract/serialize the JSON block of config.js (some legacy ES identifiers)
│   ├── config-schema.js    ← strict v4 schema validation, dotted-path errors
│   ├── config-store.js     ← read+migrate+validate, atomic write (.tmp+rename)
│   ├── migrations.js       ← the ONE place that knows old local shapes (config/quote/settings/audit)
│   ├── path-guard.js       ← IPC path allow-list (isPathAllowed)
│   │ · cloud (D1) backend — main-process only, injectable fetch
│   ├── d1-client.js        ← zero-dep Cloudflare D1 REST client (token never reaches renderer)
│   ├── db-migrator.js      ← idempotent SQL migration runner + schema_migrations ledger
│   ├── migration-loader.js ← reads bundled db/migrations/*.sql (only cloud module touching fs)
│   ├── cloud-bootstrap.js  ← factory wiring the whole cloud flow behind 3 lines of main.js
│   ├── cloud-catalog.js    ← cloud catalog read path + one-shot initial seed
│   ├── catalog-writer.js   ← per-entity version-guarded writes + audit + snapshot
│   ├── catalog-assembler.js ← cfg ↔ D1 entity rows, both directions (also the local↔cloud migrator)
│   ├── catalog-cache.js    ← last-good catalog mirror for offline read-only boot
│   ├── cloud-history.js    ← D1 audit log + snapshot restore (through the guarded writer)
│   │ · shared quote store — one quotes:* contract, two backends (§4.3b)
│   ├── quote-repo-file.js  ← file backend: <configDir>/presupuestos/<id>.json, atomic writes
│   ├── quote-repo-cloud.js ← cloud backend façade (same interface) over cloud-quotes.js
│   ├── cloud-quotes.js     ← D1 data access for the quote tables
│   ├── quote-cache.js      ← per-PC read mirror (fast list + offline view; NOT a write buffer)
│   ├── quote-outbox.js     ← offline outbox for cloud writes, drained on reconnect
│   ├── quote-drain.js      ← pure reconnect-drain routing (queued CREATE vs EDIT)
│   ├── quote-migrate-local.js ← one-time legacy presupuestos.json → shared store (idempotent)
│   ├── quote-store-helpers.js ← pure helpers (provisional PP-PENDING ids, …)
│   ├── history.js          ← legacy per-PC quote store (migrated on boot, being retired)
│   │ · audit & diff
│   ├── audit.js            ← append-only audit log writer/reader (file mode)
│   ├── diff.js             ← flat object diff for audit + admin preview
│   │ · PDF
│   ├── pdf-templates.js    ← built-in A4 quote templates + render pipeline (renderQuote)
│   ├── pdf-lines.js        ← pure ex-VAT presentation lines, reconciled to sale_base
│   ├── template-engine.js  ← tiny QWeb-style engine; output always HTML-escaped
│   ├── template-sanitizer.js ← rejects unsafe custom templates (scripts/external refs)
│   ├── cloud-pdf-templates.js ← custom templates stored in D1 (untrusted; sanitized on load)
│   │ · app infrastructure
│   ├── stats.js            ← pure statistics aggregator (computeStats)
│   ├── settings-validator.js ← validates settings:write payloads (known fields, bounds)
│   ├── settings-privacy.js ← redacts the D1 token out of settings:read
│   ├── logger.js           ← electron-log wrapper (rotating main.log)
│   ├── diagnostics.js      ← redacted support bundle (no token, no business data)
│   ├── error-scrubber.js   ← whitelist scrub of error payloads (never business data)
│   ├── error-reporter.js   ← opt-out scrubbed error reports via plain fetch
│   ├── app-updater.js      ← electron-updater events → renderer update:state
│   ├── userdata-migration.js ← one-time %APPDATA%\PackPrice → Quanto copy
│   └── admin-throttle.js   ← rate-limit for auth:verify-admin (dead UI path — §7)
│
├── renderer/               ← UI + pure calculation (no Node)
│   ├── index.html          ← single page; screens toggled via .hidden
│   ├── app.js              ← orchestration: DOM events, all IPC calls (legacy ES)
│   ├── calculo.js          ← PURE v4 pricing engine: calculatePack + helpers
│   ├── admin.js            ← catalog editor: pure renderers + controlled mutations (data-cfg-path)
│   ├── admin-extras.js     ← audit log / logs viewer / diff preview rendering
│   ├── change-format.js    ← diff entries → friendly Spanish (save/conflict/audit views)
│   ├── save-summary.js     ← old/new catalog diff grouped by entity (confirm-save modal)
│   ├── catalog-wizard.js   ← first-run wizard chrome (reuses admin render/mutation)
│   ├── wizard-validation.js ← pure per-step minimum gating (WIZARD_STEPS, wizardReady)
│   ├── history.js          ← quote history UI
│   ├── quote-inputs.js     ← pure inverse of collectInputs: planInputs/optFromPlan
│   ├── quote-reminder.js   ← startup banner: stale/expiring open quotes (pure seam)
│   ├── deposit.js          ← pure deposit ("señal") arithmetic + input parsers
│   ├── charts.js           ← hand-rolled SVG chart builders (no chart libraries)
│   ├── stats-view.js       ← stats object → chart inputs + KPI tiles (pure adapter)
│   ├── pdf-gallery.js      ← view-model for the PDF-template gallery (IPC-fed)
│   ├── data-status.js      ← data-source badge state machine (file/cloud/cache)
│   ├── dropdown.js         ← progressive-enhancement dropdown over native <select>
│   ├── format.js           ← DOM/format helpers (legacy ES)
│   └── styles.css          ← design tokens in :root, BEM-lite classes
│
└── tests/                  ← Vitest, English. One file per lib/renderer module (~57 files).
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

- `lib/*` modules are **pure where they can be** (e.g. `config-schema.js`,
  `diff.js`, `migrations.js`, `path-guard.js`, `stats.js`, `pdf-lines.js`,
  `template-engine.js`, `catalog-assembler.js`, `quote-drain.js`): no `fs`, no
  Electron, no globals. Store modules (`audit.js`, `history.js`, `logger.js`,
  `config-store.js`, `catalog-cache.js`, `quote-cache.js`, `quote-outbox.js`,
  `migration-loader.js`) may touch `fs` but must not import Electron UI.
  Network modules (`d1-client.js`, `error-reporter.js`) use an **injectable
  `fetch`** and run in main only.
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
| Business config (catalog) | file: `config-store.js` + `config-parser.js`; cloud: `cloud-bootstrap.js` → `cloud-catalog.js` / `catalog-writer.js` — each `config:*` handler routes on `settings.data_source` | NAS `config.js` **or** D1 entity tables | read / write / force-write / info |
| Saved quotes (shared) | `lib/quote-repo-file.js` / `lib/quote-repo-cloud.js` behind `quoteRepo(settings)` | folder of `<id>.json` next to `config.js`, **or** D1 `quote_payloads` | `create` / `get` / `list` / `search` / `replace` / `setStatus` / `setDepositPaid` / `delete` |
| Legacy per-PC quotes | `lib/history.js` | per-PC `presupuestos.json` | `save` / `list` / … — migrated into the shared store on boot, then retired |
| Audit log | file: `lib/audit.js`; cloud: `lib/cloud-history.js` (audit + snapshots + restore) | NAS append-only file **or** D1 `audit_log`/snapshots | `appendAuditEntry` / `readRecentEntries` / restore |
| Custom PDF templates | `lib/cloud-pdf-templates.js` + `lib/template-sanitizer.js` | D1 `pdf_templates` (untrusted shared HTML) | list / save — sanitized on load |
| Local settings | `settings:*` handlers + `settings-validator.js` / `settings-privacy.js` | `%APPDATA%` JSON | read (token redacted) / write |

The shared quote store is detailed in **§4.3b**; the record shape is below.

#### Saved quote record shape

Every quote — one `<id>.json` file in file mode, one `quote_payloads` row in
cloud mode — is the same canonical record:

```js
{
  id,           // PP-YYYY-NNNN — human, shared, identical across devices
  date,         // ISO created-at
  updated_at,   // ISO last-edit (sort + conflict)
  version,      // integer, starts at 1, bumped on each edit
  customer: { name, phone },
  pack_id,
  opt,          // raw builder inputs (options, addons, sizes, quantities/lines)
                // — what collectInputs() returns; absent on pre-Phase-A quotes
  result,       // computed snapshot (display + PDF without recompute)
  totals,       // { total_vat_inc, sale_base, vat, total_cost, margin }
  status,       // pending | accepted | rejected  (workflow; set without bumping version)
  status_ts,
  cloud_id,     // optional legacy UUID bridge (Phase-A cloud records)
  deposit,      // content: { pct, min_amount } — minimum deposit for this quote (renderer/deposit.js)
  deposit_paid  // workflow: { amount, at, by } | null — paid deposit; set only by setDepositPaid
}
```

`opt` is the key field: it stores the raw step-2 inputs so a quote can be
faithfully reopened and edited. A quote that lacks `opt` (saved before Phase A
was shipped) reopens read-only — never crashes.

#### Reopen-to-edit flow

```
history 'Reabrir'
  → main quotes:get → renderer app.js historyAction('open')
  → selectPack(pack_id) + renderPackInputs
  → applyInputs(planInputs(pack, opt))   // renderer/quote-inputs.js — pure, DOM-free
  → syncClientCard + recomputePreview + renderResult
  → state.editingQuoteId = id            // marks this as an edit, not a new quote
  → user edits step 2 and saves
  → persistCurrentQuote (editingQuoteId set; carries the conflict token)
  → quotes:save → quoteRepo.replaceQuote  // updates same entry: pins id/date,
                                          //   preserves status, bumps version
```

`renderer/quote-inputs.js` (`planInputs` / `optFromPlan`) is a pure, DOM-free
module — the inverse of `collectInputs`. It translates a saved `opt` into a
field-by-field plan that `applyInputs` uses to repopulate the step-2 builder.

**Rule:** no business logic does raw `fs.readFileSync` on these paths. Go through
the module. New persistence → new module with the same verb-style API.

#### 4.3b The shared quote repository seam

Quotes are a **shared** source of truth (Phase B): every device on the same
config sees and edits the same quotes. The renderer keeps calling the unchanged
`quotes:*` IPC; `main.js` `quoteRepo(settings)` picks the backend by
`settings.data_source` and exposes one verb API. The renderer never learns where
quotes live (hard rule §3) — the same Ports & Adapters seam the catalog uses.

```
renderer (app.js, history.js)
        │  window.packprice.{saveQuote,listQuotes,getQuote,updateQuote,deleteQuote,searchQuotes}
        ▼
main.js  quoteRepo(settings)  ── normalizes both conflict tokens into one opaque token
        ├── file mode  → lib/quote-repo-file.js    (<configDir>/presupuestos/<id>.json)
        └── cloud mode → lib/quote-repo-cloud.js    (D1 quote_payloads, via lib/cloud-quotes.js)
                                   │
                       lib/quote-cache.js   (per-PC mirror: fast list + offline read — NOT a write buffer)
                       lib/quote-outbox.js  (fullQuotes lane: cloud writes buffered while offline)
                       lib/quote-drain.js   (pure: route a queued CREATE vs EDIT on reconnect)
```

- **Source of truth** = the shared backend. **Cache** = a per-PC read mirror
  (`<userData>/cache/quotes.json`) for a fast list and a last-known offline view.
  **Outbox** = pending **cloud** writes (`<userData>/cache/outbox.json`,
  `fullQuotes` lane) drained on reconnect so a write is never lost.
- **Ids.** The human `PP-YYYY-NNNN` is canonical in both modes. Create is
  collision-safe across devices: file mode uses an exclusive `wx` create with a
  recompute-retry; cloud mode claims the id via `INSERT OR IGNORE` (`tryClaimFullQuote`)
  and retries on a lost race. An offline cloud CREATE gets a provisional
  `PP-PENDING-<uuid>` id reconciled to a real id when the outbox drains.
- **Conflict model (hard rule §6).** File = `mtime + sha256`; cloud = `version`
  (optimistic `UPDATE … WHERE version = ?`). `quoteRepo` returns an opaque token
  on `get`; the renderer round-trips it on edit. A stale write returns
  `{ conflict, current }` → the renderer offers Sobrescribir / Cancelar
  (reuses the catalog conflict UX). A status change is workflow, not a content
  edit, so `setStatus` and `setDepositPaid` (which also flips the status) do
  **not** bump the version. In cloud mode the payment lives in the additive
  `quote_deposits` table (`db/migrations/0003_quote_deposits.sql`), LEFT-JOINed
  onto the flat row on read; in file mode the token is a content hash, so a
  deposit write from another PC still moves it and an open editor gets the
  safe conflict dialog on its next save — `quotes:set-deposit` returns a fresh
  token so the SAME PC's editor stays consistent.
- **Offline behavior.** Cloud mode: an unreachable backend (`isBackendUnreachable`)
  queues the full quote and returns `{ queued: true }`; `quotes:list`/`search`
  fall back to the cache. File mode has **no drain** — a NAS-unreachable write
  surfaces an error (the renderer keeps the data on screen) rather than queue
  into a lane nothing drains.
- **Boot migration.** `lib/quote-migrate-local.js` pushes a PC's legacy per-PC
  `presupuestos.json` into the shared store once, idempotently (id-preserving
  `putQuoteIfAbsent`); on a clean file-mode run the source is renamed to
  `presupuestos.json.bak-pre-shared`. **Cloud-mode auto-migration is intentionally
  deferred** (legacy local quotes lack the flat stat fields the cloud backend
  requires; a correct backfill needs catalog-dependent tier derivation, id-bridging
  against the old UUID-keyed rows, and stats de-dup) — the local file is kept intact
  and the skip is logged.

The cloud payload lives in a **separate `quote_payloads` table** (the full
reopenable JSON + `version` + `updated_at`), not new columns on the flat `quotes`
stats row, so the additive migration (`db/migrations/0002_quote_payloads.sql`) is
idempotent by construction — `CREATE TABLE IF NOT EXISTS` re-execs cleanly,
whereas SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and the runner may
re-exec a file after a crash (`lib/db-migrator.js`). The flat `quotes` row keeps
feeding statistics and owns the authoritative status.

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

(File mode shown. In cloud mode the same `config:write` routes to per-entity,
version-guarded D1 writes with audit + snapshot — `lib/catalog-writer.js`, §10.)

**Admin catalog tab render (list ↔ editor):**

The four catalog tabs (products / packs / suppliers / addons) have two views
routed by `renderAdminTabContent(cfg, tab, view, id)` in `admin.js`:

- `view = 'list'` → `render<Entity>List(cfg, query)` — compact rows + search bar.
- `view = 'editor'` → `render<Entity>Editor(cfg, id)` — focused single-entity
  form with collapsible `<details>` sections.

`app.js`'s `showAdminTab(tab, opts)` decides which to call based on
`state.adminView` and `state.adminEditingId`. All transient UI state — current
view, entity id under edit, per-tab search text, collapsed section keys — lives
in `app.js` `state` (never in the DOM) and is re-applied after each full-tab
re-render. Non-catalog tabs (`parameters`, `tiers`, `audit`) ignore these fields
and render as before.

**App start:**

```
read settings (%APPDATA%) → resolve config path
  → if no config.js at the path (or freshly-provisioned empty D1):
        run the first-run catalog wizard (§6 "First-run bootstrap"),
        which builds the catalog from blank and persists it
  → read config from NAS/D1 → migrate → validate schema → strip admin password
  → hand CFG to renderer → render welcome or main screen
```

---

## 6. Business data lives outside code

Every number a business human might want to change — PVP per tier, margins, cost
parameters, admin password, company details — lives in `config.js` on the NAS,
**not in code**. A price change is a *data* change, never a deploy.

- `config.default.js` carries **no catalog**. It exports `SCHEMA_VERSION`
  (the v4 tag stamped into new configs), `PARAMETER_KEYS`, `DEFAULT_TARGET_MARGIN`
  (consumed by `lib/migrations.js`) and `buildEmptyConfig(meta)` — a
  schema-shaped but **empty** config (null parameters; empty
  suppliers/products/tiers/packs/addons; neutral company/quote_settings;
  placeholder admin password) that is intentionally invalid until the
  first-run **catalog wizard** fills the minimums (see "First-run bootstrap"
  below). There is no default seed and no demo catalog.
- **Corollary:** no domain numbers in `main.js`, `preload.js`, `app.js`, or
  `index.html`. A business number is *user* input collected by the wizard or
  the admin editor, persisted to `config.js`/D1, and read from `CFG` — never a
  literal in code.

### First-run bootstrap (the catalog wizard)

There is no default seed. A fresh install builds its catalog **from blank**
through a guided wizard, in both storage modes:

```
file mode:  no config.js at the chosen path
cloud mode: cloud:provision creates an empty migrated D1 (returns seeded:false)
                              │
                              ▼
   getEmptyConfig (config:empty) → buildEmptyConfig() held in memory
                              │
   catalog wizard (renderer/catalog-wizard.js): 7 steps —
   Costes → Tramos → Proveedores → Productos → Packs → Complementos → Empresa,
   every field blank, per-step minimum gating (renderer/wizard-validation.js),
   reusing the admin editor's render/mutation functions
                              │
   validateConfigSchema  (persist only when it passes)
                              │
   file  → createConfig (config:create): validated, atomic write, backup-by-create
   cloud → seedInitialCatalog (catalog:seed-initial): seeds D1 from the wizard catalog
```

The wizard launches from the local first-run flow, the cloud-provision success,
the settings "change location" flow (an empty new folder), and the error-screen
recovery button. New IPC: `config:empty`, `config:create`, `catalog:seed-initial`
(preload: `getEmptyConfig`, `createConfig`, `seedInitialCatalog`). The wizard
never writes a half-built config to shared storage — it assembles in memory and
persists once, after the schema minimums are met.

### Config schema (current — **v4**)

`buildEmptyConfig()` in `config.default.js` emits the canonical, documented v4
shape (with empty collections and null parameters); the fixture
`tests/fixtures/config-v4-full.js` (`buildFullConfigV4`) is a fully-populated v4
config used by tests. v2/v3 configs are migrated to v4 on read (§4.4) and never
seen downstream.

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
  quote_settings: { validity_days, terms, deposit_pct }
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

1. Add it to the `buildEmptyConfig()` scaffold in `config.default.js` (and to
   `buildFullConfigV4` in `tests/fixtures/config-v4-full.js`), and collect it in
   the first-run wizard / admin editor.
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
| `settings:write` / `quotes:save` input validation (`lib/settings-validator.js`) | reject malformed payloads at the IPC boundary |
| D1 API token lives in per-PC `settings.json`, main only; redacted from `settings:read` and diagnostics (`lib/settings-privacy.js`, `lib/diagnostics.js`) | the renderer — and any exported bundle — never sees the customer's Cloudflare token |
| no `eval`/`Function`/`vm`/dynamic `require` on user paths | prevent RCE via config |
| schema validation on every read | bad data fails fast, never produces `NaN` prices |
| PDF rendering only via the escaping engine (`lib/template-engine.js`); custom templates sanitized on load (`lib/template-sanitizer.js`) | shared, untrusted template HTML can never run script or load external resources |
| error reports whitelist-scrubbed (`lib/error-scrubber.js`), opt-out in settings | telemetry can never carry business data |
| auto-update reads only public GitHub Releases over HTTPS, main process only (`lib/app-updater.js`) | no private feed, no renderer involvement; trust anchor is HTTPS + GitHub |
| atomic config write (`.tmp` + rename) | an interrupted write leaves the original intact |
| backup before every admin write | recoverable from corruption or bad edit |
| conflict check before write (file: mtime+sha256; cloud: entity version) | no silent overwrite of another user's edit |
| admin password: **gate removed** — `auth:verify-admin`, its rate-limit (`lib/admin-throttle.js`) and the plaintext `admin.password` field are dead code pending a schema migration | it was anti-accidental-click, never security (`PLAN_Calculadora.md` §7.1); protection is now save-confirmation + audit + snapshot rollback. The password is still stripped before the config reaches the renderer. |

**Threat posture:** trusted users operating on storage they own (a LAN file or
their own Cloudflare account). The real risks are (a) a malformed/hostile
`config.js` or custom PDF template reaching code execution, (b) data loss, and
(c) the customer's API token or business data leaking outward. All are
mitigated above. Do not add auth, crypto, or hardening that the threat model
doesn't justify — that is its own kind of debt.

> **Accepted deferral — CSP `style-src 'unsafe-inline'`.** The CSP keeps
> `style-src 'self' 'unsafe-inline'` because the UI uses inline `style="..."`
> attributes pervasively. Tightening it would require sweeping the markup for an
> offline LAN app whose script surface is already locked down (`script-src
> 'self'`, no external origins). This is a conscious trade-off, not an oversight;
> revisit it if the UI is ever reworked.

**Never** sign the `.exe` with a borrowed or expired certificate. Publishing
is owner-sanctioned since 2026-06-12 (public GitHub repo, `.exe` on Releases —
see the decision log in `CLAUDE.md` §9); what must **never** be published:
secrets, tokens, the real NAS `config.js`, or any customer's D1 data.

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
  (`config:read`, `quotes:save`, `pdf:export`). All channel *names* are English
  already; some *payload field* names are still Spanish (`ruta`, `clave`,
  `titulo`…) until their migration wave retires them.
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
  6. `buildEmptyConfig()` — structural v4 keys survive refactors, collections
     empty / parameters null; `tests/fixtures/config-v4-full.js`
     (`buildFullConfigV4`) supplies the populated v4 config the other tests use.
  7. `wizard-validation` — per-step minimums (parametersComplete / stepErrors /
     wizardReady): blocks finishing without complete parameters / a tier /
     a supplier / a product / a pack; addons + company optional.
  8. `config-parser` / `config-schema` — malformed files, missing sections, v4 rules.
  9. `migrations.*` — round-trip v2→v3→v4, idempotency, missing-field errors.
- **Rule:** any change touching calculation or config schema ships with tests.
  Pure functions (§4.1) make this cheap — there is no excuse to skip it.
- **Intentionally untested:** thin DOM/orchestration files (`renderer/app.js`,
  `catalog-wizard.js`, `dropdown.js`, `format.js`, the history modal wiring)
  and `main.js`/`preload.js`. Logic worth testing gets extracted into a pure
  module first — don't write DOM tests, extract instead.
- E2E (Playwright on the packaged `.exe`) is deferred until the app justifies it.

---

## 10. Scalability & evolution path

The app is built for **2–3 users per company + the storage they own** (a NAS
file or their own D1). These are the *only* sanctioned growth seams; anything
beyond them needs a debate and a `CLAUDE.md` update.

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
- **Quote history at scale:** now a **shared** store behind `quoteRepo(settings)`
  (file folder or D1 `quote_payloads`; §4.3b). The repository API already hid the
  per-PC→shared swap; pagination/lazy reads over years of quotes are deferred to a
  real trigger.
- **Cloud storage (v5 — debated 2026-06-12, shipped in the 5.0.0-beta line):**
  the catalog and quotes can live in Cloudflare D1 (normalized tables) in
  *the customer's own account*, accessed **directly over Cloudflare's REST
  API — no Worker, no server-side code**; the app self-provisions the
  database on first run and applies bundled SQL migrations itself
  (`db/migrations/`, additive-only, idempotent, run by `lib/db-migrator.js`).
  Every invariant above holds: network only in the main process
  (`lib/d1-client.js`, injectable `fetch`), wired through
  `lib/cloud-bootstrap.js`; each `config:*`/`quotes:*` IPC handler routes on
  `settings.data_source` (`'file' | 'cloud'`) — there is no separate
  `config-backend.js` seam, the branch lives in the handlers; a pure
  `lib/catalog-assembler.js` converts entities ↔ the same v4 `cfg` object
  **in both directions** (it is also the local↔cloud migrator), so
  `calculo.js` and `validateConfigSchema` are untouched; writes are
  per-entity diffs (`lib/diff.js`) guarded by optimistic version checks
  (`UPDATE … WHERE version = ?`, `lib/catalog-writer.js`); offline =
  read-only from atomic local caches in `%APPDATA%` plus an outbox for
  quotes. Decision log in `CLAUDE.md` §9; full plan in
  `planes/v5-cloud-sync.md`; requirements in `docs/PRD.md`. The original
  workshop still runs file mode on its NAS; both modes are first-class and
  interchangeable at any time.
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
