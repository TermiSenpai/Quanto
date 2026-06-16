// ============================================================
// Quanto · Persistent logger (electron-log wrapper)
// ============================================================
// Centralizes log configuration so callers do not import
// `electron-log` directly. Default sink: %APPDATA%/Quanto/logs/main.log
// with size-based rotation (5 MB / 3 archived files).
//
// Why a wrapper:
//   - One place to tweak format, level, and rotation.
//   - Tests can substitute a no-op logger by stubbing this module.
//   - Renderer code never imports electron-log; it asks main for
//     the tail of the log via IPC (`logs:read-last`).
// ============================================================

'use strict';

const log = require('electron-log/main');
const fs = require('fs');
const path = require('path');

const ONE_MB = 1024 * 1024;

let configured = false;
let resolvedLogPath = null;

/**
 * Configure electron-log once at app startup. Idempotent.
 *
 * @param {object} [options]
 * @param {string} [options.logDir]      override directory (default: app userData/logs)
 * @param {string} [options.fileName]    override filename (default: main.log)
 * @param {number} [options.maxSizeMB]   rotation threshold (default: 5)
 * @param {number} [options.maxArchives] kept archives (default: 3)
 * @returns {string} the resolved log file path
 */
function configureLogger(options = {}) {
  if (configured) return resolvedLogPath;

  const fileName = options.fileName || 'main.log';
  const maxSize = (options.maxSizeMB || 5) * ONE_MB;
  const maxArchives = options.maxArchives ?? 3;

  if (options.logDir) {
    if (!fs.existsSync(options.logDir)) {
      fs.mkdirSync(options.logDir, { recursive: true });
    }
    resolvedLogPath = path.join(options.logDir, fileName);
    log.transports.file.resolvePathFn = () => resolvedLogPath;
  } else {
    log.transports.file.fileName = fileName;
    resolvedLogPath = log.transports.file.getFile().path;
  }

  log.transports.file.maxSize = maxSize;
  log.transports.file.archiveLogFn = makeRotator(maxArchives);

  // Stable line format: ISO timestamp + level + message + structured ctx.
  log.transports.file.format = '[{iso}] [{level}] {text}';
  log.transports.console.format = '[{iso}] [{level}] {text}';
  log.transports.file.level = options.level || 'info';
  log.transports.console.level = options.consoleLevel || 'warn';

  configured = true;
  return resolvedLogPath;
}

function makeRotator(maxArchives) {
  return (oldLog) => {
    try {
      const dir = path.dirname(oldLog.path);
      const base = path.basename(oldLog.path, path.extname(oldLog.path));
      const ext = path.extname(oldLog.path);
      // Shift archives: main.2.log -> main.3.log, ..., main.log -> main.1.log
      for (let i = maxArchives - 1; i >= 1; i--) {
        const from = path.join(dir, `${base}.${i}${ext}`);
        const to   = path.join(dir, `${base}.${i + 1}${ext}`);
        if (fs.existsSync(from)) {
          if (i + 1 > maxArchives) {
            fs.unlinkSync(from);
          } else {
            fs.renameSync(from, to);
          }
        }
      }
      const archived = path.join(dir, `${base}.1${ext}`);
      fs.renameSync(oldLog.path, archived);
    } catch (err) {
      // Last-resort: leave the file as-is. Logging itself must
      // never bring the app down.
    }
  };
}

/**
 * Returns the absolute path of the active log file, or null if
 * the logger has not been configured yet.
 */
function getLogPath() {
  return resolvedLogPath;
}

/**
 * Reads the last `lineLimit` lines of the active log file.
 * Returns an empty array when the file does not exist yet.
 *
 * @param {number} [lineLimit=200]
 * @returns {string[]}
 */
function readLastLines(lineLimit = 200) {
  if (!resolvedLogPath || !fs.existsSync(resolvedLogPath)) return [];
  const content = fs.readFileSync(resolvedLogPath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-lineLimit);
}

/**
 * Logs a structured message. Extra fields are JSON-stringified
 * and appended to the message so they remain greppable in the
 * flat log file.
 */
function logWithContext(level, message, ctx) {
  const text = ctx && Object.keys(ctx).length > 0
    ? `${message} ${JSON.stringify(ctx)}`
    : message;
  log[level](text);
}

const logger = {
  info:  (msg, ctx) => logWithContext('info',  msg, ctx),
  warn:  (msg, ctx) => logWithContext('warn',  msg, ctx),
  error: (msg, ctx) => logWithContext('error', msg, ctx),
  debug: (msg, ctx) => logWithContext('debug', msg, ctx)
};

module.exports = {
  configureLogger,
  getLogPath,
  readLastLines,
  logger
};
