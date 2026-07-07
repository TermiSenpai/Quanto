# Tier 1 — Profesionalidad real

> Mejoras alineadas con CLAUDE.md (YAGNI, 2-3 usuarios, sin frameworks). Son las que más valor aportan sin abrir debate. Orden recomendado de ataque al final.

---

## 1. Tests automáticos del módulo de cálculo

**Por qué**: hoy `vitest` está en `devDependencies` pero no hay un solo test. Un cambio de tramo o de fórmula puede colarse silenciosamente. CLAUDE.md §7 ya lo prescribe.

**Alcance mínimo**:

- Crear carpeta `tests/` hermana de `renderer/`.
- Refactorizar (si no está hecho) `renderer/calculo.js` para que sus funciones acepten `cfg` por parámetro (no leer global `CFG`).
- Tests prioritarios:
  - `getTramo`: bordes 9, 10, 24, 25, 49, 50, 99, 100, 9999.
  - `calcularCostePrenda`: T1 vs T4, con/sin reducción, 1 y 2 caras.
  - `calcularPackPena`: 12 packs sin capucha 2c → T1, PVP 25.95, total 311.40 €.
  - `calcularPackMixto`: 7 URBAN + 5 CLASICA T1 → 193.40 €.
  - `buildDefaultConfig`: claves estructurales presentes.
  - `leerConfigDesdeArchivo`: archivos malformados, sin `window.PACKPRICE_CONFIG`.

**Archivos**:
- `tests/calculo.test.js` (nuevo)
- `tests/config.test.js` (nuevo)
- `tests/fixtures/config-valido.js` (nuevo)
- `tests/fixtures/config-roto.js` (nuevo)
- Posible refactor en `renderer/calculo.js` para inyectar `cfg`.

**Criterio de aceptación**:
- `npm test` corre verde sin tocar el `.exe`.
- Cobertura visible en stdout (no se requiere reporter HTML).
- Al menos 1 test por función pura listada arriba.

**Esfuerzo**: 1 jornada.

---

## 2. Logging persistente con `electron-log`

**Por qué**: hoy `console.error` se pierde en el `.exe` empaquetado. Cualquier bug del taller es invisible. CLAUDE.md §8.5 ya bendice esta dependencia.

**Alcance**:

- Añadir `electron-log` como **dependencia de runtime** (la primera; documentarlo en `CLAUDE.md` §8.3).
- Logs en `%APPDATA%\Quanto\logs\main.log` con rotación por tamaño (5 MB, 3 archivos).
- Niveles: `info` en arranque (versión, ruta de config, usuario), `warn` en conflicto detectado, `error` en cualquier fallo de IPC handler.
- Exponer un handler `log:read-last` para que un admin pueda ver los últimos N logs desde la UI (botón en modo admin → "Ver logs").

**Archivos**:
- `package.json` (añadir dependencia)
- `main.js` (configurar logger, sustituir `console.error`)
- `preload.js` (exponer `window.packprice.leerLogs`)
- `renderer/admin.js` + `renderer/index.html` (botón "Ver logs")

**Criterio de aceptación**:
- Tras ejecutar el `.exe` y forzar un error de lectura de config, el archivo de log contiene la entrada.
- El botón "Ver logs" muestra los últimos 200 renglones en un modal.
- `npm audit` no introduce vulnerabilidad crítica nueva.

**Esfuerzo**: medio día.

---

## 3. Validación de esquema del `config.js` al cargar

**Por qué**: `vm.runInNewContext` ejecuta el archivo pero no comprueba forma. Si alguien borra a mano `parametros.iva`, el cálculo devuelve `NaN` páginas más tarde. Fail-fast con mensaje claro evita una llamada de soporte.

**Alcance**:

- Función `validarConfig(cfg)` en `main.js` que comprueba presencia y tipo de campos críticos:
  - `version`, `parametros.{mo_eur_hora,iva,merma_pct,dtf_eur_metro,...}`
  - `modelos_roly.{BEAGLE,CLASICA,URBAN}.precio`
  - `tramos` con 4 entradas, `desde`/`hasta` numéricos crecientes
  - `packs.pena_completa.pvp.t1.sin_capucha_2c` (un sondeo por tipo de pack)
