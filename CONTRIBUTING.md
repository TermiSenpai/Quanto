# Contributing to PackPrice

PackPrice is a small, internal desktop tool for one workshop (2–3 users). The bar
is **low maintenance and high predictability**, not feature volume. Before
contributing, read, in this order:

1. [`CLAUDE.md`](CLAUDE.md) — the rules of the road (the 10 hard rules).
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the system is built and why.
3. [`AGENTS.md`](AGENTS.md) — the working loop (understand → plan → test → build → review).
4. [`PLAN_Calculadora.md`](PLAN_Calculadora.md) — the business model, if you touch pricing.

This file is the human-facing summary; the three above are authoritative.

## Setup

```bash
nvm use            # Node 22 (see .nvmrc)
pnpm install
pnpm dev           # launch the app
pnpm test          # vitest run
pnpm test:watch    # vitest in watch mode
```

The production `config.js` lives on the NAS and is **not** in this repo. On first
run the app seeds a local config from `config.default.js`.

## The non-negotiables

Full list and rationale in `CLAUDE.md` §3. The ones that cause *major* problems:

- **Security invariants are sacred** — `contextIsolation: true`,
  `nodeIntegration: false`, CSP `default-src 'self'`, narrow preload surface, no
  `eval`/`Function`/`vm`/dynamic `require`. Don't weaken; ask.
- **No domain numbers in code** — prices/margins/parameters go in `config.js`.
- **Renderer never touches Node/filesystem** — only via `window.packprice.*`.
- **No silent error swallowing** — fail-fast in main, show it in the renderer.
- **No persisted-schema change without a backup + idempotent migration.**
- **Tests ship with any calculation or schema change.**
- **English code, Spanish user-visible strings** — rename incrementally.
- **No new dependencies, frameworks, TypeScript, or build steps** without a
  documented debate in `CLAUDE.md`.

## Code style

Enforced by `.editorconfig`; spelled out in `CLAUDE.md` §6:

- `'use strict';`, `const` by default (never `var`), 2-space indent, semicolons,
  single quotes, CommonJS `require/exports`.
- IPC channels `<resource>:<action>`, kebab-case, English.
- Comments explain *why*, not *what*.

There is no linter wired up today (no runtime/dev deps beyond the essentials). If
the team decides it wants one, ESLint (flat config, `eslint:recommended`) is the
sanctioned choice — propose it in `CLAUDE.md` first, then add it.

## Commits & branches

- Branch off `main`; never commit directly to `main`.
- Conventional Commits style, matching the existing history:
  `feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`, `refactor(...)`, `test(...)`.
- Keep diffs minimal and scoped. The English migration is **wave-based** — one
  wave per PR, per `planes/migracion-codigo-ingles.md`. Don't bundle waves.
- Never use `git --no-verify`, `--force`, or `--force-with-lease` without explicit
  sign-off.

## Pull requests

Use the PR template. A PR is ready when the **Definition of Done**
(`AGENTS.md` §5) holds:

- [ ] `pnpm test` green (new tests for calc/schema changes).
- [ ] Smoke-tested via `pnpm dev` (`CLAUDE.md` §8 checklist: first run, crew
      pack T1 with/without hood, mixed pack with two quantities, admin conflict).
- [ ] No hard rule violated; minimal diff; no new deps.
- [ ] Docs updated if a rule, pattern, or schema changed (no silent divergence).
- [ ] `CHANGELOG.md` `[Unreleased]` updated for user-visible changes.

## Releases

See [`README-build.md`](README-build.md). In short:

1. Ensure `pnpm test` is green and the smoke checklist passes.
2. Bump `package.json:version` (keep the `-beta`/`-preview` suffix until V1).
3. Move `CHANGELOG.md` `[Unreleased]` into a dated version section.
4. `pnpm build:win` → `dist/PackPrice-<version>-*.exe`.
5. Distribute the new `.exe` to **all** PCs before anyone opens admin mode after a
   schema migration (see `planes/migracion-codigo-ingles.md` §8).

## Reporting bugs / requesting features

Open an issue with the relevant template. For anything security-sensitive, follow
[`SECURITY.md`](SECURITY.md) instead of filing a public issue.
