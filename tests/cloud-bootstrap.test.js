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
import { D1ClientError } from '../lib/d1-client.js';

const NOW = () => '2026-06-12T10:00:00.000Z';

// A real transport-failure error, as lib/d1-client.js produces when fetch
// itself rejects (offline/DNS/TLS): carries the structural network:true
// flag the outbox enqueue keys off — NOT a text match.
function networkError(message = 'No se pudo conectar con Cloudflare — comprueba la conexión a internet') {
  return new D1ClientError(message, { network: true });
}

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
    userDataDir: tmpDir,
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

// ------------------------------------------------------------
// getAudit / getSnapshots — cloud history read surface
// ------------------------------------------------------------
describe('getAudit', () => {
  const AUDIT_ROWS = [
    { id: 2, ts: 't2', user: 'Ana', entity_type: 'product', entity_id: 'BEAGLE', action: 'update', diff_json: '[]', catalog_version: 8 },
    { id: 1, ts: 't1', user: 'Beto', entity_type: 'supplier', entity_id: 'ROLY', action: 'create', diff_json: '[]', catalog_version: 7 }
  ];

  test('builds the client from settings.cloud and returns mapped entries', async () => {
    const seen = [];
    const client = {
      async query(sql, params) { seen.push({ sql, params }); return { results: AUDIT_ROWS, meta: {} }; }
    };
    const { bootstrap, created } = makeBootstrap(client);
    const entries = await bootstrap.getAudit(SETTINGS, { limit: 2, offset: 0 });
    expect(created).toEqual([{ token: 'tok-secret', accountId: 'acc-1', databaseId: 'db-1' }]);
    expect(seen[0].params).toEqual([2, 0]);
    expect(entries).toEqual([
      { id: 2, ts: 't2', user: 'Ana', entityType: 'product', entityId: 'BEAGLE', action: 'update', diff: [], catalogVersion: 8 },
      { id: 1, ts: 't1', user: 'Beto', entityType: 'supplier', entityId: 'ROLY', action: 'create', diff: [], catalogVersion: 7 }
    ]);
  });

  test('passes settings into clientFromSettings (token never leaks in the result)', async () => {
    const client = { async query() { return { results: AUDIT_ROWS, meta: {} }; } };
    const { bootstrap } = makeBootstrap(client);
    const entries = await bootstrap.getAudit(SETTINGS, {});
    expect(JSON.stringify(entries)).not.toContain('tok-secret');
  });
});

describe('getSnapshots', () => {
  test('returns the snapshot list newest-first from settings.cloud', async () => {
    const rows = [
      { catalog_version: 8, ts: 't8' },
      { catalog_version: 7, ts: 't7' }
    ];
    const client = { async query() { return { results: rows, meta: {} }; } };
    const { bootstrap, created } = makeBootstrap(client);
    const list = await bootstrap.getSnapshots(SETTINGS);
    expect(created).toEqual([{ token: 'tok-secret', accountId: 'acc-1', databaseId: 'db-1' }]);
    expect(list).toEqual([
      { catalogVersion: 8, ts: 't8' },
      { catalogVersion: 7, ts: 't7' }
    ]);
  });
});

// ------------------------------------------------------------
// restore — forward-only rollback + cache refresh
// ------------------------------------------------------------
// A fake D1 world that serves getSnapshot, loadEntities (live rows +
// versions), the writeEntities guarded-write traffic AND a final
// loadEntities re-fetch (the cache refresh after a clean restore).
function fakeRestoreWorld({ snapshotCfg, liveCfg, metaRow = META_ROW } = {}) {
  const live = disassemble(liveCfg);
  for (const table of ['packs', 'products', 'suppliers', 'addons']) {
    live[table] = live[table].map((r) => ({ ...r, version: 3 }));
  }
  const snapshotJson = JSON.stringify({ ...snapshotCfg, catalog_version: 3 });
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/FROM snapshots WHERE catalog_version = \?/.test(sql)) {
        return { results: [{ catalog_version: params[0], ts: 't-snap', json: snapshotJson }], meta: {} };
      }
      if (/^UPDATE (\w+) SET version = version \+ 1/.test(sql)) {
        return { results: [], meta: { changes: 1 } };
      }
      if (/^SELECT catalog_version FROM catalog_meta/.test(sql)) {
        return { results: [{ catalog_version: metaRow.catalog_version }], meta: {} };
      }
      const exists = sql.match(/^SELECT (\w+) FROM (\w+) WHERE \w+ = \?$/);
      if (exists) return { results: [], meta: {} };
      const table = (sql.match(/FROM (\w+)/) || [])[1];
      if (table === 'catalog_meta') return { results: [metaRow], meta: {} };
      if (table && live[table] !== undefined) return { results: live[table], meta: {} };
      return { results: [], meta: { changes: 1 } };
    }
  };
}

