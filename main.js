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
// lib/history.js is NO LONGER the source of truth for the quotes:* IPC
// (Phase B routes them through the shared quote repository below). It is
// kept on disk for B5's one-time migration of any legacy presupuestos.json.
const quoteRepoFile = require('./lib/quote-repo-file');
const quoteRepoCloud = require('./lib/quote-repo-cloud');
const {
  readQuoteCache,
  writeQuoteCache
} = require('./lib/quote-cache');
const { enqueueFullQuote } = require('./lib/quote-outbox');
const {
  quotesFolder,
  newPendingId
} = require('./lib/quote-store-helpers');
const {
  isBackendUnreachable,
  isPermissionError,
  drainQueuedFullQuote
} = require('./lib/quote-drain');
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
const { readAllQuotes, historyPathFor, HISTORY_FILE_NAME } = require('./lib/history');
const { migrateLocalQuotes, partitionMigratableQuotes } = require('./lib/quote-migrate-local');
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
  log: (msg, meta) => logger.warn(msg, meta),
  // Phase B: drains the offline fullQuotes lane on every successful sync.
  // Reconciles a provisional offline-create id into a real PP-YYYY-NNNN
  // one and refreshes the per-PC cache (declared below; hoisted).
  drainFullQuote: drainFullQuoteToCloud
});

// ============================================================
// Shared quote repository (Phase B)
// ============================================================
// The quotes:* IPC routes through ONE uniform façade bound to the
// active backend (file: <configDir>/presupuestos/<id>.json; cloud: the
// customer's D1). It normalizes the two backends' differing
// conflict tokens (file {mtime,sha256} vs cloud {version}) into one
// opaque `token` that the renderer only echoes back on an edit-save —
// the token never leaves main. The per-PC cache (lib/quote-cache.js)
// mirrors the last good read for the offline list/get fallback; offline
// writes go to the fullQuotes outbox lane (lib/quote-outbox.js).
//
// The error classification (isBackendUnreachable) and the offline-drain
// routing (create vs edit) live in lib/quote-drain.js so they are pure +
// unit-tested (Electron can't be launched in tests).

/**
 * Returns the active quote backend as a uniform async interface,
 * normalizing the two backends' conflict tokens into one opaque `token`.
 * File mode wraps the synchronous lib/quote-repo-file.js fns; cloud mode
 * binds lib/quote-repo-cloud.js to a D1 client built from settings.
 *
 * @param {object} settings - per-PC settings (data_source + config_path/cloud)
 * @returns {object} the uniform repo (createQuote/getQuote/listQuotes/…)
 */
