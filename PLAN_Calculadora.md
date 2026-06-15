# PackPrice · Plan completo (calculadora de packs)

> Documento de referencia con todas las decisiones, parámetros, fórmulas, riesgos y arquitectura del proyecto. Generado al cierre de la sesión de diseño y entrega de V1 web + V2 Electron.

---

## 1. Contexto y objetivo

**Cliente / proyecto**: empresa de personalización textil DTF en Guadalajara (España), más de 25 años en el sector. La calculadora interna se llama **PackPrice**.

**Objetivo del proyecto**: dotar al taller de una calculadora interna para presupuestar rápidamente "packs de peña" (encargos típicos de grupos de amigos en verano) con varias modalidades, manteniendo márgenes sanos y permitiendo comunicar precios públicos consistentes con descuento por volumen.

**Posicionamiento comercial**: profesional, no low-cost. Argumentario apoyado en experiencia, garantía de reposición ante defectos y servicio cercano. El precio es un factor pero no el principal.

---

## 2. Modelo de costes y márgenes

### 2.1. Parámetros base

| Concepto                    | Valor                      | Notas                                 |
| --------------------------- | -------------------------- | ------------------------------------- |
| Mano de obra imputada       | 15 €/h por persona         | Tasa interna, no sueldo               |
| Tiempo base 2 caras         | 5 min/prenda               | Reducciones por volumen aplicables    |
| Tiempo base 1 cara          | 3 min/prenda               | ~60% del tiempo a 2 caras             |
| Reducción tiempo T2 (25-49) | −10%                       | Por mejora de ritmo y nesting         |
| Reducción tiempo T3 (50-99) | −15%                       |                                       |
| Reducción tiempo T4 (100+)  | −20%                       |                                       |
| DTF (película + tinta)      | 1,25 €/metro lineal        | Confirmado: incluye película y tinta  |
| DTF metros 2 caras          | 0,40 m/prenda              |                                       |
| DTF metros 1 cara           | 0,20 m/prenda              |                                       |
| Planchado                   | 0,30 €/cara                | Media 0,25-0,35 €                     |
| Merma materiales            | 10%                        | A revisar con datos reales            |
| Indirectos                  | 0,30 €/prenda              | Luz, mantenimiento, packaging         |
| Envío Roly                  | 5,90 €/bulto (~40 prendas) | Se prorratea entre prendas del pedido |
| Coste 3XL                   | por producto (`extra_cost_3xl`) | Coste interno por prenda 3XL, NO se factura (ver 2.4) |
| Recargo 4XL                 | +3 €/prenda                | Directo al cliente                    |
| Recargo 5XL+                | +5 €/prenda                | Directo al cliente                    |
| IVA                         | 21%                        | Tratado por separado del coste        |
| Margen objetivo por defecto | 35% (`default_target_margin`) | Para el PVP recomendado (ver 2.5)  |
| Redondeo psicológico        | a `x,95` (`price_rounding_ending`) | El PVP recomendado redondea hacia arriba |

> **Nota (esquema v4)**: a partir de v4 todos estos parámetros, los productos, los proveedores, los packs y los complementos son **editables desde el modo admin**. El antiguo "Buffer 3XL" fijo de 0,40 €/pack desaparece; el coste 3XL pasa a ser un coste real por prenda configurable en cada producto (`extra_cost_3xl`). Ver §2.4 y §15 (historial v4).

**Sobre el IVA**: el IVA soportado en compras (Roly, DTF, envío) NO se incluye como coste al calcular el margen. Se deduce trimestralmente en el Modelo 303 contra el IVA repercutido. Lo que sí afecta es la tesorería entre que pagas Roly con IVA y cobras al cliente con IVA repercutido.

### 2.2. Productos y proveedores

En v4 cada **producto** (garment) tiene una `category`, un coste 3XL propio (`extra_cost_3xl`), un margen objetivo, su propia tabla de PVP (caras × tramo) y una lista de **proveedores** (`suppliers`), de los cuales exactamente uno es el predeterminado (`is_default`). El precio del proveedor predeterminado es el que alimenta el coste. Los proveedores se registran aparte en la sección `suppliers` (Roly y, en el futuro, otros).

Productos sembrados por defecto (proveedor predeterminado: Roly):

