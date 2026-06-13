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

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
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
const { validateSettingsPayload } = require('./lib/settings-validator');
const { redactSettings, mergeSettingsWrite } = require('./lib/settings-privacy');
const { isPathAllowed } = require('./lib/path-guard');
const { initialThrottleState, nextThrottleState } = require('./lib/admin-throttle');
const { createD1Client } = require('./lib/d1-client');
const { loadMigrations } = require('./lib/migration-loader');
const { createCloudBootstrap } = require('./lib/cloud-bootstrap');

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

// --- Cloud mode (v5): all orchestration lives in lib/cloud-bootstrap.js;
// the handlers below are thin wiring. Network only in main, ever.
const CATALOG_CACHE_PATH = path.join(SETTINGS_DIR, 'cache', 'catalog.json');
const CLOUD_BACKUP_DIR = path.join(SETTINGS_DIR, 'backups');
const MIGRATIONS_DIR = path.join(__dirname, 'db', 'migrations');

const cloudBootstrap = createCloudBootstrap({
  createClient: createD1Client,
  loadMigrations: () => loadMigrations(MIGRATIONS_DIR),
  cachePath: CATALOG_CACHE_PATH,
  backupDir: CLOUD_BACKUP_DIR,
  buildDefaultConfig,
  appVersion: app.getVersion(),
  // Dropped cloud errors (cache fallback, lock-release throws) are
  // logged here so they are never silently swallowed (hard rule §4).
  log: (msg, meta) => logger.warn(msg, meta)
});

let mainWindow = null;

// ============================================================
// IPC path allow-list (Item D — security hardening)
// ============================================================
// Renderer-supplied paths must point at a "blessed" config.js (or its
// sidecar audit.log / backups/). The set is the union of the default
// candidates, the path persisted in settings.config_path, and any path
// the user picks via the native dialog this session. It is seeded on
// startup (app.whenReady) and grows when the user picks/sets a path.
const blessedConfigPaths = new Set(CONFIG_PATH_CANDIDATES);

function rememberBlessedConfigPath(filePath) {
  if (typeof filePath === 'string' && filePath !== '') {
    blessedConfigPaths.add(filePath);
  }
}

/**
 * Guards every handler that takes a renderer-supplied path. Throws a
 * Spanish error unless the path is a blessed config or its sidecar
 * (audit.log / backups/). Keeps a compromised renderer from coaxing
 * main into reading/writing arbitrary files.
 */
function assertConfigPathAllowed(ruta) {
  if (!isPathAllowed(blessedConfigPaths, ruta)) {
    throw new Error('Ruta no permitida.');
  }
}

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
//
// Token privacy (redact on read, re-attach on write) lives in
// lib/settings-privacy.js so it is pure and unit-tested; the handlers
// here stay thin wiring.

ipcMain.handle('settings:read', () => {
  return redactSettings(readSettings());
});

