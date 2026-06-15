# Plan v5 — Datos en local o en la nube (Cloudflare D1 directo, sin servidor)

**Estado:** aprobado 2026-06-12 (debate documentado en `CLAUDE.md`; revisado el
mismo día: **sin Worker**).
**Requisitos de producto:** `docs/PRD.md` §3.2 (R6–R16). **UI:** `docs/UI-UX.md` Parte 2.

> Decisión final: la app habla **directamente con Cloudflare D1 por su API
> REST** desde el main process. No hay Worker, no hay servidor propio, no hay
> nada que desplegar — el `.exe` es todo el software. Cada empresa usa **su
> propia cuenta de Cloudflare**: la app le aprovisiona la base de datos sola
> (estilo FactuSOL). El modo local (archivo en PC o NAS) es opción de primera
> clase, y se puede pasar de local a nube (y volver) en cualquier momento.

---

## 0. Las ideas que sostienen el diseño

1. **Tablas puras en D1.** Productos, packs, precios, presupuestos en SQL de
   verdad — consultas finas, estadísticas con `GROUP BY`, integraciones futuras.
2. **Ensamblador en cliente.** `calculo.js` y `validateConfigSchema` operan
   sobre un objeto `cfg`; no les importa su origen. `lib/catalog-assembler.js`
   (puro, nuevo) convierte entidades ↔ `cfg` v4 **en ambas direcciones** — es
   también el conversor local↔nube. **Motor de cálculo, validador y renderer
   no se reescriben.**
3. **Escrituras por diff.** El editor trabaja sobre el `cfg` completo;
   `lib/diff.js` (existente) detecta qué entidades cambiaron y solo esas se
   escriben. Conflictos por entidad, no globales.
4. **Sin servidor.** La app es el único software. Las migraciones de esquema
   las aplica la propia app (el mismo contrato que `lib/migrations.js` aplica
   a los archivos, ver §6). Cero deploys, cero mantenimiento per-cliente.

## 1. Arquitectura

```
PC empresa (Electron .exe)                       Cloudflare (cuenta DEL CLIENTE)
┌────────────────────────────────┐              ┌──────────────────────────┐
│ renderer (sin Node, sin red)   │              │ D1 "packprice"           │
│   ↕ window.packprice.*         │   HTTPS      │  (SQLite gestionado,     │
│ main.js ── lib/config-backend ─┼─────────────►│   API REST oficial,      │
│   ├─ adapter file  (actual)    │  solo main   │   free tier)             │
│   └─ adapter d1    (nuevo)     │              └──────────────────────────┘
│ lib/d1-client.js (REST)        │
│ caché %APPDATA%\packprice\cache│
└────────────────────────────────┘
```

- El renderer **jamás** toca la red: CSP `default-src 'self'` intacta.
- `lib/config-backend.js` define la interfaz (`load`, `save`, `getVersion`,
  `getAudit`); `main.js` elige adaptador según `settings.json`.
- `lib/d1-client.js`: cliente mínimo de la API REST de D1
  (`POST /accounts/{acc}/d1/database/{db}/query` con sentencias
  parametrizadas, `/export` para backups, creación/listado de bases). Sin
  librerías: `fetch` nativo del main process.
- **Cuenta y token son del cliente y por PC** (`settings.json`): el mismo
  `.exe` sirve para cualquier empresa sin tocar nada.

## 2. Primer arranque y aprovisionamiento (la visión FactuSOL)

Asistente de primer arranque — «¿Dónde guardamos tus datos?» (UI-UX §2.0):

- **Local:** elegir ruta (PC o NAS por red) → modo archivo actual. Listo.
- **Nube:**
  1. ¿No tienes cuenta de Cloudflare? La app abre el registro en el navegador.
  2. La app abre la página de **crear API token con plantilla pre-rellenada**
     (URL de plantilla de Cloudflare: permisos D1 únicamente). El usuario pulsa
     crear y copia el token. *(No existe OAuth de Cloudflare para apps de
     terceros; este es el único paso manual, una vez por empresa.)*
  3. Pegado el token, la app sola: detecta la cuenta → **busca la base
     `packprice`** → si existe, se conecta (segundo PC de la empresa); si no,
     **la crea y aplica las migraciones** (primer PC). Fin.

**Mover de local a nube** (en cualquier momento, desde ajustes): asistente de
nube + `disassemble(cfg)` → INSERT del catálogo + importación del historial
local de presupuestos. **De nube a local:** `GET` catálogo → ensamblar →
serializar a `config.js`. El conversor es el ensamblador (§0.2); no hay
formatos nuevos.

