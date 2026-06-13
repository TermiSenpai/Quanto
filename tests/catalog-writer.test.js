// ============================================================
// Tests · lib/catalog-writer.js (entity diff + guarded writes)
// ============================================================
// Per-entity optimistic-concurrency writes against D1, exercised
// with a fake client mirroring lib/d1-client.js (query returns
// { results, meta:{changes} }). Covers: diffEntities granularity,
// buildEntityWrite column shapes (pinned against the assembler),
// and writeEntities (version bump + audit + snapshot, stale →
// conflict with the server row, other entities still written,
// removal archives, globals path).
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  diffEntities,
  buildEntityWrite,
  writeEntities
} from '../lib/catalog-writer.js';
import { disassemble } from '../lib/catalog-assembler.js';
import { buildDefaultConfig } from '../config.default.js';

const NOW = () => '2026-06-13T10:00:00.000Z';

function baseCfg() {
  const cfg = buildDefaultConfig();
  delete cfg.admin;
  return cfg;
}

// Versions every per-id entity at 1 and the catalog at 7, matching
// a freshly loaded baseline.
function baselineVersions(cfg) {
  const v = { catalogVersion: 7, pack: {}, product: {}, supplier: {}, addon: {} };
  for (const id of Object.keys(cfg.packs)) v.pack[id] = 1;
  for (const id of Object.keys(cfg.products)) v.product[id] = 1;
  for (const id of Object.keys(cfg.suppliers)) v.supplier[id] = 1;
  for (const id of Object.keys(cfg.addons)) v.addon[id] = 1;
  return v;
}

// Fake D1 client mirroring lib/d1-client.js: query returns
// { results, meta:{changes} }. The guarded UPDATE reports changes=1
// unless the id is configured stale (then changes=0). SELECTs for the
// current server row return whatever `serverRows` holds.
function fakeClient({ staleIds = new Set(), serverRows = {} } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // Guarded UPDATE of a per-id main row.
      const guard = sql.match(/^UPDATE (\w+) SET version = version \+ 1/);
      if (guard) {
        const id = params[params.length - 2]; // ... WHERE id = ? AND version = ?
        const changes = staleIds.has(id) ? 0 : 1;
        return { results: [], meta: { changes } };
      }
      // Read the current server row of a conflicted entity.
      if (/^SELECT \* FROM (\w+) WHERE id = \?/.test(sql)) {
        const table = sql.match(/FROM (\w+)/)[1];
        const id = params[0];
        const row = (serverRows[table] || {})[id] || null;
        return { results: row ? [row] : [], meta: {} };
      }
      // Everything else (DELETE/INSERT children, audit, snapshot,
      // catalog_meta bump, global guard).
      return { results: [], meta: { changes: 1 } };
    }
  };
}

// Rebuilds the rows an INSERT statement carried, so a test can pin the
// emitted column shape against the assembler output.
function parseInsert(sql, params) {
  const m = sql.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES (.+)$/);
  if (!m) return null;
  const table = m[1];
  const cols = m[2].split(', ');
  const rows = [];
  for (let i = 0; i < params.length; i += cols.length) {
    const row = {};
    cols.forEach((col, j) => { row[col] = params[i + j]; });
    rows.push(row);
  }
  return { table, cols, rows };
}

