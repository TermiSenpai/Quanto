# Tier 2 — UX del taller y robustez operativa

> Mejoras de usabilidad y robustez del día a día. No tocan arquitectura. Asumen que Tier 1 está hecho (especialmente historial de presupuestos y validación de config).

---

## 1. Modo "vendedor" vs "interno"

**Por qué**: en mostrador la pantalla puede verla el cliente. Hoy se ven costes, márgenes y parámetros internos. Un toggle que oculte todo lo que no sea PVP y total profesionaliza la interacción comercial.

**Alcance**:

- Toggle en la barra superior: "Vista cliente / Vista interna" (persistente en `settings.json`).
- En "Vista cliente" se ocultan:
  - Tabla de costes internos (mano de obra, DTF, indirectos).
  - Margen y % de beneficio.
  - Detalles de buffer 3XL+ (recargos al cliente sí se muestran).
- Atajo: `Ctrl+M` para alternar rápido.

**Archivos**:
- `renderer/index.html` (clases `.solo-interno`)
- `renderer/styles.css` (regla `body.vista-cliente .solo-interno { display: none }`)
- `renderer/app.js` (toggle + persistencia)
- `main.js` + `preload.js` si se quiere recordar entre sesiones (probable)

**Criterio de aceptación**:
- Al activar vista cliente, ningún número de coste interno es visible (revisar con DevTools cerrado).
- El toggle persiste tras reiniciar la app.
- `Ctrl+M` alterna sin foco perdido.

**Esfuerzo**: medio día.

---

## 2. Ficha de cliente ligera

**Por qué**: el historial sin cliente asociado es una tabla anónima. Asociar presupuestos a un cliente permite "todos los presupuestos de la peña Águilas 2026" y reabrir el último para hacer variaciones.

**Alcance**:

- Archivo `%APPDATA%\packprice\clientes.json` con array simple:
  ```js
  { id, nombre, contacto, notas, fecha_alta }
  ```
- Al crear presupuesto: autocompletado por nombre (datalist HTML5, sin librería). Crear cliente nuevo desde el mismo desplegable.
- Vista "Clientes" con tabla y filtro por nombre.
- Borrar cliente solo si no tiene presupuestos asociados (o avisar).

**Archivos**:
- `main.js` (handlers `clientes:*`)
- `preload.js`
- `renderer/clientes.js` (nuevo)
- `renderer/app.js` (datalist en el formulario)
- `renderer/index.html` + `renderer/styles.css`

**Criterio de aceptación**:
- Crear, listar, editar, borrar cliente funciona.
- Al teclear en el campo "cliente" del presupuesto, salen sugerencias de clientes ya existentes.
- Si borras un cliente con presupuestos, salta diálogo y bloquea o requiere confirmación explícita.

**Esfuerzo**: 1 jornada.

---

## 3. Comparador de packs

**Por qué**: parte del rol del vendedor es asesorar. "Si en lugar de pack peña vais a solo camisetas, os ahorráis 8 € por persona" es una conversación que hoy se hace a ojo.

**Alcance**:

- Modal "Comparar" que toma la cantidad actual y calcula en paralelo los 5 packs (peña, solo camisetas, solo CLASICA, solo URBAN, mixto si aplica).
- Tabla comparativa: pack, PVP/ud, total, diferencia vs el seleccionado.
- Botón "Cambiar a este pack" que rehace el formulario con la opción elegida.

**Archivos**:
- `renderer/comparador.js` (nuevo, función pura sobre `calculo.js`)
- `renderer/app.js` (botón "Comparar")
- `renderer/index.html` + `renderer/styles.css`

**Criterio de aceptación**:
- El comparador llama a `calculo.js` sin duplicar lógica.
- Los totales coinciden con los de cada pack si se calculasen por separado.
- El botón "Cambiar a este pack" recalcula la vista principal sin perder cantidad ni caras.

**Esfuerzo**: medio día (es UI sobre lógica ya existente).

---

## 4. Atajos de teclado

**Por qué**: en taller se trabaja rápido. Cinco atajos quitan una cantidad ridícula de clics al cabo del mes.

**Alcance**:

