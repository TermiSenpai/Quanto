// ============================================================
// Tests · lib/diff.js
// ============================================================
import { describe, test, expect } from 'vitest';
import { diffObjects, formatChangeLine, DEFAULT_IGNORE_PATHS } from '../lib/diff.js';

describe('diffObjects — equality', () => {
  test('returns [] for identical primitives', () => {
    expect(diffObjects(1, 1)).toEqual([]);
    expect(diffObjects('a', 'a')).toEqual([]);
    expect(diffObjects(null, null)).toEqual([]);
  });

  test('returns [] for deeply equal objects', () => {
    const a = { x: { y: [1, 2, { z: 'hi' }] } };
    const b = { x: { y: [1, 2, { z: 'hi' }] } };
    expect(diffObjects(a, b)).toEqual([]);
  });
});

describe('diffObjects — leaf changes', () => {
  test('detects scalar change with full path', () => {
    const before = { parametros: { iva: 0.21, mo_eur_hora: 15 } };
    const after  = { parametros: { iva: 0.23, mo_eur_hora: 15 } };
    const d = diffObjects(before, after);
    expect(d).toEqual([
      { path: 'parametros.iva', before: 0.21, after: 0.23, kind: 'change' }
    ]);
  });

  test('detects added key', () => {
    const before = { a: 1 };
    const after  = { a: 1, b: 2 };
    expect(diffObjects(before, after)).toEqual([
      { path: 'b', before: undefined, after: 2, kind: 'add' }
    ]);
  });

  test('detects removed key', () => {
    const before = { a: 1, b: 2 };
    const after  = { a: 1 };
    expect(diffObjects(before, after)).toEqual([
      { path: 'b', before: 2, after: undefined, kind: 'remove' }
    ]);
  });

  test('handles nested addition', () => {
    // admin.has_password is in DEFAULT_IGNORE_PATHS, so use a key
    // that is not ignored to assert a plain nested addition.
    const before2 = { extras: { } };
    const after2  = { extras: { manga: 1.5 } };
    expect(diffObjects(before2, after2)).toEqual([
      { path: 'extras.manga', before: undefined, after: 1.5, kind: 'add' }
    ]);
  });
});

describe('diffObjects — arrays', () => {
  test('detects element change at index', () => {
    const before = { tiers: [{ id: 'T1', from: 10 }, { id: 'T2', from: 25 }] };
    const after  = { tiers: [{ id: 'T1', from: 10 }, { id: 'T2', from: 30 }] };
    const d = diffObjects(before, after);
    expect(d).toEqual([
      { path: 'tiers[1].from', before: 25, after: 30, kind: 'change' }
    ]);
  });

  test('detects array length growth', () => {
    const d = diffObjects([1, 2], [1, 2, 3]);
    expect(d).toEqual([
      { path: '[2]', before: undefined, after: 3, kind: 'add' }
    ]);
  });
});

describe('diffObjects — ignore paths', () => {
  test('default ignore skips updated_at and modified_by', () => {
    const before = {
      updated_at: '01/01/2026, 10:00:00',
      modified_by: 'Alberto',
      parameters: { vat: 0.21 }
    };
    const after = {
      updated_at: '02/01/2026, 11:00:00',
      modified_by: 'María',
      parameters: { vat: 0.23 }
    };
    const d = diffObjects(before, after);
    expect(d.length).toBe(1);
    expect(d[0].path).toBe('parameters.vat');
  });

  test('default ignore skips admin.password and admin.has_password', () => {
    const before = { admin: { password: 'old', has_password: true } };
    const after  = { admin: { password: 'new', has_password: true } };
    expect(diffObjects(before, after)).toEqual([]);
  });

  test('custom ignore set replaces defaults', () => {
    const before = { updated_at: 'A', payload: 1 };
    const after  = { updated_at: 'B', payload: 2 };
    const d = diffObjects(before, after, { ignorePaths: new Set(['payload']) });
    // Custom ignore: payload skipped, updated_at no longer ignored.
    expect(d.length).toBe(1);
    expect(d[0].path).toBe('updated_at');
  });
});

describe('formatChangeLine', () => {
  test('renders change kind with arrow', () => {
    const line = formatChangeLine({
      path: 'parameters.vat', before: 0.21, after: 0.23, kind: 'change'
    });
    expect(line).toMatch(/parameters\.vat/);
    expect(line).toMatch(/0\.21/);
    expect(line).toMatch(/0\.23/);
    expect(line).toMatch(/→/);
  });

  test('renders add and remove with sign prefix', () => {
    expect(formatChangeLine({ path: 'x', after: 1, kind: 'add' })).toMatch(/^\+ x/);
    expect(formatChangeLine({ path: 'x', before: 1, kind: 'remove' })).toMatch(/^- x/);
  });
});

describe('DEFAULT_IGNORE_PATHS', () => {
  test('contains the expected metadata keys', () => {
    expect(DEFAULT_IGNORE_PATHS.has('updated_at')).toBe(true);
    expect(DEFAULT_IGNORE_PATHS.has('modified_by')).toBe(true);
    expect(DEFAULT_IGNORE_PATHS.has('admin.password')).toBe(true);
  });
});
