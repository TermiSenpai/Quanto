# Plan 2 — Asistente Local/Nube + lectura cloud + caché

> **For agentic workers:** ejecutar con superpowers:subagent-driven-development.
> Formato contrato-preciso: cada tarea define firmas, canales y criterios; el
> implementador aplica TDD (test en rojo → código → verde) y sigue los
> patrones existentes del repo. Las revisiones de spec y calidad cierran cada
> tarea.

**Goal:** la app arranca desde D1 (cuenta del cliente) con asistente de primer
arranque Local/Nube, aprovisionamiento automático, caché local de respaldo y
estados online/offline — solo LECTURA (las escrituras son el Plan 3).

**Spec:** `planes/v5-cloud-sync.md` §2, §5, §6, §7 · `docs/UI-UX.md` §2.0–2.2 ·
PRD R6, R7, R10, R10b.

**Reglas transversales:** cero dependencias; red solo en main; CSP intacta;
código inglés / UI español; TDD; commits pequeños con trailer
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Task 2A — módulos lib puros (sin Electron, sin UI)

**Files:** modify `lib/d1-client.js` (+tests) · modify `lib/db-migrator.js`
(+tests) · create `lib/catalog-cache.js` (+tests) · create
`lib/cloud-catalog.js` (+tests).

1. **`d1-client.exportDatabase()`** → descarga un dump SQL completo.
   Contrato: `await client.exportDatabase({ db, account, pollIntervalMs = 1000, maxPolls = 60 })`
   → `string` (texto SQL). Implementación REST: `POST /accounts/{a}/d1/database/{db}/export`
   con body `{ output_format: 'polling' }`; repetir el POST reenviando el
   `at_bookmark` devuelto hasta `result.success && result.result?.signed_url`
   (la forma exacta del polling debe verificarse contra la respuesta real:
   campos `at_bookmark`, `status`, `result.signed_url` — escribir el cliente
   tolerante: bucle hasta encontrar `signed_url` en `result` o en
   `result.result`, error claro en español si se agotan los intentos);
   descargar la URL firmada con `fetchImpl` y devolver el texto. Inyectar
   `sleepImpl` para tests. Tests con fetch falso: happy path con 2 polls,
   agotamiento → `D1ClientError` con mensaje español.
2. **Candado de migración en `lib/db-migrator.js`:**
   `acquireMigrationLock(client, { now, staleMinutes = 10 })` →
   `UPDATE catalog_meta SET migrating_since = ? WHERE migrating_since IS NULL OR migrating_since < <stale-cutoff>`
   → true si `meta.changes === 1`; `releaseMigrationLock(client)` → pone NULL.
   Si `catalog_meta` no existe aún (base recién creada), `acquire` debe
   devolver `true` sin fallar (try/catch del UPDATE: tabla inexistente =
   primera migración = sin concurrencia posible que proteger). Tests: adquiere
   libre / rechaza ocupado fresco / roba candado caducado / tolera tabla
   ausente / release.
3. **`lib/catalog-cache.js`** (fs permitido — es un store):
   `readCache(filePath)` → `{ fetchedAt, catalogVersion, entities } | null`
   (null si no existe; lanza error español `Caché de catálogo dañada` con
   cause si JSON inválido); `writeCache(filePath, { fetchedAt, catalogVersion, entities })`
   atómico (`.tmp` + rename, crea directorio si falta — espejo del patrón de
   `lib/config-store.js`). Tests con tmpdir: write→read round-trip, null si
   falta, corrupta lanza, tmp no queda huérfano.
4. **`lib/cloud-catalog.js`** (puro, cliente inyectado):
   - `ENTITY_TABLES` — lista ordenada de las 13 tablas de catálogo.
   - `loadEntities(client)` → `{ entities, meta }`: un `SELECT` por tabla
     (entidades con `archived_at`: `WHERE archived_at IS NULL`; el resto
     completo) + `SELECT * FROM catalog_meta WHERE id = 1` → meta
     `{ catalogVersion, schemaVersion, minAppVersion }`. Error español claro
     si falta la fila meta.
   - `getCatalogVersion(client)` → número.
   - `seedCatalog(client, entities, { user, now })` → para una base VACÍA
     (0 filas en products): inserta todas las entidades tabla a tabla con
     `INSERT OR IGNORE` parametrizado y actualiza `catalog_meta`
     (`updated_by = user`, `updated_at = now()`). Si products no está vacío →
     no hace nada y devuelve `{ seeded: false }`. (Las escrituras de entidad
     reales son Plan 3; esto es solo la siembra inicial del asistente.)
   Tests con cliente falso: SQL emitido por tabla, filtro archived, seed
   completo desde `disassemble(buildDefaultConfig())`, seed no-op con base
   poblada.

**Commit sugerido por módulo** (4 commits `feat(cloud): …`).

## Task 2B — settings + IPC + main (sin tocar el renderer aún)

**Files:** modify `lib/settings-validator.js` (+tests) · modify `main.js` ·
modify `preload.js`.

1. **Settings nuevos** (en `settings.json` local, validados):
   `data_source: 'file' | 'cloud'` (default `'file'` si falta — los settings
   existentes siguen valiendo sin migración), y
   `cloud: { token, account_id, database_id, user_name }` (strings; token
   nunca sale hacia el renderer en claro — ver punto 3).
