// ============================================================
// PackPrice · Cloud catalog writer (per-entity guarded writes)
// ============================================================
// Saves a catalog edit to the customer's D1 database entity-by-entity
// with optimistic concurrency by version (planes/v5-cloud-sync.md §4,
// §5; planes/v5-impl-plan-3-escrituras.md Task 3A). Two PCs editing
// DIFFERENT entities never collide; the SAME entity edited from both
// is reported as a conflict with the server row — never a silent
// overwrite (the R18 contract).
//
// Pure module: the D1 client is injected, no fs, no Electron. Reuses
// lib/catalog-assembler.js for the canonical row shapes (so the INSERT
// columns can never drift from db/migrations/0001_init.sql) and
// lib/diff.js for the per-entity audit diff.
//
// NON-ATOMICITY (documented, §4): Cloudflare D1's REST API is not an
// interactive transaction across statements. The write order is
// deliberate — DATA FIRST (version-guarded main row, then a full
// DELETE+INSERT of that entity's rows), AUDIT + SNAPSHOT +
// catalog_version bump LAST. Every per-id write is guarded by
// `version = ?`, so re-running an interrupted save is safe: an entity
// already written by a previous attempt fails its guard (version
// moved) and is reported as a conflict rather than double-applied. The
// snapshot/version bump only happens after the data, so a crash
// mid-flight leaves the data consistent and merely missing its bump —
// the next read still sees the older version and re-pulls cleanly.
// ============================================================

'use strict';

const { disassemble } = require('./catalog-assembler');
const { diffObjects } = require('./diff');

// Per-id entity → { table, idColumn, section, children }. `children`
// are deleted before the main row and re-inserted parents-first.
const PER_ID = {
  supplier: {
    table: 'suppliers', idColumn: 'id', section: 'suppliers',
    children: []
  },
  product: {
    table: 'products', idColumn: 'id', section: 'products',
    children: [
      { table: 'product_suppliers', fk: 'product_id' },
      { table: 'product_prices', fk: 'product_id' }
    ]
  },
  addon: {
    table: 'addons', idColumn: 'id', section: 'addons',
    children: []
  },
  pack: {
    table: 'packs', idColumn: 'id', section: 'packs',
    children: [
      { table: 'pack_options', fk: 'pack_id' },
      { table: 'pack_option_values', fk: 'pack_id' },
      { table: 'pack_components', fk: 'pack_id' },
      { table: 'bundle_prices', fk: 'pack_id' }
    ]
  }
};

// Global singletons: a single change of the whole table when any field
// differs. `cfgKeys` are the cfg sub-objects that compose the entity
// (company folds in quote_settings — they share the `company` table).
const GLOBALS = {
  parameters: { tables: ['parameters'], cfgKeys: ['parameters'] },
  tiers: { tables: ['tiers'], cfgKeys: ['tiers'] },
  company: { tables: ['company'], cfgKeys: ['company', 'quote_settings'] }
};

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Builds a parameterized multi-row INSERT for one table's rows. Returns
// null for an empty set (an entity may legitimately have no children).
// Single statement per table: a v4 catalog is small enough to stay well
// under D1's 100-bound-parameter cap for one entity's rows.
function insertStatement(table, rows) {
  if (!rows || rows.length === 0) return null;
  const columns = Object.keys(rows[0]);
  const placeholders = rows.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', ');
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
    params: rows.flatMap((row) => columns.map((col) => row[col]))
  };
}

/**
 * Per-entity diff at the granularity the writer guards: per-id entities
 * (pack/product/supplier/addon) compared as cfg sub-objects, global
 * singletons (parameters/tiers/company+quote_settings) as a single
 * change when any field differs. Pure and deterministic.
 *
 * @param {object} oldCfg - the baseline cfg (what the editor loaded)
 * @param {object} newCfg - the edited cfg
 * @returns {{ changed: {entityType:string,id:?string}[], removed: {entityType:string,id:string}[] }}
 */
function diffEntities(oldCfg, newCfg) {
  const changed = [];
  const removed = [];

  for (const [entityType, spec] of Object.entries(PER_ID)) {
    const oldColl = oldCfg[spec.section] || {};
    const newColl = newCfg[spec.section] || {};
    const ids = new Set([...Object.keys(oldColl), ...Object.keys(newColl)]);
    for (const id of ids) {
      const before = oldColl[id];
      const after = newColl[id];
      if (after === undefined) {
        removed.push({ entityType, id });
      } else if (before === undefined || !deepEqual(before, after)) {
        changed.push({ entityType, id });
      }
    }
  }

  for (const [entityType, spec] of Object.entries(GLOBALS)) {
    const differs = spec.cfgKeys.some((key) => !deepEqual(oldCfg[key], newCfg[key]));
    if (differs) changed.push({ entityType, id: null });
  }

  return { changed, removed };
}

