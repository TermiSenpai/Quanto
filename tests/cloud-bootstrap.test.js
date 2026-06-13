// ============================================================
// Tests · lib/cloud-bootstrap.js (cloud read path + provisioning)
// ============================================================
// The whole IPC-facing orchestration is exercised here with fake D1
// clients and a temp dir for cache/backups, so the main.js handlers
// can stay 3-line wiring. Covers: token test, catalog load with the
// 5s timeout and the cache fallback ladder, version probe, refresh
// without silent fallback, and the §6 migration-safety contract of
// cloud:provision (lock → backup → apply → verify → release).
// ============================================================

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCloudBootstrap } from '../lib/cloud-bootstrap.js';
import { readCache, writeCache } from '../lib/catalog-cache.js';
import { disassemble } from '../lib/catalog-assembler.js';
import { buildDefaultConfig } from '../config.default.js';

const NOW = () => '2026-06-12T10:00:00.000Z';

const META_ROW = {
  id: 1, catalog_version: 7, schema_version: 1, min_app_version: '5.0.0',
  migrating_since: null, updated_at: '2026-06-12T09:00:00.000Z', updated_by: 'PC-1'
};

const SETTINGS = {
  data_source: 'cloud',
  user_name: 'Alberto',
  cloud: { token: 'tok-secret', account_id: 'acc-1', database_id: 'db-1', user_name: 'Alberto' }
};

const MIGRATIONS = [{ id: '0001_init', sql: 'CREATE TABLE IF NOT EXISTS x (y);' }];

let tmpDir, cachePath, backupDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-bootstrap-'));
  cachePath = path.join(tmpDir, 'cache', 'catalog.json');
  backupDir = path.join(tmpDir, 'backups');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// What the assembled cloud config must look like: the default
// catalog minus `admin`, with the cloud-side metadata stamped in.
function expectedConfig(updatedAt) {
  const cfg = buildDefaultConfig();
  delete cfg.admin;
  return { ...cfg, version: buildDefaultConfig().version, updated_at: updatedAt, modified_by: 'nube' };
}

// Fake read-only client: serves the meta row + entity tables.
function fakeCatalogClient(entities, metaRow = META_ROW) {
  return {
    async query(sql) {
      const table = sql.match(/FROM (\w+)/)[1];
      if (table === 'catalog_meta') return { results: metaRow ? [metaRow] : [], meta: {} };
      return { results: entities[table] || [], meta: {} };
    }
  };
}

function makeBootstrap(client, overrides = {}) {
  const created = [];
  const bootstrap = createCloudBootstrap({
    createClient: (opts) => { created.push(opts); return client; },
    loadMigrations: () => MIGRATIONS,
    cachePath,
    backupDir,
    buildDefaultConfig,
    appVersion: '5.0.0-test',
    now: NOW,
    timeoutMs: 5000,
    ...overrides
  });
  return { bootstrap, created };
}