| Producto | Categoría | Ref. Roly    | Precio   | Coste 3XL | Uso                  |
| -------- | --------- | ------------ | -------- | --------- | -------------------- |
| BEAGLE   | tshirt    | CA65540558   | 1,7325 € | 0,40 €    | Camiseta             |
| CLASICA  | hoodie    | SU10700558   | 6,2475 € | 0,60 €    | Sudadera sin capucha |
| URBAN    | hoodie    | SU1067050258 | 7,8750 € | 0,60 €    | Sudadera con capucha |

Precios sin recargo por talla 2XL. El recargo de Roly por tallas 3XL+ se cubre con el coste interno `extra_cost_3xl` por producto (3XL, no facturado) y con los recargos directos al cliente (4XL/5XL+). Ver §2.4.

### 2.3. Tramos de volumen

| Tramo | Rango     | Reducción tiempo | Etiqueta          |
| ----- | --------- | ---------------- | ----------------- |
| T1    | 10-24 uds | 0%               | Pedido pequeño    |
| T2    | 25-49 uds | 10%              | Pedido medio      |
| T3    | 50-99 uds | 15%              | Pedido grande     |
| T4    | 100+ uds  | 20%              | Pedido muy grande |

El "uds" es packs en pack peña, prendas individuales en los demás packs, o suma de sudaderas en el pack mixto.

### 2.4. Tratamiento de tallas grandes (3XL / 4XL / 5XL+)

- **3XL — coste interno, NO se factura.** En v4 no hay buffer fijo por pack. Cada producto declara su `extra_cost_3xl` (coste real del recargo de Roly en esa talla). Para un pedido, el sistema añade al coste interno `qty_3xl × MAX(extra_cost_3xl de los productos del pedido)`. El **MAX** es deliberadamente conservador: si el pedido mezcla camisetas (0,40 €) y sudaderas (0,60 €), se imputa 0,60 € a cada unidad 3XL, para no perder dinero nunca con el mix de tallas. El cliente paga el mismo PVP.
- **4XL / 5XL+ — recargo directo al cliente.** Siguen siendo recargos al cliente (+3 € / +5 € por prenda), sumados al total IVA incluido.
- Las cantidades `qty_3xl + qty_4xl + qty_5xl` no pueden superar el número de prendas del pedido.

### 2.5. PVP recomendado

El admin puede pedir un **PVP recomendado** para cualquier celda de precio (botón "Aplicar PVP recomendado"):

```
pvp_recomendado = redondear_arriba( coste / (1 − margen_objetivo) )  hasta el siguiente x,95
```

- `margen_objetivo` por defecto es `default_target_margin` (35%); cada producto/pack puede llevar el suyo.
- El redondeo sube al siguiente valor terminado en `price_rounding_ending` (0,95 → 15,38 → 15,95).
- El sistema informa del **margen real** que queda tras el redondeo. El PVP sigue siendo editable a mano; la sugerencia no se impone.

### 2.6. Complementos (addons)

Los extras opcionales (nombre, manga corta, manga larga, …) se configuran en la sección `addons`. Cada uno tiene `label`, `price` (con o sin IVA según `vat_included`), `cost` (coste interno real, para que el margen sea honesto) y `applies_to` (categorías de producto a las que aplica, o `*` para todas). Sustituyen a los antiguos parámetros fijos `extra_*_eur`.

---

## 3. Packs comerciales

Packs sembrados por defecto. Mínimo 10 unidades en todos. Pedidos por debajo de 10 quedan **fuera de la app**, fuera de la oferta peña, y se cotizan como "mini-grupo" manualmente con precios más altos para compensar el coste fijo de gestión.

> **Modelo de packs en v4**: cada pack declara un `pricing_mode`. Los packs **`bundle`** (como el Pack Peña) se venden como unidad con su propia tabla `bundle_prices` indexada por combinación de opciones × tramo; el input es el número de packs. Los packs **`components`** (camisetas, sudaderas, mixto, personalizado) facturan cada componente al PVP de su producto; el input es la cantidad por componente y el tramo se calcula sobre la suma. Las opciones (caras, capucha, …) se declaran en la config; el pack personalizado usa `free_components` para añadir líneas libres. Un solo motor genérico (`calculatePack`) cubre todos los casos; ya no hay calculadoras codificadas por tipo de pack. Todos los packs son **editables desde el modo admin** en v4.

### 3.1. Pack Peña (camiseta + sudadera)

