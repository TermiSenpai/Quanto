# UI-UX — Quanto

**Versión:** 1.0 · **Fecha:** 2026-06-12
**Relacionados:** `docs/PRD.md`, `renderer/styles.css` (fuente de verdad de los
tokens), `devlog/06-sistema-de-diseno/` (historia del sistema de diseño),
`planes/v5-cloud-sync.md` (plan técnico de los estados nuevos).

> Parte 1: el sistema de diseño **vigente** (documenta lo que ya existe en
> `styles.css` e `index.html`). Parte 2: los **estados nuevos de la v5 cloud**
> (diseño aprobado, pendiente de implementar). Si tocas un token o un patrón,
> actualiza este documento en el mismo cambio.

---

## Parte 1 — Sistema de diseño vigente

### 1.1 Principios

1. **El precio es el protagonista.** Números grandes, en `--font-data`
   (Geist Mono), siempre con dos decimales y símbolo €.
2. **Cero ambigüedad de estado.** Cada pantalla dice en qué paso estás y qué
   datos estás usando. Los errores se muestran, nunca se silencian.
3. **Velocidad de mostrador.** Un presupuesto típico en <1 minuto y el mínimo
   de clics; preview en vivo mientras se introducen cantidades.
4. **Sin modas.** Modo claro único, paleta sobria gris-azulada, sin
   animaciones decorativas. La app debe parecer igual de seria en 2030.

### 1.2 Tokens (resumen — la fuente de verdad es `:root` en `styles.css`)

| Grupo | Tokens clave |
|---|---|
| Superficies | `--surface-primary #F1F4F8` (fondo app), `--surface-secondary #FFFFFF` (cards), `--surface-tertiary #F7F9FC`, `--surface-inverse #0F1A2B` (hero/bienvenida) |
| Texto | `--fg-primary #0F1A2B`, `--fg-secondary #5A6478`, `--fg-muted #8E97AB` |
| Acento | `--accent-primary #3D7BD9` (+ hover `#2E63B8`, soft `#E4EEFC`) |
| Estado | `--success #1FA86A`, `--warning #D98A1F`, `--danger #D24D4D` — cada uno con su variante `-soft` para fondos |
| Radios | `--radius-sm 8` · `md 12` · `lg 16` · `xl 20` · `pill` |
| Sombras | `--shadow-card` (sutil), `--shadow-modal` |
| Tipografía | `--font-body` Inter (UI), `--font-data` Geist Mono (números, precios, ids) |
| Layout | `--topbar-h 64px`, `--content-max 1200px` |
| Paleta de packs | `--pack-color-1…6` para diferenciar packs/modelos de un vistazo en admin |

Reglas: **ningún color hardcodeado fuera de `:root`**; los estados usan siempre
el par color/`-soft` (texto fuerte sobre fondo suave); BEM-lite, sin
frameworks utility-first.

### 1.3 Componentes existentes

Botones (primario / secundario / peligro / fantasma), campos de formulario,
stepper numérico (`numstep`), badges de estado, tabs, cards de pack (con color
identificador), topbar, modal lateral de admin, modal de ajustes locales,
diálogos nativos de Electron para errores y conflictos.

### 1.4 Pantallas y flujo

```
Bienvenida (split, hero oscuro)
   └► Paso 1: selección de pack (cards con color e icono)
        └► Paso 2: datos del pedido (formulario + preview en vivo en columna lateral)
             └► Resultado (precio grande, desglose, margen, PDF, guardar en historial)
Transversales: modo admin (modal lateral, edición por data-cfg-path),
               historial de presupuestos, ajustes locales.
```

Convenciones: ids HTML en kebab-case; pantallas alternadas vía clase
`.hidden`; textos de usuario **siempre en español**.

---

## Parte 2 — Estados nuevos (v5 cloud)

La v5 introduce un hecho nuevo que la UI debe comunicar: **los datos pueden no
estar frescos**. Cuatro elementos nuevos, todos construidos con tokens y
componentes existentes — no se añade ningún patrón visual nuevo.

### 2.0 Asistente de primer arranque

Sustituye al arranque actual cuando no hay origen de datos configurado.
Pantalla única, dos cards grandes — «¿Dónde guardamos tus datos?»:

- **Local** — «En este equipo o en una carpeta de red (NAS)». Selector de
  ruta y listo (modo archivo actual).
