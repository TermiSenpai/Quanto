// ============================================================
// Tests · lib/cloud-history.js (audit/snapshot read + restore)
// ============================================================
// The cloud history read path (audit_log + snapshots) and the
// forward-only restore, exercised with fake D1 clients mirroring
// lib/d1-client.js (query → { results, meta }). Covers: audit
// ordering + limit/offset + diff parsing + malformed-diff tolerance,
// snapshot listing/get (cfg parsed, missing → Spanish error), and
// restore (writes the snapshot's entities, archives the ones absent
// from it, produces a new catalog_version + new snapshot + audit
// rows, and uses the CURRENT live versions so it never self-conflicts).
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  readAuditLog,
  listSnapshots,
  getSnapshot,
  restoreSnapshot
} from '../lib/cloud-history.js';
import { disassemble } from '../lib/catalog-assembler.js';
import { buildDefaultConfig } from '../config.default.js';

const NOW = () => '2026-06-13T12:00:00.000Z';

const META_ROW = {
  id: 1, catalog_version: 7, schema_version: 1, min_app_version: '5.0.0',
  migrating_since: null, updated_at: '2026-06-12T09:00:00.000Z', updated_by: 'PC-1'
};

function baseCfg() {
  const cfg = buildDefaultConfig();
  delete cfg.admin;
  return cfg;
}

// ------------------------------------------------------------
// readAuditLog
// ------------------------------------------------------------
describe('readAuditLog', () => {
  // A fake that records the audit query and serves canned rows. The
  // rows already come back newest-first (the SQL does ORDER BY id DESC);
  // the fake just echoes whatever it is given so we can assert mapping.
  function fakeAuditClient(rows) {
    const queries = [];
    return {
      queries,
      async query(sql, params = []) {
        queries.push({ sql, params });
        return { results: rows, meta: {} };
      }
    };
  }

  const ROWS = [
    { id: 3, ts: '2026-06-13T11:00:00.000Z', user: 'Ana', entity_type: 'product', entity_id: 'BEAGLE', action: 'update', diff_json: JSON.stringify([{ path: 'name', before: 'A', after: 'B', kind: 'change' }]), catalog_version: 9 },
    { id: 2, ts: '2026-06-13T10:30:00.000Z', user: 'Beto', entity_type: 'parameters', entity_id: null, action: 'update', diff_json: '[]', catalog_version: 8 },
    { id: 1, ts: '2026-06-13T10:00:00.000Z', user: 'Ana', entity_type: 'supplier', entity_id: 'ROLY', action: 'create', diff_json: JSON.stringify([{ path: 'name', before: undefined, after: 'Roly', kind: 'add' }]), catalog_version: 8 }
  ];

  test('maps rows to the public shape, diff parsed into an array, newest-first preserved', async () => {
    const client = fakeAuditClient(ROWS);
    const entries = await readAuditLog(client, {});
    expect(entries).toEqual([
      { id: 3, ts: '2026-06-13T11:00:00.000Z', user: 'Ana', entityType: 'product', entityId: 'BEAGLE', action: 'update', diff: [{ path: 'name', before: 'A', after: 'B', kind: 'change' }], catalogVersion: 9 },
      { id: 2, ts: '2026-06-13T10:30:00.000Z', user: 'Beto', entityType: 'parameters', entityId: null, action: 'update', diff: [], catalogVersion: 8 },
      { id: 1, ts: '2026-06-13T10:00:00.000Z', user: 'Ana', entityType: 'supplier', entityId: 'ROLY', action: 'create', diff: [{ path: 'name', before: undefined, after: 'Roly', kind: 'add' }], catalogVersion: 8 }
    ]);
  });

  test('orders newest-first and applies limit/offset as bound params', async () => {
    const client = fakeAuditClient(ROWS);
    await readAuditLog(client, { limit: 10, offset: 20 });
    const q = client.queries[0];
    expect(q.sql).toMatch(/ORDER BY id DESC/);
    expect(q.sql).toMatch(/LIMIT \? OFFSET \?/);
    expect(q.params).toEqual([10, 20]);
  });

  test('defaults to limit 50 offset 0 when omitted', async () => {
    const client = fakeAuditClient(ROWS);
    await readAuditLog(client);
    expect(client.queries[0].params).toEqual([50, 0]);
  });

  test('tolerates malformed diff_json: keeps the raw string, never throws the whole read', async () => {
    const bad = [
      { id: 5, ts: 't5', user: 'Ana', entity_type: 'pack', entity_id: 'crew', action: 'update', diff_json: '{not json', catalog_version: 10 },
      { id: 4, ts: 't4', user: 'Beto', entity_type: 'pack', entity_id: 'crew', action: 'update', diff_json: '[{"path":"x"}]', catalog_version: 10 }
    ];
    const entries = await readAuditLog(fakeAuditClient(bad), {});
    // The malformed one keeps the raw string instead of a parsed array.
    expect(entries[0].diff).toBe('{not json');
    // The well-formed neighbour still parses fine — one bad row never
    // poisons the rest.
    expect(entries[1].diff).toEqual([{ path: 'x' }]);
  });

  test('null results from D1 read back as an empty list', async () => {
    const client = { async query() { return { results: null, meta: {} }; } };
    expect(await readAuditLog(client, {})).toEqual([]);
  });
});