- Si falla: `{ ok: false, error: 'Config inválido: falta parametros.iva' }` al renderer.
- El renderer muestra diálogo nativo con detalle y opción "Abrir carpeta del config" + "Cargar config por defecto".

**Archivos**:
- `main.js` (función + uso en `config:read`)
- `renderer/app.js` (manejo del error de validación)

**Criterio de aceptación**:
- Test de unidad alimenta `validarConfig` con 5 configs rotas (falta IVA, tramos en orden inverso, precio negativo, modelos faltante, packs vacíos) y todas devuelven mensaje legible.
- Test con config completo del default pasa.

**Esfuerzo**: medio día (con tests).

---

## 4. Historial de presupuestos local (V3 del plan)

**Por qué**: hoy cada cálculo se evapora al cerrar la app. No se puede reabrir un presupuesto antiguo, ni darle número al cliente. Es el cambio que más percepción de "empresa" da.

**Alcance**:

- Almacenamiento en `%APPDATA%\Quanto\presupuestos.json` (JSON Lines o array, indiferente para <10k entradas).
- Numeración correlativa: `PP-AAAA-NNNN` reiniciando el contador cada año.
- Esquema por entrada:
  ```js
  {
    id: 'PP-2026-0042',
    fecha: '2026-05-11T14:32:00Z',
    usuario: 'Alberto',
    cliente: { nombre, contacto },         // opcional
    packs: [ { tipo, modelo, cantidad, caras, ... } ],
    totales: { sin_iva, iva, total },
    config_version: '2.0.0-beta'           // para auditar PVP usado
  }
  ```
- IPC: `presupuestos:listar`, `presupuestos:guardar`, `presupuestos:buscar(query)`, `presupuestos:eliminar(id)`.
- UI: pestaña "Historial" con tabla (ID, fecha, cliente, total), buscador por ID/cliente, botón "Reabrir" que rellena el formulario.

**Archivos**:
- `main.js` (handlers IPC + helpers de archivo)
- `preload.js` (expone `window.packprice.presupuestos.*`)
- `renderer/historial.js` (nuevo)
- `renderer/app.js` (botón "Guardar presupuesto" al final del cálculo)
- `renderer/index.html` (sección historial)
- `renderer/styles.css` (estilos de la tabla)

**Criterio de aceptación**:
- Tras cerrar y reabrir la app, los presupuestos guardados siguen ahí.
- Reabrir un presupuesto rellena la pantalla con los valores exactos y los totales coinciden.
- Buscar por `PP-2026-` filtra correctamente.

**Esfuerzo**: 1-2 jornadas.

---

## 5. Exportación PDF del presupuesto

**Por qué**: lo que el cliente recibe define la percepción del negocio. `webContents.printToPDF()` viene en Electron, cero dependencias nuevas.

**Alcance**:

- Plantilla HTML dedicada en `renderer/pdf/plantilla.html` con CSS de impresión propio.
- Incluye: logo (PNG en `assets/`), datos del taller (de config), número de presupuesto, fecha, validez (30 días configurable), desglose por pack, totales sin IVA / IVA / total, pie con condiciones.
- IPC `pdf:exportar(presupuestoId, rutaDestino)` → abre `BrowserWindow` oculta con la plantilla, ejecuta `printToPDF`, guarda el archivo, devuelve `{ ok: true, ruta }`.
- Botón "Exportar PDF" en historial y al cerrar un cálculo nuevo. `dialog.showSaveDialog` para elegir destino con nombre por defecto `PP-2026-0042.pdf`.

**Archivos**:
- `assets/logo.png` (nuevo; pedir el archivo al usuario)
- `renderer/pdf/plantilla.html` (nuevo)
- `renderer/pdf/estilos.css` (nuevo)
- `main.js` (handler `pdf:exportar`)
- `preload.js` (expone función)
- `renderer/app.js` + `renderer/historial.js` (botones)

