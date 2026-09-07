# CLAUDE.md — Quanto

The operating manual for working in this repo. Read this first. It is short on
purpose: deep technical detail lives in **`ARCHITECTURE.md`**, and the agent
workflow lives in **`AGENTS.md`**. The goal is a **small, predictable,
low-maintenance** codebase that stays cheap to own for years, for a workshop of
2–3 technical users.

> **Operative, not aspirational.** If the code stops matching these docs, fix the
> code or fix the doc — never leave a silent gap.

## Documentation map

| Read this when you need… | File |
|---|---|
| The rules of the road (this file) | `CLAUDE.md` |
| Architecture, design patterns, invariants, scaling | `ARCHITECTURE.md` |
| How to work with Claude Code / subagents / workflow | `AGENTS.md` |
| The pricing model (formulas, packs, tiers) — spec'd on customer #1's numbers | `PLAN_Calculadora.md` |
| The English-migration plan (waves, key glossary) | `planes/migracion-codigo-ingles.md` |
| The v4 configurability plan (products/suppliers/addons, unified engine) | `planes/v4-configurabilidad-total.md` |
| Product requirements (what & why, success metrics) | `docs/PRD.md` |
| Design system + UI states (incl. v5 cloud states) | `docs/UI-UX.md` |
| The v5 cloud-sync plan (Cloudflare D1 direct REST, no server, cache, phases) | `planes/v5-cloud-sync.md` |
| Build & distribution | `README-build.md` |

---

## 1. What this is