// ------------------------------------------------------------
// diffEntities
// ------------------------------------------------------------
describe('diffEntities', () => {
  test('no change → empty changed and removed', () => {
    const cfg = baseCfg();
    expect(diffEntities(cfg, baseCfg())).toEqual({ changed: [], removed: [] });
  });

  test('changing one pack reports only that pack', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.packs.crew_full.name = 'Pack Peña editado';
    expect(diffEntities(oldCfg, newCfg)).toEqual({
      changed: [{ entityType: 'pack', id: 'crew_full' }],
      removed: []
    });
  });

  test('changing one product reports only that product', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.products.BEAGLE.prices.two_sides.T1 = 12.5;
    expect(diffEntities(oldCfg, newCfg)).toEqual({
      changed: [{ entityType: 'product', id: 'BEAGLE' }],
      removed: []
    });
  });

  test('adding a supplier reports it as changed', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.suppliers.STANLEY = { name: 'Stanley/Stella', web: '', notes: '' };
    expect(diffEntities(oldCfg, newCfg)).toEqual({
      changed: [{ entityType: 'supplier', id: 'STANLEY' }],
      removed: []
    });
  });

  test('removing a product reports it as removed', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    delete newCfg.products.URBAN;
    const diff = diffEntities(oldCfg, newCfg);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([{ entityType: 'product', id: 'URBAN' }]);
  });

  test('changing a parameter reports the parameters global', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.parameters.labor_eur_hour = 16;
    expect(diffEntities(oldCfg, newCfg)).toEqual({
      changed: [{ entityType: 'parameters', id: null }],
      removed: []
    });
  });

  test('changing the company name reports the company global', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.company.name = 'Otro Taller';
    expect(diffEntities(oldCfg, newCfg)).toEqual({
      changed: [{ entityType: 'company', id: null }],
      removed: []
    });
  });

  test('changing quote_settings reports the company global (company includes quote_settings)', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.quote_settings.validity_days = 45;
    expect(diffEntities(oldCfg, newCfg)).toEqual({
      changed: [{ entityType: 'company', id: null }],
      removed: []
    });
  });

  test('changing a tier reports the tiers global', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.tiers[0].label = '10-20 uds';
    expect(diffEntities(oldCfg, newCfg)).toEqual({
      changed: [{ entityType: 'tiers', id: null }],
      removed: []
    });
  });
});

// ------------------------------------------------------------
// buildEntityWrite — column shapes match the assembler exactly
// ------------------------------------------------------------
describe('buildEntityWrite', () => {
  const cfg = baseCfg();
  const entities = disassemble(cfg);

  test('a product write deletes children + row, then re-inserts the assembler rows', () => {
    const stmts = buildEntityWrite('product', 'BEAGLE', cfg);
    const deletes = stmts.filter((s) => /^DELETE FROM/.test(s.sql)).map((s) => s.sql.match(/FROM (\w+)/)[1]);
    // Children deleted before the parent row.
    expect(deletes).toContain('product_suppliers');
    expect(deletes).toContain('product_prices');
    expect(deletes).toContain('products');
    expect(deletes.indexOf('products')).toBe(deletes.length - 1);

    // INSERTed rows match disassemble() filtered to this id, column-for-column.
    const inserts = stmts.map((s) => parseInsert(s.sql, s.params)).filter(Boolean);
    const byTable = {};
    for (const ins of inserts) byTable[ins.table] = ins.rows;

    expect(byTable.products).toEqual(entities.products.filter((r) => r.id === 'BEAGLE'));
    expect(byTable.product_suppliers).toEqual(entities.product_suppliers.filter((r) => r.product_id === 'BEAGLE'));
    expect(byTable.product_prices).toEqual(entities.product_prices.filter((r) => r.product_id === 'BEAGLE'));
  });

  test('a pack write rewrites options/values/components/bundle_prices for that id', () => {
    const stmts = buildEntityWrite('pack', 'crew_full', cfg);
    const inserts = stmts.map((s) => parseInsert(s.sql, s.params)).filter(Boolean);
    const byTable = {};
    for (const ins of inserts) byTable[ins.table] = ins.rows;

    expect(byTable.packs).toEqual(entities.packs.filter((r) => r.id === 'crew_full'));
    expect(byTable.pack_options).toEqual(entities.pack_options.filter((r) => r.pack_id === 'crew_full'));
    expect(byTable.pack_option_values).toEqual(entities.pack_option_values.filter((r) => r.pack_id === 'crew_full'));
    expect(byTable.pack_components).toEqual(entities.pack_components.filter((r) => r.pack_id === 'crew_full'));
    expect(byTable.bundle_prices).toEqual(entities.bundle_prices.filter((r) => r.pack_id === 'crew_full'));
  });

  test('a supplier write rewrites just the supplier row', () => {
    const stmts = buildEntityWrite('supplier', 'ROLY', cfg);
    const inserts = stmts.map((s) => parseInsert(s.sql, s.params)).filter(Boolean);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('suppliers');
    expect(inserts[0].rows).toEqual(entities.suppliers.filter((r) => r.id === 'ROLY'));
  });

  test('the parameters global replaces every parameters row', () => {
    const stmts = buildEntityWrite('parameters', null, cfg);
    expect(stmts.some((s) => /^DELETE FROM parameters/.test(s.sql))).toBe(true);
    const inserts = stmts.map((s) => parseInsert(s.sql, s.params)).filter(Boolean);
    const rows = inserts.flatMap((i) => i.rows);
    expect(rows).toEqual(entities.parameters);
  });

  test('the company global replaces every company row (company + quote_settings)', () => {
    const stmts = buildEntityWrite('company', null, cfg);
    expect(stmts.some((s) => /^DELETE FROM company/.test(s.sql))).toBe(true);
    const inserts = stmts.map((s) => parseInsert(s.sql, s.params)).filter(Boolean);
    const rows = inserts.flatMap((i) => i.rows);
    expect(rows).toEqual(entities.company);
  });

  test('the tiers global replaces every tiers row', () => {
    const stmts = buildEntityWrite('tiers', null, cfg);
    expect(stmts.some((s) => /^DELETE FROM tiers/.test(s.sql))).toBe(true);
    const inserts = stmts.map((s) => parseInsert(s.sql, s.params)).filter(Boolean);
    const rows = inserts.flatMap((i) => i.rows);
    expect(rows).toEqual(entities.tiers);
  });
});

