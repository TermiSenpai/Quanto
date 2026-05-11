# Plan · Migración del código a inglés

Aplica la regla de CLAUDE.md §2: **identificadores en inglés, strings de UI y claves del config en español**. Migración por ondas: cada onda es reviewable por separado y deja la app en estado verde (arranca, calcula, guarda admin sin perder backward-compat con `config.js` del NAS).

> **Documento operativo, no aspiracional.** Si una onda se aplaza, déjalo anotado al final ("Estado").

---

## 1. Objetivo

Pasar progresivamente los archivos legacy (`main.js`, `preload.js`, `renderer/app.js`, `renderer/calculo.js`, `renderer/admin.js`, `renderer/format.js`, `lib/config-parser.js` y sus tests) a **identificadores en inglés**, sin tocar:

- **Claves del esquema del `config.js`** (`parametros`, `modelos_roly`, `tramos`, `packs`, `pena_completa`, `con_capucha`, `dos_caras`, `cant_4xl`, `cant_5xl`, etc.) — viven en disco en el NAS y los conoce el cliente. Renombrarlas obliga a migrar todos los `config.js` existentes y a mantener fallback de lectura para versiones antiguas. Coste/beneficio no compensa.
- **Claves del resultado del cálculo** (`total_iva_inc`, `pvp_unitario`, `base_venta`, `margen_pct`, `desglose`, …) — se serializan a `presupuestos.json` (historial local) y a PDFs. Cualquier cambio rompe el historial existente y los PDFs ya emitidos. **OUT OF SCOPE.** Se documentará la deuda al final.
- **Strings visibles al usuario** (mensajes, botones, errores, títulos de diálogo) — siguen en español.
- **IDs del HTML** (`pantalla-bienvenida`, `btn-bv-empezar`, `pack-options`, …) — son superficie de contrato con CSS y JS. Renombrarlos implica tocar `index.html`, `styles.css` y todos los `document.getElementById` simultáneamente. Se hace en una onda dedicada (Onda 7), no atómica con la migración de identificadores.

## 2. Qué SÍ se migra

| Capa | Ejemplo de antes → después |
|---|---|
| Nombres de función locales | `crearVentana` → `createMainWindow`, `leerConfigDesdeArchivo` → `readConfigFromFile` |
| Variables locales | `ruta`, `rutaArchivo`, `contenido`, `cfg` → `path`, `filePath`, `content`, `cfg` (ya está en EN) |
| Parámetros de función | `(cfg, modeloId, caras, tramo)` → `(cfg, modelId, sides, tier)` *si no se serializa* |
| Métodos de `preload.js` | `leerSettings`, `guardarConfig`, `verificarAdmin` → `readSettings`, `writeConfig`, `verifyAdminPassword` |
| Canales IPC legacy | `dialog:confirmar-conflicto`, `dialog:confirmar`, `dialog:info`, `dialog:error` → `dialog:confirm-conflict`, `dialog:confirm`, `dialog:info`, `dialog:error` |
| Exports de módulos legacy | `extraerJsonDeConfig` → `extractJsonFromConfig`, `validarFormaConfig` → `validateConfigShape`, `serializarConfig` → `serializeConfig` |
| Mensajes de log estructurados (campos JSON) | `{ ruta, usuario }` → `{ path, user }` *en logs internos; cuidado con audit.log que ya vive en NAS* |
| Comentarios y JSDoc | Traducir al inglés conservando precisión técnica |

## 3. Qué NO se migra

| Cosa | Por qué |
|---|---|
| Claves del config (`parametros`, `tramos`, `pena_completa`, `con_capucha`, …) | Persistidas en NAS, propiedad del cliente |
| Resultado del cálculo (`total_iva_inc`, `pvp_unitario`, `coste_total`, `margen_pct`, `desglose`) | Persistidas en `presupuestos.json` y PDFs emitidos |
| Strings en `dialog.show*`, `alert`, botones, labels HTML | Usuarios hispanohablantes |
| Comentarios de cabecera del `config.js` generado (`serializeConfig` los emite) | Lo lee un humano del negocio si abre el archivo |
| IDs HTML y selectores CSS | Onda 7 dedicada (opt-in) |
| Campos del `audit.log` (`usuario`, `cambios`, `app_version`) | Append-only, en NAS, lo leen humanos. Mantener formato actual. |
| Campos persistidos en `presupuestos.json` (`cliente`, `fecha`, `usuario`, `pack`, `tipo`) | Historial local |
| Campos en `settings.json` (`ruta_config`, `nombre_usuario`) | Persistido en `%APPDATA%` por instalación; migrable, pero no en esta refactor |

