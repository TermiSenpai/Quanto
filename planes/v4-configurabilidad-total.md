# Plan V4 — Configurabilidad total (productos, proveedores, packs y complementos)

> Construye **sobre el esquema v3 (inglés)** ya existente en la rama de migración. La capa de
> datos/cálculo y el renderer ya usan claves inglesas (`parameters`, `roly_models`, `tiers`, `packs`,
> `prices`, tipos `crew`/`single`/`mixed`/`custom`, resultado con `total_vat_inc`/`sale_base`/`margin`…).
> Este plan **no re-traduce nada**: añade capacidades nuevas en inglés y bumpea el esquema a **`v4.0.0`**.
>
> Convierte la app de "calculadora con packs cerrados" en una herramienta donde **el usuario define
> todo el catálogo desde la UI**: productos, proveedores, packs (individuales o mezclas), complementos
> opcionales y PVP recomendado. Cruza la frontera del Tier 3 de CLAUDE.md (cambia el modelo de datos),
> así que actualiza `ARCHITECTURE.md`/`CLAUDE.md`/`PLAN_Calculadora.md` como parte del trabajo.

## Contexto real (verificado en `feat/v4-configurabilidad`, sobre `refactor/english-migration-pr1`)

- Esquema **v3 inglés** vivo: ver [config.default.js](../config.default.js). Migración v2→v3 en
  [lib/migrations.js](../lib/migrations.js) (idempotente, con tablas de rename). **203 tests verdes.**
- El `calculo.js` actual es la **traducción literal** del v2: **todos los bugs siguen vivos**
  (ver Fase 0). Las claves del resultado ya están en inglés → no hay reescritura por idioma.
- `pnpm` instalado pero **sin migrar** (solo `package-lock.json`, sin `pnpm-lock.yaml`).

## Decisiones cerradas con el dueño del proyecto

0. **Inglés desde el primer commit** (ya es el estado base). Valores visibles (`name`, `label`,
   `description`, `terms`) en español.
1. **Motor de packs unificado por componentes.** Se eliminan `calculateCrewPack`/`calculateSinglePack`/
   `calculateMixedPack`/`calculateCustomPack` y se sustituyen por **un solo `calculatePack`** genérico.
2. **3XL = coste interno escalado por cantidad.** Input `qty_3xl`; el `buffer_3xl_eur_pack` fijo
   desaparece y pasa a coste real por prenda 3XL (`extra_cost_3xl` por producto), aplicado en TODOS
   los packs. No se factura al cliente.
3. **PVP recomendado = coste + margen objetivo + redondeo psicológico** (`target_margin`, redondeo a
   `x,95`/`x,99`). Botón "aplicar sugerencia", PVP editable.
4. **Multi-proveedor por producto.** Registro `suppliers` + cada producto con varios proveedores
   (`price`/`ref`/`min_order`/`is_default`).

---

## Estructura de fases

| Fase | Título | Depende de | Esfuerzo |
|---|---|---|---|
| 0 | Saneamiento: bugs de dinero + seguridad + pnpm | — | 2-3 j |
| 1 | Esquema `v4` (products/suppliers/addons) + migración v3→v4 + validación | 0 | 2-3 j |
| 2 | Motor de cálculo unificado + 3XL + PVP recomendado | 1 | 3-4 j |
| 3 | UI de cálculo dinámica (de-hardcode de formularios y packs) | 2 | 2-3 j |
| 4 | Admin: crear/editar productos, proveedores, packs y complementos | 2 | 4-5 j |
| 5 | Hardening restante, docs, devlog | 0-4 | 1-2 j |

**Total ~14-20 jornadas.** Cada fase es entregable y testeable. Las Fases 0-1 no cambian nada visible.

---

## Fase 0 — Saneamiento (antes de tocar features)

**Por qué**: vamos a reescribir el motor. Sin red de tests sobre el comportamiento actual y con los
bugs vivos, los arrastraríamos. Los 203 tests existentes son la base; añadimos los que falten.

**Bugs confirmados vivos en [renderer/calculo.js](../renderer/calculo.js):**
- **Crash por tier nulo**: `getTier` devuelve `null` si `quantity < tiers[0].from`. `calculateCrewPack`
  (:104), `calculateSinglePack` (:135) y `calculateMixedPack` (:165) leen `tier.id`/`tier.label` sin
  guard. Solo `calculateCustomPack` (:224) lo controla. Reproducible si un admin pone `pack.min` < 10.
