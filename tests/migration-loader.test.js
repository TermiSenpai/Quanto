// ============================================================
// Tests · lib/migration-loader.js
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { loadMigrations } from '../lib/migration-loader.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'migrations');
const REAL_MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

describe('loadMigrations', () => {
  test('returns numbered .sql files sorted by id with their content', () => {
    const migrations = loadMigrations(FIXTURES);
    expect(migrations.map((m) => m.id)).toEqual(['0001_a', '0002_b']);
    expect(migrations[0].sql).toContain('CREATE TABLE');
  });

  test('ignores files that are not NNNN_name.sql', () => {
    const migrations = loadMigrations(FIXTURES);
    expect(migrations.some((m) => m.id.includes('notes'))).toBe(false);
  });

  test('throws a Spanish error with cause if the directory does not exist', () => {
    let caught;
    try { loadMigrations(path.join(FIXTURES, 'nope')); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toMatch(/migraciones/i);
    expect(caught.cause).toBeInstanceOf(Error);
  });

  test('wraps a per-file read failure in a Spanish error with cause', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-mig-'));
    // a directory matching the migration pattern makes readFileSync throw
    fs.mkdirSync(path.join(tmp, '0001_bad.sql'));
    try {
      let caught;
      try { loadMigrations(tmp); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toBe('No se pudo leer la migración: 0001_bad.sql');
      expect(caught.cause).toBeInstanceOf(Error);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('loads the real bundled migrations (wiring)', () => {
    const migrations = loadMigrations(REAL_MIGRATIONS);
    expect(migrations[0].id).toBe('0001_init');
    expect(migrations[0].sql).toContain('catalog_meta');
  });
});
