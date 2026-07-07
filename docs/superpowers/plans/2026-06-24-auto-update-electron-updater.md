# Auto-update (electron-updater) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual "new version" notice with real auto-update — the installed app downloads new releases in the background and installs them on a user-confirmed restart (or on next quit).

**Architecture:** A small injectable wrapper (`lib/app-updater.js`) translates electron-updater's `autoUpdater` events into a simple `{ phase, version, percent, error }` state. `main.js` configures `autoUpdater` (auto-download, install-on-quit) and forwards the state to the renderer over a new `update:state` event; the renderer paints a top banner + the settings "Buscar ahora" area from that state. The old GitHub-Releases `fetch` path and `lib/version-compare.js` are removed.

**Tech Stack:** Electron, `electron-updater` (new runtime dep), `electron-log` (already present, used as the updater logger), Vitest, vanilla JS renderer. Package manager: **pnpm**.

**Spec:** `docs/superpowers/specs/2026-06-24-auto-update-electron-updater-design.md`

---

### Task 1: Gate — document the rule-9 debate + add the dependency

`electron-updater` is the first new runtime dependency since the cloud debate. Hard rule 9 requires a documented debate in `CLAUDE.md` BEFORE adding it.

**Files:**
- Modify: `CLAUDE.md` (Documented debates section, after the 2026-06-16 NSIS entry)
- Modify: `package.json:62-64` (dependencies)
- Modify: `pnpm-lock.yaml` (generated)

- [ ] **Step 1: Add the debate entry to CLAUDE.md**

Insert this bullet in the "### Documented debates" list (chronological, after the `2026-06-16 — Packaging: portable → NSIS installer.` entry):

```markdown
- **2026-06-24 — Auto-update (electron-updater).** Anticipated by the NSIS
  packaging debate (2026-06-16, which noted it "unlocks `electron-updater`").
  We add **`electron-updater`** as the only new runtime dependency: the
  per-user NSIS installer supports it and the old "new version" notice
  installed nothing. Still **no Worker and no server-side code** — it reads
  public GitHub Releases (`TermiSenpai/Quanto`) over HTTPS. The `.exe` stays
  **unsigned**; trust anchor is HTTPS + GitHub Releases. The check/download
  runs **only in the main process** (renderer CSP untouched); `electron-log`
  (already present) is the updater logger. UX: silent background download,
  then a non-blocking "Versión X lista · [Reiniciar e instalar ahora]" banner,
  with install-on-quit as the fallback. This **supersedes** the manual notice:
  `lib/version-compare.js` and the GitHub-Releases `fetch` in `update:check`
  are removed. Anything beyond GitHub Releases (a private feed, staged
  rollouts, code signing) reopens the debate. Design:
  `docs/superpowers/specs/2026-06-24-auto-update-electron-updater-design.md`.
```

- [ ] **Step 2: Add the dependency**

Run: `pnpm add electron-updater@^6`
Expected: `package.json` `dependencies` gains `"electron-updater": "^6.x.x"`; `pnpm-lock.yaml` updates; install completes without errors.

- [ ] **Step 3: Verify the existing suite still passes (no code touched yet)**

Run: `pnpm test`
Expected: PASS (same count as before — adding a dep changes nothing at runtime yet).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md package.json pnpm-lock.yaml
git commit -m "chore(deps): add electron-updater + document the rule-9 debate"
```

---

### Task 2: `lib/app-updater.js` — the injectable event→state wrapper (TDD)

**Files:**
- Create: `lib/app-updater.js`
- Test: `tests/app-updater.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/app-updater.test.js`:

```js
// ============================================================
// Tests · lib/app-updater.js
// ============================================================
import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireUpdater } from '../lib/app-updater.js';

function fakeUpdater() {
  const ee = new EventEmitter();
  ee.checkForUpdates = vi.fn();
  ee.quitAndInstall = vi.fn();
  return ee;
}

