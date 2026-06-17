// ============================================================
// Tests · lib/config-store.js (file IO + lazy migration)
// ============================================================
// Exercises the real filesystem against a temp directory (same
// approach as tests/history.test.js). This is the safety net for
// "an old config becomes functional automatically without losing
// data": migrate on read, back up the original, write atomically,
// be idempotent.
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readConfigFromFile,
  readAndMigrateConfig,
  readAndMigrateSettings,
  createBackup
} from '../lib/config-store.js';
import { serializeConfig, extractJsonFromConfig } from '../lib/config-parser.js';
import { buildFullConfigV4 as buildDefaultConfig } from './fixtures/config-v4-full.js';
import { buildV2Config } from './fixtures/config-v2.js';
import { buildV3Config } from './fixtures/config-v3.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-store-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRawConfig(filePath, obj) {
  fs.writeFileSync(filePath, serializeConfig(obj), 'utf-8');
}

describe('readAndMigrateConfig — lazy migration of a v2 config', () => {
  test('migrates v2 to v4 on disk, backs up, preserves data', () => {
    const cfgPath = path.join(tmpDir, 'config.js');
    writeRawConfig(cfgPath, buildV2Config({ modificado_por: 'Alberto' }));

    let migrateInfo = null;
    const { config, didMigrate, backupPath } = readAndMigrateConfig(cfgPath, {
      onMigrate: (info) => { migrateInfo = info; }
    });

    // Returned config is v4
    expect(didMigrate).toBe(true);
    expect(config.version).toBe('4.0.0');
    expect(config.parameters.vat).toBe(0.21);

    // The on-disk file was rewritten as v4
    const onDisk = readConfigFromFile(cfgPath);
    expect(onDisk.version).toBe('4.0.0');
    expect(onDisk.parameters.labor_eur_hour).toBe(15);

    // No data lost: spot-check across every section (v4 shape)
    expect(config.packs.crew_full.bundle_prices['without_hood|two_sides'].T1).toBe(25.95);
    expect(config.packs.hoodies_mixed.components.map(c => c.product)).toEqual(['CLASICA', 'URBAN']);
    const beagleDefault = config.products.BEAGLE.suppliers.find(s => s.is_default);
    expect(beagleDefault.price).toBe(1.7325);
    expect(config.products.BEAGLE.name).toBe('Camiseta');
    expect(config.admin.password).toBe('fuzfuz2026');
    expect(config.company.name).toBe('Mi Taller DTF');

    // Backup of the ORIGINAL v2 file, tagged
    expect(backupPath).toMatch(/pre-v3-migration/);
    const backups = fs.readdirSync(path.join(tmpDir, 'backups'));
    expect(backups).toHaveLength(1);
    const backedUp = extractJsonFromConfig(fs.readFileSync(backupPath, 'utf-8'));
    expect(backedUp.version).toBe('2.0.0');
    expect(backedUp.parametros.iva).toBe(0.21);

    // onMigrate hook got version info
    expect(migrateInfo.fromVersion).toBe('2.0.0');
    expect(migrateInfo.toVersion).toBe('4.0.0');

    // Atomic write left no .tmp behind
    expect(fs.existsSync(cfgPath + '.tmp')).toBe(false);
  });

  test('migrates a v3 config to v4 on disk', () => {
    const cfgPath = path.join(tmpDir, 'config.js');
    writeRawConfig(cfgPath, buildV3Config({ modified_by: 'Alberto' }));

    let migrateInfo = null;
    const { config, didMigrate } = readAndMigrateConfig(cfgPath, {
      onMigrate: (info) => { migrateInfo = info; }
    });

    expect(didMigrate).toBe(true);
    expect(config.version).toBe('4.0.0');
    expect(config.products.URBAN.prices.two_sides.T1).toBe(16.95);
    expect(migrateInfo.fromVersion).toBe('3.0.0');
    expect(migrateInfo.toVersion).toBe('4.0.0');

    const onDisk = readConfigFromFile(cfgPath);
    expect(onDisk.version).toBe('4.0.0');
  });

  test('is idempotent: second read does not migrate or back up again', () => {
    const cfgPath = path.join(tmpDir, 'config.js');
    writeRawConfig(cfgPath, buildV2Config());

    readAndMigrateConfig(cfgPath);
    const second = readAndMigrateConfig(cfgPath);

    expect(second.didMigrate).toBe(false);
    expect(second.backupPath).toBeNull();
    expect(fs.readdirSync(path.join(tmpDir, 'backups'))).toHaveLength(1);
  });

  test('a v4 config is returned untouched and never rewritten', () => {
    const cfgPath = path.join(tmpDir, 'config.js');
    writeRawConfig(cfgPath, buildDefaultConfig({ modified_by: 'X' }));
    const before = fs.statSync(cfgPath).mtimeMs;

    const { didMigrate } = readAndMigrateConfig(cfgPath);

    expect(didMigrate).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'backups'))).toBe(false);
    expect(fs.statSync(cfgPath).mtimeMs).toBe(before);
  });

  test('throws a clear error when the file is missing', () => {
    expect(() => readAndMigrateConfig(path.join(tmpDir, 'nope.js'))).toThrow(/No existe/);
  });
});

describe('createBackup', () => {
  test('tags the backup file name when a tag is given', () => {
    const cfgPath = path.join(tmpDir, 'config.js');
    writeRawConfig(cfgPath, buildDefaultConfig());
    const p = createBackup(cfgPath, { tag: 'manual' });
    expect(p).toMatch(/-manual\.js$/);
  });

  test('returns null (no throw) when the source file does not exist', () => {
    expect(createBackup(path.join(tmpDir, 'missing.js'))).toBeNull();
  });
});

describe('readAndMigrateSettings — per-PC settings', () => {
  test('migrates v2 keys to v3 on disk and backs up', () => {
    const sPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(sPath, JSON.stringify({ ruta_config: 'C:/Packs/config.js', nombre_usuario: 'Alberto' }));

    const s = readAndMigrateSettings(sPath);
    expect(s).toEqual({ config_path: 'C:/Packs/config.js', user_name: 'Alberto' });

    const onDisk = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
    expect(onDisk).toEqual({ config_path: 'C:/Packs/config.js', user_name: 'Alberto' });
    expect(fs.existsSync(sPath + '.bak-pre-v3')).toBe(true);
  });

  test('a v3 settings file is returned untouched (no backup)', () => {
    const sPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(sPath, JSON.stringify({ config_path: 'C:/x', user_name: 'A' }));

    const s = readAndMigrateSettings(sPath);
    expect(s).toEqual({ config_path: 'C:/x', user_name: 'A' });
    expect(fs.existsSync(sPath + '.bak-pre-v3')).toBe(false);
  });

  test('returns null when settings are absent', () => {
    expect(readAndMigrateSettings(path.join(tmpDir, 'settings.json'))).toBeNull();
  });

  test('returns null and calls onCorrupt for malformed JSON', () => {
    const sPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(sPath, '{ not valid json ');
    let corrupt = false;
    const s = readAndMigrateSettings(sPath, { onCorrupt: () => { corrupt = true; } });
    expect(s).toBeNull();
    expect(corrupt).toBe(true);
  });
});