- **Nube** — «En tu cuenta de Cloudflare (gratis), accesible desde todos tus
  equipos». Flujo guiado de 3 pasos con barra de progreso:
  1. «¿Tienes cuenta de Cloudflare?» → botón que abre el registro en el
     navegador si no.
  2. «Crea tu clave de acceso» → botón que abre la página del token con la
     plantilla pre-rellenada + campo para pegarlo (validación inmediata:
     la app comprueba el token contra la API antes de continuar).
  3. Automático, con spinner y mensajes de progreso: «Buscando tu base de
     datos…» → si existe: «Encontrada — conectando» (segundo PC); si no:
     «Creando tu base de datos…» (primer PC). Sin preguntas técnicas.

Errores siempre en lenguaje llano («Esa clave no funciona — vuelve a
copiarla») con reintento, nunca códigos HTTP.

**Migración de esquema** (tras actualizar la app): pantalla bloqueante breve
«Actualizando tu base de datos — no cierres la aplicación» con progreso; si
falla, pantalla de error con botón **«Restaurar copia de seguridad»** y la app
no escribe nada más (plan v5 §6).

### 2.0b Asistente de catálogo (catálogo en blanco)

No hay catálogo por defecto. Cuando el almacén está listo pero **vacío** (modo
archivo sin `config.js` en la ruta elegida, o nube con D1 recién aprovisionada),
arranca un asistente dedicado (pantalla `#catalog-wizard`) que construye el
catálogo **desde cero**. Se lanza desde el primer arranque local, el éxito del
aprovisionamiento en nube, el flujo de «cambiar ubicación» de ajustes (carpeta
nueva vacía) y el botón de recuperación de la pantalla de error (reetiquetado
**«Configurar catálogo»**).

**Chrome de pasos:** barra de progreso con los 7 pasos en orden + botones
`Atrás` / `Siguiente` (y `Finalizar` en el último). El orden lo imponen las
dependencias (los packs necesitan tramos y productos):

| # | Paso | Mínimo para avanzar |
|---|---|---|
| 1 | **Costes** | todos los parámetros rellenos y numéricos (≥ 0) |
| 2 | **Tramos** | ≥ 1 tramo |
| 3 | **Proveedores** | ≥ 1 proveedor |
| 4 | **Productos** | ≥ 1 producto |
| 5 | **Packs** | ≥ 1 pack |
| 6 | **Complementos** *(opcional)* | puede quedar vacío |
| 7 | **Empresa** *(opcional)* | puede quedar vacío |

- **Todo en blanco:** cada campo arranca vacío, sin sugerencias; el DTF por cara
  y el resto de costes los teclea el usuario (no se siembra ningún valor).
- **Bloqueo de avance:** `Siguiente` está deshabilitado hasta cumplir el mínimo
  del paso; `Finalizar` está bloqueado hasta cumplir **todos** los mínimos
  (`renderer/wizard-validation.js`). Pasos opcionales (Complementos, Empresa)
  no bloquean.
- **Línea de error:** bajo el formulario del paso, mensaje en español que explica
  qué falta («Añade al menos un proveedor.», «Rellena todos los costes…»); nunca
  se avanza con un paso incompleto y no se ve nunca JSON ni rutas técnicas.
- **Reutiliza el editor de catálogo:** los formularios de cada entidad
  (`renderAdminTabContent` / `updateConfigFromInput` / `executeAdminAction`) son
  los mismos del editor admin (§2.4b) — el asistente solo aporta el chrome de
  pasos, el bloqueo y el ensamblado. Una sola herramienta para editar el catálogo.
- **Persistencia al final:** el config se ensambla en memoria y solo se guarda al
  pulsar `Finalizar` y pasar `validateConfigSchema` (archivo: escritura atómica +
  backup; nube: siembra de la D1 con el catálogo del asistente). Ningún paso
  escribe a medias en el almacén compartido.

### 2.1 Indicador de datos (topbar, siempre visible)

Badge en la topbar, junto al título, con tres estados:

| Estado | Aspecto | Texto |
|---|---|---|
| Conectado | badge `--success-soft`, punto `--success` | `Datos al día · v128` |
| Sin conexión | badge `--warning-soft`, punto `--warning` | `Sin conexión · datos del 12/06 14:32` |
| Modo local | badge neutro (`--surface-tertiary`) | `Modo local` |

A su lado, botón fantasma **«Actualizar»** (icono refresh): pide
`GET /catalog/version`; si hay novedades descarga y refresca; si no, toast
discreto «Ya estás al día». Nunca bloquea la pantalla: spinner solo en el
propio botón.

### 2.2 Banner de solo lectura (offline)

Cuando la app arranca desde caché sin conexión, banner persistente bajo la
topbar, fondo `--warning-soft`, borde `--warning`:

> ⚠ **Sin conexión.** Estás viendo precios del **12/06 14:32**. Puedes
> presupuestar, pero no editar el catálogo. `[Reintentar]`

- Presupuestar sigue funcionando (R7 del PRD): el cálculo es local.
- El editor de catálogo queda deshabilitado con tooltip «No disponible sin
  conexión».
- `[Reintentar]` ejecuta el mismo flujo que «Actualizar»; si conecta, el
  banner desaparece con una transición breve.

### 2.3 Conflicto de edición (por entidad)

Sustituye al diálogo de conflicto global del NAS. Al guardar, si la versión de
una entidad no coincide, modal (no nativo, mismo estilo que el modal admin):

> **Conflicto en «Pack Peña».** Otro equipo lo modificó mientras editabas.
>
> *(comparación de campos en lenguaje claro — valor del servidor vs el tuyo —
> con el mismo humanizador del §2.5b)*
>
> `[Cargar versión del servidor]` `[Sobrescribir con la mía]` `[Cancelar]`

Solo entra en conflicto la entidad afectada; el resto de cambios del guardado
se aplican con normalidad y así se comunica («3 cambios guardados, 1
conflicto»).

### 2.3b Estados del presupuesto compartido (Fase B)

El presupuesto es ahora una **fuente de verdad compartida** (mismo contrato en
modo archivo y nube). Tres estados de UI nuevos al guardar/reabrir:

**Conflicto al editar.** Al guardar la edición de un presupuesto reabierto, si
otro equipo lo cambió mientras tanto (archivo = mtime+sha256; nube = versión),
diálogo de confirmación —reutiliza la UX de conflicto del catálogo §2.3—:

> **Conflicto al guardar.** Otro equipo cambió este presupuesto.
> Si continúas, tus cambios sobrescribirán los suyos.
> `[Sobrescribir]` `[Cancelar]`

`[Cancelar]` deja al usuario en el editor sin perder nada; `[Sobrescribir]`
reintenta forzando la escritura. Nunca se pisa en silencio el cambio del otro
(regla dura §6).

**Encolado (sin conexión, modo nube).** Si el backend está inalcanzable al
guardar, la escritura se **encola** y se sincroniza al reconectar; no es un
error. Toast discreto + info no bloqueante:

> Guardado · se sincronizará al reconectar
> *(en una edición: «Cambios guardados · se subirán al reconectar»)*

En **modo archivo** no hay cola: una escritura con el NAS caído **da error**
(diálogo «No se pudo guardar») y la app conserva los datos en pantalla para
reintentar — no se finge un encolado que nada vaciaría.

**Pendiente (`PP-PENDING-…`).** Un alta hecha sin conexión obtiene un id
provisional hasta que la cola se vacía y le asigna su `PP-YYYY-NNNN`
definitivo. Mientras está pendiente:
- Reabrir muestra el desglose en **solo lectura** con aviso «Presupuesto
  pendiente · su ID definitivo se asignará al reconectar» (no entra en modo
  edición: editar un id provisional no tiene sentido).
- **Exportar a PDF está bloqueado** con el mismo aviso, para que el PDF nunca
  imprima un id provisional.
- Al reconectar, el vaciado de la cola le da el id real y reconcilia la caché
  (sin duplicar): el presupuesto pasa a editable/exportable con normalidad.

### 2.4 Error sin red ni caché (primer arranque offline)

Pantalla de error existente, con mensaje específico y dos salidas:

> **No se pudo cargar el catálogo.** No hay conexión y este equipo aún no
> tiene datos guardados.
> `[Reintentar]` `[Usar modo archivo…]` *(abre ajustes locales para apuntar al
> config del NAS)*

Nunca se muestran datos inventados ni se arranca con catálogo vacío.

### 2.4b Admin: lista de catálogo y editor enfocado

Las cuatro pestañas de catálogo del admin (Productos, Packs, Proveedores,
Complementos) tienen dos vistas dentro del mismo modal:

**Vista de lista** (por defecto al abrir la pestaña):
- Barra de búsqueda con icono lupa; acento-insensible; filtra por id, nombre
  y categoría/meta sin re-renderizar (DOM filter, el foco no se pierde).
- Contador «N de M» (oculto si no hay búsqueda activa); estado vacío
  «Sin resultados para «…»» cuando N = 0.
- Fila compacta por entidad: chip de id · nombre · meta secundaria · botón
  [Editar] · botón eliminar (deshabilitado si está en uso).
- Botón «Añadir <entidad>» al pie; abre el editor directamente sobre la
  entidad recién creada.