- **3XL**: `buffer_3xl_eur_pack` fijo y **solo en crew** (:113-114). Individual/mixed/custom no llevan
  colchón 3XL. (Se resuelve a fondo en Fase 2; aquí solo se documenta y se deja test que lo fija.)
- **% margen sobre IVA**: `margin_pct = margin / total_vat_inc` (:184, :268, :296) en vez de `/ sale_base`.
- **4XL/5XL sin tope**: `qty_4xl + qty_5xl` puede exceder el total de prendas → recargos absurdos.
- **Extras suman a venta pero no a coste** (se resuelve con `addons.cost` en Fase 2).

**Alcance**:
- **Migrar a pnpm**: `pnpm import` (conserva árbol), borrar `package-lock.json`, `.npmrc` con
  `node-linker=hoisted` (seguridad para electron-builder), actualizar `package.json`/`README-build.md`/
  `.github/workflows/ci.yml`/`CONTRIBUTING.md`/`.nvmrc` a pnpm. Verificar `pnpm run build:win`.
- Fix tier nulo: `if (!tier) return { error: 'No hay tramo para esa cantidad.' };` en los 3 calculadores.
- Fix `margin_pct = margin / sale_base` (3 sitios) + reajustar umbral del semáforo en el renderer.
- Validar `qty_4xl + qty_5xl <= total` en `collectInputs`/calculadores + `max` en inputs.
- Escritura de config **atómica**: `config:write`/`config:force-write` a `.tmp` + `fs.renameSync`
  (como [lib/history.js](../lib/history.js)) + re-verificación de hash antes del rename.
- Seguridad alta: allow-list de rutas en handlers IPC con `ruta`; quitar `'unsafe-inline'` de
  `style-src` en la CSP; validar payload de `settings:write`/`quotes:save`; rate-limit de clave admin.
- Tests nuevos que fijan los fixes (tier nulo → error; 4xl+5xl>total → error; margin_pct sobre base).

**Criterio de aceptación**: `pnpm test` verde (203 + nuevos); `pnpm run build:win` OK; CSP sin
`unsafe-inline` y la app renderiza igual; `pnpm audit` sin críticas nuevas.

---

## Fase 1 — Esquema `v4` + migración v3→v4

**Por qué**: todo cuelga del esquema. El framework de migración ya existe; añadimos un paso v3→v4.

**Modelo de datos `v4`** (claves inglesas; valores de negocio en español):

```js
{
  version: '4.0.0',

  suppliers: {
    ROLY: { name: 'Roly', web: '', notes: '' }
  },

  // evoluciona roly_models → products (multi-proveedor)
  products: {
    BEAGLE: {
      name: 'Camiseta',
      category: 'tshirt',              // agrupa + define a qué addons aplica
      extra_cost_3xl: 0.40,            // sobrecoste real cuando ESTA prenda es 3XL
      target_margin: 0.35,
      suppliers: [
        { supplier: 'ROLY', ref: 'CA65540558', price: 1.7325, min_order: 0, is_default: true }
      ],
      prices: { two_sides: { T1: 11.99, ... }, one_side: { ... } }  // PVP del producto suelto
    }
  },

  tiers: [ /* sin cambios respecto a v3 */ ],

  addons: {                            // sustituye extra_*_eur de parameters
    name:         { label: 'Nombre',      price: 1.5, vat_included: false, cost: 0.2, applies_to: ['*'] },
    short_sleeve: { label: 'Manga corta', price: 1.5, vat_included: false, cost: 0.2, applies_to: ['tshirt'] },
    long_sleeve:  { label: 'Manga larga', price: 3,   vat_included: false, cost: 0.4, applies_to: ['hoodie'] }
  },

  packs: {
    crew_full: {
      name: 'Pack Peña',
      icon: 'i-pack', description: 'Camiseta + sudadera por persona',   // de-hardcode PACK_META
      min_total: 10,
      target_margin: 0.35,
      pricing_mode: 'bundle',          // 'bundle' = prices propio del conjunto | 'components' = suma de prices de productos
      options: [
        { id: 'sides', label: 'Caras',   values: [{id:'one_side',n:1},{id:'two_sides',n:2}] },
        { id: 'hood',  label: 'Capucha', values: [{id:'without_hood'},{id:'with_hood'}],
          maps_product: { component:'hoodie', without_hood:'CLASICA', with_hood:'URBAN' } }
      ],
      components: [
        { id:'tshirt', label:'Camiseta', product:'BEAGLE',  qty_per_pack:1 },
        { id:'hoodie', label:'Sudadera', product:'CLASICA', qty_per_pack:1 }
      ],
      bundle_prices: { /* keyed por combinación de options × tier (migra el `prices` actual del crew) */ }
    },
    custom: { name: 'Pack personalizado', pricing_mode: 'components', min_total: 10, free_components: true }
  },

  company: { ... }, quote_settings: { ... }, admin: { password: '...' }
}
```