describe('restore', () => {
  test('restores the snapshot, returns the new version and refreshes the cache', async () => {
    const snapshotCfg = (() => { const c = buildDefaultConfig(); delete c.admin; return c; })();
    const liveCfg = (() => { const c = buildDefaultConfig(); delete c.admin; c.products.BEAGLE.name = 'Editado'; return c; })();
    const client = fakeRestoreWorld({ snapshotCfg, liveCfg });
    const { bootstrap, created } = makeBootstrap(client);

    const res = await bootstrap.restore(SETTINGS, { version: 3 });

    expect(res.ok).toBe(true);
    expect(res.catalogVersion).toBe(8); // live 7 → 8 (forward-only)
    // Client built from settings.cloud only — never anything else.
    expect(created[0]).toEqual({ token: 'tok-secret', accountId: 'acc-1', databaseId: 'db-1' });
    // The restore went through writeEntities (audited + snapshotted).
    expect(client.queries.some((q) => /^INSERT INTO audit_log/.test(q.sql))).toBe(true);
    expect(client.queries.some((q) => /^INSERT INTO snapshots/.test(q.sql))).toBe(true);
    // The cache was refreshed with the restored catalog.
    const cached = readCache(cachePath);
    expect(cached).toBeTruthy();
    expect(cached.catalogVersion).toBeTypeOf('number');
  });

  test('uses the configured author (cloud user_name) for the restore', async () => {
    const snapshotCfg = (() => { const c = buildDefaultConfig(); delete c.admin; return c; })();
    const liveCfg = (() => { const c = buildDefaultConfig(); delete c.admin; c.products.BEAGLE.name = 'Editado'; return c; })();
    const client = fakeRestoreWorld({ snapshotCfg, liveCfg });
    const { bootstrap } = makeBootstrap(client);

    await bootstrap.restore(SETTINGS, { version: 3 });
    const audit = client.queries.find((q) => /^INSERT INTO audit_log/.test(q.sql));
    expect(audit.params).toContain('Alberto'); // SETTINGS.cloud.user_name
  });

  test('never leaks the token in the returned shape', async () => {
    const snapshotCfg = (() => { const c = buildDefaultConfig(); delete c.admin; return c; })();
    const liveCfg = (() => { const c = buildDefaultConfig(); delete c.admin; c.products.BEAGLE.name = 'Editado'; return c; })();
    const client = fakeRestoreWorld({ snapshotCfg, liveCfg });
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.restore(SETTINGS, { version: 3 });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('tok-secret');
    expect(serialized).not.toContain('acc-1');
  });

  test('a missing version rejects with the Spanish error', async () => {
    const client = {
      async query(sql) {
        if (/FROM snapshots WHERE catalog_version = \?/.test(sql)) return { results: [], meta: {} };
        return { results: [], meta: {} };
      }
    };
    const { bootstrap } = makeBootstrap(client);
    await expect(bootstrap.restore(SETTINGS, { version: 999 })).rejects.toThrow(/versión/i);
  });
});

// ------------------------------------------------------------
// saveQuote / setQuoteStatus — upload with offline enqueue
// ------------------------------------------------------------
import { readOutbox } from '../lib/quote-outbox.js';

const SAMPLE_QUOTE = {
  id: 'uuid-1', ts: NOW(), user: 'Alberto',
  customer: { name: 'Peña', phone: '600' }, valid_until: 'v',
  pack_id: 'crew_full', tier: 'T1', total_units: 24,
  total_vat_inc: 600, sale_base: 500, margin_pct: 0.4, target_margin: 0.35,
  catalog_version: 7,
  items: [{ product_id: 'BEAGLE', sides: 'two_sides', qty: 24 }],
  addons: [{ addon_id: 'name', qty: 24 }]
};

