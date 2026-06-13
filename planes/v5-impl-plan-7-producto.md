# Plan 7 — Producto: telemetría de errores, diagnóstico, actualización, manual

> Ejecutar con superpowers:subagent-driven-development. TDD, revisiones spec +
> calidad. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Goal:** cerrar la capa de productización con lo que es software puro y de
valor inmediato: informes de error en tiempo real (opt-out, sin datos de
negocio), exportar diagnóstico para soporte a ciegas, y los toggles de
actualización; más el manual de usuario y la entrada de devlog de la release.

**Spec:** `docs/PRD.md` R15, R17, R19, §1b (principio rector), §4b (D3 firma) ·
`planes/v5-cloud-sync.md` §5b (telemetría de errores) · CLAUDE.md §2 (debate
productización). **R16 (semilla demo) NO se implementa aquí** — ver §0.

**Reglas:** cero deps; la telemetría usa `fetch` propio (protocolo
Sentry-compatible, sin SDK); lista blanca de campos, nunca datos de negocio;
red solo en main; English code / Spanish UI; TDD; fail-fast.

---

## 0. R16 (semilla demo neutra) — tarea de release del propietario, NO de código aquí

`config.default.js` contiene hoy datos reales del taller (refs/precios) y es a
la vez el fixture que fija importes exactos en `tests/calculo.test.js` y otros.
Neutralizar los valores: (a) requiere **archivar antes el catálogo real en el
NAS** (paso de operaciones que el propietario hace, no el código — principio
rector §1b), (b) está atado a la decisión D4 (qué docs/números se publican),
aún pendiente, y (c) cascada en la suite (cada importe fijado). Por tanto R16
se ejecuta **en el momento de abrir el repo**, como tarea de release:
1. Propietario archiva el `config.js`/catálogo real a `\\NAS\…\archivo\`.
2. Se sustituye `config.default.js` por un catálogo demo genérico marcado
   («datos de ejemplo — edítalos»).
3. Se re-fijan los importes de los tests al nuevo seed (tarea acotada, su
   propio PR).
Queda registrado en este plan y en `docs/PRD.md` §4b. No se toca el seed ahora.

## Task 7A — telemetría de errores + diagnóstico + actualización (lib + main)

**Files:** create `lib/error-reporter.js`, `lib/error-scrubber.js`,
`lib/diagnostics.js` (+ tests each); modify `lib/settings-validator.js`
(+tests), `main.js`, `preload.js`. Check the EXISTING update-check first
(main.js already has update-related code — verify what's implemented and only
fill gaps).

1. **`lib/error-scrubber.js`** (pure) — `scrubError(err, meta)` → a whitelisted
   payload: `{ message, stack, type, app_version, schema_version, os, arch,
   data_source }` and NOTHING else. The scrubber must STRIP anything that
   looks like business data or secrets even if it appears in a message/stack:
   redact absolute file paths to basenames, redact anything matching a token
   pattern (long hex/base64), redact email/phone-like substrings, cap message
   and stack length. Heavily tested: a stack/message containing a token,
   an email, a phone, a Windows user path, and a catalog value are all
   redacted; the whitelisted fields pass through.
2. **`lib/error-reporter.js`** (fetch injected) — `reportError(payload, {
   dsn, fetchImpl, enabled })`: if `!enabled` or no `dsn` → no-op `{sent:false}`;
   else POST the Sentry-compatible envelope to the DSN via `fetchImpl`; never
   throw (a telemetry failure must never crash the app — swallow + return
   `{sent:false, error}`). The DSN is a developer-owned constant (Sentry free
   tier / GlitchTip) — put it in a clearly-marked constant; it carries no
   customer data. Tests: disabled → no fetch; enabled → posts the scrubbed
   payload; fetch rejection swallowed.
3. **Wire in main:** `process.on('uncaughtException')` and
   `process.on('unhandledRejection')` (main process only) → `scrubError` →
   `reportError` (respecting the opt-out setting) → also log locally
   (electron-log) and surface to the user per existing fail-fast. Migration/
   backend failures already logged can also route a scrubbed report. Guard:
   reporting itself must be try/caught so a reporter bug can't mask the
   original error.
4. **`lib/diagnostics.js`** (fs read) — `buildDiagnostics({ userDataDir,
   appVersion, schemaVersion, dataSource })` → an object/zip-able set:
   recent log lines (from electron-log file), app + schema + electron + OS
   versions, data_source, settings **with the token redacted** (reuse
   `lib/settings-privacy.js redactSettings`), outbox/cache presence (counts,
   not contents). NO token, NO catalog, NO quotes content. Tests: token never
   present; structure complete; missing log file tolerated.
5. **IPC + preload:** `diagnostics:export` → main builds the diagnostics, writes
   a `packprice-diagnostico-<fecha>.json` (or a small zip) to a user-chosen
   folder (native dialog) and opens the folder. `error-reports:get`/`set`
   toggle. Preload: `exportDiagnostics`, `getErrorReportsEnabled`,
   `setErrorReportsEnabled`. No token to renderer.
6. **Settings:** add `error_reports_enabled` (default true) and (if not already
   present from 2C) `check_updates_on_start` (default true) to
   settings-validator with tests; the update-check on boot respects the toggle.

**Commits:** `feat(telemetry): error scrubber (whitelist, secret redaction)` ·
`feat(telemetry): opt-out Sentry-compatible error reporter` ·
`feat(main): wire crash reporting + diagnostics export` ·
`feat(settings): error-report + update-on-start toggles`.

## Task 7B — renderer: Privacidad + Actualizaciones (verificar lo de 2C)

**Files:** modify `renderer/app.js`, `renderer/index.html`,
`renderer/styles.css`.

1. **Sección «Privacidad»** en ajustes (UI-UX §2.6): interruptor «Enviar
   informes de error» (default on) con texto llano de qué se envía exactamente
   (errores técnicos, versión, sistema — *nunca* precios, clientes ni
   catálogo) + enlace al detalle del manual; botón **«Exportar diagnóstico»**
   (llama `exportDiagnostics`, muestra dónde se guardó).
2. **Sección «Actualizaciones»** (UI-UX §2.6): VERIFY whether 2C already added
   «Buscar actualizaciones al iniciar» + «Buscar ahora». If present and wired
   to the GitHub release check, just ensure the toggle persists via
   `check_updates_on_start`. If the existing button only refreshes the CATALOG
   (different feature), add the APP-version check: «Buscar ahora» → GitHub
   latest release vs `app.version` → «Estás en la última versión» / «Versión
   X.Y disponible — [Descargar]» (enlace a la release vía openExternal). No
   auto-install.
3. First-run / first error: the privacy choice is disclosed (a one-line note in
   the first-run wizard or settings) per the principle that the two outbound
   connections (GitHub, error reports) are declared.

**Commit:** `feat(renderer): privacy + updates settings (error reports, diagnostics)`.

## Task 7C — manual de usuario + devlog de la release

**Files:** create `docs/MANUAL.md`; create `devlog/13-v5-cloud-y-producto/README.md`
(per `devlog/TEMPLATE.md`); update `devlog/README.md` index; update
`docs/PRD.md` §4b (R16 release task) and the decisions log; bump
`package.json` version to a v5 beta (e.g. `5.0.0-beta`).

1. **`docs/MANUAL.md`** (Spanish, user-facing): instalación (con capturas del
   aviso SmartScreen y los pasos «Más información → Ejecutar de todas formas»
   — `.exe` sin firmar, D3); elegir Local vs Nube (asistente); crear la cuenta
   de Cloudflare + el token (pasos); copias de seguridad y restauración
   (snapshots + Time Travel + export); cambiar de Local a Nube y viceversa;
   estados (sin conexión, conflicto); informes de error y qué contienen
   exactamente (privacidad); plantillas PDF; FAQ y resolución de problemas.
2. **Devlog 13** siguiendo `devlog/TEMPLATE.md`: resumen de la release v5
   (almacenamiento local/nube sin servidor, sin gate de admin, auditoría/
   rollback, presupuestos+estadísticas, plantillas PDF, telemetría), diagramas
   Mermaid (arranque cloud, escritura por entidad, restore forward-only),
   caminos descartados (Worker), decisiones bloqueadas. Capturas: marcadas como
   pendientes de generar con datos demo (no precios reales).
3. Bump de versión y nota de que el devlog se publica antes de distribuir el
   `.exe` (definición de hecho, CLAUDE.md §8).

**Commit:** `docs(v5): user manual, release devlog and version bump`.

## Cierre del Plan 7

- Suite verde (≥813 + nuevos; scrubber/reporter/diagnostics bien cubiertos).
- Un error no controlado del main se reporta scrubbeado (sin datos de negocio)
  cuando el opt-in está activo; desactivable; nunca crashea por la telemetría.
- «Exportar diagnóstico» produce un archivo sin token ni datos de negocio.
- Toggles de actualización e informes de error persistidos y respetados.
- Manual de usuario completo; devlog 13 publicado; versión bumpeada.
- R16 documentado como tarea de release del propietario (no código).