Decisión clave: `pricing_mode`:
- `components` → factura cada componente al `prices` de su producto (cubre single/mixed/custom de hoy).
- `bundle` → el pack tiene su propia tabla `bundle_prices` indexada por combinación de `options` × tier
  (cubre crew). Las opciones `sides`/`hood` dejan de estar hardcodeadas.

**Alcance**:
- Reescribir [config.default.js](../config.default.js) al esquema v4 (equivalente al actual, sin
  pérdida de precios: `roly_models`→`products` con proveedor ROLY; `extra_*`→`addons`; crew→`bundle`,
  single/mixed/custom→`components`).
- Añadir `migrateConfigV3ToV4` en [lib/migrations.js](../lib/migrations.js) siguiendo el patrón
  existente (idempotente; detecta `/^4\./` y devuelve tal cual; mapea v3→v4). `migrateConfig` encadena
  v2→v3→v4.
- Ampliar [lib/config-schema.js](../lib/config-schema.js) al v4 (productos con ≥1 proveedor y un
  `is_default`; addons; packs con componentes/opciones válidos; `prices`/`bundle_prices` cubriendo los
  tiers actuales).
- Tests de migración v3→v4 con fixture real → validado → mismos números que la red de la Fase 0.

**Criterio de aceptación**: un config v3 (o v2) se migra a v4 al abrir, deja backup y los precios no
cambian; el validador rechaza un v4 inválido nombrando el campo; `pnpm test` verde.

---

## Fase 2 — Motor de cálculo unificado + 3XL + PVP recomendado

**Por qué**: el corazón. Un solo motor, testeable, que resuelve el 3XL de raíz.

**Alcance** (todo en inglés, manteniendo la **semántica** de las claves del resultado actual):
- **`calculatePack(cfg, packId, opt)` único**:
  - Resuelve componentes (con `maps_product` según opciones elegidas), tier sobre el total (con guard).
  - `pricing_mode: 'components'` → `Σ qty × product.prices[sidesKey][tier.id]`.
  - `pricing_mode: 'bundle'` → `pack.bundle_prices[comboKey][tier.id]`.
  - Coste por prenda: `calculateGarmentCost` leyendo `price` del **proveedor por defecto** (o el más
    barato si se configura).
- **3XL correcto**: input `qty_3xl`; coste extra = `Σ por prenda 3XL de product.extra_cost_3xl`,
  sumado a `total_cost` en todos los packs; sin recargo. Validar `3xl+4xl+5xl <= total`.
- **Addons configurables**: `calculateAddons(cfg, selection)` con `price`, `vat_included` y **`cost`**
  (suma a coste). Respeta `applies_to` por categoría.
- **PVP recomendado**: `recommendedPrice(cfg, packOrProductId, combo, tier)` =
  `round(cost / (1 - target_margin))` redondeado a `x,95`/`x,99`; devuelve el margen real resultante.
- Mantener estables `subtotal`, `surcharges`, `total_vat_inc`, `sale_base`, `vat`, `total_cost`,
  `margin`, `margin_pct`, `breakdown` para no romper UI/PDF/historial.

**Criterio de aceptación**: los tests de la Fase 0 siguen verdes con el motor nuevo; test de 3XL al
50% sube `total_cost` y baja margen de forma honesta; test de `recommendedPrice` (coste X, margen 35%
→ `round(X/0.65)`).