describe('saveQuote', () => {
  test('uploads the quote (idempotent INSERT OR IGNORE) and never queues on success', async () => {
    const calls = [];
    const client = { async query(sql, params) { calls.push({ sql, params }); return { results: [], meta: { changes: 1 } }; } };
    const { bootstrap, created } = makeBootstrap(client);
    const res = await bootstrap.saveQuote(SETTINGS, { quote: SAMPLE_QUOTE });

    expect(res).toEqual({ ok: true, id: 'uuid-1' });
    expect(created).toEqual([{ token: 'tok-secret', accountId: 'acc-1', databaseId: 'db-1' }]);
    expect(calls.some((c) => /INSERT OR IGNORE INTO quotes/.test(c.sql))).toBe(true);
    expect(readOutbox(tmpDir)).toEqual({ quotes: [], statuses: [] });
  });

  test('on a network failure the quote is enqueued and { ok:true, queued:true } returned', async () => {
    const client = { async query() { throw networkError(); } };
    const log = vi.fn();
    const { bootstrap } = makeBootstrap(client, { log });
    const res = await bootstrap.saveQuote(SETTINGS, { quote: SAMPLE_QUOTE });

    expect(res).toEqual({ ok: true, queued: true, id: 'uuid-1' });
    expect(readOutbox(tmpDir).quotes.map((q) => q.id)).toEqual(['uuid-1']);
    expect(log).toHaveBeenCalled();
  });

  test('a server-rejected (network:false) quote is surfaced as a failure and NEVER queued', async () => {
    // A malformed/constraint-violating quote: the server answered and
    // rejected it (D1ClientError with network:false). Enqueuing it would
    // poison the outbox — it would be retried forever on every sync. It
    // must instead surface as { ok:false } and leave the outbox empty.
    const client = {
      async query() {
        throw new D1ClientError('Cloudflare rechazó la petición: NOT NULL constraint failed', { status: 400, network: false });
      }
    };
    const log = vi.fn();
    const { bootstrap } = makeBootstrap(client, { log });
    const res = await bootstrap.saveQuote(SETTINGS, { quote: SAMPLE_QUOTE });

    expect(res.ok).toBe(false);
    expect(res.id).toBe('uuid-1');
    expect(res.error).toMatch(/Cloudflare rechazó/);
    expect(res.queued).toBeUndefined();
    expect(readOutbox(tmpDir)).toEqual({ quotes: [], statuses: [] });
    expect(log).toHaveBeenCalled();
  });

  test('a locally-validated malformed quote is surfaced as a failure and NEVER queued', async () => {
    // Defense-in-depth: uploadQuote rejects a row missing required NOT NULL
    // fields BEFORE any network call (non-network error). It must not queue.
    const client = { async query() { throw networkError('should not be reached'); } };
    const log = vi.fn();
    const { bootstrap } = makeBootstrap(client, { log });
    const badQuote = { ...SAMPLE_QUOTE, pack_id: undefined };
    const res = await bootstrap.saveQuote(SETTINGS, { quote: badQuote });

    expect(res.ok).toBe(false);
    expect(res.queued).toBeUndefined();
    expect(res.error).toMatch(/presupuesto/i);
    expect(readOutbox(tmpDir)).toEqual({ quotes: [], statuses: [] });
  });

  test('never leaks the token in the returned shape', async () => {
    const client = { async query() { throw networkError(); } };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.saveQuote(SETTINGS, { quote: SAMPLE_QUOTE });
    expect(JSON.stringify(res)).not.toContain('tok-secret');
  });
});

