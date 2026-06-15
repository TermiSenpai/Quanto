# PackPrice

> **Language**: English · [Español](README.es.md)

Desktop calculator for quoting **DTF (Direct-to-Film) textile customization packs**. Designed for in-house workshop use: every PC runs the portable `.exe` and all of them share a single `config.js` on the company NAS.

> Current status: **beta** (`2.0.0-preview`). In internal use, pending finalization of provisional retail prices and a handful of polish items before tagging V1.

---

## What it does

- Calculates retail price, cost, margin and VAT for five pack types (peña, t-shirts only, hoodies only with/without hood, mixed hoodies).
- Applies volume tiers (T1–T4) with quantity-based discounts and labor-time reductions.
- Supports direct customer surcharges for large sizes (4XL, 5XL+) and an internal buffer for 3XL.
- Admin mode with shared password to edit parameters, prices and models without touching code.
- Conflict detection when two people edit `config.js` at the same time (`mtime + sha256` comparison, automatic backup before every write).
- Guided first-run: prompts the user's name and the path to `config.js` on the NAS, persists them in `%APPDATA%\packprice\settings.json`, and offers to seed `config.js` with default values if it doesn't exist.

---

## Stack and philosophy

| Piece              | Decision                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- |
| Runtime            | Electron + Node.js (main) + Chromium (renderer)                                       |
| UI                 | HTML + CSS + vanilla JS (no framework, no build step)                                 |
| Shared persistence | Plain `config.js` on the NAS, parsed in a sandbox (`vm.runInNewContext`, 1 s timeout) |
| Local persistence  | `settings.json` in `%APPDATA%\packprice\`                                             |
| Tests              | Vitest over the calculation logic and the config parser                               |
| Packaging          | `electron-builder` portable Windows x64                                               |
| Language           | Spanish (domain, comments, UI)                                                        |

Zero runtime dependencies. Only `electron`, `electron-builder` and `vitest` as `devDependencies`. Constraints, design principles and security invariants live in [CLAUDE.md](CLAUDE.md) (Spanish).

---

## Layout

```
packs app/
├── PLAN_Calculadora.md     ← functional plan and formulas (business source of truth, ES)
├── CLAUDE.md               ← working guide and conventions (ES)
├── README-build.md         ← how to build and distribute the .exe (ES)
├── README.md               ← this file (EN)
├── README.es.md            ← Spanish version of this file
├── LICENSE                 ← Apache 2.0
├── package.json
├── main.js                 ← Electron main process (filesystem + IPC)
├── preload.js              ← contextual bridge main↔renderer
├── config.default.js       ← seed for config.js
├── lib/
│   └── config-parser.js    ← isolated parser for the NAS config
├── renderer/
│   ├── index.html
│   ├── app.js              ← orchestration (events, bootstrap, IPC)
│   ├── calculo.js          ← pure calculation logic
│   ├── admin.js            ← admin-mode editor
│   ├── format.js           ← DOM/format helpers
│   └── styles.css
├── tests/                  ← Vitest over calculation, parser and default config
└── devlog/                 ← design and decision log (ES)
```

---

## Quick start

```bash
pnpm install        # first time only
pnpm dev        # iterate in development mode
pnpm test           # run tests
pnpm build:win  # build the portable .exe into dist/
```

Packaging details, distribution to other PCs and troubleshooting: [README-build.md](README-build.md) (Spanish).

---

## Roadmap

Past and planned versions. V4 is only on the table once the quantitative threshold below is crossed; everything else may happen sooner if needed.

| Version       | Status           | Scope                                                                                                                                  |
| ------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| V1 (web)      | Closed           | Browser prototype, no shared persistence                                                                                               |
| V2 (Electron) | **Current beta** | Desktop app, `config.js` on NAS, admin mode, conflict handling, backups                                                                |
| V2.x          | In progress      | Finalize provisional prices (hoodies), UI polish, more tests                                                                           |
| V3            | Planned          | Per-PC quote history (`localStorage`), PDF export                                                                                      |
| V4            | Conditional      | Local HTTP backend (Node + Express + SQLite) if more than ~5 users or cross-PC reporting is needed. Auto-update via `electron-updater` |

Decisions deliberately **out of scope today**: TypeScript, UI frameworks (React/Vue/Svelte), bundlers, telemetry, internationalization. Rationale and criteria for revisiting them: [CLAUDE.md §11](CLAUDE.md).

---

## Contributing

Internal project of a small business (2–3 users). Third-party PRs are not accepted by default. If you do touch the code:

1. Read [CLAUDE.md](CLAUDE.md) (conventions, principles, what NOT to do).
2. Read [PLAN_Calculadora.md](PLAN_Calculadora.md) if you're going to change business logic.
3. Run `pnpm test` before proposing changes.
4. Keep calculation functions pure and testable.

---

## License

[Apache License 2.0](LICENSE) — © 2026 Alejandro Escarpa Prieto.

---

## About

**PackPrice** was born in a DTF textile customization workshop in Guadalajara (Spain) with more than 25 years in the trade. The goal is very specific: quote the typical summer "packs de peña" (group merchandise orders) in seconds, keeping margins healthy and communicating consistent prices with volume discounts, without depending on scattered spreadsheets or whoever happens to pick up the phone.

The design prioritizes **clarity over flexibility**, **data outside the code** and **minimum maintenance**: if a price changes, the change is data, not a deployment. The app must remain understandable and editable by a single person five years from now.

- **Author**: Alejandro Escarpa Prieto
- **Context**: business, internal use, no telemetry, no cloud services
- **Principles**: YAGNI, fail-fast, Spanish in the domain, no build step

---

## Tags

`electron` · `desktop-app` · `windows` · `portable-exe` · `vanilla-js` · `nodejs` · `pricing-calculator` · `quote-calculator` · `dtf-printing` · `direct-to-film` · `textile` · `apparel` · `merchandise` · `print-shop` · `small-business` · `internal-tool` · `nas-shared-config` · `electron-builder` · `vitest` · `spanish` · `es-ES`
