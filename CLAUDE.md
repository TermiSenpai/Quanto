# CLAUDE.md — PackPrice

Guía de trabajo para Claude (y para humanos) en este repositorio. Léeme antes de tocar código. La meta es mantener una base **pequeña, predecible y fácil de mantener** durante años, con la mínima fricción para una empresa de 2-3 usuarios técnicos.

> Documento operativo, no aspiracional. Si algo de aquí ya no se cumple en el código, **arregla el código o arregla este documento**. No dejes desviaciones silenciosas.

---

## 1. Qué es esto

App de escritorio **Electron** para calcular precios de packs de personalización textil DTF (Direct-to-Film). Cada PC del taller tiene su `.exe` portable y comparte un único `config.js` en el NAS de la empresa.

- **Dominio**: PVP por tramo de volumen, costes internos, márgenes, IVA.
- **Usuarios**: 2-3 personas en el taller. No hay multi-tenant, ni internet público, ni telemetría.
- **Plan funcional completo**: ver `PLAN_Calculadora.md`. Es la fuente de verdad del modelo de negocio.

---

## 2. Stack y restricciones

| Pieza | Decisión | Por qué |
|---|---|---|
| Runtime | **Electron** + Node.js (main) + Chromium (renderer) | Acceso a filesystem real (NAS), UX de escritorio nativa |
| UI | **HTML + CSS + JS vanilla** | Cero build step, cero framework, cero ruido |
| Persistencia compartida | **`config.js` plano** en el NAS | Versionable, legible, restaurable a mano |
| Persistencia local | `settings.json` en `%APPDATA%\packprice\` | Nombre del usuario y ruta del config |
| Empaquetado | `electron-builder` portable Windows x64 | No requiere instalador |
| Idioma de UI | **Español** en strings visibles al usuario | El cliente y los usuarios son hispanohablantes |
| Idioma de código | **Inglés** en variables, funciones, comentarios, IPC channels y nombres de archivo | Más mantenible a largo plazo, alinea con el ecosistema Electron/Node |

> **Nota sobre la migración de idioma**: gran parte del código actual (`main.js`, `app.js`, `calculo.js`, `admin.js`, `lib/config-parser.js`) está escrito en español por razones históricas y se irá migrando progresivamente. Todo **código nuevo** se escribe en inglés desde el primer commit. Cuando toques un archivo legacy y el cambio sea sustancial, considera renombrar las identificadoras tocadas a inglés (sin convertir el archivo entero, para mantener diffs revisables). Las **strings visibles al usuario** (UI, mensajes de error mostrados) siguen en español.

**No usamos** (y no debemos añadir sin justificación documentada):

- React / Vue / Svelte / cualquier framework UI
- TypeScript (la app es pequeña; coste/beneficio no compensa)
- Bundlers (webpack, vite, esbuild)
- Bases de datos (SQLite, IndexedDB)
- Backends, APIs, servicios externos
- Telemetría, analítica, auto-update sin servidor propio

Si crees que algo de esa lista es necesario, **abre primero un debate y actualiza este documento**. La regla de oro: **YAGNI**.

---

## 3. Estructura del proyecto

```
packs app/
├── PLAN_Calculadora.md          ← plan funcional (fuente de verdad de negocio)
├── CLAUDE.md                    ← este archivo
├── README-build.md              ← cómo construir y distribuir el .exe
├── package.json                 ← scripts y dependencias
├── main.js                      ← proceso principal Electron (filesystem + IPC)
├── preload.js                   ← bridge contextual main↔renderer
├── config.default.js            ← valores por defecto (semilla del config.js)
├── icon.png                     ← icono del .exe
├── lib/                         ← módulos compartibles main↔tests (CommonJS, en inglés)
│   ├── config-parser.js         ← extracción/serialización de config.js (legacy ES)
│   ├── config-schema.js         ← validación estricta de esquema (EN)
│   ├── diff.js                  ← diff plano para audit y previsualización (EN)
│   ├── audit.js                 ← append-only audit log (EN)
│   ├── history.js               ← historial de presupuestos (EN)
│   └── logger.js                ← wrapper de electron-log (EN)
├── renderer/
│   ├── index.html               ← UI completa (todas las pantallas)
│   ├── app.js                   ← orquestación: eventos, IPC con main (legacy ES)
│   ├── calculo.js               ← lógica de cálculo pura (legacy ES)
│   ├── admin.js                 ← editor de modo admin (legacy ES)
│   ├── format.js                ← utilidades DOM/formato (legacy ES)
│   └── styles.css               ← estilos (paleta gris azulado, modo claro)
└── tests/                       ← Vitest, en inglés
    ├── calculo.test.js          ← tests legacy (ES)
    ├── config-default.test.js   ← tests legacy (ES)
    ├── config-parser.test.js    ← tests legacy (ES)
    ├── config-schema.test.js    ← tests del validador (EN)
    ├── diff.test.js             ← tests del diff (EN)
    └── ...