// ------------------------------------------------------------
// listSnapshots + getSnapshot
// ------------------------------------------------------------
describe('listSnapshots', () => {
  test('returns { catalogVersion, ts } newest-first', async () => {
    const rows = [
      { catalog_version: 9, ts: '2026-06-13T11:00:00.000Z' },
      { catalog_version: 8, ts: '2026-06-13T10:00:00.000Z' },
      { catalog_version: 7, ts: '2026-06-13T09:00:00.000Z' }
    ];
    const queries = [];
    const client = { async query(sql) { queries.push(sql); return { results: rows, meta: {} }; } };
    const list = await listSnapshots(client);
    expect(queries[0]).toMatch(/ORDER BY catalog_version DESC/);
    expect(list).toEqual([
      { catalogVersion: 9, ts: '2026-06-13T11:00:00.000Z' },
      { catalogVersion: 8, ts: '2026-06-13T10:00:00.000Z' },
      { catalogVersion: 7, ts: '2026-06-13T09:00:00.000Z' }
    ]);
  });

  test('null results read back as an empty list', async () => {
    const client = { async query() { return { results: null, meta: {} }; } };
    expect(await listSnapshots(client)).toEqual([]);
  });
});

describe('getSnapshot', () => {
  test('parses the stored JSON into cfg', async () => {
    const cfg = baseCfg();
    const stored = JSON.stringify({ ...cfg, catalog_version: 5 });
    const client = {
      async query(sql, params) {
        expect(params).toEqual([5]);
        return { results: [{ catalog_version: 5, ts: '2026-06-13T09:00:00.000Z', json: stored }], meta: {} };
      }
    };
    const snap = await getSnapshot(client, 5);
    expect(snap.catalogVersion).toBe(5);
    expect(snap.ts).toBe('2026-06-13T09:00:00.000Z');
    expect(snap.cfg.products.BEAGLE.name).toBe(cfg.products.BEAGLE.name);
  });

  test('a missing version throws a clear Spanish error', async () => {
    const client = { async query() { return { results: [], meta: {} }; } };
    await expect(getSnapshot(client, 999)).rejects.toThrow(/versión/i);
  });

  test('corrupt snapshot JSON throws a Spanish error (never silent)', async () => {
    const client = { async query() { return { results: [{ catalog_version: 5, ts: 't', json: '{bad' }], meta: {} }; } };
    await expect(getSnapshot(client, 5)).rejects.toThrow(/snapshot|catálogo|JSON/i);
  });
});

// ------------------------------------------------------------
// restoreSnapshot — forward-only rollback
// ------------------------------------------------------------
// A combined fake D1 world: serves getSnapshot (the target version's
// stored cfg), loadEntities (the CURRENT live catalog + per-id versions)
// and the writeEntities guarded-write traffic. Per-id main rows carry a
// `version` column so restore's expectedVersions (the live versions) make
// the guards always hold — a restore must never conflict against itself.
function fakeRestoreWorld({ snapshotCfg, liveCfg, metaRow = META_ROW } = {}) {
  const live = disassemble(liveCfg);
  for (const table of ['packs', 'products', 'suppliers', 'addons']) {
    live[table] = live[table].map((r) => ({ ...r, version: 3 }));
  }
  const queries = [];
  const snapshotJson = JSON.stringify({ ...snapshotCfg, catalog_version: 3 });
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // getSnapshot read.
      if (/FROM snapshots WHERE catalog_version = \?/.test(sql)) {
        return { results: [{ catalog_version: params[0], ts: '2026-06-10T09:00:00.000Z', json: snapshotJson }], meta: {} };
      }
      // writeEntities guarded UPDATE of a per-id main row: always holds
      // (changes=1) because restore uses the live versions.
      if (/^UPDATE (\w+) SET version = version \+ 1/.test(sql)) {
        return { results: [], meta: { changes: 1 } };
      }
      // Globals guard: live re-read of catalog_meta.
      if (/^SELECT catalog_version FROM catalog_meta/.test(sql)) {
        return { results: [{ catalog_version: metaRow.catalog_version }], meta: {} };
      }
      // Create-collision existence check (a brand-new id from the snapshot).
      const exists = sql.match(/^SELECT (\w+) FROM (\w+) WHERE \w+ = \?$/);
      if (exists) return { results: [], meta: {} };
      // loadEntities reads.
      const table = (sql.match(/FROM (\w+)/) || [])[1];
      if (table === 'catalog_meta') return { results: [metaRow], meta: {} };
      if (table && live[table] !== undefined) return { results: live[table], meta: {} };
      // DELETE/INSERT children, audit, snapshot, archive, meta bump.
      return { results: [], meta: { changes: 1 } };
    }
  };
}

