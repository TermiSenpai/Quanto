// ============================================================
// Quanto - Electron main process
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
const os = require('os');
const crypto = require('crypto');

const { SCHEMA_VERSION, ADMIN_PASSWORD_PLACEHOLDER, buildEmptyConfig } = require('./config.default');
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
  getQuote,
  updateQuote
} = require('./lib/history');
const {
  renderQuote, BUILTIN_TEMPLATES, brandColors, listBuiltinTemplates, renderPreview
} = require('./lib/pdf-templates');
const { sanitizeTemplate } = require('./lib/template-sanitizer');
const {
  validateSettingsPayload,
  DEFAULT_ERROR_REPORTS_ENABLED
} = require('./lib/settings-validator');
const { redactSettings, mergeSettingsWrite } = require('./lib/settings-privacy');
const { scrubError } = require('./lib/error-scrubber');
const { reportError, DEFAULT_DSN } = require('./lib/error-reporter');
const { buildDiagnostics } = require('./lib/diagnostics');
const { isPathAllowed } = require('./lib/path-guard');
const { initialThrottleState, nextThrottleState } = require('./lib/admin-throttle');
const { createD1Client } = require('./lib/d1-client');
const { loadMigrations } = require('./lib/migration-loader');
const { createCloudBootstrap } = require('./lib/cloud-bootstrap');
const { migrateLegacyUserData } = require('./lib/userdata-migration');
const { autoUpdater } = require('electron-updater');
const { wireUpdater } = require('./lib/app-updater');

// --- Path configuration ---
const SETTINGS_DIR = path.join(app.getPath('userData'));
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');
const LOG_DIR = path.join(SETTINGS_DIR, 'logs');

// Legacy userData folder from before the Quanto rename. Electron derives
// userData from the product name, so the rename moved it from
// %APPDATA%\PackPrice to %APPDATA%\Quanto; we migrate it once on boot
// (lib/userdata-migration.js) so no PC loses its settings/quotes/outbox.
const LEGACY_USERDATA_DIR = path.join(app.getPath('appData'), 'PackPrice');

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
  // The offline quote outbox lives under <userData>/cache/ (next to the
  // catalog cache); the bootstrap drains it on every successful sync.
  userDataDir: SETTINGS_DIR,
  schemaVersion: SCHEMA_VERSION,
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
 * `config:exists`).
 *
 * We do not `fs.existsSync` here because on unreachable UNC paths
 * Windows can take tens of seconds, which would block the app boot.
 */
