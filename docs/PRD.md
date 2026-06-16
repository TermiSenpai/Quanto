# PRD — Quanto

**Versión:** 1.0 · **Fecha:** 2026-06-12 · **Estado:** aprobado
**Documentos relacionados:** `PLAN_Calculadora.md` (modelo de negocio),
`docs/UI-UX.md` (diseño), `planes/v5-cloud-sync.md` (plan técnico v5),
`ARCHITECTURE.md` (arquitectura).

> Este PRD define **qué** hace Quanto y **por qué**. El *cómo* vive en
> `ARCHITECTURE.md` y en los planes. Si producto y código divergen, se corrige
> uno de los dos — nunca se deja un hueco silencioso.

---

## 1. Visión

Quanto es la calculadora de precios de packs DTF de un taller textil de
Guadalajara (+25 años en el sector). Sustituyó a una Excel con errores por una
app de escritorio que da **precios correctos, consistentes entre trabajadores y
modificables sin tocar código**. La v5 deja elegir dónde viven los datos —
**local** (archivo en PC o NAS) o **nube** (Cloudflare D1 en la cuenta de cada
empresa, aprovisionada automáticamente por la app, sin servidor propio) — para
ganar acceso fuera del taller, trazabilidad real y poder venderse a otras
empresas sin mantener infraestructura por cliente.

## 1b. Principio rector del producto (2026-06-12)

> **El desarrollador no conoce los datos de ningún cliente.** Cada empresa es
> dueña y operadora de su propio sistema de almacenamiento (un PC, un NAS,
> su cuenta de Cloudflare, su nube privada). El desarrollador solo entrega
> software. Toda decisión de diseño parte de aquí.

Consecuencias que obligan a todo lo demás:

1. **La app debe cuidarse sola:** aprovisionamiento, migraciones, backups y
   restauración ocurren dentro de la app, sin intervención del desarrollador.
2. **El soporte es a ciegas:** sin acceso a los datos, el diagnóstico depende
   de buenos mensajes de error, logs locales y un export de diagnóstico que
   el cliente decide compartir (R17).
3. **Un solo producto, sin forks:** las diferencias entre empresas son
   **configuración** (catálogo, parámetros), nunca ramas de código por
   cliente. Es la extensión natural del v4 "el catálogo es dato".
4. **El taller de Guadalajara pasa a ser el cliente nº 1** — no el centro del
   producto. Sus números viven en *sus* datos, no en el código ni en la
   semilla (R16).
5. **Transparencia total de red.** Fuera del almacén del cliente, la app solo
   habla con: (a) GitHub Releases para comprobar versión (R15, desactivable) y
   (b) el servicio de informes de error (R19, desactivable, **jamás contiene
   datos de negocio** — solo stack trace, versiones y SO). Ambas conexiones
   están declaradas en el manual; no existe ninguna otra.

## 2. Usuarios

| Usuario | Necesidad | Frecuencia |
|---|---|---|
| **Trabajador de mostrador** (2–3 personas) | Presupuestar un pack en <1 min con el precio vigente | Diaria, en temporada alta constante |
| **Admin del taller** (1–2 personas) | Cambiar precios, costes, márgenes y catálogo; que el cambio llegue a todos los PCs | Semanal/mensual |
| **Propietario** | Confianza en que ningún presupuesto sale por debajo de coste; trazabilidad de quién cambió qué | Puntual |

Todos son perfiles técnicos básicos. UI en **español**; sin formación previa.

## 3. Objetivos de producto y estado

### 3.1 Cumplidos (v4, en beta)

