# Auto-update real con electron-updater

> Diseño aprobado en sesión de brainstorming 2026-06-24. Sustituye el **aviso
> manual** de nueva versión (fetch a la API de GitHub Releases + abrir el
> navegador) por **auto-update real**: la app instalada descarga e instala las
> actualizaciones por sí sola usando `electron-updater` contra GitHub Releases
> de `TermiSenpai/Quanto`.

## 1. Problema y objetivo

Hoy el "auto-update" es solo un **aviso**: `update:check` (`main.js`) hace un
`fetch` a `https://api.github.com/repos/<repo>/releases/latest`, compara el tag
con la versión instalada vía `lib/version-compare.js`, y el botón «Buscar ahora»
abre la página de releases en el navegador. El usuario descarga e instala el
`.exe` **a mano**.

El cambio a instalador NSIS per-user (debate de empaquetado 2026-06-16)
desbloqueó `electron-updater`, pero nunca se cableó.

**Objetivo:** que la app instalada **descargue e instale sola** las nuevas
versiones, sin que el usuario baje el `.exe` manualmente. Flujo elegido:
descarga silenciosa en segundo plano y, cuando está lista, un aviso no
bloqueante con botón «Reiniciar e instalar ahora» (o seguir trabajando); si
nunca lo pulsa, se instala al cerrar la app.

## 2. Decisiones tomadas (brainstorming)

| Decisión | Valor |
|---|---|
| Mecanismo | **`electron-updater`** (única dep de runtime nueva) |
| Flujo UX | **Descarga sola + preguntar «Reiniciar e instalar ahora»**; red de seguridad: instalar al cerrar (`autoInstallOnAppQuit`) |
| Aviso manual previo | **Sustituido**: el check al arranque y «Buscar ahora» delegan en `electron-updater`. Se retira el `fetch` manual |
| `lib/version-compare.js` | **Se elimina** (electron-updater compara versiones internamente); se borra también su test |
| Firma del `.exe` | **Sigue sin firmar** (coherente con el debate de productización). electron-updater funciona con NSIS sin firmar; confianza = HTTPS + GitHub Releases |
| Repo de releases | `TermiSenpai/Quanto` (público; los clientes leen releases sin token) |
| Modo dev | electron-updater no corre fuera del `.exe` empaquetado → estado `dev`, la UI muestra «no disponible en desarrollo» |

## 3. Restricción dura: regla 9 (no deps nuevas sin debate)

`electron-updater` es la **primera dependencia de runtime nueva** desde el
debate de la nube (que presumía de *zero new dependencies*). Antes de añadirla,
el diseño exige una **entrada de debate fechada en `CLAUDE.md`** (§Documented
debates), p.ej.:

> **2026-06-24 — Auto-update (electron-updater).** Anticipado por el debate de
> empaquetado NSIS (2026-06-16). Se añade `electron-updater` como única dep de
> runtime nueva; el instalador NSIS per-user lo soporta y el aviso manual no
> instalaba nada. Sigue **sin Worker ni servidor**: lee releases públicas de
> GitHub por HTTPS. El `.exe` sigue **sin firmar**. Red de confianza: HTTPS +
> GitHub Releases. La comprobación/descarga ocurre **solo en el proceso main**
> (CSP del renderer intacta). `electron-log` (ya presente) actúa de logger.

Sin esta entrada, el cambio deja un "silent gap" entre código y docs.

## 4. Arquitectura — módulo envoltorio testeable

Siguiendo el patrón de `lib/d1-client.js` (dependencia inyectable para testear
sin red/Electron), se crea **`lib/app-updater.js`**:

- **Qué hace:** traduce los eventos de `electron-updater` a un **estado simple**
  para el renderer y orquesta check/instalar.
- **Cómo se usa:** `wireUpdater({ updater, isPackaged, onState })` registra los
  listeners y devuelve `{ checkForUpdates, quitAndInstall }`. El `updater`
  (el `autoUpdater` de electron-updater) y `isPackaged` se **inyectan** → en
  tests se pasa un *fake* que emite eventos.
- **De qué depende:** solo del objeto `updater` inyectado. No importa Electron
  directamente (lo hace `main.js`).

**Estado expuesto al renderer** (un solo objeto, reenviado por IPC):

```js
{ phase, version, percent, error }
// phase ∈ { idle, checking, downloading, ready, error, dev }
```

Mapeo de eventos electron-updater → phase:

| Evento electron-updater | phase | extra |
|---|---|---|
| `checking-for-update` | `checking` | — |
| `update-available` | `downloading` | `version` |
| `download-progress` | `downloading` | `percent` |
| `update-downloaded` | `ready` | `version` |
| `update-not-available` | `idle` | — |
| `error` | `error` | `error` (mensaje) |
| (`!isPackaged` al pedir check) | `dev` | — |

**`main.js`** solo cablea (cableado puro, sin lógica):
- configura `updater.autoDownload = true`, `updater.autoInstallOnAppQuit = true`,
  `updater.logger = log` (electron-log);
- `wireUpdater(...)` con `onState` → `mainWindow.webContents.send('update:state', state)`;
- al arranque, si `settings.check_updates_on_start`, llama `checkForUpdates()`.

**Por qué módulo y no todo en main.js:** main.js ya es grande; aislar la lógica
de eventos la hace testeable y mantiene main.js como cableado.

## 5. Flujo

```
boot (si check_updates_on_start) ──► checkForUpdates()
  update-available  → descarga sola en 2º plano (autoDownload)
  download-progress → phase 'downloading' (% opcional en ajustes)
  update-downloaded → phase 'ready' → aviso no bloqueante:
                      «Versión X lista · [Reiniciar e instalar ahora] [Luego]»
  [Reiniciar ahora] → quitAndInstall()
  [Luego] / nunca   → se instala al cerrar (autoInstallOnAppQuit)
```

- «Buscar ahora» en ajustes → `checkForUpdates()` (mismo camino).
- Modo dev (`!app.isPackaged`): phase `dev`, UI muestra «no disponible en
  desarrollo» en vez de romper.

## 6. Cambios concretos

### Se retira / cambia
- `update:check` (`main.js`): se le quita el `fetch` a GitHub Releases; delega
  en `app-updater` (`checkForUpdates()`).
- `lib/version-compare.js` + `tests/version-compare.test.js`: **eliminados**.
- `preload.js`: mantiene `checkAppUpdate`; añade `installUpdateNow()` y la
  suscripción `onUpdateState(cb)` al canal `update:state`.
- Renderer: pasa de pintar el **valor de retorno** de `update:check` (modelo
  síncrono actual, `renderer/app.js`) a pintar los **eventos** `update:state`
  (modelo asíncrono): «Buscar ahora» dispara el check y la UI se actualiza con
  cada `phase`. El área de aviso existente se extiende para los estados
  `downloading`/`ready`, con el botón «Reiniciar e instalar ahora».

### Se añade
- `lib/app-updater.js` + `tests/app-updater.test.js`.
- `package.json`:
  ```jsonc
  "build": {
    "publish": [{ "provider": "github", "owner": "TermiSenpai", "repo": "Quanto" }],
    ...
  },
  "dependencies": { "electron-log": "...", "electron-updater": "^6" }
  ```
- IPC: `update:install` (renderer → main → `quitAndInstall`); evento
  `update:state` (main → renderer).

## 7. Proceso de release (cambia)

electron-updater necesita que cada release lleve `latest.yml` + `.blockmap`
junto al `.exe`. Los genera `electron-builder --publish always`, que sube todo a
GitHub Releases (requiere `GH_TOKEN` **solo para publicar**, no para que los
clientes lean). Se añade script `build:win-publish` y se documenta en
`README-build.md`.

## 8. Tests

- `tests/app-updater.test.js`: con un `autoUpdater` *fake* que emite eventos,
  verificar el mapeo evento→estado, el guard de dev (`isPackaged=false` →
  phase `dev`, no se llama al updater real), y que `quitAndInstall` se invoca al
  instalar.
- No se testea electron-updater en sí (integración Electron); sí toda la glue
  lógica propia. Consistente con cómo se testea `d1-client`.

## 9. Criterio de aceptación

- `pnpm test` verde, incluido `app-updater.test.js`; suite previa intacta salvo
  la retirada de `version-compare`.
- CLAUDE.md tiene la entrada de debate de §3; `package.json` declara `publish` y
  la dep; `README-build.md` documenta `build:win-publish` y el `GH_TOKEN`.
- Smoke en `.exe` instalado: con una release de prueba mayor publicada, la app
  descarga sola, muestra «Versión X lista», «Reiniciar e instalar ahora»
  reinicia e instala; «Luego» + cerrar instala al salir.
- En `pnpm dev`, «Buscar ahora» muestra «no disponible en desarrollo» sin
  romper.

## 10. Fuera de alcance (YAGNI)

- Firma de código del `.exe` (decisión de productización aparte).
- Canales de release (beta/stable), *staged rollouts*, *delta-only*.
- Auto-update en modo portable (electron-updater no lo soporta; el portable
  sigue siendo escape hatch manual).
