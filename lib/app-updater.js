// ============================================================
// lib/app-updater.js — electron-updater wrapper (main process)
// ============================================================
// Translates electron-updater's autoUpdater events into a single
// renderer-friendly state object and exposes check/install. The
// `updater` and `isPackaged` flag are INJECTED so this module is
// unit-testable without Electron (mirrors lib/d1-client's injectable
// fetch). main.js owns the actual `require('electron-updater')` and the
// IPC plumbing; this module owns the event→state translation.
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