| # | Requisito | Implementación |
|---|---|---|
| R1 | Packs con mínimo de unidades (10 por defecto, configurable por pack) | `min_total` por pack; tramo T1 = 10–24 uds (`PLAN_Calculadora.md` §2.3) |
| R2 | Crear, editar y eliminar packs sin tocar código | CRUD completo en modo admin (`renderer/admin.js`); un pack es **dato**, no código |
| R3 | PVP recomendado | `recommendedPrice`: redondeo al alza de `coste / (1 − margen_objetivo)` a terminación `x,95`; sugerido, nunca impuesto |
| R4 | Precios y costes compartidos: un cambio se refleja en todos los PCs | `config.js` único en el NAS + detección de conflictos (hash + mtime) + backups + auditoría |
| R5 | Empaquetado portable Windows | `pnpm build:win` → `.exe` portable x64 |

### 3.2 Nuevos (v5 — esta iteración)

| # | Requisito | Criterio de aceptación |
|---|---|---|
| R6 | **Catálogo en la nube (Cloudflare D1, tablas normalizadas, sin servidor propio)** | La app habla con D1 directamente (API REST, solo main process); lee al abrir y al pulsar «Actualizar»; un cambio es visible en otro PC tras actualizar |
| R7 | **Caché local de respaldo** | Sin internet, la app arranca con los últimos datos descargados en modo solo lectura, con aviso visible de fecha de los datos |
| R8 | **Escrituras por entidad, sin modo admin** | La edición del catálogo está siempre disponible (desaparece la puerta de contraseña); guardar pide confirmación con resumen de cambios; dos personas editando entidades distintas no chocan; misma entidad → diálogo de conflicto con diff |
| R9 | **Trazabilidad y vuelta atrás** | Cada escritura registra autor (nombre del equipo/trabajador), fila de auditoría y snapshot versionado; restaurar cualquier versión anterior desde la propia app |
| R10 | **Local o nube, a elección, intercambiable** | Asistente de primer arranque: «¿Dónde guardamos tus datos?» → Local (ruta en PC o NAS) o Nube (la app aprovisiona la D1 en la cuenta Cloudflare de la empresa con un token guiado; si la base ya existe, se conecta sola — segundo PC). «Subir a la nube» y «Bajar a local» disponibles en cualquier momento desde ajustes |
| R10b | **Actualizar la app nunca rompe datos** | Si el `.exe` nuevo encuentra un esquema viejo: candado anti-concurrencia → **backup automático** (dump SQL a `%APPDATA%` + Time Travel) → migración aditiva → verificación con el validador → si falla, botón «Restaurar copia de seguridad» y la app no escribe nada más. Un `.exe` viejo contra esquema nuevo sigue funcionando (migraciones solo aditivas) |
| R11 | **Devlog profesional por release** | Cada release publica una entrada en `devlog/` siguiendo `devlog/TEMPLATE.md` (capturas + gráficos) |
| R12 | **Presupuestos sincronizados a la nube** | Cada presupuesto guardado se sube a D1 (resumen + líneas); sin conexión se encola en local y se sube al reconectar; el historial local sigue funcionando igual |
| R13 | **Datos del cliente en el presupuesto** | Nombre y teléfono obligatorios al guardar; validez de 15 días (`quote_settings.validity_days`, configurable como todo dato de negocio) impresa en el PDF |
| R13b | **Estado del presupuesto** | Cualquier trabajador marca pendiente / aceptado / rechazado desde el historial. Al abrir la app, recordatorio discreto: presupuestos sin estado con más de 7 días y los que caducan esta semana |
| R14 | **Pantalla de estadísticas** | Gráficos (SVG propio, sin librerías) sobre los datos de todos los PCs: packs más presupuestados, conversión, tramos, evolución temporal, margen real vs objetivo, productos/addons más usados, desviación sobre el PVP recomendado y frecuencia de tallas especiales |
| R15 | **Distribución y actualización por GitHub** | Repo público; `main` es producción: cada release publica el `.exe` en GitHub Releases. La app comprueba al arrancar (si hay red) si existe versión nueva y lo avisa con enlace de descarga — sin auto-instalación; comprobación desactivable en ajustes |
| R16 | **Semilla neutra de demo** | `config.default.js` deja de contener el catálogo real del taller: la semilla es un catálogo de demostración genérico y claramente marcado («datos de ejemplo — edítalos»). **Antes de quitarlo, el catálogo real se archiva** (copia fechada en el NAS del taller, fuera del repo) para no perder los datos — además de que ya viven en su `config.js` de producción y sus backups |
| R17 | **Soporte a ciegas** | Manual de usuario (instalación, copias de seguridad, restauración, token, problemas frecuentes) + botón «Exportar diagnóstico» en ajustes: zip con logs, versión de app y esquema, SO y settings **sin token** — el cliente decide si lo comparte |
| R18 | **Paridad de backends garantizada** | La misma batería de tests de contrato corre contra el adaptador `file` y el `d1`: ambas rutas dan idénticas garantías (conflictos, versiones, auditoría). Un bug que solo existe en un backend es un bug de la suite |
| R19 | **Informes de error en tiempo real** | Los errores no controlados del main process se envían automáticamente a un servicio de errores (protocolo Sentry-compatible, sin SDK — `fetch` propio): el desarrollador se entera **antes** que el cliente. Contenido estricto: stack trace, código de error, versión de app y esquema, SO — **nunca precios, clientes ni catálogo**. Desactivable en ajustes y declarado en el manual |
| R20 | **Plantillas de presupuesto PDF** | 6 plantillas integradas (Clásica, Moderna, Compacta, Detallada, Corporativa, Formulario) seleccionables en ajustes con vista previa. Las que usan color exponen un **color de marca configurable por la empresa** (dato en `company`, con derivados oscuro/suave calculados). Motor de plantillas propio estilo QWeb (HTML+CSS con directivas declarativas, sin librerías). Usuarios con conocimientos pueden crear plantillas personalizadas, que se guardan en el almacén compartido de la empresa (todos sus PCs imprimen igual); se sanean al cargar (sin scripts ni recursos externos) |

