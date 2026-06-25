# Shared Quotes & Reopen-to-Edit — Design

**Date:** 2026-06-24
**Status:** Approved (high-level). Delivered in two phases, each with its own plan.
**Plans:** `docs/superpowers/plans/2026-06-24-phase-a-reopen-and-edit.md`,
`docs/superpowers/plans/2026-06-24-phase-b-shared-quote-store.md`

---

## 1. Summary

Two reported problems share one root cause: **quotes are stored per-PC and only
as a display snapshot, never as a first-class reopenable record.**

1. **Bug — reopen cannot be edited.** Reopening a saved quote
   ([app.js `historyAction` → `'open'`](../../../renderer/app.js)) only calls
   `renderResult()` and jumps to the breakdown screen. It never rebuilds the
   step-2 builder, and the saved draft
   ([`buildQuoteDraft`](../../../renderer/history.js)) stores the computed
   `result` but **not the raw inputs (`opt`)**. So "Editar pedido" returns to an
   empty/stale builder and the original data is lost.
2. **Gap — quotes are not shared across devices.** In file mode the history
   lives in per-PC `%APPDATA%\Quanto\presupuestos.json`
   ([lib/history.js](../../../lib/history.js)); in cloud mode quotes are mirrored
   to D1 only as **flat statistics rows** ([lib/cloud-quotes.js](../../../lib/cloud-quotes.js)),
   which are lossy and not reopenable.

**Solution.** Make a quote a first-class, reopenable, **shared** record, behind a
unified "quote repository" with two interchangeable backends (a folder next to
the config in file mode; a D1 payload column in cloud mode), backed by a per-PC
cache + offline outbox. The reopen bug is fixed by the same data-model change
that sharing needs, so it ships first as the foundation.

### Decisions (confirmed with the owner)

| Topic | Decision |
|---|---|
| Cross-device capability | **View *and* edit** (requires conflict control). |
| Saving an edit | **Update the same quote** (same id); no "save as copy" for now. |
| File-mode location | A **`presupuestos/` folder next to `config.js`**, one JSON per quote. |

---

## 2. Current state (anchors)

- **Mode:** `settings.data_source` is `'file'` (default) or `'cloud'`. File path in
  `settings.config_path`; cloud creds in `settings.cloud`.
- **Local history:** `lib/history.js` → `<userData>/presupuestos.json`, single JSON
  array, ids `PP-YYYY-NNNN`. IPC `quotes:save|list|get|update|delete|search`
  ([main.js](../../../main.js) ~L1191–1253), all bound to `SETTINGS_DIR`.
- **Cloud quotes:** `lib/cloud-quotes.js` writes flat rows to `quotes`/`quote_items`/
  `quote_addons` (db/migrations/0001_init.sql), for **stats + status only**.
- **Save flow:** `persistCurrentQuote` → `buildQuoteDraft` (stores `result`,
  `totals`, `customer`, `pack_id`, not `opt`) → `quotes:save`; cloud mirror via
  `buildCloudQuote` + `quotes:upload` (best-effort, enqueues offline).
- **Reopen flow:** `'open'` → `getQuote` → `renderResult` → `goToScreen('resultado')`.
  No builder rebuild.
- **Inputs:** `collectInputs()` ([app.js](../../../renderer/app.js) ~L1780) returns the
  `opt` object the engine consumes; there is **no inverse** today.
- **Conflict pattern (reuse):** catalog uses mtime+sha (file) / per-entity `version`
  (cloud) + `confirmConflict` dialog — hard rule §6.
- **Cloud orchestration pattern (reuse):** shared source of truth + per-PC cache +
  offline outbox + additive migrations with pre-migration backup
  ([lib/cloud-bootstrap.js](../../../lib/cloud-bootstrap.js)).

---

## 3. The canonical quote record

One shape, written by both backends, sufficient to **list, reopen, edit, and PDF**
on any device:

```
{
  id,             // PP-YYYY-NNNN — human, shared, identical across devices
  date,           // ISO created-at
  updated_at,     // ISO last-edit (conflict control + sort)
  version,        // integer, bumped on each edit (cloud optimistic concurrency)
  user,           // author of the last write
  config_version, // catalog version it was computed under (already snapshotted)
  customer: { name, phone },
  pack_id,
  opt,            // NEW: raw builder inputs (options, addons, sizes, packs/quantities/lines)
  result,         // computed snapshot (fast display + PDF without recompute)
  totals,         // { total_vat_inc, sale_base, vat, total_cost, margin }
  valid_until,
  status,         // pending | accepted | rejected
  status_ts
}
```

`opt` is the only **new required** field versus today; everything else already
exists in the draft. `opt` is what unlocks faithful reopen+edit.

