# Diseño — Admin de catálogo: lista + buscador + editor enfocado + responsive

- **Fecha:** 2026-06-15
- **Rama:** `refactor/english-migration-pr1`
- **Estado:** aprobado (brainstorming), pendiente de plan de implementación
- **Áreas:** `renderer/admin.js`, `renderer/app.js`, `renderer/styles.css`, `tests/`

## 1. Problema

Las pestañas de catálogo del modo administrador (Productos, Packs, Proveedores,
Complementos) renderizan **todas** las entidades, siempre expandidas, una debajo
de otra en `#admin-tab-content`. Con el tiempo la lista será larga y:

- Cuesta encontrar una entidad concreta (no hay búsqueda).
- Editar un producto entero (proveedores + matriz completa de PVP por caras y
  tramo) en línea, en medio de una lista larga, es incómodo.
- El modal tiene un ancho fijo (`max-width: 920px`) que no aprovecha los
  monitores grandes ni se ajusta de forma fluida.

## 2. Objetivos

1. **Desplegables / vista de índice:** cada pestaña de catálogo abre como una
   lista compacta (una fila por entidad), no como formularios expandidos.
2. **Buscador en vivo** en las cuatro pestañas de catálogo.
3. **Editor enfocado** (maestro-detalle dentro del mismo modal) para crear y
   editar una entidad cómodamente, con secciones plegables dentro.
4. **Modal responsive** en ambas direcciones: se ensancha en pantallas grandes y
   se ajusta en pequeñas.

## 3. No-objetivos

- No se cambian las pestañas **Parámetros, Tramos ni Auditoría** (no son listas
  de entidades editables homogéneas).
- **No se cambia el modelo de guardado** (un único «Guardar» global con
  comprobación de conflicto) ni la lógica de cálculo.
