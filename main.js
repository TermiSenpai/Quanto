// ============================================================
// PackPrice - Electron main process
// ============================================================
// Responsibilities:
//   - Create and manage the window
//   - Filesystem access (read/write of the config)
//   - Local settings persistence (%APPDATA%)
//   - IPC so the renderer can request filesystem operations
//
// Security best practices enabled:
//   - contextIsolation: true
//   - nodeIntegration: false
//   - sandbox: true (cannot, because preload uses require, but we
//     keep the exposed surface minimal)
//   - The renderer has NO direct access to fs/path/etc.
//
// Data migration (CLAUDE.md §6.3): config.js and settings.json are
// migrated v2 -> v3 lazily on read, via lib/config-store.js. The
// renderer-facing config keys are now v3 (English). User-facing
// strings stay in Spanish.
// ============================================================

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildDefaultConfig } = require('./config.default');
const {
  validateConfigShape,
  stripAdminPassword,
  injectAdminPassword
} = require('./lib/config-parser');
const { validateConfigSchema } = require('./lib/config-schema');
const { migrateConfig, migrateSettings } = require('./lib/migrations');
const {
  readConfigFromFile,
  getFileInfo,
  createBackup,
  writeConfigAtomic,
  readAndMigrateConfig,
  readAndMigrateSettings
} = require('./lib/config-store');
const { configureLogger, readLastLines, getLogPath, logger } = require('./lib/logger');
const { diffObjects } = require('./lib/diff');
const { appendAuditEntry, readRecentEntries } = require('./lib/audit');
const {
  saveQuote: saveQuoteToHistory,
  listQuotes,
  searchQuotes,
  deleteQuote,
  getQuote
} = require('./lib/history');
const { renderQuoteHtml } = require('./lib/pdf-template');

// --- Path configuration ---
const SETTINGS_DIR = path.join(app.getPath('userData'));
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');
const LOG_DIR = path.join(SETTINGS_DIR, 'logs');

// Default path where the app expects (and if needed creates) the
// shared config.js on the NAS. It can be changed in "Settings" on
// each PC and is persisted in the local settings.json.
//
// Tried in order until a writable one is found. The first existing
// or accessible one is used as the initial path; if none exists it
// is created in the first viable one.
const CONFIG_PATH_CANDIDATES = [
  '\\\\172.26.0.154\\Paep\\Packs\\config.js',
  'Z:\\Packs\\config.js'
];

let mainWindow = null;

// ============================================================
// Filesystem helpers
// ============================================================

/**
 * Checks whether a path is writable. No side effects: it does NOT
 * create directories, it only reads permissions of the file or its
 * parent.
 *
 * IMPORTANT: this can block if the path points to an unreachable
 * NAS (Windows is slow to exhaust the SMB timeout). Call it only in
 * response to an explicit user action.
 */
function isPathWritable(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.accessSync(filePath, fs.constants.W_OK);
      return true;
    }
    const dir = path.dirname(filePath);
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Returns a candidate path WITHOUT touching the filesystem. It is
 * only a suggestion to show on the welcome screen. Real existence
 * and writability are checked when the user clicks "Start" (in
 * `config:exists` and `config:create-default`).
 *
 * We do not `fs.existsSync` here because on unreachable UNC paths
 * Windows can take tens of seconds, which would block the app boot.
 */
function suggestCandidatePath() {
  return CONFIG_PATH_CANDIDATES[0];
}

/**
 * Creates the config.js file with default (v3) values at the given
 * path. Does not overwrite if it already exists.
 *
 * @param {string} filePath
 * @param {object} [meta] - { modified_by }
 * @returns {object} { creado: boolean, config, ruta, motivo? }
 */
