// ============================================================
// Tests · lib/userdata-migration.js (PackPrice → Quanto userData)
// ============================================================
// Exercises the real filesystem against temp directories (same
// approach as tests/config-store.js). The contract: copy the legacy
// folder into the new one exactly once, never lose data, never
// overwrite an already-initialized folder, always idempotent.
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateLegacyUserData } from '../lib/userdata-migration.js';

let root;
let legacyDir;
let currentDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'quanto-userdata-'));
  legacyDir = path.join(root, 'PackPrice');
  currentDir = path.join(root, 'Quanto');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLegacy() {
  fs.mkdirSync(path.join(legacyDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'settings.json'), '{"user_name":"Alberto"}');
  fs.writeFileSync(path.join(legacyDir, 'presupuestos.json'), '[{"id":"q1"}]');
  fs.writeFileSync(path.join(legacyDir, 'cache', 'catalog.json'), '{"v":4}');
}

describe('migrateLegacyUserData', () => {
  test('copies legacy data into a fresh current folder', () => {
    seedLegacy();
    const migrated = [];
    const did = migrateLegacyUserData({
      currentDir, legacyDir, onMigrated: (i) => migrated.push(i)
    });

    expect(did).toBe(true);
    expect(migrated).toHaveLength(1);
    expect(fs.readFileSync(path.join(currentDir, 'settings.json'), 'utf-8')).toContain('Alberto');
    expect(fs.existsSync(path.join(currentDir, 'presupuestos.json'))).toBe(true);
    expect(fs.readFileSync(path.join(currentDir, 'cache', 'catalog.json'), 'utf-8')).toContain('"v":4');
  });

  test('leaves the legacy folder untouched (copy, not move)', () => {
    seedLegacy();
    migrateLegacyUserData({ currentDir, legacyDir });
    expect(fs.existsSync(path.join(legacyDir, 'settings.json'))).toBe(true);
  });

  test('is a no-op when the current folder is already initialized', () => {
    seedLegacy();
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(path.join(currentDir, 'settings.json'), '{"user_name":"Fede"}');

    const did = migrateLegacyUserData({ currentDir, legacyDir });

    expect(did).toBe(false);
    // The existing Quanto data must NOT be clobbered by the legacy one.
    expect(fs.readFileSync(path.join(currentDir, 'settings.json'), 'utf-8')).toContain('Fede');
    expect(fs.existsSync(path.join(currentDir, 'presupuestos.json'))).toBe(false);
  });

  test('is a no-op when there is no legacy folder (fresh install)', () => {
    const did = migrateLegacyUserData({ currentDir, legacyDir });
    expect(did).toBe(false);
    expect(fs.existsSync(currentDir)).toBe(false);
  });

  test('is a no-op when legacy exists but has no settings.json', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'logs.txt'), 'noise');
    const did = migrateLegacyUserData({ currentDir, legacyDir });
    expect(did).toBe(false);
  });

  test('is a no-op when current and legacy resolve to the same folder', () => {
    seedLegacy();
    const did = migrateLegacyUserData({ currentDir: legacyDir, legacyDir });
    expect(did).toBe(false);
  });

  test('running twice migrates only once (idempotent)', () => {
    seedLegacy();
    expect(migrateLegacyUserData({ currentDir, legacyDir })).toBe(true);
    expect(migrateLegacyUserData({ currentDir, legacyDir })).toBe(false);
  });

  test('reports the error and does not throw on a copy failure', () => {
    seedLegacy();
    const errors = [];
    const fsImpl = {
      existsSync: fs.existsSync,
      cpSync: () => { throw new Error('disk full'); }
    };
    const did = migrateLegacyUserData({
      currentDir, legacyDir, fsImpl, onError: (e) => errors.push(e)
    });

    expect(did).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('disk full');
  });
});
