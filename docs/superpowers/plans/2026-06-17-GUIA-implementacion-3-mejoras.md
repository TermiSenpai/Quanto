# Guía de implementación — 3 mejoras (complementos, descripciones, envío por proveedor)

> Guía operativa para implementar, **de forma progresiva y profesional**, los tres
> planes independientes. No reemplaza a los planes: los **orquesta**. Cada plan es
> autónomo (produce software funcional por sí solo); esta guía dice en qué orden,
> con qué preparación, con qué buenas prácticas y cómo encajan entre sí.

**Planes que orquesta:**
- **A · Bug complementos (€/unidad):** [2026-06-17-addon-per-unit-price-fix.md](2026-06-17-addon-per-unit-price-fix.md)
- **B · Descripciones por campo:** [2026-06-17-per-field-help-descriptions.md](2026-06-17-per-field-help-descriptions.md)
- **C · Envío por proveedor (esquema v4.1):** [2026-06-17-per-supplier-shipping.md](2026-06-17-per-supplier-shipping.md)

---

## 1. Orden recomendado y por qué

**A → B → C**, una pieza completa cada vez (no en paralelo):

1. **A primero** — es el más pequeño y arregla un fallo **visible** (el €/persona no refleja los complementos). Desbloquea valor enseguida y toca poco (`calculo.js` + 2 puntos de `app.js`).
2. **B después** — aditivo, sin cambio de esquema. Mejora la usabilidad del catálogo y del asistente.
3. **C al final** — es el grande: **cambio de esquema v4.0 → v4.1**, migración (archivo + nube), motor y editor. Conviene hacerlo cuando A y B ya están integrados y estables.

> **Regla de oro de esta guía:** implementa **un plan entero, mézclalo en `develop`, y arranca el siguiente desde `develop` actualizado.** Así evitas conflictos (A y C tocan `calculo.js`; B y C tocan `admin.js` y `styles.css`) y cada plan parte de una base verde.

---

## 2. Preparación (una sola vez, antes de empezar)

- [ ] **Resolver los cambios sueltos de `GITHUB_REPO`.** El árbol de `develop` tiene cambios sin commitear en `CLAUDE.md`, `docs/PRD.md`, `main.js` (renombrado del repo a `TermiSenpai/Quanto`). Commitéalos **aparte** antes de empezar, para que cada plan arranque desde una base limpia:
  ```bash
  git add CLAUDE.md docs/PRD.md main.js
  git commit -m "chore: point GITHUB_REPO at the renamed repo (TermiSenpai/Quanto)"
  ```
- [ ] **Base verde.** Con el árbol limpio:
  ```bash
  pnpm test   # debe salir 100% verde antes de tocar nada
  ```
- [ ] **Decide la herramienta de ejecución** (igual para los tres):
  - **Subagentes** (recomendado): un subagente por tarea + revisión **spec → calidad** entre tareas.
  - **En línea**: tareas por lotes con puntos de control.

---

## 3. Buenas prácticas (aplican a los TRES planes)

Estas son las reglas que CADA tarea de cada plan debe respetar:

- **TDD estricto por tarea:** escribe el test → vélo fallar por el motivo correcto → implementa lo mínimo → vélo pasar → corre la suite completa → commit. Nunca implementación antes que test cuando el plan lo pide.
- **Commits frecuentes y verdes:** un commit por tarea; `pnpm test` **verde en cada commit**. Si una tarea deja la suite roja, no se commitea: o se completa la pieza acoplada o se reordena.
- **Diff mínimo, patrones existentes:** sigue el estilo del fichero que tocas (`'use strict'`, `const`, 2 espacios, comillas simples, CommonJS en `lib/`/`main`, ESM en `renderer/`). No refactorices de más.
- **Reglas duras de CLAUDE.md §3** (las que aplican aquí):
  - **§2 Nada de números de negocio en código** — precios, envíos, mermas, etc. van en `config` (esto es justo lo que refuerza el plan C).
  - **§3 El renderer nunca toca el filesystem/Node** — solo vía `window.packprice.*` (IPC).
  - **§5 Ningún cambio de esquema persistido sin backup + migración idempotente** — clave en C (`migrateConfigV4_0ToV4_1` + SQL aditiva `0002`).
  - **§7 Los tests viajan con cualquier cambio de cálculo o esquema** — A y C lo exigen.
  - **§9 Sin dependencias/build nuevos.**
