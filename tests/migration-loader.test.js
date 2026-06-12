// ============================================================
// Tests · lib/migration-loader.js
// ============================================================
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { loadMigrations } from '../lib/migration-loader.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'migrations');

describe('loadMigrations', () => {
  test('returns numbered .sql files sorted by id with their content', () => {
    const migrations = loadMigrations(FIXTURES);
    expect(migrations.map((m) => m.id)).toEqual(['0001_a', '0002_b']);
    expect(migrations[0].sql).toContain('CREATE TABLE');
  });

  test('ignores files that are not NNNN_name.sql', () => {
    const migrations = loadMigrations(FIXTURES);
    expect(migrations.some((m) => m.id.includes('notas'))).toBe(false);
  });

  test('throws a Spanish error if the directory does not exist', () => {
    expect(() => loadMigrations(path.join(FIXTURES, 'nope'))).toThrow(/migraciones/i);
  });
});