## 4. Inventario y volumen

| Archivo | Líneas | Estado actual | Onda |
|---|---:|---|---:|
| `lib/config-parser.js` | 194 | ES, CommonJS, sin frontera de disco | 1 |
| `preload.js` | 63 | ES, expone `window.packprice.*` | 2 |
| `main.js` | 767 | Mixto: IPC channels ya en EN para nuevos, ES para legacy; helpers ES | 3 |
| `renderer/format.js` | 38 | ES, ES modules | 4 |
| `renderer/calculo.js` | 303 | ES, ES modules, hay tests | 5 |
| `renderer/admin.js` | 494 | ES, ES modules | 6 |
| `renderer/app.js` | 1964 | ES, depende de todo lo anterior + IDs HTML | 7 |
| `tests/calculo.test.js` | 242 | ES, importa de `renderer/calculo.js` | 5 (junto con 5) |
| `tests/config-parser.test.js` | 196 | ES, importa de `lib/config-parser.js` | 1 (junto con 1) |
| `tests/config-default.test.js` | 76 | ES | 8 |

Total a tocar: ~4 000 líneas. **Estimado**: 4–5 jornadas si se hace en serie, 2–3 si se paraleliza por ondas.

## 5. Glosario canónico

Para evitar inconsistencias entre archivos. Cualquier renombrado se hace usando estas correspondencias **exactas** y se añade al glosario si aparece algo nuevo.

### 5.1 Dominio

| Español | Inglés | Notas |
|---|---|---|
| `cantidad` | `quantity` | Solo si NO es clave del config |
| `caras` (1 ó 2) | `sides` | Solo en variables locales |
| `tramo` | `tier` | Solo en variables. La clave del config sigue siendo `tramos` |
| `precio` | `price` | |
| `coste` | `cost` | |
| `pvp` | `price` o `retailPrice` | Solo si NO es clave |
| `margen` | `margin` | |
| `recargo` | `surcharge` | |
| `merma` | `waste` | |
| `desglose` | `breakdown` | Solo en variables |
| `prenda` | `garment` | |
| `pack` | `pack` | Igual |
| `peña` | `crew` | "Pack peña" → "crew pack". Pero la clave `pena_completa` se queda. |
| `con_capucha` / `sin_capucha` | `withHood` / `withoutHood` | Solo en variables locales |

### 5.2 Infra/UI

| Español | Inglés |
|---|---|
| `ruta` | `path` (cuidado con sombrear el módulo `path` de Node — usar `filePath` cuando sea de archivo) |
| `archivo` | `file` |
| `contenido` | `content` |
| `bloqueado` | `locked` |
| `ventana` | `window` |
| `botón` / `botones` | `button` / `buttons` |
| `confirmar` | `confirm` |
| `título`, `mensaje`, `detalle` | `title`, `message`, `detail` |
| `cancelado` | `canceled` |
| `bienvenida` | `welcome` |
| `pantalla` | `screen` |
| `clave` (admin) | `password` |
| `modificado_por` | `modifiedBy` *en variables locales; la clave del config sigue siendo `modificado_por`* |

### 5.3 Sufijos a evitar

- ❌ `obtenerInfoArchivo` → ✅ `getFileInfo` (no `obtainFileInfo`)
- ❌ `leerSettings` → ✅ `readSettings`
- ❌ `escribir` → ✅ `write`
- ❌ `crear` → ✅ `create`

---

## 6. Ondas