```

El `config.js` en producción **no está en este repo**. Vive en el NAS:

```
\\172.26.0.154\Paep\Packs\
├── config.js        ← punto único de verdad de negocio
└── backups\         ← backups automáticos antes de cada escritura admin
```

---

## 4. Principios de diseño

### 4.1. Datos de negocio fuera del código

Todo número que un humano del negocio querría cambiar (PVP, márgenes, parámetros de costes, claves admin, etc.) **vive en `config.js`, no en el código**. Si un PVP cambia, el cambio es de datos, no de despliegue.

`config.default.js` solo se usa para **sembrar** un `config.js` ausente (primer arranque). Una vez creado el `config.js`, el código nunca vuelve a mirar a `config.default.js`.

**Corolario**: no introduzcas valores numéricos del dominio en `main.js`, `preload.js`, `app.js` o `index.html`. Si lo necesitas, añádelo a `config.default.js` y lee desde `CFG`.

### 4.2. Separación main / renderer estricta

- `main.js` (Node) hace todo lo que toque filesystem, diálogos nativos, IPC.
- `renderer/app.js` (Chromium) solo hace UI y cálculo puro.
- El renderer **nunca** habla con `fs`, `path`, `crypto`, `vm` directamente. Solo a través de `window.packprice.*` expuesto en `preload.js`.

Si el renderer necesita una nueva capacidad de Node:

1. Añade un handler `ipcMain.handle('namespace:accion', ...)` en `main.js`.
2. Exponlo en `preload.js` vía `contextBridge`.
3. Llámalo desde el renderer con `await window.packprice.accion(...)`.

**Nunca** pongas `nodeIntegration: true` ni `contextIsolation: false`. Romperíamos el modelo de seguridad sin razón.

### 4.3. Funciones puras para cálculo

`calcularCostePrenda`, `calcularPackPena`, `calcularPackIndividual`, `calcularPackMixto`, `getTramo`, `calcularTotales` son **funciones puras**: no leen ni escriben estado global más allá de `CFG`. Manténgase así para poder testarlas sin DOM.

Cuando añadas un nuevo tipo de pack, sigue el patrón: input simple → función pura → resultado en objeto plano.

### 4.4. Escribir poco, escribir explícito

- Variables descriptivas en español del dominio (`coste_prenda`, `tramo`, `recargos`).
- Comentarios solo cuando el "porqué" no es obvio (workaround, invariante oculta, decisión contraintuitiva).
- No comentes el "qué"; los nombres ya lo explican.
- No añadas wrappers, capas, abstracciones "por si acaso". Tres líneas similares es mejor que una abstracción prematura.

### 4.5. Errores: fail-fast en main, mensajes claros en renderer

- En `main.js`, lanza `Error` con mensaje en español si una operación falla. El handler IPC los convierte en `{ ok: false, error: e.message }`.
- En el renderer, muestra el error con `mostrarError({ titulo, mensaje, detalle })` (diálogo nativo Windows). Nunca silencies un error.
- No uses `try/catch` para "que no rompa": si algo falla, el usuario debe verlo. Solo silencia si tienes una razón documentada (ej. `crearBackup` no es bloqueante).

---

## 5. Convenciones de código

### 5.1. JavaScript

- `'use strict'` al principio de cada archivo `.js` propio.
- `const` por defecto, `let` solo si reasignas, **nunca** `var`.
- 2 espacios de indentación.
- Punto y coma al final de las sentencias.
- Comillas simples (`'`), backticks solo para template strings.
- Funciones de flecha para callbacks cortos, `function` con nombre para top-level.
- IIFE no, módulos `require/exports` (CommonJS) por compatibilidad con Electron sin bundler.

### 5.2. CSS

- Variables CSS en `:root` para paleta y radios (`styles.css` ya lo tiene).
- BEM ligero o clases descriptivas (`.pack-option`, `.admin-tab.active`). Nada de utility-first tipo Tailwind.
- Mobile-first solo lo justo (la app es desktop, pero respeta `@media (max-width: 600px)`).

### 5.3. HTML

