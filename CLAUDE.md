# CLAUDE.md — PackPrice

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
| The business model (pricing, packs, tiers) — source of truth | `PLAN_Calculadora.md` |
| The English-migration plan (waves, key glossary) | `planes/migracion-codigo-ingles.md` |
| Build & distribution | `README-build.md` |

---

## 1. What this is

An **Electron** desktop app that prices DTF (Direct-to-Film) textile
customization packs. Each workshop PC runs a portable `.exe`; all share one
`config.js` on the company NAS (`\\172.26.0.154\Paep\Packs\`). No multi-tenant,
no public internet, no telemetry, no backend. The NAS file *is* the backend.

Currently **beta** (`-preview`/`-beta` version suffixes) — not V1.

## 2. Stack & non-negotiables

| Piece | Decision |
|---|---|
| Runtime | Electron + Node (main) + Chromium (renderer) |
| UI | HTML + CSS + vanilla JS — **no build step, no framework** |
| Shared persistence | flat `config.js` on the NAS |
| Local persistence | `settings.json` in `%APPDATA%\packprice\` |
| Packaging | `electron-builder` portable Windows x64 |
| **UI language** | **Spanish** (users are Spanish-speaking) |
| **Code language** | **English** — identifiers, comments, IPC channels, filenames |

**We do not add** (without a documented debate in this file): UI frameworks,
TypeScript, bundlers, databases, backends/APIs, telemetry, or runtime
dependencies. The default answer is **YAGNI**.

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
6. **Keep the admin conflict check** (mtime + sha256). Improve UX, don't remove.
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
config.default.js  ← default config seed (bootstrap only)
lib/               ← pure, testable modules (English): config-schema, diff,
                     audit, history, pdf-template, logger, config-parser, migrations*
renderer/          ← UI + pure calc: index.html, app.js, calculo.js, admin.js,
                     admin-extras.js, history.js, format.js, styles.css
tests/             ← Vitest (English), one file per module
```
`*` planned by the migration. Full map and layering rules in `ARCHITECTURE.md` §3.

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
pnpm build:win    # release: dist/PackPrice-<version>-*.exe
```

For any non-trivial change, follow the agent loop in `AGENTS.md` §2
(understand → plan → test-first → build → review) and the task protocols in
`AGENTS.md` §4. Bump `package.json:version` before a real release.

## 8. Definition of done

- `pnpm test` green (with new tests for calc/schema changes).
- `pnpm dev` smoke per the checklist below.
- No hard rule (§3) violated; minimal diff; no new deps.
- Docs updated if a rule, pattern, or schema changed.

**Smoke checklist:** first run (delete `%APPDATA%\packprice\`); crew pack T1
with/without hood; mixed pack with two quantities; admin conflict (edit config by
hand while an admin editor is open).

## 9. Glossary

- **Pack peña / crew pack** — t-shirt + sweatshirt, one per person.
- **Tramo / tier (T1–T4)** — quantity range driving PVP and time reduction.
- **DTF** — Direct-to-Film print technique.
- **NAS** — workshop file server (`172.26.0.154`).
- **Admin mode** — config parameter editor (shared password; anti-accidental-
  click, not security).

---

*Update this document whenever a rule changes. When in doubt, prefer the more
readable, less abstract option — and ask before inferring.*
