# Diseño — Resumen de cambios "humanizado" (sin JSON crudo)

- **Fecha:** 2026-06-16
- **Rama:** se creará una rama de feature desde `develop` al implementar
- **Estado:** aprobado (brainstorming), pendiente de plan de implementación
- **Áreas:** `renderer/change-format.js` (nuevo), `renderer/save-summary.js`,
  `renderer/admin-extras.js`, `renderer/app.js`, `renderer/styles.css`, `tests/`

## 1. Problema

Cuando se guardan cambios del catálogo, los modales de confirmación muestran el
cambio **en crudo**: rutas técnicas con notación de puntos
(`suppliers.SUPPLIER_1.name`) y, al crear/eliminar una entidad entera, **el
objeto JSON completo** (`+ suppliers.SUPPLIER_1 {"name":"Valento","web":"","notes":""}`).
Los usuarios no son técnicos. Lo mismo ocurre en el modal de conflicto y en la
auditoría/historial. Hay que mostrar mensajes claros, personalizados según el
cambio, sin JSON ni rutas técnicas.

## 2. Objetivos

1. Sustituir las rutas/JSON crudos por **mensajes en lenguaje claro**,
   agrupados por entidad, con badge (Nuevo/Editado/Eliminado), nombre legible y
   valores formateados (€, %, Sí/No, «texto», (vacío)).
2. Un único **humanizador puro** reutilizado por **los cinco sitios** que hoy
   pintan cambios, para que todo quede consistente y se pruebe en un solo lugar.
3. Cero JSON crudo visible en ningún caso; **fallback legible** si un campo no
   está en el diccionario.

## 3. No-objetivos

