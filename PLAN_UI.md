# PLAN_UI.md — Quanto

Plan de implementación para llevar el diseño de `pencil-new.pen` a la app
Electron real (`renderer/index.html` + `renderer/styles.css` + JS de soporte).

> Fuente visual: `pencil-new.pen` — frame raíz `GoRl1` "Quanto — UI/UX".
> Fuente funcional: `PLAN_Calculadora.md`. Reglas de código: `CLAUDE.md`.

Objetivo: una UI de escritorio en modo claro, con paleta gris-azulada y
acento azul, con jerarquía visual clara, datos numéricos en mono, y
versión mobile a 390 px. **Sin frameworks, sin build step**: HTML +
CSS + JS vanilla, como exige `CLAUDE.md` §3.

---

## 1. Estado actual vs. objetivo

| Pieza | Hoy | Objetivo (Pencil) |
|---|---|---|
| Paleta | gris-slate neutro (`--accent: #475569`) | azul `#3D7BD9` con superficies blancas e "inverse" `#0F1A2B` |
| Tipografía | system-ui sans + monoespacio del sistema | **Inter** body/heading + **Geist Mono** para datos |
| Bienvenida | tarjeta única centrada | split 560 px hero oscuro a la izq. + formulario a la der. con stats al pie |
| Topbar | una línea con `btn-link` planos | brand icon + separador + info usuario + botones agrupados con `Admin` outline |
| Selección de pack | grid `repeat(auto-fit, 220px)` simple | grid 3×2 de `PackCard` con icono, flecha, "desde X €", estado seleccionado en `surface-inverse` |
| Datos del pedido | una sola columna con `card`s apiladas | 2 columnas: principal (config) + lateral 340 px (precio en vivo `surface-inverse` + indicador de tramo) |
| Resultado | tabla `resultado-tabla` y bloque admin | hero oscuro grande + tarjeta lateral "Próximos pasos" + breakdown 2 col + composición |
| Modal admin | tabs horizontales | modal 920 px con **sidebar nav** vertical (200 px) + warn banner amarillo + footer fijo |
| Modal ajustes | igual al admin | modal 620 px compacto con hint, dos campos y bloque "Preferencias" con toggles |
| Mobile | media query a 600 px que cambia grid | 3 pantallas dedicadas a 390 px: selección, datos, resultado, con CTA full-width fijos |

---

## 2. Design tokens → CSS variables

Sobreescribir `:root` en `renderer/styles.css`. Mapping 1:1 desde
`get_variables` del `.pen`:

```css
:root {
  /* Superficies */
  --surface-primary:        #F1F4F8;  /* fondo página */
  --surface-secondary:      #FFFFFF;  /* tarjetas, modales */
  --surface-tertiary:       #F7F9FC;  /* footer modal, sutil */
  --surface-inverse:        #0F1A2B;  /* hero/precio en vivo */
  --surface-inverse-soft:   #1A2740;  /* badge sobre fondo oscuro */

  /* Foreground */
  --fg-primary:        #0F1A2B;
  --fg-secondary:      #5A6478;
  --fg-muted:          #8E97AB;
  --fg-inverse:        #FFFFFF;
  --fg-inverse-muted:  #A6B0C2;

  /* Bordes */
  --border-subtle:  #E4E9F2;
  --border-strong:  #CDD5E2;

  /* Acento */
  --accent-primary:        #3D7BD9;
  --accent-primary-hover:  #2E63B8;
  --accent-soft:           #E4EEFC;  /* bg de badge/hint */
  --accent-text-on-soft:   #1F4FA3;  /* texto sobre accent-soft */

  /* Estado */
  --success: #1FA86A; --success-soft: #E1F5EB;
  --warning: #D98A1F; --warning-soft: #FBEFD9;
  --danger:  #D24D4D; --danger-soft:  #FBE6E6;

  /* Radios */
  --radius-sm:   8px;
  --radius-md:  12px;
  --radius-lg:  16px;
  --radius-xl:  20px;
  --radius-pill: 9999px;

  /* Sombras (de los frames screen) */
  --shadow-card:   0 8px 32px rgba(15, 26, 43, 0.08);
  --shadow-modal:  0 24px 64px rgba(15, 26, 43, 0.20);

  /* Tipografía */
  --font-body:  "Inter", -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-data:  "Geist Mono", ui-monospace, "SF Mono", Consolas, monospace;
}
```

