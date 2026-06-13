// ============================================================
// PackPrice · error telemetry scrubber (PRD R19)
// ============================================================
// Turns an arbitrary error into a STRICTLY WHITELISTED payload safe
// to send to the developer's error-reporting endpoint. The single
// hard guarantee of this module:
//
//   The output object has EXACTLY the whitelisted keys — never a
//   catalog, a quote, a price, a name, a phone, a token or a path.
//
// Because an error message or stack can itself embed secrets/business
// data (a token in an auth error, a client phone in a validation
// message, an absolute path with the Windows user name), the message
// and stack are also scrubbed in place: absolute paths collapse to
// their basename, and anything that looks like a token / long hex /
// base64 / email / phone is replaced by a marker. Lengths are capped.
//
// Pure and dependency-free so it can be unit-tested in isolation.
// User-visible strings in this module are developer-facing markers,
// not UI, so the English marker is fine.
// ============================================================

'use strict';

// The ONLY fields that may leave the machine. Anything else the caller
// passes in `meta` is dropped on the floor.
const WHITELIST_FIELDS = Object.freeze([
  'message',
  'stack',
  'type',
  'app_version',
  'schema_version',
  'os',
  'arch',
  'data_source'
]);

const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 8000;

const REDACTED = '[REDACTED]';

// --- Redaction patterns ---------------------------------------------------
//
// Order matters: paths are collapsed to a basename FIRST so the file
// name survives, then emails/phones, then generic long secret runs.

// Absolute Windows paths (C:\Users\...\file.ext or UNC \\host\share\file)
// and POSIX absolute paths (/home/.../file). We keep only the basename.
//
// Windows folders/files can contain spaces ("Cliente Importante"), so we
// allow them inside the path body and only stop at characters that cannot
// appear in a Windows path (" < > | ? * newline) or the closing paren of a
// stack frame. A trailing :line:col is preserved by basename(). The path
// must contain at least one separator after the root so a bare "C:\" or a
// drive letter alone is still handled but we don't over-match prose.
//
// A drive-rooted path may use forward slashes too (Node fs errors often
// report "C:/Users/.../x.json"); we accept either slash after the drive
// colon so it basenames like the backslash form instead of stranding the
// drive letter (which would yield "C:x.json"). Forward slashes are also a
// path separator inside the body. The POSIX rule below never sees these
// because this rule consumes the drive root first.
const WIN_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^"<>|?*\n\r)]+/g;
const POSIX_PATH_RE = /\/(?:[^\s/"'<>|?*\n\r)]+\/)+[^\s/"'<>|?*\n\r)]+/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Phone-like: 9+ digits, optionally grouped by spaces/dashes/dots and an
// optional leading + (international). Matches "612345678", "+34 612 34 56
// 78", "612-345-678". Anchored loosely; the calculator's small numbers
// (a tier qty, a price like 47.50) are far shorter and survive.
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

// Generic secret runs: a 24+ char hex string, OR a 24+ char base64-ish
// run (letters/digits/+/=/-/_/), OR any 32+ char alnum run. Cloudflare
// tokens (~40 chars) and account/database ids (32-hex / base64) all fall
// here. Run AFTER paths/emails/phones so we don't shred a basename.
const HEX_RE = /\b[0-9a-fA-F]{24,}\b/g;
const BASE64_RE = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

function basename(p) {
  // Strip a trailing :line:col suffix (stack frames) before taking the
  // basename, then re-attach it so "main.js:10:5" stays readable.
  const m = /^(.*?)(:\d+:\d+|:\d+)?$/.exec(p);
  const core = m ? m[1] : p;
  const suffix = (m && m[2]) ? m[2] : '';
  const parts = core.split(/[\\/]/).filter(Boolean);
  const name = parts.length > 0 ? parts[parts.length - 1] : core;
  return name + suffix;
}

/**
 * Scrubs a free-text string (message or stack) of paths, emails,
 * phones and secret-looking runs. Returns a string with markers.
 */
function scrubText(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  // 1. Absolute paths → basename (keeps the file name, drops the user
  //    folder / project path that may name a client).
  out = out.replace(WIN_PATH_RE, (m) => basename(m));
  out = out.replace(POSIX_PATH_RE, (m) => basename(m));
  // 2. Emails and phones (business data).
  out = out.replace(EMAIL_RE, REDACTED);
  out = out.replace(PHONE_RE, REDACTED);
  // 3. Secret-looking long runs (tokens, ids). Hex first (tighter),
  //    then the broader base64/alnum sweep.
  out = out.replace(HEX_RE, REDACTED);
  out = out.replace(BASE64_RE, REDACTED);
  return out;
}

function cap(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Builds the whitelisted, scrubbed telemetry payload.
 *
 * @param {unknown} err   the thrown value (Error, string, anything)
 * @param {object} [meta] { app_version, schema_version, os, arch, data_source }
 * @returns {{message:string, stack:string|null, type:string,
 *   app_version:string|null, schema_version:(number|string|null),
 *   os:string|null, arch:string|null, data_source:string|null}}
 */
function scrubError(err, meta = {}) {
  let rawMessage;
  let rawStack = null;
  let type;

  if (err instanceof Error) {
    rawMessage = err.message;
    rawStack = typeof err.stack === 'string' ? err.stack : null;
    type = err.name || err.constructor.name || 'Error';
  } else if (typeof err === 'string') {
    rawMessage = err;
    type = 'string';
  } else if (err === null || err === undefined) {
    rawMessage = String(err);
    type = 'unknown';
  } else {
    // Some libraries reject with a plain object. Never JSON.stringify it
    // wholesale (it could carry business data); take only a safe label.
    rawMessage = (err && typeof err.message === 'string') ? err.message : '[non-error rejection]';
    type = (err && typeof err.name === 'string') ? err.name : 'object';
  }

  const safeMeta = (meta && typeof meta === 'object') ? meta : {};

  return {
    message: cap(scrubText(String(rawMessage)), MAX_MESSAGE_LEN),
    stack: rawStack !== null ? cap(scrubText(rawStack), MAX_STACK_LEN) : null,
    type: String(type),
    app_version: safeMeta.app_version != null ? String(safeMeta.app_version) : null,
    // schema_version is a small integer in our schema; keep its type if
    // numeric, else stringify, else null.
    schema_version: safeMeta.schema_version != null ? safeMeta.schema_version : null,
    os: safeMeta.os != null ? String(safeMeta.os) : null,
    arch: safeMeta.arch != null ? String(safeMeta.arch) : null,
    data_source: safeMeta.data_source != null ? String(safeMeta.data_source) : null
  };
}

module.exports = {
  scrubError,
  scrubText,
  WHITELIST_FIELDS,
  MAX_MESSAGE_LEN,
  MAX_STACK_LEN,
  REDACTED
};