ipcMain.handle('settings:write', (event, settings) => {
  try {
    // Validate + strip to known fields before persisting; never write
    // a raw renderer object to disk (Item A — security hardening).
    const clean = validateSettingsPayload(settings);
    if (typeof clean.config_path === 'string' && clean.config_path !== '') {
      rememberBlessedConfigPath(clean.config_path);
    }
    // The renderer never holds the cloud token (settings:read redacts
    // it), so a renderer round-trip must not wipe what only main
    // knows: mergeSettingsWrite re-attaches the stored token and keeps
    // the stored data_source/cloud when the payload omits them.
    writeSettings(mergeSettingsWrite(readSettings(), clean));
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
    // `config:exists` is the explicit "I want to use this path" probe
    // during setup (welcome screen / error screen). It is a benign
    // existence + writability check (no content read, no write), so we
    // treat it as the user committing to a config path and bless it for
    // this session. The content handlers (read/write/info/audit) stay
    // guarded against any path never surfaced this way (Item D).
    if (typeof ruta === 'string' && ruta !== '') {
      rememberBlessedConfigPath(ruta);
    }
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
    // Only after a successful create do we bless the path, so the
    // follow-up read of that same file is allowed. A failed create
    // never widens the allow-list.
    rememberBlessedConfigPath(r.ruta);
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
  // A path the user explicitly picked via the native dialog is trusted
  // for this session (Item D): bless it so the follow-up read/write of
  // that config is allowed.
  const picked = resultado.filePaths[0];
  rememberBlessedConfigPath(picked);
  return { cancelado: false, ruta: picked };
});

// --- Cloud (v5): first-run wizard + catalog read path ---
//
// Thin wiring only: the orchestration (timeouts, cache fallback, the
// §6 migration-safety contract) lives in lib/cloud-bootstrap.js and
// is unit-tested there. The API token stays inside main: payloads in,
// assemble() configs out — never the token, never an admin section.

ipcMain.handle('cloud:test-token', (event, payload) => {
  return cloudBootstrap.testToken(payload || {});
});

ipcMain.handle('cloud:provision', async (event, payload) => {
  const { token, accountId } = payload || {};
  const settings = readSettings() || {};
  const result = await cloudBootstrap.provision({
    token, accountId, user: settings.user_name || 'desconocido'
  });
  if (result.ok) {
    // Persist the working cloud connection so the next boot starts
    // from D1. The token lives only in the per-PC settings.json.
    // Re-read settings RIGHT before merging: provisioning is a long
    // await, so a concurrent settings:write must not be clobbered by
    // the snapshot we took before it ran.
    const latest = readSettings() || {};
    writeSettings({
      ...latest,
      data_source: 'cloud',
      cloud: {
        token,
        account_id: accountId,
        database_id: result.databaseId,
        user_name: latest.user_name || ''
      }
    });
    logger.info('cloud:provision success', { databaseId: result.databaseId, seeded: result.seeded });
  } else {
    logger.error('cloud:provision failed', { code: result.code, error: result.error });
  }
  return result;
});

ipcMain.handle('catalog:load', () => cloudBootstrap.loadCatalog(readSettings()));

ipcMain.handle('catalog:check-version', () => cloudBootstrap.checkVersion(readSettings()));

ipcMain.handle('catalog:refresh', () => cloudBootstrap.refreshCatalog(readSettings()));

// The catalog edit author for the audit log + catalog_meta. Prefer the
// cloud-specific name, fall back to the PC's general name, then a generic
// (the audit must always carry someone — CLAUDE.md §2: v5 replaces the
// admin password with author + audit + snapshot).
function cloudAuthor(settings) {
  const s = settings || {};
  return (s.cloud && s.cloud.user_name) || s.user_name || 'Equipo';
}

// catalog:save → guarded per-entity write (cloud mode). Thin wiring: the
// renderer passes the edited cfg + the version map it loaded; the
// orchestration (re-load baseline, writeEntities, cache refresh) lives in
// lib/cloud-bootstrap.js. The token never leaves main.
ipcMain.handle('catalog:save', async (event, payload) => {
  const settings = readSettings();
  const { newCfg, expectedVersions } = payload || {};
  const result = await cloudBootstrap.saveCatalog(settings, {
    newCfg, expectedVersions, user: cloudAuthor(settings)
  });
  if (result.ok) {
    logger.info('catalog:save success', {
      catalogVersion: result.catalogVersion, entities: result.results.length
    });
  } else {
    logger.warn('catalog:save conflicts', { conflicts: result.conflicts.length });
  }
  return result;
});

// --- Config read (with lazy v2 -> v3 migration) ---
//
// The first PC to open an old (v2) config migrates it to v3: backs
// up the original tagged `pre-v3-migration` and rewrites it
// atomically. Subsequent reads see v3 and do nothing.
ipcMain.handle('config:read', (event, payload) => {
  // Cloud mode answers with the same { ok, config, … } envelope so
  // the current renderer keeps working; the file path is ignored.
  // File mode below stays untouched.
  const settings = readSettings();
  if (settings && settings.data_source === 'cloud') {
    return cloudBootstrap.loadCatalog(settings);
  }
  const filePath = (payload && typeof payload === 'object')
    ? (payload.path ?? payload.ruta)
    : payload;
  try {
    assertConfigPathAllowed(filePath);
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
  // Cloud mode routes the admin-save channel through the guarded
  // per-entity writer and answers a shape the renderer understands
  // ({ ok } or { ok:false, conflicts, results }). File mode below stays
  // byte-identical. The renderer passes the edited full cfg + the
  // version map it loaded (so concurrency is detected per entity).
  const settings = readSettings();
  if (settings && settings.data_source === 'cloud') {
    const newCfg = payload.configNuevo ?? payload.newConfig;
    const expectedVersions = payload.expectedVersions ?? payload.versions;
    return cloudBootstrap.saveCatalog(settings, {
      newCfg, expectedVersions, user: cloudAuthor(settings)
    }).then((result) => {
      if (result.ok) {
        logger.info('config:write (cloud) success', { catalogVersion: result.catalogVersion });
      } else {
        logger.warn('config:write (cloud) conflicts', { conflicts: result.conflicts.length });
      }
      return result;
    });
  }

  const filePath = payload.ruta ?? payload.path;
  const configNuevo = payload.configNuevo ?? payload.newConfig;
  const infoEsperada = payload.infoEsperada ?? payload.expectedInfo;
  try {
    assertConfigPathAllowed(filePath);
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
    assertConfigPathAllowed(filePath);
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
// `audit:list` returns the change history. In CLOUD mode it reads the
// D1 audit_log (newest-first, paginated by {limit, offset}); in FILE
// mode it returns the last N entries of <NAS>/audit.log (oldest to
// newest within the slice). Both answer the same { ok, entries }
// envelope so the renderer handles one shape. `audit:diff-preview` is a
// pure helper for the file-mode "review changes" modal.
ipcMain.handle('audit:list', async (event, payload) => {
  const settings = readSettings();
  if (settings && settings.data_source === 'cloud') {
    try {
      const { limit, offset } = payload || {};
      const entries = await cloudBootstrap.getAudit(settings, { limit, offset });
      return { ok: true, entries };
    } catch (err) {
      logger.warn('audit:list (cloud) failed', { error: err.message });
      return { ok: false, error: err.message };
    }
  }
  const { ruta, limit } = payload || {};
  try {
    assertConfigPathAllowed(ruta);
    const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 5000) : 200;
    return { ok: true, entries: readRecentEntries(ruta, lim) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Cloud snapshots (v5): version list + forward-only restore ---
//
// Cloud-only. File mode answers { ok:false, code:'NOT_CLOUD' } so the
// renderer can hide the feature without a hard error. The token never
// leaves main; the orchestration lives in lib/cloud-bootstrap.js.
ipcMain.handle('snapshots:list', async () => {
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    return { ok: false, code: 'NOT_CLOUD' };
  }
  try {
    const versions = await cloudBootstrap.getSnapshots(settings);
    return { ok: true, versions };
  } catch (err) {
    logger.warn('snapshots:list failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('snapshots:restore', async (event, payload) => {
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    return { ok: false, code: 'NOT_CLOUD' };
  }
  try {
    const { version } = payload || {};
    const result = await cloudBootstrap.restore(settings, { version });
    if (result.ok) {
      logger.info('snapshots:restore success', { version, catalogVersion: result.catalogVersion });
    } else {
      logger.warn('snapshots:restore conflicts', { version });
    }
    return result;
  } catch (err) {
    logger.error('snapshots:restore failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('audit:diff-preview', (event, { ruta, configNuevo }) => {
  try {
    assertConfigPathAllowed(ruta);
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
// In-memory throttle state (per main-process, not persisted). Reset
// on restart, which is fine for an internal anti-accidental-click gate.
let adminThrottle = initialThrottleState();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ADMIN_LOCK_MESSAGE = 'Demasiados intentos. Espera unos segundos e inténtalo de nuevo.';

ipcMain.handle('auth:verify-admin', async (event, { ruta, clave }) => {
  try {
    if (typeof clave !== 'string' || typeof ruta !== 'string') {
      return { ok: false, error: 'Parámetros inválidos' };
    }
    assertConfigPathAllowed(ruta);

    // Reject up front if we are inside an active lock window, without
    // even reading the config or evaluating the password (Item C).
    if (adminThrottle.lockedUntil && Date.now() < adminThrottle.lockedUntil) {
      return { ok: false, error: ADMIN_LOCK_MESSAGE };
    }

    const cfg = migrateConfig(readConfigFromFile(ruta));
    const currentPassword = (cfg.admin && cfg.admin.password) || '';
    const aBuf = Buffer.from(clave, 'utf-8');
    const bBuf = Buffer.from(currentPassword, 'utf-8');
    const valida = (aBuf.length === bBuf.length) && crypto.timingSafeEqual(aBuf, bBuf);

    // Advance the throttle: escalate delay/lock on failure, reset on
    // success. The pure state machine decides; the handler enforces.
    const transition = nextThrottleState(adminThrottle, valida, Date.now());
    adminThrottle = transition.state;

    if (transition.locked) {
      logger.warn('auth:verify-admin locked (too many attempts)', { ruta });
      return { ok: false, error: ADMIN_LOCK_MESSAGE };
    }
    if (transition.delayMs > 0) {
      await sleep(transition.delayMs);
    }
    return { ok: true, valida };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- File info (to detect external changes) ---
ipcMain.handle('config:info', (event, ruta) => {
  try {
    assertConfigPathAllowed(ruta);
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

// --- Open an external URL in the system browser (cloud wizard) ---
//
// The first-run wizard (UI-UX §2.0) needs "Abrir Cloudflare" buttons
// that send the user to the Cloudflare sign-up / API-token pages.
// Opening happens HERE, in main, via shell.openExternal — the
// renderer never navigates or fetches (CSP stays `default-src 'self'`).
// We only ever open https URLs so a crafted payload cannot launch a
// local file or a custom protocol handler.
ipcMain.handle('dialog:open-external', async (event, url) => {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'Solo se pueden abrir enlaces https.' };
    }
    await shell.openExternal(parsed.href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    logger.info('quote saved', { id: saved.id, total: saved.totals && saved.totals.total_vat_inc });
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

  // Seed the path allow-list with the config_path persisted on this PC
  // (Item D). Default candidates are blessed at module load.
  try {
    const saved = readSettings();
    if (saved && typeof saved.config_path === 'string') {
      rememberBlessedConfigPath(saved.config_path);
    }
  } catch (_) {}

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
