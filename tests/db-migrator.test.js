// ============================================================
// Tests · lib/db-migrator.js
// ============================================================
import { describe, test, expect } from 'vitest';
import { applyMigrations, acquireMigrationLock, releaseMigrationLock } from '../lib/db-migrator.js';

function fakeClient(appliedIds = []) {
  const executed = [];
  const inserts = [];
  const rows = appliedIds.map((id) => ({ id }));
  return {
    executed,
    inserts,
    async exec(sql) { executed.push(sql); return [{ success: true }]; },
    async query(sql, params = []) {
      executed.push(sql);
      if (/SELECT id FROM schema_migrations/.test(sql)) return { results: rows, meta: {} };
      if (/INSERT INTO schema_migrations/.test(sql)) { inserts.push(params); rows.push({ id: params[0] }); return { results: [], meta: { changes: 1 } }; }
      return { results: [], meta: {} };
    }
  };
}

const MIGRATIONS = [
  { id: '0001_init', sql: 'CREATE TABLE IF NOT EXISTS a (x);' },
  { id: '0002_more', sql: 'CREATE TABLE IF NOT EXISTS b (y);' }
];
const OPTS = { user: 'PC-Test', appVersion: '5.0.0-beta', now: () => '2026-06-12T10:00:00Z' };

describe('applyMigrations', () => {
  test('applies all pending migrations in order and records them', async () => {
    const client = fakeClient([]);
    const done = await applyMigrations(client, MIGRATIONS, OPTS);
    expect(done).toEqual(['0001_init', '0002_more']);
    const creates = client.executed.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS a') || s.startsWith('CREATE TABLE IF NOT EXISTS b'));
    expect(creates).toHaveLength(2);
  });

  test('is idempotent: a second run applies nothing', async () => {
    const client = fakeClient(['0001_init', '0002_more']);
    const done = await applyMigrations(client, MIGRATIONS, OPTS);
    expect(done).toEqual([]);
  });

  test('applies only the missing tail', async () => {
    const client = fakeClient(['0001_init']);
    const done = await applyMigrations(client, MIGRATIONS, OPTS);
    expect(done).toEqual(['0002_more']);
  });

  test('records user, app version and timestamp with each row', async () => {
    const client = fakeClient([]);
    await applyMigrations(client, [MIGRATIONS[0]], OPTS);
    expect(client.inserts).toEqual([
      ['0001_init', '2026-06-12T10:00:00Z', 'PC-Test', '5.0.0-beta']
    ]);
  });

  test('mid-failure: error propagates, applied prefix stays recorded, resume applies only the tail', async () => {
    const client = fakeClient([]);
    const realExec = client.exec.bind(client);
    let broken = true;
    client.exec = async (sql) => {
      if (broken && sql === MIGRATIONS[1].sql) throw new Error('D1 exec failed');
      return realExec(sql);
    };
    await expect(applyMigrations(client, MIGRATIONS, OPTS)).rejects.toThrow('D1 exec failed');
    // 0001 made it into the ledger before the crash…
    expect(client.inserts.map((p) => p[0])).toEqual(['0001_init']);
    // …so the next run (exec fixed) applies only 0002.
    broken = false;
    const done = await applyMigrations(client, MIGRATIONS, OPTS);
    expect(done).toEqual(['0002_more']);
  });

  test('re-executes a migration when the ledger insert crashed after exec', async () => {
    const client = fakeClient([]);
    const realQuery = client.query.bind(client);
    let broken = true;
    client.query = async (sql, params = []) => {
      if (broken && /INSERT INTO schema_migrations/.test(sql) && params[0] === '0001_init') {
        broken = false;
        client.executed.push(sql);
        throw new Error('D1 insert failed');
      }
      return realQuery(sql, params);
    };
    // First run: 0001's SQL ran, but the ledger insert crashed right after.
    await expect(applyMigrations(client, [MIGRATIONS[0]], OPTS)).rejects.toThrow('D1 insert failed');
    expect(client.executed.filter((s) => s === MIGRATIONS[0].sql)).toHaveLength(1);
    expect(client.inserts).toEqual([]);
    // Second run: the ledger has no record of 0001, so its file is re-executed —
    // this is why every migration must be internally idempotent.
    const done = await applyMigrations(client, [MIGRATIONS[0]], OPTS);
    expect(done).toEqual(['0001_init']);
    expect(client.executed.filter((s) => s === MIGRATIONS[0].sql)).toHaveLength(2);
    expect(client.inserts.map((p) => p[0])).toEqual(['0001_init']);
  });
});

