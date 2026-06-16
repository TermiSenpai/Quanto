# AGENTS.md — Working on Quanto with AI agents

How to drive work on this repository with Claude Code (and any coding agent).
`CLAUDE.md` is the operating manual (what the project is, the rules).
`ARCHITECTURE.md` is the technical reference (how it's built, the patterns).
**This file is the workflow:** which agents to use, in what order, and the strict
rules that keep an autonomous agent from causing a major problem.

> **Read order for any non-trivial task:** `CLAUDE.md` → the relevant section of
> `ARCHITECTURE.md` → `PLAN_Calculadora.md` (if business logic) →
> `planes/migracion-codigo-ingles.md` (if touching identifiers/schema).

---

## 1. The prime directives (read before any change)

These are non-negotiable. Violating one can cause a *major* problem — lost money
(wrong prices), lost data (clobbered NAS config), or a security regression.

1. **Never break a security invariant.** `contextIsolation: true`,
   `nodeIntegration: false`, CSP `default-src 'self'`, narrow preload surface, no
   `eval`/`Function`/`vm`/dynamic `require`. If a task seems to require weakening
   one, **stop and ask** — do not work around it.
2. **Never put domain numbers in code.** PVP, margins, parameters → `config.js`.
   (`ARCHITECTURE.md` §6.)
3. **Never let the renderer touch the filesystem or Node.** Go through an IPC
   handler + preload wrapper. (`ARCHITECTURE.md` §2–4.2.)
4. **Never silently swallow an error.** Fail-fast in main; show it in the
   renderer. (`ARCHITECTURE.md` §4.7.)
5. **Never rewrite persisted data without a backup + idempotent migration.** Any
   schema change goes through `lib/migrations.js`. (`ARCHITECTURE.md` §4.4.)
6. **Never remove the admin conflict check** (mtime + sha256). Improve UX instead.
7. **Tests ship with calculation/schema changes.** No exceptions.
8. **English code, Spanish user strings.** Migrate legacy identifiers
   incrementally, never big-bang. (`planes/migracion-codigo-ingles.md`.)
9. **Don't add dependencies, frameworks, TypeScript, or build steps** without a
   documented debate in `CLAUDE.md`. The answer is almost always YAGNI.
10. **Never run `git` with `--no-verify`, `--force`, or `--force-with-lease`**, and
    never commit/push unless explicitly asked. Never commit `node_modules/`,
    `dist/`, or the real NAS `config.js`.

If you are about to do something irreversible or outward-facing (write to the
NAS, delete a file you didn't create, push, publish), **confirm first**.

---

## 2. Default workflow loop

For any feature or fix, run this loop. Each step names the recommended subagent
(via the Task tool) — use them; a fresh subagent with a focused brief beats one
overloaded context.

```
  ┌─────────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐   ┌────────┐
  │ 1. UNDERSTAND│─►│ 2. PLAN  │─►│ 3. TEST  │─►│ 4. BUILD│─►│5. REVIEW│
  │   the code   │  │ the change│  │  first   │  │   it    │  │  it     │
  └─────────────┘   └──────────┘   └──────────┘   └────────┘   └────────┘
        explore        Plan agent      TDD          minimal      code-reviewer
        / Explore       + brainstorm   (red→green)   diff         + security
```

1. **Understand** — Before editing, map the affected code. Use the **`Explore`**
   agent (read-only, fast fan-out) or **`feature-dev:code-explorer`** for tracing
   execution paths. Don't start editing on a guess.
2. **Plan** — For anything multi-step, use the **`Plan`** agent or the
   **`superpowers:brainstorming`** skill *before* touching code. Confirm the
   approach with the user when there's a real fork.
3. **Test first** — Use **`superpowers:test-driven-development`** /
   **`backend-development:test-automator`**. For pricing and schema, write the
   failing test (with exact expected euros from `PLAN_Calculadora.md`) before the
   implementation.
4. **Build** — Smallest diff that passes. Match surrounding style. Follow the
   patterns in `ARCHITECTURE.md` §4 — don't invent a parallel one.
5. **Review** — Use **`code-reviewer`** (quality + conventions) and
   **`security-auditor`** / **`compound-engineering:review:security-sentinel`**
   when the change touches IPC, the preload surface, config parsing, or the
   filesystem.

Skip steps only for genuinely trivial edits (a typo, a comment). When in doubt,
don't skip.

---

## 3. Subagent playbook

Pick by task. These are available via the Task tool; the left column is the
`subagent_type`.

| When you are… | Use | Notes |
|---|---|---|
| Searching across many files for "where/how" | `Explore` | read-only, returns conclusions not file dumps |
| Tracing one feature's execution path | `feature-dev:code-explorer` | deep single-feature analysis |
| Designing a multi-file change | `feature-dev:code-architect` / `Plan` | blueprint before code |
| Writing or hardening tests | `backend-development:test-automator` | Vitest, English |
| Reviewing your own diff | `pr-review-toolkit:code-reviewer` / `code-reviewer` | run on the unstaged diff |
| Checking error handling / fallbacks | `pr-review-toolkit:silent-failure-hunter` | catches swallowed errors (directive #4) |
| Security pass on IPC/preload/config/fs | `backend-development:security-auditor` | run for any boundary change |
| Reviewing a data migration | `compound-engineering:review:data-migration-expert` | idempotency, backups, rollback |
| Reviewing JS for races/timing in the renderer | `compound-engineering:review:julik-frontend-races-reviewer` | async UI, DOM lifecycle |
| Simplifying after it works | `compound-engineering:review:code-simplicity-reviewer` | YAGNI / over-abstraction pass |
| Researching an Electron/Node API | `compound-engineering:research:framework-docs-researcher` + context7 MCP | prefer official docs over memory |

**Parallelism:** when you have 2+ *independent* read tasks (e.g. "map the admin
flow" and "map the history flow"), dispatch them in one message so they run
concurrently (`superpowers:dispatching-parallel-agents`). Never parallelize edits
that touch the same file.

---

## 4. Task-specific protocols

### 4.1 Touching pricing (`renderer/calculo.js`)
1. Read `PLAN_Calculadora.md` for the exact rule and a worked numeric example.
2. Write/extend `tests/calculo.test.js` with the expected euro amount **first**.
3. Implement as a **pure function** `(cfg, input) → result` — no DOM, no globals.
4. Run `pnpm test`. Then smoke `pnpm dev` with one case per pack type.
5. If you renamed identifiers, follow the English glossary in
   `planes/migracion-codigo-ingles.md` §4 — don't free-style names.

### 4.2 Adding a main-process capability (IPC)
1. `ipcMain.handle('<resource>:<action>', …)` in `main.js` — channel in English,
   kebab-case.
2. Expose a **named** wrapper in `preload.js` (never widen to `ipcRenderer`).
3. Call `await window.packprice.<verb>(…)` from the renderer.
4. Throw in main on failure (Spanish message); surface via dialog in renderer.
5. Security-review the new surface.

### 4.3 Changing persisted schema (config / quotes / settings / audit)
This is the highest-risk class of change. Follow `ARCHITECTURE.md` §4.4 exactly:
1. Bump `VERSION`; write the migrator in `lib/migrations.js`.
2. Make it **idempotent**; prove it with a round-trip + double-apply test.
3. Tagged backup before write; atomic backup→write; structured log line.
4. Lazy migration on read; validate after migrate.
5. Document rollback in `README-build.md`.
6. Verify against a **copy** of the production config before anything touches the
   real NAS. Never test migrations against the live `\\172.26.0.154` config.

### 4.4 Executing the English migration
It is **wave-based** (`planes/migracion-codigo-ingles.md`): one wave = one PR,
scoped, each leaving the app green. Don't merge two waves at once; don't rename a
key mid-wave outside its wave's glossary. Run the §5 `git grep` checklist before
finishing a wave.

### 4.5 UI / `renderer/index.html` + `styles.css`
- Single page, screens toggled with `.hidden`. ids in kebab-case.
- No inline scripts (CSP). No external resources.
- User-visible text stays Spanish.
- Check for async/DOM-lifecycle races on anything event-driven.

---

## 5. Definition of done

A change is done only when **all** hold:

- [ ] `pnpm test` is green (and new tests exist for calc/schema changes).
- [ ] `pnpm dev` smoke-tested per `CLAUDE.md` §12 (first run, crew pack T1
      with/without hood, mixed pack two quantities, admin conflict).
- [ ] No security invariant weakened (§1).
- [ ] No domain numbers added to code.
- [ ] Diff is minimal; no unrelated reformatting; no new deps.
- [ ] Code English, user strings Spanish; renames follow the glossary.
- [ ] `ARCHITECTURE.md` / `CLAUDE.md` / `PLAN_Calculadora.md` updated if a rule,
      pattern, or schema changed (no silent divergence).
- [ ] A reviewer subagent has passed the diff.

---

## 6. Red flags — stop and reconsider

If you catch yourself thinking any of these, pause:

| Thought | Reality |
|---|---|
| "I'll just weaken the CSP / sandbox to make this work" | That's a security regression. Find another way or ask. |
| "I'll hardcode this price/parameter for now" | It belongs in `config.js`. There is no "for now." |
| "A try/catch so it doesn't crash" | You're hiding a failure the user must see. |
| "I'll add a quick framework/util dependency" | YAGNI. Justify it in `CLAUDE.md` first or don't. |
| "I'll rewrite the whole file to English while I'm here" | Big-bang renames are unreviewable. One wave, one scope. |
| "I'll migrate the schema in place, backup later" | Backup is part of the migration, not after it. |
| "It probably still prices correctly" | Run the test with the exact euro amount. Don't guess about money. |
| "This abstraction will help later" | Three similar lines beat a premature abstraction. |
| "I'll test against the real NAS config" | Use a copy. Never the live file. |

---

## 7. Bootstrap prompts (copy-paste starting points)

**Implement a feature**
> Read `CLAUDE.md`, the relevant `ARCHITECTURE.md` section, and `PLAN_Calculadora.md`.
> Use `Explore` to map the affected code, then `Plan` to design the change. Write
> the failing Vitest tests first (exact euros from the plan), then the minimal
> implementation as pure functions. Run `pnpm test` and smoke `pnpm dev`.
> Finish with a `code-reviewer` + `security-auditor` pass. Don't break any §1
> invariant; ask if you think you need to.

**Fix a bug**
> Use `superpowers:systematic-debugging`. Reproduce with a failing test before
> proposing a fix. Keep the diff minimal. Re-run the full suite and smoke the
> affected flow. Update docs if an invariant or pattern was involved.

**Run a migration wave**
> Read `planes/migracion-codigo-ingles.md`. Execute exactly one wave, scoped to
> its file list and glossary. Keep the app green (`pnpm test` + smoke). Run the §5
> `git grep` checklist for that wave's keys before finishing. One PR, no
> unrelated renames.

---

*Keep this file in sync with `CLAUDE.md` and `ARCHITECTURE.md`. If the workflow
changes, change it here.*
