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
- The English-identifier migration (config schema v2 → v3) is planned and
  specified in `planes/migracion-codigo-ingles.md`; it has not landed yet.

---

[Unreleased]: https://github.com/TermiSenpai/packs-app/compare/main...HEAD
