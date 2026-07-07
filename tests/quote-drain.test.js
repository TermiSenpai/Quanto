// ============================================================
// Tests · lib/quote-drain.js (offline quote-drain decision logic)
// ============================================================
// The pure core of main.js's offline quote handling, extracted so the
// create-vs-edit drain routing is unit-tested (the C1 regression: an
// offline EDIT must NOT drain through create-only saveFullQuote).
// ============================================================

import { describe, test, expect, vi } from 'vitest';
import {
  isBackendUnreachable,
  isPermissionError,
  classifyQueuedOp,
  drainQueuedFullQuote,
} from '../lib/quote-drain.js';

// ── isBackendUnreachable ──────────────────────────────────────
describe('isBackendUnreachable', () => {
  test('true for a cloud network error (D1ClientError.network)', () => {
    expect(isBackendUnreachable({ network: true })).toBe(true);
  });

  test('true for transient fs codes (NAS down)', () => {
    for (const code of ['ENOENT', 'ETIMEDOUT', 'EBUSY', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET']) {
      expect(isBackendUnreachable({ code })).toBe(true);
    }
  });

  test('false for permission errors (EACCES/EPERM are a persistent misconfig, NOT transient)', () => {
    expect(isBackendUnreachable({ code: 'EACCES' })).toBe(false);
    expect(isBackendUnreachable({ code: 'EPERM' })).toBe(false);
  });

  test('false for a plain validation/size error and for null', () => {
    expect(isBackendUnreachable(new Error('El presupuesto es demasiado grande.'))).toBe(false);
    expect(isBackendUnreachable(null)).toBe(false);
  });
});

describe('isPermissionError', () => {
  test('true only for EACCES/EPERM', () => {
    expect(isPermissionError({ code: 'EACCES' })).toBe(true);
    expect(isPermissionError({ code: 'EPERM' })).toBe(true);
    expect(isPermissionError({ code: 'ENOENT' })).toBe(false);
    expect(isPermissionError(null)).toBe(false);
  });
});

// ── classifyQueuedOp ──────────────────────────────────────────
describe('classifyQueuedOp', () => {
  test('marker wins', () => {
    expect(classifyQueuedOp({ id: 'PP-2026-0001', __op: 'create' })).toBe('create');
    expect(classifyQueuedOp({ id: 'PP-PENDING-x', __op: 'edit' })).toBe('edit');
  });

  test('falls back to the id shape when no marker', () => {
    expect(classifyQueuedOp({ id: 'PP-PENDING-abc' })).toBe('create');
    expect(classifyQueuedOp({ id: 'PP-2026-0001' })).toBe('edit');
  });
});

// ── drainQueuedFullQuote ──────────────────────────────────────
function makeDeps(overrides = {}) {
  return {
    createQuote: vi.fn(async (draft) => ({ ...draft, id: 'PP-2026-0042', version: 1 })),
    replaceQuote: vi.fn(async (id, q, _token) => ({ quote: { ...q, id, version: 2 } })),
    reconcileCachedQuote: vi.fn(),
    upsertCachedQuote: vi.fn(),
    ...overrides,
  };
}

describe('drainQueuedFullQuote', () => {
  // (C1 regression) An offline EDIT must drain through the UPDATE path so the
  // edited payload is actually written and version bumps — NEVER create-only.
  test('a real-id EDIT drains through replaceQuote (force), updating the payload + bumping version', async () => {
    const deps = makeDeps();
    const edit = { id: 'PP-2026-0007', __op: 'edit', user: 'Editado', totals: { total_vat_inc: 999 } };
    const saved = await drainQueuedFullQuote(deps, edit);

    // routed to the UPDATE path, NOT createQuote
    expect(deps.createQuote).not.toHaveBeenCalled();
    expect(deps.replaceQuote).toHaveBeenCalledTimes(1);
    const [id, quote, token] = deps.replaceQuote.mock.calls[0];
    expect(id).toBe('PP-2026-0007');
    expect(token).toBeNull(); // force / current-version re-read
    // the transient __op marker was stripped before the write
    expect(quote.__op).toBeUndefined();
    expect(quote.user).toBe('Editado');
    // the saved (bumped) quote is cached
    expect(saved.version).toBe(2);
    expect(deps.upsertCachedQuote).toHaveBeenCalledWith(saved);
  });

  test('a real-id EDIT with NO marker still drains as an edit (id-shape fallback)', async () => {
    const deps = makeDeps();
    await drainQueuedFullQuote(deps, { id: 'PP-2026-0009', user: 'X' });
    expect(deps.createQuote).not.toHaveBeenCalled();
    expect(deps.replaceQuote).toHaveBeenCalledTimes(1);
  });

  test('a pending-id CREATE drains through createQuote, assigns a real id, and reconciles the cache (no duplicate)', async () => {
    const deps = makeDeps();
    const create = { id: 'PP-PENDING-uuid', __op: 'create', version: 1, user: 'Nuevo', date: 'x', updated_at: 'x' };
    const saved = await drainQueuedFullQuote(deps, create);

    expect(deps.replaceQuote).not.toHaveBeenCalled();
    expect(deps.createQuote).toHaveBeenCalledTimes(1);
    // the provisional id/version/marker are stripped from the create draft
    const draft = deps.createQuote.mock.calls[0][0];
    expect(draft.id).toBeUndefined();
    expect(draft.__op).toBeUndefined();
    expect(draft.version).toBeUndefined();
    expect(draft.user).toBe('Nuevo');
    // cache reconciled: provisional id dropped, real saved inserted
    expect(saved.id).toBe('PP-2026-0042');
    expect(deps.reconcileCachedQuote).toHaveBeenCalledWith('PP-PENDING-uuid', saved);
  });

  test('an EDIT whose quote vanished from the cloud (null) throws (kept queued, never silently dropped)', async () => {
    const deps = makeDeps({ replaceQuote: vi.fn(async () => null) });
    await expect(drainQueuedFullQuote(deps, { id: 'PP-2026-0007', __op: 'edit' }))
      .rejects.toThrow(/ya no existe/i);
  });

  test('an unexpected conflict on a forced edit throws (kept queued)', async () => {
    const deps = makeDeps({ replaceQuote: vi.fn(async () => ({ conflict: true })) });
    await expect(drainQueuedFullQuote(deps, { id: 'PP-2026-0007', __op: 'edit' }))
      .rejects.toThrow(/conflicto/i);
  });

  test('a failing create propagates (so the outbox keeps the item)', async () => {
    const deps = makeDeps({ createQuote: vi.fn(async () => { const e = new Error('offline'); e.network = true; throw e; }) });
    await expect(drainQueuedFullQuote(deps, { id: 'PP-PENDING-x', __op: 'create' }))
      .rejects.toThrow(/offline/i);
    expect(deps.reconcileCachedQuote).not.toHaveBeenCalled();
  });
});
