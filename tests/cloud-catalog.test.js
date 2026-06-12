// ============================================================
// Tests · lib/cloud-catalog.js (catalog read path + initial seed)
// ============================================================
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTITY_TABLES,
  ARCHIVABLE_TABLES,
  loadEntities,
  getCatalogVersion,
  seedCatalog
} from '../lib/cloud-catalog.js';
import { disassemble } from '../lib/catalog-assembler.js';
import { buildDefaultConfig } from '../config.default.js';

const META_ROW = {
  id: 1, catalog_version: 7, schema_version: 1, min_app_version: '5.0.0',
  migrating_since: null, updated_at: '2026-06-12T10:00:00.000Z', updated_by: 'PC-1'
};

const ARCHIVABLE = ['suppliers', 'products', 'addons', 'packs'];

// Fake read client: answers each SELECT with the rows configured for
// that table and records every query for SQL pinning.
function fakeReadClient(tables = {}, metaRow = META_ROW) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      const table = sql.match(/FROM (\w+)/)[1];
      if (table === 'catalog_meta') return { results: metaRow ? [metaRow] : [], meta: {} };
      return { results: tables[table] || [], meta: {} };
    }
  };
}

describe('ENTITY_TABLES', () => {
  test('lists the 13 catalog tables in FK-safe order (parents before children)', () => {
    expect(ENTITY_TABLES).toHaveLength(13);
    expect(ENTITY_TABLES).toEqual(Object.keys(disassemble(buildDefaultConfig())));
    // Referential order: a child table never precedes its parent.
    expect(ENTITY_TABLES.indexOf('suppliers')).toBeLessThan(ENTITY_TABLES.indexOf('product_suppliers'));
    expect(ENTITY_TABLES.indexOf('products')).toBeLessThan(ENTITY_TABLES.indexOf('product_suppliers'));
    expect(ENTITY_TABLES.indexOf('products')).toBeLessThan(ENTITY_TABLES.indexOf('product_prices'));
    expect(ENTITY_TABLES.indexOf('packs')).toBeLessThan(ENTITY_TABLES.indexOf('pack_options'));
    expect(ENTITY_TABLES.indexOf('packs')).toBeLessThan(ENTITY_TABLES.indexOf('pack_components'));
    expect(ENTITY_TABLES.indexOf('packs')).toBeLessThan(ENTITY_TABLES.indexOf('bundle_prices'));
  });
});

describe('ARCHIVABLE_TABLES', () => {
  test('matches exactly the ENTITY_TABLES declaring archived_at in the bundled schema (drift pin)', () => {
    const sqlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '0001_init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    // Each chunk runs from one CREATE TABLE to the next, so an
    // archived_at column anywhere in the chunk belongs to that table.
    const declared = sql
      .split(/CREATE TABLE IF NOT EXISTS /)
      .slice(1)
      .map((chunk) => ({ name: chunk.match(/^(\w+)/)[1], chunk }))
      .filter(({ chunk }) => /\barchived_at\b/.test(chunk))
      .map(({ name }) => name)
      .filter((name) => ENTITY_TABLES.includes(name));
    expect(new Set(declared)).toEqual(ARCHIVABLE_TABLES);
  });
});

describe('loadEntities', () => {
  test('reads catalog_meta FIRST, then the entity tables', async () => {
    const client = fakeReadClient();
    await loadEntities(client);
    // The version is captured before any entity rows, so the cached
    // catalogVersion can never overstate the freshness of the rows.
    expect(client.queries[0].sql).toBe('SELECT * FROM catalog_meta WHERE id = 1');
    expect(client.queries).toHaveLength(ENTITY_TABLES.length + 1);
  });

  test('selects every table (archived filtered out) plus the meta row', async () => {
    const client = fakeReadClient({
      products: [{ id: 'BEAGLE', name: 'Camiseta' }],
      tiers: [{ id: 'T1', position: 0 }]
    });
    const { entities, meta } = await loadEntities(client);

    // One SELECT per entity table + one for catalog_meta.
    expect(client.queries).toHaveLength(ENTITY_TABLES.length + 1);
    for (const table of ARCHIVABLE) {
      expect(client.queries.some((q) => q.sql === `SELECT * FROM ${table} WHERE archived_at IS NULL`)).toBe(true);
    }
    expect(client.queries.some((q) => q.sql === 'SELECT * FROM tiers')).toBe(true);
    expect(client.queries.some((q) => q.sql === 'SELECT * FROM catalog_meta WHERE id = 1')).toBe(true);

    // Every table key present, rows passed through, empty tables → [].
    expect(Object.keys(entities)).toEqual(ENTITY_TABLES);
    expect(entities.products).toEqual([{ id: 'BEAGLE', name: 'Camiseta' }]);
    expect(entities.bundle_prices).toEqual([]);

    expect(meta).toEqual({ catalogVersion: 7, schemaVersion: 1, minAppVersion: '5.0.0' });
  });

  test('throws a Spanish error when the catalog_meta row is missing', async () => {
    const client = fakeReadClient({}, null);
    await expect(loadEntities(client)).rejects.toThrow(/metadatos del catálogo/);
  });
});