describe('setQuoteStatus', () => {
  test('uploads the status (UPDATE) on success', async () => {
    const calls = [];
    const client = { async query(sql, params) { calls.push({ sql, params }); return { results: [], meta: { changes: 1 } }; } };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.setQuoteStatus(SETTINGS, { id: 'uuid-1', status: 'accepted' });

    expect(res).toEqual({ ok: true, id: 'uuid-1', status: 'accepted' });
    const upd = calls.find((c) => /UPDATE quotes SET status/.test(c.sql));
    expect(upd).toBeTruthy();
    expect(upd.params).toEqual(['accepted', NOW(), 'uuid-1']);
    expect(readOutbox(tmpDir)).toEqual({ quotes: [], statuses: [] });
  });

  test('rejects an invalid status without touching the network (Spanish error)', async () => {
    const client = { async query() { throw new Error('should not be called'); } };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.setQuoteStatus(SETTINGS, { id: 'uuid-1', status: 'maybe' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/estado/i);
    // An invalid status is a client bug, not an outage → not queued.
    expect(readOutbox(tmpDir)).toEqual({ quotes: [], statuses: [] });
  });

  test('on a network failure the status is enqueued and { ok:true, queued:true } returned', async () => {
    const client = { async query() { throw networkError(); } };
    const { bootstrap } = makeBootstrap(client, { log: vi.fn() });
    const res = await bootstrap.setQuoteStatus(SETTINGS, { id: 'uuid-1', status: 'rejected' });

    expect(res).toEqual({ ok: true, queued: true, id: 'uuid-1', status: 'rejected' });
    expect(readOutbox(tmpDir).statuses).toEqual([{ id: 'uuid-1', status: 'rejected', ts: NOW() }]);
  });

  test('a server-rejected (network:false) status is surfaced as a failure and NEVER queued', async () => {
    const client = {
      async query() {
        throw new D1ClientError('Cloudflare rechazó la petición: no such quote', { status: 400, network: false });
      }
    };
    const { bootstrap } = makeBootstrap(client, { log: vi.fn() });
    const res = await bootstrap.setQuoteStatus(SETTINGS, { id: 'uuid-1', status: 'rejected' });

    expect(res.ok).toBe(false);
    expect(res.queued).toBeUndefined();
    expect(readOutbox(tmpDir)).toEqual({ quotes: [], statuses: [] });
  });
});

// ------------------------------------------------------------
// getStats — fetch raw rows then compute (main returns COMPUTED stats)
// ------------------------------------------------------------
describe('getStats', () => {
  const entities = disassemble(buildDefaultConfig());

  function statsClient() {
    return {
      async query(sql) {
        if (/FROM quotes/.test(sql)) {
          return { results: [{
            id: 'q1', ts: '2026-06-08T10:00:00.000Z', pack_id: 'crew_full', tier: 'T1',
            total_units: 24, qty_3xl: 0, qty_4xl: 0, qty_5xl: 0,
            total_vat_inc: 600, sale_base: 500, margin_pct: 0.4, target_margin: 0.35,
            pvp_deviation_pct: null, status: 'accepted'
          }], meta: {} };
        }
        if (/FROM quote_items/.test(sql)) return { results: [{ quote_id: 'q1', product_id: 'BEAGLE', sides: 'two_sides', qty: 24 }], meta: {} };
        if (/FROM quote_addons/.test(sql)) return { results: [], meta: {} };
        // loadEntities for the cfg used to resolve names
        const table = (sql.match(/FROM (\w+)/) || [])[1];
        if (table === 'catalog_meta') return { results: [META_ROW], meta: {} };
        return { results: entities[table] || [], meta: {} };
      }
    };
  }

  test('returns a COMPUTED stats object (not raw rows), names resolved from the loaded cfg', async () => {
    const { bootstrap, created } = makeBootstrap(statsClient());
    const res = await bootstrap.getStats(SETTINGS, { from: '2026-06-01', to: '2026-06-30' });

    expect(res.ok).toBe(true);
    expect(res.stats.totalQuoted).toBe(600);
    expect(res.stats.totalAccepted).toBe(600);
    expect(res.stats.conversionPct).toBe(1);
    // Name resolved from the loaded catalog, not the id.
    expect(res.stats.byPack[0].name).toBe(buildDefaultConfig().packs.crew_full.name);
    expect(res.stats.topProducts[0].name).toBe(buildDefaultConfig().products.BEAGLE.name);
    expect(created).toEqual([{ token: 'tok-secret', accountId: 'acc-1', databaseId: 'db-1' }]);
  });

  test('offline: { ok:false, offline:true } with the cause', async () => {
    const client = { async query() { throw new Error('No se pudo conectar con Cloudflare'); } };
    const { bootstrap } = makeBootstrap(client, { log: vi.fn() });
    const res = await bootstrap.getStats(SETTINGS, { from: 'a', to: 'b' });
    expect(res.ok).toBe(false);
    expect(res.offline).toBe(true);
    expect(res.error).toMatch(/No se pudo conectar/);
  });

  test('never leaks the token', async () => {
    const { bootstrap } = makeBootstrap(statsClient());
    const res = await bootstrap.getStats(SETTINGS, { from: '2026-06-01', to: '2026-06-30' });
    expect(JSON.stringify(res)).not.toContain('tok-secret');
  });
});

// ------------------------------------------------------------
// loadCatalog / refreshCatalog flush the outbox (best-effort)
// ------------------------------------------------------------
describe('outbox flush on sync', () => {
  const entities = disassemble(buildDefaultConfig());

  test('loadCatalog drains a queued quote on a successful cloud load', async () => {
    // Queue a quote while "offline".
    fs.mkdirSync(path.join(tmpDir, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'cache', 'outbox.json'),
      JSON.stringify({ quotes: [SAMPLE_QUOTE], statuses: [] }), 'utf-8'
    );
    const uploads = [];
    const client = {
      async query(sql, params) {
        if (/INSERT OR IGNORE INTO quotes/.test(sql)) uploads.push(params);
        const table = (sql.match(/FROM (\w+)/) || [])[1];
        if (table === 'catalog_meta') return { results: [META_ROW], meta: {} };
        if (table) return { results: entities[table] || [], meta: {} };
        return { results: [], meta: { changes: 1 } };
      }
    };
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.loadCatalog(SETTINGS);
    expect(res.ok).toBe(true);
    expect(res.source).toBe('cloud');
    // The queued quote was uploaded and the outbox drained.
    expect(uploads.length).toBe(1);
    expect(readOutbox(tmpDir)).toEqual({ quotes: [], statuses: [] });
  });

  test('a flush failure never breaks the catalog load (best-effort, logged)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'cache', 'outbox.json'),
      JSON.stringify({ quotes: [SAMPLE_QUOTE], statuses: [] }), 'utf-8'
    );
    // Cloud load succeeds, but the quote INSERT throws → flush keeps it.
    const client = {
      async query(sql) {
        if (/INSERT OR IGNORE INTO quotes/.test(sql)) throw new Error('insert blew up');
        const table = (sql.match(/FROM (\w+)/) || [])[1];
        if (table === 'catalog_meta') return { results: [META_ROW], meta: {} };
        if (table) return { results: entities[table] || [], meta: {} };
        return { results: [], meta: { changes: 1 } };
      }
    };
    const { bootstrap } = makeBootstrap(client, { log: vi.fn() });
    const res = await bootstrap.loadCatalog(SETTINGS);
    expect(res.ok).toBe(true); // load still succeeds
    // The failed quote stays queued for the next flush.
    expect(readOutbox(tmpDir).quotes.map((q) => q.id)).toEqual(['uuid-1']);
  });
});