/**
 * The parameterized statements that fully REPLACE one entity's rows in
 * D1. For a per-id entity: DELETE its child rows + the main row, then
 * INSERT the fresh disassembled rows for that id (option/value/
 * component/price children are rewritten wholesale — simplest correct
 * approach for a small catalog). For a global: replace all rows of its
 * table(s). The main-row version guard is applied by writeEntities, not
 * here — these are the replacement statements only.
 *
 * @param {string} entityType - pack|product|supplier|addon|parameters|tiers|company
 * @param {?string} id - the entity id (null for globals)
 * @param {object} cfg - the cfg the rows are disassembled from
 * @param {object} [opts]
 * @param {number} [opts.version] - version to bake into the re-inserted main row
 * @returns {{sql:string, params:any[]}[]}
 */
function buildEntityWrite(entityType, id, cfg, opts = {}) {
  const entities = disassemble(cfg);
  const stmts = [];

  if (PER_ID[entityType]) {
    const spec = PER_ID[entityType];
    // DELETE children first, then the main row (FK-safe order).
    for (const child of spec.children) {
      stmts.push({ sql: `DELETE FROM ${child.table} WHERE ${child.fk} = ?`, params: [id] });
    }
    stmts.push({ sql: `DELETE FROM ${spec.table} WHERE ${spec.idColumn} = ?`, params: [id] });

    // INSERT the main row (with the bumped version when given), then
    // children (parents before children).
    const mainRows = entities[spec.table]
      .filter((r) => r[spec.idColumn] === id)
      .map((r) => (opts.version != null ? { ...r, version: opts.version } : r));
    const mainInsert = insertStatement(spec.table, mainRows);
    if (mainInsert) stmts.push(mainInsert);
    for (const child of spec.children) {
      const rows = entities[child.table].filter((r) => r[child.fk] === id);
      const ins = insertStatement(child.table, rows);
      if (ins) stmts.push(ins);
    }
    return stmts;
  }

  const global = GLOBALS[entityType];
  if (!global) throw new Error('Tipo de entidad desconocido: ' + entityType);
  for (const table of global.tables) {
    stmts.push({ sql: `DELETE FROM ${table}`, params: [] });
    const ins = insertStatement(table, entities[table]);
    if (ins) stmts.push(ins);
  }
  return stmts;
}

// Pulls one entity's slice out of a cfg for the audit diff (per-id =
// the sub-object; globals = the composing cfg keys, e.g. company +
// quote_settings).
function entitySlice(cfg, entityType, id) {
  if (PER_ID[entityType]) {
    const coll = cfg[PER_ID[entityType].section] || {};
    return coll[id];
  }
  const global = GLOBALS[entityType];
  const slice = {};
  for (const key of global.cfgKeys) slice[key] = cfg[key];
  return slice;
}

function auditStatement({ now, user, entityType, id, action, oldCfg, newCfg, catalogVersion }) {
  const before = entitySlice(oldCfg, entityType, id);
  const after = action === 'delete' ? undefined : entitySlice(newCfg, entityType, id);
  const diff = diffObjects(before, after);
  return {
    sql: 'INSERT INTO audit_log (ts, user, entity_type, entity_id, action, diff_json, catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [now, user, entityType, id, action, JSON.stringify(diff), catalogVersion]
  };
}

// Assembles the full cfg JSON for the snapshot. The new cfg is already
// the canonical object; we strip `admin` and stamp the new
// version/author so the snapshot mirrors a fresh cloud load.
function snapshotJson(cfg, catalogVersion, ts, user) {
  const { admin, ...rest } = cfg;
  return JSON.stringify({ ...rest, updated_at: ts, modified_by: user, catalog_version: catalogVersion });
}

/**
 * Writes a catalog edit entity-by-entity with optimistic concurrency.
 *
 * For each changed per-id entity it runs a version-guarded UPDATE of the
 * main row; on `meta.changes === 0` (someone else bumped it) the entity
 * is a conflict — its current server row is read back and its rows are
 * NOT written, but the other entities proceed (partial success).
 * Globals guard on the catalog_version. Removals archive (soft delete).
 * After all entities, if anything was written: bump catalog_version,
 * stamp catalog_meta (updated_by), and insert ONE snapshot of the full
 * assembled new cfg at the new version.
 *
 * @param {object} client - D1 client (lib/d1-client.js); query → { results, meta:{changes} }
 * @param {object} args
 * @param {object} args.oldCfg - baseline cfg the editor loaded
 * @param {object} args.newCfg - edited cfg to persist
 * @param {string} args.user - author, stamped into audit + catalog_meta
 * @param {() => string} args.now - ISO-8601 timestamp source
 * @param {object} args.expectedVersions - { catalogVersion, pack:{id:v}, product:{…}, supplier:{…}, addon:{…} }
 * @param {number} [args.serverCatalogVersion] - the live catalog_version (for the globals guard); defaults to expectedVersions.catalogVersion
 * @returns {Promise<{ok:boolean, catalogVersion:number, results:object[], conflicts:object[]}>}
 */