function quoteRepo(settings) {
  const isCloud = settings && settings.data_source === 'cloud';

  if (isCloud) {
    const client = cloudBootstrap.clientFor(settings);
    return {
      async createQuote(draft) {
        return quoteRepoCloud.createQuote(client, draft);
      },
      async getQuote(id) {
        const res = await quoteRepoCloud.getQuote(client, id);
        if (!res) return null;
        return { quote: res.quote, token: { version: res.version } };
      },
      async listQuotes() {
        return quoteRepoCloud.listQuotes(client);
      },
      async searchQuotes(query) {
        return quoteRepoCloud.searchQuotes(client, query);
      },
      async replaceQuote(id, draft, token) {
        // token === null ⇒ force: re-read the CURRENT version and update
        // against it so the guarded write always wins.
        let expected = token && token.version;
        if (token === null) {
          const cur = await quoteRepoCloud.getQuote(client, id);
          if (!cur) return null;
          expected = cur.version;
        }
        const res = await quoteRepoCloud.replaceQuote(client, id, draft, expected);
        if (res && res.conflict) {
          const cur = await quoteRepoCloud.getQuote(client, id);
          return { conflict: true, current: cur ? cur.quote : null };
        }
        return res;
      },
      async setStatus(id, status, statusTs) {
        return quoteRepoCloud.setStatus(client, id, status, statusTs);
      },
      async deleteQuote(id) {
        return quoteRepoCloud.deleteQuote(client, id);
      }
    };
  }

  const folder = quotesFolder(settings.config_path);
  return {
    async createQuote(draft) {
      return quoteRepoFile.createQuote(folder, draft);
    },
    async getQuote(id) {
      const res = quoteRepoFile.getQuote(folder, id);
      if (!res) return null;
      return { quote: res.quote, token: { mtime: res.mtime, sha256: res.sha256 } };
    },
    async listQuotes() {
      return quoteRepoFile.listQuotes(folder, { log: (m) => logger.warn(m) });
    },
    async searchQuotes(query) {
      return quoteRepoFile.searchQuotes(folder, query, { log: (m) => logger.warn(m) });
    },
    async replaceQuote(id, draft, token) {
      // token === null ⇒ force: pass no `expected` so the conflict check
      // is skipped. Otherwise pass the {mtime,sha256} token straight.
      const expected = token === null ? null : token;
      const res = quoteRepoFile.replaceQuote(folder, id, draft, expected);
      if (res && res.conflict) {
        const cur = quoteRepoFile.getQuote(folder, id);
        return { conflict: true, current: cur ? cur.quote : null };
      }
      return res;
    },
    async setStatus(id, status, statusTs) {
      return quoteRepoFile.setStatus(folder, id, { status, status_ts: statusTs });
    },
    async deleteQuote(id) {
      return quoteRepoFile.deleteQuote(folder, id);
    }
  };
}

// ── per-PC quote cache helpers ─────────────────────────────────
// The cache mirrors the last good backend read so the history list and a
// reopen still answer when the backend is briefly unreachable. A cache
// read/write failure is never fatal (logged, never surfaced over the
// real result): the cache is a convenience, not the source of truth.

function readQuoteCacheSafe() {
  try {
    return readQuoteCache(SETTINGS_DIR);
  } catch (err) {
    logger.warn('quote cache read failed (ignored)', { error: err.message });
    return null;
  }
}

// Maps a full quote to the lightweight list-row shape the history list
// renders (mirrors lib/quote-repo-cloud.js listQuotes' projection).
function quoteListRow(q) {
  return {
    id: q.id,
    date: q.date || q.ts,
    user: q.user,
    customer: { name: q.customer && q.customer.name },
    total_vat_inc: (q.totals && q.totals.total_vat_inc) != null ? q.totals.total_vat_inc : q.total_vat_inc,
    status: q.status,
    pack_id: q.pack_id
  };
}

// Refreshes the cached list (from the rows the backend just returned)
// while preserving any already-cached payloads. Best-effort.
function refreshCachedList(list) {
  try {
    const prev = readQuoteCacheSafe();
    writeQuoteCache(SETTINGS_DIR, {
      fetchedAt: new Date().toISOString(),
      list: Array.isArray(list) ? list : [],
      payloads: (prev && prev.payloads) || {}
    });
  } catch (err) {
    logger.warn('quote cache list refresh failed (ignored)', { error: err.message });
  }
}

// Upserts one full quote into the cache (its list row + payload). Used on
// a successful save/get/edit so a warm cache can answer offline. Best-effort.
function upsertCachedQuote(quote) {
  if (!quote || !quote.id) return;
  try {
    const prev = readQuoteCacheSafe() || { list: [], payloads: {} };
    const payloads = { ...(prev.payloads || {}), [quote.id]: quote };
    const list = (prev.list || []).filter((r) => r.id !== quote.id);
    list.unshift(quoteListRow(quote));
    list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    writeQuoteCache(SETTINGS_DIR, { fetchedAt: new Date().toISOString(), list, payloads });
  } catch (err) {
    logger.warn('quote cache upsert failed (ignored)', { error: err.message });
  }
}