## 3. Esquema D1

Idéntico al ya definido (se conserva íntegro): convenciones transversales
(`created_at`/`updated_at`/`archived_at` en entidades, fechas ISO-8601 UTC,
ids estables, soft-delete), tablas de catálogo (`parameters`, `suppliers`,
`products`, `product_suppliers`, `product_prices`, `tiers`, `addons`, `packs`,
`pack_options`, `pack_option_values`, `pack_components`, `bundle_prices`,
`company`), presupuestos (`quotes` con cliente/teléfono/`valid_until`/estado,
`quote_items`, `quote_addons`) y control (`catalog_meta`, `audit_log`,
`snapshots`).

Cambios respecto a la versión con Worker:

```sql
-- catalog_meta gana las columnas de seguridad de actualización (§6):
--   min_app_version TEXT NOT NULL   -- la app más vieja que puede escribir
--   migrating_since TEXT            -- candado: una migración en curso
-- Tabla de control de migraciones aplicadas (la escribe la propia app):
CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL,
                                applied_by TEXT NOT NULL, app_version TEXT NOT NULL);
-- Plantillas PDF personalizadas (fase 8 — las 4 integradas van en el .exe):
CREATE TABLE pdf_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                            html TEXT NOT NULL, css TEXT NOT NULL,
                            version INTEGER NOT NULL DEFAULT 1,
                            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                            archived_at TEXT);
```

Las migraciones viven en el repo como SQL numerado (`db/migrations/0001_init.sql`,
`0002_….sql`) empaquetado dentro del `.exe`. Ya no se usa `wrangler` para
nada: **cero dependencias nuevas, ni de runtime ni de desarrollo**.

## 4. Operaciones (lo que antes era la API del Worker)

Las mismas operaciones, ahora como módulos del main process sobre
`lib/d1-client.js`:

| Operación | Implementación |
|---|---|
| Cargar catálogo | un lote de `SELECT` por tabla (no archivadas) + `catalog_version` |
| ¿Hay cambios? | `SELECT catalog_version FROM catalog_meta` |
| Escribir entidad | lote de sentencias **con guarda de versión**: `UPDATE … WHERE id=? AND version=?` → si `rows_written = 0` ⇒ conflicto (409 casero) → recargar entidad + diálogo diff. El lote incluye: cambio + bump de `version` y `catalog_version` + fila de `audit_log` + fila de `snapshots` |
| Borrar | `UPDATE … SET archived_at = ?` — archiva, nunca `DELETE` |
| Presupuestos | `INSERT OR IGNORE` (UUID cliente = idempotencia de la cola offline); estado con `UPDATE` |
| Estadísticas | los mismos `GROUP BY`, lanzados directo a D1; la app solo pinta |
| Restore | leer `snapshots[version]` → `disassemble` → lote de escritura, auditado |

**Validación:** vive solo en el cliente (`validateConfigSchema` antes de cada
escritura) — el **mismo modelo de confianza que el modo archivo actual**: los
usuarios son empleados de la propia empresa, igual que quienes hoy pueden
editar el `config.js` del NAS a mano.

**Atomicidad (honesto):** la API REST de D1 ejecuta cada sentencia
atómicamente, pero un lote no es una transacción interactiva. Mitigación:
(1) las guardas de versión hacen las escrituras autovalidantes; (2) toda
escritura es aditiva o idempotente (re-ejecutar un lote a medias no corrompe);
(3) el orden dentro del lote pone el dato primero y los metadatos después —
el peor caso realista es una fila de audit ausente, nunca un precio corrupto.
Para 2–3 escrituras semanales de usuarios de confianza, es suficiente; si
algún día doliera, la costura es el Worker (§9.2), no una reescritura.

## 5. Seguridad

| Capa | Decisión |
|---|---|
| Transporte | HTTPS (API oficial de Cloudflare) |
| Credencial | **API token de Cloudflare del cliente** (permisos solo D1), en `settings.json` de cada PC. Nunca en el repo, nunca en el renderer. Mismo token en todos los PCs de la empresa |
| Alcance del token | Puede tocar las D1 de esa cuenta — más ancho que un bearer fino. Mitigación: backups automáticos + Time Travel (§6) + el token es del cliente y solo expone *sus* datos. Rotación: crear token nuevo en el dashboard + actualizar settings |
| Errores humanos | Sin modo admin (decisión 2026-06-12): confirmación con resumen al guardar + auditoría con autor (`user` obligatorio) + rollback por snapshots |
| Electron | Sin cambios: `contextIsolation`, CSP, preload estrecho, `fetch` solo en main, `lib/path-guard.js` para el modo archivo |
| Aislamiento entre empresas | Total por construcción: cada empresa, su cuenta, su base, su token. No existe servidor común que comprometer |