// ------------------------------------------------------------
// testToken
// ------------------------------------------------------------
describe('testToken', () => {
  test('returns the accounts (id + name only) on a valid token', async () => {
    const client = {
      async listAccounts() {
        return [{ id: 'acc-1', name: 'Taller', extra: 'dropped' }, { id: 'acc-2', name: 'Otra' }];
      }
    };
    const { bootstrap, created } = makeBootstrap(client);
    const res = await bootstrap.testToken({ token: 'tok-secret' });
    expect(res).toEqual({ ok: true, accounts: [{ id: 'acc-1', name: 'Taller' }, { id: 'acc-2', name: 'Otra' }] });
    expect(created).toEqual([{ token: 'tok-secret' }]);
  });

  test('maps a rejected token to { ok: false, error } (Spanish message passthrough)', async () => {
    const client = {
      async listAccounts() { throw new Error('Cloudflare rechazó la petición: Invalid API Token'); }
    };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.testToken({ token: 'bad' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Cloudflare rechazó/);
  });
});

// ------------------------------------------------------------
// loadCatalog — cloud → cache → error ladder
// ------------------------------------------------------------
describe('loadCatalog', () => {
  const entities = disassemble(buildDefaultConfig());

  test('cloud ok: assembles, validates, writes the cache and reports source cloud', async () => {
    const client = fakeCatalogClient(entities);
    const { bootstrap, created } = makeBootstrap(client);
    const res = await bootstrap.loadCatalog(SETTINGS);

    expect(res.ok).toBe(true);
    expect(res.source).toBe('cloud');
    expect(res.catalogVersion).toBe(7);
    expect(res.fetchedAt).toBe(NOW());
    expect(res.config).toEqual(expectedConfig(NOW()));
    // The per-entity version map travels with the load (plan 3B item 5).
    // The fake rows carry no version column, so the maps are empty but the
    // catalog-wide counter is present for the renderer to echo on save.
    expect(res.versions).toEqual({ catalogVersion: 7, pack: {}, product: {}, supplier: {}, addon: {} });
    // The client is built from settings.cloud — and nothing else.
    expect(created).toEqual([{ token: 'tok-secret', accountId: 'acc-1', databaseId: 'db-1' }]);
    // Cache persisted for the next offline boot (versions included).
    expect(readCache(cachePath)).toEqual({
      fetchedAt: NOW(), catalogVersion: 7, entities,
      versions: { catalogVersion: 7, pack: {}, product: {}, supplier: {}, addon: {} }
    });
  });

  test('the config sent out has no admin section and never carries the token', async () => {
    const { bootstrap } = makeBootstrap(fakeCatalogClient(entities));
    const res = await bootstrap.loadCatalog(SETTINGS);
    expect(res.config.admin).toBeUndefined();
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('tok-secret');
    expect(serialized).not.toContain('account_id');
    expect(serialized).not.toContain('acc-1');
  });

  test('cloud down + cache present: starts from the cache, offline flagged', async () => {
    writeCache(cachePath, { fetchedAt: '2026-06-11T08:00:00.000Z', catalogVersion: 5, entities });
    const client = { async query() { throw new Error('No se pudo conectar con Cloudflare — comprueba la conexión a internet'); } };
    const log = vi.fn();
    const { bootstrap } = makeBootstrap(client, { log });
    const res = await bootstrap.loadCatalog(SETTINGS);

    expect(res.ok).toBe(true);
    expect(res.source).toBe('cache');
    expect(res.offline).toBe(true);
    // A network failure is offline, not cloud-invalid.
    expect(res.reason).toBeUndefined();
    // The cause is carried, never silently dropped, and logged.
    expect(res.cloudError).toMatch(/No se pudo conectar/);
    expect(log).toHaveBeenCalled();
    expect(res.fetchedAt).toBe('2026-06-11T08:00:00.000Z');
    expect(res.catalogVersion).toBe(5);
    expect(res.config).toEqual(expectedConfig('2026-06-11T08:00:00.000Z'));
  });

  test('invalid cloud data also falls back to the last good cache', async () => {
    writeCache(cachePath, { fetchedAt: '2026-06-11T08:00:00.000Z', catalogVersion: 5, entities });
    // Reachable D1 but an empty/garbage catalog: validation must reject
    // it and the app must keep working from the last good snapshot.
    // The cloud WAS reachable, so this is NOT offline — it is a
    // cloud-invalid fallback carrying the dropped cloud error.
    const log = vi.fn();
    const { bootstrap } = makeBootstrap(fakeCatalogClient({}), { log });
    const res = await bootstrap.loadCatalog(SETTINGS);
    expect(res.ok).toBe(true);
    expect(res.source).toBe('cache');
    expect(res.reason).toBe('cloud-invalid');
    expect(res.cloudError).toBeTruthy();
    expect(res.offline).toBeFalsy();
    // The dropped cloud error is logged, never silently swallowed.
    expect(log).toHaveBeenCalled();
  });

  test('cloud down + no cache: NO_CLOUD_NO_CACHE with the network error', async () => {
    const client = { async query() { throw new Error('No se pudo conectar con Cloudflare — comprueba la conexión a internet'); } };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.loadCatalog(SETTINGS);
    expect(res).toEqual({
      ok: false,
      code: 'NO_CLOUD_NO_CACHE',
      error: 'No se pudo conectar con Cloudflare — comprueba la conexión a internet'
    });
  });

  test('cloud down + corrupt cache: NO_CLOUD_NO_CACHE surfaces the corruption', async () => {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, '{ truncated', 'utf-8');
    const client = { async query() { throw new Error('No se pudo conectar con Cloudflare — comprueba la conexión a internet'); } };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.loadCatalog(SETTINGS);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NO_CLOUD_NO_CACHE');
    expect(res.error).toMatch(/Caché de catálogo dañada/);
  });

  test('a D1 that never answers is cut off by the timeout (cache fallback)', async () => {
    vi.useFakeTimers();
    writeCache(cachePath, { fetchedAt: '2026-06-11T08:00:00.000Z', catalogVersion: 5, entities });
    const client = { query: () => new Promise(() => {}) }; // hangs forever
    const { bootstrap } = makeBootstrap(client);
    const pending = bootstrap.loadCatalog(SETTINGS);
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.source).toBe('cache');
    expect(res.offline).toBe(true);
  });

  test('a D1 that never answers + no cache: timeout error with NO_CLOUD_NO_CACHE', async () => {
    vi.useFakeTimers();
    const client = { query: () => new Promise(() => {}) };
    const { bootstrap } = makeBootstrap(client);
    const pending = bootstrap.loadCatalog(SETTINGS);
    await vi.advanceTimersByTimeAsync(5000);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NO_CLOUD_NO_CACHE');
    expect(res.error).toMatch(/no respondió a tiempo/);
  });

  test('honours an injected timeoutMs', async () => {
    vi.useFakeTimers();
    const client = { query: () => new Promise(() => {}) };
    const { bootstrap } = makeBootstrap(client, { timeoutMs: 100 });
    const pending = bootstrap.loadCatalog(SETTINGS);
    await vi.advanceTimersByTimeAsync(100);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no respondió a tiempo/);
  });
});