// ------------------------------------------------------------
// savePdfTemplate (Task 6B) — sanitize, slug + dedup, persist
// ------------------------------------------------------------
describe('savePdfTemplate', () => {
  // A client whose query() returns the seeded list on SELECT and records
  // the INSERT call for assertions. `existing` is the visible (non-archived)
  // gallery list (id+name); `allIds` is EVERY row id including archived ones
  // — the dedup keys off the latter so a reused slug can't hit the PK.
  function tplClient(existing = [], allIds = null) {
    const calls = [];
    const ids = allIds || existing.map((t) => t.id);
    const client = {
      query: vi.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT id, name FROM pdf_templates/.test(sql)) {
          return { results: existing };
        }
        // listAllPdfTemplateIds: every id, archived included.
        if (/SELECT id FROM pdf_templates/.test(sql)) {
          return { results: ids.map((id) => ({ id })) };
        }
        return { results: [] };
      })
    };
    return { client, calls };
  }

  test('sanitizes, derives a slug id and inserts (happy path)', async () => {
    const { client, calls } = tplClient([]);
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.savePdfTemplate(SETTINGS, {
      name: 'Mi Plantilla Bonita',
      html: '<!doctype html><html><body><style>p{color:#111}</style><p>{{quote.id}}</p></body></html>'
    });
    expect(res.ok).toBe(true);
    expect(res.id).toBe('mi-plantilla-bonita');
    const insert = calls.find((c) => /INSERT INTO pdf_templates/.test(c.sql));
    expect(insert).toBeTruthy();
    expect(insert.params[0]).toBe('mi-plantilla-bonita');
    expect(insert.params[1]).toBe('Mi Plantilla Bonita');
  });

  test('rejects a template with a <script> (sanitizer message, not stored)', async () => {
    const { client, calls } = tplClient([]);
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.savePdfTemplate(SETTINGS, {
      name: 'Maliciosa',
      html: '<html><body><script>alert(1)</script></body></html>'
    });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(0);
    // Nothing was inserted.
    expect(calls.some((c) => /INSERT INTO pdf_templates/.test(c.sql))).toBe(false);
  });

  test('dedups the slug id against existing templates', async () => {
    const { client, calls } = tplClient([{ id: 'mi-plantilla', name: 'Mi plantilla' }]);
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.savePdfTemplate(SETTINGS, {
      name: 'Mi plantilla',
      html: '<html><body><p>{{quote.id}}</p></body></html>'
    });
    expect(res.ok).toBe(true);
    expect(res.id).toBe('mi-plantilla-2');
    const insert = calls.find((c) => /INSERT INTO pdf_templates/.test(c.sql));
    expect(insert.params[0]).toBe('mi-plantilla-2');
  });

  test('rejects an empty name or empty html before touching the network', async () => {
    const { client, calls } = tplClient([]);
    const { bootstrap } = makeBootstrap(client);
    expect((await bootstrap.savePdfTemplate(SETTINGS, { name: '  ', html: '<p>x</p>' })).ok).toBe(false);
    expect((await bootstrap.savePdfTemplate(SETTINGS, { name: 'X', html: '   ' })).ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  // --- Hardening: bound the input so a multi-MB paste can't balloon the
  //     D1 row (re-fetched + sanitized on every export/preview, every PC).
  test('rejects an overlong name (> 80 chars) before sanitize/insert', async () => {
    const { client, calls } = tplClient([]);
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.savePdfTemplate(SETTINGS, {
      name: 'x'.repeat(81),
      html: '<html><body><p>{{quote.id}}</p></body></html>'
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nombre.*demasiado largo/i);
    // No network touched: rejected before any SELECT/INSERT.
    expect(calls.length).toBe(0);
  });

  test('rejects oversize html (> 256 KB) before sanitize/insert', async () => {
    const { client, calls } = tplClient([]);
    const { bootstrap } = makeBootstrap(client);
    // 256 KB + a wrapper → comfortably over the cap.
    const huge = '<html><body><p>' + 'a'.repeat(256 * 1024) + '</p></body></html>';
    const res = await bootstrap.savePdfTemplate(SETTINGS, { name: 'Grande', html: huge });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/demasiado grande/i);
    expect(calls.length).toBe(0);
  });

  test('accepts a name and html right at the limits', async () => {
    const { client } = tplClient([]);
    const { bootstrap } = makeBootstrap(client);
    // Name exactly 80 chars; html just under 256 KB after the wrapper.
    const name = 'x'.repeat(80);
    const body = 'a'.repeat(256 * 1024 - 64); // wrapper + body < 256 KB
    const html = '<html><body><p>' + body + '</p></body></html>';
    expect(Buffer.byteLength(html, 'utf-8')).toBeLessThanOrEqual(256 * 1024);
    const res = await bootstrap.savePdfTemplate(SETTINGS, { name, html });
    expect(res.ok).toBe(true);
  });

  // --- Hardening: dedup against ALL ids (archived included), so re-creating
  //     a template whose slug matches a soft-deleted row gets a suffix, not a
  //     PRIMARY KEY collision masked by a misleading generic error.
  test('a slug colliding with an ARCHIVED id gets a -2 suffix (no PK failure)', async () => {
    // The gallery (non-archived) is empty, but an archived row owns the slug.
    const { client, calls } = tplClient([], ['mi-plantilla']);
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.savePdfTemplate(SETTINGS, {
      name: 'Mi plantilla',
      html: '<html><body><p>{{quote.id}}</p></body></html>'
    });
    expect(res.ok).toBe(true);
    expect(res.id).toBe('mi-plantilla-2');
    const insert = calls.find((c) => /INSERT INTO pdf_templates/.test(c.sql));
    expect(insert.params[0]).toBe('mi-plantilla-2');
  });
});
