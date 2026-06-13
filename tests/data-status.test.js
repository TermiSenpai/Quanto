// ============================================================
// Data-status indicator state machine (renderer/data-status.js)
// ============================================================
// Pure mapping from a catalog load-result to the topbar indicator
// state. This is the testable seam behind the DOM glue in app.js:
// it decides the badge `kind`, the Spanish `label` and the `tone`
// (success / warning / neutral) per UI-UX §2.1, and is the single
// place that formats the "dd/mm hh:mm" freshness stamp (§2.8).
// Pure: no DOM, no IPC — just data in, display data out.
// ============================================================
import { describe, test, expect } from 'vitest';
import { deriveDataStatus, formatFreshness } from '../renderer/data-status.js';

describe('deriveDataStatus', () => {
  test('cloud + online → success "Datos al día · v{N}"', () => {
    const s = deriveDataStatus({ source: 'cloud', catalogVersion: 128 });
    expect(s.kind).toBe('connected');
    expect(s.tone).toBe('success');
    expect(s.label).toBe('Datos al día · v128');
    // Accessibility (§2.8): distinguished by text + icon, not color alone.
    expect(s.icon).toBeTruthy();
  });

  test('cache (offline) → warning "Sin conexión · datos del {dd/mm hh:mm}"', () => {
    const s = deriveDataStatus({
      source: 'cache',
      catalogVersion: 120,
      fetchedAt: '2026-06-12T14:32:00.000Z',
      offline: true
    });
    expect(s.kind).toBe('offline');
    expect(s.tone).toBe('warning');
    expect(s.label).toMatch(/^Sin conexión · datos del \d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(s.icon).toBeTruthy();
  });

  test('cache from a cloud-invalid catalog is still treated as offline-style', () => {
    const s = deriveDataStatus({
      source: 'cache',
      catalogVersion: 120,
      fetchedAt: '2026-06-12T14:32:00.000Z',
      reason: 'cloud-invalid'
    });
    expect(s.kind).toBe('offline');
    expect(s.tone).toBe('warning');
    expect(s.label).toMatch(/^Sin conexión · datos del /);
  });

  test('file mode → neutral "Modo local"', () => {
    const s = deriveDataStatus({ source: 'file' });
    expect(s.kind).toBe('local');
    expect(s.tone).toBe('neutral');
    expect(s.label).toBe('Modo local');
    expect(s.icon).toBeTruthy();
  });

  test('missing source defaults to local (file mode is the safe default)', () => {
    const s = deriveDataStatus({});
    expect(s.kind).toBe('local');
    expect(s.tone).toBe('neutral');
  });

  test('cache without a fetchedAt still produces a stable offline label', () => {
    const s = deriveDataStatus({ source: 'cache', offline: true });
    expect(s.kind).toBe('offline');
    // No date available → degrade gracefully, never "Invalid Date".
    expect(s.label).toBe('Sin conexión · datos sin fecha');
  });
});

describe('formatFreshness', () => {
  test('formats an ISO timestamp as local dd/mm hh:mm', () => {
    // Built from explicit local-time parts so the assertion is
    // timezone-independent: whatever the runner's TZ, the formatter
    // reads the same local fields back out.
    const d = new Date(2026, 5, 12, 14, 32); // 12 Jun 2026, 14:32 local
    expect(formatFreshness(d.toISOString())).toBe('12/06 14:32');
  });

  test('pads single-digit day, month, hour and minute', () => {
    const d = new Date(2026, 0, 3, 9, 5); // 03 Jan 2026, 09:05 local
    expect(formatFreshness(d.toISOString())).toBe('03/01 09:05');
  });

  test('returns "sin fecha" for a missing or invalid input', () => {
    expect(formatFreshness(null)).toBe('sin fecha');
    expect(formatFreshness(undefined)).toBe('sin fecha');
    expect(formatFreshness('not-a-date')).toBe('sin fecha');
  });
});
