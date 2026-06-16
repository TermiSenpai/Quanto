# Quanto

> **Language**: English · [Español](README.es.md)

Desktop calculator for quoting **DTF (Direct-to-Film) textile customization packs**. Each PC runs an installed app (per-user installer); the shared catalog lives either in a single `config.js` on the company NAS **or** in **Cloudflare D1 inside the customer's own account** — the two are interchangeable at any time, with **no developer backend** in between.

> Current status: **beta** (`5.0.0-beta`). In internal use; the v5 cloud-sync (optional Cloudflare D1 storage, in the customer's own account) is in progress. Not yet tagged V1.

---

## What it does

- Calculates retail price, cost, margin and VAT for the workshop's pack types (peña, t-shirts only, hoodies with/without hood, mixed) — the whole catalog is user-configurable (schema v4).
- Applies volume tiers (T1–T4) with quantity-based discounts and labor-time reductions.
- Supports direct customer surcharges for large sizes (4XL, 5XL+) and an internal buffer for 3XL.
- Catalog editor (products, suppliers, add-ons, packs, prices, margins, quote texts) — all editable from the app, no code. The admin-password gate was removed in v5; mistakes are guarded instead by a save-confirmation, a per-write author in the audit log and snapshot rollback.
- Conflict detection when two people edit at the same time (file mode: `mtime + sha256`; cloud mode: per-entity version), automatic backup/snapshot before every write.
- Guided first-run: prompts the user's name and the path to `config.js` on the NAS, persists them in `%APPDATA%\Quanto\settings.json`, and offers to seed `config.js` with default values if it doesn't exist.

---

## Stack and philosophy

| Piece              | Decision                                                                              |
| ------------------ | ------------------------------------------------------------------------------------- |
| Runtime            | Electron + Node.js (main) + Chromium (renderer)                                       |
| UI                 | HTML + CSS + vanilla JS (no framework, no build step)                                 |
| Shared persistence | `config.js` on PC/NAS (scan its JSON block + `JSON.parse` + schema validation — no `eval`/`vm`) **or** Cloudflare D1 in the customer's own account (REST from main, no server) |
| Local persistence  | `settings.json` in `%APPDATA%\Quanto\`                                             |
| Tests              | Vitest over the calculation logic and the config parser                               |
| Packaging          | `electron-builder` per-user NSIS installer, Windows x64                               |
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
├── lib/                    ← pure, testable modules (config parser/schema,
│                             cloud D1 client, migrations, pdf, audit, diff…)
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
pnpm build:win  # build the per-user installer into dist/
```

Packaging details, distribution to other PCs and troubleshooting: [README-build.md](README-build.md) (Spanish).

---

## Versions

| Version       | Status           | Scope                                                                            |
| ------------- | ---------------- | -------------------------------------------------------------------------------- |
| V1 (web)      | Closed           | Browser prototype, no shared persistence                                         |
| V2 (Electron) | Closed           | Desktop app, `config.js` on NAS, conflict handling, backups                      |
| V3            | Closed           | Per-PC quote history + PDF export                                                |
| V4            | Closed           | Fully user-configurable catalog (products, suppliers, add-ons, packs)            |
| V5            | **Current beta** | Optional Cloudflare D1 storage in the customer's own account (no backend), in-app stats, audit + snapshots, productization (public repo, Apache-2.0); admin password removed |

Deliberately **out of scope**: a server/backend of our own, TypeScript, UI frameworks, bundlers, business telemetry. Rationale and the documented debates: [CLAUDE.md](CLAUDE.md).

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

**Quanto** was born in a DTF textile customization workshop in Guadalajara (Spain) with more than 25 years in the trade. The goal is very specific: quote the typical summer "packs de peña" (group merchandise orders) in seconds, keeping margins healthy and communicating consistent prices with volume discounts, without depending on scattered spreadsheets or whoever happens to pick up the phone.

The design prioritizes **clarity over flexibility**, **data outside the code** and **minimum maintenance**: if a price changes, the change is data, not a deployment. The app must remain understandable and editable by a single person five years from now.

- **Author**: Alejandro Escarpa Prieto
- **Context**: business, internal use, no business telemetry; optional cloud only in the customer's own account (no developer backend)
- **Principles**: YAGNI, fail-fast, Spanish in the domain, no build step

---

## Tags

`electron` · `desktop-app` · `windows` · `nsis-installer` · `vanilla-js` · `nodejs` · `pricing-calculator` · `quote-calculator` · `dtf-printing` · `direct-to-film` · `textile` · `apparel` · `merchandise` · `print-shop` · `small-business` · `internal-tool` · `nas-shared-config` · `electron-builder` · `vitest` · `spanish` · `es-ES`