describe('restoreSnapshot', () => {
  test('restores the snapshot content: a new version, new snapshot and audit rows', async () => {
    // Live state has an edited BEAGLE; the snapshot has the original.
    const snapshotCfg = baseCfg();
    const liveCfg = baseCfg();
    liveCfg.products.BEAGLE.name = 'Editado después';
    const client = fakeRestoreWorld({ snapshotCfg, liveCfg });

    const res = await restoreSnapshot(client, { version: 3, user: 'Ana', now: NOW });

    expect(res.ok).toBe(true);
    expect(res.catalogVersion).toBe(8); // live 7 → 8 (forward-only)
    // The edited entity was rewritten back to the snapshot value.
    const beagleInsert = client.queries.find(
      (q) => /^INSERT INTO products/.test(q.sql) && q.params.includes('BEAGLE')
    );
    expect(beagleInsert).toBeTruthy();
    // A new snapshot at the new version + audit rows were written by
    // writeEntities (restore is itself audited).
    expect(client.queries.some((q) => /^INSERT INTO snapshots/.test(q.sql))).toBe(true);
    expect(client.queries.some((q) => /^INSERT INTO audit_log/.test(q.sql))).toBe(true);
    expect(client.queries.some((q) => /^UPDATE catalog_meta SET catalog_version/.test(q.sql))).toBe(true);
  });

  test('archives entities present live but absent from the snapshot', async () => {
    // The snapshot predates a product that exists in the live catalog.
    const snapshotCfg = baseCfg();
    delete snapshotCfg.products.URBAN; // not in the snapshot
    const liveCfg = baseCfg();        // URBAN still live
    const client = fakeRestoreWorld({ snapshotCfg, liveCfg });

    const res = await restoreSnapshot(client, { version: 3, user: 'Ana', now: NOW });

    expect(res.ok).toBe(true);
    // URBAN is archived (soft delete), not left dangling.
    const archive = client.queries.find((q) => /^UPDATE products SET archived_at = \?/.test(q.sql) && q.params.includes('URBAN'));
    expect(archive).toBeTruthy();
  });

  test('uses the CURRENT live versions so the guards always hold (never self-conflicts)', async () => {
    const snapshotCfg = baseCfg();
    const liveCfg = baseCfg();
    liveCfg.products.BEAGLE.name = 'Editado después';
    const client = fakeRestoreWorld({ snapshotCfg, liveCfg });

    const res = await restoreSnapshot(client, { version: 3, user: 'Ana', now: NOW });
    expect(res.ok).toBe(true);
    expect(res.catalogVersion).toBe(8);
    // The guard UPDATE used the LIVE version (3, stamped by the fake),
    // not the snapshot's — so it can never report a false conflict.
    const guard = client.queries.find((q) => /^UPDATE products SET version = version \+ 1/.test(q.sql) && q.params.includes('BEAGLE'));
    expect(guard.params).toEqual([NOW(), 'BEAGLE', 3]);
  });

  test('a missing target version surfaces the Spanish error from getSnapshot', async () => {
    const client = {
      async query(sql) {
        if (/FROM snapshots WHERE catalog_version = \?/.test(sql)) return { results: [], meta: {} };
        return { results: [], meta: {} };
      }
    };
    await expect(restoreSnapshot(client, { version: 999, user: 'Ana', now: NOW })).rejects.toThrow(/versión/i);
  });
});