// Removes one quote from the cache (list row + payload). Best-effort.
function removeCachedQuote(id) {
  if (!id) return;
  try {
    const prev = readQuoteCacheSafe();
    if (!prev) return;
    const payloads = { ...(prev.payloads || {}) };
    delete payloads[id];
    const list = (prev.list || []).filter((r) => r.id !== id);
    writeQuoteCache(SETTINGS_DIR, { fetchedAt: new Date().toISOString(), list, payloads });
  } catch (err) {
    logger.warn('quote cache remove failed (ignored)', { error: err.message });
  }
}

// Replaces a provisional offline-create entry with the real saved quote:
// drops the PP-PENDING-… payload/list row and inserts the real one.
function reconcileCachedQuote(provisionalId, realQuote) {
  removeCachedQuote(provisionalId);
  upsertCachedQuote(realQuote);
}

/**
 * Drains one full reopenable quote buffered offline against the cloud
 * (Phase B fullQuotes lane), routing CREATE vs EDIT correctly via the pure
 * lib/quote-drain.js (a CREATE assigns a real id + reconciles the cache; an
 * EDIT goes through the force-update path so the edited payload is actually
 * written and `version` bumps — never create-only saveFullQuote). Throws on
 * failure so the outbox keeps the item for a later retry.
 *
 * @param {object} client - the live D1 client (bound by cloud-bootstrap)
 * @param {object} quote - the queued full reopenable quote
 */
async function drainFullQuoteToCloud(client, quote) {
  return drainQueuedFullQuote({
    createQuote: (draft) => quoteRepoCloud.createQuote(client, draft),
    // null token ⇒ force (current-version re-read), so the queued edit lands.
    replaceQuote: (id, q, token) => quoteRepoCloud.replaceQuote(client, id, q, token),
    reconcileCachedQuote,
    upsertCachedQuote
  }, quote);
}

