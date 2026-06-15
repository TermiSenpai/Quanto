# Capítulo 12 · Configurabilidad total (esquema y motor v4)

> Hasta el capítulo 11, PackPrice era una calculadora con cinco packs cerrados, tres modelos Roly cableados y cuatro funciones de cálculo escritas a mano. Funcionaba, pero cualquier cambio del catálogo —un producto nuevo, otro proveedor, un pack distinto— era un cambio de **código**, no de **datos**. Este capítulo rompe ese techo: en v4 el taller define todo el catálogo desde el modo admin. Para llegar ahí hubo que generalizar el esquema, unificar el motor de cálculo, arreglar tres bugs de dinero que llevaban vivos desde la Excel, endurecer la seguridad y, de paso, migrar el tooling a pnpm.

---

## Por qué v4 (y por qué cruza la frontera del Tier-3)

CLAUDE.md tiene una regla de oro: **los datos de negocio viven fuera del código**. Pero el catálogo no eran datos del todo. El `config.js` tenía los precios, sí, pero la *forma* del catálogo estaba cableada: `modelos_roly` asumía exactamente BEAGLE/CLASICA/URBAN, `calculateMixedPack` asumía CLASICA+URBAN, y añadir un pack mixto distinto exigía tocar el motor. Eso es deuda latente: el día que el taller quiera vender gorras, o cambiar de proveedor, o montar un pack de tres prendas, toca abrir el editor de código.

v4 es la decisión de cerrar esa grieta de raíz. Y como **cambia el modelo de datos**, cruza la frontera del Tier-3 de CLAUDE.md: no es una mejora invisible, es un cambio estructural que se debatió con el dueño del proyecto antes de tocar nada. El plan completo está en [`planes/v4-configurabilidad-total.md`](../../planes/v4-configurabilidad-total.md).

> **Decisión bloqueada**: el catálogo entero (productos, proveedores, packs, complementos) es **datos editables desde la UI**, no código. Un producto o un pack nuevo no debe requerir un despliegue.

---

## El orden de ataque

El plan se ejecutó en fases, cada una entregable y con su red de tests:

0. **Saneamiento** — arreglar los bugs de dinero y la seguridad *antes* de reescribir el motor, para no arrastrarlos.
1. **Esquema v4** — `products`/`suppliers`/`addons`, migración v3→v4, validación.
2. **Motor unificado** — un solo `calculatePack`, 3XL real, PVP recomendado.
3. **UI dinámica** — formularios y packs generados desde la config, no cableados.
4. **Admin builder** — crear/editar productos, proveedores, packs y complementos.
5. **Hardening, docs, devlog** — cerrar.

El orden no es cosmético. Reescribir el motor sin red de tests sobre el comportamiento *actual* habría sido reintroducir los bugs viejos con otra cara. Por eso la Fase 0 va primero.

---

## Paso 0 · Los tres bugs de dinero (y pnpm)

El `calculo.js` heredado era la traducción literal del v2: arrastraba los mismos errores.

- **Crash por tramo nulo.** `getTier` devuelve `null` si la cantidad es menor que el primer tramo. Tres de las cuatro calculadoras leían `tier.id`/`tier.label` sin comprobarlo. Reproducible si un admin bajaba el `min` de un pack por debajo de 10. Ahora **todos** los packs tienen guard.
- **`margen %` sobre el total con IVA.** El margen comercial se calculaba dividiendo entre el total IVA incluido, no entre la base neta. Resultado: un margen que se leía ~1-2 puntos más bajo de lo real. Corregido: `margen % = margen / base_venta`.
- **Tallas grandes sin tope.** Nada impedía meter más unidades 3XL/4XL/5XL que prendas hay en el pedido. Ahora `qty_3xl + qty_4xl + qty_5xl` está acotado al total.

Y un cambio transversal: el proyecto migra de npm a **pnpm**. `pnpm-lock.yaml`, `pnpm-workspace.yaml` con `allowBuilds` para las dependencias que compilan binarios, y `.npmrc` con `node-linker=hoisted` (Electron y su builder no se llevan bien con el store enlazado por symlinks). Todos los comandos de la doc pasan a `pnpm install` / `pnpm dev` / `pnpm test` / `pnpm build:win`.