Pack base. Combina BEAGLE + CLASICA (sin capucha) o BEAGLE + URBAN (con capucha). El cliente elige tipo de sudadera y caras estampadas.

**PVP IVA incluido**:

| Tramo      | Sin capucha 2c | Sin capucha 1c | Con capucha 2c | Con capucha 1c |
| ---------- | -------------- | -------------- | -------------- | -------------- |
| T1 (10-24) | 25,95 €        | 22,95 €        | 28,95 €        | 25,95 €        |
| T2 (25-49) | 24,95 €        | 21,95 €        | 27,95 €        | 24,95 €        |
| T3 (50-99) | 23,95 €        | 20,95 €        | 26,95 €        | 23,95 €        |
| T4 (100+)  | 22,95 €        | 19,95 €        | 25,95 €        | 22,95 €        |

**Regla**: 1 cara = 2 caras − 3 €.

### 3.2. Pack solo camisetas (BEAGLE)

Solo camisetas estampadas. Mínimo 10 camisetas.

**PVP IVA incluido**:

| Tramo      | 2 caras | 1 cara |
| ---------- | ------- | ------ |
| T1 (10-24) | 9,95 €  | 8,95 € |
| T2 (25-49) | 8,99 €  | 7,99 € |
| T3 (50-99) | 8,45 €  | 7,45 € |
| T4 (100+)  | 7,99 €  | 6,99 € |

### 3.3. Pack solo sudaderas SIN capucha (CLASICA)

Solo sudaderas sin capucha. Mínimo 10 sudaderas. **PVP provisionales pendientes de revisar**.

| Tramo      | 2 caras | 1 cara  |
| ---------- | ------- | ------- |
| T1 (10-24) | 14,95 € | 12,95 € |
| T2 (25-49) | 13,95 € | 11,95 € |
| T3 (50-99) | 12,95 € | 10,95 € |
| T4 (100+)  | 12,45 € | 10,45 € |

### 3.4. Pack solo sudaderas CON capucha (URBAN)

Solo sudaderas con capucha. Mínimo 10 sudaderas. **PVP provisionales pendientes de revisar**.

| Tramo      | 2 caras | 1 cara  |
| ---------- | ------- | ------- |
| T1 (10-24) | 16,95 € | 14,95 € |
| T2 (25-49) | 15,95 € | 13,95 € |
| T3 (50-99) | 14,95 € | 12,95 € |
| T4 (100+)  | 13,95 € | 11,95 € |

### 3.5. Pack mixto sudaderas

Combina X URBAN + Y CLASICA, total mínimo 10. **Cada sudadera se factura a su precio individual** del tramo correspondiente, donde el tramo se calcula sobre el TOTAL de sudaderas.

**Ejemplo**: 7 URBAN + 5 CLASICA, 2 caras → total 12 → tramo T1 → factura 7 × 16,95 € + 5 × 14,95 € = 193,40 €.

---

## 4. Reglas de cálculo

### 4.1. Determinación del tramo

A partir de la cantidad de uds (packs / camisetas / sudaderas según pack), el sistema busca el primer tramo cuyo rango la contenga.

### 4.2. Coste real por prenda terminada

```
coste_prenda = base_roly
             + envio_prorrateado
             + dtf
             + planchado
             + merma
             + mano_obra
             + indirectos
```

Donde:

- `envio_prorrateado` = `ceil(prendas_totales / 40) × 5,90 € / prendas_totales`
- `dtf` = `metros × 1,25 €` (0,50 € a 2 caras, 0,25 € a 1 cara)
- `planchado` = `caras × 0,30 €`
- `merma` = 10% de la suma de los anteriores
- `mano_obra` = `(minutos × (1 − reducción_tramo) / 60) × 15 €`
- `indirectos` = 0,30 € fijos

### 4.3. Coste total del pedido

```
coste_prendas = Σ (cantidad_línea × coste_prenda)        # por cada componente
coste_3xl     = qty_3xl × MAX(extra_cost_3xl del pedido)  # ver 2.4
coste_addons  = Σ (cantidad_addon × addon.cost)
coste_total   = coste_prendas + coste_3xl + coste_addons
```

Ya no existe un buffer 3XL fijo por pack: el coste 3XL se escala por la cantidad de unidades 3XL reales (§2.4).

### 4.4. Total final al cliente

