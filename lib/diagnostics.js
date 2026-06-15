// ============================================================
// PackPrice · diagnostics bundle for blind support (PRD R17)
// ============================================================
// buildDiagnostics() assembles a single JSON object a user can hand to
// the developer when something breaks, WITHOUT a remote session. It
// trades two concerns off:
//   - Useful: recent log lines, the app/schema/electron/OS versions,
//     the storage mode, and the PRESENCE (counts) of the catalog cache
//     and offline outbox.
//   - Safe: it must never carry the Cloudflare token, a catalog, a
//     quote or any business datum. Settings go through
//     lib/settings-privacy.js redactSettings (token → has_token), and
//     the cache/outbox are reduced to counts, never their contents.
//
// Reads the filesystem (the log file, settings.json, the cache dir) but
// stays otherwise pure: it takes the userData dir + versions as inputs
// so it can be unit-tested against a temp dir.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { redactSettings } = require('./settings-privacy');
const { scrubText, REDACTED } = require('./error-scrubber');

const DEFAULT_LOG_LINES = 200;

// Operator-name keys our own logging emits (audit lines, save events). The
// scrubber collapses paths/tokens/emails/phones but cannot know an
// arbitrary "value" is a person's name, so we redact these keys by name.
// Both JSON ("key":"value") and bare (key: value) log forms are matched.
const PII_LOG_KEYS = ['user', 'usuario', 'modified_by', 'modificadoPor', 'modificado_por'];

// "key":"value"  →  "key":"[REDACTED]"   (JSON-embedded audit payloads)
const PII_JSON_RE = new RegExp(`("(?:${PII_LOG_KEYS.join('|')})"\\s*:\\s*)"[^"]*"`, 'g');
// key: value     →  key: [REDACTED]      (free-text log lines; stops at a
// comma/brace/quote/whitespace-run so we redact only the name token).
const PII_BARE_RE = new RegExp(`\\b(${PII_LOG_KEYS.join('|')})(\\s*[:=]\\s*)[^\\s,}"']+`, 'g');

/**
 * Scrubs a single log line of every PII vector before it can leave the
 * machine in a diagnostics bundle: paths/tokens/emails/phones via the
 * shared scrubText, then operator-name values for known PII keys.
 */
function scrubLogLine(line) {
  let out = scrubText(line);
  out = out.replace(PII_JSON_RE, `$1"${REDACTED}"`);
  out = out.replace(PII_BARE_RE, `$1$2${REDACTED}`);
  return out;
}

/**
 * Reads the last N lines of the electron-log main.log under
 * <userDataDir>/logs/. Returns [] when the file is missing or
 * unreadable (a diagnostics build must never fail because of logs).
 * Every returned line is scrubbed of PII (paths, tokens, operator
 * names) — the bundle promises "no business datum".
 */
function readRecentLogLines(userDataDir, lineLimit) {
  const logPath = path.join(userDataDir, 'logs', 'main.log');
  try {
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-lineLimit).map(scrubLogLine);
  } catch (_) {
    return [];
  }
}

/**
 * Reads + parses the local settings.json, tolerating a missing or
 * corrupt file (returns null). Never throws.
 */
function readRawSettings(userDataDir) {
  const settingsPath = path.join(userDataDir, 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) return null;
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

/**
 * Summarizes the catalog cache + offline outbox by PRESENCE and COUNTS
 * only — never their contents (which would carry the catalog and
 * quotes). A corrupt outbox is tolerated: present:true, counts 0.
 */
function summarizeStorage(userDataDir) {
  const cachePath = path.join(userDataDir, 'cache', 'catalog.json');
  const outboxPath = path.join(userDataDir, 'cache', 'outbox.json');

  const catalogCachePresent = safeExists(cachePath);
  const outboxPresent = safeExists(outboxPath);

  let outboxQuotes = 0;
  let outboxStatuses = 0;
  if (outboxPresent) {
    try {
      const outbox = JSON.parse(fs.readFileSync(outboxPath, 'utf-8'));
      outboxQuotes = Array.isArray(outbox.quotes) ? outbox.quotes.length : 0;
      outboxStatuses = Array.isArray(outbox.statuses) ? outbox.statuses.length : 0;
    } catch (_) {
      // Corrupt outbox: keep presence, zero the counts. We never surface
      // the raw content, so a parse failure is harmless here.
    }
  }

  return {
    catalog_cache_present: catalogCachePresent,
    outbox_present: outboxPresent,
    outbox_quotes: outboxQuotes,
    outbox_statuses: outboxStatuses
  };
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

/**
 * Builds the diagnostics object.
 *
 * @param {object} args
 * @param {string} args.userDataDir   the %APPDATA%/packprice directory
 * @param {string} args.appVersion
 * @param {number|string} args.schemaVersion
 * @param {string} args.dataSource    'file' | 'cloud'
 * @param {number} [args.logLines=200]
 * @returns {object} a JSON-serializable bundle with NO token / business data
 */
function buildDiagnostics(args = {}) {
  const {
    userDataDir,
    appVersion = null,
    schemaVersion = null,
    dataSource = null,
    logLines = DEFAULT_LOG_LINES
  } = args;

  const rawSettings = userDataDir ? readRawSettings(userDataDir) : null;

  return {
    generated_at: new Date().toISOString(),
    data_source: dataSource,
    versions: {
      app: appVersion,
      schema: schemaVersion,
      // process.versions is always defined in main; in a plain Node test
      // electron is undefined — keep the key present for a stable shape.
      electron: (process.versions && process.versions.electron) || null,
      node: (process.versions && process.versions.node) || null,
      os: `${process.platform} ${process.arch} ${(require('os').release && require('os').release()) || ''}`.trim()
    },
    // The redacted view drops the token and exposes only has_token.
    settings: redactSettings(rawSettings),
    storage: userDataDir ? summarizeStorage(userDataDir) : {
      catalog_cache_present: false, outbox_present: false, outbox_quotes: 0, outbox_statuses: 0
    },
    recent_log_lines: userDataDir ? readRecentLogLines(userDataDir, logLines) : []
  };
}

module.exports = {
  buildDiagnostics,
  readRecentLogLines,
  summarizeStorage
};