> **Decisión bloqueada**: ningún bug de cálculo se arrastra a la reescritura. Se fija con un test antes de tocar el motor.

---

## Paso 1 · El esquema v4

El salto conceptual: de un catálogo cerrado a uno declarativo. Las secciones nuevas, todas documentadas en [`config.default.js`](../../config.default.js):

- **`suppliers`** — registro de proveedores (Roly y los que vengan). Antes Roly estaba implícito en cada modelo; ahora es una entidad de primera clase.
- **`products`** — sustituye a `roly_models`. Cada producto lleva su `category` (que decide qué complementos aplican), su `extra_cost_3xl`, su `target_margin`, su tabla de precios propia (`prices`, caras × tramo) y una lista de proveedores (`suppliers[]`) de los que exactamente uno es `is_default`. El precio del proveedor por defecto alimenta el coste.
- **`addons`** — sustituye a los parámetros fijos `extra_nombre_eur` / `extra_manga_*_eur`. Cada complemento tiene `label`, `price` (con o sin IVA según `vat_included`), `cost` (el coste interno real, para que el margen no mienta) y `applies_to` (categorías a las que aplica, o `*`).

Y los `parameters` adelgazan: desaparecen `buffer_3xl_eur_pack` y los tres `extra_*_eur`; entran `default_target_margin` y `price_rounding_ending`.

### La migración v3→v4

Toda la lógica de versiones vive en un único sitio —[`lib/migrations.js`](../../lib/migrations.js)— y corre cuando el dato *entra* al sistema. `migrateConfig` ahora encadena: un config v2 se mapea a v3 (`mapConfigV2ToV3`) y luego a v4 (`migrateConfigV3ToV4`); un v3 salta directo al paso v4; un v4 se devuelve por identidad (idempotente, mismo objeto, para que la store de migración perezosa compare por referencia).

El paso v3→v4 es el sustancioso:

- `roly_models` → `products`: la `category` se infiere (BEAGLE=tshirt, CLASICA/URBAN=hoodie), el `extra_cost_3xl` se siembra por categoría, y la tabla de precios se copia desde el pack `single` que referenciaba ese modelo.
- `extra_*_eur` → `addons`: conservando los importes que hubiera.
- pack `type` → `pricing_mode`: `crew`→`bundle` (con `bundle_prices` reconstruidos desde el árbol `prices[capucha][caras][tramo]`), `single`/`mixed`/`custom`→`components`. Las opciones (caras, capucha) y los componentes se declaran; el pack peña recibe el `maps_product` que elige CLASICA o URBAN según la capucha.

### La validación

[`lib/config-schema.js`](../../lib/config-schema.js) se reescribe para v4 y rechaza de entrada cualquier config v2/v3 (debe migrarse antes). Comprueba, con `path` exacto y mensaje en español, todo lo que el motor necesita: que cada producto tenga **exactamente un** proveedor por defecto, que la tabla de precios cubra todas las caras y tramos, que los `bundle_prices` cubran **todas** las combinaciones de opciones × tramo (producto cartesiano de los valores de opción), que los tramos no se solapen, y que los `components` y los `maps_product` apunten a productos que existen.

> **Decisión bloqueada**: el esquema v4 vive en `config.default.js`; la migración en `lib/migrations.js`; la validación en `config-schema.js`. Nadie aguas abajo conoce las formas antiguas.

---

## Paso 2 · Un solo motor de cálculo

Aquí está el corazón del capítulo. Las cuatro calculadoras (`calculateCrewPack`, `calculateSinglePack`, `calculateMixedPack`, `calculateCustomPack`) **desaparecen**. En su lugar, un solo [`calculatePack(cfg, packId, opt)`](../../renderer/calculo.js) dirigido por completo por la config:

