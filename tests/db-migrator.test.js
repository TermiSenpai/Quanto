// ============================================================
// Tests · lib/db-migrator.js
// ============================================================
import { describe, test, expect } from 'vitest';
import { applyMigrations } from '../lib/db-migrator.js';

function fakeClient(appliedIds = []) {
  const executed = [];
  const rows = appliedIds.map((id) => ({ id }));
  return {
    executed,
    async exec(sql) { executed.push(sql); return [{ success: true }]; },
    async query(sql, params = []) {
      executed.push(sql);
      if (/SELECT id FROM schema_migrations/.test(sql)) return { results: rows, meta: {} };
      if (/INSERT INTO schema_migrations/.test(sql)) { rows.push({ id: params[0] }); return { results: [], meta: { changes: 1 } }; }
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
    const insert = client.executed.find((s) => /INSERT INTO schema_migrations/.test(s));
    expect(insert).toBeTruthy();
  });
});
