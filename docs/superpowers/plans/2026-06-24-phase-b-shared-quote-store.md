# Phase B — Shared Quote Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the quote source of truth from per-PC `presupuestos.json` to a **shared store** so every device on the same config sees and edits the same quotes — a `presupuestos/` folder next to `config.js` in file mode, and a D1 `quote_payloads` table in cloud mode — with offline-safe writes, conflict control, and a one-time migration of existing quotes.

**Architecture:** A unified **quote repository** behind the unchanged `quotes:*` IPC. `main` routes by `settings.data_source` to one of two adapters: `lib/quote-repo-file.js` (one `<id>.json` per quote, atomic writes, exclusive-create ids, mtime+sha conflict) or `lib/quote-repo-cloud.js` (full JSON in a new `quote_payloads` table, optimistic `version` guard; the existing flat `quotes` row keeps feeding stats/status). A lightweight per-PC mirror (`lib/quote-cache.js`) and the existing offline outbox keep listing fast and writes safe. Builds on Phase A's record shape (`opt`, `version`, `updated_at`).

**Tech Stack:** Electron (main = Node/CommonJS, renderer = vanilla ESM), D1 over REST (`lib/d1-client.js`, main-only), Vitest in Node (inject the client + base dir), pnpm. **Zero new dependencies.**

**Spec:** `docs/superpowers/specs/2026-06-24-shared-quotes-reopen-edit-design.md` (§4, §6).

**Prerequisite:** Phase A merged (the record already carries `opt`, `version`, `updated_at`; edits update the same id).

---

## Norms (must hold for every task)

- **No persisted-schema change without backup + idempotent migration.** The cloud
  migration is a `CREATE TABLE IF NOT EXISTS` (idempotent by construction — the
  runner re-execs a file on a crash between `exec` and the ledger insert,
  `lib/db-migrator.js`), applied under the existing pre-migration backup + verify
  contract (`cloud-bootstrap.provision`). The file backend keeps a pre-shared backup.
- **Keep the conflict check (hard rule §6).** File = mtime+sha; cloud = `version`.
  Reuse the `confirmConflict` dialog; never silently clobber a concurrent edit.
- **Renderer never touches fs/Node; main owns IO.** Both repos are `lib/` (main-only).
- **No silent error swallow.** A corrupt quote file is skipped in the list **and
  logged**; a corrupt outbox/cache surfaces a Spanish error.
- **Modes stay interchangeable.** The renderer contract is identical for file and
  cloud; switching modes must not lose access to quotes (each store is independent,
  like the catalog).
- **English code, Spanish strings. No new deps / TS / build step. No `--no-verify`. Commit only when asked.**

---

## File structure

**Created:**
- `lib/quote-repo-file.js` — file backend. CRUD over `<configDir>/presupuestos/<id>.json`.
  Pure-ish: takes the folder path; owns its `fs` (one place per concern, like `lib/history.js`).
- `lib/quote-repo-cloud.js` — cloud backend façade over `lib/cloud-quotes.js` + the
  injected D1 client; full-quote save/get/list/update keyed by the human id.
- `lib/quote-cache.js` — per-PC mirror (last list + reopened payloads) for fast/offline
  listing; atomic writes, mirroring `lib/catalog-cache.js`.
- `db/migrations/0002_quote_payloads.sql` — additive, idempotent migration.
- `tests/quote-repo-file.test.js`, `tests/quote-repo-cloud.test.js`,
  `tests/quote-cache.test.js`, `tests/quote-migrate-local.test.js`.

**Modified:**
- `lib/cloud-quotes.js` — add `saveFullQuote`/`getFullQuote`/`listFullQuotes`/
  `updateFullQuote` (payload table) beside the existing flat-row writers; human-id
  generation with unique-insert retry.
- `main.js` — `quotes:save|list|get|update|delete|search` route by mode to the
  repository; integrate cache + outbox + conflict result; one-time local→shared migration on boot.
- `renderer/app.js` — handle a conflict result on edit-save (`confirmConflict` →
  force overwrite); refresh the history list from the shared store; keep status/PDF working.
- `renderer/history.js` — list rows tolerate a shared entry (already shape-compatible).
- `lib/migration-loader.js` — picks up `0002` automatically (glob); verify no change needed.
- Docs: `CLAUDE.md`, `ARCHITECTURE.md`, `docs/PRD.md`, `docs/UI-UX.md`; devlog entry.

