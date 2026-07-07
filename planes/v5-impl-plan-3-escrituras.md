# Plan 3 — Escrituras por entidad (cloud) + editor sin contraseña

> Ejecutar con superpowers:subagent-driven-development. TDD, dos revisiones
> (spec + calidad) por tarea. Trailer de commit:
> `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Goal:** guardar cambios de catálogo en D1 entidad-a-entidad con concurrencia
optimista por versión, sustituir la puerta de contraseña del editor por
confirmación con resumen, y resolver conflictos por entidad. El modo archivo
sigue intacto.

**Spec:** `planes/v5-cloud-sync.md` §4, §5b(no), §3 (tablas
`audit_log`/`snapshots`/versiones) · `docs/UI-UX.md` §2.3, §2.5 · PRD R8, R9,
R18 · CLAUDE.md §9 (debate: v5 quita el gate de admin).

**Reglas:** cero deps; red solo en main; English code / Spanish UI; TDD;
fail-fast.

---

## Task 3A — `lib/catalog-writer.js` (puro, cliente inyectado) + contrato file/d1

**Files:** create `lib/catalog-writer.js` (+`tests/catalog-writer.test.js`);
reuse `lib/diff.js`, `lib/catalog-assembler.js`, `lib/cloud-catalog.js`.

1. **`diffEntities(oldCfg, newCfg)` → `{ changed, removed }`** where each is a
   list of `{ entityType, id }`. Entity types and granularity:
   - `pack` (per id), `product` (per id), `supplier` (per id), `addon` (per id)
     — added/removed/changed detected by deep-comparing the assembled rows of
     that entity (use `disassemble` then group rows by entity, or compare the
     cfg sub-objects directly — compare cfg sub-objects, simpler and exact).
   - `parameters`, `tiers`, `company` (which includes quote_settings) are
     **global singletons**: if any field changed, emit one change of that type.
   Pure, deterministic, no I/O. Tests: no change → empty; change one pack →
   only that pack; add/remove a product; change a parameter → parameters
   global; change company name or quote_settings → company global.

2. **`buildEntityWrite(entityType, id, cfg)` → array of `{ sql, params }`**:
   the parameterized statements that REPLACE that entity's rows in D1.
   - For a per-id entity: `DELETE` its child rows + the row, then `INSERT` the
     fresh rows from `disassemble(cfg)` filtered to that id (so option/value/
     component/price children are fully rewritten — simplest correct approach
     for a small catalog). The main entity row carries the **version guard**
     (see writeEntities).
   - For globals: replace all rows of `parameters` / `tiers` / `company`.

3. **`writeEntities(client, { oldCfg, newCfg, user, now, expectedVersions })`**
   → `{ ok, catalogVersion, results: [{ entityType, id, status }] }` where
   `status` ∈ `'written' | 'conflict' | 'deleted'`. For each changed entity:
   - **Version guard:** `UPDATE <table> SET version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?` using `expectedVersions[type][id]`. If
     `meta.changes === 0` → it's a conflict (someone else bumped it) → record
     `status:'conflict'`, read the current server row+version, DO NOT write the
     children, continue with the other entities. For globals the guard is the
     `catalog_version` compared to `expectedVersions.catalogVersion`.
   - On guard success: run the entity's `buildEntityWrite` child statements,
     insert an `audit_log` row (`user`, `entity_type`, `entity_id`, `action`,
     `diff_json` from `lib/diff.js` of that entity's before/after,
     `catalog_version`), and after all entities, bump `catalog_version`,
     stamp `catalog_meta` (`updated_by=user`), and insert one `snapshots` row
     with the full assembled new cfg JSON at the new version.
   - Removals: archive (`UPDATE … SET archived_at = ?`), audit `action:'delete'`.
   - Return aggregate: `ok:true` if zero conflicts; if any conflict,
     `ok:false, conflicts:[…]` but the non-conflicting entities ARE written
     (partial success is reported precisely — the UI re-loads and shows which
     ones conflicted).
   NOTE on atomicity (documented, per §4): D1 REST batches aren't interactive
   transactions; order is data-first, audit/snapshot last; re-running is safe
   because guards are version-checked. Add a why-comment.
   Tests with a fake client (mirror cloud-catalog tests): single pack write
   bumps version + audit + snapshot; stale version → conflict, server row
   returned, other entities still written; removal archives; globals path.

4. **Contract test (R18):** `tests/backend-contract.test.js` (new) — a small
   shared suite asserting the same guarantees for the file backend
   (config-store write+conflict) and the d1 backend (writeEntities): a write
   succeeds; a stale-baseline write is reported as a conflict, never a silent
   overwrite. Keep it minimal but real (both adapters exercised).

**Commits:** `feat(cloud): entity diff and guarded entity writes` ·
`test(cloud): backend write/conflict contract (file + d1)`.

## Task 3B — main IPC `catalog:save` + author + file-mode parity

**Files:** modify `main.js`, `preload.js`, `lib/cloud-bootstrap.js`
(add a `saveCatalog` method to the bootstrap surface, injected client/now/log).

1. **`cloud-bootstrap.saveCatalog({ newCfg, expectedVersions, user })`**:
   re-load current entities to get authoritative versions if `expectedVersions`
   missing; call `writeEntities`; refresh the local cache with the new catalog
   on success; return `{ ok, catalogVersion, conflicts, results }`. On full
   conflict-only result, do NOT refresh cache.
2. **IPC `catalog:save`** (cloud mode) — thin handler delegating to
   `saveCatalog`, with `user` from settings `cloud.user_name` (fallback to a
   generic). The renderer passes the edited full cfg + the versions it loaded.
3. **`config:write` cloud branch:** when `data_source==='cloud'`, route the
   existing admin-save channel to `saveCatalog` and return a shape the renderer
   understands (ok / conflict list). File mode `config:write` stays byte-identical.
4. **preload:** add `saveCatalog`. Token/admin never sent to renderer; the
   cfg returned after save is assemble() output (no admin/token).
5. **Expose entity versions to the renderer:** `catalog:load`/`config:read`
   cloud response must include `versions` (`{ pack:{id:v}, product:{…}, …,
   catalogVersion }`) so the renderer can send them back on save. Add to the
   load result (cache stores them too).

Tests: extend `tests/cloud-bootstrap.test.js` (saveCatalog happy/conflict/
cache-refresh-only-on-success). Handlers thin.

**Commit:** `feat(main): catalog:save cloud handler with per-entity versions`.

## Task 3C — renderer: editor sin gate + confirmación + conflicto por entidad

**Files:** modify `renderer/app.js`, `renderer/admin.js`,
`renderer/index.html`, `renderer/styles.css`; pure helper
`renderer/save-summary.js` (+test) for the change-summary derivation.

1. **Quitar la puerta de contraseña** del editor de catálogo **solo en modo
   cloud** (file mode keeps its existing password gate until retired — do not
   regress file mode). In cloud mode the catalog editor opens directly; show
   the author in its header («Editando como {user_name}»).
2. **Confirmación al guardar** (UI-UX §2.5): on save, compute the change
   summary (reuse `lib/diff.js` via a small `renderer/save-summary.js` pure
   wrapper that turns old/new cfg into grouped `{entityType, id, lines[]}`),
   show a modal listing the changes and the author, `[Guardar N cambios]` /
   `[Cancelar]`. Only on confirm call `saveCatalog`. Saving without confirming
   is impossible.
3. **Conflicto por entidad** (UI-UX §2.3): if `saveCatalog` returns conflicts,
   show a modal per conflicted entity (reuse the diff render) with
   `[Cargar versión del servidor]` / `[Sobrescribir con la mía]` / `[Cancelar]`,
   and report «N cambios guardados, M conflictos». «Cargar versión del
   servidor» reloads the entity; «Sobrescribir» re-saves that entity with the
   server's current version as baseline.
4. **save-summary.js test:** pure mapping old/new cfg → grouped summary;
   covers a pack change, a parameter change, an added product.

**Commits:** `feat(renderer): catalog editor save confirmation (cloud)` ·
`feat(renderer): per-entity save-conflict resolution`.

## Cierre del Plan 3

- Suite verde (≥445 + nuevos).
- Editar un pack en PC-A y un producto en PC-B no chocan (distinta entidad);
  misma entidad editada en ambos → conflicto con diff, nunca sobrescritura
  silenciosa (contrato R18 + test de conflicto).
- Guardar sin confirmar es imposible; cada escritura deja audit + snapshot.
- Modo archivo: cero regresiones (mismos tests + smoke).
