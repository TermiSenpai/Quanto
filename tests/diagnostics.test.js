// ============================================================
// Tests · lib/diagnostics.js
// ============================================================
// "Soporte a ciegas" (PRD R17): the diagnostics bundle is what a user
// sends the developer when something breaks. It must be USEFUL (logs,
// versions, presence of cache/outbox) and SAFE: never the Cloudflare
// token, never a catalog, a quote or any business datum.
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDiagnostics } from '../lib/diagnostics.js';

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-diag-'));
  return d;
}

const SETTINGS = {
  config_path: 'Z:\\Packs\\config.js',
  user_name: 'Alberto',
  data_source: 'cloud',
  error_reports_enabled: true,
  check_updates_on_start: true,
  cloud: {
    token: 'super-secret-cloudflare-token-abcdef1234567890',
    account_id: 'a'.repeat(32),
    database_id: '123e4567-e89b-42d3-a456-426614174000',
    user_name: 'PC-Taller'
  }
};

function seed(dir, { withLog = true, withCache = true, withOutbox = true, settings = SETTINGS } = {}) {
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  if (settings) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8');
  }
  if (withLog) {
    fs.writeFileSync(path.join(dir, 'logs', 'main.log'),
      '[2026-06-13T10:00:00.000Z] [info] app started\n[2026-06-13T10:00:01.000Z] [error] boom\n', 'utf-8');
  }
  if (withCache) {
    fs.writeFileSync(path.join(dir, 'cache', 'catalog.json'), JSON.stringify({ packs: [{ id: 'p1' }] }), 'utf-8');
  }
  if (withOutbox) {
    fs.writeFileSync(path.join(dir, 'cache', 'outbox.json'),
      JSON.stringify({ quotes: [{ id: 'q1' }, { id: 'q2' }], statuses: [{ id: 'q1', status: 'accepted' }] }), 'utf-8');
  }
}

const META = { appVersion: '5.0.0-beta', schemaVersion: 1, dataSource: 'cloud' };

describe('buildDiagnostics · structure', () => {
  test('returns the expected top-level sections', () => {
    const dir = tmpDir();
    seed(dir);
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    expect(d).toHaveProperty('generated_at');
    expect(d).toHaveProperty('versions');
    expect(d).toHaveProperty('data_source', 'cloud');
    expect(d).toHaveProperty('settings');
    expect(d).toHaveProperty('storage');
    expect(d).toHaveProperty('recent_log_lines');
  });

  test('carries app + schema + electron + os versions', () => {
    const dir = tmpDir();
    seed(dir);
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    expect(d.versions.app).toBe('5.0.0-beta');
    expect(d.versions.schema).toBe(1);
    expect(d.versions).toHaveProperty('electron');
    expect(d.versions).toHaveProperty('os');
    expect(d.versions).toHaveProperty('node');
  });

  test('includes recent log lines from main.log', () => {
    const dir = tmpDir();
    seed(dir);
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    expect(Array.isArray(d.recent_log_lines)).toBe(true);
    expect(d.recent_log_lines.join('\n')).toContain('app started');
    expect(d.recent_log_lines.join('\n')).toContain('boom');
  });

  test('reports cache + outbox PRESENCE and counts, not contents', () => {
    const dir = tmpDir();
    seed(dir);
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    expect(d.storage.catalog_cache_present).toBe(true);
    expect(d.storage.outbox_present).toBe(true);
    expect(d.storage.outbox_quotes).toBe(2);
    expect(d.storage.outbox_statuses).toBe(1);
    // The actual catalog/quote contents must NOT appear anywhere.
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('p1');
    expect(serialized).not.toContain('q1');
    expect(serialized).not.toContain('q2');
  });
});