---

## Task B1: File backend — `lib/quote-repo-file.js`

**Files:**
- Create: `lib/quote-repo-file.js`
- Test: `tests/quote-repo-file.test.js`

**What:** CRUD over a quotes folder derived from the config path
(`path.dirname(configPath)` + `presupuestos`). Functions (all take the folder path):
- `createQuote(folder, draft)` — assign `PP-YYYY-NNNN` (scan folder for the year's
  max), write `<id>.json` with the exclusive **`wx`** flag; on `EEXIST`, recompute and
  retry (cap the retries, throw a Spanish error if exhausted). Atomic (`.tmp`+rename
  is unnecessary with `wx`, but use `.tmp`+rename for the body write then no clobber).
  Returns the saved quote (`version: 1`, `date`, `updated_at`).
- `getQuote(folder, id)` — read+parse `<id>.json`; return `{ quote, mtime, sha256 }`
  (the mtime+sha are the conflict token); `null` if absent.
- `listQuotes(folder)` — read the directory, parse each `*.json`, skip+log a corrupt
  file (never crash the list), return sorted newest-first by `date`.
- `searchQuotes(folder, query)` — `listQuotes` + the existing substring filter.
- `replaceQuote(folder, id, draft, expected)` — re-read; if `expected` (mtime/sha)
  given and the file changed → return `{ conflict: true }`; else overwrite, pin
  `id`+`date`, bump `version`, set `updated_at`, atomic write. Return `{ quote }`.
- `deleteQuote(folder, id)` — unlink; return the removed quote or `null`.
- `MAX_QUOTE_BYTES` reused (export from `lib/history.js` or re-declare).

**Tests (Node, real temp dir):**
- create→get→list round-trip; ids increment per year.
- exclusive-create: two `createQuote` with the same computed id never overwrite
  (simulate by pre-writing `<id>.json`, assert the second lands on the next id).
- `replaceQuote` with a stale `expected` token returns `{ conflict: true }` and does
  not write; with a fresh token it overwrites + bumps `version`.
- a corrupt `*.json` is skipped by `listQuotes` (and logged), others still listed.

**Commit:** `feat(quotes): file backend — shared presupuestos/ folder store`

---

## Task B2: Cloud migration `0002` + full-quote ops

**Files:**
- Create: `db/migrations/0002_quote_payloads.sql`
- Modify: `lib/cloud-quotes.js`
- Test: `tests/quote-repo-cloud.test.js` (or extend `tests/cloud-quotes.test.js`)

**What:**
- Migration (idempotent — separate table, **not** `ALTER … ADD COLUMN`, which SQLite
  cannot guard with `IF NOT EXISTS`):

  ```sql
  -- 0002_quote_payloads.sql — full reopenable quote JSON, separate from the flat
  -- stats columns in `quotes`. CREATE ... IF NOT EXISTS keeps the file idempotent
  -- (the runner may re-exec a file after a crash — lib/db-migrator.js).
  CREATE TABLE IF NOT EXISTS quote_payloads (
    quote_id TEXT PRIMARY KEY,
    payload  TEXT NOT NULL,
    version  INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  ```