- Una sola página (`index.html`) con secciones que se muestran/ocultan con `.hidden`.
- IDs en `kebab-case`. Dataset (`data-*`) para enlazar config.
- CSP restrictiva (`default-src 'self'`). No introduzcas scripts inline ni recursos externos.

### 5.4. Nombres de IPC channels

`<resource>:<action>` siempre, en kebab-case y **en inglés**. Ejemplos válidos:

- `config:read`, `config:write`, `config:create-default`
- `dialog:select-config`, `dialog:confirm-conflict`
- `settings:read`, `settings:write`
- `audit:list`, `audit:append`
- `quotes:list`, `quotes:save`, `quotes:delete`, `quotes:search`
- `pdf:export`
- `logs:read-last`

Canales legacy en español (`dialog:confirmar-conflicto`, `dialog:confirmar`, `dialog:info`, `dialog:error`) se mantienen vivos hasta que se migre el renderer; **nuevos canales se nombran en inglés**.

Los handlers se registran en `main.js` con `ipcMain.handle`. La envoltura amigable se expone en `preload.js`. Los nombres de los métodos expuestos en `window.packprice` también se nombran en inglés (ej. `readConfig`, `saveQuote`, `exportPdf`).

---

## 6. Trabajar con el config

### 6.1. Esquema esperado

```js
{
  version: '2.0.0',
  fecha_actualizacion: '28/4/2026, 15:32:10',
  modificado_por: 'Alberto',
  admin: { clave: '...' },
  parametros:   { mo_eur_hora, iva, merma_pct, ... },
  modelos_roly: { BEAGLE: { nombre, ref, precio }, CLASICA: {...}, URBAN: {...} },
  tramos:       [{ id, etiqueta, desde, hasta, reduccion_tiempo }, ...],
  packs:        { pena_completa: {...}, solo_camisetas: {...}, ..., sudaderas_mixto: {...} }
}
```

`config.default.js` documenta cada campo. Si añades uno nuevo:

1. Añádelo a `config.default.js`.
2. Documéntalo en `PLAN_Calculadora.md`.
3. Si los `config.js` ya existentes en NAS no lo tienen, **añade un fallback en el código** o **migra el archivo** (ver 6.3).

### 6.2. Lectura segura

`leerConfigDesdeArchivo` (legacy, en `main.js`) extrae el JSON con un escáner de llaves y lo parsea con `JSON.parse`. **NUNCA** uses `eval`, `new Function`, `vm.runInNewContext` ni `require` dinámico para parsear un config externo: `vm` no es una frontera de seguridad y abriría una puerta a RCE.

Adicionalmente, todo config recién leído debe pasar por `validateConfigSchema` (ver `lib/config-schema.js`) antes de devolverse al renderer; si falla, devuelve un error legible con el campo concreto que falta o es inválido.

### 6.3. Migraciones de esquema

Cuando cambie el esquema de manera incompatible:

1. Bumpa `VERSION` en `config.default.js`.
2. Crea una función `migrarConfig(config)` en `main.js` que detecte la versión vieja y la actualice **antes** de devolverla al renderer.
3. Sé conservador: añadir campos con defaults es seguro; renombrar/eliminar requiere migrar y dejar backup.
4. Documenta el cambio en `PLAN_Calculadora.md` sección "Historial de decisiones".

El sistema ya hace **backup automático** de cada escritura, así que una migración fallida es recuperable, pero hazla idempotente igualmente.

### 6.4. Detección de conflictos

Cuando dos usuarios editan el modo admin a la vez, comparamos `mtime + sha256` antes de escribir. **No quites** este chequeo. Si parece molesto, añade UX, no lo elimines.

---

## 7. Testing

Hoy el proyecto **no tiene tests automáticos**. Es una omisión consciente: la base es pequeña y la lógica crítica (cálculo) son funciones puras testeables sin tooling. Pero al primer cambio que toque cálculo o cuando crezca el equipo:

### 7.1. Setup mínimo recomendado

- **Vitest** (rápido, cero config, soporta ESM/CJS).
- Carpeta `tests/` hermana de `renderer/`.
- Script en `package.json`:
  ```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
  ```

### 7.2. Qué testar primero (en orden de retorno)

1. **`getTramo(cantidad)`** — frontera entre tramos (9, 10, 24, 25, 49, 50, 99, 100, 9999).
2. **`calcularCostePrenda`** — coste de una camiseta a 2 caras en T1, T4, con/sin reducción.
3. **`calcularPackPena`** — caso del plan: 12 packs sin capucha 2 caras → tramo T1, PVP 25.95, total 311.40 €.
4. **`calcularPackMixto`** — el ejemplo del plan: 7 URBAN + 5 CLASICA T1 → 193.40 €.
5. **`buildDefaultConfig()`** — que las claves estructurales no se pierdan tras refactores.
6. **`leerConfigDesdeArchivo`** — feed con archivos malformados, sin `window.PACKPRICE_CONFIG`, etc.

