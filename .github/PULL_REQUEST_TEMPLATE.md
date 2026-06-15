<!--
Keep PRs small and scoped. The English migration is wave-based: one wave per PR
(see planes/migracion-codigo-ingles.md). Don't bundle unrelated changes.
-->

## What & why

<!-- One or two sentences. What does this change and why is it needed? -->

## Type

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] refactor / migration wave
- [ ] test
- [ ] chore

## Definition of done (AGENTS.md §5)

- [ ] `pnpm test` is green (new tests added for calculation/schema changes)
- [ ] Smoke-tested with `pnpm dev` (CLAUDE.md §8: first run, crew pack T1
      with/without hood, mixed pack with two quantities, admin conflict)
- [ ] No hard rule violated (CLAUDE.md §3) — security invariants intact, no domain
      numbers in code, renderer doesn't touch Node/fs, no swallowed errors
- [ ] Minimal diff; no unrelated reformatting; **no new dependencies**
- [ ] Code in English, user-visible strings in Spanish; renames follow the
      glossary (planes/migracion-codigo-ingles.md §4)
- [ ] Docs updated if a rule, pattern, or schema changed (CLAUDE.md / ARCHITECTURE.md)
- [ ] `CHANGELOG.md` `[Unreleased]` updated for user-visible changes

## Schema / migration (if applicable)

- [ ] N/A
- [ ] Persisted-schema change goes through `lib/migrations.js`, is idempotent,
      backs up before write, and is covered by round-trip + double-apply tests
- [ ] Verified against a **copy** of the production config (never the live NAS file)

## Notes for the reviewer

<!-- Anything non-obvious: a workaround, a tradeoff, a follow-up. -->
