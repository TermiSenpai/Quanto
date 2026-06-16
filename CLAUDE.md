# CLAUDE.md — Quanto

The operating manual for working in this repo. Read this first. It is short on
purpose: deep technical detail lives in **`ARCHITECTURE.md`**, and the agent/AI
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
PC runs an installed `.exe` (per-user NSIS installer); the original workshop (customer #1) shares one
`config.js` on its NAS (`\\172.26.0.154\Paep\Packs\`). No multi-tenant,
no business-data telemetry (only opt-out error reports — see the debates
below), **no server-side code at all**. The NAS file *is* the backend
today; **v5 (approved, in progress)** adds a second storage choice: Cloudflare
D1 in *the customer's own account*, talked to directly over Cloudflare's REST
API and self-provisioned by the app. Local and cloud are interchangeable at
any time (`planes/v5-cloud-sync.md`).

The config/engine is at **schema v4**: the whole catalog (products, suppliers,
addons, packs) is user-configurable from the admin UI. See `ARCHITECTURE.md` §6
for the shape and `PLAN_Calculadora.md` for the business model.

Currently **beta** (`-preview`/`-beta` version suffixes) — not V1.

## 2. Stack & non-negotiables

| Piece | Decision |
|---|---|
| Runtime | Electron + Node (main) + Chromium (renderer) |
| UI | HTML + CSS + vanilla JS — **no build step, no framework** |
| Shared persistence | user's choice: flat `config.js` (PC/NAS) **or** Cloudflare D1 in the customer's account, via REST from main (v5) — interchangeable |
| Local persistence | `settings.json` + catalog cache + outbox in `%APPDATA%\Quanto\` |
| Cloud (v5) | **no server code**: `lib/d1-client.js` (native `fetch`, main only) + bundled SQL migrations in `db/migrations/` — zero new dependencies |
| Packaging | `electron-builder` NSIS installer (per-user) Windows x64 |
| **UI language** | **Spanish** (users are Spanish-speaking) |
| **Code language** | **English** — identifiers, comments, IPC channels, filenames |

**We do not add** (without a documented debate in this file): UI frameworks,
TypeScript, bundlers, databases, backends/APIs, telemetry, or runtime
dependencies. The default answer is **YAGNI**.

### Documented debates

- **2026-06-12 — Cloud storage, no backend (final form after same-day
  revision).** The catalog (and quotes) can live in Cloudflare D1 (normalized
  tables) **in each customer's own account**, accessed directly over
  Cloudflare's REST API — there is **no Worker and no server-side code**; the
  app self-provisions the database (first-run wizard, guided API token). The
  "no backends/APIs" rule stands. Motivation: out-of-workshop access, real
  traceability (audit + versioned snapshots in SQL), in-app statistics, and
  selling the app to other companies with zero per-customer infrastructure.
  Conditions that keep the rules intact: network calls **only in the main
  process** (renderer CSP untouched); the customer's API token lives in
  per-PC `settings.json`, never committed, never in the renderer; **the
  admin-mode password gate is removed in v5** — protection against mistakes
  is a save-confirmation dialog + per-write author in the audit log +
  snapshot rollback; validation is client-side only (same trust model as the
  NAS file); schema migrations are applied by the app itself, additive-only,
  with an automatic pre-migration backup + restore fallback; the file mode
  remains a first-class choice, interchangeable with cloud at any time.
  Statistics use hand-rolled SVG (`renderer/charts.js`) — no chart libraries.
  This is each company's own business data in its own database — the "no
  telemetry" rule is untouched. Anything beyond this (a Worker, other
  services, background sync, multi-tenant DB) reopens the debate. Full
  design: `planes/v5-cloud-sync.md`, requirements `docs/PRD.md`.
- **2026-06-12 — GitHub distribution.** The repo goes **public**; `main` is
  production; each release publishes the release `.exe` on GitHub Releases
  and the app shows a non-blocking "new version" notice on startup
  (toggleable, plus a manual "check now" button in settings). Before
  the repo flips public: sweep for secrets, and the owner decides which docs
  with real business numbers (`PLAN_Calculadora.md`, devlog) get published.
- **2026-06-12 — Productization.** License: **Apache-2.0** (business model is
  service, not license enforcement). `.exe` ships **unsigned** for now — the
  SmartScreen warning is documented with screenshots in the user manual.
  The default seed becomes a **neutral demo catalog** (the workshop's real
  catalog is archived to its NAS first — never lost, never published).
  **Error-report telemetry is the one sanctioned exception to "no
  telemetry"**: unhandled main-process errors go to a developer-owned
  Sentry-compatible endpoint via plain `fetch` (no SDK, no new deps),
  whitelisted fields only (stack, versions, OS — never business data, with a
  tested scrubber), opt-out in settings, disclosed in the manual. PDF quote
  templates use a **tiny in-house template engine** (QWeb-style HTML+CSS
  directives, no library); custom templates are shared data, sanitized on
  load (no scripts, no external resources).
- **2026-06-16 — Brand identity (Quanto).** Renamed **PackPrice → Quanto**
  (Spanish *cuánto* + *cuanto*/quantum — it answers *how much*, by *quantity
  tier*). Logo system lives in `assets/brand/`: a symbol of four ascending tiers
  (T1–T4, rising opacity) and a wordmark whose **Q tail flows into the "price
  line"** underline. Brand color **Quanto Indigo** — `--brand-500 #3D5AF1`
  (`-400 #6C82FF`, `-600 #2E44C8`), tokens in `renderer/styles.css`; chosen to
  sit between the UI accent blue and the pack violet so the app stays unified.
  App icon ships as root `icon.png` (the in-app window icon, `main.js`) and
  `icon.ico` (multi-size, embedded in the `.exe` via `build.win.icon`); favicon
  PNGs in `assets/brand/`. The wordmark is shipped **outlined to paths**
  (`quanto-wordmark.svg`) so it renders identically without Inter installed.
  The product identity ships as Quanto: `package.json` `productName`/`appId`
  (`com.quanto.calculadora`), the window title, the NSIS installer + shortcut,
  and the diagnostics filename. Because Electron derives the `%APPDATA%` folder
  from the product name, `lib/userdata-migration.js` copies a pre-rename
  `%APPDATA%\PackPrice` folder into `%APPDATA%\Quanto` once on boot so no PC
  loses its settings/quotes/outbox (tested, idempotent, copy-not-move). The
  rename swept all prose, comments and docs to Quanto; **three technical
  identifiers stay `packprice` for compatibility** and must not be renamed
  without a migration: the `window.packprice` IPC bridge (renderer↔main), the
  persisted config-format marker `window.PACKPRICE_CONFIG` (existing `config.js`
  files assign it), and the Cloudflare D1 database name `packprice` (already
  provisioned in customer accounts). The GitHub repo slug
  (`xkoistudio/packprice`, `main.js`) is pending the owner's rename.
- **2026-06-16 — Packaging: portable → NSIS installer.** The Windows target
  moves from `portable` to a **per-user one-click NSIS installer**
  (`build.nsis` in `package.json`). Motivation: the portable `.exe` is a
  self-extractor that unpacks ~85 MB to `%TEMP%` and runs from there — the
  dominant cause of slow startup (and AV-prone). The installer runs from a real
  installed folder (`%LOCALAPPDATA%\Programs\`), so startup is fast and stable.
  `perMachine: false` ⇒ no admin elevation ⇒ no UAC "unknown publisher" prompt.
  This also unlocks `electron-updater` (it does not support `portable`). No new
  runtime deps; `pnpm build:win-portable` stays as an escape hatch. The `.exe`
  stays **unsigned** for now (productization debate); SmartScreen guidance is in
  the user manual. Code-signing options (free self-signed trusted on the
  workshop PCs; SignPath/Certum/Azure for public distribution) are noted in
  `README-build.md`.

> **Language migration:** much legacy code (`main.js`, `app.js`, `calculo.js`,
> `admin.js`, `config-parser.js`) is Spanish for historical reasons and migrates
> progressively (`planes/migracion-codigo-ingles.md`). **All new code is English
> from the first commit.** User-visible strings stay Spanish.

## 3. The 10 hard rules

These prevent *major* problems (wrong prices, lost data, security regressions).
Full rationale in `ARCHITECTURE.md` §7 and `AGENTS.md` §1.

1. **Security invariants are sacred:** `contextIsolation: true`,
   `nodeIntegration: false`, CSP `default-src 'self'`, narrow preload surface,
   no `eval`/`Function`/`vm`/dynamic `require` on user paths. Don't weaken — ask.
2. **No domain numbers in code.** Prices, margins, parameters → `config.js`.
3. **Renderer never touches the filesystem or Node.** Only via
   `window.packprice.*` (IPC + preload).
4. **No silent error swallowing.** Fail-fast in main; show it in the renderer.
5. **No persisted-schema change without a backup + idempotent migration**
   (`lib/migrations.js`).
6. **Keep the admin conflict check** (file mode: mtime + sha256; cloud mode:
   per-entity `If-Match` version). Improve UX, don't remove.
7. **Tests ship with any calculation or schema change.**
8. **English code, Spanish user strings.** Incremental renames, never big-bang.
9. **No new deps/frameworks/TS/build steps** without debate + a doc update here.
10. **No `git --no-verify`/`--force`**; don't commit/push unless asked; never
    commit `node_modules/`, `dist/`, or the real NAS `config.js`.

## 4. Design principles (the short version)

- **Business data outside code** (`ARCHITECTURE.md` §6). `config.default.js` only
  seeds a missing `config.js`; after that the code never reads it again.
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
main.js            ← main process: IPC + filesystem
preload.js         ← the port: window.packprice.* whitelist
config.default.js  ← default config seed (bootstrap only; canonical v4 shape)
lib/               ← pure, testable modules (English): config-schema, diff,
                     audit, history, pdf-template, logger, config-parser,
                     config-store, migrations, path-guard
renderer/          ← UI + pure calc: index.html, app.js, calculo.js, admin.js,
                     admin-extras.js, history.js, format.js, styles.css
tests/             ← Vitest (English), one file per module
```
Full map and layering rules in `ARCHITECTURE.md` §3.

The production `config.js` is **not in this repo** — it lives on the NAS with
automatic `backups\` before every admin write.

## 6. Conventions

- `'use strict';` everywhere; `const` by default, never `var`; 2-space indent;
  semicolons; single quotes; CommonJS `require/exports`.
- IPC channels `<resource>:<action>`, kebab-case, English
  (`config:read`, `quotes:save`, `pdf:export`). Exposed preload methods English
  (`readConfig`, `saveQuote`). Legacy Spanish channels live until the renderer
  migration retires them.
- HTML ids kebab-case; CSS tokens in `:root`, BEM-lite classes; no utility-first.
- Config parsing: scan the JSON block + `JSON.parse`, then `validateConfigSchema`.
  **Never** `eval`/`Function`/`vm`/`require` on the external config.

## 7. Workflow

```bash
pnpm install          # if package.json changed
pnpm dev          # iterate
pnpm test             # vitest run
pnpm build:win    # release: dist/Quanto-<version>-*.exe
```

For any non-trivial change, follow the agent loop in `AGENTS.md` §2
(understand → plan → test-first → build → review) and the task protocols in
`AGENTS.md` §4. Bump `package.json:version` before a real release.

## 8. Definition of done

- `pnpm test` green (with new tests for calc/schema changes).
- `pnpm dev` smoke per the checklist below.
- No hard rule (§3) violated; minimal diff; no new deps.
- Docs updated if a rule, pattern, or schema changed.
- **Releases only:** devlog entry per `devlog/TEMPLATE.md` (screenshots +
  diagrams) published before distributing the `.exe`.

**Smoke checklist:** first run (delete `%APPDATA%\Quanto\`); crew pack T1
with/without hood; mixed pack with two quantities; admin conflict (edit config by
hand while an admin editor is open).

## 9. Glossary

- **Pack peña / crew pack** — t-shirt + sweatshirt, one per person.
- **Tramo / tier (T1–T4)** — quantity range driving PVP and time reduction.
- **DTF** — Direct-to-Film print technique.
- **NAS** — workshop file server (`172.26.0.154`).
- **Admin mode** — legacy name for the config editor. The **password gate is
  removed** in both file and cloud mode (WIP toward the full v5 cleanup): the
  catalog editor opens directly, protected by save confirmation + audit +
  snapshot rollback instead. The `verifyAdminPassword` IPC (main) and the
  `admin_password` config field remain as dead code pending a schema migration.

---

*Update this document whenever a rule changes. When in doubt, prefer the more
readable, less abstract option — and ask before inferring.*
