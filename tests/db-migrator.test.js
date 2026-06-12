// ============================================================
// Tests · lib/db-migrator.js
// ============================================================
import { describe, test, expect } from 'vitest';
import { applyMigrations } from '../lib/db-migrator.js';

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