- **File backend:** the whole record is the file `<configDir>/presupuestos/<id>.json`.
- **Cloud backend:** the record's full JSON is stored in a **new `quote_payloads`
  table** (one row per quote: `quote_id`, `payload`, `version`, `updated_at`),
  separate from the flat `quotes` row, which keeps feeding statistics/status. A
  separate table (not new columns on `quotes`) is what keeps the migration
  idempotent — `CREATE TABLE IF NOT EXISTS` re-execs cleanly, whereas SQLite has no
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (the runner may re-exec a file after a
  crash — `lib/db-migrator.js`). `version` drives optimistic concurrency.

---

## 4. Architecture — unified quote repository

The renderer keeps calling the **same IPC** (`quotes:*`). `main` routes each call
to the active backend by `settings.data_source`. The renderer never learns where
quotes live (hard rule §3).

```
renderer (app.js, history.js)
        │  window.packprice.{saveQuote,listQuotes,getQuote,updateQuote,deleteQuote,searchQuotes}
        ▼
main.js  (quote IPC — thin wiring, picks backend by mode)
        ├── file mode  → lib/quote-repo-file.js   (folder of <id>.json next to config)
        └── cloud mode → lib/quote-repo-cloud.js   (D1 payload, via lib/cloud-quotes.js)
                                   │
                       lib/quote-cache.js  (per-PC mirror: fast list + offline view)
                       lib/quote-outbox.js (offline writes; drained on reconnect — already exists)
```

- **Source of truth** = the shared backend. **Cache** = a per-PC mirror for fast
  listing and offline reading. **Outbox** = pending writes when the backend is
  unreachable, so a write is never lost.
- One IPC contract, two adapters — Ports & Adapters at the `main` boundary, the
  same seam the catalog already uses.

---

## 5. Phase A — Reopen & Edit (no storage change)

Goal: fix the bug and lay the data-model foundation, **without** moving storage.
Quotes stay per-PC; only the record shape and the reopen/save flows change.

1. **Store inputs.** `buildQuoteDraft(result, ctx)` also stores `ctx.opt`
   (the `opt` from `collectInputs()`); `persistCurrentQuote` passes it.
2. **Inverse of `collectInputs`.** New `applyInputs(packId, opt)` in the renderer
   fills the step-2 DOM from `opt`: option radios, addon quantities, 3XL/4XL/5XL,
   and the per-mode quantities (bundle `in_packs`, components `in_comp_n`,
   free-components lines rebuilt). It is the exact mirror of `collectInputs`.
3. **Reopen rebuilds the builder.** `'open'` becomes:
   `selectPack(packId)` → `renderPackInputs(packId)` → `applyInputs(packId, opt)`
   → `syncClientCard(quote)` → `recomputePreview()` → `renderResult(result)` →
   land on `resultado`. The desglose still shows first (current UX), but
   "Editar pedido" now returns to a fully populated step 2.
4. **Edit updates the same quote.** `state.editingQuoteId` holds the reopened id.
   `saveCurrentQuote` updates that quote (same id, bump `updated_at`/`version`)
   instead of creating a new one. Selecting a pack anew, `resetForm`, or
   `backToSelection` clears `editingQuoteId` → the next save creates a new quote.
5. **Legacy quotes.** A quote missing `opt` (saved before Phase A) reopens
   read-only with the existing "no editable" notice — never a crash (hard rule §4).
   Same for a quote whose `pack_id` no longer exists in the catalog.

---

## 6. Phase B — Shared quote store (file + cloud)

Goal: move the source of truth to the shared backend so every device on the same
config sees and edits the same quotes.

1. **File backend — `lib/quote-repo-file.js`.** CRUD over
   `<configDir>/presupuestos/<id>.json`:
   - `path.dirname(settings.config_path)` + `presupuestos/`.
   - **Atomic writes** (`.tmp` + rename), like `lib/history.js`.
   - **Collision-safe ids:** compute next `PP-YYYY-NNNN` by scanning the folder,
     then create with the exclusive `wx` flag; on `EEXIST` recompute and retry —
     two devices can never overwrite each other on create.
   - **Conflict control:** capture `mtime`+`sha256` of the file on reopen; on
     update, re-read and compare; mismatch → `confirmConflict` dialog (hard rule §6).
   - **List:** read the directory; build entries from each file (lazy/parsed),
     served fast from the cache and refreshed on open.
2. **Cloud backend — migration `0002` + `lib/quote-repo-cloud.js`.**
   - Additive migration `db/migrations/0002_quote_payloads.sql`: a single
     `CREATE TABLE IF NOT EXISTS quote_payloads (quote_id TEXT PRIMARY KEY,
     payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT
     NOT NULL DEFAULT (...))` — idempotent by construction (no `ALTER … ADD
     COLUMN`, which SQLite cannot guard). Applied by the app with the existing
     pre-migration backup + verify contract (`cloud-bootstrap.provision`).
   - Full-quote ops in `lib/cloud-quotes.js`: `saveFullQuote` (upsert payload +
     flat stat columns in one logical write), `getFullQuote`, `listFullQuotes`
     (id, customer, total, status, dates — no payload), `updateFullQuote`
     (optimistic `WHERE version = ?`, bump on success), keyed by the human id.
   - Stats and status keep working off the flat columns unchanged.
