# Capítulo 11 · Tier-1 profesionalidad real

> Hasta el capítulo 10, Quanto calculaba bien y empaquetaba bien. Pero un bug del taller seguía siendo invisible (logs en stderr perdidos en el `.exe`), un cambio de IVA no dejaba huella (¿quién lo subió y cuándo?), y un presupuesto se evaporaba al cerrar la app. Este capítulo cierra esos huecos con seis entregas concretas, todas alineadas con CLAUDE.md, y abre la primera grieta deliberada en una de sus reglas: a partir de aquí, el código nuevo se escribe en inglés.

![Resumen visual del Tier-1: validación, logs, auditoría con diff, historial, PDF](images/tier-1-overview.svg)

---

## Por qué un "Tier-1" y no un sprint corriente

Cuando una base es pequeña y limpia, lo peligroso no es el cambio grande. Lo peligroso son las decisiones que parecen pequeñas y, en seis meses, descubres que se han calcificado: un dato que no se valida, un error que se traga en silencio, una lista de cambios que nadie auditó. Cosas que no se ven hasta que duelen.

El Tier-1 es exactamente eso: la lista de cosas que **una empresa que cobra a clientes** debería tener antes de la primera factura. Validación de datos, observabilidad mínima, trazabilidad de cambios, persistencia del trabajo hecho, exportación a PDF. Nada de aquí necesita debate: todo encaja con los principios del proyecto. Por eso se etiqueta como "profesionalidad real" en `planes/tier-1-profesionalidad-real.md` y por eso se ataca primero.

> **Decisión bloqueada**: Tier-1 = mejoras que no abren debate sobre los principios de CLAUDE.md. Cualquier cosa que sí los abra (un framework UI, una BD local, telemetría) va al Tier-3 y se discute aparte.

---

## La política de idioma: por qué cambia ahora

Antes de tocar una sola línea de implementación, tocó una decisión transversal: **el código nuevo se escribe en inglés**. Las strings visibles al usuario siguen en español (CLAUDE.md §4.5 sigue intacto en eso). Pero los identificadores, comentarios, nombres de archivo y canales IPC pasan a inglés.

Las razones son las habituales:

- **Mantenibilidad a largo plazo**. Las APIs de Electron, Node y npm están en inglés. Mezclar `calcularPackPena` con `webContents.printToPDF` produce un cóctel difícil de leer.
- **Reusabilidad del talento**. Si en el futuro entra alguien al proyecto, leer `audit:list` o `quotes:save` no requiere contexto.
- **Coherencia con el ecosistema**. `electron-log`, `electron-builder` y demás dependencias hablan inglés; nuestros wrappers también.

Lo que **no** cambia: la base legacy (`main.js`, `app.js`, `calculo.js`, `admin.js`, `lib/config-parser.js`) sigue en español. Migrarla en bloque sería un commit ilegible. Se renombra in-situ cuando un cambio sustancial pase por encima.

`CLAUDE.md` queda actualizado con la política, una nota explicando la migración progresiva y una sección §5.4 con ejemplos de IPC en inglés (`audit:list`, `quotes:save`, `pdf:export`, `logs:read-last`).

---

## Orden de ataque (y por qué)