- **Revisión doble (si usas subagentes):** primero **cumplimiento de spec** (¿construyó exactamente lo pedido, ni más ni menos?), luego **calidad** (¿está limpio, nombrado, testeado?). No pases a la siguiente tarea con hallazgos abiertos.
- **Smoke en máquina real:** la GUI de Electron **no se puede lanzar en este entorno** (sandbox). Todo lo visual (titular €/unidad en A, tooltips en B, editor de proveedores en C) se revisa **estáticamente + tests**, y se **marca como pendiente de smoke** en una máquina real antes de dar por cerrado.
- **Comentarios el *por qué*, no el *qué*.** Mensajes de commit en presente, con el *trailer*:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Nunca** `git --no-verify` / `--force`; **no** hacer push salvo que se pida.

---

## 4. Ciclo por plan (repetir A, luego B, luego C)

Para **cada** plan, sigue este ciclo:

```
1. Rama         git checkout develop && git pull (si aplica)
                git checkout -b feature/<nombre-corto>
2. Ejecuta      Implementa las tareas del plan EN ORDEN, con TDD y un commit por tarea.
                Tras cada tarea: pnpm test verde (+ revisión spec→calidad si subagentes).
3. Verifica     Repasa la "Definición de hecho" del plan. node --check en ficheros JS tocados.
4. Smoke        Anota explícitamente lo que NO se pudo probar en GUI (pendiente máquina real).
5. Cierra       git checkout develop
                git merge --no-ff feature/<nombre-corto>   (mensaje que agrupe la pieza)
                pnpm test   (verde sobre el resultado fusionado)
                git branch -d feature/<nombre-corto>
6. Siguiente    Arranca el siguiente plan desde develop ya actualizado.
```

### 4.A · Plan A — Bug complementos
- **Rama sugerida:** `feature/addon-per-unit-fix`
- **Tareas (ver el plan):**
  - [ ] **Tarea 1** — Motor: `extras_vat_inc` + `unit_price_with_extras` en el resultado de `calculatePack` (con tests en `calculo.test.js`).
  - [ ] **Tarea 2** — Renderer: el titular "PVP por pack/medio" usa `unit_price_with_extras` (2 puntos de `app.js`), etiqueta "(con extras)".
- **Puerta de verificación:** un complemento mueve el €/unidad (IVA inc) y el total sigue cuadrando; `unit_price` (líneas/PDF) y la línea de recargos 4XL/5XL **no cambian**.
- **DoD:** la del plan A. Mézclalo en `develop` antes de empezar B.

### 4.B · Plan B — Descripciones por campo
- **Rama sugerida:** `feature/field-help`
- **Tareas (ver el plan):**
  - [ ] **Tarea 1** — `renderer/field-help.js` (diccionario curado) + `tests/field-help.test.js`.
  - [ ] **Tarea 2** — CSS `.field__hint--clamp` (2 líneas + "…" + `cursor:help`).
  - [ ] **Tarea 3** — `admin.js`: helper `helpHint(key)` + inyectar bajo los campos (parámetros, producto, proveedor, complemento, tramo, pack). El asistente lo hereda gratis.
- **Puerta de verificación:** el texto sale recortado con "…" y completo al pasar el ratón, en admin **y** en el asistente.
- **DoD:** la del plan B. Mézclalo en `develop` antes de empezar C.

### 4.C · Plan C — Envío por proveedor (esquema v4.1)
- **Rama sugerida:** `feature/per-supplier-shipping`
- **Tareas (ver el plan) — el orden importa para mantener verde:**
  - [ ] **Tarea 1 (cimiento acoplado)** — esquema + `config.default.js` (quitar 2 claves de `PARAMETER_KEYS`, `SCHEMA_VERSION='4.1.0'`) + fixture (`config-v4-full.js`) + motor (`calculo.js`, agrupar por proveedor) + sus tests. **Todo junto, en un commit verde.**
  - [ ] **Tarea 2** — Migración `migrateConfigV4_0ToV4_1` (idempotente) + encadenado en `migrateConfig` + tests.
  - [ ] **Tarea 3** — Nube: SQL aditiva `db/migrations/0002_add_supplier_shipping.sql` + mapeo en `catalog-assembler.js` (ida y vuelta) + tests.
  - [ ] **Tarea 4** — Editor admin: campos de envío en el editor de proveedor + defaults en `addSupplier` + quitar los 2 inputs globales de Parámetros.
  - [ ] **Tarea 5** — Docs (CLAUDE.md debate, ARCHITECTURE, PLAN_Calculadora).