**Vista de editor** (al pulsar [Editar] o una fila):
- Cabecera `← Volver a la lista` + título «Editar: <nombre>».
- Formulario de la entidad a todo el ancho, con secciones largas envueltas en
  `<details>` nativos plegables (abiertas por defecto):
  - Productos: «Proveedores», «PVP por caras y tramo»
  - Packs: «Opciones», «Componentes», «Precios»
  - Complementos: «Aplica a»
  - Proveedores: sin secciones plegables (formulario corto)
- «← Volver» regresa a la lista conservando el texto de búsqueda.
- El modelo de guardado no cambia: el único «Guardar» del pie del modal
  persiste el catálogo completo con comprobación de conflicto.

**Modal responsive:** ancho `min(1380px, 95vw)`; la rejilla `.admin-grid`
usa `repeat(auto-fit, minmax(220px, 1fr))`, lo que muestra más columnas en
monitores grandes y colapsa a una sola columna en estrecho (≤ 600 px →
pantalla completa).

### 2.5 Editor de catálogo sin modo admin

En v5 desaparece la puerta de contraseña: el editor de catálogo (el antiguo
«modo admin») se abre directamente desde la topbar para cualquier trabajador.
Lo que sustituye a la contraseña:

- **Confirmación al guardar:** modal con el resumen de cambios **en lenguaje
  claro** (ver §2.5b) y el autor que quedará registrado.
  `[Guardar N cambios]` `[Cancelar]`. Guardar sin pasar por aquí es imposible.
- **Autor visible:** el nombre de equipo/trabajador (de ajustes locales) se
  muestra en la cabecera del editor — «Editando como *Mostrador-2*».
- **Historial a mano:** pestaña de auditoría (quién, cuándo, qué) y lista de
  versiones con botón «Restaurar esta versión», que también pide confirmación
  y queda auditado.

### 2.5b Resumen de cambios legible (no técnico)

Todo lo que muestra cambios del catálogo —confirmación al guardar (modo archivo
y nube), modal de conflicto (§2.3) y auditoría/historial— usa un **humanizador**
común (`renderer/change-format.js`). Nunca se ve JSON crudo ni rutas con puntos.

- **Agrupado por entidad**, con badge e identidad: `NUEVO · Proveedor «Valento»`,
  `EDITADO · Producto «Camiseta»`, `ELIMINADO · Pack «Peña»` (verde / ámbar /
  rojo). El nombre sale de `name`/`label`, con el id como respaldo.
- **Alta/baja** de una entidad entera → solo la línea de resumen (sin volcar
  todos los campos).
- **Edición** → una fila por campo, en lenguaje claro y con el valor formateado:
  `Margen objetivo: 35 % → 40 %`, `Precio base (prov. 1): 3,50 € → 3,80 €`,
  `Componentes libres: Sí`. Unidades automáticas (€, %, Sí/No, «texto»,
  `(vacío)`); etiquetas de parámetros reutilizadas del editor.
- Si un campo no está en el diccionario, se muestra una etiqueta legible
  (nunca la ruta cruda).

### 2.6 Ajustes locales (ampliación)

El modal de ajustes locales gana cuatro secciones:

- **«Origen de datos»**: estado actual (`Nube — cuenta …` / `Local — ruta …`),
  botón para relanzar el asistente (§2.0), campo del **token de Cloudflare**
  (tipo password, solo en `settings.json` local), **nombre de
  equipo/trabajador** (autor de los cambios en la auditoría) y las dos
  acciones de migración: **«Subir a la nube»** / **«Bajar a local»**
  (catálogo + historial, con confirmación y resumen). Cambiar de origen pide
  confirmación y recarga.
- **«Actualizaciones»**: interruptor **«Buscar actualizaciones al iniciar»**
  (activado por defecto) + botón **«Buscar ahora»** con resultado en línea
  («Estás en la última versión» / «Versión X.Y disponible — [Descargar]»,
  enlace a la release de GitHub).
- **«Privacidad»**: interruptor **«Enviar informes de error»** (activado por
  defecto) con texto llano de qué se envía exactamente (errores técnicos,
  versión y sistema — *nunca* precios, clientes ni catálogo) y enlace al
  detalle del manual. Botón **«Exportar diagnóstico»** (genera el zip y abre
  la carpeta).