2. **Canales IPC nuevos** (kebab-case inglés, patrón `<resource>:<action>`,
   handlers finos en main que delegan en lib):
   - `cloud:test-token` `{ token }` → `{ ok, accounts: [{id, name}] }` —
     valida el token con `listAccounts`.
   - `cloud:provision` `{ token, accountId }` → busca base `packprice`
     (`findDatabaseByName`); si no existe la crea; aplica migraciones con
     candado §6 (acquire → backup-export si la base tenía `schema_migrations`
     previa → `applyMigrations(loadMigrations('db/migrations'))` → verificar
     cargando catálogo+`validateConfigSchema` cuando haya datos → release);
     si la base quedó vacía de catálogo → `seedCatalog` con la semilla de
     `buildDefaultConfig()`; guarda settings (`data_source: 'cloud'`, ids,
     token) y devuelve `{ ok, databaseId, seeded }`. Backup pre-migración a
     `%APPDATA%/packprice/backups/pre-migration-<ISO>.sql`.
   - `catalog:load` → flujo de arranque cloud: intento red (timeout 5 s con
     `Promise.race`) → `loadEntities` → `assemble` → `validateConfigSchema`
     → `writeCache` → `{ ok, config, source: 'cloud', catalogVersion, fetchedAt }`.
     Fallo de red → `readCache` → assemble+validate →
     `{ ok, config, source: 'cache', fetchedAt, offline: true }`. Sin caché →
     `{ ok: false, error, code: 'NO_CLOUD_NO_CACHE' }`.
   - `catalog:check-version` → `{ ok, current, remote, upToDate }`.
   - `catalog:refresh` → como `catalog:load` pero sin fallback a caché
     silencioso: si no hay red devuelve `{ ok: false, offline: true }`.
3. **`config:read` existente:** si `data_source === 'cloud'`, main responde
   con el resultado de `catalog:load` (misma forma `{ ok, config, … }` que el
   modo archivo para que el renderer actual siga funcionando); el modo file
   queda intacto byte a byte. El cfg cloud que viaja al renderer NO lleva
   `admin` ni token.
4. **preload:** exponer `testCloudToken`, `provisionCloud`, `loadCatalog`,
   `checkCatalogVersion`, `refreshCatalog` — funciones nombradas, nada
   genérico.
5. La migración de esquema en `cloud:provision` sigue el contrato §6
   íntegro; si la verificación post-migración falla → `releaseMigrationLock`
   en `finally`, responder `{ ok: false, code: 'MIGRATION_FAILED', backupPath }`.

Tests: settings-validator (nuevos campos, defaults, rechazo de formas malas);
los handlers son finos — la lógica orquestadora extraíble se prueba si se
extrae a lib (decisión del implementador: preferir `lib/cloud-bootstrap.js`
puro con `client`/`cache`/`now` inyectados y handlers de main de 3 líneas).

**Commits:** `feat(settings): data_source + cloud settings` ·
`feat(cloud): bootstrap read path with cache fallback` ·
`feat(main): cloud IPC handlers + preload surface`.

## Task 2C — renderer: asistente + indicador + banner

**Files:** modify `renderer/index.html`, `renderer/styles.css`,
`renderer/app.js` (+ helpers puros testeables si surgen — p. ej.
`renderer/data-status.js` con la máquina de estados del indicador).

Según `docs/UI-UX.md` §2.0–2.2 (textos en español de allí, ids kebab-case):

1. **Asistente primer arranque** (`#setup-wizard`): se muestra cuando no hay
   origen configurado (`data_source` ausente y sin config path legacy). Dos
   cards: Local (reusa el selector de ruta existente del welcome actual) /
   Nube (3 pasos: cuenta → token con botón «Abrir Cloudflare» vía
   `shell.openExternal` EXISTENTE o enlace target _blank si ya hay patrón —
   red del renderer NO; pegado de token → `testCloudToken` → selector de
   cuenta si hay varias → `provisionCloud` con spinner y mensajes de
   progreso). Errores en lenguaje llano, reintento sin salir del asistente.
2. **Indicador de datos** en topbar (`#data-status`): tres estados
   (`Datos al día · v{N}` verde / `Sin conexión · datos del {dd/mm hh:mm}`
   ámbar / `Modo local` neutro) + botón `#refresh-catalog` («Actualizar») con
   spinner inline y toast «Ya estás al día» / recarga de cfg en vivo.
3. **Banner offline** (`#offline-banner`, `role="status"`): visible cuando
   `source === 'cache'`; texto UI-UX §2.2; botón «Reintentar» → mismo flujo
   que Actualizar; al reconectar, desaparece y el cfg se refresca. Con banner
   activo, el botón de edición de catálogo (admin actual) deshabilitado con
   tooltip «No disponible sin conexión».
4. **Pantalla de error sin red ni caché**: reusa la pantalla de error
   existente con el texto de UI-UX §2.4 y botones «Reintentar» / «Usar modo
   local…» (abre el selector de ruta).
5. CSS con tokens existentes (`--warning-soft`, `--success-soft`…), BEM-lite.

Smoke manual (sin D1 real): arrancar `pnpm dev` y simular — el implementador
debe poder demostrar con capturas o pasos reproducibles que: primer arranque
muestra el asistente; modo local sigue funcionando igual que antes (regresión
cero); con `data_source: 'cloud'` y red rota + caché presente arranca en
solo-lectura con banner.

**Commits:** `feat(renderer): first-run wizard local/cloud` ·
`feat(renderer): data status indicator, refresh and offline banner`.

## Criterios de cierre del Plan 2

- Suite completa verde (≥355 + nuevos).
- Modo file: cero regresiones (mismos tests, smoke `pnpm dev`).
- PC-1 con token válido aprovisiona la base sola; PC-2 con el mismo token la
  encuentra y se conecta (verificable contra una D1 real del propietario —
  si no hay credenciales en el entorno, queda anotado como pendiente de
  verificación manual en el informe final).
- Sin red + caché → arranca solo-lectura con banner; sin red ni caché →
  pantalla de error con salida a modo local.