async function writeEntities(client, { oldCfg, newCfg, user, now, expectedVersions, serverCatalogVersion }) {
  const ts = now();
  const baseVersion = expectedVersions.catalogVersion;
  const newVersion = baseVersion + 1;
  const liveCatalogVersion = serverCatalogVersion === undefined ? baseVersion : serverCatalogVersion;

  const { changed, removed } = diffEntities(oldCfg, newCfg);
  const results = [];
  const conflicts = [];
  let wroteSomething = false;

  async function runStatements(stmts) {
    for (const stmt of stmts) await client.query(stmt.sql, stmt.params);
  }

  async function audit(entityType, id, action) {
    const stmt = auditStatement({ now: ts, user, entityType, id, action, oldCfg, newCfg, catalogVersion: newVersion });
    await client.query(stmt.sql, stmt.params);
  }

  // --- DATA FIRST: per-entity version-guarded writes ---
  for (const { entityType, id } of changed) {
    if (PER_ID[entityType]) {
      const spec = PER_ID[entityType];
      const expected = (expectedVersions[entityType] || {})[id];

      // A brand-new entity (no baseline version) is inserted, not
      // guarded — there is no prior row to race against.
      if (expected === undefined) {
        await runStatements(buildEntityWrite(entityType, id, newCfg, { version: 1 }));
        await audit(entityType, id, 'create');
        results.push({ entityType, id, status: 'written' });
        wroteSomething = true;
        continue;
      }

      // Version guard: claim the row and bump it. changes===0 means
      // another PC moved it on → conflict.
      const guard = await client.query(
        `UPDATE ${spec.table} SET version = version + 1, updated_at = ? WHERE ${spec.idColumn} = ? AND version = ?`,
        [ts, id, expected]
      );
      if (!guard.meta || guard.meta.changes === 0) {
        const current = await client.query(`SELECT * FROM ${spec.table} WHERE ${spec.idColumn} = ?`, [id]);
        const serverRow = (current.results || [])[0] || null;
        conflicts.push({ entityType, id, serverRow });
        results.push({ entityType, id, status: 'conflict' });
        continue;
      }

      // Guard held: fully replace the entity's rows (the re-inserted
      // main row carries the version we just bumped to, so a follow-up
      // save still guards correctly).
      await runStatements(buildEntityWrite(entityType, id, newCfg, { version: expected + 1 }));
      await audit(entityType, id, 'update');
      results.push({ entityType, id, status: 'written' });
      wroteSomething = true;
    } else {
      // Global: guard on the catalog_version.
      if (liveCatalogVersion !== baseVersion) {
        conflicts.push({ entityType, id: null, serverCatalogVersion: liveCatalogVersion });
        results.push({ entityType, id: null, status: 'conflict' });
        continue;
      }
      await runStatements(buildEntityWrite(entityType, null, newCfg));
      await audit(entityType, null, 'update');
      results.push({ entityType, id: null, status: 'written' });
      wroteSomething = true;
    }
  }

  // --- Removals: soft-delete (archive) + audit ---
  for (const { entityType, id } of removed) {
    const spec = PER_ID[entityType];
    await client.query(`UPDATE ${spec.table} SET archived_at = ? WHERE ${spec.idColumn} = ?`, [ts, id]);
    await audit(entityType, id, 'delete');
    results.push({ entityType, id, status: 'deleted' });
    wroteSomething = true;
  }

  // --- AUDIT/SNAPSHOT/VERSION LAST (only if anything was written) ---
  if (wroteSomething) {
    await client.query(
      'UPDATE catalog_meta SET catalog_version = ?, updated_by = ?, updated_at = ? WHERE id = 1',
      [newVersion, user, ts]
    );
    await client.query(
      'INSERT INTO snapshots (catalog_version, json, ts) VALUES (?, ?, ?)',
      [newVersion, snapshotJson(newCfg, newVersion, ts, user), ts]
    );
  }

  return {
    ok: conflicts.length === 0,
    catalogVersion: wroteSomething ? newVersion : baseVersion,
    results,
    conflicts
  };
}

module.exports = { diffEntities, buildEntityWrite, writeEntities };