// ------------------------------------------------------------
// checkVersion
// ------------------------------------------------------------
describe('checkVersion', () => {
  const entities = disassemble(buildDefaultConfig());

  test('up to date when the cached version matches the remote one', async () => {
    writeCache(cachePath, { fetchedAt: NOW(), catalogVersion: 7, entities });
    const { bootstrap } = makeBootstrap(fakeCatalogClient(entities));
    expect(await bootstrap.checkVersion(SETTINGS)).toEqual({ ok: true, current: 7, remote: 7, upToDate: true });
  });

  test('stale when the remote moved on', async () => {
    writeCache(cachePath, { fetchedAt: NOW(), catalogVersion: 5, entities });
    const { bootstrap } = makeBootstrap(fakeCatalogClient(entities));
    expect(await bootstrap.checkVersion(SETTINGS)).toEqual({ ok: true, current: 5, remote: 7, upToDate: false });
  });

  test('no cache yet: current is null and never up to date', async () => {
    const { bootstrap } = makeBootstrap(fakeCatalogClient(entities));
    expect(await bootstrap.checkVersion(SETTINGS)).toEqual({ ok: true, current: null, remote: 7, upToDate: false });
  });

  test('offline: { ok: false, offline: true }', async () => {
    const client = { async query() { throw new Error('No se pudo conectar con Cloudflare — comprueba la conexión a internet'); } };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.checkVersion(SETTINGS);
    expect(res.ok).toBe(false);
    expect(res.offline).toBe(true);
    expect(res.error).toMatch(/No se pudo conectar/);
  });
});

