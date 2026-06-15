# Plan · Migración del código a inglés (alcance completo)

Aplica CLAUDE.md §2: **todo el código en inglés**. Los **strings visibles al usuario siguen en español** (mensajes, botones, labels, contenido del PDF). Como ahora el alcance incluye claves persistidas (`config.js` del NAS, `presupuestos.json` local, `audit.log`, `settings.json`), el plan añade una migración de esquema **idempotente, versionada y con backup** que corre la primera vez que un PC abre un archivo en el formato antiguo.

> **Documento operativo, no aspiracional.** Cada onda deja la app en estado verde. Si una onda se aplaza, déjalo anotado al final ("Estado").

---

## 1. Objetivo

Pasar a inglés:

1. **Identificadores de código** (funciones, variables, parámetros, comentarios, JSDoc).
2. **Canales IPC** y **payloads** entre `main.js` y el renderer.
3. **Claves del esquema** del `config.js` del NAS (sección `parametros`, `modelos_roly`, `tramos`, `packs`, `admin`, `empresa`, `presupuesto` y todo su contenido).
4. **Claves del objeto resultado** del cálculo (`total_iva_inc`, `pvp_unitario`, `coste_total`, …).
5. **Claves de `presupuestos.json`** (historial local de presupuestos por PC).
6. **Campos de `audit.log`** (append-only en NAS).
7. **Claves de `settings.json`** (per-PC, en `%APPDATA%`).
8. **IDs HTML** y selectores CSS asociados.

Lo que **NO** cambia:

- **Strings visibles al usuario** (UI, mensajes de error mostrados, contenido del PDF para el cliente, botones, labels, hints, títulos de diálogo).
- **Cabecera comentada del `config.js` generado** (la lee un humano del negocio si abre el archivo).
- **Valores de los enums del config** que no son claves estructurales pero sí se renderizan al usuario (ej. `etiqueta: '10-24 uds'`, `nombre: 'Camiseta'`). Estos viven en `config.default.js` y se serializan al config.js. Se quedan en español porque los ve el usuario en la UI.

## 2. Estrategia

La migración del esquema de datos sigue **CLAUDE.md §6.3** al pie de la letra:

1. **Bump de versión**: `config.default.js:VERSION` pasa de `'2.0.0'` a `'3.0.0'`.
2. **Migración idempotente**: `migrateConfig(config)` en `main.js` (o `lib/migrations.js` si crece) detecta `version: '2.x'` y devuelve un objeto en formato v3. Ejecutarla dos veces produce el mismo output.
3. **Backup automático con etiqueta**: antes de escribir el config migrado se guarda backup con el sufijo `pre-v3-migration` además del timestamp habitual. La carpeta `<NAS>\Packs\backups\` ya existe.
4. **Migración perezosa**: corre la primera vez que `config:read` ve un config v2 en cualquier PC del taller. Al terminar, escribe el config en v3 al NAS (atómica vía el flujo normal: backup → write).
5. **Persistencia local (`presupuestos.json`, `settings.json`)**: migración perezosa similar al abrir el archivo. Backup local antes de sobrescribir.
6. **Audit log (`audit.log`)**: append-only en NAS, no migra. El **reader** acepta ambas formas y normaliza a v3 en memoria. Los **writes** nuevos usan v3.
7. **Rollback**: si tras desplegar la versión v3.x.x se detecta un bug crítico antes de que ningún PC haya escrito un config v3, basta con instalar el .exe anterior. Si ya hubo escrituras v3, hay que restaurar el backup `pre-v3-migration` manualmente. **Documentado en `README-build.md`** como parte de esta onda.

### Por qué migración perezosa y no migración manual de todos los archivos

- Hay un único `config.js` (en el NAS). El primer PC que lo abra tras actualizar lo migra.
- Hay un `presupuestos.json` por PC. Cada PC lo migra la primera vez que actualiza.
- No requiere acción manual del usuario.
- Los backups quedan al lado, recuperables.

### Adapter durante el rollover

Para que el código nuevo (que asume v3 puro) **no tenga ramas v2/v3 esparcidas**, la migración se concentra en una única capa:

- `migrateConfig(rawConfig)` → devuelve v3.
- `migrateQuote(rawQuote)` → devuelve quote en formato v3 (para `presupuestos.json`).
- `normalizeAuditEntry(rawEntry)` → devuelve entrada de audit en formato v3 en memoria.
- `migrateSettings(rawSettings)` → devuelve settings v3.

Todas se invocan al **entrar** datos al sistema (read). Nadie más en el código mira al formato v2.

---

## 3. Inventario

| Archivo | Líneas | Estado | Tipo de cambio |
|---|---:|---|---|
| `lib/config-parser.js` | 194 | ES | Renombrar identificadores (Onda 1) |
| `lib/config-schema.js` | – | EN | Actualizar a validar v3 (Onda 2) |
| `lib/diff.js` | – | EN | Sin cambios funcionales; aceptar claves nuevas |
| `lib/audit.js` | – | EN | Añadir reader dual-shape (Onda 8) |
| `lib/history.js` | – | EN | Migración perezosa de `presupuestos.json` (Onda 7) |
| `lib/logger.js` | – | EN | Sin cambios |
| `lib/pdf-template.js` | – | EN | Actualizar a leer claves de resultado v3 (Onda 6) |
| **`lib/migrations.js`** | nuevo | EN | Nuevo módulo: `migrateConfig`, `migrateQuote`, `migrateSettings`, `normalizeAuditEntry` (Onda 2) |
| `config.default.js` | 187 | ES (claves) | Emitir v3 (Onda 2) |
| `main.js` | 767 | ES | Renombrar + wire migrations (Onda 3) |
| `preload.js` | 63 | ES | Renombrar API expuesta + canales IPC (Onda 4) |
| `renderer/format.js` | 38 | ES | Renombrar helpers (Onda 5) |
| `renderer/calculo.js` | 303 | ES | Renombrar + cambiar shape del resultado a v3 (Onda 6) |
| `renderer/admin.js` | 494 | ES | Renombrar + actualizar `data-cfg-path` a claves v3 (Onda 9) |
| `renderer/app.js` | 1964 | ES | Renombrar + IDs HTML v3 (Ondas 10 + 11) |
| `renderer/history.js` | 116 | EN | Actualizar a quotes v3 (Onda 7) |
| `renderer/admin-extras.js` | 161 | EN | Renderizar audit normalizado v3 (Onda 8) |
| `renderer/index.html` | 671 | ES (IDs) | Renombrar IDs a inglés (Onda 11) |
| `renderer/styles.css` | – | ES (selectores) | Actualizar selectores acoplados a IDs (Onda 11) |
| `tests/config-parser.test.js` | 196 | ES | Imports nuevos + fixtures v3 + tests de migración (Onda 1) |
| `tests/config-schema.test.js` | – | EN | Validar v3 (Onda 2) |
| `tests/calculo.test.js` | 242 | ES | Imports nuevos + expects con claves v3 (Onda 6) |
| `tests/config-default.test.js` | 76 | ES | Claves v3 (Onda 2) |
| **`tests/migrations.test.js`** | nuevo | EN | Round-trip v2→v3, idempotencia, edge cases (Onda 2) |
| `tests/history.test.js` | – | EN | Añadir migración perezosa de quotes (Onda 7) |
| `tests/audit.test.js` | – | EN | Añadir lectura dual-shape (Onda 8) |
| `tests/pdf-template.test.js` | – | EN | Render con quote v3 (Onda 6) |

Total a tocar: ~4 200 líneas + ~400 líneas nuevas (`lib/migrations.js` y tests).

---

## 4. Glosario canónico (completo)

> **Convención de naming en el config.js**: `snake_case` para consistencia con el JSON que se serializa al NAS y porque el `config.js` actual ya es snake_case. Sólo los nombres de modelo Roly mantienen UPPERCASE (`BEAGLE`, `CLASICA`, `URBAN`) — son identificadores de catálogo del proveedor, no claves del esquema.
>
> **Convención en código JS**: `camelCase` para variables, funciones, métodos del preload y nombres de fichero auxiliares.
>
> **Convención en HTML/CSS**: `kebab-case` para IDs y clases.

### 4.1 Esquema del config (claves persistidas)

#### Top-level

| Antes (v2) | Después (v3) |
|---|---|
| `version` | `version` |
| `fecha_actualizacion` | `updated_at` |
| `modificado_por` | `modified_by` |
| `admin` | `admin` |
| `parametros` | `parameters` |
| `modelos_roly` | `roly_models` |
| `tramos` | `tiers` |
| `packs` | `packs` |
| `empresa` | `company` |
| `presupuesto` | `quote_settings` |

#### `admin.*`

| Antes | Después |
|---|---|
| `clave` | `password` |
| `tiene_clave` (stripped) | `has_password` |

#### `parameters.*` (antes `parametros.*`)

| Antes | Después |
|---|---|
| `mo_eur_hora` | `labor_eur_hour` |
| `iva` | `vat` |
| `merma_pct` | `waste_pct` |
| `indirectos_eur_prenda` | `overhead_eur_garment` |
| `buffer_3xl_eur_pack` | `buffer_3xl_eur_pack` |
| `recargo_4xl_eur` | `surcharge_4xl_eur` |
| `recargo_5xl_eur` | `surcharge_5xl_eur` |
| `envio_roly_eur_bulto` | `roly_shipping_eur_bundle` |
| `prendas_por_bulto` | `garments_per_bundle` |
| `dtf_eur_metro` | `dtf_eur_meter` |
| `dtf_metros_2caras` | `dtf_meters_two_sides` |
| `dtf_metros_1cara` | `dtf_meters_one_side` |
| `planchado_eur_cara` | `pressing_eur_side` |
| `minutos_2caras_base` | `minutes_two_sides_base` |
| `minutos_1cara_base` | `minutes_one_side_base` |
| `extra_nombre_eur` | `extra_name_eur` |
| `extra_manga_corta_eur` | `extra_short_sleeve_eur` |
| `extra_manga_larga_eur` | `extra_long_sleeve_eur` |

#### `roly_models.<ID>.*` (antes `modelos_roly.<ID>.*`)

Los IDs (`BEAGLE`, `CLASICA`, `URBAN`) se quedan. Las claves internas cambian:

| Antes | Después |
|---|---|
| `nombre` | `name` |
| `ref` | `ref` |
| `precio` | `price` |

Los **valores** de `name` (`'Camiseta'`, `'Sudadera sin capucha'`, `'Sudadera con capucha'`) se renderizan al usuario y **siguen en español**.

#### `tiers[*].*` (antes `tramos[*].*`)

| Antes | Después |
|---|---|
| `id` | `id` |
| `etiqueta` | `label` |
| `desde` | `from` |
| `hasta` | `to` |
| `reduccion_tiempo` | `time_reduction` |

Los valores de `label` (`'10-24 uds'`, etc.) se renderizan y **siguen en español**.

#### `packs.<id>.*`

##### IDs de pack

| Antes | Después |
|---|---|
| `pena_completa` | `crew_full` |
| `solo_camisetas` | `tshirts_only` |
| `solo_clasica` | `classic_only` |
| `solo_urban` | `urban_only` |
| `sudaderas_mixto` | `hoodies_mixed` |
| `personalizado` | `custom` |

##### Campos comunes

| Antes | Después |
|---|---|
| `tipo` | `type` |
| `nombre` | `name` |
| `min` | `min` |
| `min_total` | `min_total` |
| `modelo` | `model` |
| `pvp` | `prices` |
| `packs_referencia` | `reference_packs` |
| `modelos_referencia` | `reference_models` |

##### Valores de `type`

| Antes | Después |
|---|---|
| `'pena'` | `'crew'` |
| `'individual'` | `'single'` |
| `'mixto'` | `'mixed'` |
| `'personalizado'` | `'custom'` |

##### Estructura de `prices` (antes `pvp`)

| Antes | Después |
|---|---|
| `con_capucha` | `with_hood` |
| `sin_capucha` | `without_hood` |
| `dos_caras` | `two_sides` |
| `una_cara` | `one_side` |

Los **IDs de tramo** dentro de `prices` (`T1`, `T2`, `T3`, `T4`) se mantienen — son identificadores estables del dominio.

##### `reference_packs` y `reference_models`

Mapas `{ <RolyModelId>: <pack_id> }` o `{ BEAGLE: 'tshirts_only', CLASICA: 'classic_only', URBAN: 'urban_only' }`. Las claves del mapa (`BEAGLE`, …) se quedan; los valores son IDs de pack y siguen el rename de §4.1.

#### `company.*` (antes `empresa.*`)

| Antes | Después |
|---|---|
| `nombre` | `name` |
| `cif` | `tax_id` |
| `direccion` | `address` |
| `telefono` | `phone` |
| `email` | `email` |
| `web` | `web` |

#### `quote_settings.*` (antes `presupuesto.*`)

| Antes | Después |
|---|---|
| `validez_dias` | `validity_days` |
| `condiciones` | `terms` |

El **texto** de `terms` se renderiza al cliente en el PDF y **sigue en español**.

### 4.2 Objeto resultado del cálculo

Devuelto por `calculate*Pack`, consumido por la UI, el PDF y el historial.

| Antes | Después |
|---|---|
| `pack` | `pack` |
| `tramo` | `tier` |
| `cantidad` | `quantity` |
| `cantidad_total` | `total_quantity` |
| `pvp_unitario` | `unit_price` |
| `cant_4xl` | `qty_4xl` |
| `cant_5xl` | `qty_5xl` |
| `caras` | `sides` |
| `subtotal` | `subtotal` |
| `recargos` | `surcharges` |
| `extras_sin_iva` | `extras_no_vat` |
| `extras_detalle` | `extras_detail` |
| `total_iva_inc` | `total_vat_inc` |
| `base_venta` | `sale_base` |
| `iva` | `vat` |
| `coste_unitario` | `unit_cost` |
| `coste_total` | `total_cost` |
| `margen` | `margin` |
| `margen_pct` | `margin_pct` |
| `desglose` | `breakdown` |
| `es_mixto` | `is_mixed` |
| `es_personalizado` | `is_custom` |
| `extra` | `extra` |
| (dentro de `extras_detail`) `nombres` | `names` |
| (dentro de `extras_detail`) `mangas_cortas` | `short_sleeves` |
| (dentro de `extras_detail`) `mangas_largas` | `long_sleeves` |
| (dentro de `breakdown`) `modelo` | `model` |
| (dentro de `breakdown`) `nombre` | `name` |
| (dentro de `breakdown`) `cantidad` | `quantity` |
| (dentro de `breakdown`) `pvp` | `price` |
| (dentro de `breakdown`) `subtotal` | `subtotal` |
| (dentro de `breakdown`) `caras` | `sides` |
| (dentro de `extra`) `capucha` | `hood` |
| (dentro de `extra`) `modelo` | `model` |
| (dentro de `extra`) `caras` | `sides` |

### 4.3 `presupuestos.json` (historial local)

Cada entrada es un quote con metadata. Conserva el shape del resultado de §4.2 más:

| Antes | Después |
|---|---|
| `id` | `id` |
| `fecha` | `date` |
| `usuario` | `user` |
| `cliente.nombre` | `customer.name` |
| `cliente.telefono` | `customer.phone` |
| `cliente.email` | `customer.email` |
| `cliente.notas` | `customer.notes` |
| `tipo` | `type` |
| `totales.*` | `totals.*` (mismas claves que §4.2) |

### 4.4 `audit.log` (append-only, NAS)

| Antes | Después |
|---|---|
| `timestamp` | `timestamp` |
| `usuario` | `user` |
| `app_version` | `app_version` |
| `cambios[*].path` | `changes[*].path` |
| `cambios[*].kind` | `changes[*].kind` |
| `cambios[*].before` | `changes[*].before` |
| `cambios[*].after` | `changes[*].after` |

El reader dual-shape (`normalizeAuditEntry`) acepta `usuario`/`user` y `cambios`/`changes` indistintamente y devuelve la forma v3.

### 4.5 `settings.json` (per-PC, `%APPDATA%`)

| Antes | Después |
|---|---|
| `ruta_config` | `config_path` |
| `nombre_usuario` | `user_name` |

### 4.6 Canales IPC y métodos del preload

#### Canales

| Antes | Después |
|---|---|
| `settings:read`, `settings:write` | (igual) |
| `config:default-path` | (igual) |
| `config:exists` | (igual) |
| `config:create-default` | (igual) |
| `config:read`, `config:info`, `config:write`, `config:force-write` | (igual) |
| `dialog:select-config` | (igual) |
| `dialog:confirmar-conflicto` | `dialog:confirm-conflict` |
| `dialog:confirmar` | `dialog:confirm` |
| `dialog:info`, `dialog:error` | (igual) |
| `auth:verify-admin` | (igual) |
| `audit:list`, `audit:diff-preview` | (igual) |
| `logs:read-last` | (igual) |
| `quotes:*`, `pdf:export` | (igual) |

#### Métodos expuestos en `window.packprice.*`

| Antes | Después |
|---|---|
| `leerSettings` | `readSettings` |
| `guardarSettings` | `writeSettings` |
| `seleccionarConfig` | `selectConfigFile` |
| `rutaConfigPorDefecto` | `getDefaultConfigPath` |
| `existeConfig` | `configExists` |
| `crearConfigDefault` | `createDefaultConfig` |
| `leerConfig` | `readConfig` |
| `infoConfig` | `getConfigInfo` |
| `guardarConfig` | `writeConfig` |
| `guardarConfigForzado` | `forceWriteConfig` |
| `verificarAdmin` | `verifyAdminPassword` |
| `confirmarConflicto` | `confirmConflict` |
| `confirmar` | `confirm` |
| `mostrarInfo` | `showInfo` |
| `mostrarError` | `showError` |

#### Payloads IPC

`{ ruta, modificadoPor }` → `{ path, modifiedBy }`
`{ ruta, configNuevo, infoEsperada }` → `{ path, newConfig, expectedInfo }`
`{ titulo, mensaje, detalle, botones, defaultId }` → `{ title, message, detail, buttons, defaultId }`
`{ modificadoPor, fechaActualizacion }` → `{ modifiedBy, updatedAt }`

### 4.7 IDs HTML y selectores CSS

Migración aparte (Onda 11). Patrón:

| Antes | Después |
|---|---|
| `pantalla-bienvenida` | `screen-welcome` |
| `pantalla-app` | `screen-app` |
| `pantalla-error` | `screen-error` |
| `btn-bv-empezar`, `bv-nombre`, `bv-ruta`, `bv-error` | `btn-welcome-start`, `welcome-name`, `welcome-path`, `welcome-error` |
| `seccion-resultado`, `seccion-pack`, `seccion-cliente` | `section-result`, `section-pack`, `section-customer` |
| `modal-admin`, `modal-historial`, `modal-logs` | `modal-admin`, `modal-history`, `modal-logs` |
| `btn-calcular`, `btn-guardar-presupuesto`, `btn-exportar-pdf` | `btn-calculate`, `btn-save-quote`, `btn-export-pdf` |
| `tab-parametros`, `tab-modelos`, `tab-tramos`, `tab-packs`, `tab-auditoria` | `tab-parameters`, `tab-models`, `tab-tiers`, `tab-packs`, `tab-audit` |

Lista completa: extraerla con `grep -oE 'id="[^"]+"' renderer/index.html` al ejecutar Onda 11; este plan no la pre-enumera entera para evitar drift.

### 4.8 Identificadores de función y variables (resumen)

Ya cubiertos en el plan anterior (`extraerJsonDeConfig` → `extractJsonFromConfig`, `crearVentana` → `createMainWindow`, `fmtEur` → `formatEur`, `calcularPackPena` → `calculateCrewPack`, etc.). Se aplican junto con el rename de claves.

---

## 5. Ondas

Cada onda tiene scope acotado, glosario aplicado, criterio de aceptación y smoke test. PRs separados.

---

### Onda 1 · `lib/config-parser.js` + test

**Scope**: rename de identificadores internos (sin tocar el shape del config — se hace en Onda 2).

**Renombrados** (igual que el plan anterior):
- `extraerJsonDeConfig` → `extractJsonFromConfig`
- `validarFormaConfig` → `validateConfigShape`
- `stripAdminClave` → `stripAdminPassword`
- `reinyectarAdminClave` → `injectAdminPassword`
- `serializarConfig` → `serializeConfig`
- `SECCIONES_REQUERIDAS` → `REQUIRED_SECTIONS`
- Variables internas (`idxMarcador` → `markerIdx`, `bloqueJson` → `jsonBlock`, …).

**Importante**: `REQUIRED_SECTIONS` se actualiza en Onda 2 (cuando llegue v3) a `['parameters', 'roly_models', 'tiers', 'packs', 'admin']`. En esta onda se queda con los nombres v2.

**Mensajes de `throw`**: siguen en español.

**Tests** (`tests/config-parser.test.js`): traducir `describe`/`test` strings.

**Aceptación**: `npm test` verde. `npm run dev` arranca y carga config v2 existente.

---

### Onda 2 · Schema v3 + migración + `lib/migrations.js`

**Scope**: definir y publicar el formato v3 del config. **No rompe nada** porque la app sigue leyendo v2 y migrando perezosamente.

**Nuevos archivos**:

- `lib/migrations.js`:
  ```js
  exports.migrateConfig = function migrateConfig(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Config inválido');
    if (raw.version && /^3\./.test(raw.version)) return raw;        // ya es v3, idempotente
    return mapV2ToV3(raw);                                          // transformación pura
  };
  exports.migrateQuote    = function migrateQuote(raw)    { … };
  exports.migrateSettings = function migrateSettings(raw) { … };
  exports.normalizeAuditEntry = function normalizeAuditEntry(raw) { … };
  ```
- `tests/migrations.test.js`: fixture v2 completo → migrar → coincide byte-a-byte con fixture v3. Migrar dos veces → idempotente. Migrar v3 → no-op.

**Cambios en archivos existentes**:

- `config.default.js`:
  - `VERSION = '3.0.0'`
  - Todas las claves listadas en §4.1 en su forma v3.
  - **Renombre del archivo a inglés** sólo de las constantes locales (`PARAMETROS` → `PARAMETERS`, `MODELOS_ROLY` → `ROLY_MODELS`, `TRAMOS` → `TIERS`, `PACKS` → `PACKS`, `EMPRESA` → `COMPANY`, `PRESUPUESTO` → `QUOTE_SETTINGS`). El export `buildDefaultConfig` queda igual.

- `lib/config-schema.js`:
  - `validateConfigSchema` valida v3 (todas las claves listadas).
  - Mantiene un check inicial: si `version` empieza por `2.`, lanza un error que indica que debe pasar por `migrateConfig` primero. Esto previene leaks de v2 al validator.

- `lib/config-parser.js`:
  - `REQUIRED_SECTIONS` → `['parameters', 'roly_models', 'tiers', 'packs', 'admin']`.
  - `validateConfigShape` actualizado a las mismas claves.
  - `stripAdminPassword` / `injectAdminPassword`: clave interna pasa de `clave` a `password`, flag de `tiene_clave` a `has_password`.

- `tests/config-parser.test.js` y `tests/config-schema.test.js` y `tests/config-default.test.js`: actualizar fixtures a v3.

**Aceptación**:
- `npm test` verde con la nueva forma v3.
- `migrateConfig(v2-fixture)` produce el mismo output que `buildDefaultConfig()` cuando se aplica al config de defaults v2.
- `migrateConfig(migrateConfig(v2))` ≡ `migrateConfig(v2)` (idempotencia).
- App arranca **NO**: la app todavía no usa migrateConfig (se enchufa en Onda 3). En esta onda sólo verificamos que el módulo existe y los tests pasan.

---

### Onda 3 · `main.js` + wire de migración

**Scope**:
1. Renombrar helpers internos (igual que el plan anterior: `crearVentana` → `createMainWindow`, `leerConfigDesdeArchivo` → `readConfigFromFile`, etc.).
2. Renombrar variables locales (`ruta` → `filePath`, `contenido` → `content`, etc.).
3. **Enchufar la migración**: `config:read` ejecuta `migrateConfig` antes de devolver. Si el config era v2 y la migración mutó algo, se escribe al NAS atómicamente:
   ```js
   ipcMain.handle('config:read', (event, payload) => {
     const filePath = payload.path ?? payload.ruta;     // shim payload v2→v3 (Onda 4 lo elimina)
     const raw = readConfigFromFile(filePath);
     const migrated = migrateConfig(raw);
     if (raw !== migrated) {
       // Migración real: backup tagged + write atómica
       createBackup(filePath, { tag: 'pre-v3-migration' });
       fs.writeFileSync(filePath, serializeConfig(migrated), 'utf-8');
       logger.info('config migrated v2→v3', { filePath });
     }
     validateConfigSchema(migrated);
     return { ok: true, config: stripAdminPassword(migrated), info: getFileInfo(filePath) };
   });
   ```
4. `createBackup` acepta `{ tag }` opcional para sufijar el nombre del backup (`config-2026-05-11T10-30-00-pre-v3-migration.js`).
5. Migración de `settings.json` perezosa al llamar a `readSettingsFile`: si detecta `ruta_config`/`nombre_usuario`, transforma y reescribe.
6. Wire de `migrateQuote` y `normalizeAuditEntry` se aplaza a Ondas 7 y 8 (donde cada uno se ejerce).
7. Canales IPC legacy renombrados: `dialog:confirmar-conflicto` → `dialog:confirm-conflict`, `dialog:confirmar` → `dialog:confirm`. Mensajes de los diálogos siguen en español.
8. Payloads IPC: aceptar ambas claves (`payload.path ?? payload.ruta`, `payload.newConfig ?? payload.configNuevo`, etc.) hasta que Onda 4 + Onda 10 cierren el renderer.

**Aceptación**:
- Arrancar contra el `config.js` de producción (v2) → log `'config migrated v2→v3'`, backup creado con sufijo `pre-v3-migration`, NAS contiene v3.
- Vuelta a arrancar → no se migra, no se crea backup, app sigue funcionando.
- `audit.log` sigue funcionando (queda en v2 hasta Onda 8, gracias al normalizer en memoria que se añadirá entonces).
- Smoke: pack peña 12 ud 2 caras sin capucha → 311.40 €. Migración admin → guardar → conflicto → resolver.

---

### Onda 4 · `preload.js` + alias temporales

**Scope**: API expuesta en `window.packprice` se renombra (`leerSettings` → `readSettings`, …). Canales IPC legacy ya están renombrados en Onda 3.

**Alias temporales**: durante Ondas 4–10, `window.packprice` expone **ambos nombres** (los nuevos y los viejos como aliases) para que `renderer/app.js` migre por bloques sin romper.

```js
const api = {
  readSettings: () => ipcRenderer.invoke('settings:read'),
  writeSettings: (s) => ipcRenderer.invoke('settings:write', s),
  // …
};
contextBridge.exposeInMainWorld('packprice', {
  ...api,
  // legacy aliases — removed in Onda 12 cleanup
  leerSettings: api.readSettings,
  guardarSettings: api.writeSettings,
  // …
});
```

**Aceptación**: app funciona idéntica antes y después.

---

### Onda 5 · `renderer/format.js`

**Scope**: rename de helpers (`fmtEur` → `formatEur`, `fmtPct` → `formatPct`, `intDe` → `intFromInput`). Re-exportar nombres antiguos como alias hasta Onda 12.

**Aceptación**: app sigue funcionando.

---

### Onda 6 · `renderer/calculo.js` + `lib/pdf-template.js` + tests

**Scope**: el cambio más profundo del refactor. Las funciones de cálculo:

1. **Consumen** un config v3 (claves nuevas).
2. **Producen** un resultado con claves v3 (§4.2).
3. **Cambian de nombre** (`calcularPackPena` → `calculateCrewPack`, etc.).

**Cambios en `renderer/calculo.js`**:

```js
export function calculateCrewPack(cfg, opt) {
  const { quantity, hood, sides, qty_4xl, qty_5xl, extras } = opt;
  const pack = cfg.packs.crew_full;

  if (quantity < pack.min) {
    return { error: `Mínimo ${pack.min} packs para "${pack.name}".` };
  }

  const tier = getTier(cfg, quantity);
  const sidesKey = (sides === 2) ? 'two_sides' : 'one_side';
  const hoodKey  = (hood === 'with') ? 'with_hood' : 'without_hood';
  const unitPrice = pack.prices[hoodKey][sidesKey][tier.id];

  const totalGarments = quantity * 2;
  const hoodieModel = (hood === 'with') ? 'URBAN' : 'CLASICA';
  const tshirtCost  = calculateGarmentCost(cfg, 'BEAGLE',     sides, tier, totalGarments);
  const hoodieCost  = calculateGarmentCost(cfg, hoodieModel,  sides, tier, totalGarments);
  const buffer3xl   = cfg.parameters.buffer_3xl_eur_pack;
  const packCost    = tshirtCost.total + hoodieCost.total + buffer3xl;

  return calculateTotals(cfg, {
    pack: pack.name, tier: tier.label, quantity,
    unit_price: unitPrice, unit_cost: packCost,
    qty_4xl, qty_5xl, extras,
    extra_detail: { hood: hoodKey, sides }
  });
}
```

(Análogo para `calculateSinglePack`, `calculateMixedPack`, `calculateCustomPack`, `calculateTotals`, `calculateExtras`, `getTier`, `calculateGarmentCost`.)

**Cambios en `lib/pdf-template.js`**:
- Lee `quote.total_vat_inc` en vez de `quote.total_iva_inc`, `quote.unit_price`, `quote.breakdown[*].name`, etc.
- El **texto visible** del PDF sigue en español: encabezados, "Subtotal", "IVA 21%", "Total IVA incl.", "Condiciones del presupuesto", etc.

**Cambios en `tests/calculo.test.js`** y **`tests/pdf-template.test.js`**:
- Imports a `calculateCrewPack`, etc.
- Expects con `total_vat_inc`, `unit_price`, `tier`, `quantity` — claves v3.
- Fixtures de quote en v3.
- `describe`/`test` strings en inglés.

**Aceptación**:
- `npm test` verde.
- Smoke: pack peña 12 ud → 311.40 € en `total_vat_inc`. Pack mixto 7 URBAN + 5 CLASICA T1 → 193.40 € (pero la UI aún muestra Spanish — calcula está OK; el render se acomoda en Onda 10).
- **OJO**: en este momento la UI (`renderer/app.js`, no migrada) sigue leyendo `r.total_iva_inc`. Hace falta un puente temporal en `app.js`:
  ```js
  // Bridge antiguo→nuevo, eliminado en Onda 10
  function bridgeResultV2(r) {
    if (!r || r.error) return r;
    return {
      ...r,
      total_iva_inc: r.total_vat_inc,
      pvp_unitario: r.unit_price,
      coste_total:  r.total_cost,
      margen_pct:   r.margin_pct,
      // … (alias minimal hasta Onda 10)
    };
  }
  ```
  Este bridge vive en `renderer/app.js` durante 1 PR (Onda 6 → Onda 10). En Onda 10 desaparece.

---

### Onda 7 · `lib/history.js` + `renderer/history.js` + migración de `presupuestos.json`

**Scope**:
1. `lib/history.js` invoca `migrateQuote` al leer entradas; reescribe el archivo si hubo migración.
2. `renderer/history.js` consume quotes v3.
3. Tests de migración de historial.

**Backup**: `presupuestos.json.bak-pre-v3` al lado, generado la primera vez que un PC migra.

**Aceptación**:
- Un PC con historial v2 abre la app: log `'history migrated v2→v3'`, `.bak-pre-v3` creado, listar/buscar/exportar PDF funcionan con todos los presupuestos.
- Idempotencia: cerrar y abrir de nuevo no re-migra.

---

### Onda 8 · `lib/audit.js` + `renderer/admin-extras.js`

**Scope**:
1. `lib/audit.js` añade `normalizeAuditEntry` al lectura: cualquier entrada con `usuario`/`cambios` se devuelve con `user`/`changes`.
2. Las escrituras nuevas (`appendAuditEntry`) usan v3 (`user`, `changes`).
3. `renderer/admin-extras.js` renderiza con campos v3.

**Justificación de no migrar el archivo**:
- `audit.log` es append-only (un JSON por línea). Reescribirlo entero anularía el principio de no-tamper.
- El reader dual-shape es trivial: 6 líneas.
- Con el tiempo, las entradas v2 quedan atrás; el archivo es naturalmente bi-modal y eso es aceptable.

**Aceptación**:
- Audit log con entradas v2 antiguas + v3 nuevas se renderiza coherente.
- Tests dual-shape: input con `usuario` → output con `user`.

---

### Onda 9 · `renderer/admin.js`

**Scope**:
1. Rename de identificadores y funciones (igual que el plan anterior).
2. **Actualizar todos los `data-cfg-path`** a las claves v3: `parametros.iva` → `parameters.vat`, `packs.pena_completa.pvp.con_capucha.dos_caras.T1` → `packs.crew_full.prices.with_hood.two_sides.T1`, etc.
3. Constantes `PARAMETROS_GRUPOS` → `PARAMETER_GROUPS`; las `key` dentro apuntan a las claves v3.

**Strings visibles** (labels, hints, títulos de grupo) siguen en español.

**Aceptación**: editor admin abre, edita, guarda contra config v3.

---

### Onda 10 · `renderer/app.js` (3 sub-PRs)

**Scope**: rename de identificadores + reemplazar el bridge temporal de Onda 6 + consumir claves v3 directamente.

**Sub-PR 10a** (bootstrap + welcome + carga de config): ~líneas 1–500. Renombrar funciones, variables, llamadas a `window.packprice.*` (a los nombres v3 expuestos en Onda 4).

**Sub-PR 10b** (pack selection + cálculo + render de resultado): ~líneas 500–1200. Eliminar `bridgeResultV2`; la UI consume `total_vat_inc`, `unit_price`, `total_cost`, `margin_pct` directamente.

**Sub-PR 10c** (admin orchestration + historial + PDF + atajos + misc): ~líneas 1200–1964.

**IDs HTML**: en esta onda se **MANTIENEN los IDs v2** porque renombrar el HTML está en Onda 11. `app.js` aún hace `document.getElementById('pantalla-bienvenida')`.

**Aceptación** (al cerrar las tres sub-ondas):
- Smoke completo de CLAUDE.md §12.
- Eliminar alias de `window.packprice` (Onda 4) y de `format.js` (Onda 5).
- Eliminar bridge `bridgeResultV2` (Onda 6).

---

### Onda 11 · HTML IDs + CSS

**Scope**: renombrar IDs y clases acopladas a IDs en:
- `renderer/index.html`
- `renderer/styles.css`
- `renderer/app.js` (todos los `getElementById('pantalla-bienvenida')` etc.)

**Estrategia**: hacerlo de golpe en un único PR porque los tres archivos están acoplados. Procedimiento:

1. Extraer lista exhaustiva: `grep -oE 'id="[^"]+"' renderer/index.html | sort -u`.
2. Definir tabla de rename siguiendo el patrón de §4.7. Documentarla en este plan **al ejecutar la onda** (snapshot del momento).
3. Sed multi-archivo con la tabla, revisar diff.
4. Smoke completo.

**Clases CSS** (`.pack-option`, `.admin-tab`, etc.): la mayoría ya están en EN. Las que estén en ES (`.boton-volver`?, `.tarjeta-pack`?) se renombran junto con sus selectores.

**Aceptación**: smoke completo + visual review (la UI no debe haber cambiado un píxel).

---

### Onda 12 · Limpieza final

**Scope**:
1. Eliminar alias de `preload.js` (Onda 4).
2. Eliminar alias de `format.js` (Onda 5).
3. Eliminar shims de payload IPC en `main.js` (`payload.ruta ?? payload.path` → solo `payload.path`).
4. Actualizar `CLAUDE.md`:
   - §1: el `config.js` ahora es v3 (claves en inglés con valores visibles en español).
   - §3: ningún archivo marcado "legacy ES".
   - §6.1: actualizar el esquema esperado a v3.
   - §6.3: documentar v2→v3 como ejemplo concreto del flow de migración.
5. Actualizar `PLAN_Calculadora.md` con el nuevo nombrado (manteniendo conceptos del negocio en español; las claves del config en su nueva forma v3).
6. Actualizar `README-build.md` con la sección "Rollback de la migración v3".
7. `npm audit`.
8. Bumpear `package.json:version` a `3.0.0-beta` (el sufijo `-beta` se queda según memoria del proyecto).
9. Smoke completo.

**Aceptación**:
- `git grep -n -E "leer|guardar|seleccionar|validar|crear|obtener|escribible|cantidad|tramo|caras|parametros|modelos_roly|tramos|pena_completa|con_capucha|dos_caras|pvp|coste|margen|total_iva_inc|ruta_config|nombre_usuario|modificado_por|fecha_actualizacion|recargo|merma|envio|planchado|minutos|indirectos" -- '*.js' '*.html' '*.css' ':!node_modules' ':!planes' ':!devlog' ':!*.md' ':!CONFIG TEST'`
  no devuelve resultados **excepto** dentro de:
  - `lib/migrations.js` (donde están las tablas de rename v2→v3).
  - Tests de migración (donde están los fixtures v2 de prueba).
  - Strings de UI (`'Cantidad'`, `'Caras'`, etc. en `index.html` y en mensajes de error).

---

## 6. Política de migraciones de datos

### 6.1 Reglas universales

1. **Idempotencia**: ejecutar la migración dos veces produce el mismo output. Detección por `version` (config), por presencia de claves v3 (quotes, settings), o por shape (audit entry).
2. **Backup antes de escribir**: con sufijo `pre-v3-migration` para distinguir de los backups normales.
3. **Atomicidad**: backup → write. Si el write falla, el archivo original sigue en disco (Windows mantiene el archivo abierto hasta cerrar el handle).
4. **Logging**: cada migración real escribe en `electron-log` con campos `{ filePath, fromVersion, toVersion, recordCount? }`.
5. **Migración perezosa**: corre la primera vez que un PC abre el archivo en formato antiguo. No requiere acción humana.
6. **Rollback documentado**: pasos exactos en `README-build.md` (sección añadida en Onda 12).

### 6.2 Tests de migración (mínimos)

- `migrateConfig(v2-completo) === v3-esperado` (fixture canónico).
- `migrateConfig(v3) === v3` (no-op).
- `migrateConfig(migrateConfig(v2)) === migrateConfig(v2)` (idempotencia).
- `migrateConfig({ version: '2.0.0' })` con campos faltantes → lanza error claro **antes** de migrar.
- `migrateQuote` idem con un quote canónico.
- `normalizeAuditEntry({ usuario: 'X', cambios: [] })` → `{ user: 'X', changes: [] }`.
- `migrateSettings({ ruta_config, nombre_usuario })` → `{ config_path, user_name }`.

### 6.3 Rollback

- **Antes de Onda 12 (incluida)**: instalar el `.exe` anterior. El renderer escribe v2 → al primer guardado el config queda en v2. Si no se ha guardado, el config en NAS ya es v3 y el `.exe` antiguo no lo entenderá: restaurar el backup `config-…-pre-v3-migration.js`.
- **Después de Onda 12**: no hay vuelta atrás sin restaurar backups manualmente. La operación se considera estable tras 30 días sin incidentes en producción.

---

## 7. Política de strings visibles

Identifica qué es "visible al usuario" y por tanto debe seguir en español:

- Cualquier string pasado a `dialog.showMessageBox` (`title`, `message`, `detail`, `buttons`).
- Cualquier string pasado a `window.packprice.showError`, `showInfo`, `confirm`, etc.
- Cualquier string renderizado en el DOM (innerHTML/textContent) — labels, botones, hints, títulos de sección, mensajes de error.
- Cualquier string en el PDF (`lib/pdf-template.js`): "Subtotal", "Total IVA incluido", "Condiciones del presupuesto", "Validez", "Cliente", "Pack", "Tramo", "Cantidad", etc.
- Valores del config que se renderizan (`tier.label`, `roly_models.<id>.name`, `pack.name`, `quote_settings.terms`).
- Cabecera comentada del `config.js` (la lee un humano si abre el archivo a mano).

Lo demás (claves estructurales, identificadores, logs estructurados, mensajes en `throw` que **siempre** se ven envueltos en un diálogo en español, comentarios JSDoc) va en inglés.

**Hueco gris — mensajes de `throw`**: hoy están en español porque se propagan a la UI como `{ ok:false, error: e.message }` y se muestran tal cual. Mantenemos en español. Si en el futuro se separa "error técnico para log" de "mensaje para UI", se podrá pasar la parte técnica a inglés.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Migración irreversible del config en producción con bug | Backup `pre-v3-migration` automático + procedimiento de rollback documentado en `README-build.md` |
| Bug en `migrateConfig` pierde campos | Test `migrateConfig(v2-completo) === v3-esperado` byte-a-byte cubre todos los campos del fixture |
| PR demasiado grande (Onda 10a/b/c) | Dividir explícitamente por bloques de líneas; cada sub-PR auto-contenido |
| Renombrar accidentalmente una clave en mitad de una rama | Antes de mergear cada onda, ejecutar `git grep` del checklist §5 contra las claves objetivo de esa onda |
| HTML / CSS / JS desincronizado tras Onda 11 | Toda Onda 11 en un único PR; smoke visual + funcional obligatorio |
| `audit.log` antiguo ilegible | Reader dual-shape probado con fixture |
| Conflicto entre PRs paralelos durante Ondas 9–10 | Mergear Ondas en serie; no paralelizar 9 y 10 |
| Usuarios con versiones distintas del .exe leen/escriben el mismo `config.js` del NAS | El primer PC en actualizar migra a v3. Los PCs viejos verán un config v3 que no entienden y mostrarán error claro. **Mitigación**: distribuir el `.exe` v3 a todos los PCs antes de que cualquiera abra el admin tras el upgrade. Documentado en release notes. |

---

## 9. Orden de ejecución sugerido

```
PR 1: Onda 1 + Onda 2     (config-parser.js refactor + schema v3 + migrations module + tests)
PR 2: Onda 3              (main.js + wire de migrateConfig)
PR 3: Onda 4              (preload.js + alias)
PR 4: Onda 5              (format.js)
PR 5: Onda 6              (calculo.js + pdf-template.js + tests + bridgeResultV2 temporal)
PR 6: Onda 7              (history.js + migración de presupuestos.json)
PR 7: Onda 8              (audit.js dual-shape)
PR 8: Onda 9              (admin.js)
PR 9-11: Onda 10a/b/c     (app.js dividido)
PR 12: Onda 11            (HTML IDs + CSS)
PR 13: Onda 12            (limpieza + docs + version bump)
```

Total: 13 PRs. Cada uno reviewable en <1h. Estimado: 8–10 jornadas en serie, 4–5 con paralelización limitada.

**Hito antes de mergear Onda 3 a `main`**: confirmar que el .exe de v3 está listo para distribuir a todos los PCs **antes** de que se ejecute la migración en el NAS. Si se mergea a `main` y sale un build .exe sin que los PCs estén actualizados, un PC con .exe v2 abriendo el config migrado v3 mostrará error.

---

## 10. Criterios de finalización global

- `npm test` verde.
- Smoke manual completo (CLAUDE.md §12) verde.
- Migración v2→v3 ejercitada contra el `config.js` real de producción, en un entorno de test con copia del NAS — verificado que el resultado es idéntico al `buildDefaultConfig()` re-tipado a v3.
- Versión bumpeada a `3.0.0-beta` (mantener sufijo según memoria del proyecto).
- CLAUDE.md, PLAN_Calculadora.md y README-build.md actualizados.
- `lib/migrations.js` cubierto al 100% por tests.

---

## 11. Deuda residual (post-Onda 12)

- **Strings de UI a inglés**: no aplica — son visibles al cliente.
- **Logs internos a inglés**: ya en inglés.
- **Migración v3→v4 en el futuro**: precedente establecido. `migrateConfig` puede encadenar `if (v < 3) v = mapV2ToV3(v); if (v < 4) v = mapV3ToV4(v);`.

---

## Estado

- [ ] Onda 1 — `lib/config-parser.js` rename interno
- [ ] Onda 2 — Schema v3 + `lib/migrations.js` + tests
- [ ] Onda 3 — `main.js` + wire de `migrateConfig` + canales IPC legacy
- [ ] Onda 4 — `preload.js` + alias temporales
- [ ] Onda 5 — `renderer/format.js`
- [ ] Onda 6 — `renderer/calculo.js` + `lib/pdf-template.js` + bridgeResultV2 temporal
- [ ] Onda 7 — `lib/history.js` migración perezosa de `presupuestos.json`
- [ ] Onda 8 — `lib/audit.js` dual-shape reader
- [ ] Onda 9 — `renderer/admin.js` + `data-cfg-path` v3
- [ ] Onda 10a — `renderer/app.js` (bootstrap + welcome + carga)
- [ ] Onda 10b — `renderer/app.js` (cálculo + render de resultado)
- [ ] Onda 10c — `renderer/app.js` (admin + historial + PDF + misc)
- [ ] Onda 11 — HTML IDs + selectores CSS
- [ ] Onda 12 — Limpieza de alias + docs + version bump