describe('getCatalogVersion', () => {
  test('returns the catalog_version as a number', async () => {
    const client = fakeReadClient();
    expect(await getCatalogVersion(client)).toBe(7);
    expect(client.queries[0].sql).toBe('SELECT catalog_version FROM catalog_meta WHERE id = 1');
  });

  test('throws a Spanish error when the meta row is missing', async () => {
    const client = fakeReadClient({}, null);
    await expect(getCatalogVersion(client)).rejects.toThrow(/metadatos del catálogo/);
  });
});

// Fake seed client: reports the configured products count and
// records every INSERT/UPDATE for later reconstruction.
function fakeSeedClient({ productCount = 0 } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/^SELECT COUNT\(\*\)/.test(sql)) return { results: [{ n: productCount }], meta: {} };
      return { results: [], meta: { changes: 1 } };
    }
  };
}

// Rebuilds the rows a table received across all (possibly chunked)
// INSERT statements, so the test can compare against the input.
function insertedRows(queries, table) {
  const rows = [];
  for (const q of queries) {
    const m = q.sql.match(new RegExp(`^INSERT OR IGNORE INTO ${table} \\(([^)]+)\\) VALUES `));
    if (!m) continue;
    const cols = m[1].split(', ');
    expect(q.params.length % cols.length).toBe(0);
    for (let i = 0; i < q.params.length; i += cols.length) {
      const row = {};
      cols.forEach((col, j) => { row[col] = q.params[i + j]; });
      rows.push(row);
    }
  }
  return rows;
}

describe('seedCatalog', () => {
  const entities = disassemble(buildDefaultConfig());
  const OPTS = { user: 'PC-Wizard', now: () => '2026-06-12T11:00:00.000Z' };

  test('seeds the full default catalog into an empty base, table by table', async () => {
    const client = fakeSeedClient({ productCount: 0 });
    const out = await seedCatalog(client, entities, OPTS);
    expect(out).toEqual({ seeded: true });

    // Every row of every table arrives, parameterized, nothing inline.
    for (const table of ENTITY_TABLES) {
      expect(insertedRows(client.queries, table)).toEqual(entities[table]);
    }
    // D1 caps bound parameters per query at 100 — chunking must respect it.
    for (const q of client.queries) {
      expect(q.params.length).toBeLessThanOrEqual(100);
    }
    // Inserts follow ENTITY_TABLES order (FK parents first).
    const insertOrder = client.queries
      .map((q) => (q.sql.match(/^INSERT OR IGNORE INTO (\w+) /) || [])[1])
      .filter(Boolean);
    const firstSeen = [...new Set(insertOrder)];
    expect(firstSeen).toEqual(ENTITY_TABLES.filter((t) => entities[t].length > 0));
  });

  test('bumps catalog_version and stamps the seeding user and timestamp', async () => {
    const client = fakeSeedClient({ productCount: 0 });
    await seedCatalog(client, entities, OPTS);
    const metaUpdate = client.queries.find((q) => /^UPDATE catalog_meta/.test(q.sql));
    // The bump invalidates any cached pre-seed (empty) snapshot.
    expect(metaUpdate.sql).toBe(
      'UPDATE catalog_meta SET catalog_version = catalog_version + 1, updated_by = ?, updated_at = ? WHERE id = 1'
    );
    expect(metaUpdate.params).toEqual(['PC-Wizard', '2026-06-12T11:00:00.000Z']);
  });

  test('is a no-op on an already-populated base', async () => {
    const client = fakeSeedClient({ productCount: 9 });
    const out = await seedCatalog(client, entities, OPTS);
    expect(out).toEqual({ seeded: false });
    expect(client.queries).toHaveLength(1); // only the COUNT probe
  });
});