```
subtotal        = ingreso de las líneas + complementos (IVA incl.)
                  · pack 'bundle'     → nº_packs × pvp_del_pack(combo, tramo)
                  · pack 'components' → Σ (cantidad × pvp_producto(caras, tramo))
recargos        = (4xl × 3 €) + (5xl+ × 5 €)
total_iva_inc   = subtotal + recargos + addons_iva_inc
base_venta      = total_iva_inc / 1,21
iva_repercutido = total_iva_inc − base_venta

margen € = base_venta − coste_total
margen % = margen € / base_venta        # sobre la base neta, NO sobre el total con IVA
```

> **Corrección v4**: el `margen %` se calcula sobre la **base de venta** (sin IVA), no sobre el total con IVA repercutido. Esto da la lectura correcta del margen comercial.

---

## 5. Riesgos identificados y mitigaciones

**5.1. Impago o cancelación**: cláusula de no devolución (Art. 103.c TRLGDCU), anticipo mínimo 50% en presencial, retención del anticipo si cancelan tras lanzar pedido a Roly.

**5.2. Rotura de stock en Roly**: cerrar stock antes de confirmar precio en pedidos >30 packs. Tener modelos alternativos identificados.

**5.3. Derechos del diseño**: cláusula firmada en hoja de pedido. El cliente declara tener derechos. La empresa queda exonerada.

**5.4. Merma real >10%**: medir en los primeros 3 pedidos grandes. Si supera 12% sistemáticamente, ajustar parámetro y subir PVP del tramo superior.

**5.5. Concentración de cliente**: ningún cliente debería superar el 25-30% de la facturación trimestral. Diversificar captación.

**5.6. Tiempo real > tiempo imputado**: cronometrar primeros pedidos. Si supera 5,5 min/prenda, ajustar parámetro y/o subir PVP. Mantener colchón 10-15% sobre tiempo medido.

---

## 6. Decisiones arquitectónicas

### 6.1. Caminos descartados y por qué

**SQLite directamente en NAS compartido (SMB)**: descartado por riesgo de corrupción documentado en la propia documentación de SQLite con escritura concurrente sobre SMB.

**Backend Node corriendo en cada PC con SQLite remoto compartido**: misma razón.

**Servidor central Node con HTTP sirviendo a otros PCs**: descartado porque el "servidor" disponible es solo un NAS de archivos, no permite ejecutar aplicaciones.

**SQLite en V1 con archivo único centralizado y un solo escritor**: técnicamente viable pero sobredimensionado para un fichero de configuración. Se sustituye por JSON.

**Web app file:// con ruta de config configurable**: descartado por limitaciones de seguridad del navegador. El navegador no permite leer rutas arbitrarias del filesystem desde `file://`, ni escribir, ni recordar handles entre sesiones. Forzaba selección manual del archivo cada vez.

### 6.2. Decisión final: Electron + config.js en NAS

**App de escritorio Electron** que cada PC tiene en local, leyendo y escribiendo un único `config.js` centralizado en el NAS de archivos.

**Razones**:

- Electron permite acceso completo al filesystem (es Node + Chromium)
- Lectura y escritura directa al NAS sin diálogos manuales
- Detección de conflictos al guardar mediante hash SHA-256 + timestamp
- Backups automáticos antes de cada escritura
- UX de app de escritorio nativa (diálogos Windows, "Explorar...", iconos)
- Misma lógica que la versión web, código JavaScript reutilizado al 100%
- No requiere infraestructura adicional (servidor, BD, etc.)

### 6.3. Stack técnico final

- **Electron** (proceso principal en Node.js + renderer en Chromium)
- **HTML + CSS + JavaScript vanilla** en el renderer (sin React/Vue)
- **Node.js fs** para acceso al filesystem
- **Escáner del bloque JSON + `JSON.parse`** para leer el `config.js` de forma segura (sin `eval`/`Function`/`vm`/`require`; ver `lib/config-parser.js`)
- **crypto SHA-256** para hash de detección de conflictos
- **electron-builder** para empaquetar el `.exe` portable
- **config.js** (JavaScript plano) como almacén de datos en NAS, no SQLite

---

## 7. Estructura de la app V2

