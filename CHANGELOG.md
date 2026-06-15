# Changelog

All notable changes to PackPrice are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/). The app is in **beta**, so
versions carry a pre-release suffix (`-preview` / `-beta`) until the owner marks
V1. The narrated, illustrated history lives in [`devlog/`](devlog/); this file is
the terse, release-oriented log.

## [Unreleased]

### Added
- `ARCHITECTURE.md` — technical reference: process model, design patterns,
  invariants, scalability path.
- `AGENTS.md` — Claude Code workflow: subagent playbook, task protocols, strict
  rules.
- Project meta files: `.editorconfig`, `.gitattributes`, `.nvmrc`,
  `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, GitHub issue/PR templates,
  CI workflow, Dependabot config.

### Changed
- `CLAUDE.md` rewritten in English and slimmed into an operating manual that
  indexes `ARCHITECTURE.md` and `AGENTS.md`.

## [4.0.0-beta] — beta

Schema and engine **v4**: the whole catalog is now user-configurable from the
admin UI. Narrated in [`devlog/12-v4-configurabilidad-total/`](devlog/12-v4-configurabilidad-total/README.md).

### Added
- **Configurable catalog.** New config sections, all editable from admin:
  - `suppliers` — provider registry (Roly, …).
  - `products` — replaces `roly_models`; each garment carries a `category`, a
    per-product `extra_cost_3xl`, a `target_margin`, a `suppliers[]` array (one
    `is_default`) and its own `prices` table (sides × tier).
  - `addons` — replaces the fixed `parameters.extra_*_eur`; each has `label`,
    `price`, `vat_included`, `cost`, `applies_to` (product categories or `*`).
- **Unified, config-driven pricing engine.** A single `calculatePack(cfg,
  packId, opt)` replaces the four hard-coded calculators. Each pack declares a
  `pricing_mode`: `'bundle'` (own `bundle_prices` keyed by option-combo × tier;
  input = number of packs) or `'components'` (each component priced from its
  product's `prices`; input = quantity per component; `free_components: true` =
  custom lines). Pack `options` (sides, hood, …) are declared in config; an
  option may carry `maps_product` to swap a component's product by value.
- **Recommended PVP.** `recommendedPrice` = round-up of `cost / (1 −
  target_margin)` to the next price ending in `parameters.price_rounding_ending`
  (e.g. `x,95`). Admin gains "Aplicar PVP recomendado" buttons.
- **v3 → v4 migration** in `lib/migrations.js` (`migrateConfigV3ToV4`), chained
  after v2 → v3 by `migrateConfig`; idempotent. Strict v4 validator in
  `lib/config-schema.js`.

### Changed
- **3XL is now a per-product internal cost.** The fixed
  `parameters.buffer_3xl_eur_pack` is gone; each product has `extra_cost_3xl`,
  applied conservatively (MAX over the products in the order) to internal cost
  via a `qty_3xl` input. It is **not** billed to the client. 4XL/5XL remain
  client surcharges.
- `parameters` lost `buffer_3xl_eur_pack` and the `extra_*_eur` keys; gained
  `default_target_margin` and `price_rounding_ending`.
- Tooling migrated from npm to **pnpm** (`pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `.npmrc` with `node-linker=hoisted`).

### Fixed
- Null-tier guard in every pack (an order below the first tier no longer crashes
  reading `tier.id`).
- `margin_pct` is now computed over the net base (`sale_base`), not the
  VAT-inclusive total.
- 4XL/5XL and 3XL quantities are bounded by the order size.

### Security
- IPC path allow-list (`lib/path-guard.js`); `settings:write` / `quotes:save`
  input validation; admin-password verification rate-limit.
- Config writes are atomic (`.tmp` + rename; `lib/config-store.js`).
- **Accepted deferral:** the CSP keeps `style-src 'unsafe-inline'` because the
  UI uses inline `style="..."` pervasively. Documented for an offline LAN app;
  `script-src 'self'` and `default-src 'self'` are unchanged.

## [2.0.0-preview] — beta

### Added
- Tier-1 "real professionalism": strict config schema validation
  (`lib/config-schema.js`), structured logging via `electron-log`
  (`lib/logger.js`), append-only admin audit log (`lib/audit.js`), flat object
  diff for audit and admin preview (`lib/diff.js`), local quote history
  (`lib/history.js`), and PDF export (`lib/pdf-template.js`).
- Vitest test suite covering calculation, config parsing/schema, diff, audit,
  history, logger, and PDF rendering.

### Notes
- Business model and pricing rules: see `PLAN_Calculadora.md`.
- The English-identifier migration (config schema v2 → v3) is specified in
  `planes/migracion-codigo-ingles.md`. It later landed and was extended to v4
  (see the `4.0.0-beta` entry above).

---

[Unreleased]: https://github.com/TermiSenpai/packs-app/compare/main...HEAD