- `Ctrl+N` — nuevo presupuesto (limpia el formulario).
- `Ctrl+S` — guardar presupuesto en historial.
- `Ctrl+P` — exportar PDF (si Tier 1 #5 está hecho).
- `Ctrl+M` — alternar vista cliente / interna.
- `Ctrl+K` — buscar en historial.
- `F1` — abrir `PLAN_Calculadora.md` en un modal (ayuda contextual).

**Archivos**:
- `renderer/atajos.js` (nuevo, único listener global `keydown`)
- `renderer/app.js` (registrar)

**Criterio de aceptación**:
- Cada atajo funciona desde la pantalla principal.
- No interfieren cuando hay un `<input>` con foco (excepto los que tienen sentido, como `Ctrl+S`).
- Tooltip o ayuda visible al pulsar `F1`.

**Esfuerzo**: 2-3 horas.

---

## 5. Aviso de "config desactualizado"

**Por qué**: si dos PCs tienen la app abierta y una guarda en modo admin, la otra sigue trabajando con valores viejos hasta reiniciar. Un banner asíncrono evita errores silenciosos.

**Alcance**:

- En `main.js`, cada 30 s comparar `mtime` del config en NAS con el `mtime` cacheado al cargar.
- Si difiere: enviar evento `config:changed-externally` al renderer.
- Banner amarillo persistente: "El config se ha modificado desde otro PC. [Recargar] / [Ignorar]".
- "Recargar" hace `config:read` y refresca `CFG` en memoria sin reiniciar la app.

**Archivos**:
- `main.js` (intervalo + evento)
- `preload.js` (`onConfigChangedExternally(cb)`)
- `renderer/app.js` (banner)
- `renderer/index.html` + `renderer/styles.css`

**Criterio de aceptación**:
- Modificar `mtime` del config a mano (touch) y en <30 s aparece el banner.
- "Recargar" carga el nuevo config sin reiniciar.
- Si la app está en modo admin con cambios sin guardar, recargar pide confirmación y conserva los cambios pendientes.

**Esfuerzo**: medio día.

---

## 6. Buscador en modo admin

**Por qué**: a medida que crezcan parámetros (recargos por talla, modelos Roly nuevos, packs adicionales), el árbol del admin se vuelve laborioso. Un filtro de texto en tiempo real es trivial y útil.

**Alcance**:

- Caja de búsqueda arriba de cada pestaña de admin.
- Al teclear, se ocultan las filas/grupos cuyo label o path no contiene el texto.
- Resaltar coincidencias.

**Archivos**:
- `renderer/admin.js`
- `renderer/styles.css`

**Criterio de aceptación**:
- Filtra en <100 ms hasta 200 campos.
- Al borrar el texto, vuelve todo a la vista.
- Funciona también con paths (`packs.pena_completa.pvp`).

**Esfuerzo**: 2-3 horas.

---

## 7. Validación inline en modo admin

**Por qué**: hoy puedes meter `-5` en `iva`, `0` en `mo_eur_hora` o un string en un campo numérico, y solo se descubre al calcular. Validar al `blur` del campo evita configs rotos.

**Alcance**:

- Reglas declarativas por campo (mínimo, máximo, requerido, tipo):
  ```js
  { 'parametros.iva': { min: 0, max: 50, tipo: 'number' },
    'parametros.mo_eur_hora': { min: 0.01, tipo: 'number' },
    ... }
  ```
- En `blur`, validar y mostrar mensaje rojo bajo el input si falla. Bloquear "Guardar" hasta resolver.

**Archivos**:
- `renderer/validaciones.js` (nuevo)
- `renderer/admin.js`
- `renderer/styles.css`

**Criterio de aceptación**:
- Meter IVA negativo muestra error y bloquea guardar.
- Meter texto en un numérico marca error.
- Corregir limpia el error sin recargar.

**Esfuerzo**: medio día.

---

## 8. Modo oscuro

**Por qué**: cinco minutos de trabajo si la paleta ya está en variables CSS (`:root`). Mejora ergonomía en taller con luz baja.

**Alcance**:

- Variables CSS alternativas en `body.tema-oscuro`.
- Toggle en barra superior, atajo `Ctrl+Shift+L`.
- Persistir en `settings.json`.
- Respetar `prefers-color-scheme` en primer arranque.

**Archivos**:
- `renderer/styles.css`
- `renderer/app.js`

**Criterio de aceptación**:
- Contraste WCAG AA en ambos temas (verificar con DevTools).
- Persiste tras reiniciar.

**Esfuerzo**: 2-4 horas (depende de cuántos hard-codeos haya).

---

## Orden recomendado

1. **#4 Atajos** — la victoria más rápida, te acostumbras enseguida.
2. **#1 Vista cliente** — alto impacto comercial, bajo coste.
3. **#5 Aviso config desactualizado** — defensivo, complementa la auditoría del Tier 1.
4. **#7 Validación inline admin** — complementa la validación de esquema del Tier 1.
5. **#3 Comparador** — depende de que `calculo.js` sea limpio.
6. **#2 Ficha de cliente** — depende del historial del Tier 1.
7. **#6 Buscador admin** — solo cuando empiece a haber muchos parámetros.
8. **#8 Modo oscuro** — extra; hacerlo cuando alguien lo pida.

Total estimado: ~4-5 jornadas.
