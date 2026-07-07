// ============================================================
// Quanto · Config file store + lazy migration
// ============================================================
// Wraps the filesystem side of reading/writing the shared
// config.js (NAS) and the per-PC settings.json. The interesting
// part is the LAZY MIGRATION: the first time any PC opens an old
// (v2) file, it is migrated to v3, backed up, and rewritten in
// place. Subsequent reads see v3 and do nothing (idempotent).
//
// Kept out of main.js so it can be unit-tested against a temp
// directory without Electron (see tests/config-store.test.js).
// Follows CLAUDE.md §6.3 (migrations) and the migration plan §6.1:
//   backup before write · atomic write · idempotent · logged.
//
// User-facing throw messages stay in Spanish (CLAUDE.md §4.5).
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { extractJsonFromConfig, serializeConfig } = require('./config-parser');
const { migrateConfig, migrateSettings } = require('./migrations');

const MIGRATION_BACKUP_TAG = 'pre-v3-migration';

/**
 * Reads and parses config.js without executing it as JavaScript.
 * @throws {Error} if the file is missing or not valid.
 */
function readConfigFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`No existe el archivo: ${filePath}`);
  }
  return extractJsonFromConfig(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Returns mtime + size + sha256 of the file, used to detect
 * external changes (conflict detection). null if absent.
 */
function getFileInfo(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { mtimeMs: stat.mtimeMs, size: stat.size, hash };
}

/**
 * Copies the config to a sibling `backups/` folder with a
 * timestamped name. Non-blocking: on failure it calls
 * `opts.onError` (if given) and returns null instead of throwing,
 * so a backup hiccup never blocks a legitimate write.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string} [opts.tag]      suffix to distinguish backups (e.g. 'pre-v3-migration')
 * @param {(err:Error)=>void} [opts.onError]
 * @returns {string|null} the backup path, or null
 */
function createBackup(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.dirname(filePath);
  const backupsDir = path.join(dir, 'backups');
  try {
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suffix = opts.tag ? `-${opts.tag}` : '';
    const backupPath = path.join(backupsDir, `config-${ts}${suffix}.js`);
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch (err) {
    if (typeof opts.onError === 'function') opts.onError(err);
    return null;
  }
}

/**
 * Serializes and writes the config atomically: writes a sibling
 * `.tmp` and renames over the target. If the write is interrupted,
 * the original file stays intact (the rename is the commit point).
 */
function writeConfigAtomic(filePath, config) {
  const content = serializeConfig(config);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Lazy migration on read. Reads the config, migrates it to v3, and
 * — only if it actually changed (i.e. it was v2) — backs up the
 * original with the `pre-v3-migration` tag and rewrites it as v3
 * atomically. Idempotent: a v3 file is returned untouched and the
 * file is not rewritten.
 *
 * @param {string} filePath
 * @param {object} [hooks]
 * @param {(info:object)=>void} [hooks.onMigrate]      called once when a real migration happens
 * @param {(err:Error)=>void}   [hooks.onBackupError]  called if the pre-migration backup fails
 * @returns {{ config: object, didMigrate: boolean, backupPath: ?string }}
 */
function readAndMigrateConfig(filePath, hooks = {}) {
  const raw = readConfigFromFile(filePath);
  const migrated = migrateConfig(raw);
  const didMigrate = migrated !== raw; // migrateConfig returns the same ref for v3

  let backupPath = null;
  if (didMigrate) {
    backupPath = createBackup(filePath, {
      tag: MIGRATION_BACKUP_TAG,
      onError: hooks.onBackupError
    });
    writeConfigAtomic(filePath, migrated);
    if (typeof hooks.onMigrate === 'function') {
      hooks.onMigrate({
        filePath,
        backupPath,
        fromVersion: raw && raw.version,
        toVersion: migrated.version
      });
    }
  }
  return { config: migrated, didMigrate, backupPath };
}

/**
 * Lazy migration of the per-PC settings.json. Returns null when the
 * file is absent (first boot) or corrupt. Migrates v2 keys
 * (ruta_config, nombre_usuario) to v3 (config_path, user_name),
 * backing up to `<file>.bak-pre-v3` before rewriting. Idempotent.
 *
 * @param {string} settingsPath
 * @param {object} [hooks]
 * @param {(err:Error)=>void}   [hooks.onCorrupt]
 * @param {(info:object)=>void} [hooks.onMigrate]
 * @param {(err:Error)=>void}   [hooks.onBackupError]
 * @returns {object|null} the (possibly migrated) settings, or null
 */
function readAndMigrateSettings(settingsPath, hooks = {}) {
  if (!fs.existsSync(settingsPath)) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch (err) {
    if (typeof hooks.onCorrupt === 'function') hooks.onCorrupt(err);
    return null;
  }

  const needsMigration = raw && typeof raw === 'object'
    && (('ruta_config' in raw) || ('nombre_usuario' in raw));
  if (!needsMigration) return raw;

  const migrated = migrateSettings(raw);
  try {
    fs.copyFileSync(settingsPath, settingsPath + '.bak-pre-v3');
  } catch (err) {
    if (typeof hooks.onBackupError === 'function') hooks.onBackupError(err);
  }
  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(migrated, null, 2), 'utf-8');
  fs.renameSync(tmpPath, settingsPath);
  if (typeof hooks.onMigrate === 'function') hooks.onMigrate({ settingsPath });
  return migrated;
}

module.exports = {
  MIGRATION_BACKUP_TAG,
  readConfigFromFile,
  getFileInfo,
  createBackup,
  writeConfigAtomic,
  readAndMigrateConfig,
  readAndMigrateSettings
};
