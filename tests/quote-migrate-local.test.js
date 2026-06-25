// ============================================================
// Tests · lib/quote-migrate-local.js
// ============================================================
// Pure migration-logic tests: a fixture array of local quotes is
// pushed through an injected `putIfAbsent` adapter (backed by an
// in-memory map) so the tally + idempotency + error-collection
// behaviour is exercised without fs or the network.
// ============================================================

import { describe, test, expect } from 'vitest';
import { migrateLocalQuotes, partitionMigratableQuotes } from '../lib/quote-migrate-local.js';
import { isValidId } from '../lib/quote-repo-file.js';

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

// ── partitionMigratableQuotes ─────────────────────────────────
describe('partitionMigratableQuotes', () => {
  test('keeps real objects with a valid id; quarantines the rest', () => {
    const valid1 = { id: 'PP-2026-0001', user: 'A' };
    const valid2 = { id: 'PP-2026-0002', user: 'B' };
    const input = [
      valid1,
      null,                       // not an object
      'oops',                     // not an object
      [],                         // array, not a plain quote object
      { id: 'not-an-id', x: 1 },  // bad id shape
      { user: 'no id' },          // missing id
      valid2,
    ];
    const { migratable, invalid } = partitionMigratableQuotes(input, isValidId);
    expect(migratable).toEqual([valid1, valid2]);
    expect(invalid).toHaveLength(5);
  });

  test('falls back to the built-in PP-YYYY-NNNN guard when none is injected', () => {
    const { migratable, invalid } = partitionMigratableQuotes([
      { id: 'PP-2025-0042' },
      { id: 'PP-25-1' }, // year not 4 digits
    ]);
    expect(migratable.map(q => q.id)).toEqual(['PP-2025-0042']);
    expect(invalid).toHaveLength(1);
  });

  test('a non-array input yields empty partitions', () => {
    expect(partitionMigratableQuotes(null)).toEqual({ migratable: [], invalid: [] });
    expect(partitionMigratableQuotes(undefined)).toEqual({ migratable: [], invalid: [] });
  });

  test('reuses lib/quote-repo-file.js isValidId (same rule as the adapter)', () => {
    // The exported guard must accept exactly what the file adapter writes.
    expect(isValidId('PP-2026-0001')).toBe(true);
    expect(isValidId('../escape')).toBe(false);
    expect(isValidId(null)).toBe(false);
  });
});

// ── pre-filter + migrate: invalid entries are skipped, not failed ──
describe('pre-filtered migration (invalid entries do not wedge the gate)', () => {
  test('valid quotes migrate cleanly (failed===0) while invalid ones are quarantined', async () => {
    const { store, putIfAbsent } = makeFakeStore();
    const mixed = [
      { id: 'PP-2026-0001', user: 'A' },
      null,                              // structurally invalid
      { id: '../escape', user: 'EVIL' }, // bad id — would THROW in the real adapter
      { id: 'PP-2026-0002', user: 'B' },
    ];
    const { migratable, invalid } = partitionMigratableQuotes(mixed, isValidId);
    expect(invalid).toHaveLength(2);

    // Only the migratable subset reaches the (id-preserving) adapter, so it
    // never throws → failed stays 0 → the caller's rename gate (failed===0)
    // holds even though the source contained junk.
    const summary = await migrateLocalQuotes(migratable, putIfAbsent);
    expect(summary).toMatchObject({ total: 2, migrated: 2, skipped: 0, failed: 0 });
    expect([...store.keys()]).toEqual(['PP-2026-0001', 'PP-2026-0002']);
  });
});