function suggestCandidatePath() {
  return CONFIG_PATH_CANDIDATES[0];
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
// Error telemetry (PRD R19) + diagnostics (PRD R17)
// ============================================================
// Opt-out: errors are scrubbed (lib/error-scrubber.js → strict
// whitelist, no business data) and posted to the developer's
// Sentry-compatible endpoint (lib/error-reporter.js) ONLY when the
// per-PC toggle is on and a DSN is configured. The reporter never
// throws; this wrapper is itself fully guarded so a telemetry bug can
// never mask the original error.

const TELEMETRY_DSN = DEFAULT_DSN;

// The schema version bundled in this build = the highest numbered SQL
// migration shipped under db/migrations/. Best-effort and cached; a
// read failure degrades to null so diagnostics never breaks.
let _bundledSchemaVersion;
function bundledSchemaVersion() {
  if (_bundledSchemaVersion !== undefined) return _bundledSchemaVersion;
  try {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    const last = migrations.length > 0 ? migrations[migrations.length - 1].id : '';
    const m = /^(\d{4})/.exec(last);
    _bundledSchemaVersion = m ? parseInt(m[1], 10) : null;
  } catch (_) {
    _bundledSchemaVersion = null;
  }
  return _bundledSchemaVersion;
}

/**
 * Resolves the error-reports opt-out toggle, applying the default
 * (ON) when the field is absent — pre-7A settings keep reporting
 * without a migration. Tolerates a null/corrupt settings read.
 */
function errorReportsEnabled(settings) {
  const s = settings || {};
  return typeof s.error_reports_enabled === 'boolean'
    ? s.error_reports_enabled
    : DEFAULT_ERROR_REPORTS_ENABLED;
}

/**
 * Builds the whitelisted meta attached to a scrubbed error. The schema
 * version is best-effort (the cloud catalog_meta carries the live one;
 * here we record only the storage mode and the bundled app/OS facts —
 * never a token or business datum).
 */
function telemetryMeta(settings) {
  const s = settings || {};
  return {
    app_version: app.getVersion(),
    schema_version: null,
    os: `${process.platform} ${os.release ? os.release() : ''}`.trim(),
    arch: process.arch,
    data_source: s.data_source || 'file'
  };
}

/**
 * Scrubs and reports an error, respecting the opt-out toggle. Fully
 * guarded: any failure inside scrubbing/reporting is swallowed (and
 * logged) so it can never propagate over the original error. Returns
 * a promise that always resolves.
 */
async function reportScrubbedError(err, settings) {
  try {
    const enabled = errorReportsEnabled(settings);
    const payload = scrubError(err, telemetryMeta(settings));
    const result = await reportError(payload, {
      dsn: TELEMETRY_DSN,
      enabled,
      fetchImpl: typeof fetch === 'function' ? fetch : undefined
    });
    if (result && result.error) {
      logger.warn('error report failed (non-blocking)', { error: result.error });
    }
    return result;
  } catch (reporterErr) {
    // A bug in the reporter must NEVER mask the original error.
    try {
      logger.warn('error reporting threw (swallowed)', { error: reporterErr.message });
    } catch (_) {}
    return { sent: false };
  }
}

// ============================================================
// Main window
// ============================================================

// Set once in app.whenReady (after the window exists) — see wireUpdater below.
let updaterController = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    title: 'Quanto · Calculadora de packs',
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
    // No prior file / unreadable: there is no default config anymore. The
    // admin gate is removed; fall back to the dead placeholder the schema
    // still requires.
    currentPassword = ADMIN_PASSWORD_PLACEHOLDER;
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

// --- Empty scaffold for the first-run wizard (renderer-shaped) ---
ipcMain.handle('config:empty', (event, payload) => {
  const modifiedBy = (payload && (payload.modificadoPor ?? payload.modifiedBy)) || undefined;
  // stripAdminPassword swaps the raw password for has_password=true, the
  // shape the renderer/admin editor expects.
  return stripAdminPassword(buildEmptyConfig({ modified_by: modifiedBy }));
});

// --- Create a NEW config file from the wizard-built config ---
ipcMain.handle('config:create', (event, payload) => {
  const filePath = payload.ruta ?? payload.path;
  const modifiedBy = payload.modificadoPor ?? payload.modifiedBy;
  const rendererCfg = payload.config;
  try {
    if (fs.existsSync(filePath)) {
      return { ok: false, motivo: 'ya_existe', error: 'El archivo ya existe en esa ruta' };
    }
    // Re-attach the (dead) admin password the schema still requires, stamp
    // author/version, validate, then write atomically (creating the dir).
    const full = injectAdminPassword(rendererCfg, ADMIN_PASSWORD_PLACEHOLDER);
    full.version = SCHEMA_VERSION;
    full.updated_at = new Date().toLocaleString('es-ES');
    full.modified_by = modifiedBy || 'sistema (alta)';
    validateConfigSchema(full); // throws a Spanish Error on any problem

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeConfigAtomic(filePath, full);

    // Only after a successful create do we bless the path, so the
    // follow-up read of that same file is allowed.
    rememberBlessedConfigPath(filePath);
    const info = getFileInfo(filePath);
    return { ok: true, ruta: filePath, info, config: stripAdminPassword(full) };
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

// Local mode (v5): the user picks a FOLDER; config.js inside it is reused
// if present, created with defaults if not. We return the folder only; the
// renderer shows it and later calls `config:folder-config-path` to resolve
// it to <folder>/config.js (path join stays in main — no path in renderer).
ipcMain.handle('dialog:select-config-folder', async () => {
  const resultado = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona la carpeta donde guardar los datos',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: app.getPath('home')
  });
  if (resultado.canceled || resultado.filePaths.length === 0) {
    return { cancelado: true };
  }
  return { cancelado: false, carpeta: resultado.filePaths[0] };
});

// Resolves a chosen folder to the config.js path inside it. Idempotent:
// a path that already points at a .js file is returned unchanged (so the
// settings field can carry the saved config.js path untouched), while a
// folder gets config.js appended. Pure path join; blessing happens later
// via `config:exists` when the user commits.
ipcMain.handle('config:folder-config-path', (event, carpeta) => {
  const s = typeof carpeta === 'string' ? carpeta.trim() : '';
  if (s === '') return { error: 'Carpeta no válida' };
  if (/\.js$/i.test(s)) return { ruta: s };
  return { ruta: path.join(s, 'config.js') };
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

ipcMain.handle('catalog:seed-initial', async (event, payload) => {
  const settings = readSettings();
  const rendererCfg = (payload && payload.config) || null;
  if (!rendererCfg) return { ok: false, error: 'Falta el catálogo a sembrar.' };
  try {
    // Re-attach the placeholder password + validate before seeding, same
    // guard the file path uses. disassemble() (inside seedInitial) drops the
    // admin section for the cloud tables.
    const full = injectAdminPassword(rendererCfg, ADMIN_PASSWORD_PLACEHOLDER);
    full.version = SCHEMA_VERSION;
    validateConfigSchema(full);
    return await cloudBootstrap.seedInitial(settings, { config: full, user: cloudAuthor(settings) });
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

// --- Cloud quotes + statistics (v5) ---
//
// Thin wiring. The local history (quotes:save) stays the per-PC source of
// truth; these mirror quotes to the shared D1 (idempotently) and compute
// statistics over all PCs' data. File mode: upload/status are no-ops
// ({ ok:true, skipped:true } — the chip state is still stored locally by
// the renderer) and stats answers { ok:false, code:'NOT_CLOUD' } so the
// screen shows the local-only note (UI-UX §2.7). The token never leaves
// main; the orchestration (upload, offline enqueue, aggregation) lives in
// lib/cloud-bootstrap.js.
ipcMain.handle('quotes:upload', async (event, payload) => {
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    return { ok: true, skipped: true };
  }
  try {
    const { quote } = payload || {};
    const result = await cloudBootstrap.saveQuote(settings, { quote });
    if (result.queued) logger.info('quotes:upload queued (offline)', { id: result.id });
    else if (!result.ok) logger.warn('quotes:upload failed', { error: result.error });
    return result;
  } catch (err) {
    logger.error('quotes:upload error', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:set-status', async (event, payload) => {
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    return { ok: true, skipped: true };
  }
  try {
    const { id, status } = payload || {};
    const result = await cloudBootstrap.setQuoteStatus(settings, { id, status });
    if (result.queued) logger.info('quotes:set-status queued (offline)', { id, status });
    else if (!result.ok) logger.warn('quotes:set-status failed', { error: result.error });
    return result;
  } catch (err) {
    logger.error('quotes:set-status error', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stats:get', async (event, payload) => {
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    return { ok: false, code: 'NOT_CLOUD' };
  }
  try {
    const { from, to } = payload || {};
    return await cloudBootstrap.getStats(settings, { from, to });
  } catch (err) {
    logger.error('stats:get error', { error: err.message });
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

// --- App update (PRD R15, now real auto-update via electron-updater) ---
// `update:check` just TRIGGERS a check; progress + result arrive on the
// renderer as `update:state` events (see wireUpdater in app.whenReady).
// `update:install` quits and installs a downloaded update. Both signal
// clearly until the updater is wired, and in dev the wrapper emits a
// `dev` phase instead of touching electron-updater.
ipcMain.handle('update:check', async () => {
  if (!updaterController) return { ok: false, error: 'Updater no inicializado.' };
  updaterController.checkForUpdates();
  return { ok: true };
});

ipcMain.handle('update:install', async () => {
  if (!updaterController) return { ok: false, error: 'Updater no inicializado.' };
  updaterController.quitAndInstall();
  return { ok: true };
});

// --- App version (renderer welcome-screen label) ---
// Lightweight, no network: the renderer reads the running version to show
// it instead of a hardcoded string (which used to drift). Distinct from
// update:check, which triggers the electron-updater flow.
ipcMain.handle('app:version', () => app.getVersion());

// --- Logs (electron-log) ---
ipcMain.handle('logs:read-last', (event, lineLimit) => {
  try {
    const limit = Number.isFinite(lineLimit) ? Math.min(Math.max(1, lineLimit), 5000) : 200;
    return { ok: true, path: getLogPath(), lines: readLastLines(limit) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Diagnostics export (PRD R17, blind support) ---
//
// Builds the diagnostics bundle (lib/diagnostics.js → logs + versions +
// storage presence + REDACTED settings, never the token or business
// data), lets the user pick where to save it via the native dialog,
// writes it and opens it. Thin wiring: the assembly + the privacy
// guarantee live in the pure lib module, which is unit-tested.
ipcMain.handle('diagnostics:export', async () => {
  try {
    const settings = readSettings();
    const bundle = buildDiagnostics({
      userDataDir: SETTINGS_DIR,
      appVersion: app.getVersion(),
      schemaVersion: bundledSchemaVersion(),
      dataSource: (settings && settings.data_source) || 'file'
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const saveDialog = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar diagnóstico',
      defaultPath: `quanto-diagnostico-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (saveDialog.canceled || !saveDialog.filePath) {
      return { ok: false, cancelado: true };
    }

    fs.writeFileSync(saveDialog.filePath, JSON.stringify(bundle, null, 2), 'utf-8');
    logger.info('diagnostics exported', { ruta: saveDialog.filePath });
    // Open the saved file so the user can review / attach it. A failure
    // to open is non-fatal — the file is already written.
    try { await shell.openPath(saveDialog.filePath); } catch (_) {}
    return { ok: true, ruta: saveDialog.filePath };
  } catch (err) {
    logger.error('diagnostics export failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

// --- Error-report toggle (PRD R19) ---
//
// The renderer's Privacy section reads/writes the opt-out toggle. We
// persist it through the same validated settings path; the default
// (ON) is applied when the field is absent. No token ever crosses here.
ipcMain.handle('error-reports:get', () => {
  try {
    return { ok: true, enabled: errorReportsEnabled(readSettings()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('error-reports:set', (event, enabled) => {
  try {
    const value = enabled === true;
    const clean = validateSettingsPayload({ error_reports_enabled: value });
    writeSettings(mergeSettingsWrite(readSettings(), clean));
    logger.info('error reports toggle set', { enabled: value });
    return { ok: true, enabled: value };
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

// Patches an existing local quote (status chip change, or recording the
// cloud UUID after an upload). The local history stays the per-PC source
// of truth; the cloud mirror is updated separately via quotes:set-status.
ipcMain.handle('quotes:update', (event, payload) => {
  try {
    const { id, patch } = payload || {};
    const updated = updateQuote(SETTINGS_DIR, id, patch || {});
    if (updated) logger.info('quote updated', { id, fields: Object.keys(patch || {}) });
    return { ok: true, quote: updated };
  } catch (err) {
    logger.error('quote update failed', { error: err.message });
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
// Template selection (Plan 6): the chosen template id comes from
// `company.pdf_template` (shared catalog data) and the brand color from
// `company.brand_color`. A built-in id renders straight from
// lib/pdf-templates.js. Any other id is a CUSTOM template: in cloud mode
// it is loaded from the shared `pdf_templates` store, SANITIZED, then
// rendered; if it can't be loaded/sanitized we fall back to 'clasica'
// so an export never fails because of a bad custom template. File mode
// has the built-ins only (custom templates are a cloud feature).
//
// Inputs:
//   { quote, company, quote_settings } -- quote is the persisted record
//                                          OR a fresh draft (result-only).
//   { defaultName }                    -- suggested file name.
//
// Returns { ok, ruta } on success or { ok:false, error } on failure.
const BUILTIN_TEMPLATE_IDS = new Set(BUILTIN_TEMPLATES.map((t) => t.id));

/**
 * Resolves the template to render for a quote export. Returns the
 * options object renderQuote expects: a built-in `templateId`, or a
 * sanitized `custom: { html }` for a cloud custom template. Falls back
 * to 'clasica' when a custom id can't be loaded/sanitized (logged).
 */
async function resolvePdfTemplate(company) {
  const requested = (company && typeof company.pdf_template === 'string')
    ? company.pdf_template.trim()
    : '';
  if (!requested || BUILTIN_TEMPLATE_IDS.has(requested)) {
    return { templateId: requested || 'clasica' };
  }
  // A non-built-in id: a custom template. Only resolvable in cloud mode.
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    logger.warn('pdf:export custom template requested in file mode, using clasica', { id: requested });
    return { templateId: 'clasica' };
  }
  try {
    const tpl = await cloudBootstrap.getPdfTemplate(settings, requested);
    if (!tpl) {
      logger.warn('pdf:export custom template not found, using clasica', { id: requested });
      return { templateId: 'clasica' };
    }
    // The stored html may carry its CSS separately; combine then sanitize.
    const combined = tpl.css ? `<style>${tpl.css}</style>${tpl.html}` : tpl.html;
    const safe = sanitizeTemplate(combined);
    return { custom: { html: safe } };
  } catch (err) {
    // A custom template that fails to load or sanitize must not break the
    // export: fall back to the built-in, surfacing the cause in the log.
    logger.warn('pdf:export custom template rejected, using clasica', { id: requested, error: err.message });
    return { templateId: 'clasica' };
  }
}

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

    const templateChoice = await resolvePdfTemplate(company);
    const brand = brandColors(company && company.brand_color);
    const html = renderQuote(quote, {
      ...templateChoice,
      company,
      quoteSettings: quote_settings,
      brand
    });
    // electron-builder strips temp dirs from app userData, so use the
    // OS temp folder. The file is deleted after PDF generation.
    tmpHtmlPath = path.join(app.getPath('temp'), `quanto-quote-${Date.now()}.html`);
    fs.writeFileSync(tmpHtmlPath, html, 'utf-8');

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Defense-in-depth: the quote templates are pure static HTML+CSS
        // (printToPDF needs no JS), so disable the JS engine entirely.
        // Even if a custom template slipped a script past the sanitizer,
        // it could not run in this render window.
        javascript: false
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

// --- PDF template gallery / preview / custom save (Task 6B) ---
//
// The renderer is a native ES module with no build step and CANNOT
// require the CommonJS lib/pdf-templates.js. So the gallery list, the
// preview HTML and the custom-template save all cross the IPC boundary:
//   pdf:list-templates → [{id,name}] (built-ins + cloud custom)
//   pdf:preview        → demo-quote HTML for a sandboxed iframe
//   pdf:save-template  → sanitize + persist a custom template (cloud)
// The API token never leaves main; the preview HTML is rendered here
// (same path as a real export) and shown only inside a sandboxed iframe
// in the renderer (no scripts), never injected into the main DOM.

// Lists the templates for the settings gallery: the built-ins always,
// plus the company's custom templates in cloud mode. A cloud-list
// failure (offline) degrades to the built-ins so the gallery still works.
ipcMain.handle('pdf:list-templates', async () => {
  const builtins = listBuiltinTemplates();
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    return { ok: true, templates: builtins, builtinIds: builtins.map((t) => t.id), cloud: false };
  }
  try {
    const custom = await cloudBootstrap.listPdfTemplates(settings);
    return {
      ok: true,
      templates: [...builtins, ...custom],
      builtinIds: builtins.map((t) => t.id),
      cloud: true
    };
  } catch (err) {
    logger.warn('pdf:list-templates cloud list failed, builtins only', { error: err.message });
    return { ok: true, templates: builtins, builtinIds: builtins.map((t) => t.id), cloud: true, partial: true };
  }
});

// Renders the demo-quote preview for the chosen template + brand color.
// Built-in ids render straight from code; any other id is a cloud custom
// template (loaded, sanitized, then rendered). Returns the HTML string —
// the renderer drops it into a sandboxed iframe's srcdoc.
ipcMain.handle('pdf:preview', async (event, payload) => {
  const { templateId, brandColor } = payload || {};
  try {
    const requested = typeof templateId === 'string' ? templateId.trim() : '';
    const isBuiltin = !requested || BUILTIN_TEMPLATE_IDS.has(requested);
    if (isBuiltin) {
      const html = renderPreview({ templateId: requested || 'clasica', brandColor });
      return { ok: true, html };
    }
    // Custom template: cloud-only. Load + sanitize before previewing.
    const settings = readSettings();
    if (!settings || settings.data_source !== 'cloud') {
      return { ok: false, error: 'Las plantillas personalizadas solo están disponibles en modo nube.' };
    }
    const tpl = await cloudBootstrap.getPdfTemplate(settings, requested);
    if (!tpl) return { ok: false, error: 'No se encontró la plantilla seleccionada.' };
    const combined = tpl.css ? `<style>${tpl.css}</style>${tpl.html}` : tpl.html;
    const safe = sanitizeTemplate(combined);
    const html = renderPreview({ custom: { html: safe }, brandColor });
    return { ok: true, html };
  } catch (err) {
    logger.warn('pdf:preview failed', { error: err.message });
    return { ok: false, error: 'No se pudo generar la vista previa de la plantilla.' };
  }
});

// Saves a user-authored custom template (cloud only). The HTML is
// sanitized in the bootstrap before it is ever stored; a rejected
// template returns { ok:false, error } with a plain Spanish message that
// the renderer shows verbatim. The token never leaves main.
ipcMain.handle('pdf:save-template', async (event, payload) => {
  const { name, html } = payload || {};
  const settings = readSettings();
  if (!settings || settings.data_source !== 'cloud') {
    return { ok: false, error: 'Las plantillas personalizadas solo están disponibles en modo nube.' };
  }
  const result = await cloudBootstrap.savePdfTemplate(settings, { name, html });
  if (result.ok) {
    logger.info('pdf:save-template saved', { id: result.id });
  } else {
    logger.warn('pdf:save-template rejected', { error: result.error });
  }
  return result;
});

// ============================================================
// App lifecycle
// ============================================================

app.whenReady().then(() => {
  // Carry over a pre-rename (PackPrice) userData folder BEFORE the logger
  // opens a handle in the new logs dir — copying over an in-use log file
  // would fail on Windows. We log the outcome right after configuring it.
  let userDataMigrated = false;
  let userDataMigrateError = null;
  migrateLegacyUserData({
    currentDir: SETTINGS_DIR,
    legacyDir: LEGACY_USERDATA_DIR,
    onMigrated: () => { userDataMigrated = true; },
    onError: (err) => { userDataMigrateError = err; }
  });

  configureLogger({ logDir: LOG_DIR });

  if (userDataMigrated) {
    logger.info('migrated legacy PackPrice userData → Quanto', {
      from: LEGACY_USERDATA_DIR, to: SETTINGS_DIR
    });
  }
  if (userDataMigrateError) {
    logger.warn('legacy userData migration failed (non-blocking)', {
      error: userDataMigrateError.message
    });
  }

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

  // Unhandled main-process errors: log locally (fail-fast surfacing,
  // unchanged) AND route a scrubbed report to the developer endpoint
  // when the opt-out toggle is on (PRD R19). Reporting is fully guarded
  // inside reportScrubbedError so it can never mask the original error;
  // we still read settings defensively here.
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { message: err && err.message, stack: err && err.stack });
    let settings = null;
    try { settings = readSettings(); } catch (_) {}
    void reportScrubbedError(err, settings);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: String(reason) });
    let settings = null;
    try { settings = readSettings(); } catch (_) {}
    void reportScrubbedError(reason, settings);
  });

  createMainWindow();

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
