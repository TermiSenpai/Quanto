// ============================================================
// Tests · lib/catalog-cache.js (local catalog cache store)
// ============================================================
// Exercises the real filesystem against a temp directory (same
// approach as tests/config-store.test.js). This is the safety net
// for the offline read-only start: the last good cloud catalog must
// survive on disk, atomically written, and a corrupt cache must be
// reported loudly — never silently treated as data.
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCache, writeCache } from '../lib/catalog-cache.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-cache-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SAMPLE = {
  fetchedAt: '2026-06-12T10:00:00.000Z',
  catalogVersion: 7,
  entities: { products: [{ id: 'BEAGLE', name: 'Camiseta' }], tiers: [] }
};

describe('catalog cache', () => {
  test('write → read round-trip preserves the exact payload', () => {
    const cachePath = path.join(tmpDir, 'cache', 'catalog.json');
    writeCache(cachePath, SAMPLE);
    expect(readCache(cachePath)).toEqual(SAMPLE);
  });

  test('readCache returns null when the file does not exist', () => {
    expect(readCache(path.join(tmpDir, 'missing', 'catalog.json'))).toBeNull();
  });

  test('readCache throws a Spanish error with cause on invalid JSON', () => {
    const cachePath = path.join(tmpDir, 'catalog.json');
    fs.writeFileSync(cachePath, '{ truncated', 'utf-8');
    let thrown = null;
    try {
      readCache(cachePath);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(/Caché de catálogo dañada/);
    expect(thrown.cause).toBeInstanceOf(Error);
  });

  test('writeCache creates the parent directory when missing', () => {
    const cachePath = path.join(tmpDir, 'deep', 'nested', 'catalog.json');
    writeCache(cachePath, SAMPLE);
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  test('writeCache is atomic: no orphan .tmp remains and rewrites replace cleanly', () => {
    const cachePath = path.join(tmpDir, 'catalog.json');
    writeCache(cachePath, SAMPLE);
    writeCache(cachePath, { ...SAMPLE, catalogVersion: 8 });
    expect(fs.existsSync(cachePath + '.tmp')).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual(['catalog.json']);
    expect(readCache(cachePath).catalogVersion).toBe(8);
  });
});