**Decisión sobre fuentes**: empaquetar Inter (Regular/600/700) y Geist Mono
(Regular/500/700) como `.woff2` en `renderer/fonts/` con `@font-face`. Motivo:
sin red, no podemos tirar de Google Fonts. Suma ~150 KB al `.exe`. Si se
prefiere no añadir dependencia binaria, dejar fallback al stack del sistema
(documentar en commit).

---

## 3. Componentes reutilizables → clases CSS

Mapeo de los 9 componentes del `.pen` a clases. Convención BEM ligera, ya
establecida en el repo.

| Pencil | Clase | Notas |
|---|---|---|
| `Component/Button/Primary` | `.btn-primary` (refactor) | fondo `--accent-primary`, padding 12/20, radius `--radius-md`, gap 8 con icono |
| `Component/Button/Secondary` | `.btn-secondary` (refactor) | fondo `--surface-secondary`, stroke `--border-strong`, padding 12/20 |
| `Component/Button/Ghost` | `.btn-ghost` (nuevo) | sin fondo, padding 10/14, gap 6, hover sutil |
| `Component/Input` | `.field` (nuevo, reemplaza `<label class="full-label">`) | wrapper vertical: label 12 px `--fg-secondary` + input + opcional hint |
| `Component/NumberStep` | `.numstep` (nuevo) | `− [valor] +` con dos botones cuadrados, valor mono centrado |
| `Component/Badge` | `.badge` (nuevo) | radius-pill, padding 4/10, gap 6, variantes `.badge--accent`, `.badge--warn`, `.badge--success` |
| `Component/PackCard` | `.pack-card` (refactor de `.pack-option`) | radius-lg, padding 24, icono 40 px arriba, título 18, descripción 13 muted, "Desde X,XX €" en `.badge`, flecha esquina sup. der. Estado seleccionado: `surface-inverse` + `fg-inverse` |
| `Component/Tabs` | `.tabs` (refactor de `.admin-tabs`) | radius-md, padding 4, fondo `--surface-primary`. Tab activo = `--surface-secondary` con sombra leve |
| `Component/StatTile` | `.stat-tile` (nuevo) | radius-lg, padding 24, etiqueta 12 muted + valor 28 mono |

Otros bloques compuestos (no son `reusable` en el `.pen` pero los usamos
muchas veces):

- `.app-shell`: viewport con grid `topbar / body / footer` y radius-xl + sombra (en mobile y windowed mode no se ven los bordes; en escritorio se ven al hacer la ventana más pequeña).
- `.split` (bienvenida): grid 2 cols `560px 1fr`, colapsa a 1 col bajo 900 px.
- `.section-card`: radius-lg, padding 24-32, stroke `--border-subtle`. Usado en `hCard`, `tallasCard`, `breakdownCard`, etc.
- `.dark-card`: variante con `surface-inverse` + `fg-inverse` (precio en vivo, hero del resultado).
- `.kicker`: badge encima de un H1 ("Primer arranque", "Cálculo guardado · Tramo T1").

---

## 4. Pantalla por pantalla

### 4.1. `pantalla-bienvenida` (Pencil: `M6JBD` / `V1Xta`)

Markup objetivo:

```html
<section id="pantalla-bienvenida" class="pantalla split hidden">
  <aside class="split-left dark-pane">
    <div class="brand brand--inverse">…icono + "Quanto"…</div>
    <div class="hero">
      <span class="badge badge--inverse">Primer arranque</span>
      <h1>Calcula precios de packs DTF en segundos.</h1>
      <p class="lead">Configuración compartida desde tu NAS…</p>
    </div>
    <div class="hero-stats">
      <div class="stat"><strong>4</strong><span>Tipos de pack</span></div>
      <div class="stat"><strong>3</strong><span>Modelos Roly</span></div>
      <div class="stat"><strong>4</strong><span>Tramos por volumen</span></div>
    </div>
  </aside>
  <main class="split-right">
    <header><h2>Empezar</h2><p>Indica tu nombre y la ruta del config…</p></header>
    <form class="form-stack">
      <div class="field">…Tu nombre…</div>
      <div class="field">…Archivo de configuración…</div>
      <p class="hint hint--info">Si el archivo no existe, Quanto puede crearlo…</p>
    </form>
    <footer class="actions actions--split">
      <a class="link-muted" href="#">¿Necesitas ayuda? Contacta con tu administrador</a>
      <button id="btn-bv-empezar" class="btn-primary">Empezar →</button>
    </footer>
  </main>
</section>
```

