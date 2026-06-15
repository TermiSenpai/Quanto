// ============================================================
// PackPrice · Cloud history read + forward-only restore
// ============================================================
// Reads the change history (audit_log) and the version list
// (snapshots) the catalog writer already persists (lib/catalog-
// writer.js writeEntities), and restores any prior version
// (planes/v5-impl-plan-4-auditoria-rollback.md Task 4A;
// planes/v5-cloud-sync.md §3 tables, §4 audited restore).
//
// Pure module: the D1 client is injected, no fs, no Electron. Reuses
// lib/cloud-catalog.js (loadEntities), lib/catalog-assembler.js
// (assemble) and lib/catalog-writer.js (writeEntities) so the restore
// goes through the exact same guarded, audited write path as a normal
// edit — there is no second way to mutate the catalog.
//
// User-facing throw messages stay in Spanish (CLAUDE.md §6).
// ============================================================

'use strict';

const { loadEntities } = require('./cloud-catalog');
const { assemble } = require('./catalog-assembler');
const { writeEntities } = require('./catalog-writer');

// Per-id entity type → its catalog table, for deriving the live
// per-entity version map restore feeds back as expectedVersions. Same
// mapping lib/cloud-bootstrap.js uses; kept local so this module stays
// self-contained (no cross-import of a private helper).
const VERSIONED_ENTITIES = {
  pack: 'packs',
  product: 'products',
  supplier: 'suppliers',
  addon: 'addons'
};

// The cfg `version` (v4 schema tag) stamped onto the assembled current
// catalog. It is metadata only — writeEntities diffs the entity slices,
// not this field — so any non-empty value is fine for the baseline.
const CONFIG_VERSION_PLACEHOLDER = 'restore-baseline';

/**
 * Reads the audit log newest-first, mapping the stored row columns to a
 * renderer-friendly shape and parsing each `diff_json` into an array.
 *
 * A single malformed `diff_json` must never sink the whole read: the
 * audit log is the user's safety record, so a corrupt cell falls back to
 * its raw string rather than throwing (the rest of the page still loads).
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @returns {Promise<Array<{id:number, ts:string, user:string, entityType:string, entityId:?string, action:string, diff:(Array|string), catalogVersion:number}>>}
 */
async function readAuditLog(client, { limit = 50, offset = 0 } = {}) {
  const res = await client.query(
    'SELECT id, ts, user, entity_type, entity_id, action, diff_json, catalog_version ' +
    'FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
  return (res.results || []).map((row) => ({
    id: row.id,
    ts: row.ts,
    user: row.user,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    diff: parseDiffTolerant(row.diff_json),
    catalogVersion: row.catalog_version
  }));
}

// Tolerant parse: a bad diff cell keeps its raw string so the row still
// renders (and the corruption is visible) instead of throwing the read.
function parseDiffTolerant(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Lists the available snapshots (version + timestamp) newest-first.
 *
 * @param {object} client - D1 client
 * @returns {Promise<Array<{catalogVersion:number, ts:string}>>}
 */
async function listSnapshots(client) {
  const res = await client.query(
    'SELECT catalog_version, ts FROM snapshots ORDER BY catalog_version DESC'
  );
  return (res.results || []).map((row) => ({
    catalogVersion: row.catalog_version,
    ts: row.ts
  }));
}

/**
 * Reads one snapshot and parses its stored full-catalog JSON into a cfg.
 *
 * @param {object} client - D1 client
 * @param {number} version - the catalog_version of the wanted snapshot
 * @returns {Promise<{catalogVersion:number, ts:string, cfg:object}>}
 * @throws {Error} Spanish message when the version does not exist or its
 *   stored JSON is corrupt (never silently swallowed)
 */
async function getSnapshot(client, version) {
  const res = await client.query(
    'SELECT catalog_version, ts, json FROM snapshots WHERE catalog_version = ?',
    [version]
  );
  const row = (res.results || [])[0];
  if (!row) throw new Error('No existe ninguna versión ' + version + ' para restaurar');
  let cfg;
  try {
    cfg = JSON.parse(row.json);
  } catch (err) {
    throw new Error('El snapshot de la versión ' + version + ' está dañado (JSON inválido)', { cause: err });
  }
  return { catalogVersion: row.catalog_version, ts: row.ts, cfg };
}

// Derives the per-entity optimistic-concurrency version map from freshly
// loaded rows (each versioned table carries a `version` column). Restore
// feeds THIS live map back as expectedVersions, so every guard matches
// the current row and the write always wins — a restore must never
// conflict against the very state it is overwriting.
function deriveLiveVersions(entities, catalogVersion) {
  const versions = { catalogVersion, pack: {}, product: {}, supplier: {}, addon: {} };
  for (const [type, table] of Object.entries(VERSIONED_ENTITIES)) {
    for (const row of entities[table] || []) versions[type][row.id] = row.version;
  }
  return versions;
}

/**
 * Restores the catalog to a prior snapshot's content.
 *
 * Forward-only: restore never rewrites history. It loads the CURRENT
 * live catalog as the diff baseline and writes the target snapshot's cfg
 * through writeEntities, which creates a NEW catalog_version whose content
 * equals the old one — re-adding entities the snapshot has, archiving
 * those absent from it — and audits + snapshots the restore itself. So
 * restoring v3 produces (say) v8 whose content matches v3; v3 still
 * stands in the timeline.
 *
 * expectedVersions is the CURRENT live version map (derived from the rows
 * we just loaded), so the per-entity guards always hold: a deliberate
 * overwrite to a known prior state must win, never report a false
 * conflict against itself.
 *
 * @param {object} client - D1 client
 * @param {object} args
 * @param {number} args.version - the snapshot version to restore
 * @param {string} args.user - author, stamped into audit + catalog_meta
 * @param {() => string} args.now - ISO-8601 timestamp source
 * @returns {Promise<{ok:boolean, catalogVersion:number}>}
 */
async function restoreSnapshot(client, { version, user, now }) {
  // Target state: the cfg captured in the snapshot we are rolling back to.
  const { cfg: snapshotCfg } = await getSnapshot(client, version);

  // Baseline: the CURRENT live catalog (so writeEntities diffs against
  // reality) plus the live per-entity versions for the guards.
  const { entities, meta } = await loadEntities(client);
  const currentCfg = assemble(entities, {
    version: CONFIG_VERSION_PLACEHOLDER, updated_at: now(), modified_by: user
  });
  const expectedVersions = deriveLiveVersions(entities, meta.catalogVersion);

  const res = await writeEntities(client, {
    oldCfg: currentCfg, newCfg: snapshotCfg, user, now, expectedVersions
  });

  return { ok: res.ok, catalogVersion: res.catalogVersion };
}

module.exports = { readAuditLog, listSnapshots, getSnapshot, restoreSnapshot };