- No se añaden dependencias, frameworks, build step ni TypeScript (regla #9).
- No se implementan las «ideas a largo plazo» del §10.

## 4. Decisiones de brainstorming

| Decisión | Elección |
|---|---|
| Presentación del editor | **Maestro-detalle** dentro del modal (no modal apilado ni panel lateral) |
| Mecanismo de plegado | **`<details>`/`<summary>` nativo** (no acordeón JS a medida) |
| Vista por defecto de la lista | **Todo plegado**: filas compactas, no formularios |
| Alcance | **Las cuatro** entidades: Productos, Packs, Proveedores, Complementos |
| Modelo de guardado | **Sin cambios**: edición en vivo sobre `CFG` + «Guardar» global |
| Buscador | En las cuatro; en vivo por DOM; por `id + nombre + categoría`, sin acentos |

`renderer/dropdown.js` (estiliza los `<select>`) es una preocupación distinta y
**no se toca**; los `<select>` del editor se siguen enriqueciendo con
`enhanceDropdowns()` tras cada render, como ahora.

## 5. Restricción que condiciona el diseño

`showAdminTab(tab)` (en `app.js`) re-renderiza la pestaña **entera**
(`cont.innerHTML = renderAdminTabContent(...)`) y vuelve a cablear los eventos
tras **cada** acción estructural (alta/baja) y en cada cambio de pestaña. Por
tanto, **todo el estado de UI (vista actual, entidad en edición, texto de
búsqueda, secciones plegadas) vive fuera del DOM**, en `state`, y se re-aplica
después de cada render. Es el mismo patrón que ya usa `state.adminTab`.

## 6. Estado

Extender el objeto `state` de `app.js` (hoy `{ packId, isAdmin, adminTab,
showCosts }`):

```js
const state = {
  packId: null,
  isAdmin: false,
  adminTab: 'parameters',
  showCosts: false,

  // --- nuevo: navegación y filtros del admin de catálogo ---
  adminView: 'list',          // 'list' | 'editor' (solo para pestañas de catálogo)
  adminEditingId: null,       // id de la entidad en edición
  adminSearch: {              // texto de búsqueda por pestaña (persiste al re-render)
    products: '', packs: '', suppliers: '', addons: ''
  },
  adminSections: new Set()    // claves "<tab>:<id>:<section>" de <details> abiertos
};
```

Reglas de reseteo:
- Cambiar de pestaña (`showAdminTab` con otra tab) ⇒ `adminView = 'list'`,
  `adminEditingId = null`.
- Abrir/cerrar el modal de admin ⇒ resetear a `list`.
- El texto de búsqueda **se conserva** por pestaña mientras dura la sesión del
  modal (no se borra al ir y volver del editor).

Las pestañas que **no** son de catálogo (`parameters`, `tiers`, `audit`)
ignoran `adminView` y siguen renderizando como hoy.

## 7. Vista de lista

Una función por entidad: `renderProductsList(cfg, query)`,
`renderPacksList(cfg, query)`, `renderSuppliersList(cfg, query)`,
`renderAddonsList(cfg, query)`. Todas producen la misma estructura mediante un
helper compartido `renderListToolbar()` + filas.

**Estructura:**

```
[ hint de la pestaña, como ahora ]
.admin-search        → input de búsqueda + icono lupa, value = query
.admin-list-count    → "N de M"  (oculto si no hay búsqueda activa)
.admin-list
  .admin-list__row  (data-id, data-search="<haystack>")  × N
  .admin-empty      (solo si 0 resultados: "Sin resultados para «…»")
.admin-row-add       → botón "Añadir <entidad>" (acción existente add-*)
```

**Fila compacta** (`.admin-list__row`): chip de id · nombre/etiqueta ·
meta secundaria (categoría en productos; modo de precio en packs; «en uso» donde
aplique) · botón `[Editar]` · botón `[🗑 eliminar]` (reusa `data-action="remove-*"`
con su lógica de `disabled` por «en uso»). Click en la fila (fuera de los
botones) = Editar.

**Buscador (filtrado en vivo por DOM, sin re-render):**
- Cada fila lleva `data-search` con un *haystack* precomputado:
  `normalizeText(id + ' ' + nombre + ' ' + categoría/meta)`.
- Al teclear, un listener `input` recorre las filas y conmuta la clase
  `.is-hidden` según `haystack.includes(normalizeText(query))`. No re-renderiza
  ⇒ no se pierde el foco ni el cursor.
- Actualiza `.admin-list-count` ("N de M") y muestra `.admin-empty` si N = 0.
- Guarda el texto en `state.adminSearch[tab]` en cada pulsación.
- Tras un re-render estructural (alta/baja), se restaura `value` desde
  `state.adminSearch[tab]` y se re-aplica el filtro.

`normalizeText(s)`: minúsculas + `String(s).normalize('NFD').replace(diacríticos)`
para que «camiseta» encuentre «Camiseta» y se ignoren acentos.

## 8. Vista de editor (maestro-detalle)

Una función por entidad: `renderProductEditor(cfg, id)`,
`renderPackEditor(cfg, id)`, `renderSupplierEditor(cfg, id)`,
`renderAddonEditor(cfg, id)`. **Se extraen del cuerpo del bucle actual** de cada
`renderAdminX` (el HTML del formulario de una entidad ya existe; solo se aísla a
una función que recibe un `id`).

**Estructura:**

```
.admin-editor__head
  [ ← Volver a la lista ]      (botón, data-action o handler dedicado)
  h3  "Editar: <nombre>"  (o "Nuevo <entidad>")
[ formulario de la entidad, a todo el ancho ]
  - Datos básicos: visibles directamente (.admin-grid)
  - Secciones largas envueltas en <details> plegables vía wrapCollapsible():
      · Productos:   "Proveedores", "PVP por caras y tramo"
      · Packs:       "Opciones", "Componentes", "Precios"
      · Proveedores: (formulario corto, sin secciones plegables)
      · Complementos:"Aplica a"
```

**`wrapCollapsible(headerLabel, bodyHtml, { tab, id, section, open })`** genera:

```html
<details class="admin-section" {open}>
  <summary class="admin-section__head">
    <svg caret/> headerLabel
  </summary>
  <div class="admin-section__body"> bodyHtml </div>
</details>
```

- Secciones **abiertas por defecto** (acabas de entrar a editar esa entidad).
- El estado abierto/cerrado se recuerda en `state.adminSections` con la clave
  `"<tab>:<id>:<section>"`; un listener `toggle` lo actualiza y el render
  re-aplica el atributo `open`.
- Marcador nativo oculto (`summary { list-style: none }` +
  `::-webkit-details-marker { display: none }`); el caret SVG rota con
  `[open] > summary`.

**Guardado (sin cambios):**
- Los campos del editor siguen escribiendo en `CFG` en vivo con el cableado
  existente de `data-cfg-path` → `updateConfigFromInput(CFG, input)`.
- Las acciones estructurales del editor (añadir proveedor, añadir opción de
  pack, etc.) usan el `data-action`/`data-action-change` actuales; tras la
  acción se re-renderiza **quedándose en el editor** (`adminView` sigue en
  `'editor'`, `preserveScroll`).
- «← Volver» solo cambia `adminView = 'list'` y re-renderiza. **No** hay
  guardar/cancelar por entidad (no se toca el modelo de persistencia ni la
  comprobación de conflicto — reglas #5/#6).
- El único «Guardar» del pie del modal sigue persistiendo todo el `config`.

## 9. Navegación y flujo

```
showAdminTab(tab):
  si tab ∈ {products, packs, suppliers, addons}:
      si state.adminView === 'editor' && state.adminEditingId existe:
          cont.innerHTML = render<Entity>Editor(CFG, id)
          wireEditor(cont, tab)        # volver, details-toggle, + cableado existente
      si no:
          cont.innerHTML = render<Entity>List(CFG, state.adminSearch[tab])
          wireList(cont, tab)          # buscador, editar, añadir, eliminar
  si no:  # parameters / tiers / audit
      (como hoy)
```

Acciones:
- **Editar** (fila o botón): `adminView='editor'`, `adminEditingId=id`, re-render.
- **Añadir**: ejecuta la acción `add-*` existente (crea la entidad en `CFG` y
  devuelve su id nuevo), luego `adminView='editor'`, `adminEditingId=<nuevo id>`,
  re-render → el editor abre directamente sobre la entidad recién creada.
  - *Requisito:* las funciones `add*` de `admin.js` deben **devolver el id
    creado** (hoy crean con `nextId` pero no lo exponen al llamador). Se añade el
    id al resultado (`{ dirty: true, id }`) para que `app.js` lo use.
- **Eliminar** (en lista): acción `remove-*` existente; permanece en la lista.
- **← Volver**: `adminView='list'`, re-render (la búsqueda se conserva).
- **Cambiar de pestaña**: resetea a lista.

## 10. Modal responsive

En `styles.css`:

- `.modal`: `max-width: min(1380px, 95vw)` (se ensancha en grande, se ajusta en
  pequeño). El alto ya está resuelto (`max-height: calc(100vh - 64px)` +
  `overflow-y: auto` en `.modal__body`).
- `.admin-grid`: de `grid-template-columns: 1fr 1fr` fijo a
  `repeat(auto-fit, minmax(220px, 1fr))` → **más columnas cuanto más ancho** el
  modal; en estrecho colapsa solo. (Aplica también a las sub-rejillas anidadas
  de proveedores/precios, lo cual es deseable.)
- Se conservan y afinan los breakpoints actuales (`880px` nav horizontal,
  `600px` una columna y modal a pantalla completa).
- Filas de lista (`.admin-list__row`): en ≤600px apilan meta y acciones bajo el
  nombre.

## 11. Cambios por archivo

**`renderer/admin.js`**
- Partir cada `renderAdminProducts/Packs/Suppliers/Addons` en:
  `render<Entity>List(cfg, query)` (filas) y `render<Entity>Editor(cfg, id)`
  (una entidad, extraído del cuerpo del bucle actual).
- Helpers nuevos (puros, exportados para test): `normalizeText(s)`,
  `buildHaystack(parts[])`, `renderListToolbar({ tab, query, count, total })`,
  `wrapCollapsible(label, bodyHtml, opts)`.
- `renderAdminTabContent(cfg, tab, view, id)`: enruta a lista o editor para las
  pestañas de catálogo; igual que hoy para el resto.
- Las funciones `add*` devuelven el id creado.

**`renderer/app.js`**
- Extender `state` (§6).
- `showAdminTab`: enrutar list/editor (§9); cablear buscador (filtro DOM),
  Editar/Añadir/Volver y persistencia de `<details>`. Reutilizar el cableado
  existente de `data-cfg-path` / `data-action` / `data-action-change` y
  `enhanceDropdowns(cont)`.
- Resetear `adminView`/`adminEditingId` al cambiar de pestaña y al abrir/cerrar
  el modal.

**`renderer/styles.css`**
- Nuevas clases: `.admin-search`, `.admin-list`, `.admin-list__row`,
  `.admin-list__meta`, `.admin-list-count`, `.admin-empty`,
  `.admin-editor__head`, `.admin-section`, `.admin-section__head/__body`,
  caret, `.is-hidden`.
- Cambios responsive de `.modal` y `.admin-grid` (§10).

**`tests/`** (Vitest, uno por módulo)
- `normalizeText`: minúsculas e insensible a acentos.
- `buildHaystack` / filtro: una query incluye/excluye las entidades correctas.
- `render<Entity>List(cfg, query)`: solo filas que casan; toolbar y contador
  presentes; estado vacío con 0 resultados.
- `render<Entity>Editor(cfg, id)`: saca exactamente una entidad; `<details>`
  refleja `open` según el estado; «Volver» presente.
- `add*` devuelve el id creado.

## 12. Riesgos y casos límite

- **Foco del buscador:** el filtrado por DOM no re-renderiza, así que el cursor
  no se pierde al teclear. Los re-render solo ocurren al pulsar botones, no al
  escribir.
- **Botones dentro de cabeceras plegables:** si algún botón de acción queda
  dentro de un `<summary>`, su handler debe `preventDefault()` para no
  plegar/desplegar al pulsarlo. (En el editor, los botones de acción van en el
  cuerpo, no en el `<summary>`, así que el riesgo es menor.)
- **Crear y salir sin tocar:** «Añadir» crea la entidad inmediatamente (como
  hoy); si el usuario «Vuelve» sin editar, queda una entidad en blanco. Es el
  comportamiento actual; el descarte automático queda como idea (§13).
- **Eliminar la entidad en edición:** desde el editor no se elimina (el botón
  eliminar vive en la lista); no hay estado huérfano.
- **`auto-fit` en rejillas anidadas:** revisar que las tablas de PVP (tramos ×
  caras) se vean bien con muchas columnas en monitores anchos; ajustar el
  `minmax` si hace falta.

## 13. Ideas a largo plazo (no en este alcance)

- Recordar la última pestaña, los plegados y la búsqueda **entre sesiones**.
- Botón «Expandir / plegar todo» en el editor.
- Resaltar las coincidencias del buscador dentro de la fila.
- Atajo `Ctrl/Cmd+F` para enfocar el buscador de la pestaña activa.
- Filtro por categoría y orden de la lista (por nombre, por uso…).
- Búsqueda global entre pestañas.
- Descartar la entidad recién creada si se sale del editor sin tocarla.
- Duplicar producto / pack como punto de partida.
- Virtualización de la lista si crece a cientos de entidades.