- `lib/cloud-quotes.js` new ops (client injected):
  - `saveFullQuote(client, quote)` — INSERT the flat `quotes` row (reuse the existing
    `uploadQuote` row build) **and** `INSERT OR REPLACE INTO quote_payloads` the JSON
    (`version` 1). Idempotent on the human-id PK.
  - `getFullQuote(client, id)` — read the payload row + the flat row's `status`/
    `status_ts`; return the merged reopenable quote (status authoritative from `quotes`).
  - `listFullQuotes(client)` — read from the existing flat `quotes` columns only
    (id, client_name, total_vat_inc, status, ts) — no payload needed for the list.
  - `updateFullQuote(client, id, payload, expectedVersion)` — `UPDATE quote_payloads
    SET payload=?, version=version+1, updated_at=? WHERE quote_id=? AND version=?`;
    if `changes === 0` → `{ conflict: true }`; also update the flat `quotes` row's
    stat columns so stats stay correct. Return `{ quote, version }`.
  - Human-id generation: `nextCloudQuoteId(client, year)` — `SELECT id` for the year,
    compute max+1; the caller inserts with the id as PK and retries on a UNIQUE
    failure (mirrors the file backend's exclusive create).

**Tests (Node, fake D1 client):**
- migration runs once, re-run is a no-op (ledger), and re-exec of the file does not
  throw (CREATE IF NOT EXISTS).
- save→get round-trips the full payload (opt+result+customer); list reads the flat row.
- `updateFullQuote` with a stale `expectedVersion` returns `{ conflict: true }`;
  with the current version bumps to `version+1`.

**Commit:** `feat(quotes): cloud backend — quote_payloads table + full-quote ops`

---

## Task B3: Per-PC quote cache — `lib/quote-cache.js`

**Files:**
- Create: `lib/quote-cache.js`
- Test: `tests/quote-cache.test.js`

**What:** a small mirror under `<userData>/cache/quotes.json`, atomic (`.tmp`+rename),
mirroring `lib/catalog-cache.js`:
- `writeQuoteCache(userDataDir, { fetchedAt, list, payloads })` — store the last list
  + a small map of reopened payloads.
- `readQuoteCache(userDataDir)` — return the cache or `null`; corrupt → throw a Spanish
  error (surfaced, never silent).
- Purpose: fast list (avoid re-scanning the folder / re-querying D1 every open) and a
  last-known view when the cloud is briefly unreachable. **Not** a write buffer — that
  is the outbox.

**Tests (Node, temp dir):** write→read round-trip; missing file → `null`; corrupt →
throws a Spanish error.

**Commit:** `feat(quotes): per-PC quote cache mirror`

---

## Task B4: Route the `quotes:*` IPC through the repository

**Files:**
- Modify: `main.js`
- Test: covered by B1/B2/B3 unit tests + the smoke checklist (the IPC layer is thin wiring).

**What:** turn the six quote handlers into a thin selector:
- A `quoteRepo(settings)` helper returns the active backend:
  - file mode → bind `lib/quote-repo-file.js` to `quotesFolder(settings.config_path)`.
  - cloud mode → bind `lib/quote-repo-cloud.js` to a D1 client from `settings.cloud`.
- `quotes:save`:
  - new (no `draft.id`) → `createQuote`; edit (`draft.id`) → `replaceQuote`/`updateFullQuote`
    with the conflict token/version → return `{ ok:true, quote }` or `{ ok:false, conflict:true, current }`.
  - On an **unreachable** backend (cloud network error / NAS write fail) → enqueue to
    the outbox and return `{ ok:true, queued:true, quote }` (never lose the quote).
  - On success, update `lib/quote-cache.js`.
- `quotes:list`/`search` → backend list (fallback to the cache when the backend is
  unreachable); refresh the cache on success.
- `quotes:get` → backend get (fallback to the cache payloads).
- `quotes:update` (status patch) → keep the existing status path; in cloud mode it
  already mirrors via `quotes:set-status` (unchanged).
- `quotes:delete` → backend delete.
- Keep `SETTINGS_DIR` only for the cache + outbox + the legacy file (no longer the
  source of truth). `preload.js` is unchanged (same channels).

**Acceptance:** with two app instances pointed at the same config (file or cloud), a
quote saved on one appears in the other's history after a refresh; an edit on one is
visible on the other.

**Commit:** `feat(quotes): route quote IPC through the shared repository`

---

## Task B5: One-time migration of existing per-PC quotes

**Files:**
- Modify: `main.js` (boot hook)
- Create: `tests/quote-migrate-local.test.js`
- (logic in a small `lib/quote-migrate-local.js` helper for testability)

**What:** on boot, if a per-PC `presupuestos.json` exists and a shared store is
configured, push each entry into the shared store **idempotently**:
- skip an entry whose id already exists in the shared store (so re-runs and
  multi-PC boots don't duplicate),
- on success, rename the local file to `presupuestos.json.bak-pre-shared` (kept as a
  safety copy; never deleted by the app).
- Best-effort and logged: a migration hiccup must not block boot (hard rule §4 — log it).

**Tests (Node):** migrating a fixture history into a temp file store inserts each
quote once; a second run inserts nothing (idempotent); the backup file is created.

**Commit:** `feat(quotes): migrate existing per-PC quotes into the shared store`

---

## Task B6: Renderer — conflict dialog on edit + shared-list refresh

**Files:**
- Modify: `renderer/app.js`

**What:**
- `persistCurrentQuote`/`saveCurrentQuote`: when `quotes:save` returns
  `{ conflict:true, current }`, show `confirmConflict` ("Otro equipo cambió este
  presupuesto") with **Sobrescribir / Cancelar**; on overwrite, re-save with a
  `force` flag (backend skips the token/version check). Mirror the catalog conflict UX.
- When `{ queued:true }`, toast "Guardado · se sincronizará al reconectar".
- `refreshHistory` already calls `listQuotes` — now backed by the shared store; no
  shape change (rows already read `q.totals`/`q.customer`).
- Reopen (Phase A) already pulls the full record via `getQuote`; in cloud mode this
  now returns the payload-backed quote.
- Status chips + PDF paths unchanged (status stays authoritative in the flat `quotes`
  row / local entry).

**Tests:** none (DOM glue); smoke checklist.

**Commit:** `feat(quotes): conflict-aware edit + shared history refresh`

---

## Task B7: Id unification — human id canonical, retire the `cloud_id` bridge

**Files:**
- Modify: `renderer/app.js` (`buildCloudQuote` no longer mints a UUID; the save flow
  uses the id the repository assigns), `lib/cloud-quotes.js` (accept the human id as PK).

**What:**
- New cloud quotes use the human `PP-YYYY-NNNN` as `quotes.id` and
  `quote_payloads.quote_id` (assigned by the repository, unique-retry on collision).
- `quotes:save` returns the assigned id; the renderer already trusts `saved.id`.
- Phase-A records that still carry a `cloud_id` UUID keep working (read tolerates
  both); no destructive change to existing rows.

**Tests:** `lib/cloud-quotes.js` assigns and round-trips a human id; a UNIQUE
collision retries to the next id.

**Commit:** `refactor(quotes): unify on the human-readable shared id`

---

## Task B8: Docs, devlog, smoke

**Files:**
- Modify: `CLAUDE.md` (quotes are now shared; the two backends; conflict model),
  `ARCHITECTURE.md` (repository seam + `quote_payloads`), `docs/PRD.md` (shared quotes
  requirement), `docs/UI-UX.md` (conflict + queued states). Update the spec status.
- Create: `devlog/<n>-presupuestos-compartidos/README.md` per `devlog/TEMPLATE.md`
  (screenshots + a diagram of the repository seam) — required before distributing a build.

**Smoke checklist (manual, two instances on the same config):**
- File mode: save on A → appears on B after refresh; edit on B → A sees the change;
  delete on A → gone on B; simulate a stale edit → conflict dialog.
- Cloud mode: same four, plus save while offline → queued toast → drains on reconnect.
- Upgrade path: a PC with an existing `presupuestos.json` boots → its quotes appear in
  the shared store once; `.bak-pre-shared` exists.

**Commit:** `docs(quotes): shared quote store + devlog`

---

## Self-review notes (coverage)

- Spec §4 repository seam → B4. §6.1 file backend → B1. §6.2 cloud migration+ops → B2.
  §6.3 cache+outbox → B3 + B4. §6.4 migrate existing → B5. §6.5 id unification → B7.
  §5 conflict UX → B6. §7 norms enforced per task. §9 testing → each task's tests.
- Migration idempotency resolved via a separate `quote_payloads` table (not
  `ALTER … ADD COLUMN`), consistent with `lib/db-migrator.js`'s contract.

---

## Future improvements (designed to be additive)

- **List pagination + a cache index** for years of quotes over the NAS (B3 is a simple
  mirror; an index keyed by year/month avoids parsing every file).
- **Soft-delete / archive** (`archived_at`, like the catalog) instead of hard unlink —
  recover an accidentally deleted quote; in cloud, a flag column on `quote_payloads`.
- **Per-quote audit + version history** — reuse the catalog's audit/snapshot pattern so
  you can see who changed a quote and roll one back (`version` is already tracked).
- **Near-real-time refresh** — short poll / folder-mtime watch so a teammate's new quote
  appears without a manual refresh.
- **Quote version history** — keep prior payloads per id (a `quote_payload_versions`
  table / `<id>/v<n>.json`), enabling "compare with previous".
- **"Save as copy"** — the second edit-save option, once update-same is proven.