// ============================================================
// B5 · one-time migration of per-PC quotes → shared store
// ============================================================
// A PC upgrading from a pre-Phase-B build still has its quotes in the
// legacy per-PC presupuestos.json (lib/history.js). Phase B made the
// shared store (file folder next to config.js, or D1 quote_payloads) the
// source of truth, so on boot we push those legacy quotes into the
// shared store once, idempotently — preserving each quote's existing id
// and skipping any id already present (so re-runs and multi-PC boots
// never duplicate). On a fully-clean run (no failures) the legacy file
// is renamed to a .bak-pre-shared safety copy (never deleted by the app).
// Best-effort and logged: a hiccup must never block boot (hard rule §4).
async function migratePerPcQuotesToSharedStore() {
  try {
    const legacyPath = historyPathFor(SETTINGS_DIR);
    const settings = readSettings() || {};
    const isCloud = settings.data_source === 'cloud';

    // Cloud mode: do NOT attempt per-quote migration. Legacy per-PC quotes
    // carry the buildQuoteDraft shape (user/customer/result/totals/opt/…)
    // but NOT the flat stat fields tryClaimFullQuote → validateQuoteRow
    // requires (ts, tier, total_units, total_vat_inc, sale_base, margin_pct,
    // catalog_version). A correct cloud backfill needs catalog-dependent
    // flat-field derivation (tier), id-bridging against the pre-Phase-B
    // UUID-keyed flat rows, and stats de-dup — out of scope here, and cloud
    // mode is brand-new so legacy local data in cloud is an edge case
    // (tracked for B8). So we keep the data fully intact and log the skip.
    //
    // We do NOT call readAllQuotes here: it lazily REWRITES presupuestos.json
    // in place when it finds v2 (Spanish-key) entries. Touching nothing in
    // cloud mode means a cheap existence check, not a full parse + rewrite.
    if (isCloud) {
      if (fs.existsSync(legacyPath)) {
        logger.warn(
          `cloud mode: legacy local quotes in ${HISTORY_FILE_NAME} were NOT ` +
          'auto-migrated to the shared store (kept intact); cloud backfill of ' +
          'pre-Phase-B quotes is not yet supported'
        );
      }
      return;
    }

    // File mode. The shared store must be configured (the wizard sets
    // config_path on first run); otherwise skip and retry on a later boot.
    if (!settings.config_path) {
      logger.info('quote migration skipped: shared config path not set yet');
      return;
    }

    // Read the legacy per-PC file (lazily migrates v2→v3 entries — fine in
    // file mode, where we are about to consume + retire it). Empty/missing →
    // nothing to do.
    const localQuotes = readAllQuotes(SETTINGS_DIR);
    if (!localQuotes || localQuotes.length === 0) return;

    // Drop structurally-invalid entries (null / non-object / bad id) from the
    // attempt: the id-preserving adapter could only ever THROW on them, and
    // counting that as `failed` would wedge the migration into endless retry
    // (the source never gets renamed). They are NOT lost — the original file
    // becomes the .bak-pre-shared backup. So `failed` reflects only transient
    // fs errors, the correct gate for "keep the source for retry".
    const { migratable, invalid } = partitionMigratableQuotes(localQuotes, quoteRepoFile.isValidId);
    if (invalid.length > 0) {
      logger.warn('per-PC quote migration: dropped structurally-invalid entries (preserved in backup)', {
        dropped: invalid.length
      });
    }

    const folder = quotesFolder(settings.config_path);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const putIfAbsent = async (q) => quoteRepoFile.putQuoteIfAbsent(folder, q);

    const summary = await migrateLocalQuotes(migratable, putIfAbsent);
    logger.info('per-PC quote migration ran (file mode)', {
      total: summary.total,
      migrated: summary.migrated,
      skipped: summary.skipped,
      failed: summary.failed,
      droppedInvalid: invalid.length
    });

    if (summary.failed === 0) {
      // Every migratable entry is now in the shared store (migrated or
      // already present). Retire the legacy file to a safety copy — never
      // delete. Only rename when the source still exists (a prior partial run
      // may have left an older .bak-pre-shared; that's fine, we overwrite it).
      if (fs.existsSync(legacyPath)) {
        const backupPath = legacyPath + '.bak-pre-shared';
        fs.renameSync(legacyPath, backupPath);
        logger.info('legacy presupuestos.json retired after migration', { backupPath });
      }
    } else {
      // Leave the source in place so the next boot retries the remaining
      // entries (already-migrated ids are skipped). Surface the causes, but
      // bound the log: a backend-wide failure would otherwise dump one
      // id+message per quote on every boot.
      logger.warn('per-PC quote migration had transient failures; source kept for retry', {
        failed: summary.failed,
        firstErrors: summary.errors.slice(0, 5),
        moreErrors: Math.max(0, summary.errors.length - 5)
      });
    }
  } catch (err) {
    // Never block or crash boot on a migration hiccup (hard rule §4: log
    // it, don't swallow silently). The legacy file is untouched on a throw.
    logger.warn('per-PC quote migration failed (non-blocking)', {
      error: err && err.message
    });
  }
}

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
// Legacy cloud flat-row mirror (Phase B: no longer called by the renderer).
// quotes:save now routes to the SHARED store via quoteRepo(settings); these
// quotes:upload / quotes:set-status handlers are the old per-PC → D1
// flat-row mirror path and are kept pending removal. File mode: upload/
// status are no-ops ({ ok:true, skipped:true }) and stats answers
// { ok:false, code:'NOT_CLOUD' } so the screen shows the local-only note
// (UI-UX §2.7). The token never leaves main; the orchestration lives in
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

// --- Quote history (shared store, Phase B) ---
//
// Routes through the uniform quote repository (quoteRepo above): file
// mode → <configDir>/presupuestos/<id>.json; cloud mode → the customer's
// D1. The renderer sends/receives plain quote objects; the conflict token
// is opaque and never leaves main (it rides inside the draft on an edit as
// draft.__token, and draft.__force forces a save past a conflict). The
// per-PC cache (lib/quote-cache.js) backs the offline list/get fallback;
// offline writes go to the fullQuotes outbox lane.