function createDefaultConfigFile(filePath, meta = {}) {
  if (fs.existsSync(filePath)) {
    return { creado: false, motivo: 'ya_existe', ruta: filePath };
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const config = buildDefaultConfig(meta);
  writeConfigAtomic(filePath, config);
  return { creado: true, config, ruta: filePath };
}

/**
 * Loads local settings from %APPDATA%, migrating v2 -> v3 lazily.
 * Returns null if they do not exist (first boot) or are corrupt.
 */
function readSettings() {
  return readAndMigrateSettings(SETTINGS_PATH, {
    onCorrupt: (err) => logger.warn('corrupt settings.json, ignored', { error: err.message }),
    onMigrate: (info) => logger.info('settings migrated v2→v3', info),
    onBackupError: (err) => logger.warn('settings backup failed (non-blocking)', { error: err.message })
  });
}

/**
 * Persists local settings. Normalizes to v3 so a still-v2 renderer
 * payload is stored in v3 shape.
 */
function writeSettings(settings) {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  const v3 = migrateSettings(settings);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(v3, null, 2), 'utf-8');
}

// ============================================================
// Main window
// ============================================================

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    title: 'PackPrice · Calculadora de packs',
    backgroundColor: '#E8ECF1',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false  // necessary because preload.js uses require
    }
  });

  // Simplified menu (hidden by default, reachable with Alt)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Archivo',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'zoomIn',   label: 'Aumentar zoom' },
        { role: 'zoomOut',  label: 'Reducir zoom' },
        { role: 'resetZoom', label: 'Zoom 100%' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }
      ]
    }
  ]));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Reinjects the admin password into a config received from the
 * renderer (which gets it stripped). The incoming config is
 * normalized to v3 first. If the on-disk file cannot be read
 * (degraded case) we fall back to the default password instead of
 * leaving the config without a valid admin.password.
 */
function mergeWithCurrentPassword(filePath, configFromRenderer) {
  let currentPassword = null;
  try {
    const onDisk = migrateConfig(readConfigFromFile(filePath));
    currentPassword = (onDisk.admin && onDisk.admin.password) || null;
  } catch (_) {
    // New or unreadable file: fall back to the default. We don't
    // silence by habit; it's the only recovery that doesn't break
    // the in-progress admin edit.
    currentPassword = buildDefaultConfig().admin.password;
  }
  return injectAdminPassword(migrateConfig(configFromRenderer), currentPassword);
}

// ============================================================
// IPC handlers
// ============================================================

// --- Settings ---

ipcMain.handle('settings:read', () => {
  return readSettings();
});