describe('wireUpdater event → state mapping', () => {
  test('maps each electron-updater event to a phase', () => {
    const updater = fakeUpdater();
    const states = [];
    wireUpdater({ updater, isPackaged: true, onState: (s) => states.push(s) });

    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '5.1.0' });
    updater.emit('download-progress', { percent: 42.7 });
    updater.emit('update-downloaded', { version: '5.1.0' });
    updater.emit('update-not-available', {});
    updater.emit('error', new Error('boom'));

    expect(states).toEqual([
      { phase: 'checking' },
      { phase: 'downloading', version: '5.1.0' },
      { phase: 'downloading', percent: 43 },
      { phase: 'ready', version: '5.1.0' },
      { phase: 'idle' },
      { phase: 'error', error: 'boom' }
    ]);
  });

  test('checkForUpdates delegates to the updater when packaged', () => {
    const updater = fakeUpdater();
    const api = wireUpdater({ updater, isPackaged: true, onState: () => {} });
    api.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('quitAndInstall delegates to the updater when packaged', () => {
    const updater = fakeUpdater();
    const api = wireUpdater({ updater, isPackaged: true, onState: () => {} });
    api.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('dev guard: checkForUpdates emits dev phase and does NOT call the updater', () => {
    const updater = fakeUpdater();
    const states = [];
    const api = wireUpdater({ updater, isPackaged: false, onState: (s) => states.push(s) });
    api.checkForUpdates();
    api.quitAndInstall();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(states).toEqual([{ phase: 'dev' }]);
  });

  test('a throwing onState never propagates out of an event', () => {
    const updater = fakeUpdater();
    wireUpdater({ updater, isPackaged: true, onState: () => { throw new Error('ui blew up'); } });
    expect(() => updater.emit('checking-for-update')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- app-updater`
Expected: FAIL — `Cannot find module '../lib/app-updater.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/app-updater.js`:

```js
// ============================================================
// lib/app-updater.js — electron-updater wrapper (main process)
// ============================================================
// Translates electron-updater's autoUpdater events into a single
// renderer-friendly state object and exposes check/install. The
// `updater` (autoUpdater) and `isPackaged` flag are INJECTED so this
// module is unit-testable without Electron (mirrors lib/d1-client's
// injectable fetch). main.js owns the actual `require('electron-updater')`
// and the IPC plumbing; this module owns the event→state translation.
// ============================================================

'use strict';

/**
 * @param {object} deps
 * @param {object}  deps.updater     electron-updater autoUpdater (EventEmitter)
 * @param {boolean} deps.isPackaged  app.isPackaged (false under `pnpm dev`)
 * @param {(state: object) => void} deps.onState  receives { phase, version?, percent?, error? }
 * @returns {{ checkForUpdates: () => void, quitAndInstall: () => void }}
 */
function wireUpdater({ updater, isPackaged, onState }) {
  // A bug in the UI callback must never break the updater event loop.
  const emit = (state) => { try { onState(state); } catch (_) {} };

  updater.on('checking-for-update', () => emit({ phase: 'checking' }));
  updater.on('update-available', (info) => emit({ phase: 'downloading', version: info && info.version }));
  updater.on('download-progress', (p) => emit({ phase: 'downloading', percent: Math.round((p && p.percent) || 0) }));
  updater.on('update-downloaded', (info) => emit({ phase: 'ready', version: info && info.version }));
  updater.on('update-not-available', () => emit({ phase: 'idle' }));
  updater.on('error', (err) => emit({ phase: 'error', error: (err && err.message) || String(err) }));

  return {
    checkForUpdates() {
      // electron-updater only works in a packaged app; in dev it would throw.
      if (!isPackaged) { emit({ phase: 'dev' }); return; }
      updater.checkForUpdates();
    },
    quitAndInstall() {
      if (!isPackaged) return;
      updater.quitAndInstall();
    }
  };
}

module.exports = { wireUpdater };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- app-updater`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/app-updater.js tests/app-updater.test.js
git commit -m "feat(updater): add injectable electron-updater event→state wrapper"
```

---

### Task 3: Wire the updater into main.js + new IPC

**Files:**
- Modify: `main.js:70` (remove the version-compare require)
- Modify: `main.js:231-239` (remove the now-dead GITHUB_REPO constants)
- Modify: `main.js:58-76` (add requires)
- Modify: `main.js:1100-1150` (replace the `update:check` handler; add `update:install`)
- Modify: `main.js:1565` (wire the updater after the window exists)

- [ ] **Step 1: Add the requires and a module-level controller**

In the require block (after `main.js:76` `const { migrateLegacyUserData } = require('./lib/userdata-migration');`), add:

```js
const { autoUpdater } = require('electron-updater');
const { wireUpdater } = require('./lib/app-updater');
```

Remove this line (`main.js:70`):

```js
const { isNewerVersion } = require('./lib/version-compare');
```

Near the other top-level `let` state (e.g. just above `function createMainWindow()` at `main.js:317`), add:

```js
// Set once in app.whenReady (after the window exists) — see wireUpdater below.
let updaterController = null;
```

- [ ] **Step 2: Remove the dead GITHUB_REPO constants**

Delete the comment block + both constants at `main.js:231-239`:

```js
// ------------------------------------------------------------------
// The public GitHub repo the update check (PRD R15) queries for the
// latest release (owner-confirmed 2026-06-17). The endpoint and the
// download link both derive from it; it carries no secret (public API).
// ------------------------------------------------------------------
const GITHUB_REPO = 'TermiSenpai/Quanto';
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;
```

(electron-updater reads the repo from `build.publish` in `package.json` via the generated `app-update.yml` — Task 7 — so these are dead.)

Then fix the two doc references that named the now-removed constant, so they point at the new source of truth (`package.json` `build.publish`):

- `CLAUDE.md:134` — change `` `main.js` `GITHUB_REPO` points at it. `` to `` the repo lives in `package.json` `build.publish` (electron-updater). ``
- `docs/PRD.md:140` — change `usa la constante `GITHUB_REPO` de `main.js`` to `usa `package.json` `build.publish` (electron-updater)` and drop "y la constante actualizada".

- [ ] **Step 3: Replace the `update:check` handler and add `update:install`**

Replace the entire block at `main.js:1100-1150` (the big comment + the `ipcMain.handle('update:check', ...)` body) with:

```js
// --- App update (PRD R15, now real auto-update via electron-updater) ---
// `update:check` just TRIGGERS a check; progress + result arrive on the
// renderer as `update:state` events (see wireUpdater in app.whenReady).
// `update:install` quits and installs a downloaded update. Both are no-ops
// with a clear signal until the updater is wired, and in dev the wrapper
// emits a `dev` phase instead of touching electron-updater.
ipcMain.handle('update:check', async () => {
  if (!updaterController) return { ok: false, error: 'Updater no inicializado.' };
  updaterController.checkForUpdates();
  return { ok: true };
});

ipcMain.handle('update:install', async () => {
  if (!updaterController) return { ok: false };
  updaterController.quitAndInstall();
  return { ok: true };
});
```

- [ ] **Step 4: Wire the updater in app.whenReady (after the window exists)**

In `app.whenReady()`, immediately after `createMainWindow();` (`main.js:1565`), add:

```js
  // Real auto-update (PRD R15). Configure electron-updater and forward its
  // state to the renderer. autoDownload pulls updates silently; the user
  // confirms the restart via the banner, else it installs on quit.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = logger; // electron-log is electron-updater-compatible
  updaterController = wireUpdater({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:state', state);
      }
    }
  });
```

- [ ] **Step 5: Run the full suite (nothing references version-compare in main anymore)**

Run: `pnpm test`
Expected: PASS for everything EXCEPT possibly nothing — `tests/version-compare.test.js` still exists and still passes (it tests the lib directly, deleted in Task 6). No main.js test imports `update:check`'s old return shape. If any test fails referencing `isNewerVersion` from main, it is a pre-existing integration test — note it and continue; it is removed in Task 6.

- [ ] **Step 6: Commit**

```bash
git add main.js
git commit -m "feat(updater): wire electron-updater in main + update:check/install IPC"
```

---

### Task 4: Expose the new IPC on the preload bridge

**Files:**
- Modify: `preload.js:70-75` (rewrite the update comment + `checkAppUpdate`; add `installUpdateNow` + `onUpdateState`)

- [ ] **Step 1: Replace the update bridge block**

Replace `preload.js:70-75` (the `// --- App-version update check ...` comment + `checkAppUpdate` line) with:

```js
  // --- App auto-update (PRD R15, electron-updater) ---
  // `checkAppUpdate` TRIGGERS a check in main; results arrive via the
  // `onUpdateState` subscription (main pushes { phase, version, percent,
  // error } over `update:state`). `installUpdateNow` quits + installs a
  // downloaded update. All network/Electron lives in main (CSP intact).
  checkAppUpdate:    ()   => ipcRenderer.invoke('update:check'),
  installUpdateNow:  ()   => ipcRenderer.invoke('update:install'),
  onUpdateState:     (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
```

- [ ] **Step 2: Sanity-check preload parses (no test harness for preload)**

Run: `node -e "require('./preload.js')" 2>&1 | head -5`
Expected: it errors on `contextBridge`/`electron` not being available outside Electron — that's fine; what matters is NO syntax error (no `SyntaxError`). If you see only an Electron/contextBridge runtime error, the file is syntactically valid.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(updater): expose installUpdateNow + onUpdateState on preload"
```

---

### Task 5: Renderer — event-driven banner + settings area

**Files:**
- Modify: `renderer/index.html:536-539` (banner: swap Descargar → Reiniciar e instalar)
- Modify: `renderer/index.html:1145` (settings copy: it no longer says "no se instala nada")
- Modify: `renderer/app.js:4275-4327` (replace `checkForUpdateNow` + `renderUpdateResult` with state-driven logic)
- Modify: `renderer/app.js:4392-4413` (simplify `maybeCheckForUpdate`)
- Modify: `renderer/app.js:~842` and `~1233` (register the subscription + bind the restart button)

- [ ] **Step 1: Update the banner markup**

At `renderer/index.html:539`, replace the download button:

```html
      <button id="btn-update-download" class="btn btn-secondary btn-sm" type="button">Descargar</button>
```

with:

```html
      <button id="btn-update-restart" class="btn btn-secondary btn-sm hidden" type="button">Reiniciar e instalar ahora</button>
```

- [ ] **Step 2: Update the settings help copy**

At `renderer/index.html:1145`, replace:

```html
              <p class="text-secondary" style="font-size: 12px;">Comprueba si hay una versión más reciente en GitHub. No se instala nada automáticamente.</p>
```

with:

```html
              <p class="text-secondary" style="font-size: 12px;">Comprueba si hay una versión más reciente. Se descarga sola y te avisa para reiniciar e instalar.</p>
```

- [ ] **Step 3: Replace `checkForUpdateNow` + `renderUpdateResult` with the state renderer**

Replace `renderer/app.js:4281-4327` (the `checkForUpdateNow` function AND the `renderUpdateResult` function) with:

```js
async function checkForUpdateNow() {
  const btn = el('btn-aj-buscar-update');
  const result = el('aj-update-result');
  if (!btn || !result) return;

  btn.dataset.label = btn.dataset.label || btn.innerHTML;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Buscando…';
  result.textContent = '';
  try {
    // Just triggers the check; applyUpdateState paints the result and
    // re-enables the button when a terminal phase event arrives.
    await window.packprice.checkAppUpdate();
  } catch (_) {
    result.textContent = 'No se pudo comprobar. Revisa tu conexión e inténtalo de nuevo.';
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label;
    btn.dataset.busy = '';
  }
}

/**
 * Single source of truth for painting update progress, driven by the
 * `update:state` events from main. Updates both the settings inline area
 * (when the modal is open) and the top banner.
 */
function applyUpdateState(state) {
  const phase = state && state.phase;

  // 1) Settings inline result (only present while the modal is open).
  const result = el('aj-update-result');
  if (result) {
    if (phase === 'checking') {
      result.textContent = 'Buscando…';
    } else if (phase === 'downloading') {
      result.textContent = typeof state.percent === 'number'
        ? `Descargando actualización… ${state.percent}%`
        : 'Descargando actualización…';
    } else if (phase === 'ready') {
      result.textContent = `Versión ${state.version || ''} lista. Se instalará al cerrar la app.`;
    } else if (phase === 'idle') {
      result.textContent = 'Estás en la última versión.';
    } else if (phase === 'error') {
      result.textContent = 'No se pudo comprobar. Revisa tu conexión e inténtalo de nuevo.';
    } else if (phase === 'dev') {
      result.textContent = 'Las actualizaciones automáticas solo están disponibles en la app instalada.';
    }
  }

  // Re-enable the manual «Buscar ahora» button on any terminal phase.
  if (phase === 'idle' || phase === 'ready' || phase === 'error' || phase === 'dev') {
    const btn = el('btn-aj-buscar-update');
    if (btn && btn.dataset.busy === '1') {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.label || 'Buscar ahora';
      btn.dataset.busy = '';
    }
  }

  // 2) Top banner: show during download and when ready; the restart button
  // appears only when an update is downloaded and ready to install.
  const textEl = el('update-banner-text');
  const restartBtn = el('btn-update-restart');
  if (phase === 'downloading') {
    if (textEl) {
      textEl.textContent = typeof state.percent === 'number'
        ? `Descargando versión ${state.version || ''}… ${state.percent}%`
        : 'Descargando actualización…';
    }
    if (restartBtn) restartBtn.classList.add('hidden');
    show('update-banner');
  } else if (phase === 'ready') {
    if (textEl) textEl.textContent = `Versión ${state.version || ''} lista`;
    if (restartBtn) restartBtn.classList.remove('hidden');
    show('update-banner');
  }
  // checking / idle / error / dev: leave the banner as-is (boot stays silent).
}
```

- [ ] **Step 4: Simplify the boot check**

Replace `renderer/app.js:4398-4413` (the `maybeCheckForUpdate` function body) with:

```js
async function maybeCheckForUpdate() {
  if (SETTINGS && SETTINGS.check_updates_on_start === false) return;
  // Just trigger it; results arrive via update:state → applyUpdateState,
  // which only surfaces the banner for downloading/ready. A failed check
  // is swallowed silently on boot.
  try { await window.packprice.checkAppUpdate(); } catch (_) {}
}
```

- [ ] **Step 5: Register the subscription + bind the restart button**

At `renderer/app.js:842` (where `maybeCheckForUpdate();` is called during init), add the subscription on the line BEFORE it:

```js
    if (window.packprice && typeof window.packprice.onUpdateState === 'function') {
      window.packprice.onUpdateState(applyUpdateState);
    }
    maybeCheckForUpdate();
```

At `renderer/app.js:1234` (just after the `btn-aj-buscar-update` listener is bound), bind the restart button:

```js
  const btnUpdateRestart = el('btn-update-restart');
  if (btnUpdateRestart) {
    btnUpdateRestart.addEventListener('click', () => {
      btnUpdateRestart.disabled = true;
      window.packprice.installUpdateNow();
    });
  }
```

- [ ] **Step 6: Run the full suite (renderer has no unit tests; confirm nothing else broke)**

Run: `pnpm test`
Expected: PASS (renderer JS is not unit-tested here; this confirms no shared module regressed).

- [ ] **Step 7: Commit**

```bash
git add renderer/app.js renderer/index.html
git commit -m "feat(updater): event-driven update banner + settings area in renderer"
```

---

### Task 6: Remove the now-dead version-compare module

**Files:**
- Delete: `lib/version-compare.js`
- Delete: `tests/version-compare.test.js`

- [ ] **Step 1: Confirm nothing still imports it**

Run: `grep -rn "version-compare\|isNewerVersion" --include=*.js . | grep -v node_modules`
Expected: NO matches (Task 3 removed the only `require`). If any remain, fix them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm lib/version-compare.js tests/version-compare.test.js
```

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: PASS, with the version-compare test count gone and `app-updater` tests present.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(updater): drop version-compare (electron-updater compares internally)"
```

---

### Task 7: Release wiring — publish config + docs

electron-updater needs each release to carry `latest.yml` + `.blockmap` next to the `.exe`. `electron-builder --publish` generates and uploads them from `build.publish`.

**Files:**
- Modify: `package.json` (`build.publish` + `build:win-publish` script)
- Modify: `README-build.md` (release process + GH_TOKEN)
- Modify: `docs/PRD.md` (R15 requirement text — no longer "sin auto-instalación")

- [ ] **Step 0: Update PRD R15 to match the new (approved) behavior**

In `docs/PRD.md`, find the R15 table row. It currently ends with `lo avisa con enlace de descarga — sin auto-instalación; comprobación desactivable en ajustes`. Replace that clause with: `descarga la actualización en segundo plano y avisa para reiniciar e instalar (con instalación al cerrar como respaldo, vía electron-updater); comprobación desactivable en ajustes`. Keep the rest of the row (repo público / `main` es producción / release en GitHub Releases) intact.

- [ ] **Step 1: Add the publish config**

In `package.json`, inside `"build"` (e.g. right after `"directories"`), add:

```json
    "publish": [
      { "provider": "github", "owner": "TermiSenpai", "repo": "Quanto" }
    ],
```

- [ ] **Step 2: Add a publish script**

In `package.json` `"scripts"`, after `"build:win-portable"`, add:

```json
    "build:win-publish": "electron-builder --win --x64 --publish always",
```

- [ ] **Step 3: Document the release process**

Append a section to `README-build.md`:

```markdown
## Publicar una release con auto-update (electron-updater)

La app instalada se actualiza sola leyendo las releases de
`github.com/TermiSenpai/Quanto`. Para que funcione, cada release debe llevar
`latest.yml` + el `.exe` + su `.blockmap`, que genera y sube
`electron-builder --publish`.

1. Sube `package.json:version` (sin la dep, ya está).
2. Exporta un token de GitHub con permiso `repo` (solo para **publicar**; los
   clientes leen sin token porque el repo es público):
   `setx GH_TOKEN <token>` (o variable de entorno de la sesión).
3. `pnpm build:win-publish` — compila el instalador NSIS y sube
   `Quanto-<version>-setup.exe`, `latest.yml` y `.blockmap` a una release
   (draft) de GitHub.
4. Publica la release (quita el "draft") en GitHub.

Las versiones anteriores ya instaladas la detectarán al arrancar, la
descargarán en segundo plano y ofrecerán «Reiniciar e instalar ahora».
El `.exe` sigue **sin firmar** (SmartScreen documentado en el manual).
```

- [ ] **Step 4: Verify package.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add package.json README-build.md
git commit -m "build(updater): github publish config + release docs for electron-updater"
```

---

### Task 8: Manual smoke verification (packaged app)

Unit tests cover the wrapper; electron-updater itself only runs in a packaged build. This task is manual and gated on a real test release.

**Per the sandbox memory (`electron-builder-symlink-sandbox`), the NSIS build runs on the real Windows machine, not this sandbox.**

- [ ] **Step 1: Dev guard check**

Run: `pnpm dev`, open Ajustes → Actualizaciones → «Buscar ahora».
Expected: shows «Las actualizaciones automáticas solo están disponibles en la app instalada.» and the button re-enables. No crash.

- [ ] **Step 2: Build + publish a higher test version**

Bump `version` to a value above the installed one, then `pnpm build:win-publish` (with `GH_TOKEN`). Publish the GitHub release.

- [ ] **Step 3: Real update flow**

Launch a previously-installed older `.exe`.
Expected: banner shows «Descargando…» then «Versión X lista» with «Reiniciar e instalar ahora»; clicking it relaunches into the new version. Closing without clicking installs on next quit.

- [ ] **Step 4: Devlog (release only)**

Per `CLAUDE.md` §8, add a devlog entry before distributing the `.exe`.

---

## Notes for the implementer

- **Order matters:** Task 1 (debate + dep) is the rule-9 gate — do not add `electron-updater` usage before the `CLAUDE.md` entry exists.
- **`logger`** in `main.js` is the configured `electron-log` instance; assigning it to `autoUpdater.logger` is the documented, zero-cost integration.
- **No signing:** the `.exe` is intentionally unsigned (productization debate). electron-updater works with unsigned NSIS; do not add signing in this plan.
- **Renderer is not unit-tested** in this repo; the `pnpm test` steps in Tasks 3–6 are regression guards for shared modules, and the real renderer verification is the manual smoke in Task 8.
