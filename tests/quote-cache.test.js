// ============================================================
// Tests · lib/quote-cache.js (per-PC quote cache mirror)
// ============================================================
// The quote cache mirrors the last backend read to disk so the
// history list is fast and shows a last-known view when the cloud
// is briefly unreachable. It is NOT a write buffer (the outbox
// handles offline writes). Atomic .tmp+rename, same pattern as
// lib/catalog-cache.js and lib/quote-outbox.js.
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  quoteCachePathFor,
  writeQuoteCache,
  readQuoteCache,
} from '../lib/quote-cache.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanto-quote-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = {
  fetchedAt: '2026-06-25T10:00:00.000Z',
  list: [
    { id: 'q1', customer: 'Cliente A', total: 120.5, status: 'draft', date: '2026-06-24' },
    { id: 'q2', customer: 'Cliente B', total: 85.0,  status: 'accepted', date: '2026-06-23' },
  ],
  payloads: {
    q1: { id: 'q1', customer: 'Cliente A', opt: { items: [] }, result: {}, totals: {} },
  },
};

// ---------------------------------------------------------------------------
// quoteCachePathFor
// ---------------------------------------------------------------------------
describe('quoteCachePathFor', () => {
  test('points at <userDataDir>/cache/quotes.json', () => {
    expect(quoteCachePathFor(dir)).toBe(path.join(dir, 'cache', 'quotes.json'));
  });
});

// ---------------------------------------------------------------------------
// write → read round-trip
// ---------------------------------------------------------------------------
describe('writeQuoteCache / readQuoteCache', () => {
  test('round-trip preserves fetchedAt, list, and payloads exactly', () => {
    writeQuoteCache(dir, SAMPLE);
    expect(readQuoteCache(dir)).toEqual(SAMPLE);
  });

  test('round-trip works with an empty list and empty payloads', () => {
    const empty = { fetchedAt: '2026-06-25T00:00:00.000Z', list: [], payloads: {} };
    writeQuoteCache(dir, empty);
    expect(readQuoteCache(dir)).toEqual(empty);
  });

  test('creates the cache directory when it does not exist', () => {
    writeQuoteCache(dir, SAMPLE);
    expect(fs.existsSync(quoteCachePathFor(dir))).toBe(true);
  });

  test('is atomic: no orphan .tmp remains after a write', () => {
    writeQuoteCache(dir, SAMPLE);
    expect(fs.existsSync(quoteCachePathFor(dir) + '.tmp')).toBe(false);
  });

  test('a subsequent write replaces cleanly (no stale data)', () => {
    writeQuoteCache(dir, SAMPLE);
    const updated = { ...SAMPLE, fetchedAt: '2026-06-25T12:00:00.000Z', list: [] };
    writeQuoteCache(dir, updated);
    const read = readQuoteCache(dir);
    expect(read.fetchedAt).toBe('2026-06-25T12:00:00.000Z');
    expect(read.list).toEqual([]);
  });

  // payloads is optional: tolerate missing or empty-object payloads on read
  test('tolerates missing payloads field (reads back as undefined or {})', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ fetchedAt: '2026-06-25T10:00:00.000Z', list: [] }, null, 2),
      'utf-8'
    );
    const result = readQuoteCache(dir);
    // Shape check only requires list array — payloads absence is tolerated.
    expect(result).not.toBeNull();
    expect(Array.isArray(result.list)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// missing / empty file → null
// ---------------------------------------------------------------------------
describe('readQuoteCache — absent or empty file', () => {
  test('returns null when the cache file does not exist', () => {
    expect(readQuoteCache(dir)).toBeNull();
  });

  test('returns null when the cache file is empty', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '', 'utf-8');
    expect(readQuoteCache(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// corrupt / bad-shape → throws Spanish error
// ---------------------------------------------------------------------------
describe('readQuoteCache — corrupt or bad-shape file', () => {
  test('throws a Spanish error with cause on invalid JSON', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ truncado', 'utf-8');

    let thrown = null;
    try {
      readQuoteCache(dir);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(/Caché de presupuestos dañada/);
    expect(thrown.cause).toBeInstanceOf(Error);
  });

  test('throws Spanish error for valid JSON that is not an object (string scalar)', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '"hola"', 'utf-8');
    expect(() => readQuoteCache(dir)).toThrow(/Caché de presupuestos dañada/);
  });

  test('throws Spanish error when list is not an array', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ fetchedAt: 't', list: 'no es array', payloads: {} }), 'utf-8');
    expect(() => readQuoteCache(dir)).toThrow(/Caché de presupuestos dañada/);
  });

  test('throws Spanish error for null JSON', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'null', 'utf-8');
    expect(() => readQuoteCache(dir)).toThrow(/Caché de presupuestos dañada/);
  });

  test('throws Spanish error when list key is missing entirely', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ fetchedAt: 't', payloads: {} }), 'utf-8');
    expect(() => readQuoteCache(dir)).toThrow(/Caché de presupuestos dañada/);
  });

  test('throws Spanish error when payloads is present but wrong-typed', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // A consumer doing `cache.payloads[id]` would read garbage — corruption,
    // not forward-compat. An ABSENT payloads is fine; a wrong-typed one is not.
    const wrongPayloads = [
      JSON.stringify({ fetchedAt: 't', list: [], payloads: 42 }),
      JSON.stringify({ fetchedAt: 't', list: [], payloads: 'nope' }),
      JSON.stringify({ fetchedAt: 't', list: [], payloads: [] }),
      JSON.stringify({ fetchedAt: 't', list: [], payloads: null }),
    ];
    for (const raw of wrongPayloads) {
      fs.writeFileSync(filePath, raw, 'utf-8');
      expect(() => readQuoteCache(dir), raw).toThrow(/Caché de presupuestos dañada/);
    }
  });

  test('throws Spanish error when fetchedAt is missing or non-string', () => {
    const filePath = quoteCachePathFor(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // fetchedAt is the staleness key — a missing/non-string one defeats the
    // cache's whole purpose, so it is treated as corruption (mirrors the
    // catalogVersion-is-a-number guard in catalog-cache.js).
    const badFetchedAt = [
      JSON.stringify({ list: [], payloads: {} }), // missing entirely
      JSON.stringify({ fetchedAt: 12345, list: [], payloads: {} }), // number
      JSON.stringify({ fetchedAt: null, list: [], payloads: {} }), // null
    ];
    for (const raw of badFetchedAt) {
      fs.writeFileSync(filePath, raw, 'utf-8');
      expect(() => readQuoteCache(dir), raw).toThrow(/Caché de presupuestos dañada/);
    }
  });
});
