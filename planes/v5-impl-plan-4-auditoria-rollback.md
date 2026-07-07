# Plan 4 — Auditoría, snapshots y restore (lectura + rollback)

> Ejecutar con superpowers:subagent-driven-development. TDD, revisiones spec +
> calidad. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Goal:** leer y mostrar el historial de cambios del catálogo (audit_log) y la
lista de versiones (snapshots), y restaurar cualquier versión anterior — el
propio restore queda auditado. Las filas de audit/snapshot **ya las escribe**
`lib/catalog-writer.js` (Plan 3); aquí solo se leen y se restaura.

**Spec:** `planes/v5-cloud-sync.md` §3 (tablas), §4 (restore auditado) ·
`docs/UI-UX.md` §2.5 (pestaña de auditoría + «Restaurar esta versión») · PRD R9.

**Reglas:** cero deps; red solo en main; English code / Spanish UI; TDD; fail-fast.

---

## Task 4A — `lib/cloud-history.js` (puro, cliente inyectado) + bootstrap + IPC

**Files:** create `lib/cloud-history.js` (+`tests/cloud-history.test.js`);
modify `lib/cloud-bootstrap.js` (+tests), `main.js`, `preload.js`. Reuse
`lib/catalog-writer.js` (writeEntities), `lib/catalog-assembler.js`,
`lib/cloud-catalog.js`, `lib/diff.js`.

1. **`readAuditLog(client, { limit = 50, offset = 0 })`** →
   `[{ id, ts, user, entityType, entityId, action, diff, catalogVersion }]`
   newest-first: `SELECT … FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`.
   Parse `diff_json` into `diff` (array); tolerate malformed JSON (skip parse,
   keep raw, never throw the whole read). Tests: ordering, limit/offset, diff
   parsed, malformed diff_json tolerated.
2. **`listSnapshots(client)`** → `[{ catalogVersion, ts }]` newest-first
   (`SELECT catalog_version, ts FROM snapshots ORDER BY catalog_version DESC`).
   `getSnapshot(client, version)` → `{ catalogVersion, ts, cfg }` (parses the
   stored JSON into `cfg`); clear Spanish error if the version doesn't exist.
   Tests: list ordering, get parses cfg, missing version errors.
3. **`restoreSnapshot(client, { version, user, now })`**: read the target
   snapshot's cfg, load the CURRENT entities → assemble currentCfg, then call
   `writeEntities(client, { oldCfg: currentCfg, newCfg: snapshotCfg, user, now,
   expectedVersions: <current live versions> })`. Because restore is a
   deliberate overwrite to a known prior state, it uses the CURRENT live
   versions as expectedVersions (so it always wins — no false conflicts against
   itself), but still archives entities absent in the snapshot and re-adds ones
   the snapshot has. The restore writes its own audit rows (action 'update'/
   'create'/'delete' per entity, via writeEntities) AND a NEW snapshot at the
   new catalog_version (writeEntities already does this) — so the timeline is
   append-only: restoring v3 creates v9 whose content equals v3. Return
   `{ ok, catalogVersion }`. Add a why-comment: restore is forward-only
   (never rewrites history; it creates a new version equal to the old one).
   Tests: restore writes entities to match snapshot, archives entities not in
   snapshot, produces a new catalogVersion + new snapshot + audit rows.
4. **Bootstrap surface:** add `getAudit({limit,offset})`, `getSnapshots()`,
   `restore({version})` to `createCloudBootstrap` (build client from settings,
   `user` from settings for restore, `now` injected). On successful restore,
   refresh the local cache with the restored catalog. Tests in
   cloud-bootstrap.test.js.
5. **IPC + preload (thin):** `audit:list` `{limit,offset}` → entries;
   `snapshots:list` → versions; `snapshots:restore` `{version}` → result.
   Preload named fns: `listAudit`, `listSnapshots`, `restoreSnapshot`. No
   token/admin to renderer. Cloud-only (file mode: these return a clear
   `{ ok:false, code:'NOT_CLOUD' }` or the renderer simply doesn't show them).

**Commits:** `feat(cloud): audit log + snapshot read and forward-only restore` ·
`feat(main): audit/snapshots/restore IPC + bootstrap surface`.

## Task 4B — renderer: pestaña Auditoría + lista de versiones + restaurar

**Files:** modify `renderer/admin.js` (or admin-extras.js — the audit render
already exists there for file mode; READ it), `renderer/app.js`,
`renderer/index.html`, `renderer/styles.css`. Pure helper only if a mapping
emerges.

1. **Pestaña «Historial»** in the catalog editor (cloud mode): two views —
   **Auditoría** (who/when/what: reuse the existing audit row render from
   admin-extras.js / `renderChangeRow`; each entry shows user, ts,
   entity, and its diff lines, newest first; paginated «Cargar más» via
   offset) and **Versiones** (the snapshots list: each row `v{N} · {fecha}`
   with a «Restaurar esta versión» button).
2. **Restaurar:** clicking «Restaurar esta versión» opens a confirmation
   (UI-UX §2.5 spirit: «Vas a restaurar la versión {N} del {fecha}. Se creará
   una versión nueva con ese contenido. ¿Continuar?») → `restoreSnapshot` →
   on success reload the catalog (so the editor shows the restored state) and
   toast «Restaurado a la versión {N}». The restore is itself audited (shows
   up as a new audit entry).
3. File mode: the Historial tab shows only the existing local audit (no
   snapshots/restore — those are cloud features). Do not regress the existing
   admin audit view.

**Commit:** `feat(renderer): catalog history tab with snapshot restore`.

## Cierre del Plan 4

- Suite verde (≥495 + nuevos).
- Desde el editor (cloud): ver el historial de cambios con autor y diff; ver
  la lista de versiones; restaurar una versión anterior → crea una versión
  nueva con ese contenido, queda auditado, y el editor refleja el estado
  restaurado.
- Modo archivo: la auditoría local existente sigue funcionando; sin
  regresiones.
- Restore es forward-only (no reescribe historia); un restore fallido por red
  no deja el catálogo a medias (writeEntities es por entidad con guardas).