// ------------------------------------------------------------
// refreshCatalog — explicit refresh, NO silent cache fallback
// ------------------------------------------------------------
describe('refreshCatalog', () => {
  const entities = disassemble(buildDefaultConfig());

  test('reachable cloud: same success shape as loadCatalog, cache rewritten', async () => {
    const { bootstrap } = makeBootstrap(fakeCatalogClient(entities));
    const res = await bootstrap.refreshCatalog(SETTINGS);
    expect(res.ok).toBe(true);
    expect(res.source).toBe('cloud');
    expect(res.catalogVersion).toBe(7);
    expect(res.config).toEqual(expectedConfig(NOW()));
    expect(readCache(cachePath).catalogVersion).toBe(7);
  });

  test('offline: fails loudly even when a cache exists (no silent fallback)', async () => {
    writeCache(cachePath, { fetchedAt: NOW(), catalogVersion: 5, entities });
    const client = { async query() { throw new Error('No se pudo conectar con Cloudflare — comprueba la conexión a internet'); } };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.refreshCatalog(SETTINGS);
    expect(res.ok).toBe(false);
    expect(res.offline).toBe(true);
    expect(res.error).toMatch(/No se pudo conectar/);
    expect(res.config).toBeUndefined();
  });
});

// ------------------------------------------------------------
// provision — the §6 migration-safety contract
// ------------------------------------------------------------
// Fake D1 world rich enough for the full provision flow: database
// listing/creation, the catalog_meta lock state machine, the
// schema_migrations probe/ledger, export, verify reads and the seed.
function provisionWorld({
  existingDb = null,
  hadSchemaMigrations = false,
  lockHeldSince = null,
  productCount = 0,
  entities = {},
  metaRow = META_ROW,
  exportDump = '-- sql dump --'
} = {}) {
  const state = {
    createdDbName: null,
    executed: [],
    ledger: [],
    seedInserts: [],
    exported: false,
    // catalog_meta exists only once the schema has ever been applied.
    hasCatalogMeta: hadSchemaMigrations || lockHeldSince !== null,
    migratingSince: lockHeldSince,
    releaseCalls: 0
  };
  const client = {
    accountId: null,
    databaseId: null,
    async findDatabaseByName(name) {
      return existingDb && existingDb.name === name ? existingDb : null;
    },
    async createDatabase(name) {
      state.createdDbName = name;
      return { uuid: 'db-new', name };
    },
    async exportDatabase() {
      state.exported = true;
      return exportDump;
    },
    async exec(sql) {
      state.executed.push(sql);
      state.hasCatalogMeta = true; // applying 0001 creates catalog_meta
      return [{ success: true }];
    },
    async query(sql, params = []) {
      if (/FROM sqlite_master/.test(sql)) {
        return { results: hadSchemaMigrations ? [{ name: 'schema_migrations' }] : [], meta: {} };
      }
      if (/SET migrating_since = \?/.test(sql)) {
        if (!state.hasCatalogMeta) throw new Error('Cloudflare rechazó la petición: no such table: catalog_meta');
        const [lockTs, staleCutoff] = params;
        if (state.migratingSince === null || state.migratingSince < staleCutoff) {
          state.migratingSince = lockTs;
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 0 } };
      }
      if (/SET migrating_since = NULL WHERE migrating_since = \?/.test(sql)) {
        state.releaseCalls++;
        if (state.migratingSince === params[0]) state.migratingSince = null;
        return { results: [], meta: { changes: 1 } };
      }
      if (/SELECT id FROM schema_migrations/.test(sql)) {
        return { results: state.ledger.map((id) => ({ id })), meta: {} };
      }
      if (/INSERT INTO schema_migrations/.test(sql)) {
        state.ledger.push(params[0]);
        return { results: [], meta: { changes: 1 } };
      }
      if (/SELECT COUNT\(\*\) AS n FROM products/.test(sql)) {
        return { results: [{ n: productCount }], meta: {} };
      }
      if (/^INSERT OR IGNORE INTO /.test(sql)) {
        state.seedInserts.push({ sql, params });
        return { results: [], meta: { changes: 1 } };
      }
      if (/UPDATE catalog_meta SET catalog_version/.test(sql)) {
        return { results: [], meta: { changes: 1 } };
      }
      const table = (sql.match(/FROM (\w+)/) || [])[1];
      if (table === 'catalog_meta') return { results: metaRow ? [metaRow] : [], meta: {} };
      if (table) return { results: entities[table] || [], meta: {} };
      throw new Error('unexpected SQL in fake: ' + sql);
    }
  };
  return { client, state };
}

