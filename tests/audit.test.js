// ============================================================
// Tests · lib/audit.js
// ============================================================
import { describe, test, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appendAuditEntry,
  readRecentEntries,
  auditPathFor,
  AUDIT_FILE_NAME
} from '../lib/audit.js';

const dirs = [];
afterAll(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-audit-'));
  dirs.push(dir);
  return path.join(dir, 'config.js');
}

describe('auditPathFor', () => {
  test('places audit.log next to the config file', () => {
    // Use a real platform-correct path so Windows backslashes match.
    const cfg = path.join(os.tmpdir(), 'Paep', 'Packs', 'config.js');
    expect(auditPathFor(cfg).endsWith(AUDIT_FILE_NAME)).toBe(true);
    expect(path.dirname(auditPathFor(cfg))).toBe(path.dirname(cfg));
  });
});

describe('appendAuditEntry', () => {
  test('writes one JSONL line per call with stable schema', () => {
    const cfgPath = makeConfigDir();
    const result = appendAuditEntry(cfgPath, {
      usuario: 'Alberto',
      app_version: '2.0.0-beta',
      cambios: [
        { path: 'parametros.iva', before: 0.21, after: 0.23, kind: 'change' }
      ]
    });
    expect(result.written).toBe(true);
    const txt = fs.readFileSync(result.path, 'utf-8');
    const lines = txt.split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.usuario).toBe('Alberto');
    expect(parsed.app_version).toBe('2.0.0-beta');
    expect(parsed.cambios).toHaveLength(1);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('skips writing when cambios is empty', () => {
    const cfgPath = makeConfigDir();
    const result = appendAuditEntry(cfgPath, { usuario: 'X', cambios: [] });
    expect(result.written).toBe(false);
    expect(fs.existsSync(result.path)).toBe(false);
  });

  test('appends without rewriting previous lines', () => {
    const cfgPath = makeConfigDir();
    appendAuditEntry(cfgPath, { usuario: 'A', cambios: [{ path: 'x', before: 1, after: 2, kind: 'change' }] });
    appendAuditEntry(cfgPath, { usuario: 'B', cambios: [{ path: 'y', before: 3, after: 4, kind: 'change' }] });
    const lines = fs.readFileSync(auditPathFor(cfgPath), 'utf-8').split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).usuario).toBe('A');
    expect(JSON.parse(lines[1]).usuario).toBe('B');
  });

  test('creates the parent directory when missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-audit-'));
    dirs.push(dir);
    const nested = path.join(dir, 'sub', 'config.js');
    const result = appendAuditEntry(nested, {
      usuario: 'A',
      cambios: [{ path: 'p', before: 1, after: 2, kind: 'change' }]
    });
    expect(result.written).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

describe('readRecentEntries', () => {
  test('returns [] when the file does not exist', () => {
    expect(readRecentEntries('/nope/whatever/config.js')).toEqual([]);
  });

  test('returns last N entries oldest→newest', () => {
    const cfgPath = makeConfigDir();
    for (let i = 1; i <= 5; i++) {
      appendAuditEntry(cfgPath, {
        usuario: `u${i}`,
        cambios: [{ path: 'k', before: i - 1, after: i, kind: 'change' }]
      });
    }
    const last3 = readRecentEntries(cfgPath, 3);
    expect(last3.map(e => e.usuario)).toEqual(['u3', 'u4', 'u5']);
  });

  test('skips corrupt lines without throwing', () => {
    const cfgPath = makeConfigDir();
    appendAuditEntry(cfgPath, { usuario: 'A', cambios: [{ path: 'x', before: 1, after: 2, kind: 'change' }] });
    fs.appendFileSync(auditPathFor(cfgPath), '{ this is broken json\n', 'utf-8');
    appendAuditEntry(cfgPath, { usuario: 'B', cambios: [{ path: 'y', before: 3, after: 4, kind: 'change' }] });
    const entries = readRecentEntries(cfgPath, 10);
    expect(entries.map(e => e.usuario)).toEqual(['A', 'B']);
  });
});