- **«Plantilla de presupuesto»**: galería con miniaturas de las 6 integradas
  (**Clásica · Moderna · Compacta · Detallada · Corporativa · Formulario** —
  diseños aprobados en `MainUI.pen`) + las personalizadas de la empresa, con
  **vista previa** del presupuesto de demo al seleccionar. Las plantillas con
  color (Corporativa, Moderna) muestran un **selector de color de marca**
  (dato de `company`; los tonos oscuro/suave se derivan solos). Botón «Añadir
  plantilla personalizada…» (importa HTML+CSS, se valida y se guarda en el
  almacén compartido — todos los PCs la ven). Si una plantilla no pasa el
  saneado, error en lenguaje llano («La plantilla contiene scripts, que no
  están permitidos»). Los presupuestos son **digitales, sin firmas**: las
  plantillas cierran con la nota de confirmación por teléfono/email, y todos
  los textos (condiciones, notas legales) son datos editables de
  `quote_settings`/`company`, nunca texto fijo.

### 2.7 Pantalla «Estadísticas»

Pantalla nueva, accesible desde la topbar, que responde a «¿qué se usa y qué
se vende?» con datos de **todos** los PCs. El main process trae las filas de
presupuestos de D1 (sin servidor: REST directo) y un agregador puro
(`lib/stats.js`) calcula los indicadores; la app solo pinta.

**Layout:** selector de periodo arriba (Temporada · 30 días · Año · Rango) →
fila de tarjetas KPI → rejilla de gráficos 2×N.

**Tarjetas KPI:** total presupuestado (€), total aceptado (€), tasa de
conversión (%), unidades totales, ticket medio, margen real medio vs objetivo
(verde si ≥ objetivo, ámbar si no).

**Gráficos** (cada uno una card con título y total):

| Gráfico | Tipo | Pregunta que responde |
|---|---|---|
| Presupuestos y unidades por pack | barras horizontales, colores `--pack-color-1…6` | ¿Qué pack se usa más? |
| Conversión por pack | barras con % aceptado/rechazado/pendiente | ¿Qué pack se presupuesta mucho pero no se vende? |
| Evolución semanal | líneas (presupuestado vs aceptado) | ¿Cuándo es la temporada? ¿Crece? |
| Distribución por tramo | barras T1–T4 | ¿Vendemos volumen o pedidos pequeños? |
| Margen real vs objetivo por pack | barras emparejadas | ¿Respetamos el margen? |
| Desviación sobre PVP recomendado | histograma | ¿Cuánto se rebaja a mano sobre lo recomendado? |
| Top productos y addons | dos listas con barra inline | ¿Qué prendas/extras pedir a proveedor? |
| Tallas especiales | barras 3XL/4XL/5XL por pack | ¿Qué coste interno generan las tallas grandes? |

**Implementación:** `renderer/charts.js` — módulo propio de SVG (barras,
líneas, histograma; ejes, tooltips nativos via `<title>`). **Sin librerías**
(regla 9 de `CLAUDE.md`): tres tipos de gráfico sencillos no justifican una
dependencia. Colores y tipografía desde los tokens (`--font-data` para cifras).

**Estados:** cargando (skeleton en cards); sin conexión → la pantalla muestra
el aviso estándar offline (los agregados requieren conexión a D1); periodo sin
datos → mensaje vacío con explicación, nunca gráficos a cero engañosos.

**Historial (cambio asociado):** cada presupuesto gana chips de estado
`Pendiente` (neutro) / `Aceptado` (`--success-soft`) / `Rechazado`
(`--danger-soft`), clicables para cambiar el estado — cualquier trabajador
puede hacerlo. Es un clic en frío del mostrador — sin modal, con undo en toast.

**Recordatorio de estados (al arrancar):** si hay presupuestos sin estado con
más de 7 días o que caducan esta semana (validez 15 días), aparece un aviso
discreto bajo la topbar — «4 presupuestos esperan respuesta · 2 caducan esta
semana — [Revisar]» — que lleva al historial filtrado. Se descarta con un
clic y no vuelve hasta el día siguiente. Nunca un modal bloqueante: es un
recordatorio, no una tarea.

**Datos del pedido (cambio asociado):** el formulario del paso 2 pide
**nombre y teléfono del cliente, obligatorios** (validación en línea, no al
final), que viajan al historial, a D1 y al PDF junto con la validez de 15
días («Presupuesto válido hasta dd/mm/aaaa»).

### 2.8 Accesibilidad y detalles

- Los tres estados del indicador se distinguen por **texto e icono, no solo
  color**; ídem los chips de estado del historial.
- Cada gráfico SVG lleva título accesible y una alternativa tabular
  («Ver como tabla») — además es la forma rápida de copiar los números.
- El banner offline tiene `role="status"`; el resultado de «Actualizar» se
  anuncia con `aria-live="polite"`.
- Toda fecha de frescura de datos en formato `dd/mm hh:mm` local.