describe('provision', () => {
  const PAYLOAD = { token: 'tok-secret', accountId: 'acc-1', user: 'Alberto' };
  const fullEntities = disassemble(buildDefaultConfig());

  test('fresh account: creates the packprice base, migrates without backup, seeds', async () => {
    const { client, state } = provisionWorld();
    const { bootstrap, created } = makeBootstrap(client);
    const res = await bootstrap.provision(PAYLOAD);

    expect(res).toEqual({ ok: true, databaseId: 'db-new', seeded: true });
    expect(created).toEqual([{ token: 'tok-secret', accountId: 'acc-1' }]);
    expect(state.createdDbName).toBe('packprice');
    expect(client.databaseId).toBe('db-new');
    // Migration applied and recorded.
    expect(state.executed).toContain(MIGRATIONS[0].sql);
    expect(state.ledger).toEqual(['0001_init']);
    // Empty fresh base: no export, no backup file, but the seed ran.
    expect(state.exported).toBe(false);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(state.seedInserts.length).toBeGreaterThan(0);
    // Lock released at the end.
    expect(state.releaseCalls).toBe(1);
    expect(state.migratingSince).toBeNull();
  });

  test('existing populated base: backs up BEFORE migrating, verifies, does not reseed', async () => {
    const { client, state } = provisionWorld({
      existingDb: { uuid: 'db-9', name: 'packprice' },
      hadSchemaMigrations: true,
      productCount: 9,
      entities: fullEntities
    });
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.provision(PAYLOAD);

    expect(res).toEqual({ ok: true, databaseId: 'db-9', seeded: false });
    expect(state.createdDbName).toBeNull();
    // Pre-migration backup written to backupDir/pre-migration-<ISO>.sql.
    expect(state.exported).toBe(true);
    const backups = fs.readdirSync(backupDir);
    expect(backups).toEqual(['pre-migration-2026-06-12T10-00-00-000Z.sql']);
    expect(fs.readFileSync(path.join(backupDir, backups[0]), 'utf-8')).toBe('-- sql dump --');
    // Populated base is never reseeded.
    expect(state.seedInserts).toEqual([]);
    expect(state.releaseCalls).toBe(1);
    expect(state.migratingSince).toBeNull();
  });

  test('stamps user and app version into the migration ledger', async () => {
    const inserts = [];
    const { client } = provisionWorld();
    const original = client.query.bind(client);
    client.query = async (sql, params = []) => {
      if (/INSERT INTO schema_migrations/.test(sql)) inserts.push(params);
      return original(sql, params);
    };
    const { bootstrap } = makeBootstrap(client);
    await bootstrap.provision(PAYLOAD);
    expect(inserts).toEqual([['0001_init', NOW(), 'Alberto', '5.0.0-test']]);
  });

  test('lock busy: refuses with MIGRATION_LOCKED and touches nothing', async () => {
    const { client, state } = provisionWorld({
      existingDb: { uuid: 'db-9', name: 'packprice' },
      hadSchemaMigrations: true,
      lockHeldSince: '2026-06-12T09:58:00.000Z' // fresh foreign lock (2 min old)
    });
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.provision(PAYLOAD);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('MIGRATION_LOCKED');
    expect(res.error).toMatch(/migrando/i);
    expect(state.exported).toBe(false);
    expect(state.executed).toEqual([]);
    expect(state.migratingSince).toBe('2026-06-12T09:58:00.000Z'); // untouched
  });

  test('verify failure: MIGRATION_FAILED with backupPath, lock released in finally', async () => {
    // Populated base whose rows assemble into an invalid config →
    // post-migration verification must reject it.
    const { client, state } = provisionWorld({
      existingDb: { uuid: 'db-9', name: 'packprice' },
      hadSchemaMigrations: true,
      productCount: 9,
      entities: {} // every table empty → invalid catalog
    });
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.provision(PAYLOAD);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('MIGRATION_FAILED');
    expect(res.error).toMatch(/Config inválido/);
    expect(res.backupPath).toBe(path.join(backupDir, 'pre-migration-2026-06-12T10-00-00-000Z.sql'));
    expect(fs.existsSync(res.backupPath)).toBe(true);
    // The lock is never left behind.
    expect(state.releaseCalls).toBe(1);
    expect(state.migratingSince).toBeNull();
    // And a failed provision never seeds.
    expect(state.seedInserts).toEqual([]);
  });

  test('migration apply failure: MIGRATION_FAILED, lock still released', async () => {
    const { client, state } = provisionWorld({
      existingDb: { uuid: 'db-9', name: 'packprice' },
      hadSchemaMigrations: true
    });
    client.exec = async () => { throw new Error('No se pudo conectar con Cloudflare — comprueba la conexión a internet'); };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.provision(PAYLOAD);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('MIGRATION_FAILED');
    expect(state.releaseCalls).toBe(1);
  });

  test('a throw while releasing the lock does not mask the in-flight result', async () => {
    // Verify fails (MIGRATION_FAILED + backupPath) AND the lock
    // release throws in the finally: the original failure result must
    // survive — a finally throw can never replace it.
    const { client, state } = provisionWorld({
      existingDb: { uuid: 'db-9', name: 'packprice' },
      hadSchemaMigrations: true,
      productCount: 9,
      entities: {} // invalid catalog → verify rejects
    });
    const original = client.query.bind(client);
    client.query = async (sql, params = []) => {
      if (/SET migrating_since = NULL WHERE migrating_since = \?/.test(sql)) {
        state.releaseCalls++;
        throw new Error('Cloudflare rechazó la petición al liberar el cerrojo');
      }
      return original(sql, params);
    };
    const log = vi.fn();
    const { bootstrap } = makeBootstrap(client, { log });
    const res = await bootstrap.provision(PAYLOAD);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('MIGRATION_FAILED');
    expect(res.backupPath).toBe(path.join(backupDir, 'pre-migration-2026-06-12T10-00-00-000Z.sql'));
    // The release was attempted, its throw was caught and logged.
    expect(state.releaseCalls).toBe(1);
    expect(log).toHaveBeenCalled();
  });

  test('unexpected failure outside the lock: plain { ok: false, error }', async () => {
    const client = {
      async findDatabaseByName() { throw new Error('Cloudflare rechazó la petición: Invalid API Token'); }
    };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.provision(PAYLOAD);
    expect(res.ok).toBe(false);
    expect(res.code).toBeUndefined();
    expect(res.error).toMatch(/Cloudflare rechazó/);
  });
});