CSS clave:
- `.split { display: grid; grid-template-columns: 560px 1fr; min-height: 100vh; }`
- `.dark-pane { background: var(--surface-inverse); color: var(--fg-inverse); padding: 80px 72px; display: flex; flex-direction: column; justify-content: space-between; }`
- `.hero h1 { font-size: 42px; line-height: 1.15; letter-spacing: -0.5px; }`
- Bajo 900 px → 1 columna (la columna oscura pasa a ser un banner reducido encima del formulario, con menos padding).

### 4.2. Topbar + footer de la app (`PlDb9`/`Topbar` y `Footer`)

Topbar (objetivo, reemplaza `header.topbar`):

```
[icono 32 cuadrado dark] Quanto  | Calculadora de packs   ·  👤 Alberto · ⏱ Config 28/4 · v2.0.0   ·  ↻ Recargar | ⚙ Ajustes | [🔒 Admin]
```

- Brand wrap: icono `surface-inverse` + título 16/700 + separador vertical 1×18 `--border-strong` + tagline 13 muted.
- Info wrap: dos chips `userInfo` y `cfgInfo` en gris.
- Actions wrap: dos `.btn-ghost` (Recargar, Ajustes) + un `.btn-secondary` (Admin) con borde `--border-strong` y candado.
- En mobile (≤ 600 px): topbar mobile (`acSuh/wNwfI`): solo brand izquierda + dos botones cuadrados 36×36 a la derecha (recargar, menú). El nombre/cfg se mueve a la primera tarjeta del body (`mUserCard`).

Footer:
- Texto izquierda: `v2.0.0` (Geist Mono 11) · "Modificado por Alberto" · "Quanto · uso interno taller".
- Punto verde + "NAS conectado" a la derecha. Si offline → punto rojo + "NAS desconectado", reusando estilo `--danger`.

### 4.3. Selección de pack (`PlDb9` / `ldkkG`)

Layout:
1. **Hero row**: H1 "¿Qué tipo de pack vas a calcular?" + sublinea, breadcrumb "PASO 1 DE 3" en chip ghost a la derecha + badge "Si tienes presupuesto guardado".
2. **PackGrid**: 2 filas × 3 cols (gap 16) de `.pack-card`:
   - Pack peña completa (seleccionado por defecto, **dark-card**)
   - Solo camisetas
   - Solo sudaderas
   - Sudaderas mixto
   - Pack sin capucha
   - Pack personalizado (estado **disabled** con badge "En desarrollo")

`PackCard` tiene 4 estados: `default`, `:hover`, `.is-selected` (dark-card), `.is-disabled`. Los renderizamos por dataset desde `app.js` igual que hoy, pero con plantilla nueva:

```html
<button class="pack-card" data-pack-id="pena_completa">
  <span class="pack-card__icon">…icon…</span>
  <span class="pack-card__arrow">→</span>
  <span class="pack-card__title">Pack peña completa</span>
  <span class="pack-card__desc">Camiseta + sudadera por persona.…</span>
  <span class="badge badge--accent">Desde 25,95 €</span>
</button>
```

### 4.4. Datos del pedido (`ZNFEb` / `oJTkF`)

Layout 2 columnas:
- **mainCol** (`fill_container`):
  - Back row "← Cambiar pack" + breadcrumb "PASO 2 DE 3".
  - **`.section-card` hCard**: header con icono + título + tagline + botón "Cambiar"; luego `inputs-pack` (cantidad, NumberStep), grid 1-3 con caras camiseta/sudadera (radio cards), y selector de modelo (3 tarjetas CLASICA/URBAN/BEAGLE con radio).
  - **`.section-card` tallasCard**: dos `NumberStep` (4XL, 5XL+) + chip warning "Recargo directo al cliente" arriba a la derecha.
  - Actions row: `Reiniciar` (ghost) + `Calcular precio →` (primary).
- **sideCol** (340 px fijo):
  - Spacer 40 px (alinea con la primera card).
  - **`.dark-card` sideCard**: badge "Vista previa en vivo" + chip "Tramo T1" arriba der.; precio mono 48 px; meta 12 packs · 25,95 € por pack; bloque de 4 filas: Camisetas, Sudaderas, Recargos, IVA(21%) con `Geist Mono`.
  - **`.section-card` tramoCard**: "Volumen y siguiente tramo" + barra horizontal segmentada (5 tramos) + tip "Si llegas a X packs el PVP baja a Y…".