### 5b. Telemetría de errores (decisión 2026-06-12, PRD R19)

El desarrollador no ve datos de clientes, pero **sí debe enterarse de los
errores antes de que se los cuenten**. Diseño:

- **Qué se envía:** errores no controlados del main process y fallos de
  migración/backend: stack trace, código de error, versión de app, versión de
  esquema, SO, modo de almacén (`file`/`d1`). **Lista blanca de campos** —
  jamás catálogo, precios, presupuestos, nombres, teléfonos ni tokens. El
  saneado se hace en el cliente antes de enviar y tiene test propio.
- **Transporte:** protocolo **Sentry-compatible** por `fetch` desde main —
  sin SDK, cero dependencias nuevas. El endpoint (DSN) es del desarrollador:
  Sentry free tier o GlitchTip; son **elementos de terceros asumidos**
  (única pieza ajena al almacén del cliente, junto a GitHub Releases). Las
  alertas en tiempo real (email/aviso) las da el propio servicio — el
  desarrollador no mantiene infraestructura.
- **Control del cliente:** ajuste «Enviar informes de error» (activado por
  defecto, desactivable), explicado en el primer arranque y en el manual con
  la lista exacta de campos.
- **Sin red:** los informes se encolan en local (mismo patrón outbox) y se
  envían al reconectar.

## 6. Actualizaciones de la app sin romper bases ajenas

El contrato de `ARCHITECTURE.md` §4.4 (idempotente, backup antes de escribir,
logged, lazy) aplicado a D1. La pregunta clave: *un cliente actualiza el
`.exe` y su esquema es viejo — ¿cómo se migra sin riesgo?*

```
.exe nuevo arranca → compara schema_migrations con sus migraciones empaquetadas
  ├─ al día → arranca normal
  └─ faltan migraciones:
       1. CANDADO   UPDATE catalog_meta SET migrating_since=? WHERE migrating_since IS NULL
                    (si falla: otro PC migra ahora mismo → esperar y releer)
       2. BACKUP    POST /export → dump SQL completo descargado a
                    %APPDATA%\packprice\backups\pre-migration-<fecha>.sql
                    (+ Time Travel de Cloudflare como red de 30 días, gratis)
       3. MIGRAR    aplicar las migraciones pendientes en orden, registrando
                    cada una en schema_migrations
       4. VERIFICAR cargar catálogo completo → validateConfigSchema → soltar candado
       5. SI FALLA  pantalla de error honesta + botón «Restaurar copia de
                    seguridad» (re-ejecuta el dump del paso 2) + instrucciones
                    de Time Travel en el runbook. La app no escribe nada más
```

Las reglas que hacen esto seguro (disciplinas de §9.1):

- **Solo migraciones aditivas** → un `.exe` viejo contra un esquema nuevo
  **sigue funcionando** (ignora columnas que no conoce). Nadie se queda
  tirado porque un compañero actualizó primero.
- `min_app_version` en `catalog_meta`: solo si una migración fuese
  excepcionalmente rompedora (evitarlo siempre), las apps viejas reciben
  «actualiza la app» en vez de un fallo críptico.
- El candado `migrating_since` evita que dos PCs migren a la vez; un candado
  más viejo de 10 min se considera huérfano (migración muerta) y se puede
  retomar.
- En **modo local**, nada de esto cambia: `lib/migrations.js` sigue haciendo
  exactamente lo mismo con el archivo, como siempre.

## 7. Caché local y cola offline

Sin cambios respecto a lo ya diseñado:

- **Caché:** `%APPDATA%\packprice\cache\catalog.json` (entidades +
  `catalog_version` + `fetched_at`), escritura atómica. Arranque: intento red
  (timeout 5 s) → si falla, caché en solo lectura con banner; sin caché ni
  red → pantalla de error con salida a modo local. Jamás datos inventados.
- **Outbox:** `outbox.json` para presupuestos y cambios de estado creados sin
  red; se vacía al arrancar y al pulsar «Actualizar»; UUIDs = reintentos
  idempotentes.
- Edición de catálogo deshabilitada sin conexión; presupuestar funciona
  siempre (cálculo 100% local).
- **En modo local** la pantalla de estadísticas usa solo el historial de ese
  PC (limitación documentada — la nube es lo que unifica los datos de todos).

## 8. Fases de implementación