describe('buildDiagnostics · safety (no secrets, no business data)', () => {
  test('the Cloudflare token is NEVER present anywhere in the bundle', () => {
    const dir = tmpDir();
    seed(dir);
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('super-secret-cloudflare-token-abcdef1234567890');
    // The redacted view exposes only a boolean.
    expect(d.settings.cloud).not.toHaveProperty('token');
    expect(d.settings.cloud.has_token).toBe(true);
  });

  test('settings are the redacted view (other fields survive)', () => {
    const dir = tmpDir();
    seed(dir);
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    expect(d.settings.user_name).toBe('Alberto');
    expect(d.settings.data_source).toBe('cloud');
    expect(d.settings.cloud.account_id).toBe('a'.repeat(32));
  });

  test('no catalog / quote contents leak through storage section', () => {
    const dir = tmpDir();
    seed(dir);
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    expect(d.storage).not.toHaveProperty('catalog');
    expect(d.storage).not.toHaveProperty('quotes');
  });

  test('recent_log_lines scrub PII: no Windows username, no operator name, no token', () => {
    const dir = tmpDir();
    seed(dir, { withLog: false });
    const logBody = [
      '[2026-06-13T10:00:00.000Z] [info] app started',
      '[2026-06-13T10:00:01.000Z] [info] read C:\\Users\\Alberto\\AppData\\Roaming\\packprice\\config.js',
      '[2026-06-13T10:00:02.000Z] [info] audit {"action":"save","usuario":"Alberto"}',
      '[2026-06-13T10:00:03.000Z] [info] write by modificadoPor: Alberto on entity pack-1',
      '[2026-06-13T10:00:04.000Z] [info] config updated modified_by: Alberto',
      '[2026-06-13T10:00:05.000Z] [error] auth failed token=vK9zT3xQ1aB7cD2eF4gH6jK8lM0nP1qR3sT5uV7w'
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'logs', 'main.log'), logBody + '\n', 'utf-8');

    const d = buildDiagnostics({ userDataDir: dir, ...META });
    const joined = d.recent_log_lines.join('\n');

    // Structure still complete: every non-empty line survives.
    expect(Array.isArray(d.recent_log_lines)).toBe(true);
    expect(d.recent_log_lines.length).toBe(6);

    // Assert ABSENCE of the PII anywhere in the lines.
    expect(joined).not.toContain('Alberto');
    expect(joined).not.toContain('C:\\Users');
    expect(joined).not.toContain('vK9zT3xQ1aB7cD2eF4gH6jK8lM0nP1qR3sT5uV7w');

    // The basename of the path survives (still useful), and the lines are
    // not blanked wholesale.
    expect(joined).toContain('config.js');
    expect(joined).toContain('app started');
  });
});

describe('buildDiagnostics · tolerance', () => {
  test('missing log file → empty recent_log_lines, no throw', () => {
    const dir = tmpDir();
    seed(dir, { withLog: false });
    let d;
    expect(() => { d = buildDiagnostics({ userDataDir: dir, ...META }); }).not.toThrow();
    expect(d.recent_log_lines).toEqual([]);
  });

  test('missing cache + outbox → presence flags false, counts zero', () => {
    const dir = tmpDir();
    seed(dir, { withCache: false, withOutbox: false });
    const d = buildDiagnostics({ userDataDir: dir, ...META });
    expect(d.storage.catalog_cache_present).toBe(false);
    expect(d.storage.outbox_present).toBe(false);
    expect(d.storage.outbox_quotes).toBe(0);
    expect(d.storage.outbox_statuses).toBe(0);
  });

  test('missing settings file → null/empty settings, no throw', () => {
    const dir = tmpDir();
    seed(dir, { settings: null });
    let d;
    expect(() => { d = buildDiagnostics({ userDataDir: dir, ...META }); }).not.toThrow();
    expect(d.settings === null || typeof d.settings === 'object').toBe(true);
  });

  test('a corrupt outbox is tolerated (presence true, counts zero)', () => {
    const dir = tmpDir();
    seed(dir);
    fs.writeFileSync(path.join(dir, 'cache', 'outbox.json'), '{ not json', 'utf-8');
    let d;
    expect(() => { d = buildDiagnostics({ userDataDir: dir, ...META }); }).not.toThrow();
    expect(d.storage.outbox_present).toBe(true);
    expect(d.storage.outbox_quotes).toBe(0);
  });
});