Comportamiento:
- La tarjeta lateral oscura **se actualiza al cambiar cualquier input** (debounce 50 ms). Hoy el cálculo solo ocurre al pulsar "Calcular"; pasamos a un cálculo "preview" en cada `input` event que rellena la card lateral, pero **el resultado final** sigue requiriendo el botón.
- En ≤ 1024 px el sideCol se mueve **debajo** del mainCol (no encima del fold) y deja de ser sticky.
- En ≤ 600 px se simplifica: la dark-card vuelve a tener el comportamiento actual de "preview pequeño" arriba del CTA, y el tramoCard se oculta tras un `<details>`.

### 4.5. Resultado (`pYcQT` / `mtz3p`)

Layout:
- Back row con `← Editar pedido` + chips a la derecha "📋 Copiar resumen" + `📤 Exportar PDF` (primary outline).
- **heroResult** (2 cols):
  - **heroResultBig dark-card**: kicker "Cálculo guardado · Tramo T1", sub "Total a facturar", número grande **376,93 €** (Geist Mono 64), pista "con 21% IVA", grid de 4 stats (Packs · PVP por pack · Tiempo estimado · Margen bruto en `--success`).
  - **heroResultSide section-card** (340 px): "Próximos pasos" con 3 acciones (Programar producción / Enviar al cliente / Nuevo cálculo) como filas con icono + flecha.
- **resultGrid** (2 cols):
  - **breakdownCard**: tabla 4 cols (CONCEPTO · UD · CANT · SUBTOTAL) con filas zebra y línea final "TOTAL A FACTURAR" en negrita.
  - **infoCard** (340 px): "Composición del pedido" con barra apilada de tallas + lista de meta (Pack, Modelo, Caras, Tramo).

Reutiliza la lógica de cálculo existente. Cambia solo el render del `#resultado-content`. El callsite en `app.js` ya recibe `totales` — el nuevo template es una función `renderResultado(totales, contexto)` que devuelve HTML.

### 4.6. Modal admin (`Cl94e`)

Cambios estructurales respecto al actual:
- Modal **920 px** (no 720), `--shadow-modal`.
- Tabs **verticales** en sidebar de 200 px (en vez de horizontales). Items: Parámetros · Modelos Roly · Tramos por volumen · Packs (PVP) · Clave admin.
- Banner amarillo `--warning-soft` con icono `triangle-alert` justo bajo el header: "Los demás usuarios verán los cambios al pulsar Recargar config. Se hace backup automático antes de cada escritura."
- Footer fijo `--surface-tertiary` con info izquierda "Última escritura 28/4 10:32 por Alberto · backup nº147" + botones derecha (`Cancelar cambios` ghost + `Guardar en NAS` primary con icono).
- Pestaña **Parámetros**: 2 cols de inputs (MO €/h, IVA, Merma %, Recargo 4XL, Recargo 5XL, Buffer 3XL+) y debajo un mini-bar-chart "Resumen visual del impacto" Antes / Después.
- Pestaña **Tramos por volumen**: bar chart con los 4 tramos coloreados.
- En mobile: la sidebar pasa a `<select>` arriba.

### 4.7. Modal ajustes locales (`ye1zM`)

Modal **620 px** simplificado:
- Header: icono + "Ajustes locales" + sub "Solo afectan a este PC".
- Hint info: `accent-soft` "Guardado en %APPDATA%\Quanto\settings.json. No se sincroniza con el NAS."
- Field "Tu nombre" con hint mostrando "Aparecerás como modificador en cada cambio admin que escribas en config".
- Field "Archivo de configuración" con botón "Cambiar..." y badge **success** "Conectado v2.0.0 · 28/4 15:32".
- Bloque "Preferencias" con dos toggles:
  - "Recordar último pack abierto" (on por defecto, persistente en settings).
  - "Mostrar IVA en pantalla" (off por defecto). _Nuevo flag, requiere extender `settings.json`._
- Footer: `Cancelar` + `Guardar y recargar` primary.

### 4.8. Mobile (`acSuh`, `dg0Kt`, `eO9vI`)