ipcMain.handle('settings:write', (event, settings) => {
  try {
    writeSettings(settings);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Default candidate path (NAS) ---

ipcMain.handle('config:default-path', () => {
  // Instant return: a suggestion without touching the filesystem so
  // the boot does not block when the NAS is unreachable.
  return {
    candidatas: CONFIG_PATH_CANDIDATES.slice(),
    sugerida:   suggestCandidatePath()
  };
});

// --- Existence check ---

ipcMain.handle('config:exists', (event, ruta) => {
  try {
    return { existe: fs.existsSync(ruta), escribible: isPathWritable(ruta) };
  } catch (err) {
    return { existe: false, escribible: false, error: err.message };
  }
});

// --- Create config with defaults ---

ipcMain.handle('config:create-default', (event, payload) => {
  const filePath = payload.ruta ?? payload.path;
  const modifiedBy = payload.modificadoPor ?? payload.modifiedBy;
  try {
    const r = createDefaultConfigFile(filePath, { modified_by: modifiedBy });
    if (!r.creado) {
      return { ok: false, motivo: r.motivo, error: 'El archivo ya existe en esa ruta' };
    }
    const info = getFileInfo(r.ruta);
    return { ok: true, config: stripAdminPassword(r.config), info, ruta: r.ruta };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Config file selection dialog ---

ipcMain.handle('dialog:select-config', async () => {
  // We do not pass `defaultPath` pointing to the NAS: if the UNC
  // path is unreachable, Windows hangs trying to resolve it before
  // showing the dialog. We use the user's home folder as the start
  // (always instant); the explorer remembers the last location.
  const resultado = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona el archivo de configuración',
    filters: [
      { name: 'Configuración JS', extensions: ['js'] },
      { name: 'Todos los archivos', extensions: ['*'] }
    ],
    properties: ['openFile'],
    defaultPath: app.getPath('home')
  });

  if (resultado.canceled || resultado.filePaths.length === 0) {
    return { cancelado: true };
  }
  return { cancelado: false, ruta: resultado.filePaths[0] };
});

// --- Config read (with lazy v2 -> v3 migration) ---
//
// The first PC to open an old (v2) config migrates it to v3: backs
// up the original tagged `pre-v3-migration` and rewrites it
// atomically. Subsequent reads see v3 and do nothing.
ipcMain.handle('config:read', (event, payload) => {
  const filePath = (payload && typeof payload === 'object')
    ? (payload.path ?? payload.ruta)
    : payload;
  try {
    const { config } = readAndMigrateConfig(filePath, {
      onMigrate: (info) => logger.info('config migrated v2→v3', info),
      onBackupError: (err) => logger.warn('pre-v3 backup failed (non-blocking)', { error: err.message })
    });
    // Strict schema validation: fail-fast with a precise message so
    // the admin sees exactly which field is broken instead of NaNs
    // deep in the calculator.
    validateConfigSchema(config);
    const info = getFileInfo(filePath);
    return { ok: true, config: stripAdminPassword(config), info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Config write (with conflict detection) ---
//
// Receives:
//   - ruta/path: the file path
//   - configNuevo/newConfig: the configuration object to save
//   - infoEsperada/expectedInfo: { mtimeMs, hash } the renderer read
//                    when opening admin (null on first write or to skip)
//
// Returns:
//   - { ok: true, info } if saved
//   - { ok: false, conflicto: true, infoActual } on conflict
//   - { ok: false, error } on generic error

ipcMain.handle('config:write', (event, payload) => {
  const filePath = payload.ruta ?? payload.path;
  const configNuevo = payload.configNuevo ?? payload.newConfig;
  const infoEsperada = payload.infoEsperada ?? payload.expectedInfo;
  try {
    // Conflict detection: did the file change since the admin read it?
    if (infoEsperada) {
      const infoActual = getFileInfo(filePath);
      if (infoActual) {
        const cambio = (infoActual.hash !== infoEsperada.hash);
        if (cambio) {
          // Try to read the current config to show who modified it
          let modificadoPor = 'desconocido';
          let fechaActualizacion = '';
          try {
            const cfgActual = migrateConfig(readConfigFromFile(filePath));
            modificadoPor = cfgActual.modified_by || 'desconocido';
            fechaActualizacion = cfgActual.updated_at || '';
          } catch (_) {}

          logger.warn('config:write conflict detected', {
            ruta: filePath, modificadoPor, fechaActualizacion
          });
          return {
            ok: false,
            conflicto: true,
            infoActual,
            modificadoPor,
            fechaActualizacion
          };
        }
      }
    }

    // Snapshot of the previous on-disk config to compute the diff
    // before overwriting. If it cannot be read (first boot, corrupt
    // file), we continue: the audit log will show kind:'add' for
    // each new field, which is correct.
    let configPrevio = null;
    try { configPrevio = migrateConfig(readConfigFromFile(filePath)); } catch (_) {}

    const configCompleto = mergeWithCurrentPassword(filePath, configNuevo);
    validateConfigShape(configCompleto);
    validateConfigSchema(configCompleto);

    // Backup before overwriting
    const backupPath = createBackup(filePath, {
      onError: (err) => logger.warn('backup failed (non-blocking)', { ruta: filePath, error: err.message })
    });

    // Atomic write
    writeConfigAtomic(filePath, configCompleto);

    // Audit AFTER successful write (order: backup -> write -> audit).
    // If this fails, we do not break the user: the change is done
    // and a backup exists. We only log.
    try {
      const changes = configPrevio ? diffObjects(configPrevio, configCompleto) : [];
      appendAuditEntry(filePath, {
        user: configCompleto.modified_by || 'desconocido',
        app_version: app.getVersion(),
        changes
      });
      logger.info('config:write success', {
        ruta: filePath, user: configCompleto.modified_by, changes: changes.length, backupPath
      });
    } catch (auditErr) {
      logger.warn('audit append failed (non-blocking)', { error: auditErr.message });
    }

    // Return new info
    const infoNueva = getFileInfo(filePath);
    return { ok: true, info: infoNueva, backupPath };
  } catch (err) {
    logger.error('config:write failed', { ruta: filePath, error: err.message });
    return { ok: false, error: err.message };
  }
});

// --- Force write (overwrite conflict) ---
ipcMain.handle('config:force-write', (event, payload) => {
  const filePath = payload.ruta ?? payload.path;
  const configNuevo = payload.configNuevo ?? payload.newConfig;
  try {
    let configPrevio = null;
    try { configPrevio = migrateConfig(readConfigFromFile(filePath)); } catch (_) {}

    const configCompleto = mergeWithCurrentPassword(filePath, configNuevo);
    validateConfigShape(configCompleto);
    validateConfigSchema(configCompleto);
    const backupPath = createBackup(filePath, {
      onError: (err) => logger.warn('backup failed (non-blocking)', { ruta: filePath, error: err.message })
    });
    writeConfigAtomic(filePath, configCompleto);

    try {
      const changes = configPrevio ? diffObjects(configPrevio, configCompleto) : [];
      appendAuditEntry(filePath, {
        user: configCompleto.modified_by || 'desconocido',
        app_version: app.getVersion(),
        changes
      });
      logger.info('config:force-write success', {
        ruta: filePath, user: configCompleto.modified_by, changes: changes.length, backupPath
      });
    } catch (auditErr) {
      logger.warn('audit append failed (non-blocking)', { error: auditErr.message });
    }

    const infoNueva = getFileInfo(filePath);
    return { ok: true, info: infoNueva };
  } catch (err) {
    logger.error('config:force-write failed', { ruta: filePath, error: err.message });
    return { ok: false, error: err.message };
  }
});

// --- Audit log ---
//
// `audit:list` returns the last N entries of <NAS>/audit.log (oldest
// to newest within the slice). `audit:diff-preview` is a pure helper
// the renderer can use to compute the diff between the current admin
// draft and the on-disk config, used by the "review changes" modal.
ipcMain.handle('audit:list', (event, { ruta, limit }) => {
  try {
    const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 5000) : 200;
    return { ok: true, entries: readRecentEntries(ruta, lim) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('audit:diff-preview', (event, { ruta, configNuevo }) => {
  try {
    let configPrevio = null;
    try { configPrevio = migrateConfig(readConfigFromFile(ruta)); } catch (_) {}
    const configCompleto = mergeWithCurrentPassword(ruta, configNuevo);
    const changes = configPrevio ? diffObjects(configPrevio, configCompleto) : [];
    return { ok: true, changes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Admin password verification (in main, not in renderer) ---
//
// The renderer receives the config without `admin.password`, so the
// comparison must happen here. We use `crypto.timingSafeEqual` to
// avoid leaking by time. If lengths differ we return `false`
// directly: timing stays tied to the candidate length, not its
// content, which is acceptable for an "anti-accidental-click".
ipcMain.handle('auth:verify-admin', (event, { ruta, clave }) => {
  try {
    if (typeof clave !== 'string' || typeof ruta !== 'string') {
      return { ok: false, error: 'Parámetros inválidos' };
    }
    const cfg = migrateConfig(readConfigFromFile(ruta));
    const currentPassword = (cfg.admin && cfg.admin.password) || '';
    const aBuf = Buffer.from(clave, 'utf-8');
    const bBuf = Buffer.from(currentPassword, 'utf-8');
    if (aBuf.length !== bBuf.length) {
      return { ok: true, valida: false };
    }
    const valida = crypto.timingSafeEqual(aBuf, bBuf);
    return { ok: true, valida };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- File info (to detect external changes) ---
ipcMain.handle('config:info', (event, ruta) => {
  try {
    return getFileInfo(ruta);
  } catch (err) {
    return null;
  }
});

// --- Native confirmation dialog ---
ipcMain.handle('dialog:confirm-conflict', async (event, datos) => {
  const { modificadoPor, fechaActualizacion } = datos;
  const respuesta = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Conflicto al guardar',
    message: 'El archivo fue modificado mientras editabas',
    detail: `Otro usuario (${modificadoPor || 'desconocido'}) modificó el config el ${fechaActualizacion || 'sin fecha'}. ¿Cómo quieres proceder?`,
    buttons: [
      'Sobrescribir (mis cambios ganan)',
      'Descartar mis cambios (recargar)',
      'Cancelar'
    ],
    defaultId: 2,
    cancelId: 2
  });
  return respuesta.response; // 0, 1 o 2
});

ipcMain.handle('dialog:confirm', async (event, { titulo, mensaje, detalle, botones, defaultId }) => {
  const respuesta = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: titulo,
    message: mensaje,
    detail: detalle || '',
    buttons: botones || ['Aceptar', 'Cancelar'],
    defaultId: typeof defaultId === 'number' ? defaultId : 0,
    cancelId: (botones || ['Aceptar', 'Cancelar']).length - 1
  });
  return respuesta.response;
});

ipcMain.handle('dialog:info', async (event, { titulo, mensaje, detalle }) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: titulo,
    message: mensaje,
    detail: detalle || ''
  });
});

ipcMain.handle('dialog:error', async (event, { titulo, mensaje, detalle }) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: titulo,
    message: mensaje,
    detail: detalle || ''
  });
});

// --- Logs (electron-log) ---
ipcMain.handle('logs:read-last', (event, lineLimit) => {
  try {
    const limit = Number.isFinite(lineLimit) ? Math.min(Math.max(1, lineLimit), 5000) : 200;
    return { ok: true, path: getLogPath(), lines: readLastLines(limit) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Quote history (local, per-PC) ---
//
// Stored under <userData>/presupuestos.json. The renderer doesn't
// need to know the path; it just sends/receives plain quote objects.
ipcMain.handle('quotes:save', (event, draft) => {
  try {
    const saved = saveQuoteToHistory(SETTINGS_DIR, draft);
    logger.info('quote saved', { id: saved.id, total: saved.total_iva_inc });
    return { ok: true, quote: saved };
  } catch (err) {
    logger.error('quote save failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:list', () => {
  try {
    return { ok: true, quotes: listQuotes(SETTINGS_DIR) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:search', (event, query) => {
  try {
    return { ok: true, quotes: searchQuotes(SETTINGS_DIR, query) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:get', (event, id) => {
  try {
    return { ok: true, quote: getQuote(SETTINGS_DIR, id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:delete', (event, id) => {
  try {
    const removed = deleteQuote(SETTINGS_DIR, id);
    if (removed) logger.info('quote deleted', { id });
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- PDF export ---
//
// Renders the quote into a hidden BrowserWindow and uses
// `webContents.printToPDF` (built into Electron) to produce the
// file. We do not depend on external PDF libraries.
//
// Inputs:
//   { quote, company, quote_settings } -- quote is the persisted record
//                                          OR a fresh draft (result-only).
//   { defaultName }                    -- suggested file name.
//
// Returns { ok, ruta } on success or { ok:false, error } on failure.
ipcMain.handle('pdf:export', async (event, payload) => {
  const { quote, company, quote_settings, defaultName } = payload || {};
  if (!quote) return { ok: false, error: 'Falta el presupuesto a exportar.' };

  let win = null;
  let tmpHtmlPath = null;
  try {
    const saveDialog = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar presupuesto a PDF',
      defaultPath: defaultName || `${quote.id || 'presupuesto'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (saveDialog.canceled || !saveDialog.filePath) {
      return { ok: false, cancelado: true };
    }

    const html = renderQuoteHtml(quote, { company, quoteSettings: quote_settings });
    // electron-builder strips temp dirs from app userData, so use the
    // OS temp folder. The file is deleted after PDF generation.
    tmpHtmlPath = path.join(app.getPath('temp'), `packprice-quote-${Date.now()}.html`);
    fs.writeFileSync(tmpHtmlPath, html, 'utf-8');

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    await win.loadFile(tmpHtmlPath);
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'default' }
    });
    fs.writeFileSync(saveDialog.filePath, pdfBuffer);

    logger.info('pdf exported', { id: quote.id, ruta: saveDialog.filePath });
    return { ok: true, ruta: saveDialog.filePath };
  } catch (err) {
    logger.error('pdf export failed', { error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (win && !win.isDestroyed()) win.close();
    if (tmpHtmlPath && fs.existsSync(tmpHtmlPath)) {
      try { fs.unlinkSync(tmpHtmlPath); } catch (_) {}
    }
  }
});

// ============================================================
// App lifecycle
// ============================================================

app.whenReady().then(() => {
  configureLogger({ logDir: LOG_DIR });
  logger.info('app started', {
    version: app.getVersion(),
    platform: process.platform,
    userData: SETTINGS_DIR
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { message: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason) });
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