// ------------------------------------------------------------
// writeEntities
// ------------------------------------------------------------
describe('writeEntities', () => {
  test('no change → writes nothing, ok with the unchanged version', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    const client = fakeClient();
    const res = await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW, expectedVersions: baselineVersions(oldCfg)
    });
    expect(res.ok).toBe(true);
    expect(res.results).toEqual([]);
    expect(res.conflicts).toEqual([]);
    // No version bump, no writes at all.
    expect(client.queries).toEqual([]);
  });

  test('a single pack change bumps the version, audits and snapshots', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.packs.crew_full.name = 'Pack Peña editado';
    const client = fakeClient();
    const res = await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW, expectedVersions: baselineVersions(oldCfg)
    });

    expect(res.ok).toBe(true);
    expect(res.catalogVersion).toBe(8); // 7 → 8
    expect(res.results).toEqual([{ entityType: 'pack', id: 'crew_full', status: 'written' }]);
    expect(res.conflicts).toEqual([]);

    // Guard runs first, then children, then audit, then meta bump + snapshot.
    expect(client.queries.some((q) => /^UPDATE packs SET version = version \+ 1/.test(q.sql))).toBe(true);
    const audit = client.queries.find((q) => /^INSERT INTO audit_log/.test(q.sql));
    expect(audit).toBeTruthy();
    expect(audit.params).toContain('Alberto');
    expect(audit.params).toContain('pack');
    expect(audit.params).toContain('crew_full');
    expect(audit.params).toContain('update');
    const meta = client.queries.find((q) => /^UPDATE catalog_meta SET catalog_version/.test(q.sql));
    expect(meta).toBeTruthy();
    expect(meta.params).toContain('Alberto');
    const snap = client.queries.find((q) => /^INSERT INTO snapshots/.test(q.sql));
    expect(snap).toBeTruthy();
    // The snapshot stores the full assembled new cfg JSON at the new version.
    expect(snap.params[0]).toBe(8);
    const stored = JSON.parse(snap.params[1]);
    expect(stored.packs.crew_full.name).toBe('Pack Peña editado');
  });

  test('the guard UPDATE uses the expected version of that entity', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.products.BEAGLE.name = 'Camiseta premium';
    const client = fakeClient();
    await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW, expectedVersions: baselineVersions(oldCfg)
    });
    const guard = client.queries.find((q) => /^UPDATE products SET version = version \+ 1/.test(q.sql));
    expect(guard.sql).toBe('UPDATE products SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?');
    expect(guard.params).toEqual([NOW(), 'BEAGLE', 1]);
  });

  test('a stale version is a conflict: server row returned, children NOT written, others still written', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.packs.crew_full.name = 'Pack editado';      // will conflict
    newCfg.products.BEAGLE.name = 'Camiseta editada';  // will succeed
    const serverRow = { id: 'crew_full', name: 'Editado por otro PC', version: 5 };
    const client = fakeClient({
      staleIds: new Set(['crew_full']),
      serverRows: { packs: { crew_full: serverRow } }
    });
    const res = await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW, expectedVersions: baselineVersions(oldCfg)
    });

    expect(res.ok).toBe(false);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toMatchObject({ entityType: 'pack', id: 'crew_full', serverRow });
    // The conflicted pack's children must NOT have been written.
    expect(client.queries.some((q) => /^DELETE FROM pack_options/.test(q.sql))).toBe(false);
    // The non-conflicting product WAS written.
    expect(client.queries.some((q) => /^UPDATE products SET version = version \+ 1/.test(q.sql))).toBe(true);
    expect(client.queries.some((q) => /^INSERT INTO products/.test(q.sql))).toBe(true);
    // Result statuses reflect both outcomes.
    expect(res.results).toContainEqual({ entityType: 'pack', id: 'crew_full', status: 'conflict' });
    expect(res.results).toContainEqual({ entityType: 'product', id: 'BEAGLE', status: 'written' });
    // The version still bumped because at least one entity was written.
    expect(res.catalogVersion).toBe(8);
  });

  test('an all-conflict result does not bump the version, snapshot, or audit', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.packs.crew_full.name = 'Pack editado';
    const client = fakeClient({
      staleIds: new Set(['crew_full']),
      serverRows: { packs: { crew_full: { id: 'crew_full', version: 5 } } }
    });
    const res = await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW, expectedVersions: baselineVersions(oldCfg)
    });
    expect(res.ok).toBe(false);
    expect(res.catalogVersion).toBe(7); // unchanged
    expect(client.queries.some((q) => /^UPDATE catalog_meta/.test(q.sql))).toBe(false);
    expect(client.queries.some((q) => /^INSERT INTO snapshots/.test(q.sql))).toBe(false);
    expect(client.queries.some((q) => /^INSERT INTO audit_log/.test(q.sql))).toBe(false);
  });

  test('removing an entity archives it and audits a delete', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    delete newCfg.products.URBAN;
    const client = fakeClient();
    const res = await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW, expectedVersions: baselineVersions(oldCfg)
    });
    expect(res.ok).toBe(true);
    expect(res.results).toContainEqual({ entityType: 'product', id: 'URBAN', status: 'deleted' });
    const archive = client.queries.find((q) => /^UPDATE products SET archived_at = \?/.test(q.sql));
    expect(archive).toBeTruthy();
    expect(archive.params).toEqual([NOW(), 'URBAN']);
    const audit = client.queries.find((q) => /^INSERT INTO audit_log/.test(q.sql));
    expect(audit.params).toContain('delete');
    expect(res.catalogVersion).toBe(8);
  });

  test('a global parameter change replaces the parameters rows, bumps and audits', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.parameters.labor_eur_hour = 16;
    const client = fakeClient();
    const res = await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW, expectedVersions: baselineVersions(oldCfg)
    });
    expect(res.ok).toBe(true);
    expect(res.results).toEqual([{ entityType: 'parameters', id: null, status: 'written' }]);
    expect(res.catalogVersion).toBe(8);
    // Parameters rows wiped and re-inserted.
    expect(client.queries.some((q) => /^DELETE FROM parameters/.test(q.sql))).toBe(true);
    expect(client.queries.some((q) => /^INSERT INTO parameters/.test(q.sql))).toBe(true);
    const audit = client.queries.find((q) => /^INSERT INTO audit_log/.test(q.sql));
    expect(audit.params).toContain('parameters');
  });

  test('a global with a stale catalog_version is reported as a conflict', async () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.parameters.labor_eur_hour = 16;
    const client = fakeClient();
    const expected = baselineVersions(oldCfg);
    expected.catalogVersion = 5; // server is at 7 → stale
    const res = await writeEntities(client, {
      oldCfg, newCfg, user: 'Alberto', now: NOW,
      expectedVersions: expected,
      serverCatalogVersion: 7
    });
    expect(res.ok).toBe(false);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toMatchObject({ entityType: 'parameters', id: null });
    // No parameters rows touched on a global conflict.
    expect(client.queries.some((q) => /^DELETE FROM parameters/.test(q.sql))).toBe(false);
  });
});
