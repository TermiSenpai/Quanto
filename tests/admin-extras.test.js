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
  formatSnapshotLabel
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
    const html = renderCloudAuditList([
      {
        id: 2,
        ts: '2026-06-13T09:05:00.000Z',
        user: 'Mostrador-2',
        entityType: 'pack',
        entityId: 'crew',
        action: 'update',
        diff: [{ path: 'packs.crew.name', before: 'A', after: 'B', kind: 'change' }],
        catalogVersion: 8
      }
    ]);
    expect(html).toContain('Mostrador-2');
    expect(html).toContain('editó');
    expect(html).toContain('Pack «crew»');
    expect(html).toContain('packs.crew.name');
    expect(html).toContain('v8');
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