**Config adicional** en `config.default.js`:
```js
empresa: {
  nombre: 'Mi Taller DTF',
  cif: '',
  direccion: '',
  telefono: '',
  email: '',
  web: ''
},
presupuesto: {
  validez_dias: 30,
  condiciones: 'Precios IVA incluido. Validez 30 días desde la fecha de emisión. ...'
}
```

**Criterio de aceptación**:
- PDF generado abre correctamente, se ve idéntico en Chrome/Edge/Acrobat.
- El total del PDF coincide con el total mostrado en pantalla al céntimo.
- Logo se ve nítido a tamaño A4.
- El nombre de archivo por defecto es el ID del presupuesto.

**Esfuerzo**: 2 jornadas (la plantilla bonita lleva más de lo que parece).

---

## 6. Auditoría real de cambios admin

**Por qué**: hoy se guarda `modificado_por` y se hace backup, pero no hay registro de **qué campos** cambiaron. "¿Quién subió el IVA al 23?" sigue siendo arqueología contra los backups.

**Alcance**:

- Archivo `audit.log` en el NAS junto al `config.js`, append-only, JSON Lines:
  ```json
  {"ts":"2026-05-11T14:32:00Z","usuario":"Alberto","cambios":[{"path":"parametros.iva","de":21,"a":23}]}
  ```
- En `config:write` de `main.js`, diff entre el config previo y el nuevo (recorrido recursivo simple, claves planas tipo `parametros.iva`, `packs.pena_completa.pvp.t1.sin_capucha_2c`).
- Visor en modo admin: pestaña "Auditoría" con últimas 200 entradas, filtro por usuario y fecha.

**Archivos**:
- `main.js` (función `diff(antes, despues)`, escritura del audit log)
- `preload.js` (expone `auditoria:listar`)
- `renderer/admin.js` (pestaña nueva)
- `renderer/index.html` + `renderer/styles.css`

**Criterio de aceptación**:
- Tras cambiar IVA en admin y guardar, el `audit.log` añade una línea con el diff exacto.
- Si el cambio falla a mitad de escritura, el audit no se actualiza (orden: backup → write → audit).
- La pestaña "Auditoría" muestra las entradas ordenadas de más nuevas a más viejas.

**Esfuerzo**: 1 jornada.

---

## 7. Diff visual al guardar modo admin

**Por qué**: errores tipográficos en `parametros.iva` o un `pvp` cuestan dinero. Mostrar "vas a cambiar 21 → 23, confirmar" filtra el 90%.

**Alcance**:

- Antes de llamar a `config:write`, calcular diff en el renderer y mostrar modal:
  ```
  Vas a guardar 3 cambios:
   • parametros.iva: 21 → 23
   • parametros.mo_eur_hora: 15 → 18
   • packs.pena_completa.pvp.t1.sin_capucha_2c: 25.95 → 26.95
  [Cancelar]  [Confirmar y guardar]
  ```
- Reutiliza la función `diff` del punto 6 (compartirla en `renderer/utils.js`).
- Cancelar revierte; confirmar manda a `config:write`.

**Archivos**:
- `renderer/utils.js` (función `diff`, compartida con auditoría)
- `renderer/admin.js` (interceptar "Guardar")
- `renderer/index.html` + `renderer/styles.css` (modal)

**Criterio de aceptación**:
- Sin cambios reales, el botón "Guardar" no abre el modal (o avisa "no hay cambios").
- Cancelar no escribe nada (verificable en `audit.log` y `mtime` del config).
- Confirmar escribe exactamente lo previsualizado.

**Esfuerzo**: medio día.

---

## Orden recomendado de ataque

1. **#3 Validación de esquema** — barato, alto valor defensivo, base para confiar en lo siguiente.
2. **#1 Tests del cálculo** — red de seguridad antes de tocar más cosas.
3. **#2 `electron-log`** — observabilidad mínima.
4. **#6 Auditoría** + **#7 Diff visual** — van juntos, comparten código.
5. **#4 Historial** — el más grande de los "fáciles".
6. **#5 PDF** — lo último porque depende del historial y del logo.

Total estimado: ~7 jornadas de trabajo enfocado.