```
packs app/
├── package.json              ← dependencias Electron + scripts build
├── main.js                   ← proceso principal: filesystem, IPC, ventana
├── preload.js                ← puente seguro main↔renderer
├── icon.png                  ← icono del .exe
├── README-build.md           ← instrucciones para construir
└── renderer/
    ├── index.html            ← UI completa (todas las pantallas)
    ├── app.js                ← lógica: cálculo, eventos, IPC con main
    └── styles.css            ← estilos paleta gris azulado modo claro
```

En cada PC, además, Electron crea automáticamente:

```
%APPDATA%\packprice\
└── settings.json             ← ruta del config + nombre del usuario
```

En el NAS, la primera vez que alguien guarda desde modo admin se crea:

```
\\172.26.0.154\Paep\Packs\
├── config.js                 ← archivo central de configuración
└── backups\                  ← backups con timestamp antes de cada escritura
    ├── config-2026-04-28T15-30-12.js
    └── config-2026-04-29T09-15-44.js
```

### 7.1. Buenas prácticas de seguridad Electron aplicadas

- `contextIsolation: true` y `nodeIntegration: false`: el renderer no tiene acceso directo a Node ni al filesystem
- `preload.js` expone solo APIs específicas vía `contextBridge`
- Toda operación de filesystem va por IPC al proceso principal, con lista blanca de rutas (`lib/path-guard.js`)
- Lectura de `config.js`: se escanea su bloque JSON y se hace `JSON.parse`. **Nunca** `eval`/`Function`/`vm`/`require` sobre el archivo externo (sería una puerta a RCE)
- Todo config leído pasa por `validateConfigSchema` (v4) antes de llegar al renderer; escrituras de config atómicas (`.tmp` + rename); límite de intentos en la verificación de la clave admin
- CSP restrictivo en HTML (`default-src 'self'`, `script-src 'self'`). Se mantiene `style-src 'unsafe-inline'` de forma deliberada porque la UI usa estilos inline; es un compromiso aceptado para una app de LAN sin red
- La clave de admin (texto plano en config) es **protección anti-clic-accidental, no seguridad real**

---

## 8. Flujos de la app V2

### 8.1. Primer arranque en un PC nuevo

1. La app abre, no encuentra `settings.json` local
2. Pantalla de bienvenida pide:
   - Nombre del usuario (Alberto, Fede, etc.)
   - Ruta del `config.js` en el NAS (botón "Explorar" abre diálogo nativo Windows)
3. Se valida que el archivo se puede leer
4. Se guarda `settings.json` en `%APPDATA%`
5. Arranca la calculadora

### 8.2. Arranque normal

1. Lee `settings.json` local
2. Lee `config.js` desde la ruta guardada
3. Si no es accesible (NAS desconectado, archivo movido) → pantalla de error con botón "Reintentar" y "Cambiar ubicación"
4. Si todo OK, pantalla principal con la lista de packs

### 8.3. Modo administrador con detección de conflictos

1. Cualquier usuario entra con la clave compartida
2. Antes de mostrar editor, app guarda **mtime + hash SHA-256** del archivo
3. Usuario edita parámetros / modelos / tramos / packs
4. Al pulsar "Guardar":
   - Vuelve a leer mtime + hash del archivo
   - Si cambió desde que abrió el editor → diálogo nativo: "El archivo fue modificado por [otro usuario] mientras editabas":
     - **Sobrescribir** (mis cambios ganan)
     - **Descartar mis cambios** (recargar)
     - **Cancelar** (sigo editando)
   - Si no cambió → backup automático + escritura
5. El config guardado lleva: `fecha_actualizacion` (con hora) y `modificado_por` (nombre del usuario)

### 8.4. Recargar config

Botón en cabecera. Re-lee el archivo del NAS y refresca la UI. Si hay modo admin abierto con cambios sin guardar, avisa antes.

### 8.5. Cambiar ubicación del config

En el modal "Ajustes locales". Diálogo nativo para seleccionar nuevo `.js`. Se valida que se puede leer antes de cambiar la ruta en `settings.json`.

---

## 9. Decisiones operativas