Breakpoint principal: **≤ 600 px**. Cambios de fondo:
- Topbar reducida (44 px alta) con solo brand + dos botones cuadrados.
- Las tres pantallas de mobile son las mismas, **no son rutas separadas**: el mismo HTML responde a media queries y muestra/oculta lo que sobra.
- Selección de pack: lista vertical de cards a ancho completo, con icono y flecha. Pack seleccionado en dark-card como en desktop.
- Datos del pedido en mobile: dark-card de preview **arriba**, luego una sola section-card colapsable con el form, CTA fijo abajo (`position: sticky; bottom: 0`).
- Resultado en mobile: dark-card hero con valor grande, debajo "Desglose" colapsado por defecto con `<details>` ("Ver detalle"), y dos CTAs apilados: Exportar PDF (primary) + Nuevo cálculo (secondary).

---

## 5. Responsive: breakpoints

| Bp | Trigger | Comportamiento |
|---|---|---|
| `≥ 1280` | desktop estándar | layouts del Pencil tal cual |
| `1024–1279` | laptop estrecha | `sideCol` baja debajo de `mainCol` en pantalla 03 y 04; PackGrid sigue 3 cols |
| `768–1023` | tablet | PackGrid 2 cols; modal admin con sidebar fija pero 720 px ancho; topbar mantiene 3 grupos |
| `600–767` | tablet pequeña | topbar wrappea info abajo; PackGrid 2 cols; resultado en 1 col |
| `< 600` | mobile | layouts mobile descritos en §4.8 |

Implementación: media queries en orden mobile-first **no**. El proyecto es
desktop-first como hoy; añadimos overrides en `@media (max-width: 1023px)`,
`@media (max-width: 767px)` y `@media (max-width: 599px)`.

---

## 6. Cambios concretos en archivos

| Archivo | Cambio |
|---|---|
| `renderer/styles.css` | Reescritura grande: tokens nuevos, componentes nuevos, layout split, dark-card, modal sidebar. ~+400 líneas, manteniendo la estructura por secciones. |
| `renderer/index.html` | Reestructurar las 4 pantallas + 2 modales con el markup descrito. Mantener mismos `id`s donde el JS los necesita (`bv-nombre`, `seccion-paso2`, `resultado-content`, `admin-overlay`, etc.) y añadir nuevos para el sidebar admin. |
| `renderer/app.js` | (a) Añadir handler "preview en vivo" (debounce 50 ms) que llama a `calcularPackXxx` en cada cambio y rellena la dark-card lateral. (b) Cambiar el renderer del resultado a la plantilla nueva. (c) Adaptar el toggle del admin (sidebar en lugar de tabs horizontales). |
| `renderer/admin.js` | Renombrar/ajustar `renderAdminTabContent` para los nuevos paneles (parámetros con minigráfico, tramos con bar chart). El bar chart se hace con divs CSS, sin librería. |
| `renderer/calculo.js` | Sin cambios funcionales. Exponer `calcularPreview(packId, inputs, cfg)` que devuelve `{ pvp, total, tramo, deltaSiguienteTramo }` para alimentar la card en vivo. |
| `renderer/format.js` | Añadir `fmtMoneyMono(n)` que formatea con espacio fino antes del €, alineado a la derecha y con ancho fijo de glifo. |
| `renderer/fonts/` (nuevo) | Inter y Geist Mono `.woff2` con sus `@font-face` en `styles.css`. _Decisión a confirmar antes de Fase 1._ |
| `main.js` | Sin cambios obligatorios. Si añadimos el flag "mostrar_iva", extender `settings.json` schema (no rompe nada: campo opcional). |
| `config.default.js` | Sin cambios. |

---

## 7. Orden de implementación (commits)

Cada fase es un commit autocontenido y desplegable. Después de cada
fase se hace `npm run dev` y se verifica visualmente.

