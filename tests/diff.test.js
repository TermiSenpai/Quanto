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
    const before = { admin: { } };
    const after  = { admin: { tiene_clave: false } }; // not in default ignore
    // Wait — admin.tiene_clave IS in DEFAULT_IGNORE_PATHS. Use a different one.
    const before2 = { extras: { } };
    const after2  = { extras: { manga: 1.5 } };
    expect(diffObjects(before2, after2)).toEqual([
      { path: 'extras.manga', before: undefined, after: 1.5, kind: 'add' }
    ]);
  });
});

describe('diffObjects — arrays', () => {
  test('detects element change at index', () => {
    const before = { tramos: [{ id: 'T1', desde: 10 }, { id: 'T2', desde: 25 }] };
    const after  = { tramos: [{ id: 'T1', desde: 10 }, { id: 'T2', desde: 30 }] };
    const d = diffObjects(before, after);
    expect(d).toEqual([
      { path: 'tramos[1].desde', before: 25, after: 30, kind: 'change' }
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
  test('default ignore skips fecha_actualizacion and modificado_por', () => {
    const before = {
      fecha_actualizacion: '01/01/2026, 10:00:00',
      modificado_por: 'Alberto',
      parametros: { iva: 0.21 }
    };
    const after = {
      fecha_actualizacion: '02/01/2026, 11:00:00',
      modificado_por: 'María',
      parametros: { iva: 0.23 }
    };
    const d = diffObjects(before, after);
    expect(d.length).toBe(1);
    expect(d[0].path).toBe('parametros.iva');
  });

  test('default ignore skips admin.clave and admin.tiene_clave', () => {
    const before = { admin: { clave: 'old', tiene_clave: true } };
    const after  = { admin: { clave: 'new', tiene_clave: true } };
    expect(diffObjects(before, after)).toEqual([]);
  });

  test('custom ignore set replaces defaults', () => {
    const before = { fecha_actualizacion: 'A', payload: 1 };
    const after  = { fecha_actualizacion: 'B', payload: 2 };
    const d = diffObjects(before, after, { ignorePaths: new Set(['payload']) });
    // Custom ignore: payload skipped, fecha_actualizacion no longer ignored.
    expect(d.length).toBe(1);
    expect(d[0].path).toBe('fecha_actualizacion');
  });
});

describe('formatChangeLine', () => {
  test('renders change kind with arrow', () => {
    const line = formatChangeLine({
      path: 'parametros.iva', before: 0.21, after: 0.23, kind: 'change'
    });
    expect(line).toMatch(/parametros\.iva/);
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
    expect(DEFAULT_IGNORE_PATHS.has('fecha_actualizacion')).toBe(true);
    expect(DEFAULT_IGNORE_PATHS.has('modificado_por')).toBe(true);
    expect(DEFAULT_IGNORE_PATHS.has('admin.clave')).toBe(true);
  });
});