Cada fase termina con `pnpm test` verde y es entregable por sí sola.

| Fase | Contenido | Criterio de aceptación |
|---|---|---|
| **0. Cliente D1 + migraciones** | `lib/d1-client.js` (REST, fetch nativo) + runner de migraciones de la app + `db/migrations/0001_init.sql` + candado/backup/verify (§6). **Tests de contrato del backend**: la misma batería corre contra `file` y `d1` — idénticas garantías de conflicto, versión y auditoría (PRD R18) | Contra una D1 de prueba: crear base, aplicar esquema de cero, re-aplicar = no-op; backup pre-migración aparece en `%APPDATA%`; suite de contrato verde en ambos adaptadores |
| **1. Ensamblador bidireccional** | `lib/catalog-assembler.js` puro: entidades ↔ `cfg` v4 | `assemble(disassemble(cfg)) ≅ cfg` contra `config.default.js`; validador v4 pasa |
| **2. Asistente + lectura** | Asistente primer arranque Local/Nube (UI-UX §2.0); aprovisionamiento automático (detectar cuenta, buscar/crear base); adaptador `d1` de lectura; caché; indicador + banner offline | PC-1 crea la base sola con un token recién pegado; PC-2 con el mismo token la encuentra y se conecta; sin red arranca de caché en solo lectura |
| **3. Escrituras** | Lotes con guarda de versión; diff→entidades; retirar la puerta de contraseña (confirmación con resumen); conflicto por entidad con diff | Pack en PC-A y producto en PC-B no chocan; misma entidad → conflicto + diálogo; guardar sin confirmar es imposible |
| **4. Auditoría, snapshots y restore** | Vistas de auditoría y versiones leyendo de D1; «Restaurar esta versión» | Rollback desde la app, auditado |
| **5. Presupuestos y estadísticas** | Tablas quotes (nombre, teléfono, `valid_until`); outbox; estados + recordatorio al arrancar; `renderer/charts.js` (SVG puro) + pantalla «Estadísticas» (UI-UX §2.7) | Presupuesto de PC-A visible en stats de PC-B; aceptado/rechazado mueve la conversión; offline encola y sube al reconectar; recordatorio aparece con datos de prueba |
| **6. Migración local↔nube** | «Subir a la nube» (catálogo + historial) y «Bajar a local» desde ajustes | Taller real: subir el config del NAS a su cuenta, una semana de doble comprobación, vuelta atrás probada |
| **7. Producto** | **Semilla demo neutra** (PRD R16): antes de tocar nada, **archivar el catálogo real** (copia fechada en el NAS, fuera del repo); después `config.default.js` pasa a catálogo de ejemplo genérico. **`LICENSE` Apache-2.0** en la raíz (confirmar titular del copyright con el propietario). **Manual de usuario** (instalación **con capturas del aviso SmartScreen** y sus pasos — `.exe` sin firmar asumido, PRD D3 —, backups, restore, token, FAQ). **«Exportar diagnóstico»** en ajustes (logs + versiones + SO, sin token). **Telemetría de errores** (§5b) con su saneador testeado. GitHub: repo público (tras D4), `main` = producción, `.exe` en Releases; ajustes: «Buscar actualizaciones al iniciar» (desactivable) + botón «Buscar ahora» | Release de prueba publicada; PC con versión vieja muestra el aviso; un tercero sigue el manual y monta su sistema de cero sin ayuda; el diagnóstico y los informes de error no contienen ni un dato de negocio (test del saneador) |
| **8. Plantillas PDF** | Motor propio `lib/template-engine.js` (~150 líneas: `{{campo}}`, `{{#each}}`, `{{#if}}` sobre HTML+CSS — estilo QWeb sin Odoo ni dependencias) + 6 plantillas integradas: **Clásica, Moderna, Compacta, Detallada, Corporativa, Formulario** — **diseños aprobados en `MainUI.pen`** (frames «PDF Plantilla — …», con el catálogo demo, A4). **Color de marca por empresa**: las plantillas con color (Corporativa, Moderna) consumen `{{brand.color}}` / `{{brand.dark}}` / `{{brand.soft}}`; el color base es un dato de `company` (clave-valor, sin migración) y los derivados se calculan en código; en Pencil están modelados como variables `$tpl-brand…`. **Todos los textos del presupuesto son datos, no plantilla**: condiciones, nota de confirmación y textos legales salen de `quote_settings`/`company` y cada empresa los redacta a su manera desde el editor (regla 2 de `CLAUDE.md`: ningún texto de negocio fijo en código); los diseños de Pencil muestran ejemplos neutros del catálogo demo. Selector con vista previa en ajustes. Plantillas personalizadas como **dato compartido** (tabla `pdf_templates` en D1 / sección en `config.js`): todos los PCs de la empresa imprimen igual. Saneado al cargar: sin `<script>`, sin recursos externos (la ventana de impresión mantiene CSP `'self'`) | Las 4 plantillas renderizan el mismo presupuesto correctamente; una plantilla personalizada subida en PC-A imprime idéntica en PC-B; una plantilla con `<script>` se rechaza con mensaje claro; tests del motor y del saneador |