1. **chore: tokens y tipografía** — vars CSS nuevas, `@font-face`, normalizar reset. Verifica: nada se rompe con la app actual, solo cambia la paleta a azul.
2. **feat: componentes base** — `.btn-*`, `.field`, `.numstep`, `.badge`, `.tabs` refactor. Las pantallas existentes los heredan.
3. **feat(ui): pantalla de bienvenida split** — replantilla `#pantalla-bienvenida` con split + hero stats. Smoke test: borrar `%APPDATA%\Quanto\` y entrar.
4. **feat(ui): topbar + footer de la app** — branding nuevo, info usuario+cfg, footer con estado NAS.
5. **feat(ui): selección de pack** — `.pack-card` en grid 3×2 con estados, dark-card seleccionado, breadcrumb, badge "Desde X €".
6. **feat(ui): datos del pedido (2 cols + preview en vivo)** — layout split con sideCol dark + tramoCard. Conectar `calcularPreview`.
7. **feat(ui): resultado** — hero dark + breakdown + composición. Reemplaza `resultado-tabla`.
8. **feat(ui): modal admin con sidebar** — sidebar nav, warn banner, footer fijo. Refactor de `renderAdminTabContent` a los paneles nuevos. Mantener test de flujo admin.
9. **feat(ui): modal ajustes locales** — modal 620 px, hint, toggles. Si se añade flag "mostrar_iva", actualizar `settings.json` y `PLAN_Calculadora.md`.
10. **feat(ui): mobile** — media queries y comportamientos de §4.8. Probar en DevTools 390 px.
11. **chore: pulido y QA final** — micro-anims (`transition` en hover de cards), focus rings accesibles, ajustes de contraste, snapshot de las 4 pantallas y comparar con el `.pen`.

---

## 8. QA antes de release

Antes de cortar release, ejecutar los casos del `CLAUDE.md` §8 + estos:

- **Tipografía**: Inter cargada (no system fallback) → comparar pantalla 03 contra `ZNFEb` exportado a PNG.
- **Contraste**: el azul `#3D7BD9` sobre `--surface-secondary` cumple AA para texto 14+ (lo cumple, ratio 4.85). Los chips en dark-card también.
- **Responsive**: en 600 px y 390 px no hay scroll horizontal en ninguna pantalla.
- **Estado seleccionado** en `pack-card` accesible por teclado (focus-visible con anillo `--accent-primary`).
- **Modal admin sin scroll molesto**: 920 px modal, sidebar fija, formulario con su propio overflow.
- **Dark-card en mobile**: el precio grande (48 px) **no** desborda en 390 px (mín. 320 px de ancho dejando padding).
- **Conflicto admin**: editar config a mano mientras admin está abierto sigue mostrando el aviso (no cambia el flujo, solo su look).

---

## 9. Riesgos y decisiones abiertas

1. **Empaquetar fuentes**: añadir Inter + Geist Mono suma ~150 KB y dos archivos al `renderer/`. Alternativa: usar `system-ui` y `ui-monospace`. Decisión: empaquetar, porque la diferencia visual con Inter es notable (los números son la información clave de la app).
2. **Bar charts en admin** (parámetros y tramos): usar divs con `height` calculado en JS, sin librería. Si más adelante se quieren tendencias o ejes, evaluar [chart.css](https://chartscss.org/) (CSS puro) antes de meter Chart.js.
3. **Flag "mostrar_iva"**: requiere extender `settings.json`. Cabe en este sprint, pero documentar en `PLAN_Calculadora.md` §"Decisiones".
4. **Animaciones**: limitar a `transition: background-color 0.15s, border-color 0.15s, transform 0.05s` ya presentes. No se añade Motion ni similar.
5. **Iconos**: el `.pen` usa Lucide (`triangle-alert`, `chevron-left`, `share`, `pencil`, `calculator`, `package`, etc.). Hoy el HTML usa emojis. Decisión: mantener emojis donde funcionan (✕, ↻, ⚙, 🔒) e introducir SVGs inline solo para los iconos de pack y los de la dark-card lateral, para preservar el carácter "interno y simple" sin meter una dependencia de iconfont.

---

## 10. Estimación

| Fase | Esfuerzo |
|---|---|
| 1. Tokens + tipografía | 1 h |
| 2. Componentes base | 2 h |
| 3. Bienvenida | 1.5 h |
| 4. Topbar + footer | 1 h |
| 5. Selección de pack | 1.5 h |
| 6. Datos del pedido (2 cols + preview en vivo) | 3 h |
| 7. Resultado | 2 h |
| 8. Modal admin | 2.5 h |
| 9. Modal ajustes locales | 1 h |
| 10. Mobile | 2 h |
| 11. Pulido y QA | 1.5 h |
| **Total** | **~19 h** |

Repartible en 4–5 sesiones de trabajo. Cada fase queda *shippeable*: si
hay que parar a mitad, las fases 1–5 ya entregan una mejora visible
sobre lo actual sin romper flujo.

---

*Última actualización: 2026-04-28. Mantener sincronizado con `pencil-new.pen` — si cambia un componente o pantalla, actualizar la sección correspondiente.*