Cada onda:
1. Tiene un **scope acotado**.
2. Empieza con el **glosario aplicado** (sección 5).
3. Termina con un **smoke test manual** (los descritos en CLAUDE.md §12 último bullet).
4. Tiene **commits separados por archivo** dentro del PR (más fácil de revisar y rebasable).
5. Si rompe API hacia fuera, mantiene **shim de compat** durante al menos una versión (notas concretas más abajo).

---

### Onda 1 · `lib/config-parser.js` + su test

**Por qué primero**: módulo aislado, sin frontera con UI ni IPC. Sirve de calibrado del glosario.

**Renombrados**:
- Funciones exportadas:
  - `extraerJsonDeConfig` → `extractJsonFromConfig`
  - `validarFormaConfig` → `validateConfigShape`
  - `stripAdminClave` → `stripAdminPassword`
  - `reinyectarAdminClave` → `injectAdminPassword`
  - `serializarConfig` → `serializeConfig`
  - `SECCIONES_REQUERIDAS` → `REQUIRED_SECTIONS`
- Variables internas: `idxMarcador` → `markerIdx`, `idxBrace` → `braceIdx`, `depth` (igual), `enString` → `inString`, `escapado` → `escaped`, `bloqueJson` → `jsonBlock`, `claveActual` → `currentPassword`, `claveDelRenderer` → `passwordFromRenderer`, `claveFinal` → `finalPassword`.
- Comentarios JSDoc → inglés (mantener el detalle de seguridad sobre `vm`).
- **Mensajes de `throw new Error('…')` siguen en español** — son visibles al usuario cuando el config corrupto se muestra en el modal de error.

**Mantener compat**:
- Re-exportar los nombres antiguos durante esta onda **sólo si algún módulo no migrado los importa todavía**. Como `main.js` es el único consumidor y se migra en Onda 3, conviene migrar Onda 1 + Onda 3 en el mismo PR. Si se separan, añadir:
  ```js
  module.exports = { extractJsonFromConfig, /* … */
    // legacy aliases — remove after Onda 3
    extraerJsonDeConfig: extractJsonFromConfig,
    validarFormaConfig: validateConfigShape,
    stripAdminClave: stripAdminPassword,
    reinyectarAdminClave: injectAdminPassword,
    serializarConfig: serializeConfig
  };
  ```

**Tests** (`tests/config-parser.test.js`):
- Renombrar imports a los nuevos nombres.
- Traducir `describe` y `test` strings al inglés (estos sí los puede ver el dev; no son UI).
- Mantener los inputs en español (siguen siendo configs de prueba con claves en ES).

**Aceptación**:
- `npm test` verde.
- `npm run dev` arranca y crea/carga el config sin errores.

---

### Onda 2 · `preload.js` + canales IPC legacy

**Por qué pronto**: es la API expuesta a `window.packprice`. Migrar antes que `renderer/app.js` permite que cada archivo del renderer migre llamando ya a los nombres nuevos.

**Renombrados en `preload.js`** (todos los métodos expuestos):

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

**Canales IPC legacy a renombrar** (ambos lados, `main.js` y la cadena de invocación en `preload.js`):

| Antes | Después |
|---|---|
| `dialog:confirmar-conflicto` | `dialog:confirm-conflict` |
| `dialog:confirmar` | `dialog:confirm` |
| `dialog:info` | (ya en EN, sin cambio) |
| `dialog:error` | (ya en EN, sin cambio) |

**Mantener compat (puente temporal)**:
Durante esta onda, exponer ambos nombres en `window.packprice` (alias `leerSettings = readSettings`, etc.). Sin esto, `renderer/app.js` (Onda 7) deja de funcionar entre PRs. Eliminar los alias al final de la Onda 7.

```js
// Compat: alias eliminados tras Onda 7.
const api = {
  readSettings: () => ipcRenderer.invoke('settings:read'),
  // …
};
contextBridge.exposeInMainWorld('packprice', {
  ...api,
  // legacy aliases
  leerSettings: api.readSettings,
  guardarSettings: api.writeSettings,
  // … resto de la tabla
});
```

**Aceptación**:
- Renderer (sin tocar) sigue funcionando porque usa los alias.
- Console del renderer sin `TypeError: window.packprice.X is not a function`.