3. **Routing + cache + outbox.** `main` routes `quotes:*` by mode; both backends
   feed `lib/quote-cache.js` (per-PC mirror) and reuse the offline outbox so an
   unreachable backend queues the write and a toast says "se guardará al reconectar".
4. **Migrate existing local quotes.** On first run after upgrade, push each entry
   from the per-PC `presupuestos.json` into the shared store (idempotent by id;
   skip if already present). Keep the old file as `presupuestos.json.bak-pre-shared`.
5. **Id unification.** The human `PP-YYYY-NNNN` becomes the canonical shared id in
   both modes. In cloud, new quotes use it as the row id; the legacy `cloud_id`
   UUID bridge from Phase-A records is tolerated and migrated.

---

## 7. Norms & invariants (the rules this work must respect)

These are the project's hard rules (CLAUDE.md §3) as they apply here:

1. **Renderer never touches fs/Node** — all storage behind `window.packprice.*`
   IPC; both new repos are `lib/` (main-only) modules.
2. **No domain numbers in code** — ids, validity days, margins stay from config;
   only structural limits (e.g. `MAX_QUOTE_BYTES`) live in code.
3. **Fail-fast, no silent swallow** — corrupt files/queues surface a Spanish error;
   never treated as empty data.
4. **No persisted-schema change without backup + idempotent migration** — the
   cloud `0002` migration is additive, idempotent, and runs under the existing
   backup+verify contract; the file backend keeps a pre-shared backup.
5. **Keep the conflict check** — file mtime+sha, cloud `version`; reuse
   `confirmConflict`. Improve UX, never remove.
6. **Tests ship with the change** — every new module and flow has Vitest coverage.
7. **English code, Spanish user strings** — new modules/identifiers/comments in
   English; every user-facing message in Spanish.
8. **No new deps / frameworks / TS / build steps** — native `fs`/`fetch`/`crypto`
   only; zero additions to `package.json`.
9. **Interchangeable modes** — file and cloud remain first-class and swappable at
   any time; the renderer contract is identical for both.
10. **No `--no-verify` / no force; commit only when asked.**

---

## 8. Error handling & edge cases

| Case | Behavior |
|---|---|
| Backend unreachable on save | Enqueue to outbox; toast "se guardará al reconectar"; never lose the quote. |
| Concurrent edit (same quote) | Conflict detected (mtime+sha / version) → `confirmConflict` dialog (overwrite / cancel). |
| Corrupt quote file / queue | Surface a Spanish error; skip the bad file in listings (logged), never crash the list. |
| Legacy quote without `opt` | Reopen read-only with the existing notice; PDF still works. |
| `pack_id` removed from catalog | Read-only reopen with the existing warning. |
| Id collision on create (file) | Exclusive `wx` create + recompute-retry. |
| Id collision on create (cloud) | Unique row id + insert-retry. |

---

## 9. Testing strategy

- **Phase A:** `applyInputs` round-trips `collectInputs` (identity for every pack
  mode); reopen rebuilds the builder; edit updates the same id; legacy/no-`opt`
  reopen is read-only, not a crash.
- **Phase B:** file-repo CRUD + concurrency (exclusive create, conflict on stale
  write); migration `0002` idempotent + backup; cloud full-quote round-trip
  (save → list → get → update with version guard); existing-history migration is
  idempotent; outbox drains on reconnect.
- Pure `lib/` modules unit-tested without Electron (inject the D1 client and the
  base dir), mirroring `tests/cloud-quotes.test.js` and `tests/history.test.js`.

---

## 10. Future improvements (explicitly out of scope now)

Designed so each is additive, not a rewrite:

- **Quote version history** — keep prior versions per quote (the record already
  snapshots `config_version` + `version`); a `snapshots`-style table/folder.
- **"Save as copy"** alongside "update same" (the second answer to the edit-save
  question), once update-same is solid.
- **Soft-delete / archive** (`archived_at`) instead of hard delete, mirroring the
  catalog tables — recover an accidentally deleted quote.
- **Per-quote audit** (who edited what, when), mirroring the catalog audit log.
- **Search / filter / pagination** over large shared stores; lazy file reads and
  a cache index for years of quotes over the NAS.
- **Near-real-time refresh** of the shared list (short poll / mtime watch), so a
  teammate's new quote appears without a manual refresh.
- **Attachments / internal notes** per quote.
- **Full id unification** — retire the `cloud_id` UUID bridge entirely once all
  records use the human id.

---

## 11. Risks

- **Sequence-id collisions across devices** — mitigated by exclusive-create
  (file) and unique-row retry (cloud); never silent overwrite.
- **NAS latency listing many files** — mitigated by the per-PC cache + lazy reads;
  pagination deferred to Future Improvements.
- **Cloud migration safety** — additive + idempotent + pre-migration backup +
  verify, reusing the proven `provision` contract.