// Pulls the transient save envelope (token + force flag the renderer adds
// on an edit-save) off a draft, returning the clean draft to persist and
// the extracted { token, force }. These fields must NEVER be stored.
function extractSaveEnvelope(draft) {
  if (!draft || typeof draft !== 'object') return { clean: draft, token: undefined, force: false };
  const { __token, __force, ...clean } = draft;
  return { clean, token: __token, force: __force === true };
}

ipcMain.handle('quotes:save', async (event, draft) => {
  const settings = readSettings();
  const { clean, token, force } = extractSaveEnvelope(draft);
  const repo = quoteRepo(settings);
  const isEdit = Boolean(clean && clean.id);
  try {
    let saved;
    if (isEdit) {
      const res = await repo.replaceQuote(clean.id, clean, force ? null : (token || null));
      if (res === null) {
        return { ok: false, error: `No se encontró el presupuesto ${clean.id}.` };
      }
      if (res.conflict) {
        logger.info('quote save conflict', { id: clean.id });
        return { ok: false, conflict: true, current: res.current };
      }
      saved = res.quote;
      logger.info('quote replaced (edit)', { id: saved.id });
    } else {
      saved = await repo.createQuote(clean);
      logger.info('quote saved', { id: saved.id, total: saved.totals && saved.totals.total_vat_inc });
    }
    upsertCachedQuote(saved);
    return { ok: true, quote: saved };
  } catch (err) {
    // A CLOUD-unreachable error must never lose the quote: buffer the FULL
    // quote to the outbox (it drains on the next successful cloud sync) and
    // report it queued. A validation/size/conflict error is a data bug —
    // surface it, never queue.
    //
    // File mode has no outbox drain (the NAS file IS the backend), so a
    // folder-unreachable error there is surfaced for an explicit retry once
    // the NAS is back — the renderer keeps the data on screen. Queuing it
    // into a lane nothing drains in file mode would be a silent black hole.
    const isCloud = settings && settings.data_source === 'cloud';
    if (isCloud && isBackendUnreachable(err)) {
      try {
        // The displayed/cached quote carries no transient marker; the queued
        // copy carries `__op` so the drain (lib/quote-drain.js) routes it to
        // the RIGHT cloud op — an EDIT through the force-update path (so the
        // edit is actually written), a CREATE through id assignment.
        let display;
        if (isEdit) {
          // An edit already owns a real id; mark it so the drain UPDATES it
          // (never the create-only path, which would no-op and lose the edit).
          display = clean;
          enqueueFullQuote(SETTINGS_DIR, { ...clean, __op: 'edit' });
        } else {
          // A fresh offline create gets a provisional id until the drain
          // assigns the real one and reconciles the cache.
          display = { ...clean, id: newPendingId(), version: 1 };
          enqueueFullQuote(SETTINGS_DIR, { ...display, __op: 'create' });
        }
        upsertCachedQuote(display);
        logger.info('quote queued (offline)', { id: display.id, edit: isEdit });
        return { ok: true, queued: true, quote: display };
      } catch (queueErr) {
        logger.error('quote offline-queue failed', { error: queueErr.message });
        return { ok: false, error: queueErr.message };
      }
    }
    if (isPermissionError(err)) {
      // A persistent permission misconfig (not an outage): surface + log
      // loudly so it is fixed, never masked as transient/retry.
      logger.error('quote save: permission denied', { error: err.message, code: err.code });
    } else {
      logger.error('quote save failed', { error: err.message });
    }
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:list', async () => {
  const settings = readSettings();
  try {
    const quotes = await quoteRepo(settings).listQuotes();
    refreshCachedList(quotes);
    return { ok: true, quotes };
  } catch (err) {
    if (isBackendUnreachable(err)) {
      const cached = readQuoteCacheSafe();
      logger.warn('quotes:list backend unreachable, serving cache', { error: err.message });
      return { ok: true, quotes: (cached && cached.list) || [] };
    }
    logger.error('quotes:list failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:search', async (event, query) => {
  const settings = readSettings();
  try {
    const quotes = await quoteRepo(settings).searchQuotes(query);
    return { ok: true, quotes };
  } catch (err) {
    if (isBackendUnreachable(err)) {
      // Offline: filter the cached list locally (mirrors the backends' fields).
      const cached = readQuoteCacheSafe();
      const list = (cached && cached.list) || [];
      const q = String(query || '').trim().toLowerCase();
      const filtered = !q ? list : list.filter((row) => {
        const haystack = [row.id, row.user, row.customer && row.customer.name]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
      logger.warn('quotes:search backend unreachable, serving cache', { error: err.message });
      return { ok: true, quotes: filtered };
    }
    logger.error('quotes:search failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:get', async (event, id) => {
  const settings = readSettings();
  try {
    const res = await quoteRepo(settings).getQuote(id);
    if (!res) return { ok: true, quote: null, token: null };
    upsertCachedQuote(res.quote);
    return { ok: true, quote: res.quote, token: res.token };
  } catch (err) {
    if (isBackendUnreachable(err)) {
      const cached = readQuoteCacheSafe();
      const payload = cached && cached.payloads && cached.payloads[id];
      logger.warn('quotes:get backend unreachable, serving cache', { id, error: err.message });
      // No token offline: an edit-save then forces (the renderer can't echo a
      // token it never received) — acceptable, the next online save wins.
      return { ok: true, quote: payload || null, token: null };
    }
    logger.error('quotes:get failed', { id, error: err.message });
    return { ok: false, error: err.message };
  }
});

// Patches an existing quote's STATUS (workflow, not a content edit — no
// version bump). In cloud mode this updates the authoritative flat row.
// A legacy cloud_id in the patch is ignored gracefully (the human id is
// canonical now — B7). The separate quotes:set-status handler still mirrors
// to the cloud for the renderer's existing flow and stays idempotent.
ipcMain.handle('quotes:update', async (event, payload) => {
  const settings = readSettings();
  // Build the repo (and, in cloud mode, the D1 client) ONCE and reuse it for
  // both the status write and the cache refresh — no second client/round-trip.
  const repo = quoteRepo(settings);
  try {
    const { id, patch } = payload || {};
    const p = patch || {};
    const status = p.status;
    const statusTs = p.status_ts || new Date().toISOString();
    // setStatus now honors the uniform updated|null contract in BOTH modes:
    // it returns the overlaid quote (file: full record; cloud: re-fetched)
    // or null for an unknown id. So a real quote can be cached directly.
    const updated = await repo.setStatus(id, status, statusTs);
    if (updated) {
      logger.info('quote status updated', { id, status });
      upsertCachedQuote(updated);
    }
    return { ok: true, quote: updated };
  } catch (err) {
    if (isBackendUnreachable(err)) {
      logger.warn('quotes:update backend unreachable', { error: err.message });
      return { ok: false, offline: true, error: err.message };
    }
    logger.error('quote update failed', { error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('quotes:delete', async (event, id) => {
  const settings = readSettings();
  try {
    const removed = await quoteRepo(settings).deleteQuote(id);
    if (removed) {
      logger.info('quote deleted', { id });
      removeCachedQuote(id);
    }
    return { ok: true, removed };
  } catch (err) {
    if (isBackendUnreachable(err)) {
      logger.warn('quotes:delete backend unreachable', { error: err.message });
      return { ok: false, offline: true, error: err.message };
    }
    logger.error('quote delete failed', { error: err.message });
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

  // One-time, idempotent migration of any pre-Phase-B per-PC quotes into
  // the shared store (B5). Fire-and-forget: it owns its own try/catch and
  // must never block boot — the file path is fast, and a slow/hung cloud
  // call must not delay the window (it just retries next boot). Logged.
  void migratePerPcQuotesToSharedStore();

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