1. Lee el `pricing_mode` del pack.
2. Resuelve las opciones seleccionadas (de qué valor de opción sale el número de caras y la clave de la tabla de precios).
3. Expande los componentes en líneas con su producto resuelto (honrando `maps_product`).
4. Calcula el tramo sobre la cantidad total, aplica 3XL/4XL/5XL, suma complementos.
5. Devuelve un objeto plano con el desglose, o `{ error }` con mensaje en español si algo no valida (no lanza).

Dos modos:

- **`bundle`** (el Pack Peña): el pack se vende como unidad a su tabla `bundle_prices`, indexada por la cadena de combinación de opciones (`without_hood|two_sides`) × tramo. El input es el número de packs.
- **`components`** (camisetas, sudaderas, mixto, personalizado): cada componente se factura al precio de su producto (`product.prices[caras][tramo]`). El input es la cantidad por componente; el tramo se calcula sobre la suma. Con `free_components: true`, el usuario añade líneas de producto libres (el pack personalizado).

Que el pack mixto del plan siga dando exactamente **193,40 €** (7 URBAN + 5 CLASICA, T1) y el pack peña **311,40 €** (12 packs sin capucha 2 caras, T1) no es casualidad: son los casos que el plan fija y que los tests pinean al céntimo. La generalización no movió ni un euro de los precios conocidos.

### 3XL: de buffer fijo a coste real

El cambio más fino de modelo de negocio. El antiguo `buffer_3xl_eur_pack` de 0,40 €/pack era una aproximación: un colchón fijo para amortizar el recargo de Roly en tallas grandes. v4 lo sustituye por **coste real por prenda 3XL**, configurable por producto (`extra_cost_3xl`). Para un pedido, el motor añade al coste interno:

```
coste_3xl = qty_3xl × MAX(extra_cost_3xl de los productos del pedido)
```

El **MAX** es deliberado y conservador: si el pedido mezcla camisetas (0,40 €) y sudaderas (0,60 €), se imputa el peor caso (0,60 €) a cada unidad 3XL. El taller nunca pierde dinero con el mix de tallas. Y, como antes, **el cliente no paga el 3XL**: es coste interno, no recargo. Los 4XL/5XL+ siguen siendo recargos directos al cliente.

### PVP recomendado

Nuevo en v4: dado un coste y un margen objetivo, sugerir un PVP redondeado a un final psicológico.

```
recommendedPrice = redondear_arriba( coste / (1 − margen) ) hasta el siguiente x,95
```

`recommendedPrice` informa además del **margen real** que queda tras el redondeo (porque redondear hacia arriba mejora el margen sobre el objetivo). El admin tiene botones "Aplicar PVP recomendado" en cada tabla de precios; la sugerencia rellena la celda pero el PVP sigue siendo editable a mano. El motor usa `parameters.default_target_margin` como margen por defecto; la UI pasa el `target_margin` por entrada cuando hay override.

> **Decisión bloqueada**: un solo `calculatePack` genérico. 3XL = coste interno real escalado por cantidad (MAX sobre el pedido, no facturado). PVP recomendado = coste / (1 − margen) redondeado a `x,95`, editable.

---

## Pasos 3-4 · La UI deja de estar cableada

Con el motor dirigido por datos, los formularios podían dejar de estar escritos a mano. La pantalla de cálculo genera sus controles (selectores de opción, líneas de componente, contadores de tallas) a partir de la definición del pack en la config. Si mañana hay un pack con tres opciones y cuatro componentes, la UI lo dibuja sola.

Y el modo admin se convierte en un **builder de catálogo**: crear y editar productos (con sus proveedores y tabla de precios), proveedores, packs (opciones, componentes, `bundle_prices`) y complementos. Los botones de PVP recomendado viven aquí. Todo lo que antes era una edición de código ahora es una edición de datos con su backup, su diff y su entrada de auditoría, como cualquier otro cambio admin.

---

## Paso 5 · Endurecimiento de seguridad

Aprovechando que se tocaba la frontera IPC, se cerraron varias superficies:

- **Lista blanca de rutas IPC** (`lib/path-guard.js`): los handlers de filesystem solo tocan rutas bendecidas (el config y los settings de este PC), nunca rutas arbitrarias que llegue a colar el renderer.
- **Validación de payloads** en `settings:write` y `quotes:save`: se rechaza la entrada malformada en la frontera.
- **Límite de intentos** en la verificación de la clave admin (`auth:verify-admin`): throttle/bloqueo ante intentos repetidos.
- **Escrituras de config atómicas** (`.tmp` + rename, en `lib/config-store.js`): una escritura interrumpida deja el original intacto. Importante sobre SMB, donde una caída de red a mitad de escritura es un escenario real.

Una decisión que **no** se tomó, y se documenta honestamente: la CSP mantiene `style-src 'unsafe-inline'`. La UI usa estilos inline (`style="..."`) de forma generalizada; apretar esa directiva exigiría barrer todo el markup. Para una app de LAN sin red, con `script-src 'self'` y `default-src 'self'` ya cerrados, el riesgo no lo justifica. Es un compromiso consciente, no un descuido. Queda anotado en `ARCHITECTURE.md` §7 y en `PLAN_Calculadora.md` §7.1.

---

## Resultado

| Antes (v3) | Después (v4) |
| --- | --- |
| `roly_models` cableado a 3 modelos | `products` con multi-proveedor y tabla de precios propia, editable |
| Roly implícito en cada modelo | `suppliers` como registro de primera clase |
| Extras fijos (`extra_*_eur`) | `addons` configurables con coste, IVA y categorías |
| 4 calculadoras codificadas por tipo | un solo `calculatePack` dirigido por `pricing_mode` |
| Pack nuevo = cambio de código | Pack nuevo = entrada en `config.packs`, desde el admin |
| Buffer 3XL fijo 0,40 €/pack | Coste 3XL real por producto, MAX sobre el pedido, no facturado |
| Sin sugerencia de PVP | PVP recomendado (coste + margen + redondeo a `x,95`) |
| `margen %` sobre el total con IVA | `margen %` sobre la base neta |
| npm | pnpm |

**Idioma**: el código de v4 es 100 % inglés (identificadores, comentarios, canales IPC); las strings visibles (`name`, `label`, `description`, `terms`) siguen en español, como manda CLAUDE.md §2/§4.5.

---

## Decisiones bloqueadas en este capítulo

1. **El catálogo es datos editables desde la UI**, no código: productos, proveedores, packs y complementos.
2. **Esquema v4** con `suppliers`/`products`/`addons`; `roly_models` y los `extra_*_eur` fijos desaparecen.
3. **Un solo `calculatePack` genérico** con `pricing_mode` `bundle`/`components` y opciones declaradas; cero calculadoras por tipo.
4. **3XL = coste interno real por producto** (`extra_cost_3xl`), MAX sobre el pedido, no facturado. El buffer fijo desaparece.
5. **PVP recomendado** = coste / (1 − margen objetivo) redondeado a `x,95`; sugerencia editable.
6. **Migración v3→v4 idempotente** en `lib/migrations.js`, encadenada tras v2→v3.
7. **Correcciones de dinero**: guard de tramo nulo en todos los packs, `margen %` sobre la base neta, tallas grandes acotadas al pedido.
8. **Endurecimiento**: lista blanca de rutas IPC, validación de payloads, límite de intentos admin, escrituras atómicas. CSP `style-src 'unsafe-inline'` mantenida como compromiso documentado.
9. **Tooling en pnpm**.

---

## Qué viene después

Con el catálogo configurable y el motor unificado, las siguientes paradas razonables son operativas, no estructurales:

1. **Empaquetar y probar el `.exe`** con v4 dentro: que la migración v3→v4 corra limpia en el primer PC que abra un config viejo, que el builder de admin no rompa la build portable.
2. **Validar con el cliente** un alta de producto y un pack nuevo end-to-end, desde el admin, sin tocar código.
3. **Consumir el `target_margin` por entrada** en el motor de PVP recomendado de forma automática (hoy usa `default_target_margin` y la UI pasa el override explícito).