// ------------------------------------------------------------
// saveCatalog — guarded per-entity write + cache refresh
// ------------------------------------------------------------
// A combined fake: serves loadEntities (the authoritative baseline +
// version map) AND the writeEntities guarded-write traffic. Per-id main
// rows carry a `version` column (db/migrations/0001_init.sql) so the
// version derivation and the UPDATE guards have something real to bite.
function fakeSaveClient({ staleIds = new Set(), serverRows = {}, metaRow = META_ROW } = {}) {
  // The live catalog rows: disassemble output with a version stamped onto
  // every per-id main row (children/globals have no version column).
  const entities = disassemble(buildDefaultConfig());
  for (const table of ['packs', 'products', 'suppliers', 'addons']) {
    entities[table] = entities[table].map((r) => ({ ...r, version: 1 }));
  }
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // --- writeEntities guarded UPDATE of a per-id main row ---
      if (/^UPDATE (\w+) SET version = version \+ 1/.test(sql)) {
        const id = params[params.length - 2];
        return { results: [], meta: { changes: staleIds.has(id) ? 0 : 1 } };
      }
      // Live re-read of catalog_meta for the globals guard.
      if (/^SELECT catalog_version FROM catalog_meta/.test(sql)) {
        return { results: [{ catalog_version: metaRow.catalog_version }], meta: {} };
      }
      // Create-collision existence check.
      const exists = sql.match(/^SELECT (\w+) FROM (\w+) WHERE \w+ = \?$/);
      if (exists) return { results: [], meta: {} };
      // Read the current server row of a conflicted entity.
      if (/^SELECT \* FROM (\w+) WHERE id = \?/.test(sql)) {
        const table = sql.match(/FROM (\w+)/)[1];
        const row = (serverRows[table] || {})[params[0]] || null;
        return { results: row ? [row] : [], meta: {} };
      }
      // --- loadEntities reads ---
      const table = (sql.match(/FROM (\w+)/) || [])[1];
      if (table === 'catalog_meta') return { results: [metaRow], meta: {} };
      if (table && entities[table] !== undefined) return { results: entities[table], meta: {} };
      // Everything else: DELETE/INSERT children, audit, snapshot, bump.
      return { results: [], meta: { changes: 1 } };
    }
  };
}