An **Electron** desktop app that prices DTF (Direct-to-Film) textile
customization packs — built for one workshop, becoming a **product for many
companies, each owning and operating its own storage** (single PC, NAS, their
Cloudflare account, or their private cloud). **The developer never sees any
customer's data — he only ships software** (`docs/PRD.md` §1b). Each workshop
PC runs an installed `.exe` (per-user NSIS installer); the original workshop
(customer #1) shares one `config.js` on its NAS (`\\172.26.0.154\Paep\Packs\`).
No multi-tenant, no business-data telemetry (only opt-out error reports — §9),
**no server-side code at all**. The NAS file *is* the backend for file mode;
**v5 (in beta)** adds the second storage choice: Cloudflare D1 in *the
customer's own account*, talked to directly over Cloudflare's REST API and
self-provisioned by the app. Local and cloud are interchangeable at any time
(`planes/v5-cloud-sync.md`).

The config/engine is at **schema v4**: the whole catalog (products, suppliers,
addons, packs) is user-configurable from the admin UI. See `ARCHITECTURE.md` §6
for the shape and `PLAN_Calculadora.md` for the business model.

Currently **beta** (`-preview`/`-beta` version suffixes) — not V1.

## 2. The 10 hard rules

These prevent *major* problems (wrong prices, lost data, security regressions).
Read them before any change. Full rationale in `ARCHITECTURE.md` §7 and
`AGENTS.md` §1.

1. **Security invariants are sacred:** `contextIsolation: true`,
   `nodeIntegration: false`, CSP `default-src 'self'`, narrow preload surface,
   no `eval`/`Function`/`vm`/dynamic `require` on user paths. Don't weaken — ask.
2. **No domain numbers in code.** Prices, margins, parameters → `config.js`.
3. **Renderer never touches the filesystem, the network, or Node.** Only via
   `window.packprice.*` (IPC + preload).
4. **No silent error swallowing.** Fail-fast in main; show it in the renderer.
5. **No persisted-schema change without a backup + idempotent migration**
   (`lib/migrations.js` for local data; additive-only `db/migrations/*.sql` for D1).
6. **Keep the conflict checks** (file mode: mtime + sha256; cloud mode:
   per-entity version guard). Improve UX, don't remove.
7. **Tests ship with any calculation or schema change.**
8. **English code, Spanish user strings.** Incremental renames, never big-bang.
9. **No new deps/frameworks/TS/build steps** without debate + a doc update here.
10. **No `git --no-verify`/`--force`**; don't commit/push unless asked; never
    commit `node_modules/`, `dist/`, or the real NAS `config.js`.

## 3. Stack & non-negotiables

| Piece | Decision |
|---|---|
| Runtime | Electron + Node (main) + Chromium (renderer) |
| UI | HTML + CSS + vanilla JS — **no build step, no framework** |
| Shared persistence | user's choice: flat `config.js` (PC/NAS) **or** Cloudflare D1 in the customer's account, via REST from main (v5) — interchangeable (`settings.data_source`) |
| Local persistence | `settings.json` + catalog/quote caches + outbox in `%APPDATA%\Quanto\` |
| Cloud (v5) | **no server code**: `lib/d1-client.js` (native `fetch`, main only) + bundled SQL migrations in `db/migrations/` |
| Packaging | `electron-builder` NSIS installer (per-user) Windows x64 |
| Runtime deps | only the sanctioned two: `electron-log`, `electron-updater` (see §9) |
| **UI language** | **Spanish** (users are Spanish-speaking) |
| **Code language** | **English** — identifiers, comments, IPC channels, filenames |

**We do not add** (without a documented debate recorded in §9): UI frameworks,
TypeScript, bundlers, databases, backends/APIs, telemetry, or runtime
dependencies. The default answer is **YAGNI**.

> **Language migration:** much legacy code (`main.js`, `app.js`, `calculo.js`,
> `admin.js`, `config-parser.js`) is Spanish for historical reasons and migrates
> progressively (`planes/migracion-codigo-ingles.md`). **All new code is English
> from the first commit.** User-visible strings stay Spanish.

## 4. Design principles (the short version)

- **Business data outside code** (`ARCHITECTURE.md` §6). `config.default.js`
  carries no catalog: it exports the schema version and an empty scaffold
  (`buildEmptyConfig`) that the first-run wizard fills; there is no default seed.
- **Strict main/renderer separation** — Ports & Adapters at the preload boundary
  (`ARCHITECTURE.md` §2, §4.2).
- **Pure functions for all pricing** — `(cfg, input) → result`, no DOM, testable
  (`ARCHITECTURE.md` §4.1).
- **One place per concern** — filesystem only in `main.js`, version handling only
  in `lib/migrations.js`, persistence only behind repository modules. This is how
  debt stays out (`ARCHITECTURE.md` §11).
- **Write little, write explicit.** Comments explain *why*, not *what*. Three
  similar lines beat a premature abstraction. Delete before you add.

## 5. Project structure

```
main.js            ← main process: IPC handlers + fs/network orchestration
preload.js         ← the port: window.packprice.* whitelist (~50 named methods)
config.default.js  ← schema version + empty scaffold (buildEmptyConfig); no catalog seed
db/migrations/     ← bundled additive-only SQL migrations for cloud (D1) mode
lib/               ← ~40 pure/testable CommonJS modules (English), grouped by
                     concern: file config backend (config-parser/-schema/-store,
                     migrations, path-guard) · cloud D1 backend (d1-client,
                     db-migrator, cloud-bootstrap, cloud-catalog, catalog-writer/
                     -assembler/-cache, cloud-history) · shared quote store
                     (quote-repo-file/-cloud, cloud-quotes, quote-cache/-outbox/
                     -drain, quote-migrate-local, quote-store-helpers) · PDF
                     (pdf-templates, pdf-lines, template-engine/-sanitizer,
                     cloud-pdf-templates) · audit, diff, stats · app infra
                     (logger, diagnostics, error-scrubber/-reporter, app-updater,
                     settings-validator/-privacy, userdata-migration,
                     admin-throttle)
renderer/          ← UI + pure calc (no Node): app.js (orchestration), calculo.js
                     (pure pricing), admin.js/admin-extras.js/change-format.js/
                     save-summary.js (catalog editor), catalog-wizard.js/
                     wizard-validation.js (first run), history.js/quote-inputs.js/
                     quote-reminder.js/deposit.js (quotes), charts.js/stats-view.js (stats),
                     pdf-gallery.js, data-status.js, dropdown.js, format.js,
                     index.html, styles.css
tests/             ← Vitest (English), one file per module (~57 files)
```
Full per-module map and layering rules in `ARCHITECTURE.md` §3.

The production `config.js` is **not in this repo** — it lives on the NAS with
automatic `backups\` before every admin write.

## 6. Conventions

- `'use strict';` everywhere; `const` by default, never `var`; 2-space indent;
  semicolons; single quotes; CommonJS `require/exports`.
- IPC channels `<resource>:<action>`, kebab-case, English
  (`config:read`, `quotes:save`, `pdf:export`). Exposed preload methods English
  (`readConfig`, `saveQuote`). All channel *names* are English already; some
  *payload field* names are still Spanish (`ruta`, `clave`, `titulo`…) until
  their migration wave retires them.
- HTML ids kebab-case; CSS tokens in `:root`, BEM-lite classes; no utility-first.
- Config parsing: scan the JSON block + `JSON.parse`, then `validateConfigSchema`.
  **Never** `eval`/`Function`/`vm`/`require` on the external config.

## 7. Workflow

```bash
pnpm install     # once, or when package.json changed
pnpm dev         # run the app
pnpm test        # vitest run (pnpm test:watch to iterate)
pnpm build:win   # release: dist/Quanto-<version>-setup.exe
```

For any non-trivial change, follow the agent loop in `AGENTS.md` §2
(understand → plan → test-first → build → review) and the task protocols in
`AGENTS.md` §4. Bump `package.json:version` before a real release.

## 8. Definition of done

- `pnpm test` green (with new tests for calc/schema changes).
- `pnpm dev` smoke per the checklist below.
- No hard rule (§2) violated; minimal diff; no new deps.
- Docs updated if a rule, pattern, or schema changed.
- **Releases only:** devlog entry per `devlog/TEMPLATE.md` (screenshots +
  diagrams) published before distributing the `.exe`.

**Smoke checklist:** first run (delete `%APPDATA%\Quanto\`); crew pack T1
with/without hood; mixed pack with two quantities; admin conflict (edit config by
hand while an admin editor is open); señal: cambiar el porcentaje en el paso 3,
marcar pagada, guardar → historial en Aceptado con chip y PDF con las tres
filas; quitar desde el historial → Pendiente → deshacer; en nube, editar sin
conexión un presupuesto pagado no debe borrar la señal.

## 9. Documented debates (decision log)

Rule changes are recorded here, newest last. Each entry states the **decision**
and the constraints that remain **operative**; the full rationale lives in the
linked plan/spec. When a later debate supersedes part of an earlier one, the
earlier entry says so.

- **2026-06-12 — Cloud storage, no backend.** The catalog (and quotes) may live
  in Cloudflare D1 **in each customer's own account**, accessed directly over
  Cloudflare's REST API — **no Worker, no server-side code**; the app
  self-provisions the database (first-run wizard, guided API token). Operative:
  network calls **only in the main process** (renderer CSP untouched); the API
  token lives in per-PC `settings.json`, never committed, never in the
  renderer; the admin-mode password gate is removed (save-confirmation dialog +
  per-write author in the audit log + snapshot rollback instead); validation is
  client-side only (same trust model as the NAS file); schema migrations are
  app-applied, additive-only, with automatic pre-migration backup + restore
  fallback; file mode stays first-class and interchangeable; statistics use
  hand-rolled SVG (`renderer/charts.js`) — **no chart libraries**; the "no
  telemetry" rule is untouched (customer data in the customer's database).
  Anything beyond this (a Worker, other services, background sync, multi-tenant
  DB) reopens the debate. Design: `planes/v5-cloud-sync.md`; requirements:
  `docs/PRD.md`.
- **2026-06-12 — GitHub distribution.** The repo goes **public**; `main` is
  production; each release publishes the `.exe` on GitHub Releases. Before the
  repo flips public: sweep for secrets, and the owner decides which docs with
  real business numbers (`PLAN_Calculadora.md`, devlog) get published. (The
  startup "new version" notice this debate introduced was superseded by
  auto-update, 2026-06-24.)
- **2026-06-12 — Productization.** License **Apache-2.0** (business model is
  service, not license enforcement). `.exe` ships **unsigned** for now —
  SmartScreen is documented in the user manual. **Error-report telemetry is the
  one sanctioned exception to "no telemetry"**: unhandled main-process errors go
  to a developer-owned Sentry-compatible endpoint via plain `fetch` (no SDK),
  whitelisted fields only through a tested scrubber (`lib/error-scrubber.js`) —
  never business data — opt-out in settings, disclosed in the manual. PDF quote
  templates use a **tiny in-house template engine** (`lib/template-engine.js`,
  QWeb-style, no library); custom templates are shared data, sanitized on load
  (`lib/template-sanitizer.js`: no scripts, no external resources). (The
  "neutral demo catalog" part was superseded by first-run-from-blank,
  2026-06-16.)
- **2026-06-16 — Brand identity (Quanto).** Renamed **PackPrice → Quanto**
  everywhere a user can see it: `package.json` `productName`/`appId`
  (`com.quanto.calculadora`), window title, NSIS installer + shortcut,
  diagnostics filename; logo/wordmark/favicons in `assets/brand/`; brand color
  **Quanto Indigo** tokens (`--brand-500 #3D5AF1` …) in `renderer/styles.css`.
  Operative: **three technical identifiers stay `packprice`** and must not be
  renamed without a migration — the `window.packprice` IPC bridge, the persisted
  config marker `window.PACKPRICE_CONFIG`, and the Cloudflare D1 database name
  `packprice` (already provisioned in customer accounts).
  `lib/userdata-migration.js` copies a pre-rename `%APPDATA%\PackPrice` into
  `%APPDATA%\Quanto` once on boot (idempotent, copy-not-move). GitHub repo:
  `TermiSenpai/Quanto` (renamed 2026-06-17; set in `package.json`
  `build.publish`).
- **2026-06-16 — Packaging: portable → NSIS installer.** The Windows target is
  a **per-user one-click NSIS installer** (`build.nsis`): it runs from a real
  installed folder (fast startup, AV-safe), `perMachine: false` ⇒ no UAC
  prompt, and it unlocks `electron-updater` (portable doesn't support it).
  `pnpm build:win-portable` stays as an escape hatch. The `.exe` stays
  **unsigned**; code-signing options are noted in `README-build.md`.
- **2026-06-16 — First run builds the catalog from blank** (amends the "neutral
  demo catalog" decision). There is **no default seed and no demo catalog**.
  `config.default.js` exports only `SCHEMA_VERSION`, `PARAMETER_KEYS`,
  `DEFAULT_TARGET_MARGIN`, `ADMIN_PASSWORD_PLACEHOLDER` (dead schema-compat)
  and `buildEmptyConfig()`. A dedicated 7-step wizard
  (`renderer/catalog-wizard.js`, per-step gating in
  `renderer/wizard-validation.js`) walks Costes → Tramos → Proveedores →
  Productos → Packs → Complementos → Empresa, holds the config in memory, and
  persists only once the schema minimums pass: file → `config:create`
  (validated, atomic, backup); cloud → provision + `catalog:seed-initial`. The
  old catalog lives on as the test fixture `tests/fixtures/config-v4-full.js`.
- **2026-06-24 — Auto-update (electron-updater).** `electron-updater` is a
  sanctioned runtime dependency: it reads **public GitHub Releases**
  (`TermiSenpai/Quanto`) over HTTPS — still no Worker, no server-side code; the
  trust anchor is HTTPS + GitHub Releases (`.exe` still unsigned). Check and
  download run **only in the main process** (`lib/app-updater.js`;
  `electron-log` is the updater logger). UX: silent background download, then a
  non-blocking "Versión X lista · [Reiniciar e instalar ahora]" banner, with
  install-on-quit as fallback. Supersedes the manual notice
  (`lib/version-compare.js` and the GitHub `fetch` in `update:check` were
  removed). Anything beyond GitHub Releases (private feed, staged rollouts,
  code signing) reopens the debate. Design:
  `docs/superpowers/specs/2026-06-24-auto-update-electron-updater-design.md`.

## 10. Glossary

- **Pack peña / crew pack** — t-shirt + sweatshirt, one per person.
- **Tramo / tier (T1–T4)** — quantity range driving PVP and time reduction.
- **DTF** — Direct-to-Film print technique.
- **NAS** — workshop file server (`172.26.0.154`).
- **Admin mode** — legacy name for the config editor. The **password gate is
  removed** in both file and cloud mode (WIP toward the full v5 cleanup): the
  catalog editor opens directly, protected by save confirmation + audit +
  snapshot rollback instead. The `verifyAdminPassword` IPC (main), its
  rate-limit (`lib/admin-throttle.js`) and the `admin_password` config field
  remain as dead code pending a schema migration.
- **Saved quote / reopen-to-edit** — a quote stores the raw builder inputs as
  `opt` alongside `result` and `totals`, plus `version` (starts at 1) and
  `updated_at` (ISO). Reopening rebuilds the editable step-2 builder via
  `applyInputs` (using `renderer/quote-inputs.js`) so "Editar pedido" works;
  saving an edit updates the same entry (same id, bumped version), never a new
  one. Quotes are a **shared store** (Phase B): the source of truth moved from
  per-PC `presupuestos.json` to one of two interchangeable backends behind the
  unchanged `quotes:*` IPC — file mode = `<configDir>/presupuestos/<id>.json`
  next to `config.js` (`lib/quote-repo-file.js`); cloud mode = a `quote_payloads`
  table in the customer's D1 (`lib/quote-repo-cloud.js` + `lib/cloud-quotes.js`).
  `main.js` `quoteRepo(settings)` routes by `data_source` and normalizes the two
  conflict tokens (file = mtime+sha256; cloud = version) into one opaque token; a
  per-PC cache (`lib/quote-cache.js`) backs fast list/offline read and an outbox
  (`lib/quote-outbox.js` + `lib/quote-drain.js`) buffers cloud writes when the
  backend is unreachable. Never silently clobbers a concurrent edit (hard rule
  §2.6). Cloud-mode auto-migration of legacy local quotes is intentionally
  deferred (file mode migrates once on boot; see
  `devlog/15-presupuestos-compartidos/`).
  **Deposit (señal):** two more fields on the same record. `deposit = { pct,
  min_amount }` is **content** — the minimum owed before an order launches,
  `ceil(round2(total_vat_inc × pct))` in whole euros, computed only in
  `renderer/deposit.js` and saved with the draft like `totals`. `deposit_paid
  = { amount, at, by } | null` is **workflow**, written only by the
  `quotes:set-deposit` IPC → `setDepositPaid` (file: rewrites `<id>.json`;
  cloud: additive `quote_deposits` table LEFT-JOINed on read), which also
  flips `status` to accepted (paid) or pending (cleared) **without** bumping
  `version` — same rule as a status chip. `createQuote` strips a
  `deposit_paid` smuggled in a draft; `replaceQuote` pins it from the stored
  record, so an edit never touches the payment. File mode's conflict token is
  a content hash, so a deposit write from another PC still moves it: an open
  editor's next save shows the standard (safe) conflict dialog rather than a
  false "up to date". Design: `docs/superpowers/specs/2026-09-04-quote-deposit-design.md`.

---

*Update this document whenever a rule changes. When in doubt, prefer the more
readable, less abstract option — and ask before inferring.*