- **Puerta de verificación crítica:** un pedido **con un solo proveedor** reproduce los totales de antes; un pedido **mezclando dos proveedores** prorratea el envío de cada uno entre **sus** prendas. Una config v4.0 real (archivo o D1) migra idempotente a v4.1 al leerla.
- **DoD:** la del plan C, incluyendo backup + migración (regla §5) y tests (§7).

---

## 5. Interacciones entre planes (importante)

Por hacerlos en orden y mezclando entre medias, los conflictos se evitan, pero hay **dos toques cruzados** a tener en cuenta:

1. **`calculo.js` (A ↔ C):** A añade campos al resultado cerca del `return`; C cambia `calculateGarmentCost` y el bucle de coste. Regiones distintas, pero **haz A → merge → C** y C parte de un `calculo.js` que ya tiene los campos de A (sin conflicto).
2. **Descripciones del envío (B ↔ C):** el diccionario de B **no** incluye los antiguos parámetros globales de envío (a propósito, porque C los elimina). Cuando hagas **C después de B**, añade en `renderer/field-help.js` dos entradas para los campos **por proveedor** y cablea `helpHint` en los inputs nuevos del editor de proveedor (Tarea 4 de C):
   ```js
   // en FIELD_HELP (renderer/field-help.js)
   shipping_eur_bundle: 'Coste de envío que te cobra este proveedor por cada bulto. Envío gratis = 0.',
   garments_per_bundle: 'Cuántas prendas caben en un bulto de este proveedor. Sirve para prorratear el envío.',
   ```
   ```html
   <!-- en renderSupplierEditor, junto a cada input de envío -->
   ${helpHint('shipping_eur_bundle')}
   ${helpHint('garments_per_bundle')}
   ```
   Si haces C **sin** B, omite esto (no existe `helpHint`); los campos llevan su etiqueta normal.

---

## 6. Integración final y cierre (tras los tres)

- [ ] **Suite completa verde** en `develop` con los tres integrados (`pnpm test`).
- [ ] **Smoke en máquina real** (lo que el sandbox no permite), siguiendo el *Smoke checklist* de CLAUDE.md §8 **más**:
  - A: complemento → el €/persona sube (IVA inc) y el total cuadra.
  - B: tooltips de ayuda visibles y completos al pasar el ratón, en admin y asistente.
  - C: pedido con 1 proveedor (igual que antes) y pedido con 2 proveedores (prorrateo independiente); abrir una config v4.0 real y comprobar que migra a v4.1 sin perder datos (con backup).
- [ ] **Si se publica release:** entrada de devlog (`devlog/TEMPLATE.md`) y bump de `package.json:version` (C es cambio de esquema → conviene reflejarlo en la versión de la app).
- [ ] **Docs coherentes:** que ningún documento contradiga el estado final (CLAUDE.md, ARCHITECTURE, PLAN_Calculadora, UI-UX, PRD).

---

## 7. Definición de hecho (plantilla por tarea)

Una tarea está hecha cuando:

- [ ] Test escrito primero (si el plan lo pide), visto fallar y luego pasar.
- [ ] `pnpm test` verde (suite completa, no solo el fichero).
- [ ] `node --check` OK en los `.js` tocados (ESM con `--input-type=module` si hace falta).
- [ ] Sin reglas duras (§3) violadas; diff mínimo; sin deps nuevas.
- [ ] (Subagentes) revisión **spec** ✅ y **calidad** ✅, sin hallazgos abiertos.
- [ ] Commit con su *trailer*; nada de push ni `--no-verify`.
- [ ] Lo no verificable en GUI queda **anotado** como pendiente de máquina real.

---

*Guía generada junto a los tres planes. Si un plan cambia, actualiza también esta guía (regla: si el código deja de coincidir con los docs, arregla uno de los dos — nunca dejes un hueco silencioso).*