### 3.3 Fuera de alcance (decidido, no olvidado)

- Usuarios individuales con roles y contraseñas — para 2–3 usuarios de
  confianza basta el token compartido + trazabilidad (quién cambió qué) +
  rollback. La clave de admin desaparece en v5.
- Edición offline con sincronización posterior (merge distribuido).
- App web o móvil; telemetría; TypeScript en la app Electron.
- Sincronización automática en segundo plano — la carga es mínima por diseño:
  **lectura al abrir + actualización manual** (la cola de presupuestos
  pendientes de subir se vacía en esos mismos momentos).
- Librerías de gráficos (Chart.js y similares) — los gráficos son SVG propio.
- Telemetría externa — las estadísticas son **datos de negocio propios en la
  D1 propia** (qué se presupuesta y se vende), nunca datos de uso de la app
  enviados a terceros.

## 4. Requisitos no funcionales

| Categoría | Requisito |
|---|---|
| Rendimiento | Arranque con red <3 s; cálculo de pack instantáneo (<50 ms, ya cumplido — es función pura local) |
| Disponibilidad | Sin internet la app **siempre** arranca (caché o fallback archivo); nunca pantalla en blanco |
| Seguridad | Invariantes Electron intactas (`contextIsolation`, CSP `'self'`); red **solo desde el main process**; el API token de Cloudflare (del cliente, solo permisos D1) vive en `settings.json` local — nunca en el repo ni en el renderer; el modelo de protección de escrituras es **trazabilidad + rollback**, no puertas de contraseña |
| Coste | Free tier de Cloudflare D1 **en la cuenta de cada empresa** (uso: decenas de lecturas/día, escrituras semanales); el desarrollador no paga ni mantiene infraestructura por cliente |
| Datos | Toda escritura es transaccional, auditada y con snapshot; pérdida de datos = bug crítico |
| Mantenibilidad | **Cero dependencias nuevas, ni de runtime ni de desarrollo** (el cliente D1 es `fetch` nativo en main); sin servidor propio que mantener; los 200+ tests siguen verdes |

