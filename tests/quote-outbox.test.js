// ============================================================
// Tests · lib/quote-outbox.js (offline quote queue)
// ============================================================
// The outbox persists quotes/statuses that could not reach D1 (offline)
// and drains them on reconnect. fs store, atomic .tmp+rename like
// lib/catalog-cache.js. A fake client mirroring lib/cloud-quotes.js'
// uploadQuote/updateQuoteStatus drives flushOutbox.
// ============================================================

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  outboxPathFor,
  enqueueQuote,
  enqueueStatus,
  readOutbox,
  clearOutbox,
  flushOutbox
} from '../lib/quote-outbox.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-outbox-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sampleQuote(id) {
  return { id, ts: 't', user: 'u', customer: { name: 'C', phone: 'p' }, pack_id: 'p1', total_units: 10 };
}

describe('outboxPathFor', () => {
  test('points at <dir>/cache/outbox.json', () => {
    expect(outboxPathFor(dir)).toBe(path.join(dir, 'cache', 'outbox.json'));
  });
});

describe('enqueue / read / clear', () => {
  test('empty outbox reads as { quotes: [], statuses: [] }', () => {
    expect(readOutbox(dir)).toEqual({ quotes: [], statuses: [] });
  });

  test('enqueueQuote appends and persists', () => {
    enqueueQuote(dir, sampleQuote('q1'));
    enqueueQuote(dir, sampleQuote('q2'));
    const out = readOutbox(dir);
    expect(out.quotes.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(out.statuses).toEqual([]);
    // Persisted atomically: the file exists, no .tmp left behind.
    expect(fs.existsSync(outboxPathFor(dir))).toBe(true);
    expect(fs.existsSync(outboxPathFor(dir) + '.tmp')).toBe(false);
  });

  test('enqueueStatus appends a {id,status,ts} entry', () => {
    enqueueStatus(dir, { id: 'q1', status: 'accepted', ts: '2026-06-13T00:00:00.000Z' });
    expect(readOutbox(dir).statuses).toEqual([{ id: 'q1', status: 'accepted', ts: '2026-06-13T00:00:00.000Z' }]);
  });

  test('clearOutbox resets to the empty shape', () => {
    enqueueQuote(dir, sampleQuote('q1'));
    clearOutbox(dir);
    expect(readOutbox(dir)).toEqual({ quotes: [], statuses: [] });
  });

  test('a corrupt outbox throws a Spanish error (never silently treated as data)', () => {
    const p = outboxPathFor(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ truncated', 'utf-8');
    expect(() => readOutbox(dir)).toThrow(/cola de presupuestos dañada/i);
  });
});

// Fake cloud-quotes deps: records calls, lets a test mark some ids to
// fail (network down) so flushOutbox's partial-drain behaviour is testable.
function makeDeps({ failQuoteIds = new Set(), failStatusIds = new Set() } = {}) {
  const uploaded = [];
  const statuses = [];
  return {
    uploaded,
    statuses,
    async uploadQuote(_client, quote) {
      if (failQuoteIds.has(quote.id)) throw new Error('No se pudo conectar con Cloudflare');
      uploaded.push(quote.id);
      return { ok: true, id: quote.id };
    },
    async updateQuoteStatus(_client, { id, status }) {
      if (failStatusIds.has(id)) throw new Error('No se pudo conectar con Cloudflare');
      statuses.push({ id, status });
      return { ok: true, id, status };
    }
  };
}

describe('flushOutbox', () => {
  const client = {}; // opaque; the deps decide what happens

  test('empty outbox: nothing to do', async () => {
    const deps = makeDeps();
    const res = await flushOutbox(dir, client, deps);
    expect(res).toEqual({ uploaded: 0, statusesApplied: 0, remaining: 0 });
    expect(deps.uploaded).toEqual([]);
  });

  test('success drains the whole outbox', async () => {
    enqueueQuote(dir, sampleQuote('q1'));
    enqueueQuote(dir, sampleQuote('q2'));
    enqueueStatus(dir, { id: 'q1', status: 'accepted', ts: 't' });
    const deps = makeDeps();
    const res = await flushOutbox(dir, client, deps);
    expect(res).toEqual({ uploaded: 2, statusesApplied: 1, remaining: 0 });
    expect(deps.uploaded).toEqual(['q1', 'q2']);
    expect(deps.statuses).toEqual([{ id: 'q1', status: 'accepted' }]);
    expect(readOutbox(dir)).toEqual({ quotes: [], statuses: [] });
  });

  test('a failing item stays queued, successful ones drain (UUID idempotency makes retry safe)', async () => {
    enqueueQuote(dir, sampleQuote('q1'));
    enqueueQuote(dir, sampleQuote('q2')); // this one will fail
    enqueueStatus(dir, { id: 'q1', status: 'accepted', ts: 't' });
    enqueueStatus(dir, { id: 'q9', status: 'rejected', ts: 't' }); // this one will fail
    const deps = makeDeps({ failQuoteIds: new Set(['q2']), failStatusIds: new Set(['q9']) });

    const res = await flushOutbox(dir, client, deps);
    expect(res).toEqual({ uploaded: 1, statusesApplied: 1, remaining: 2 });
    // The successful ones drained; the failures stay queued for retry.
    const remaining = readOutbox(dir);
    expect(remaining.quotes.map((q) => q.id)).toEqual(['q2']);
    expect(remaining.statuses.map((s) => s.id)).toEqual(['q9']);
  });

  test('re-flush after a transient failure recovers (idempotent retry)', async () => {
    enqueueQuote(dir, sampleQuote('q2'));
    // First flush fails for q2.
    await flushOutbox(dir, client, makeDeps({ failQuoteIds: new Set(['q2']) }));
    expect(readOutbox(dir).quotes.map((q) => q.id)).toEqual(['q2']);
    // Second flush succeeds and drains it.
    const res = await flushOutbox(dir, client, makeDeps());
    expect(res).toEqual({ uploaded: 1, statusesApplied: 0, remaining: 0 });
    expect(readOutbox(dir)).toEqual({ quotes: [], statuses: [] });
  });

  test('a corrupt outbox is tolerated (never crashes the flush)', async () => {
    const p = outboxPathFor(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ broken', 'utf-8');
    const deps = makeDeps();
    const res = await flushOutbox(dir, client, deps);
    expect(res.uploaded).toBe(0);
    expect(res.statusesApplied).toBe(0);
    expect(res.error).toMatch(/cola de presupuestos dañada/i);
  });
});