## 9. Extensibilidad a largo plazo

### 9.1 Las cuatro disciplinas (desde la fase 0)

1. **Migraciones numeradas, siempre** (`db/migrations/`, aplicadas por la
   app, registradas en `schema_migrations`). El esquema es reproducible de
   cero — es también lo que aprovisiona a cada empresa nueva.
2. **Solo cambios aditivos.** Columnas nuevas `NULL`/`DEFAULT`; ids y columnas
   jamás se renombran ni reutilizan. Un `.exe` viejo nunca se rompe por una
   ampliación; `min_app_version` cubre el caso excepcional.
3. **Archivar, no borrar.** `archived_at` en todo lo referenciado por
   históricos. Los presupuestos de 2026 deben explicarse en 2030.
4. **Índices cuando duelan, no antes.** Llegado el día:
   `quotes(ts)`, `quotes(pack_id)`, `quotes(status)` — una migración de tres
   líneas.

### 9.2 Costuras previstas

| Ampliación futura | Qué necesitaría | Por qué es barato |
|---|---|---|
| **Ficha de cliente** (ya en `tier-2-ux-taller.md`) | Tabla `customers` + `quotes.customer_id NULL` | FK nullable aditiva |
| **Pedidos / producción** | Tabla `orders(quote_id, …)` | `status='accepted'` ya es el punto de entrada |
| **Histórico de precios de proveedor** | `supplier_price_history`, escrita por la app en el mismo lote | Una sentencia más en un lote existente |
| **Stock / inventario** | `stock` + `stock_movements` | Independientes; ids estables |
| **Segunda sede** | Columna `location DEFAULT '…'` | Aditiva; invisible mientras haya una |
| **Portal web de cliente** | Aquí **sí** nacería un Worker (solo lectura) delante de la D1 del cliente — el renderer de un navegador no puede llevar el token | La única costura que reintroduce servidor; reabre el debate de `CLAUDE.md` y el de auth |
| **Exportación contable** | `SELECT …` → CSV desde la propia app | Las tablas normalizadas ya son el formato |
| **Nube privada del cliente** (su propio servidor) | Un tercer adaptador detrás de `lib/config-backend.js` (p. ej. SQLite/Postgres self-hosted). **No se promete**: el contrato del backend es la costura; se construye solo si un cliente real lo paga | La interfaz ya existe; los tests de contrato (R18) definen exactamente qué debe cumplir un adaptador nuevo. Mientras tanto, su NAS/VPN + modo archivo ya cubre el 90 % del caso |
| **Logo de empresa en el PDF** (lo pedirá todo cliente) | Campo de imagen en `company` + render en `pdf-template` | Dato, no código; aditivo |
| **Multi-tenant SaaS real** (decenas de empresas y querer gestión central) | `tenant_id` en tablas + servicio central | Migración aditiva más un debate completo; hoy el aislamiento por cuenta es mejor y más barato |

Cualquiera de estas requiere su línea en el debate de `CLAUDE.md` §2 antes de
empezar.

## 10. Riesgos y rollback

- **Rollback global:** «Bajar a local» desde ajustes — el modo archivo
  completo sigue existiendo. Ninguna fase quema las naves.
- **Migración de esquema fallida en casa de un cliente:** §6 — backup
  automático previo + botón de restaurar + Time Travel. La app nunca escribe
  sobre una base a medio migrar.
- **Token con permisos D1 filtrado:** expone solo los datos de esa empresa;
  rotación inmediata desde su dashboard; backups locales y Time Travel cubren
  el peor caso (borrado malicioso).
- **Cloudflare cambia la API REST de D1:** versionada por Cloudflare
  (`/client/v4/`); el cliente REST está aislado en `lib/d1-client.js` — un
  solo lugar que tocar (§11 de `ARCHITECTURE.md`: one place per concern).
- **Coste:** free tier de D1 por cuenta de cliente (5 GB, 5 M lecturas/día) —
  órdenes de magnitud por encima del uso real de un taller.