El plan listaba siete ítems; aquí se entregan los seis pendientes (el #1, tests del cálculo, ya estaba):

1. **#3 Validación de esquema** — barato, alto valor defensivo, base para confiar en lo siguiente.
2. **#2 `electron-log`** — observabilidad mínima.
3. **#6 Auditoría** + **#7 Diff visual** — comparten el mismo `diff.js`, se entregan juntos.
4. **#4 Historial de presupuestos** — el más grande de los "fáciles".
5. **#5 Exportación PDF** — depende del historial (necesita un id estable) y cierra la cadena valor para el cliente.

El orden no es accidental: cada paso necesita que el anterior esté firme. Validar primero significa que el resto del código puede asumir que el config tiene forma. Logs antes que auditoría significa que si el audit falla, lo vemos. Diff antes que UI de auditoría significa que la previsualización y el log comparten el mismo motor.

---

## Paso 1 · Validación estricta del config (`#3`)

![Diagrama: config.js → validateConfigSchema → renderer (con error legible) o cálculo](images/schema-validation-flow.svg)

`lib/config-parser.js` ya hacía un chequeo grueso (existen las secciones top-level), pero un `parametros.iva` borrado a mano se colaba y luego el cálculo escupía `NaN` páginas más tarde. Eso es el peor patrón posible: el error sucede lejos del problema.

La pieza nueva es `lib/config-schema.js`, un módulo puro (sin `fs`, sin Electron, trivialmente testable) que devuelve una lista de mensajes con `path` exacto:

```js
const errors = collectConfigErrors(cfg);
// → [
//     'Falta "parametros.iva".',
//     '"parametros.merma_pct" debe estar entre 0 y 1 (recibido: 12).',
//     '"tramos[1].desde" (15) se solapa con el tramo anterior (hasta 24).'
//   ]
```

El validador cubre:

- **Parámetros**: 15 campos numéricos requeridos. Cotas explícitas: `iva` ∈ [0, 1] (atrapa el clásico "21" en lugar de "0.21"), `merma_pct` ∈ [0, 1], `prendas_por_bulto` ≥ 1.
- **Modelos Roly**: BEAGLE/CLASICA/URBAN presentes con `nombre`, `ref`, `precio` no negativo.
- **Tramos**: array no vacío, cada uno con `id`, `desde` ≥ 1, `hasta` ≥ `desde` (o `null`), `reduccion_tiempo` ∈ [0, 1). **Detección de solapes**: el `desde` de un tramo no puede ser ≤ al `hasta` del anterior.
- **Packs**: PVP completo por `(grupo, caras, tramo)` para packs `pena`, por `(caras, tramo)` para `individual`. Refs cruzadas validadas: `solo_camisetas.modelo='BEAGLE'` debe existir en `modelos_roly`; `sudaderas_mixto.packs_referencia.URBAN='solo_urban'` debe existir en `packs`.
- **Admin**: tolera tanto el shape de disco (`{clave: '...'}`) como el del renderer (`{tiene_clave: true}`).

`validateConfigSchema(cfg)` es el wrapper que lanza con todos los errores concatenados. Se cablea en dos sitios de `main.js`:

```js
ipcMain.handle('config:read', (event, ruta) => {
  try {
    const config = leerConfigDesdeArchivo(ruta);
    validateConfigSchema(config);   // fail-fast
    ...
  }
});
```

Y antes de cada `config:write`/`config:force-write`, justo después de la validación de forma. El admin que mete un valor inválido recibe un mensaje que **nombra el campo**; nada se persiste.

44 tests en `tests/config-schema.test.js` cubren cada categoría de error y el camino feliz.

> **Decisión bloqueada**: la validación vive en un módulo puro y se aplica tanto en lectura como en escritura. Nunca se persiste un config que el validador rechazaría.

---

## Paso 2 · Logging persistente con `electron-log` (`#2`)

Hasta ahora, `console.error` en `main.js` iba a stderr, que en el `.exe` empaquetado **no existe**. Cualquier excepción del taller era invisible. Para una app de dos usuarios sin canal de soporte 24/7, eso es una bomba de relojería: el primer bug raro consume horas de "¿qué hiciste? ¿puedes reproducirlo?".

CLAUDE.md §8.5 ya bendecía `electron-log` como la única dependencia que merece la pena para esto. Se añade como **primera dependencia de runtime** del proyecto:

```diff
+ "dependencies": {
+   "electron-log": "^5.4.3"
+ }
```

`lib/logger.js` es un wrapper fino:

- Sink en `%APPDATA%\Quanto\logs\main.log`.
- Rotación por tamaño: 5 MB por archivo, 3 archivos archivados.
- Formato estable: `[ISO timestamp] [level] mensaje {ctx-json}`.
- API simple: `logger.info('quote saved', { id, total })`.

El `logger.info(message, ctx)` serializa el `ctx` como JSON al final de la línea, lo cual mantiene el log greppable desde cualquier shell:

```bash
grep "config:write" main.log
# 2026-05-11T14:32:00.123Z [warn]  config:write conflict detected {"ruta":"…","modificadoPor":"María"}
```

Reemplaza tres `console.error` legacy en `main.js` (backup, settings corruptos, errores de IPC) por llamadas equivalentes al logger. Añade `process.on('uncaughtException')` y `'unhandledRejection'` para que cualquier crash deje rastro.

El handler IPC `logs:read-last` permite que el admin vea las últimas N líneas desde un modal nuevo, abierto desde un botón "Ver logs" en el footer del modo admin. Útil cuando el cliente reporta "no me deja guardar" y necesitas el contexto sin pedirle que abra el explorador de archivos.

5 tests en `tests/logger.test.js` validan creación de archivo, lectura de tail, contexto JSON y la idempotencia de `configureLogger`.

---

## Paso 3 · Diff plano (`lib/diff.js`)

El plan pedía dos cosas que comparten motor: **auditoría** (qué cambió, quién y cuándo) y **previsualización del diff antes de guardar** (revisar antes de apretar "guardar"). Lo limpio era no escribir el motor de diff dos veces.

`lib/diff.js` es ese motor, en inglés, puro y testeable:

```js
diffObjects(before, after) → [
  { path: 'parametros.iva',         before: 0.21, after: 0.23, kind: 'change' },
  { path: 'tramos[1].hasta',         before: 24,   after: 30,   kind: 'change' },
  { path: 'packs.solo_urban.pvp.dos_caras.T4', before: 13.95, after: 12.95, kind: 'change' }
]
```

Decisiones del diseño:

- **Output plano**, no JSON Patch. La nidación del config es somera; un array de `{path, before, after, kind}` es suficiente y se renderiza directamente en una `<ul>`.
- **`path` con dot-notation** y `[idx]` para arrays. Ergonómico para humanos: `tramos[1].hasta` se lee y se busca al instante.
- **`kind` ∈ `add | remove | change`**. La UI los pinta en verde/rojo/ámbar.
- **Ignore-paths por defecto**: `fecha_actualizacion`, `modificado_por`, `admin.clave`, `admin.tiene_clave`. Estos cambian en cada save aunque el contenido real sea idéntico. Si los registráramos, el audit log se llenaría de ruido.

`formatChangeLine(change)` produce una línea legible: `~ parametros.iva: 0.21 → 0.23`. Se reusa en la UI y, indirectamente, en los logs.

15 tests cubren equality, scalar/object/array, ignore paths personalizables y la regla de "ignore por defecto".

---

## Paso 4 · Auditoría real (`lib/audit.js`, `#6`)

![Línea de tiempo: backup → write → audit, con audit.log en JSONL al lado del config](images/audit-flow.svg)

El audit log vive **junto al config en el NAS**, no en el `%APPDATA%` local. Es información compartida del taller, no del PC: cualquiera con acceso al NAS la puede consultar.

Formato: **JSON Lines**, una entrada por línea:

```json
{"ts":"2026-05-11T14:32:00.000Z","usuario":"Alberto","app_version":"2.0.0-beta","cambios":[{"path":"parametros.iva","before":0.21,"after":0.23,"kind":"change"}]}
```

Por qué JSONL y no un único array JSON:

- **Append-only es O(1)**. Sumar una entrada no requiere parsear y reescribir el archivo entero.
- **Una línea corrupta solo se pierde a sí misma**. Si el NAS se cae a mitad de escritura (raro pero posible en SMB), el resto del log sigue siendo leíble.
- **Greppable** desde Windows, Linux o Mac sin parser custom.
- **Migrable a ELK/Loki** el día que el taller crezca, sin reformatear histórico.

El cableado en `main.js` es estricto en orden: **backup → write → audit**. El audit es lo último, y se hace dentro de un `try/catch` que **no propaga el error**: si auditar falla por permisos en el NAS, el cambio del usuario ya está hecho y el backup existe; perder solo la entrada del log es preferible a deshacer el cambio. El fallo se loguea por `electron-log`, no se silencia.

Una decisión deliberada: **`audit:list` siempre lee desde disco**, no cachea. Las entradas son apenas unos cientos al cabo de meses; la latencia de SMB para leer 50 KB es despreciable comparada con la complejidad de invalidar una caché compartida entre múltiples PCs.

UI: nueva pestaña **"Auditoría"** en el modo admin, junto a Parámetros / Modelos / Tramos / Packs. Renderiza las últimas 200 entradas de más reciente a más antigua, cada una con su usuario, fecha, contador de cambios y la lista coloreada de paths modificados.

---

## Paso 5 · Diff visual antes de guardar (`#7`)

![Modal "Confirmar cambios" mostrando 3 cambios pendientes con before/after y botones Cancelar/Confirmar](images/diff-preview-modal.svg)

El error tipográfico más caro del mundo es subir el IVA de 21 a 23 cuando querías subirlo a 21.5. Lo que evita ese gasto es una pregunta antes de escribir: "vas a guardar 3 cambios. ¿Confirmas?".

El flujo nuevo se inserta justo entre "Guardar" y `config:write`:

1. El renderer envía el config local + la ruta a `audit:diff-preview` (un IPC nuevo, puro: no escribe nada).
2. `main.js` lee el config actual del disco, le inyecta la clave admin (que el renderer no tiene) y devuelve el `diffObjects(antes, despues)`.
3. Si la lista está vacía → modal "Sin cambios", aborta.
4. Si tiene contenido → modal "Confirmar cambios" con la lista renderizada por el mismo `renderChangeRow` que usa la pestaña Auditoría. Botones Cancelar / Confirmar.
5. Solo si confirma se llama a `config:write`.

El detalle clave: **el cancelar es seguro**. No escribe, no audita, no toca el `mtime` del archivo. Verificable porque el sistema ya hace `mtime + sha256` para detectar conflictos (capítulo 09): si el cancelar escribiera algo, otro PC lo vería como conflicto.

---

## Paso 6 · Historial de presupuestos (`#4`)

![Modal "Historial de presupuestos" con buscador y tabla de IDs PP-2026-0042 con acciones reabrir/PDF/eliminar](images/history-modal.svg)

Hasta este capítulo, cada cálculo se evaporaba al cerrar la app. Imposible reabrir un presupuesto antiguo, imposible darle un número al cliente. La sensación al usar la app era la de una calculadora de bolsillo, no la de una herramienta de empresa.

`lib/history.js` añade persistencia local con cuatro decisiones explícitas:

### A) Local, no NAS

> El `config.js` es solo configuración, no histórico. (CLAUDE.md §9.2)

Los presupuestos viven en `<userData>/presupuestos.json`, único por PC. Razones:

- El NAS es para datos compartidos (config, audit). Mezclar histórico de varios PCs en un único archivo invitaría a colisiones que nadie quiere depurar.
- El historial tiene valor *operativo* en el PC donde se generó: el comercial reabre su presupuesto. No hay caso de uso transversal.
- Si el día de mañana se necesita un historial centralizado, es un cambio aditivo (un sync opcional al NAS, no una migración de modelo).

### B) IDs `PP-YYYY-NNNN` correlativos por año

```js
nextIdForYear(existing, 2026) // → 'PP-2026-0001' la primera vez del año
                              //    'PP-2026-0042' si ya hay 41 del año
```

El reset por año mantiene los números cortos y hace que "PP-2027-0001" tenga significado: es el primer presupuesto del año nuevo. Crece más allá de 4 dígitos cuando hace falta (`PP-2026-10000`); no truncamos.

### C) Escritura atómica `.tmp → rename`

```js
fs.writeFileSync(tmpPath, JSON.stringify(quotes, null, 2));
fs.renameSync(tmpPath, filePath);
```

Si el proceso muere a mitad de escribir, el `.tmp` queda huérfano (una limpieza menor al arrancar) y el archivo real sigue intacto. En SMB esto es importante: una desconexión de red durante la escritura es un escenario real.

### D) Lectura **estricta**, escritura silenciosa de errores

`readAllQuotes` lanza si el archivo está corrupto. **No lo silenciamos**: enmascarar pérdida de datos sería peor que un error visible. La UI muestra el mensaje al usuario; el admin tiene los backups del NAS para restaurar (si se hubiera optado por silenciar, ese backup nunca se hubiera consultado).

### Cableado UI

- Botón **"Historial"** en la topbar (icono clipboard).
- Modal con tabla: ID, fecha, usuario, cliente, pack, total, acciones.
- Buscador con debounce de 150 ms (`searchQuotes` matchea por id/usuario/cliente.nombre/cliente.contacto, case-insensitive).
- Acciones por fila: **Reabrir** (rellena el resultado en pantalla), **Exportar PDF** (paso 7), **Eliminar** (con confirmación nativa).
- Botón **"Guardar presupuesto"** en la pantalla de resultado; asigna el id, persiste, devuelve el id al usuario.

18 tests en `tests/history.test.js` cubren ids correlativos, persistencia entre arranques, búsqueda case-insensitive y atomicidad.

---

## Paso 7 · Exportación PDF (`#5`)

![Vista de un presupuesto exportado: cabecera con logo, datos del cliente, tabla de líneas, totales, condiciones](images/pdf-output.svg)

El último eslabón. Lo que el cliente recibe define la percepción del taller: si el PDF es feo, el negocio parece amateur por mucho que el cálculo sea perfecto.

Decisión clave de stack: **cero dependencias nuevas**. Electron ya trae `webContents.printToPDF()` desde hace versiones. Solo hay que generar HTML, cargarlo en una `BrowserWindow` oculta, y pedir el PDF.

`lib/pdf-template.js` es la plantilla, un módulo puro que devuelve un string con el HTML completo:

- **Self-contained**: cero recursos externos, todo el CSS inline. Si mañana hace falta enviar el PDF a alguien sin Internet, el template no se rompe.
- **Estilos de imprenta**: `@page A4`, márgenes 18×16 mm, tipografía Helvetica, paleta sobria. La cabecera es la marca; la tabla de líneas es la información.
- **Escapa todo**: nombres de cliente con `<script>` no inyectan nada. 14 tests en `tests/pdf-template.test.js` lo verifican.
- **Logo opcional**: si el cliente entrega un PNG, basta pasarlo como `logoDataUri`; si no, el template renderiza solo el nombre de la empresa.

Handler IPC `pdf:export`:

```js
ipcMain.handle('pdf:export', async (event, payload) => {
  const { quote, empresa, presupuesto, defaultName } = payload;
  // 1. Diálogo nativo "Guardar como"
  const saveDialog = await dialog.showSaveDialog(mainWindow, { ... });
  if (saveDialog.canceled) return { ok: false, cancelado: true };

  // 2. HTML → archivo temp → BrowserWindow oculta
  const html = renderQuoteHtml(quote, { empresa, presupuesto });
  fs.writeFileSync(tmpHtmlPath, html);
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, ... } });
  await win.loadFile(tmpHtmlPath);

  // 3. printToPDF → buffer → archivo
  const pdfBuffer = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  fs.writeFileSync(saveDialog.filePath, pdfBuffer);

  // 4. Cleanup en finally (incluido si algo lanza)
  return { ok: true, ruta: saveDialog.filePath };
});
```

La `BrowserWindow` se crea con `sandbox: true` (la principal lleva `false` solo porque su `preload.js` usa `require`; este popup ni necesita preload). Una superficie de ataque menos.

`config.default.js` recibe dos secciones nuevas para que el PDF salga sin tocar nada:

```js
empresa:     { nombre, cif, direccion, telefono, email, web }
presupuesto: { validez_dias: 30, condiciones: '...' }
```

Cuando un config viejo del NAS no tenga estas claves, el template usa sus propios defaults (`DEFAULT_EMPRESA`, `DEFAULT_PRESUPUESTO`). No es necesario migrar el archivo del NAS para que el PDF funcione el día 1.

UX: el botón **"Exportar PDF"** está disponible tras un cálculo y en cada fila del historial. Si el presupuesto aún no se ha guardado, el botón lo persiste primero (asignando id y fecha) y luego exporta. Esto garantiza que el id que aparece en el PDF coincide con el id en el historial.

---

## Resultado

| Antes | Después |
| --- | --- |
| Un IVA borrado a mano produce `NaN` en pantalla | El admin ve "Falta `parametros.iva`" antes de cargar |
| `console.error` se pierde en el `.exe` | `%APPDATA%\Quanto\logs\main.log` con rotación |
| Cambio de IVA = arqueología contra los backups | `audit.log` JSONL con quién, cuándo, qué |
| Tipo erróneo en admin = pérdida silenciosa | Modal "vas a cambiar 21 → 23, ¿confirmas?" |
| El cálculo se evapora al cerrar | `PP-2026-0042` guardado en `presupuestos.json`, reabrible |
| El cliente recibe un copy/paste | PDF A4 con logo opcional, condiciones y validez |

**Tests**: 110 → 169. La suite tarda 600 ms en local. Cada nuevo módulo trae sus tests; el código existente no regresiona.

**Dependencias de runtime**: 0 → 1 (`electron-log`). El compromiso era aceptable: documentado en CLAUDE.md §8.3 desde antes, justificado por el coste de la falta de logs.

**Idioma**: el código nuevo está 100 % en inglés. El legacy sigue intacto. La frontera está clara: si tocas un módulo con identificadores en español y haces un cambio sustancial, renombras lo que tocas; si no, lo dejas como está. Los diffs siguen siendo revisables.

---

## Decisiones bloqueadas en este capítulo

1. **Validación estricta del config en lectura y escritura**, con `path` exacto. Nunca se persiste un config que el validador rechazaría.
2. **`electron-log` como única dependencia de runtime**. Cualquier dependencia adicional pasa por debate y actualización de CLAUDE.md §8.3.
3. **Audit log JSONL, append-only, junto al config en el NAS**. Orden estricto: backup → write → audit.
4. **Diff plano + ignore-paths por defecto** (`fecha_actualizacion`, `modificado_por`, `admin.clave`). Un solo motor de diff, dos consumidores (audit y preview).
5. **Historial local por PC**, no en NAS. IDs `PP-YYYY-NNNN` correlativos por año, escritura atómica `.tmp → rename`.
6. **PDF generado por `webContents.printToPDF`**, sin librería externa. Plantilla self-contained, escapa todo, logo opcional.
7. **Idioma de código nuevo: inglés** (CLAUDE.md §2). Strings de UI siguen en español. Migración del legacy: progresiva y oportunista, no en bloque.

---

## Qué viene después

Quedan los planes Tier-2 (UX taller) y Tier-3 (debate). Antes de tocarlos, el orden razonable es:

1. **Empaquetar y probar el `.exe`** con el Tier-1 dentro. Asegurarse de que `electron-log` no rompe la build portable, que el `lib/**/*` viaja en el bundle, y que el PDF sale igual desde `dev` y desde `.exe` empaquetado.
2. **Validar el flujo end-to-end con el cliente**: que un admin guarde, que aparezca en `audit.log`, que un comercial guarde un presupuesto, que lo reabra al día siguiente, que exporte el PDF y se vea bien en Acrobat.
3. **Añadir el logo real del taller** al config para que aparezca en el PDF.

Solo entonces tiene sentido abrir el Tier-2.