- No cambia el **modelo de guardado** ni la **comprobación de conflicto**.
- No cambia `main.js`/`lib/` ni el **formato persistido** de `audit.log`
  (lo escribe el proceso main; se conserva — regla #5). Solo cambia **cómo el
  renderer muestra** los cambios.
- No cambia la lógica de cálculo. Sin dependencias nuevas (vanilla ESM).

## 4. Decisiones de brainstorming

| Decisión | Elección |
|---|---|
| Dirección visual | **Agrupado por entidad** + filas de campo amigables (badge + icono + tipo + nombre) |
| Alta/baja de entidad entera | **Solo una línea de resumen** (sin volcar campos ni JSON) |
| Alcance | **Todo**: confirmación (file + nube), modal de conflicto, auditoría (file) e historial (nube) |

## 5. Hallazgos del código actual (lo que condiciona el diseño)

- `renderer/admin-extras.js#renderChangeRow(change)` es **compartido**: lo usan
  la confirmación en modo archivo (`renderDiffPreview`), la auditoría modo
  archivo (`renderAuditTab` → `entry.changes`) y el historial nube
  (`renderCloudAuditList` → `renderCloudDiff` → `entry.diff`). Consume
  `{path, before, after, kind}`.
- **Las rutas difieren por origen:** en modo archivo la ruta es **completa**
  (`suppliers.SUPPLIER_1.name`, diff de todo el config en main); en nube el
  cambio viene **por entidad** (`entityType`/`entityId` aparte; ruta relativa
  tipo `name`, `price`).
- La confirmación en **nube** usa `renderer/save-summary.js#buildSaveSummary`,
  que ya **agrupa por entidad** pero emite `lines: string[]` ya formateadas
  (`"+ path: json"`). Hay que refactorizarlo para que emita cambios
  **estructurados** y pasen por el humanizador.
- `renderer/admin.js` ya tiene un diccionario de etiquetas de **parámetros**
  (`PARAMETER_GROUPS`, `key → label`) que reutilizaremos.
- Todos los consumidores que renderizan ya disponen de datos **estructurados**
  (`path/before/after/kind`), así que el humanizador vive **solo en el
  renderer**; main/lib no se tocan.

## 6. Arquitectura

**Nuevo módulo puro `renderer/change-format.js`** (ESM, sin DOM, testeable). Es
el "humanizador". API (todas puras):

- `parsePath(fullPath) → { entityType, id, rel }`
  Convierte una ruta completa en tipo de entidad + id + ruta **relativa** a la
  entidad. Ej.: `"suppliers.SUPPLIER_1.name"` → `{ entityType:'supplier',
  id:'SUPPLIER_1', rel:'name' }`; `"parameters.vat"` →
  `{ entityType:'parameters', id:null, rel:'vat' }`;
  `"products.BEAGLE.suppliers[0].price"` → `{ entityType:'product', id:'BEAGLE',
  rel:'suppliers[0].price' }`; `"tiers[1].to"` → `{ entityType:'tiers', id:null,
  rel:'[1].to' }`. Mapea sección→tipo: `suppliers→supplier`, `products→product`,
  `addons→addon`, `packs→pack`; globales `parameters`/`tiers`/`company`.

- `fieldLabel(entityType, rel) → string`
  Etiqueta amigable del campo según la entidad y la ruta relativa (diccionario,
  §7). Si no hay match, **fallback legible** (segmentos en palabras, índices de
  array como "N+1"), nunca la ruta cruda con puntos ni JSON.

- `formatValue(entityType, rel, value) → string`
  Valor formateado según el campo: € / % / Sí-No / «texto» / `(vacío)` / número
  (§7).

- `humanizeChange(change, entityType?) → string`
  Una línea amigable para UN cambio de campo. Si `entityType` se pasa, `change.path`
  se trata como **relativo**; si no, se usa `parsePath(change.path)`. Formatos:
  - `add`: `"<Etiqueta>: <valor>"`
  - `remove`: `"<Etiqueta>: se quita (<valor>)"`
  - `change`: `"<Etiqueta>: <antes> → <después>"`

- `groupChanges(flatChanges) → Group[]`
  Agrupa una lista **plana** de cambios (rutas completas, como el diff de modo
  archivo) por entidad y detecta el **tipo de grupo**:
  `Group = { entityType, id, name, kind, fieldChanges }` donde
  `kind ∈ 'add'|'remove'|'edit'`. Si la entidad entera se añadió/eliminó
  (un único cambio cuya `rel` es vacía, con `after`/`before` objeto), el grupo
  es `add`/`remove` y `fieldChanges` queda vacío (solo línea de resumen);
  si no, `edit` con sus `fieldChanges` (cada uno con `rel` ya relativa).

- `entityName(entityType, entityObj, id) → string`
  Nombre a mostrar: `entityObj.name` / `entityObj.label`, con fallback al `id`.

- `entityTypeLabel(entityType) → string`
  `'supplier'→'Proveedor'`, `'product'→'Producto'`, `'pack'→'Pack'`,
  `'addon'→'Complemento'`, `'parameters'→'Parámetros de cálculo'`,
  `'tiers'→'Tramos por volumen'`, `'company'→'Empresa'`.

- `kindBadge(kind) → { label, cls }`
  `add→{'Nuevo','add'}`, `remove→{'Eliminado','remove'}`,
  `edit→{'Editado','change'}` (reutiliza las clases de color existentes
  `audit-change--add/remove/change`).

> Decisión de unidad: el humanizador **no tiene acceso al `cfg`**, así que en
> referencias a otra entidad (p. ej. `suppliers[0].supplier`, cuyo valor es el
> id de un proveedor) se muestra el id entre «». Mostrar el nombre resuelto
> queda como idea futura (§11).

## 7. Diccionario de etiquetas y formato de valores

**Reglas de formato de valor** (`formatValue`), por heurística de campo + tipo:
- **€**: claves que terminan en `_eur`, o `price`, `cost`, `extra_cost_3xl`,
  `surcharge_*`, `overhead_*`, y celdas de `prices.*`/`bundle_prices.*` →
  `3,5` → `"3,50 €"` (2 decimales, coma decimal).
- **%**: `target_margin`, `default_target_margin`, `vat`, `waste_pct` →
  `0.35` → `"35 %"`.
- **booleano** → `"Sí"` / `"No"` (`is_default`, `free_components`,
  `vat_included`).
- **texto** → `«valor»`; cadena vacía → `"(vacío)"`.
- **null/undefined** → `"(vacío)"`.
- **número** sin unidad → tal cual con coma decimal.
- **modo de precio** (`pricing_mode`): `bundle→"Por unidad"`,
  `components→"Por componentes"`.

**Etiquetas por entidad** (`fieldLabel`, ruta relativa → etiqueta):

- **Producto**: `name`→"Nombre", `category`→"Categoría",
  `extra_cost_3xl`→"Coste extra 3XL", `target_margin`→"Margen objetivo",
  `suppliers[i].supplier`→"Proveedor N · Proveedor",
  `suppliers[i].ref`→"Proveedor N · Referencia",
  `suppliers[i].price`→"Proveedor N · Precio base",
  `suppliers[i].min_order`→"Proveedor N · Pedido mínimo",
  `suppliers[i].is_default`→"Proveedor N · Por defecto",
  `prices.two_sides.<T>`→"PVP · 2 caras · Tramo <T>",
  `prices.one_side.<T>`→"PVP · 1 cara · Tramo <T>".
- **Pack**: `name`→"Nombre", `description`→"Descripción", `icon`→"Icono",
  `min_total`→"Mínimo total (uds)", `target_margin`→"Margen objetivo",
  `pricing_mode`→"Modo de precio", `free_components`→"Componentes libres",
  `options[i].label`→"Opción N · Etiqueta",
  `options[i].values[j].label`→"Opción N · Valor M · Etiqueta",
  `options[i].values[j].sides`→"Opción N · Valor M · Caras",
  `components[i].label`→"Componente N · Etiqueta",
  `components[i].product`→"Componente N · Producto",
  `components[i].qty_per_pack`→"Componente N · Uds por pack",
  `bundle_prices.<combo>.<T>`→"PVP · <combo> · Tramo <T>".
- **Proveedor**: `name`→"Nombre", `web`→"Web", `notes`→"Notas".
- **Complemento**: `label`→"Etiqueta", `price`→"Precio (€/ud)",
  `cost`→"Coste interno (€/ud)", `vat_included`→"IVA incluido",
  `applies_to[i]`→"Aplica a".
- **Parámetros**: reutilizar el mapa `key → label` de `PARAMETER_GROUPS`
  (`admin.js`). Exponer un helper exportado en `admin.js`
  (`parameterLabel(key)`) o duplicar el mapa mínimo en `change-format.js`
  (decisión en el plan; preferible exportar desde `admin.js` para no duplicar).
- **Tramos** (`tiers`): `[i].id`→"Tramo N · Id", `[i].label`→"Tramo N · Etiqueta",
  `[i].from`→"Tramo N · Desde", `[i].to`→"Tramo N · Hasta", y cualquier otro
  campo del tramo con fallback "Tramo N · <campo>".
- **Empresa** (`company`): `name`→"Nombre", y fallback por campo.

**Fallback** (campo no mapeado): construir la etiqueta a partir de los
segmentos relativos en palabras (último segmento legible + índices "N"),
nunca JSON ni ruta con puntos.

## 8. Render por sitio (los 5)

1. **Confirmación modo archivo** — `renderDiffPreview(flatChanges)`
   (`admin-extras.js`): `groupChanges(flatChanges)` → render agrupado (badge +
   tipo + nombre; alta/baja = línea de resumen; edición = filas humanizadas).
   Cabecera: "Vas a guardar N cambios" (N = nº de cambios de campo + nº de
   altas/bajas, definido en el plan).
2. **Confirmación modo nube** — `buildSaveSummary` refactorizado a grupos
   estructurados `{ entityType, id, name, kind, fieldChanges }`;
   `renderSaveSummary` (`app.js`) usa el **mismo** componente de render de grupo
   que el modo archivo (extraído a una función compartida, p. ej.
   `renderChangeGroup(group)` en `change-format.js` o `admin-extras.js`).
   Mantiene la coletilla del autor ("como <autor>").
3. **Modal de conflicto** — `app.js` (server-vs-mía): cada lado se humaniza con
   el mismo grupo/funciones; muestra el nombre de entidad y, por columna, las
   filas humanizadas en vez de las líneas crudas.
4. **Auditoría modo archivo** — `renderChangeRow(change)` pasa a usar
   `humanizeChange(change)` (deduce entityType con `parsePath`, ruta completa).
5. **Historial nube** — `renderCloudAuditList`/`renderCloudDiff` pasan
   `entry.entityType` a `renderChangeRow(change, entityType)` (ruta relativa).

`renderChangeRow` gana un segundo parámetro **opcional** `entityType`; sin él,
`humanizeChange` deduce el tipo con `parsePath`. Se conserva el guard de diff
malformado (cadena cruda) del historial nube.

Estilo visual (`styles.css`): badge por tipo reutilizando colores
`--*-soft`/`audit-change--*` existentes; fila "etiqueta · antes → después" con
los valores resaltados; cabecera de grupo con icono de entidad. Sin `<code>`
para rutas.

## 9. Pruebas

`change-format.js` es puro → Vitest exhaustivo:
- `parsePath`: secciones per-id (con índices de array), globales, ruta de
  entidad raíz (rel vacía).
- `fieldLabel`: una muestra de cada entidad + fallback de campo desconocido
  (sin puntos/JSON).
- `formatValue`: €, %, booleano, texto, vacío, número, `pricing_mode`.
- `humanizeChange`: add/remove/change con y sin `entityType`.
- `groupChanges`: alta de entidad entera (kind add, sin fieldChanges), baja
  (kind remove), edición multi-campo (kind edit), mezcla, y que **nunca**
  produce JSON.
- `entityName`/`entityTypeLabel`/`kindBadge`.
Adaptar `tests/save-summary.test.js` al nuevo shape estructurado de
`buildSaveSummary` (grupos con `kind`/`name`/`fieldChanges`). El formato de
`audit.log` no cambia → tests de main/lib intactos.

## 10. Riesgos y casos límite

- **Rutas relativas vs completas:** el humanizador debe funcionar con ambas;
  `humanizeChange(change, entityType?)` cubre los dos orígenes. Verificar el
  shape real de `entry.diff` en nube al cablear (paso del plan).
- **Diff malformado** (historial nube, cadena cruda): conservar el guard
  actual; no romper.
- **Valores objeto en una hoja** (no debería pasar salvo alta/baja, que se
  resume): si aparece, `formatValue` devuelve "(varios datos)" en vez de JSON.
- **Conteo del botón** "Guardar N cambios": definir N de forma coherente entre
  file y nube (cambios de campo + altas/bajas como 1 cada una). Detallar en el
  plan; no romper el texto del botón.
- **Etiquetas de parámetros:** preferir exportar `parameterLabel` desde
  `admin.js` para no duplicar el diccionario; si se duplica, dejar un test que
  detecte divergencias.

## 11. Ideas a largo plazo (fuera de alcance)

- Resolver ids a nombres (p. ej. el proveedor por defecto mostrado por su
  nombre, el producto de un componente por su nombre) pasando un `cfg` opcional
  al humanizador.
- Iconos por tipo de cambio en cada fila (no solo en la cabecera del grupo).
- Agrupar visualmente los PVP cambiados en una mini-tabla en vez de fila a fila.
- Texto "diff inline" (resaltar la parte que cambió dentro de un texto largo).