// Fake client that simulates the single catalog_meta row and the
// conditional-UPDATE semantics D1 applies (meta.changes 0/1).
function lockClient({ migratingSince = null, tableExists = true } = {}) {
  const state = { migratingSince };
  const queries = [];
  return {
    state,
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (!tableExists) {
        throw new Error('Cloudflare rechazó la petición: no such table: catalog_meta');
      }
      if (/SET migrating_since = \?/.test(sql)) {
        const [lockTs, staleCutoff] = params;
        if (state.migratingSince === null || state.migratingSince < staleCutoff) {
          state.migratingSince = lockTs;
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 0 } };
      }
      if (/SET migrating_since = NULL/.test(sql)) {
        state.migratingSince = null;
        return { results: [], meta: { changes: 1 } };
      }
      return { results: [], meta: {} };
    }
  };
}

const NOW = () => '2026-06-12T10:00:00.000Z';

describe('acquireMigrationLock / releaseMigrationLock', () => {
  test('acquires a free lock and stamps migrating_since with now()', async () => {
    const client = lockClient();
    const got = await acquireMigrationLock(client, { now: NOW });
    expect(got).toBe(true);
    expect(client.state.migratingSince).toBe('2026-06-12T10:00:00.000Z');
    const { sql, params } = client.queries[0];
    expect(sql).toMatch(/UPDATE catalog_meta SET migrating_since = \? WHERE migrating_since IS NULL OR migrating_since < \?/);
    // Default staleness window: 10 minutes before now.
    expect(params).toEqual(['2026-06-12T10:00:00.000Z', '2026-06-12T09:50:00.000Z']);
  });

  test('refuses when another PC holds a fresh lock', async () => {
    const client = lockClient({ migratingSince: '2026-06-12T09:55:00.000Z' }); // 5 min old
    expect(await acquireMigrationLock(client, { now: NOW })).toBe(false);
    expect(client.state.migratingSince).toBe('2026-06-12T09:55:00.000Z'); // untouched
  });

  test('steals a stale lock older than staleMinutes (orphaned migration)', async () => {
    const client = lockClient({ migratingSince: '2026-06-12T09:30:00.000Z' }); // 30 min old
    expect(await acquireMigrationLock(client, { now: NOW })).toBe(true);
    expect(client.state.migratingSince).toBe('2026-06-12T10:00:00.000Z');
  });

  test('honours a custom staleMinutes window', async () => {
    const client = lockClient({ migratingSince: '2026-06-12T09:55:00.000Z' }); // 5 min old
    expect(await acquireMigrationLock(client, { now: NOW, staleMinutes: 3 })).toBe(true);
  });

  test('returns true without failing when catalog_meta does not exist yet (first migration)', async () => {
    const client = lockClient({ tableExists: false });
    expect(await acquireMigrationLock(client, { now: NOW })).toBe(true);
  });

  test('propagates non-missing-table errors instead of swallowing them', async () => {
    const client = {
      async query() { throw new Error('No se pudo conectar con Cloudflare — comprueba la conexión a internet'); }
    };
    await expect(acquireMigrationLock(client, { now: NOW })).rejects.toThrow(/No se pudo conectar/);
  });

  test('releaseMigrationLock sets migrating_since back to NULL', async () => {
    const client = lockClient({ migratingSince: '2026-06-12T09:59:00.000Z' });
    await releaseMigrationLock(client);
    expect(client.state.migratingSince).toBeNull();
    expect(client.queries[0].sql).toMatch(/UPDATE catalog_meta SET migrating_since = NULL/);
  });
});