| Decisión                    | Valor                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| Stack backend               | Node.js (Electron)                                                                                |
| Stack frontend              | HTML + CSS + JS vanilla                                                                           |
| Almacén de datos compartido | `config.js` en NAS                                                                                |
| Almacén local de cada PC    | `settings.json` en `%APPDATA%`                                                                    |
| Distribución del .exe       | Manual a cada PC, copia local                                                                     |
| Identificación del usuario  | Pedida en primer arranque, persistida                                                             |
| Conflictos al guardar       | Avisar y dejar elegir (más seguro)                                                                |
| Backups del config          | Automáticos antes de cada escritura, en `<NAS>\Packs\backups\`                                    |
| Ruta del config recomendada | UNC: `\\172.26.0.154\Paep\Packs\config.js` (mejor que `Z:\` por independencia de letra de unidad) |

---

## 10. Bug detectado en V0 (calculadora Excel) y corregido en V2

**Bug**: en la calculadora Excel original (sesión anterior), el buffer 3XL de 0,40 €/pack se sumaba a CADA prenda en lugar de UNA vez al pack. Resultado: coste sobreestimado en ~0,40 €/pack.

**Impacto**: márgenes del estudio interno aparecen ~1 punto porcentual más bajos de lo real.

**Corrección**: la app V1 web y V2 Electron lo aplican correctamente (una vez por pack). El precio al cliente no cambia, solo la lectura interna del coste.

**Acción pendiente**: corregir la calculadora Excel si se sigue usando, o sustituirla por la app.

---

## 11. Roadmap de versiones

### V0 — Estudio Excel + DOCX

Entregado en sesión anterior. Estudio interno completo con costes, márgenes, escenarios, riesgos. Calculadora Excel con bug menor descrito arriba.

### V1 — Web file:// (entregada como prototipo)

App HTML/JS abierta con doble clic. Limitaciones: requiere descargar config modificado y subir manualmente al NAS, no soporta cambio de ruta.

**Sirve como referencia visual y de lógica**. La V2 reutiliza todo su código.

### V2 — Electron .exe (versión actual, en pruebas)

App de escritorio empaquetada como `.exe` portable. Lee y escribe directamente el `config.js` del NAS, modo admin con detección de conflictos, backups automáticos, identificación de usuario.

**En fase de pruebas locales antes de distribución a otros PCs.**

### V3 — Persistencia y exportación (futuro)

- Histórico local de presupuestos en `localStorage` o archivo local
- Exportación de presupuesto a PDF
- Datos del cliente (peña, contacto) en cada presupuesto
- Búsqueda y reapertura de presupuestos antiguos

### V4 — Centralización avanzada (futuro)

- Migración a SQLite con un PC del taller actuando como servidor HTTP
- Histórico de presupuestos compartido entre todos los usuarios
- Reportes (facturación trimestral, packs más vendidos, márgenes promedio)
- Posible integración con WooCommerce de PAEP Digital
- Auto-update del .exe (electron-updater)

---

## 12. Validaciones pendientes

| Asunción                                                | Valor actual                           | Acción                                                    |
| ------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| MO 15 €/h imputada                                      | Provisional                            | Contrastar con coste real (sueldo + SS + luz prorrateada) |
| Tiempo 5 min/prenda 2 caras                             | Provisional                            | Cronometrar 3 pedidos, si supera 5,5 ajustar              |
| Merma 10%                                               | Provisional                            | Registrar prendas perdidas en 3 pedidos y calcular % real |
| DTF 0,40 m por prenda 2 caras                           | Provisional                            | Medir consumo real                                        |
| Buffer 3XL 0,40 €/pack                                  | Provisional                            | Si tallas 3XL+ superan 25% del mix, subir buffer          |
| Envío Roly 5,90 €/bulto                                 | Confirmado por captura                 | Verificar que se mantiene en pedidos grandes              |
| **PVP packs nuevos** (camisetas, CLASICA, URBAN, mixto) | Provisionales / parcialmente revisados | Validar todos los tramos antes de uso comercial           |
| Tipo IVA 21%                                            | Confirmado para textil personalizado   | —                                                         |

**Revisión recomendada con Anguix (gestor)**:

- Estructura de facturación del pedido (un solo albarán o por lote)
- Tratamiento fiscal del anticipo retenido en cancelaciones
- Compatibilidad de la cláusula Art. 103.c TRLGDCU con la facturación B2C habitual de peñas
- Implicaciones de ingresos concentrados para la estimación directa del IRPF

---

## 13. Comandos útiles (V2 Electron)

En la carpeta del proyecto descomprimido:

```bash
pnpm install              # instalar dependencias (solo primera vez)
pnpm dev              # ejecutar en modo desarrollo (sin construir .exe)
pnpm build:win        # generar .exe portable en dist/
```

El `.exe` resultante: `dist/PackPrice-2.0.0-portable.exe`.

---

## 14. Resolución de problemas comunes

| Problema                              | Causa probable                     | Solución                                                                                |
| ------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm install` falla con permisos      | Terminal sin permisos              | Ejecutar como administrador                                                             |
| Build avisa de "code signing"         | .exe no firmado                    | Para uso interno no hace falta firmar; añadir `"sign": null` en package.json si bloquea |
| Windows SmartScreen avisa al ejecutar | .exe sin firma digital             | "Más información" → "Ejecutar de todas formas". Solo primera vez por PC                 |
| App no encuentra config.js            | NAS desconectado o ruta incorrecta | Comprobar unidad mapeada o usar Ajustes para cambiar ruta                               |
| Conflicto al guardar                  | Otro usuario modificó el archivo   | Diálogo nativo permite elegir qué hacer. Backup automático ya creado                    |
| Diálogo aparece aunque solo edito yo  | Hash compara archivo entero        | Es comportamiento esperado, basta con elegir "Sobrescribir"                             |

