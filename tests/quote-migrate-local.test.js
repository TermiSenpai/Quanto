// ============================================================
// Tests · lib/quote-migrate-local.js
// ============================================================
// Pure migration-logic tests: a fixture array of local quotes is
// pushed through an injected `putIfAbsent` adapter (backed by an
// in-memory map) so the tally + idempotency + error-collection
// behaviour is exercised without fs or the network.
// ============================================================

import { describe, test, expect } from 'vitest';
import { migrateLocalQuotes } from '../lib/quote-migrate-local.js';

// A handful of local-history-shaped quotes (the only field migration
// cares about is the existing human id).
const QUOTES = [
  { id: 'PP-2026-0001', user: 'A', totals: { total_vat_inc: 100 } },
  { id: 'PP-2026-0002', user: 'B', totals: { total_vat_inc: 200 } },
  { id: 'PP-2026-0003', user: 'C', totals: { total_vat_inc: 300 } },
];

// In-memory backend: a Map keyed by the quote's existing id. putIfAbsent
// inserts only when the id is absent, mirroring the file `wx` / cloud
// INSERT OR IGNORE adapters.
function makeFakeStore() {
  const store = new Map();
  const putIfAbsent = async (quote) => {
    if (store.has(quote.id)) return { migrated: false };
    store.set(quote.id, quote);
    return { migrated: true };
  };
  return { store, putIfAbsent };
}

describe('migrateLocalQuotes', () => {
  test('inserts each quote once and reports them migrated', async () => {
    const { store, putIfAbsent } = makeFakeStore();
    const summary = await migrateLocalQuotes(QUOTES, putIfAbsent);
    expect(summary).toMatchObject({ total: 3, migrated: 3, skipped: 0, failed: 0 });
    expect(summary.errors).toEqual([]);
    expect([...store.keys()]).toEqual(['PP-2026-0001', 'PP-2026-0002', 'PP-2026-0003']);
    // The stored value preserves the existing id (no re-stamping).
    expect(store.get('PP-2026-0001').id).toBe('PP-2026-0001');
  });

  test('is idempotent: a second run inserts nothing', async () => {
    const { store, putIfAbsent } = makeFakeStore();
    await migrateLocalQuotes(QUOTES, putIfAbsent);
    const second = await migrateLocalQuotes(QUOTES, putIfAbsent);
    expect(second).toMatchObject({ total: 3, migrated: 0, skipped: 3, failed: 0 });
    expect(second.errors).toEqual([]);
    expect(store.size).toBe(3);
  });

  test('a partially-populated store skips the present ids and migrates the rest', async () => {
    const { store, putIfAbsent } = makeFakeStore();
    store.set('PP-2026-0002', QUOTES[1]); // pre-existing
    const summary = await migrateLocalQuotes(QUOTES, putIfAbsent);
    expect(summary).toMatchObject({ total: 3, migrated: 2, skipped: 1, failed: 0 });
    expect(store.size).toBe(3);
  });

  test('a throwing putIfAbsent counts that entry as failed and keeps going', async () => {
    const store = new Map();
    const putIfAbsent = async (quote) => {
      if (quote.id === 'PP-2026-0002') {
        throw new Error('boom');
      }
      store.set(quote.id, quote);
      return { migrated: true };
    };
    const summary = await migrateLocalQuotes(QUOTES, putIfAbsent);
    expect(summary).toMatchObject({ total: 3, migrated: 2, skipped: 0, failed: 1 });
    // The other two still made it in.
    expect([...store.keys()]).toEqual(['PP-2026-0001', 'PP-2026-0003']);
    // The error is collected (id + message), never swallowed.
    expect(summary.errors).toEqual([{ id: 'PP-2026-0002', message: 'boom' }]);
  });

  test('an empty list is a clean no-op', async () => {
    const { putIfAbsent } = makeFakeStore();
    const summary = await migrateLocalQuotes([], putIfAbsent);
    expect(summary).toEqual({ total: 0, migrated: 0, skipped: 0, failed: 0, errors: [] });
  });
});