---

### Onda 3 · `main.js`

**Renombrados de funciones internas**:

| Antes | Después |
|---|---|
| `leerConfigDesdeArchivo` | `readConfigFromFile` |
| `obtenerInfoArchivo` | `getFileInfo` |
| `crearBackup` | `createBackup` |
| `rutaEscribible` | `isPathWritable` |
| `sugerirRutaCandidata` | `suggestCandidatePath` |
| `crearConfigPorDefecto` | `createDefaultConfigFile` |
| `leerSettings` | `readSettingsFile` (evitar colisión con método del preload) |
| `guardarSettings` | `writeSettingsFile` |
| `crearVentana` | `createMainWindow` |
| `fusionarConClaveActual` | `mergeWithCurrentPassword` |

**Renombrados de constantes**:

| Antes | Después |
|---|---|
| `SETTINGS_DIR`, `SETTINGS_PATH`, `LOG_DIR` | (ya en EN, sin cambio) |
| `RUTAS_CONFIG_CANDIDATAS` | `CANDIDATE_CONFIG_PATHS` |

**Variables locales**:
- `ruta` → `filePath`
- `contenido` → `content`
- `infoEsperada` → `expectedInfo`
- `infoActual` → `currentInfo`
- `cambio` → `changed`
- `configPrevio` → `previousConfig`
- `configNuevo` → `newConfig` (en handlers IPC, ojo: si el renderer envía con esta clave, hay que ver Onda 7)
- `configCompleto` → `completeConfig`
- `configDelRenderer` → `configFromRenderer`
- `claveActual` → `currentPassword`
- `cfgDisco` → `diskConfig`

**IPC handlers · payloads del renderer**:
Los handlers reciben objetos cuyas claves vienen del renderer:
```js
ipcMain.handle('config:create-default', (event, { ruta, modificadoPor }) => …)
ipcMain.handle('config:write',          (event, { ruta, configNuevo, infoEsperada }) => …)
```

**Decisión**: las claves de payload IPC se renombran a inglés (`{ path, modifiedBy }`, `{ path, newConfig, expectedInfo }`). En la Onda 3 se acepta **ambas formas** vía destructuring con alias, durante un PR:
```js
ipcMain.handle('config:write', (event, payload) => {
  const filePath    = payload.path        ?? payload.ruta;
  const newConfig   = payload.newConfig   ?? payload.configNuevo;
  const expectedInfo = payload.expectedInfo ?? payload.infoEsperada;
  …
});
```
Cuando se cierre Onda 7, eliminar la rama legacy.

**Diálogos legacy renombrados** (`dialog:confirmar-conflicto`, `dialog:confirmar`):
- Cambiar el handler a `dialog:confirm-conflict` / `dialog:confirm`.
- Si Onda 2 ya existe, los alias del preload los hacen invisibles al renderer.

**Mensajes en `dialog.showMessageBox`** (los botones, títulos, mensajes) siguen en **español**.