## 4b. Decisiones pendientes del propietario (bloquean la venta, no el desarrollo)

| # | Decisión | Estado |
|---|---|---|
| D1 | **Licencia del repo** | ✅ **Resuelta (2026-06-12): Apache-2.0.** Permisiva con concesión de patentes. Implicación asumida: cualquiera puede usar y modificar la app gratis — el negocio es el servicio (instalación, soporte, evolución), no la licencia |
| D2 | **Modelo de cobro** | ✅ Implícitamente resuelta por D1: **servicio**, no licencia técnica. Sin control de licencias en el software |
| D3 | **Firma de código** | ✅ **Resuelta (2026-06-12): sin certificado por ahora.** El manual documenta el aviso de SmartScreen con capturas y los pasos «Más información → Ejecutar de todas formas». Revisar cuando haya clientes de pago |
| D4 | **Qué docs se publican** | ⏳ Pendiente: `PLAN_Calculadora.md` y el devlog contienen márgenes y precios reales del taller (cliente nº 1) — decidir antes de abrir el repo |

### 4b.1 Tareas de release del propietario (no son código)

Estas tareas las ejecuta el propietario **en el momento de abrir el repo /
publicar la primera release pública**, no el desarrollo. Quedan listadas aquí
para que no se pierdan:

| # | Tarea de release | Detalle |
|---|---|---|
| R16 | **Semilla demo neutra** (tarea del propietario, no de código) | `config.default.js` contiene hoy el catálogo real del taller (cliente nº 1) y es a la vez el fixture que fija los importes exactos de `tests/calculo.test.js` y otros. Neutralizarlo es una **tarea de release**, no un cambio de la v5: (1) el propietario **archiva antes** el `config.js`/catálogo real a `\\NAS\…\archivo\` (paso de operaciones, principio rector §1b); (2) se sustituye `config.default.js` por un catálogo demo genérico marcado «datos de ejemplo — edítalos»; (3) se re-fijan los importes de los tests al nuevo seed (PR propio y acotado). Está atada a **D4** (qué números se publican), aún pendiente. **No se toca el seed en la v5.** Plan: `planes/v5-impl-plan-7-producto.md` §0 |
| — | **`GITHUB_REPO` real** | El check de versión (R15) usa la constante `GITHUB_REPO` de `main.js` (hoy `'xkoistudio/packprice'`, **placeholder**). Antes de publicar la primera release, el propietario confirma el `owner/repo` real del repositorio público y, si difiere, lo ajusta. El DSN de informes de error (R19) es del desarrollador y ya está fijado |
| — | **Titular del copyright en `LICENSE`** | `LICENSE` (Apache-2.0) en la raíz; confirmar la línea de copyright (`© xkoistudio`) con el propietario antes de abrir el repo |

## 5. Métricas de éxito

1. **Cero presupuestos con precio desactualizado** tras un cambio de admin
   (hoy: posible si un PC no relee el NAS; v5: el indicador de versión avisa).
2. Un cambio de precio tarda **<2 min** de extremo a extremo (editar → guardar
   → visible en otro PC tras actualizar).
3. Caída de internet en el taller → **0 interrupciones** de presupuestación
   (modo solo lectura con caché).
4. Cada release con su entrada de devlog publicada **antes** de distribuir el
   `.exe`.
5. Al cierre de la primera temporada con v5: poder responder con datos, no
   con intuición, a «¿qué pack se vende más?», «¿qué pack no convierte?» y
   «¿estamos respetando el margen objetivo?» — y al menos **una decisión de
   catálogo** (precio, pack retirado o nuevo) tomada a partir de la pantalla
   de estadísticas.

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Cloudflare caído o sin internet en momento de venta | Caché local solo-lectura + modo local siempre disponible (R7, R10) |
| API token filtrado | Solo expone los datos de esa empresa (su cuenta); rotación inmediata desde su dashboard; backups locales + Time Travel cubren hasta el borrado malicioso |
| Migración de esquema falla en casa de un cliente | R10b: backup automático previo + restaurar con un botón + Time Travel; migraciones solo aditivas para que apps viejas nunca se rompan |
| Cambio accidental o erróneo de precios | Confirmación con resumen antes de guardar; auditoría con autor; rollback a cualquier versión en <1 min |
| Repo público expone información sensible | Secretos jamás en el repo (regla dura 10); **pendiente de decisión del propietario:** `PLAN_Calculadora.md` y el devlog contienen márgenes y precios reales del taller — revisar qué docs se publican antes de abrir el repo |
| Migración corrompe el catálogo | El NAS no se toca durante la transición; importación a D1 validada contra `validateConfigSchema`; rollback = volver al modo archivo |
| Deriva de esquema entre D1 y la app | `schema_version` en `catalog_meta`; el ensamblador valida con el mismo validador v4 de siempre |

## 7. Historial de decisiones

- **2026-06-12** — Aprobada la migración a Cloudflare D1 con tablas puras,
  ensamblador en cliente y caché de respaldo (debate documentado en
  `CLAUDE.md`; detalle en `planes/v5-cloud-sync.md`). Aprobado el estándar de
  devlog por release.
- **2026-06-12** — **Eliminado el modo admin en v5.** La edición del catálogo
  queda siempre disponible; la protección pasa de una contraseña compartida
  (que solo era anti-clic accidental) a confirmación al guardar + auditoría
  con autor + rollback por snapshots.
- **2026-06-12** — **Distribución por GitHub** (repo público, `main` =
  producción, `.exe` en Releases, aviso de versión nueva en la app). El
  presupuesto pasa a llevar nombre y teléfono obligatorios, con validez de
  15 días.
- **2026-06-12** — **Modelo multi-empresa: autoservicio, sin Worker.**
  Revisión el mismo día: se elimina el Worker. La app habla con D1
  directamente por la API REST de Cloudflare y **se aprovisiona sola la base
  en la cuenta de cada empresa** (asistente de primer arranque, token guiado,
  estilo FactuSOL). Vender a otra empresa = entregar el `.exe`; cero deploys
  y cero infraestructura del desarrollador. Local ↔ nube intercambiable en
  cualquier momento. La validación pasa a ser solo-cliente (mismo modelo de
  confianza que el NAS); las migraciones de esquema las aplica la app con
  backup automático previo y fallback (R10b). El multi-tenant real queda como
  costura (`planes/v5-cloud-sync.md` §9.2).
- **2026-06-12** — **Productización:** licencia **Apache-2.0** (negocio =
  servicio); `.exe` sin firmar asumido y documentado en el manual; semilla
  demo neutra con archivado previo del catálogo real; **informes de error en
  tiempo real** (R19) como excepción declarada y desactivable a la regla de
  no-telemetría — nunca datos de negocio; plantillas PDF (R20) con motor
  propio estilo QWeb y plantillas personalizadas como dato compartido.
- **2026-06-13** — **Cierre de la v5 (`5.0.0-beta`).** Implementados R6–R20
  (almacenamiento local/nube sin servidor, asistente, sin gate de admin,
  auditoría + rollback, presupuestos con cliente + estados + recordatorio,
  estadísticas SVG, 6 plantillas PDF + color de marca + personalizadas,
  telemetría opt-out + diagnóstico + check de versión por GitHub). Publicado
  el **manual de usuario** (`docs/MANUAL.md`) y el **devlog 13**. Versión
  bumpeada `4.0.0-beta → 5.0.0-beta`. R16 (semilla demo) queda como tarea de
  release del propietario (§4b.1), igual que confirmar `GITHUB_REPO` real y
  el titular del copyright.
