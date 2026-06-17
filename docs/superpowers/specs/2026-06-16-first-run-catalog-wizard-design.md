# Asistente de catálogo en primer arranque (catálogo en blanco)

> Diseño aprobado en sesión de brainstorming 2026-06-16. Sustituye el sembrado
> automático con `buildDefaultConfig()` por un **asistente guiado** que el usuario
> rellena desde cero ("desde su lógica de negocio"), tanto en modo archivo como en
> modo nube.

## 1. Problema y objetivo

Hoy, en el primer arranque, el catálogo se siembra de golpe desde
`buildDefaultConfig()` (`config.default.js`): parámetros de coste, proveedores,
productos, tramos, packs, complementos, empresa y ajustes de presupuesto. Eso
crea una instalación nueva con los **números de negocio de otra empresa**
(customer #1), que el usuario tiene que ir borrando/sustituyendo.

**Objetivo:** que una instalación nueva se construya **desde cero**, con el
usuario introduciendo **todos** los datos (empezando por los costes), mediante un
asistente guiado paso a paso con validación. No se parte de ningún default.

## 2. Decisiones tomadas (brainstorming)

| Decisión | Valor |
|---|---|
| Alcance | **Todo el catálogo en blanco** (proveedores, productos, tramos, packs, PVP, costes, complementos, empresa) |
| Mecanismo | **Asistente guiado dedicado**, paso a paso, con validación por paso |
| Valores iniciales | **Todo en blanco**, cada campo obligatorio, sin sugerencias |
| Paso "Empresa" | **Incluido** en el asistente |
| Botón "Cargar catálogo de ejemplo" | **No** se incluye — `buildDefaultConfig` sale del producto |
| Modos | **Archivo y nube por igual** |
| Disparador | No existe `config.js` en la ruta local elegida **o** no hay catálogo en la nube |

## 3. Restricción dura del esquema

El validador `validateConfigSchema` (`lib/config-schema.js`) **rechaza** un config
con secciones vacías:

- `suppliers` no vacío (l. 149)
- `products` no vacío (l. 174-175)
- `tiers` array con ≥1 tramo (l. 274)
- `packs` no vacío (l. 323-324)
- `addons` **puede** estar vacío; cada addon presente exige `applies_to` no vacío (l. 264)

**Consecuencia:** no existe un "config vacío válido". El asistente NUNCA escribe un
config a medias: lo construye en memoria y solo persiste al final, cuando ya
cumple los mínimos y pasa `validateConfigSchema`. Los mínimos para poder terminar
son: parámetros completos + ≥1 tramo + ≥1 proveedor + ≥1 producto con PVP + ≥1 pack.
`addons` y `company` pueden quedar vacíos/mínimos.

## 4. Flujo

```
Bienvenida → elegir Local/Nube → (almacenamiento listo)
   ANTES:  sembrar buildDefaultConfig()         ← se elimina del arranque
   AHORA:  Asistente de catálogo (en blanco)
           → ensamblar config en memoria
           → validateConfigSchema
           → persistir (archivo: writeConfigAtomic+backup / nube: seedCatalog)
```

- **Disparo archivo:** en el flujo actual, cuando `config:exists` indica que el
  archivo no existe en la ruta elegida (hoy lanza el diálogo "¿Crear con valores
  por defecto?"). Ese diálogo y `createDefaultConfigFile` se sustituyen por el
  asistente.
- **Disparo nube:** tras `provisionCloud`, si la BD recién creada no tiene
  catálogo (hoy `seedCatalog(disassemble(buildDefaultConfig()))` dentro de
  provision). Se separa: provisionar BD vacía → asistente → sembrar con el
  catálogo del asistente.

El config se ensambla en memoria durante todo el asistente; ningún paso escribe en
NAS/D1 hasta el final. Así no quedan configs inválidos a medias en el
almacenamiento compartido.

## 5. Pasos del asistente

Orden impuesto por dependencias (los packs necesitan tramos + productos; el PVP se
teclea por tramo). Cada paso valida antes de permitir "Siguiente".

| # | Paso | Recoge | Mínimo para avanzar |
|---|---|---|---|
| 1 | **Costes** | Todos los `parameters`: mano de obra €/h, DTF €/m, DTF m/cara (1 y 2), planchado/cara, merma %, indirectos/prenda, envío/bulto, prendas/bulto, IVA, margen objetivo, redondeo, recargos 4XL/5XL | Todos rellenos y numéricos válidos |
| 2 | **Tramos** | Lista de tramos (`from`/`to`, `time_reduction`, `label`) | ≥1 tramo; rangos coherentes (sin solapes/huecos según valida el esquema) |
| 3 | **Proveedores** | Lista de proveedores (nombre, web, notas) | ≥1 proveedor |
| 4 | **Productos** | Por producto: categoría, lista de proveedores con precio (uno `is_default`), `extra_cost_3xl`, margen objetivo, tabla de PVP por caras × tramo | ≥1 producto válido con su tabla de PVP completa para los tramos definidos |
| 5 | **Packs** | Por pack: `pricing_mode` (`bundle`/`components`), opciones, componentes; PVP (tabla `bundle_prices` para bundle, o PVP de producto para components) | ≥1 pack válido; bundle cubre toda combinación × tramo |
| 6 | **Complementos** *(opcional)* | Addons (`label`, `price`/`vat_included`, `cost`, `applies_to`) | Puede quedar vacío |
| 7 | **Empresa** | Datos para el PDF (nombre, etc.) y ajustes mínimos de presupuesto | Datos de empresa rellenos |

Cierre: `validateConfigSchema(configEnsamblado)`; si pasa, se persiste.

## 6. Reutilización de UI

Los pasos 2–7 editan exactamente las entidades que el **editor admin** ya gestiona
(`renderer/admin.js`, `admin-extras.js`, listas de catálogo). El asistente
**reutiliza esos formularios/render**, no los duplica. El asistente aporta solo:

- el "chrome" de pasos (barra de progreso, Atrás/Siguiente, bloqueo de avance);
- la validación de "mínimo por paso";
- el ensamblado en memoria y la persistencia final.

Esto mantiene "una sola herramienta para editar el catálogo" y evita una segunda UI
paralela que mantener. Sigue los patrones existentes del editor admin.

## 7. Destino de `buildDefaultConfig()` y `config.default.js`

`buildDefaultConfig` **sale del producto**: ya no auto-siembra y no hay botón de
"cargar ejemplo". Pero hay dependencias técnicas que reubicar:

- **Versión de esquema:** hoy `main.js` y `lib/cloud-bootstrap.js` obtienen la
  versión vía `buildDefaultConfig().version`. Se extrae a una constante
  independiente (p. ej. `SCHEMA_VERSION` exportada desde `config.default.js`), sin
  acarrear un catálogo.
- **Skeleton del asistente:** se añade `buildEmptyConfig()` que devuelve un config
  con la **forma** válida pero **colecciones vacías** y `parameters` en blanco,
  con la versión sellada. Es el objeto en memoria que el asistente va rellenando.
  No es un "catálogo default": no contiene ningún número de negocio.
- **Constantes de negocio sembradas** (`PRODUCTS`, `PACKS`, `SUPPLIERS`, `TIERS`,
  `ADDONS`, `COMPANY`, `QUOTE_SETTINGS`, y los valores de `PARAMETERS`): **se
  eliminan** de `config.default.js`. El cambio previo de DTF a 0,30 vivía en esas
  constantes y, por tanto, **queda obsoleto** (el usuario teclea ese 0,30 en el
  paso de Costes).
- **Fallback de password admin** (`main.js:398`, `buildDefaultConfig().admin.password`):
  el gate de password está siendo retirado en v5; se sustituye por la constante o
  se elimina junto al resto de código muerto de admin password (sin reabrir esa
  limpieza aquí).
- **Inyección en `cloud-bootstrap`:** `deps.buildDefaultConfig` se reemplaza por
  `deps.schemaVersion` (para el ledger de migración) y el catálogo a sembrar pasa a
  ser el del asistente (`disassemble(wizardConfig)`), no el default.

## 8. Estrategia de persistencia

- **Archivo:** se escribe el config ensamblado con `writeConfigAtomic` + backup
  (mismo camino que cualquier escritura admin). Sustituye a `createDefaultConfigFile`.
- **Nube:** provisionar BD vacía → asistente → `seedCatalog(disassemble(wizardConfig))`.
  Cuidar el orden (provisionar → asistente → seed) y que `seedCatalog` siga siendo
  no-op sobre datos ya poblados (protección de catálogo de un compañero).

## 9. Manejo de errores

- Validación por paso: mensajes en español, junto al campo, sin permitir avanzar.
- Validación final con `validateConfigSchema`: si por algún motivo falla, se muestra
  el detalle y se vuelve al paso implicado (no se escribe nada).
- Persistencia: errores de NAS/D1 se reportan tal cual (regla §4, sin tragado
  silencioso); el asistente conserva lo introducido para reintentar.

## 10. Tests (regla §7)

- Ensamblado del asistente → config que pasa `validateConfigSchema`.
- Mínimos forzados: el asistente rechaza terminar sin parámetros completos / sin
  tramo / sin proveedor / sin producto con PVP / sin pack.
- `buildEmptyConfig()` produce una forma válida estructuralmente (claves v4) con
  colecciones vacías y `parameters` en blanco.
- Caso end-to-end: un catálogo mínimo tecleado en el asistente produce un cálculo
  correcto en `calculatePack`.
- Persistencia: archivo (escritura atómica + backup) y nube (seed con catálogo del
  asistente, no-op si ya poblado).

## 11. Impacto en documentación

- **CLAUDE.md** — nuevo debate (2026-06-16) que **enmienda** el debate de
  productización ("el seed por defecto pasa a ser un catálogo demo neutro"): ya no
  hay catálogo demo ni seed por defecto; el primer arranque construye el catálogo
  desde cero con un asistente.
- **PLAN_Calculadora.md / ARCHITECTURE.md** — actualizar referencias a
  `buildDefaultConfig` y al sembrado por defecto.
- **docs/UI-UX.md** — estados del asistente de catálogo (pasos, validación, vacío).
- **docs/PRD.md** — el onboarding "desde cero" como requisito de producto.

## 12. Fuera de alcance (YAGNI)

- Importar/exportar catálogos entre instalaciones.
- Plantillas de catálogo por sector.
- Cualquier "cargar ejemplo" (explícitamente descartado).
- Reabrir la limpieza completa del password admin (solo se toca lo imprescindible).
