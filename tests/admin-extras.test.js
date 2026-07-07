// ============================================================
// Admin-extras cloud history render helpers (renderer/admin-extras.js)
// ============================================================
// Pure(ish) string-returning render helpers for the v5 cloud
// «Historial» tab: the audit list (one entity change per row) and the
// snapshot/versions list with its restore buttons. These are the
// testable seams behind the DOM glue in app.js.
//
// The critical guard under test: a cloud audit `diff` is normally the
// array readAuditLog parsed from diff_json, but a malformed cell falls
// back to a RAW STRING — the render must show it verbatim, never crash.
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  renderCloudAuditList,
  renderSnapshotsList,
  formatSnapshotLabel,
  renderDiffPreview,
  renderAuditTab
} from '../renderer/admin-extras.js';

describe('formatSnapshotLabel', () => {
  test('formats version + dd/mm/yyyy · hh:mm from an ISO timestamp', () => {
    const label = formatSnapshotLabel({
      catalogVersion: 7,
      ts: '2026-06-13T09:05:00.000Z'
    });
    expect(label).toMatch(/^v7 · \d{2}\/\d{2}\/\d{4} · \d{2}:\d{2}$/);
  });

  test('tolerates a missing/garbage timestamp without throwing', () => {
    expect(() => formatSnapshotLabel({ catalogVersion: 1, ts: 'nope' })).not.toThrow();
    expect(formatSnapshotLabel({ catalogVersion: 1, ts: 'nope' })).toBe('v1 · nope');
  });
});

describe('renderCloudAuditList', () => {
  test('empty list shows a Spanish hint', () => {
    const html = renderCloudAuditList([]);
    expect(html).toContain('No hay cambios registrados');
  });

  test('renders user, Spanish action + entity label, and diff change rows', () => {
    // Cloud diffs carry ENTITY-RELATIVE paths; entityType drives the labels.
    const html = renderCloudAuditList([
      {
        id: 2,
        ts: '2026-06-13T09:05:00.000Z',
        user: 'Mostrador-2',
        entityType: 'pack',
        entityId: 'crew',
        action: 'update',
        diff: [{ path: 'name', before: 'A', after: 'B', kind: 'change' }],
        catalogVersion: 8
      }
    ]);
    expect(html).toContain('Mostrador-2');
    expect(html).toContain('editó');
    expect(html).toContain('Pack «crew»');
    // Friendly humanized row (no raw dotted path).
    expect(html).toContain('Nombre');
    expect(html).toContain('«A»');
    expect(html).toContain('«B»');
    expect(html).toContain('v8');
  });

  test('humanizes diff rows with the entry entityType', () => {
    const html = renderCloudAuditList([
      {
        user: 'ana',
        ts: '2026-06-16T10:00:00Z',
        action: 'update',
        entityType: 'supplier',
        entityId: 'S1',
        diff: [{ path: 'name', before: 'A', after: 'B', kind: 'change' }]
      }
    ]);
    expect(html).toContain('Nombre');
    expect(html).toContain('«A»');
    expect(html).toContain('«B»');
    expect(html).not.toContain('path');
  });

  test('GUARD: a malformed (raw string) diff renders verbatim, never crashes', () => {
    const html = renderCloudAuditList([
      {
        id: 1,
        ts: '2026-06-13T09:00:00.000Z',
        user: 'X',
        entityType: 'product',
        entityId: 'P1',
        action: 'create',
        diff: '{not valid json',
        catalogVersion: 1
      }
    ]);
    // Shown verbatim (HTML-escaped) and no throw.
    expect(html).toContain('{not valid json');
    expect(html).toContain('creó');
  });

  test('an empty diff array shows "Sin cambios registrados"', () => {
    const html = renderCloudAuditList([
      { id: 1, ts: '', user: 'X', entityType: 'tiers', entityId: null, action: 'update', diff: [], catalogVersion: 3 }
    ]);
    expect(html).toContain('Sin cambios registrados');
  });

  test('escapes HTML in user / entity id (no injection)', () => {
    const html = renderCloudAuditList([
      { id: 1, ts: '', user: '<script>', entityType: 'pack', entityId: '"><img>', action: 'update', diff: [], catalogVersion: 1 }
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><img>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderSnapshotsList', () => {
  test('empty list shows a Spanish hint', () => {
    expect(renderSnapshotsList([])).toContain('No hay versiones guardadas');
  });

  test('renders a restore button per snapshot carrying the version + label', () => {
    const html = renderSnapshotsList([
      { catalogVersion: 5, ts: '2026-06-13T09:05:00.000Z' },
      { catalogVersion: 4, ts: '2026-06-12T08:00:00.000Z' }
    ]);
    expect(html).toContain('data-action="restore-snapshot"');
    expect(html).toContain('data-version="5"');
    expect(html).toContain('data-version="4"');
    expect(html).toContain('Restaurar esta versión');
    // Version label appears for the row.
    expect(html).toContain('v5 ·');
  });
});

describe('renderDiffPreview', () => {
  test('empty changes shows a Spanish hint', () => {
    expect(renderDiffPreview([])).toContain('No hay cambios pendientes');
  });

  test('humanizes a whole-entity add (no JSON, no path)', () => {
    const html = renderDiffPreview([
      { path: 'suppliers.SUPPLIER_1', before: undefined, after: { name: 'Valento', web: '', notes: '' }, kind: 'add' }
    ]);
    expect(html).toContain('Nuevo');
    expect(html).toContain('Proveedor');
    expect(html).toContain('Valento');
    expect(html).not.toContain('{');
    expect(html).not.toContain('suppliers.SUPPLIER_1');
  });

  test('humanizes a field change (friendly label + formatted values)', () => {
    const html = renderDiffPreview([
      { path: 'products.BEAGLE.target_margin', before: 0.35, after: 0.4, kind: 'change' }
    ]);
    expect(html).toContain('Margen objetivo');
    expect(html).toContain('35 %');
    expect(html).toContain('40 %');
    expect(html).not.toContain('target_margin');
  });
});

describe('renderAuditTab', () => {
  test('empty entries shows a Spanish hint', () => {
    expect(renderAuditTab([])).toContain('No hay entradas de auditoría');
  });

  test('humanizes file-audit change rows from the full path', () => {
    // File audit changes carry FULL paths; entityType is derived from them.
    const html = renderAuditTab([
      {
        user: 'Mostrador-1',
        ts: '2026-06-13T09:05:00.000Z',
        app_version: '5.0.0',
        changes: [{ path: 'packs.crew.name', before: 'A', after: 'B', kind: 'change' }]
      }
    ]);
    expect(html).toContain('Mostrador-1');
    expect(html).toContain('Nombre');
    expect(html).toContain('«A»');
    expect(html).toContain('«B»');
    expect(html).not.toContain('packs.crew.name');
  });
});