### 7.3. Cómo hacer testables las funciones del renderer

`renderer/app.js` hoy depende de `CFG` global. Para tests:

- Refactoriza la lógica de cálculo a `renderer/calculo.js` que **exporte** las funciones (CommonJS o ES Modules) y reciba `cfg` por parámetro.
- `app.js` queda como capa de DOM/eventos llamando a `calculo.js`.
- Los tests importan `calculo.js` con un `cfg` fixture.

Hazlo cuando vayas a tocar el módulo de cálculo, no como refactor preventivo.

### 7.4. Tests E2E (futuro)

Si la cosa crece, **Playwright** (no Spectron, está descontinuado) sobre el `.exe` empaquetado. Solo si justifica el coste; con 2 usuarios no.

---

## 8. Mantenimiento

### 8.1. Workflow de cambios

1. Pull, instala dependencias si cambió `package.json`:
   ```bash
   npm install
   ```
2. Itera en modo dev:
   ```bash
   npm run dev
   ```
3. Si tocaste cálculo o el config: prueba al menos un caso de cada tipo de pack.
4. Para release:
   ```bash
   npm run build:win
   ```
   Genera `dist/PackPrice-<version>-portable.exe`.
5. Bumpa la versión en `package.json` **antes** de construir si es un release real, no un test.

### 8.2. Versionado

- `package.json:version` usa SemVer.
- `config.default.js:VERSION` se ata a la versión de la app que sembró el config.
- En `config.js` del NAS, `version` es la última que escribió. Útil para saber si toca migrar.

### 8.3. Dependencias

- **Cero dependencias en runtime** (sólo `devDependencies`). Si tienes que añadir una, justifícalo en commit + actualiza esta sección.
- Actualiza `electron` y `electron-builder` con cuidado, **probando empaquetado** después de cada bump.
- Audita: `npm audit` antes de cada release. Para una app interna sin red, las vulnerabilidades de transitivas de build son tolerables, pero documenta cuáles ignoras y por qué.

### 8.4. Backups del config