---

## Fase 3 — UI de cálculo dinámica

**Por qué**: el renderer aún asume formularios por tipo. Hay que generarlos desde el config.

**Alcance**:
- De-hardcode `PACK_META`: icono/descripción desde `pack.icon`/`pack.description`.
- `renderPackInputs` genérico desde `pack.options`, `components` (libres si `free_components`), inputs
  3XL/4XL/5XL y **addons aplicables** filtrados por categoría.
- `collectInputs` genérico (sin ramas por tipo).
- Resultado: desglose por componente + línea de addons + nota de 3XL absorbido. Reabrir presupuesto
  del historial fija `state.packId = quote.pack_id` antes de renderizar (bug detectado).

**Criterio de aceptación**: crear un pack a mano en config → aparece y se presupuesta sin tocar código;
un addon que no aplica a una categoría no se ofrece; reabrir histórico muestra el pack correcto.

---

## Fase 4 — Admin: crear y editar todo el catálogo

**Por qué**: aquí aterriza "todo configurable". Hoy [renderer/admin.js](../renderer/admin.js) solo
edita parámetros, modelos (alta/baja) y PVP de packs existentes; **no crea packs, proveedores ni addons**.

**Alcance** (patrón existente `data-cfg-path` + `executeAdminAction`):
- **Proveedores** (`suppliers`): alta/baja/edición; no borrar uno en uso.
- **Productos** (`products`, sustituye "Modelos Roly"): nombre, categoría, `extra_cost_3xl`,
  `target_margin`, lista de proveedores (`price`/`ref`/`min_order`/`is_default`), tabla de PVP con
  **"Aplicar PVP recomendado"** + semáforo de margen por celda.
- **Complementos** (`addons`): alta/baja/edición (`label`, `price`, `vat_included`, `cost`, `applies_to`).
- **Packs** (constructor): crear desde cero (nombre, icono, `pricing_mode`, mínimo, `target_margin`,
  `options`, `components`, `maps_product`); para `bundle`, tabla `bundle_prices` con "Aplicar
  recomendado"; borrar packs. El "color por pack" ya existe.
- Quitar del admin el grupo "Extras opcionales" (ahora `addons`) y `buffer_3xl_eur_pack` (ahora
  `extra_cost_3xl` por producto).
- Validación pre-guardado con `config-schema.js`; el diff/auditoría visual ya existe.

**Criterio de aceptación**: crear de cero proveedor + producto con 2 proveedores + addon + un pack
`components` y uno `bundle`, sin editar `config.js` a mano; "Aplicar PVP recomendado" coincide con el
motor; guardar registra diff y crea backup.

---

## Fase 5 — Hardening restante, docs y devlog

**Alcance**: seguridad media/baja (`sandbox:true` si se quita `require` de preload; `webSecurity:true`
explícito; DevTools fuera de prod; no exponer rutas completas del NAS); docs (ARCHITECTURE.md/CLAUDE.md
esquema v4, PLAN_Calculadora.md modelo de negocio v4, corregir cualquier afirmación obsoleta sobre el
parsing); devlog nuevo; bump a `4.0.0-beta` (sigue en beta — no marcar V1).

---

## Otras oportunidades (no bloqueantes)

- Reconciliación de céntimos (redondear en puntos definidos para que las líneas sumen el total del PDF).
- Presupuesto reproducible (guardar inputs + versión de config, no solo el resultado congelado).
- Comparador de proveedores ("¿cuál sale más barato para este pedido?") — casi gratis con multi-proveedor.
- Aviso de pedido mínimo de proveedor (`min_order`).
- `target_margin` global por defecto con override por pack/producto.
- Export/import del catálogo a `.json`.
- E2E con Playwright cuando el catálogo configurable esté estable (hoy no justifica el coste).

## Riesgos y mitigaciones

- Migración con pérdida: backup automático + tests + idempotencia; no tocar el `config.js` del NAS sin
  validar con copia.
- Romper números buenos: la red de tests de la Fase 0 es el oráculo.
- Sobre-ingeniería de options/bundle: congelar el esquema al inicio de la Fase 1 con 3 ejemplos reales.
- pnpm + electron-builder: probar empaquetado en la Fase 0, no al final.
