// ============================================================
// PackPrice · Plain object diff
// ============================================================
// Used for two purposes:
//   1. Audit log: persist exactly which fields changed in a config:write.
//   2. Admin "review changes" modal: show the human a list of
//      `path: from -> to` lines before they confirm.
//
// Design choices:
//   - Output format is a flat array of { path, before, after, kind }.
//     Flat is enough for our nested-but-shallow config. JSON Patch
//     would be overkill.
//   - `path` is dot-notation with bracketed indices for arrays,
//     e.g. "tramos[0].hasta" or "packs.pena_completa.pvp.t1".
//   - `kind` is one of "add" | "remove" | "change". Helpful for the
//     UI to colour rows differently.
//   - Pure: no Electron, no I/O, deterministic. Trivially testable.
//   - Ignores keys listed in `ignorePaths` (set of dot paths to
//     skip whole subtrees, e.g. "fecha_actualizacion").
// ============================================================

'use strict';

const DEFAULT_IGNORE_PATHS = new Set([
  'fecha_actualizacion',
  'modificado_por',
  'admin.clave',
  'admin.tiene_clave'
]);

/**
 * Computes a flat diff between two plain JS values. Returns an
 * array of { path, before, after, kind }. Empty when equal.
 *
 * @param {*} before
 * @param {*} after
 * @param {object} [options]
 * @param {Set<string>} [options.ignorePaths] dot-paths to skip
 * @returns {{path:string, before:*, after:*, kind:'add'|'remove'|'change'}[]}
 */
function diffObjects(before, after, options = {}) {
  const ignore = options.ignorePaths || DEFAULT_IGNORE_PATHS;
  const out = [];
  walk(before, after, '', ignore, out);
  return out;
}

function walk(before, after, currentPath, ignore, out) {
  if (currentPath && ignore.has(currentPath)) return;

  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      walk(before[key], after[key], childPath, ignore, out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      const childPath = `${currentPath}[${i}]`;
      walk(before[i], after[i], childPath, ignore, out);
    }
    return;
  }

  // Scalar / type mismatch / array<->object: leaf comparison.
  if (deepEqual(before, after)) return;

  if (before === undefined) {
    out.push({ path: currentPath, before: undefined, after, kind: 'add' });
  } else if (after === undefined) {
    out.push({ path: currentPath, before, after: undefined, kind: 'remove' });
  } else {
    out.push({ path: currentPath, before, after, kind: 'change' });
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/**
 * Renders a single diff entry as a single line of human-readable text.
 * Spanish on purpose: this string is shown to the admin in modals and
 * also written to the audit log alongside the structured entry.
 *
 * @param {{path:string, before:*, after:*, kind:string}} change
 * @returns {string}
 */
function formatChangeLine(change) {
  const { path, before, after, kind } = change;
  if (kind === 'add')    return `+ ${path}: ${stringify(after)}`;
  if (kind === 'remove') return `- ${path}: ${stringify(before)}`;
  return `~ ${path}: ${stringify(before)} → ${stringify(after)}`;
}

function stringify(value) {
  if (value === undefined) return '∅';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

module.exports = {
  diffObjects,
  formatChangeLine,
  DEFAULT_IGNORE_PATHS
};