El sistema crea backups automáticos en `<NAS>\Packs\backups\` antes de cada escritura admin. Política sugerida:

- Borrar manualmente backups > 90 días una vez al trimestre.
- Copiar `config.js` actual a un disco externo cada 6 meses como protección frente a fallo del NAS.

### 8.5. Logs

Hoy `console.error` en main va a stderr, que en el `.exe` se pierde. Si esto se vuelve un problema:

- Añadir `electron-log` (única dependencia que merece la pena para debugging).
- Logs en `%APPDATA%\packprice\logs\`.

No lo añadas hasta que haya un bug real difícil de reproducir.

---

## 9. Escalabilidad

La app se diseña para **2-3 usuarios y un NAS local**. No la hagas escalable a N usuarios sin antes hablarlo. Pero estos son los puntos donde podría crecer:

### 9.1. Más packs / modelos Roly

Soportado por diseño. Añadir entradas al `config.js`:

- Nuevo modelo: `modelos_roly.NUEVO_ID = { nombre, ref, precio }`.
- Nuevo pack individual: `packs.solo_nuevo_id = { tipo: 'individual', modelo: 'NUEVO_ID', pvp: {...} }`.
- Nuevo pack mixto: implica cambios de código (función `calcularPackMixto` está acoplada a CLASICA+URBAN). Si se necesita mixto genérico, refactoriza `calcularPackMixto` para iterar `pack.componentes` en lugar de hard-coded.

### 9.2. Persistencia de presupuestos (V3)

Plan: `localStorage` o JSON local por PC. NO en el NAS (el `config.js` es solo configuración, no histórico).

Si llega el momento:

- Crear `renderer/historial.js` con API: `guardar(presupuesto)`, `listar()`, `buscar(q)`.
- Backend: `localStorage` (rápido, suficiente para miles de entradas).
- Exportar a PDF: `electron`'s `webContents.printToPDF()` o `pdfkit` si necesitas plantilla rica.

### 9.3. Migración a backend HTTP (V4)

Solo si cruzas los 5 usuarios o necesitas reportes cross-PC. Plan:

- Levantar Node + Express + SQLite en un PC siempre encendido del taller.
- Endpoints `GET /config`, `PUT /config`, `GET /presupuestos`, `POST /presupuestos`.
- La app Electron se vuelve cliente HTTP, el `config.js` deja de ser punto único.
- Auto-update: GitHub Releases + `electron-updater`.

**No empieces V4** sin justificación cuantificable (≥4 usuarios activos o reportes solicitados ≥3 veces).

### 9.4. Internacionalización

Hoy todo en español, hard-coded. Si alguna vez se vende a alguien fuera:

- Extraer strings a `renderer/i18n/<lang>.json`.
- `T(clave)` función de lookup. No uses `i18next` para 50 strings.

No lo hagas todavía. El cliente es 100% español.

---

## 10. Seguridad

Resumen de invariantes; mira `main.js` y `preload.js` para el detalle.

| Invariante | Por qué |
|---|---|
| `contextIsolation: true` | Aísla el renderer del proceso main |
| `nodeIntegration: false` | El renderer no puede llamar a Node directamente |
| `sandbox: false` | Necesario porque `preload.js` usa `require`. Si refactorizas a preload sin require, ponlo a `true` |
| CSP `default-src 'self'` | Bloquea scripts/recursos externos |
| `vm.runInNewContext` con timeout 1s | El `config.js` se parsea aislado del filesystem |
| Backup antes de cada escritura | Recuperable ante corrupción o cambio destructivo |
| `admin.clave` en plano | Es **anti-clic-accidental**, no seguridad. Documentado en plan §7.1 |

**No expongas APIs amplias** desde `preload.js` (ej. no expongas `ipcRenderer` entero, ni `fs`). Cada función expuesta es una superficie de ataque.

**No firmes el `.exe`** con certificado robado o expirado. Si hay que firmar, usar certificado oficial del autónomo / la empresa propietaria.

---

## 11. Cosas que NO hacer

- ❌ No añadas frameworks UI (React, Vue, etc.) sin debate previo.
- ❌ No añadas TypeScript "porque es mejor". Añádelo si hay 3+ devs o si tipos previenen un bug real.
- ❌ No metas valores de negocio en código (PVP, parámetros). Va a `config.js`.
- ❌ No silencies errores con `try/catch` vacíos.
- ❌ No uses `eval`, `new Function`, ni `require` dinámico de paths del usuario.
- ❌ No leas/escribas filesystem desde el renderer.
- ❌ No metas dependencias de runtime sin justificarlas.
- ❌ No commitees `node_modules/`, `dist/`, `.env`, ni el `config.js` real del NAS.
- ❌ No uses `--no-verify` ni `--force-with-lease` sin permiso explícito del usuario.
- ❌ No publiques este `.exe` ni el código fuera del taller sin pedirlo a la dueña del proyecto.

---

## 12. Cosas que SÍ hacer

- ✅ Lee `PLAN_Calculadora.md` antes de tocar lógica de negocio.
- ✅ Cuando dudes entre dos formas, elige la **más legible** y **menos abstracta**.
- ✅ Cuando añadas un IPC, sigue el patrón `<recurso>:<accion>`.
- ✅ Cuando añadas un parámetro al config, añádelo también a `config.default.js` y al plan.
- ✅ Cuando cambies un PVP o constante, hazlo en el `config.js` del NAS, no en código.
- ✅ Antes de un release, ejecuta `npm run dev` y prueba al menos:
  - Primer arranque (borrando `%APPDATA%\packprice\`)
  - Caso de pack peña T1 con/sin capucha
  - Caso de pack mixto con dos cantidades distintas
  - Conflicto admin (modificar config a mano mientras un admin está abierto)
- ✅ Antes de escribir, lee. Antes de añadir, simplifica.

---

## 13. Glosario rápido

- **Pack peña**: combina camiseta + sudadera. Uno por persona.
- **Tramo (T1..T4)**: rango de cantidad que determina PVP y reducción de tiempo.
- **DTF**: Direct-to-Film, la técnica de impresión.
- **NAS**: el servidor de archivos del taller (`172.26.0.154`).
- **3XL+ buffer**: colchón de coste para amortizar tallas grandes en el mix típico (no recargo al cliente).
- **Recargo 4XL/5XL+**: recargo directo al cliente, no buffer.
- **Modo admin**: editor de parámetros del config (clave compartida).

---

## 14. Contactos

- Plan funcional, decisiones de negocio: ver `PLAN_Calculadora.md`.
- Build / distribución: ver `README-build.md`.
- Cualquier ambigüedad técnica: prefiere preguntar antes de inferir.

---

*Última actualización de este documento: añadir aquí cuando lo modifiques.*
