// ============================================================
// PackPrice · Save-summary (pure, renderer)
// ============================================================
// Turns an old/new catalog pair into a change summary GROUPED by
// catalog entity, for the cloud "confirm save" modal (UI-UX §2.5) and,
// per entity, the conflict modal (§2.3). Each group is
//   { entityType, id, kind, name, fieldChanges }
// where `kind` is 'add' | 'remove' | 'edit', `name` is the entity's
// display name (name → label → id), and `fieldChanges` is the array of
// structured { path, before, after, kind } entries (empty for whole
// add/remove). The humanizer (renderer/change-format.js) turns these
// into friendly Spanish text — this module no longer pre-formats lines.
//
// Grouping mirrors lib/catalog-writer.js `diffEntities` (the cloud
// writer's seam): the per-id entities pack / product / supplier / addon
// are grouped by id; the global singletons parameters / tiers / company
// collapse to one group each (id: null).
//
// WHY the diff lives here and not via `import` of lib/diff.js: the
// renderer is loaded as a native ES module in Chromium with NO build
// step (CLAUDE.md §2), while lib/diff.js is CommonJS (`module.exports`,
// required by main.js under Electron's Node 20, which cannot `require`
// ESM). Chromium cannot `import` a CommonJS file, and lib/diff.js
// cannot gain `export` without breaking main — so a thin, self-contained
// re-statement of the two pure diff primitives is the zero-build,
// zero-dep bridge. It is byte-for-byte equivalent to lib/diff.js's
// `diffObjects` + `formatChangeLine` and covered by tests/save-summary.test.js.
// ============================================================

'use strict';

// Mirror of lib/diff.js DEFAULT_IGNORE_PATHS: metadata that is stamped
// on every save and must never show up as a "change" in the summary.
const IGNORE_PATHS = new Set([
  'updated_at',
  'modified_by',
  'admin.password',
  'admin.has_password'
]);

// Per-id entity types and the cfg collection that holds them. Order is
// stable so the summary is deterministic.
const PER_ID = [
  ['pack', 'packs'],
  ['product', 'products'],
  ['supplier', 'suppliers'],
  ['addon', 'addons']
];

// Global singletons: any field change emits a single group of this type.
const GLOBALS = ['parameters', 'tiers', 'company'];

/**
 * Builds the grouped change summary between two configs.
 *
 * @param {object} oldCfg - the baseline catalog (e.g. the editor backup)
 * @param {object} newCfg - the edited catalog
 * @returns {{ entityType: string, id: string|null, kind: string, name: string|null, fieldChanges: object[] }[]}
 *   One group per changed/added/removed entity (per-id) or changed
 *   global, in a stable order; empty when nothing changed.
 */
export function buildSaveSummary(oldCfg, newCfg) {
  const old = oldCfg || {};
  const next = newCfg || {};
  const out = [];

  for (const [entityType, section] of PER_ID) {
    const oldColl = old[section] || {};
    const newColl = next[section] || {};
    const ids = new Set([...Object.keys(oldColl), ...Object.keys(newColl)]);
    for (const id of ids) {
      const before = oldColl[id];
      const after = newColl[id];
      const changes = diffObjects(before, after);
      if (changes.length === 0) continue;
      const added = before === undefined && after !== undefined;
      const removed = before !== undefined && after === undefined;
      const kind = added ? 'add' : removed ? 'remove' : 'edit';
      const nameObj = (kind === 'remove') ? before : after;
      const name = (nameObj && (nameObj.name || nameObj.label)) || id;
      const fieldChanges = kind === 'edit' ? changes : [];
      out.push({ entityType, id, kind, name, fieldChanges });
    }
  }

  for (const entityType of GLOBALS) {
    const changes = diffObjects(old[entityType], next[entityType]);
    if (changes.length === 0) continue;
    out.push({ entityType, id: null, kind: 'edit', name: null, fieldChanges: changes });
  }

  return out;
}

/**
 * Total change count for the "Guardar N cambios" button: each edited
 * field counts once; a whole-entity add/remove counts as one.
 *
 * @param {{ kind: string, fieldChanges: object[] }[]} summary
 * @returns {number}
 */
export function totalChanges(summary) {
  return (summary || []).reduce((n, g) => {
    if (g.kind === 'edit') return n + (g.fieldChanges ? g.fieldChanges.length : 0);
    return n + 1; // add / remove
  }, 0);
}

// ------------------------------------------------------------
// Pure diff primitives (equivalent to lib/diff.js — see header note).
// ------------------------------------------------------------

/**
 * Flat diff between two plain JS values → array of
 * { path, before, after, kind }. Empty when equal.
 */
function diffObjects(before, after) {
  const out = [];
  walk(before, after, '', out);
  return out;
}

function walk(before, after, currentPath, out) {
  if (currentPath && IGNORE_PATHS.has(currentPath)) return;

  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      walk(before[key], after[key], childPath, out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      walk(before[i], after[i], `${currentPath}[${i}]`, out);
    }
    return;
  }

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
 * Renders one diff entry as a human Spanish line (matches lib/diff.js
 * `formatChangeLine`, and the audit modal's "+ / − / ~" convention).
 */
function formatChangeLine(change) {
  const { path, before, after, kind } = change;
  if (kind === 'add') return `+ ${path}: ${stringify(after)}`;
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
