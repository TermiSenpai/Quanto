// ============================================================
// Tests · lib/path-guard.js
// ============================================================
import { describe, test, expect } from 'vitest';
import path from 'path';
import { isPathAllowed } from '../lib/path-guard.js';

const CONFIG = path.resolve('/srv/packs/config.js');
const DIR = path.dirname(CONFIG);
const blessed = [CONFIG];

describe('isPathAllowed', () => {
  test('allows the blessed config path itself', () => {
    expect(isPathAllowed(blessed, CONFIG)).toBe(true);
  });

  test('allows the sibling audit.log', () => {
    expect(isPathAllowed(blessed, path.join(DIR, 'audit.log'))).toBe(true);
  });

  test('allows files under backups/', () => {
    expect(isPathAllowed(blessed, path.join(DIR, 'backups', 'config-2026.js'))).toBe(true);
    expect(isPathAllowed(blessed, path.join(DIR, 'backups'))).toBe(true);
  });

  test('rejects arbitrary files in the same directory', () => {
    expect(isPathAllowed(blessed, path.join(DIR, 'secrets.txt'))).toBe(false);
    expect(isPathAllowed(blessed, path.join(DIR, 'other.js'))).toBe(false);
  });

  test('rejects files outside the config directory', () => {
    expect(isPathAllowed(blessed, path.resolve('/etc/passwd'))).toBe(false);
    expect(isPathAllowed(blessed, path.resolve('/srv/other/config.js'))).toBe(false);
  });

  test('rejects traversal that escapes the config dir', () => {
    expect(isPathAllowed(blessed, path.join(DIR, '..', 'evil.js'))).toBe(false);
    expect(isPathAllowed(blessed, path.join(DIR, 'backups', '..', '..', 'evil.js'))).toBe(false);
  });

  test('does not let a sibling "backups-evil" dir slip through', () => {
    expect(isPathAllowed(blessed, path.join(DIR, 'backups-evil', 'x.js'))).toBe(false);
  });

  test('normalizes traversal that resolves back to an allowed path', () => {
    // <dir>/backups/sub/../config-1.js resolves into backups/ -> allowed
    expect(isPathAllowed(blessed, path.join(DIR, 'backups', 'sub', '..', 'config-1.js'))).toBe(true);
  });

  test('honors multiple blessed paths', () => {
    const second = path.resolve('/mnt/z/Packs/config.js');
    const set = [CONFIG, second];
    expect(isPathAllowed(set, second)).toBe(true);
    expect(isPathAllowed(set, path.join(path.dirname(second), 'audit.log'))).toBe(true);
  });

  test('rejects empty / non-string candidates', () => {
    expect(isPathAllowed(blessed, '')).toBe(false);
    expect(isPathAllowed(blessed, null)).toBe(false);
    expect(isPathAllowed(blessed, 123)).toBe(false);
  });

  test('empty blessed set rejects everything', () => {
    expect(isPathAllowed([], CONFIG)).toBe(false);
  });
});