---

## 15. Historial de decisiones (timeline resumido)

1. Sesión 1 — Estudio Excel + DOCX. Estudio de costes, márgenes y riesgos. Calculadora Excel y dos DOCX (hoja de pedido + estudio interno).
2. Sesión 2 — Diseño de la app. Aclaración de constraints reales (NAS solo de archivos, 2 usuarios). Iteración de decisiones técnicas: SQLite descartado a favor de JSON. Web `file://` descartada por limitaciones del navegador. Electron elegido.
3. Sesión 2 (cont.) — Implementación V2 Electron. Filesystem real, settings local en `%APPDATA%`, detección de conflictos por hash, backups automáticos, diálogos nativos.
4. Tier-1 — Profesionalidad real: validación de esquema, logs (`electron-log`), auditoría con diff, historial de presupuestos, exportación PDF. Inicio de la migración del código a inglés.
5. **Esquema y motor v4 — Configurabilidad total.** El catálogo entero pasa a ser editable desde el admin: nuevas secciones `suppliers`, `products` (sustituye `roly_models`, con tabla de precios propia, multi-proveedor y `extra_cost_3xl`) y `addons` (sustituye los `extra_*_eur` fijos). Las cuatro calculadoras codificadas se unifican en un solo `calculatePack` dirigido por `pricing_mode` (`bundle`/`components`) y opciones declaradas. El buffer 3XL fijo desaparece (coste 3XL real por producto, MAX sobre el pedido, no facturado). PVP recomendado (coste + margen objetivo + redondeo a `x,95`). Correcciones: guard de tramo nulo, `margen %` sobre la base neta, tallas grandes acotadas al pedido. Migración v3→v4 idempotente (`lib/migrations.js`). Endurecimiento de seguridad (lista blanca de rutas IPC, validación de payloads, límite de intentos admin, escrituras atómicas). Migración del tooling a **pnpm**.
6. Pendiente — Pruebas locales con `pnpm dev`, validación de comportamiento, ajuste fino de PVP de packs nuevos, distribución del `.exe` al segundo PC.

---

## 16. Aspectos a tener en cuenta a futuro

- **El `config.js` del NAS es el punto único de verdad**. Si se borra accidentalmente, los backups en `\Packs\backups\` permiten restaurarlo. Convendría hacer copia periódica del `config.js` y los backups a otro disco/medio para protección frente a fallo del NAS.
- **El `.exe` no está firmado digitalmente**. Para 2 usuarios internos no merece la pena pagar certificado (~200-400 €/año). Aceptar el aviso de SmartScreen la primera vez en cada PC.
- **Cuando saquemos V3 con cambios de código**, hay que redistribuir el `.exe` manualmente. Si crece el número de usuarios, valorar añadir auto-update.
- **El bug del buffer 3XL en la Excel** sigue ahí si la usas. Si la app V2 es la herramienta de uso diario, la Excel queda como referencia histórica únicamente.
- **Los PVP de los packs nuevos** son la pieza más débil del modelo actual. Validarlos con un par de pedidos reales antes de comunicarlos en flyer o web.

---

_Documento generado al cierre de la sesión de diseño. Actualizar conforme evolucione el proyecto._
