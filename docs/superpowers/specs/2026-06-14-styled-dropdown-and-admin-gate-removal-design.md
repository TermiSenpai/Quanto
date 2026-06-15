# Diseño — Desplegable estilizado + retirada del gate de contraseña admin

**Fecha:** 2026-06-14
**Estado:** aprobado, en implementación
**Ámbito:** renderer (UI). Sin cambios de cálculo ni de schema. Sin dependencias nuevas.

---

## 1. Objetivo

1. **Desplegable estilizado reutilizable** que sustituya, en toda la app, el
   panel desplegado **nativo** de Windows/Chromium de los `<select>` (que rompe
   la estética moderna), manteniendo una estética coherente con el sistema de
   diseño.
2. **Quitar la contraseña de admin** del modo archivo, completando la dirección
   ya documentada para v5 ("v5 removes the gate", CLAUDE.md §9 / UI-UX §2.5).

Ambas cosas afectan solo al renderer; ninguna toca cálculo, schema ni
persistencia, así que no requiere migración ni tests de cálculo (regla §7).

## 2. Parte A — Desplegable estilizado

### Enfoque: mejora progresiva sobre el `<select>` nativo

El `<select>` nativo **permanece en el DOM como fuente de verdad** (oculto). Se
monta encima una UI custom (botón disparador + panel propio `role="listbox"`).
Al elegir opción se escribe `select.value` y se dispara un `change` nativo
(`bubbles: true`).

**Por qué.** Todo el binding actual lee `.value` y/o escucha `change`:
`[data-cfg-path]` ([app.js:2476]), `[data-action-change]` ([app.js:2503],
lee `ctrl.value`), `[data-linea-modelo]` ([app.js:1752], change delegado en
`step2` [app.js:1792]) y la cuenta cloud ([app.js:480]). Manteniendo el mismo
elemento `<select>`, **ese binding sigue intacto: cero reescrituras**. La
alternativa (reemplazar selects por divs) obligaría a rehacer todo ese binding
genérico — descartada por diff y riesgo.

### Componente: `renderer/dropdown.js` (módulo ES, inglés)

API mínima:

- `enhanceDropdowns(root = document)` — por cada `<select>` dentro de `root` no
  marcado y no `[data-no-dropdown]` (y no `multiple`):
  - lo marca (`dataset.ppEnhanced`), lo envuelve en `.pp-select`, lo oculta
    (visualmente, `tabindex=-1`) conservándolo en el DOM;
  - crea trigger `<button aria-haspopup="listbox" aria-expanded>` con etiqueta +
    caret, y panel `<div role="listbox">` con un `role="option"` por `<option>`;
  - selección → `select.value = v` + `dispatchEvent(new Event('change',{bubbles:true}))`
    + actualiza etiqueta/seleccionado + cierra + devuelve foco al trigger;
  - teclado: ↑↓ Home/End para resaltar, Enter/Espacio selecciona, Esc cierra,
    type-ahead por inicial; refleja `disabled`;
  - un único panel abierto a la vez; cierre por click-fuera / Esc (listeners
    globales, registrados una vez); idempotente y defensivo si el DOM se
    reemplaza (admin re-render).

Sin librerías, sin assets nuevos (caret SVG inline, como el actual
[styles.css:303]).

### CSS (`renderer/styles.css`)

Clases `.pp-select`, `.pp-select__trigger`, `.pp-select__panel`,
`.pp-select__option` usando tokens existentes (`--surface-secondary`,
`--border-strong/subtle`, `--radius-md`, `--shadow-modal`, `--accent-*`,
`--fg-*`). El trigger replica el aspecto cerrado actual de `select.input`;
el panel añade hover/seleccionado/resaltado y una animación sutil de apertura.
`max-height` con scroll; se voltea hacia arriba si no cabe debajo.

### Puntos de enhancement (explícitos, sin MutationObserver)

1. `showAdminTab`, tras `cont.innerHTML = …` → `enhanceDropdowns(cont)`.
2. Render de línea personalizada, tras construir el nodo → `enhanceDropdowns(wrap)`.
3. Poblado de `cloud-account` (wizard) tras fijar su `innerHTML`.

No hay `<select>` estáticos en `index.html` salvo `cloud-account` (vacío hasta
poblarse), así que no hace falta barrido global en carga.

## 3. Parte B — Quitar la contraseña de admin

### Cambios en el renderer (gate fuera por completo)

- `openAdmin` ([app.js:2339]): abre el editor directamente (como ya hace el
  modo cloud), unificando ambos modos. Pone `state.isAdmin = true` y el rótulo
  "Admin activo" del toggle; elimina la rama `show('admin-login')`/foco.
- Eliminar `adminLogin()` ([app.js:2367]) y los listeners de `btn-admin-login`
  y `admin-clave` ([app.js:1074-1077]).
- `closeAdmin`/`showAdminEditor`: quitar referencias a `admin-login`,
  `admin-login-error`, `admin-clave`.
- `index.html`: eliminar el bloque `#admin-login` (input de clave + error).

`state.isAdmin` se conserva (controla la vista de costes internos, [app.js:1987]).

### Boundary (lo que NO se toca ahora)

`verifyAdminPassword` (main) y el campo `admin_password` del schema quedan como
**código muerto inocuo**. Arrancarlos exige migración + tests de schema (reglas
§5/§7) y pertenece al "nuevo plan WIP" de retirada de contraseña. Así este
cambio se mantiene enfocado en UI y no abre una migración a medias.

## 4. Verificación

- `pnpm test` verde (sin cambios de cálculo/schema; no hay infra jsdom para
  tests de DOM — `vitest.config.js` usa `environment: 'node'`).
- Smoke `pnpm dev`: desplegable Producto en presupuesto; abrir admin **sin
  pedir contraseña** con sus selectores de proveedor/modo/producto; cuenta en
  el wizard cloud; teclado y click-fuera del desplegable.

[app.js:2476]: ../../../renderer/app.js
[app.js:2503]: ../../../renderer/app.js
[app.js:1752]: ../../../renderer/app.js
[app.js:1792]: ../../../renderer/app.js
[app.js:480]: ../../../renderer/app.js
[app.js:303]: ../../../renderer/styles.css
[app.js:2339]: ../../../renderer/app.js
[app.js:2367]: ../../../renderer/app.js
[app.js:1074-1077]: ../../../renderer/app.js
[app.js:1987]: ../../../renderer/app.js