**Mensajes de log estructurados**: los campos JSON del logger se traducen a inglés (`{ ruta, usuario, error }` → `{ path, user, error }`). Esto afecta a lo que se ve en `%APPDATA%\packprice\logs\` — es propio de la app, no del cliente. **Excepción**: `audit:append` mete entradas en `audit.log` del NAS (gestionado por `lib/audit.js`, que ya está en EN); su forma de payload (`{ usuario, app_version, cambios }`) **no se toca** en esta onda — vive en NAS, lo leen humanos.

**Aceptación**:
- App arranca, abre admin, guarda, dispara conflicto y todas las rutas IPC funcionan.
- `audit.log` y `presupuestos.json` mantienen formato byte-exacto.

---

### Onda 4 · `renderer/format.js`

Pequeño y aislado. Probable refactor en un único commit.

**Renombrados**:
| Antes | Después |
|---|---|
| `el(id)` | (mantener — es helper idiomatico equivalente a `$`; o renombrar a `byId`) |
| `show(id)` / `hide(id)` | (igual) |
| `intDe(id)` | `intFromInput(id)` |
| `fmtEur(n)` | `formatEur(n)` |
| `fmtPct(n)` | `formatPct(n)` |
| `deepClone` | (igual) |

**Compat**: re-exportar los nombres viejos como alias durante la Onda 4 únicamente; eliminarlos al cerrar Onda 7.

```js
export const fmtEur = formatEur;  // legacy alias, remove after Onda 7
export const fmtPct = formatPct;
export const intDe  = intFromInput;
```

**Aceptación**: app sigue funcionando con los alias; tests no aplican (es DOM-only).

---

### Onda 5 · `renderer/calculo.js` + `tests/calculo.test.js`

**Más crítico que parece**: las funciones devuelven objetos con claves que SE PERSISTEN (`total_iva_inc`, `pvp_unitario`, `coste_total`, `desglose`, `extras_detalle`, …). Esas claves **no se renombran** (regla de §3).

**Renombrados permitidos** (variables internas y parámetros):

| Antes | Después |
|---|---|
| `calcularExtras` | `calculateExtras` |
| `getTramo` | `getTier` |
| `calcularCostePrenda` | `calculateGarmentCost` |
| `calcularPackPena` | `calculateCrewPack` |
| `calcularPackIndividual` | `calculateSinglePack` |
| `calcularPackMixto` | `calculateMixedPack` |
| `calcularPackPersonalizado` | `calculateCustomPack` |
| `calcularTotales` | `calculateTotals` |

**Variables locales**:
- `cantidad` → `quantity` (en parámetros, NO al construir el objeto resultado).
- `caras` → `sides`
- `tramo` → `tier`
- `cant_4xl`, `cant_5xl` → MANTENER, son claves del resultado.
- `extras` → (igual)
- `pvpUnit` → `unitPrice`
- `carasKey`, `capuchaKey` → `sidesKey`, `hoodKey` (los valores siguen siendo `'dos_caras'`, `'con_capucha'`, porque indexan dentro del config).

**Construcción del objeto resultado**: las claves son **immutables**:
```js
return {
  pack: …, tramo: …, cantidad: …, pvp_unitario: …,
  cant_4xl: …, cant_5xl: …, subtotal: …, recargos: …,
  extras_sin_iva: …, extras_detalle: …,
  total_iva_inc: …, base_venta: …, iva: …,
  coste_unitario: …, coste_total: …,
  margen: …, margen_pct: …,
  extra: …
};
```

**Tests** (`tests/calculo.test.js`):
- Renombrar imports.
- Traducir `describe`/`test` al inglés.
- **No tocar los expects**: comprueban claves del resultado que no cambian.
- Reusar el fixture `buildDefaultConfig()` tal cual.

**Aceptación**:
- `npm test` verde.
- Smoke: pack peña 12 ud sin capucha 2 caras → 311.40 €. Pack mixto 7 URBAN + 5 CLASICA T1 → 193.40 €.

---

### Onda 6 · `renderer/admin.js`

Renderiza el editor admin. La superficie pública es:
- `renderAdminTabContent(cfg, tab)` — ya en EN
- `actualizarConfigDesdeInput` → `updateConfigFromInput`
- `ejecutarAccionAdmin` → `runAdminAction`
- `colorTokenPack` — ya en EN

**Renombrados**:
- Constantes: `PARAMETROS_GRUPOS` → `PARAMETER_GROUPS` (el array; las claves dentro (`titulo`, `highlight`, `items`) son internas del módulo; convertir a `title`, `highlight`, `items`).
- Funciones internas: `renderAdminParametros` → `renderAdminParameters`, `renderAdminModelos` → `renderAdminModels`, `renderAdminTramos` → `renderAdminTiers`, `renderAdminPacks` → `renderAdminPacks` (igual), `esc` → (mantener).
- Variables locales: `grupo` → `group`, `valor` → `value`, `valorAttr` → `valueAttr`, etc.

**Atributos `data-cfg-path`**: los strings que indexan dentro del config (`parametros.iva`, `packs.pena_completa.pvp.…`) NO se tocan — apuntan a claves reales del config.

**Strings visibles** (labels, hints, títulos de grupo) — siguen en español.

**Aceptación**:
- Modo admin se abre, se navega entre tabs, se edita un parámetro y se guarda con éxito.

---

### Onda 7 · `renderer/app.js`

**El más grande** (~1964 líneas). Aquí coexisten:
1. Estado global (`CFG`, `SETTINGS`, `estado`, etc.) → identificadores se renombran.
2. Lógica de orquestación (eventos del DOM, llamadas IPC) → renombrados acumulan los cambios de Ondas 2, 4, 5, 6.
3. IDs HTML (`pantalla-bienvenida`, etc.) → **NO se tocan en esta onda**.

**Renombrados de identificadores**:
- Funciones `arrancar` → `bootstrap`, `mostrarBienvenida` → `showWelcomeScreen`, `validarFormBienvenida` → `validateWelcomeForm`, `empezarPrimeraVez` → `startFirstRun`, `empezarPrimeraVezImpl` → `startFirstRunImpl`, `cargarConfigYMostrarApp` → `loadConfigAndShowApp`, `mostrarErrorBienvenida` → `showWelcomeError`, `mostrarError` (función local) → `showErrorDialog`, …
- Variables: `CFG` (igual), `SETTINGS` (igual), `infoConfigAlAbrirAdmin` → `configInfoOnAdminOpen`, `CFG_BACKUP` → `cfgBackup`, `eventosBindeados` → `eventsBound`, `ultimoResultado` → `lastResult`, `estado.packId` (igual), `estado.esAdmin` → `estado.isAdmin` (cuidado, se accede en varios sitios), `estado.mostrarCostes` → `estado.showCosts`, …
- Metadatos: `PACK_META` (igual), `ADMIN_TAB_META` (igual; sus claves internas `titulo`, `desc` → `title`, `desc`).

**Llamadas a `window.packprice.*`**: pasan al nombre nuevo expuesto en Onda 2 (`readSettings` en vez de `leerSettings`, …). Como los alias siguen vivos, la migración se puede fasear por bloques.

**IDs HTML**: **OUT OF SCOPE de esta onda**. Si en el futuro se renombran (`pantalla-bienvenida` → `welcome-screen`), abrir una onda separada que toque a la vez `index.html`, `styles.css` y `renderer/app.js`. Documentar la deuda al final del documento.

**Subdividir el PR**: 1964 líneas en un PR es ilegible. Dividir por bloques de eventos:
1. Sección de bootstrap + welcome (líneas 1–230 aprox.)
2. Sección de carga de config + render del home
3. Sección de selección de pack + cálculo
4. Sección de admin (open/save/cancel/conflict/etc.)
5. Sección de historial
6. Sección de PDF export
7. Sección de atajos y misc.

**Aceptación tras cerrar Onda 7**:
- Limpiar alias de Onda 2 y Onda 4. Re-test completo.
- Smoke completo CLAUDE.md §12.

---

### Onda 8 · Limpieza

1. Eliminar alias legacy de `preload.js` y `renderer/format.js`.
2. Borrar la rama de compat de payloads IPC en `main.js` (`payload.ruta ?? payload.path` → solo `payload.path`).
3. Pasar `tests/config-default.test.js` a inglés (importa `buildDefaultConfig` y comprueba claves del config; las claves se quedan en español, los `describe`/`test` strings se traducen).
4. Actualizar CLAUDE.md §3 (la sección que dice "legacy (ES)") quitando las marcas de legacy de los archivos ya migrados.
5. Revisar mensajes de log en `lib/logger.js` callers — campos JSON traducidos consistentemente.
6. `npm audit` + smoke completo + tag de versión beta.

---

## 7. Política de mensajes de error

Después del refactor, todos los mensajes de error que **se muestran al usuario** (vía `showError`, `dialog.showMessageBox`, o renderizados en pantalla de error) **siguen en español**. Los `throw new Error('…')` internos también, porque acaban propagándose a la UI vía `{ ok:false, error: e.message }`.

Los logs estructurados (campos JSON del logger) sí van en inglés (`{ path, user, error }`).

## 8. Política de tests

- `describe` y `test` strings → inglés (los lee solo el dev).
- Datos de entrada → siguen usando las claves del config en español (es lo realista).
- Snapshots/golden files (si los hubiera) — no aplica hoy.

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Romper `renderer/app.js` entre PRs por renombrar el preload | Onda 2 introduce alias; se eliminan tras Onda 7 |
| Confundir claves del config con variables locales | Glosario §5 + revisar el diff con `git diff --color-words` |
| Renombrar accidentalmente una clave persistida | Antes de cada onda, ejecutar `grep` específico: `git grep -n "total_iva_inc\|pvp_unitario\|coste_total\|margen_pct\|cant_4xl\|cant_5xl\|cantidad_total\|extras_sin_iva\|extras_detalle\|base_venta\|desglose\|modificado_por\|fecha_actualizacion\|ruta_config\|nombre_usuario"` y verificar que no aparecen en el diff |
| Tests pasan pero PDF/Historial roto | Smoke manual al final de Onda 5, 7 y 8: generar PDF, listar historial, restaurar quote |
| Logs ilegibles tras renombrar campos | El logger en `lib/logger.js` ya está en EN; alinear progresivamente |
| Bloquear merges del equipo (PRs largos) | Cada onda como PR independiente; alias mantienen compat |

## 10. Deuda explícita (no abordada por este plan)

1. **Claves del config en español**: documentar como decisión consciente en CLAUDE.md §1 (ya lo está implícitamente; reforzar). Si en el futuro se quiere migrar, requiere `migrarConfig(config)` (CLAUDE.md §6.3) con versión bumpeada y backup.
2. **Claves del resultado del cálculo** (`total_iva_inc`, etc.): mismo principio — el día que se migre, hay que migrar `presupuestos.json` y regenerar PDFs.
3. **IDs HTML**: onda futura dedicada. Riesgo medio (CSS+JS+HTML acoplados); beneficio bajo a corto plazo.
4. **Campos del audit log y del payload de `audit:append`**: `usuario`, `cambios`, `app_version`. Al estar en NAS append-only, una migración a `user`, `changes` (manteniendo `app_version`) requiere doble lectura durante un trimestre. Aplazar.

## 11. Orden de ejecución sugerido

```
PR 1: Onda 1 + Onda 3   (lib/config-parser.js + main.js + tests)
PR 2: Onda 2            (preload.js, con alias)
PR 3: Onda 4 + Onda 5   (format.js + calculo.js + tests)
PR 4: Onda 6            (admin.js)
PR 5..7: Onda 7         (app.js, dividido en 3 sub-PRs por sección)
PR 8: Onda 8            (limpieza de alias + CLAUDE.md + config-default.test)
```

Total: 8 PRs. Cada uno reviewable en <1h.

## 12. Criterios de finalización global

- `git grep -nE "leer|guardar|seleccionar|validar|crear|obtener|fusionar|escribible|ruta|archivo|contenido|cantidad|tramo|caras" -- '*.js' ':!node_modules' ':!config.default.js' ':!lib/config-parser.js'` no devuelve resultados **excepto** los listados como no-renombrables en §3 (claves del config, claves del resultado, strings de UI).
- `npm test` y smoke manual completo (CLAUDE.md §12) verde.
- Versión de la app bumpeada (sufijo `-beta` se mantiene; ver memory note del proyecto).
- CLAUDE.md §3 actualizado: ningún archivo marcado "legacy ES" salvo `config.default.js` (sus claves siguen en español a propósito).

---

## Estado

- [ ] Onda 1 — `lib/config-parser.js` + test
- [ ] Onda 2 — `preload.js` + canales IPC legacy
- [ ] Onda 3 — `main.js`
- [ ] Onda 4 — `renderer/format.js`
- [ ] Onda 5 — `renderer/calculo.js` + test
- [ ] Onda 6 — `renderer/admin.js`
- [ ] Onda 7 — `renderer/app.js` (3 sub-PRs)
- [ ] Onda 8 — Limpieza de alias + actualización de CLAUDE.md