describe('saveCatalog', () => {
  // The version map the renderer echoes back: every per-id entity at 1,
  // the catalog counter matching the loaded baseline (META_ROW = 7).
  function rendererVersions() {
    const cfg = buildDefaultConfig();
    const v = { catalogVersion: 7, pack: {}, product: {}, supplier: {}, addon: {} };
    for (const id of Object.keys(cfg.packs)) v.pack[id] = 1;
    for (const id of Object.keys(cfg.products)) v.product[id] = 1;
    for (const id of Object.keys(cfg.suppliers)) v.supplier[id] = 1;
    for (const id of Object.keys(cfg.addons)) v.addon[id] = 1;
    return v;
  }

  function editedCfg(mutate) {
    const cfg = buildDefaultConfig();
    delete cfg.admin;
    mutate(cfg);
    return cfg;
  }

  test('happy path: writes the entity, bumps the version and refreshes the cache', async () => {
    const client = fakeSaveClient();
    const { bootstrap, created } = makeBootstrap(client);
    const newCfg = editedCfg((c) => { c.products.BEAGLE.name = 'Camiseta editada'; });

    const res = await bootstrap.saveCatalog(SETTINGS, {
      newCfg, expectedVersions: rendererVersions(), user: 'Alberto'
    });

    expect(res.ok).toBe(true);
    expect(res.catalogVersion).toBe(8); // 7 → 8
    expect(res.conflicts).toEqual([]);
    expect(res.results).toContainEqual({ entityType: 'product', id: 'BEAGLE', status: 'written' });
    // Built from settings.cloud only — never anything else.
    expect(created).toEqual([{ token: 'tok-secret', accountId: 'acc-1', databaseId: 'db-1' }]);

    // Cache refreshed with the saved catalog at the new version, the edit
    // present, and the bumped per-entity version (1 → 2) for BEAGLE.
    const cached = readCache(cachePath);
    expect(cached.catalogVersion).toBe(8);
    expect(cached.versions.catalogVersion).toBe(8);
    expect(cached.versions.product.BEAGLE).toBe(2);
    expect(cached.entities.products.find((p) => p.id === 'BEAGLE').name).toBe('Camiseta editada');
  });

  test('conflict path: returns the conflict and does NOT refresh the cache', async () => {
    // Seed a known-good cache so we can prove it is left untouched.
    const priorCache = { fetchedAt: '2026-06-10T08:00:00.000Z', catalogVersion: 7, entities: { products: [] } };
    writeCache(cachePath, priorCache);

    const serverRow = { id: 'BEAGLE', name: 'Editado por otro PC', version: 5 };
    const client = fakeSaveClient({ staleIds: new Set(['BEAGLE']), serverRows: { products: { BEAGLE: serverRow } } });
    const { bootstrap } = makeBootstrap(client);
    const newCfg = editedCfg((c) => { c.products.BEAGLE.name = 'Mi edición'; });

    const res = await bootstrap.saveCatalog(SETTINGS, {
      newCfg, expectedVersions: rendererVersions(), user: 'Alberto'
    });

    expect(res.ok).toBe(false);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toMatchObject({ entityType: 'product', id: 'BEAGLE', serverRow });
    expect(res.catalogVersion).toBe(7); // unchanged
    // The cache is exactly the prior one — a conflicted save never touches it.
    expect(readCache(cachePath)).toEqual(priorCache);
  });

  test('missing expectedVersions: derives them from the live load (no conflict possible)', async () => {
    const client = fakeSaveClient();
    const { bootstrap } = makeBootstrap(client);
    const newCfg = editedCfg((c) => { c.products.BEAGLE.name = 'Camiseta editada'; });

    const res = await bootstrap.saveCatalog(SETTINGS, { newCfg, user: 'Alberto' });

    expect(res.ok).toBe(true);
    // The guard UPDATE used the version derived from the live rows (1).
    const guard = client.queries.find((q) => /^UPDATE products SET version = version \+ 1/.test(q.sql));
    expect(guard.params).toEqual([NOW(), 'BEAGLE', 1]);
    expect(res.results).toContainEqual({ entityType: 'product', id: 'BEAGLE', status: 'written' });
  });

  test('the baseline diff is the live cloud catalog, not a renderer-supplied oldCfg', async () => {
    // saveCatalog takes only newCfg; it must re-load the baseline itself.
    const client = fakeSaveClient();
    const { bootstrap } = makeBootstrap(client);
    const newCfg = editedCfg((c) => { c.products.BEAGLE.name = 'Camiseta editada'; });
    await bootstrap.saveCatalog(SETTINGS, { newCfg, expectedVersions: rendererVersions(), user: 'Alberto' });
    // It read catalog_meta + the entity tables (loadEntities) before writing.
    expect(client.queries.some((q) => /SELECT \* FROM catalog_meta/.test(q.sql))).toBe(true);
    expect(client.queries.some((q) => /SELECT \* FROM products/.test(q.sql))).toBe(true);
  });

  test('never leaks the token in the returned shape', async () => {
    const client = fakeSaveClient();
    const { bootstrap } = makeBootstrap(client);
    const newCfg = editedCfg((c) => { c.products.BEAGLE.name = 'Camiseta editada'; });
    const res = await bootstrap.saveCatalog(SETTINGS, { newCfg, expectedVersions: rendererVersions(), user: 'Alberto' });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('tok-secret');
    expect(serialized).not.toContain('acc-1');
  });

  test('a removed entity drops out of the refreshed cache version map', async () => {
    const client = fakeSaveClient();
    const { bootstrap } = makeBootstrap(client);
    const newCfg = editedCfg((c) => { delete c.products.URBAN; });
    const res = await bootstrap.saveCatalog(SETTINGS, {
      newCfg, expectedVersions: rendererVersions(), user: 'Alberto'
    });
    expect(res.ok).toBe(true);
    expect(res.results).toContainEqual({ entityType: 'product', id: 'URBAN', status: 'deleted' });
    expect(readCache(cachePath).versions.product.URBAN).toBeUndefined();
  });
});
