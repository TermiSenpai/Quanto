// ============================================================
// Tests · lib/quote-repo-cloud.js (cloud-mode quote repository façade)
// ============================================================
// Phase B (shared quote store), cloud backend façade: the cloud
// parallel of lib/quote-repo-file.js. Same interface + return shapes,
// but client-injected (D1) instead of folder-backed, orchestrating the
// lib/cloud-quotes.js ops (no raw SQL here).
//
// The fake D1 client below mirrors the fake in tests/quote-repo-cloud.test.js
// (it is self-contained): it models BOTH the flat `quotes` row (INSERT OR
// IGNORE on the human
// id PK, with a real changes count) and the `quote_payloads` row
// (INSERT OR IGNORE create-only + version-guarded UPDATE), plus the
// DELETEs the façade's deleteQuote drives. It records every statement
// so a test can assert what SQL ran (e.g. list never touches payloads).
// ============================================================

import { describe, test, expect } from 'vitest';
import {
  createQuote,
  getQuote,
  listQuotes,
  searchQuotes,
  replaceQuote,
  setStatus,
  setDepositPaid,
  deleteQuote,
} from '../lib/quote-repo-cloud.js';
import { tryClaimFullQuote, deleteFullQuote } from '../lib/cloud-quotes.js';

// ── The canonical reopenable cloud quote (superset: flat + reopen) ──
function sampleDraft(overrides = {}) {
  return {
    ts: '2026-06-12T10:00:00.000Z',
    user: 'Alberto',
    config_version: 7,
    catalog_version: 7,
    customer: { name: 'Peña La Cuesta', phone: '600123123' },
    valid_until: '2026-06-27T10:00:00.000Z',
    pack_id: 'crew_full',
    tier: 'T1',
    total_units: 24,
    qty_3xl: 2,
    qty_4xl: 1,
    qty_5xl: 0,
    total_vat_inc: 622.8,
    sale_base: 514.7,
    margin_pct: 0.38,
    target_margin: 0.35,
    pvp_deviation_pct: -0.05,
    opt: { packId: 'crew_full', quantities: { T1: 24 }, options: { shirt: 'beagle' } },
    result: { lines: [{ id: 'shirt', pvp: 12.5 }], tier: 'T1' },
    totals: { total_vat_inc: 622.8, sale_base: 514.7, vat: 108.1, total_cost: 320, margin: 0.38 },
    status: 'pending',
    status_ts: null,
    items: [{ product_id: 'BEAGLE', sides: 'two_sides', qty: 24 }],
    addons: [{ addon_id: 'name', qty: 24 }],
    ...overrides,
  };
}

// A draft already carrying a fixed `ts` produces a flat row that needs an `id`
// the façade stamps; for direct buildQuoteRows-style ops a complete quote with
// `id` is built by spreading sampleDraft + { id }.
function sampleFullQuote(overrides = {}) {
  return { id: 'PP-2026-0001', date: '2026-06-12T10:00:00.000Z', version: 1, updated_at: '2026-06-12T10:00:00.000Z', ...sampleDraft(), ...overrides };
}

// ── Fake D1 client modelling quotes + quote_payloads + child tables ──
// Mirrors tests/quote-repo-cloud.js but adds: a real changes count on the
// payload claim (INSERT OR IGNORE quote_payloads → changes 0 when the id is
// already taken), the child line tables (quote_items/quote_addons), and the
// DELETE statements deleteFullQuote emits.
function fakeClient() {
  const quotes = new Map();   // id → flat row
  const payloads = new Map(); // quote_id → { payload, version, updated_at }
  const items = [];           // { quote_id, ... }
  const addons = [];          // { quote_id, ... }
  const calls = [];
  const deposits = new Map(); // quote_id → { amount, paid_at, paid_by }

  // getFullQuote/listFullQuotes LEFT JOIN quote_deposits: expose the
  // deposit columns (null when unpaid) on every flat row they return.
  function withDeposit(row) {
    const d = deposits.get(row.id);
    return {
      ...row,
      deposit_amount: d ? d.amount : null,
      deposit_paid_at: d ? d.paid_at : null,
      deposit_paid_by: d ? d.paid_by : null
    };
  }

  function insertOrIgnoreQuotes(sql, params) {
    const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim());
    const row = {};
    cols.forEach((c, i) => { row[c] = params[i]; });
    const existed = quotes.has(row.id);
    if (!existed) quotes.set(row.id, { status: 'pending', status_ts: null, ...row });
    return { results: [], meta: { changes: existed ? 0 : 1 } };
  }

  return {
    calls,
    quotes,
    payloads,
    items,
    addons,
    deposits,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/INSERT OR IGNORE INTO quotes/.test(sql)) {
        return insertOrIgnoreQuotes(sql, params);
      }
      if (/INSERT OR IGNORE INTO quote_items/.test(sql)) {
        // one or more rows; the façade/saveFullQuote insert one row at a time here
        items.push({ quote_id: params[0], product_id: params[1], sides: params[2], qty: params[3] });
        return { results: [], meta: { changes: 1 } };
      }
      if (/INSERT OR IGNORE INTO quote_addons/.test(sql)) {
        addons.push({ quote_id: params[0], addon_id: params[1], qty: params[2] });
        return { results: [], meta: { changes: 1 } };
      }
      if (/INSERT OR IGNORE INTO quote_payloads/.test(sql)) {
        // params: [quote_id, payload, updated_at] (version is the SQL literal 1)
        const [quote_id, payload, updated_at] = params;
        if (payloads.has(quote_id)) return { results: [], meta: { changes: 0 } };
        payloads.set(quote_id, { payload, version: 1, updated_at });
        return { results: [], meta: { changes: 1 } };
      }
      if (/UPDATE quote_payloads SET payload/.test(sql)) {
        const [payload, updated_at, quote_id, expectedVersion] = params;
        const cur = payloads.get(quote_id);
        if (cur && cur.version === expectedVersion) {
          payloads.set(quote_id, { payload, version: cur.version + 1, updated_at });
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 0 } };
      }
      if (/UPDATE quotes SET/.test(sql)) {
        const setCols = sql
          .replace(/^[^]*SET\s+/i, '')
          .replace(/\s+WHERE[^]*$/i, '')
          .split(',')
          .map((p) => p.trim().replace(/\s*=\s*\?$/, ''));
        const id = params[params.length - 1];
        const row = quotes.get(id);
        if (row) {
          const next = { ...row };
          setCols.forEach((col, i) => { next[col] = params[i]; });
          quotes.set(id, next);
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 0 } };
      }
      if (/DELETE FROM quote_items/.test(sql)) {
        const id = params[0];
        for (let i = items.length - 1; i >= 0; i--) if (items[i].quote_id === id) items.splice(i, 1);
        return { results: [], meta: { changes: 1 } };
      }
      if (/DELETE FROM quote_addons/.test(sql)) {
        const id = params[0];
        for (let i = addons.length - 1; i >= 0; i--) if (addons[i].quote_id === id) addons.splice(i, 1);
        return { results: [], meta: { changes: 1 } };
      }
      if (/DELETE FROM quote_payloads/.test(sql)) {
        const had = payloads.delete(params[0]);
        return { results: [], meta: { changes: had ? 1 : 0 } };
      }
      if (/INSERT INTO quote_deposits/.test(sql)) {
        // upsert: [quote_id, amount, paid_at, paid_by]
        const [quote_id, amount, paid_at, paid_by] = params;
        deposits.set(quote_id, { amount, paid_at, paid_by });
        return { results: [], meta: { changes: 1 } };
      }
      if (/DELETE FROM quote_deposits/.test(sql)) {
        const had = deposits.delete(params[0]);
        return { results: [], meta: { changes: had ? 1 : 0 } };
      }
      if (/DELETE FROM quotes/.test(sql)) {
        const had = quotes.delete(params[0]);
        return { results: [], meta: { changes: had ? 1 : 0 } };
      }
      if (/SELECT [^]*FROM quote_payloads/i.test(sql)) {
        const id = params[0];
        const p = payloads.get(id);
        return { results: p ? [{ quote_id: id, payload: p.payload, version: p.version, updated_at: p.updated_at }] : [], meta: {} };
      }
      if (/SELECT [^]*FROM quotes/i.test(sql)) {
        if (/WHERE (q\.)?id = \?/.test(sql)) {
          const row = quotes.get(params[0]);
          return { results: row ? [withDeposit(row)] : [], meta: {} };
        }
        if (/LIKE \?/.test(sql)) {
          const like = String(params[0]);
          const prefix = like.replace(/%$/, '');
          const rows = [...quotes.values()].filter((r) => String(r.id).startsWith(prefix)).map((r) => ({ id: r.id }));
          return { results: rows, meta: {} };
        }
        // plain list (listFullQuotes) — return the flat rows joined with any deposit
        return { results: [...quotes.values()].map(withDeposit), meta: {} };
      }
      return { results: [], meta: { changes: 0 } };
    },
  };
}

// ── createQuote ──────────────────────────────────────────────────
describe('createQuote', () => {
  test('round-trip: create → getQuote returns the full payload (opt+result+customer), version 1, PP-YYYY-NNNN id', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    expect(q.id).toBe('PP-2026-0001');
    expect(q.date).toBe('2026-06-12T10:00:00.000Z');
    expect(q.updated_at).toBe('2026-06-12T10:00:00.000Z');
    expect(q.version).toBe(1);
    expect(q.user).toBe('Alberto');

    const got = await getQuote(client, q.id);
    expect(got).not.toBeNull();
    expect(got.version).toBe(1);
    expect(got.quote.id).toBe('PP-2026-0001');
    expect(got.quote.opt).toEqual(sampleDraft().opt);
    expect(got.quote.result).toEqual(sampleDraft().result);
    expect(got.quote.customer).toEqual({ name: 'Peña La Cuesta', phone: '600123123' });
    expect(got.quote.version).toBe(1);
  });

  test('ids increment within the same year', async () => {
    const client = fakeClient();
    const q1 = await createQuote(client, sampleDraft(), { now: '2026-03-01T10:00:00.000Z' });
    const q2 = await createQuote(client, sampleDraft(), { now: '2026-03-01T10:00:00.000Z' });
    const q3 = await createQuote(client, sampleDraft(), { now: '2026-03-01T10:00:00.000Z' });
    expect(q1.id).toBe('PP-2026-0001');
    expect(q2.id).toBe('PP-2026-0002');
    expect(q3.id).toBe('PP-2026-0003');
  });

  test('uses the year from `now` (ISO string)', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft({ ts: '2027-01-02T10:00:00.000Z' }), { now: '2027-01-02T10:00:00.000Z' });
    expect(q.id).toBe('PP-2027-0001');
  });

  test('collision retry: a payload-only race forces createQuote onto the NEXT id and never overwrites the taken one', async () => {
    const client = fakeClient();
    // Model the genuine cross-device race the claim defends against: two PCs
    // both computed PP-2026-0002 (flat already holds 0001), the OTHER PC won
    // the payload claim for 0002 a beat before this one. To make the FIRST
    // computed id collide here, seed flat with 0001 (so nextCloudQuoteId
    // returns 0002) and seed the 0002 PAYLOAD (so this device's claim sees
    // changes:0). The other PC's own flat-row write for 0002 lands on the next
    // call() the fake serves, so the retry recomputes a fresh id.
    client.quotes.set('PP-2026-0001', { id: 'PP-2026-0001', ts: '2026-06-12T09:00:00.000Z', status: 'pending', status_ts: null });
    const sentinel = JSON.stringify({ id: 'PP-2026-0002', sentinel: true });
    client.payloads.set('PP-2026-0002', { payload: sentinel, version: 9, updated_at: 'x' });
    // The winner's flat row for 0002 is present too (a claim winner writes both),
    // so this device's recompute sees 0002 taken and advances to 0003.
    client.quotes.set('PP-2026-0002', { id: 'PP-2026-0002', ts: '2026-06-12T09:30:00.000Z', status: 'pending', status_ts: null });

    const q = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    // nextCloudQuoteId returns 0003 (flat holds 0001+0002) and the claim for
    // 0003 succeeds.
    expect(q.id).toBe('PP-2026-0003');

    // the pre-seeded payload of the taken id is untouched (the lost claim wrote
    // NOTHING for it)
    const seeded = client.payloads.get('PP-2026-0002');
    expect(seeded.version).toBe(9);
    expect(JSON.parse(seeded.payload)).toEqual({ id: 'PP-2026-0002', sentinel: true });
  });

  test('claim losing the race (changes:0) makes the loop recompute the next id', async () => {
    // Drives the genuine claim-retry branch: the FIRST computed id loses its
    // payload claim (changes:0), and the winner's flat row for that id becomes
    // visible to the NEXT nextCloudQuoteId so the recompute advances. A tiny
    // dedicated fake makes the failed claim reveal the winner's flat row.
    const client = fakeClient();
    // The winner has already claimed PP-2026-0001's payload (flat not yet seen).
    client.payloads.set('PP-2026-0001', { payload: JSON.stringify({ id: 'PP-2026-0001', other: true }), version: 3, updated_at: 'x' });
    const innerQuery = client.query.bind(client);
    client.query = async (sql, params = []) => {
      const res = await innerQuery(sql, params);
      // When this device's claim for the taken id loses (changes:0), simulate
      // the winner's flat-row write becoming visible so the retry recomputes.
      if (/INSERT OR IGNORE INTO quote_payloads/.test(sql) && (res.meta && res.meta.changes) === 0) {
        const id = params[0];
        if (!client.quotes.has(id)) {
          client.quotes.set(id, { id, ts: '2026-06-12T09:00:00.000Z', status: 'pending', status_ts: null });
        }
      }
      return res;
    };

    const q = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    // first claim (0001) lost → flat 0001 revealed → recompute → 0002 claimed
    expect(q.id).toBe('PP-2026-0002');
    // the other device's payload survives intact (lost claim wrote nothing)
    expect(JSON.parse(client.payloads.get('PP-2026-0001').payload)).toEqual({ id: 'PP-2026-0001', other: true });
  });

  test('a network error during the claim PROPAGATES (never mis-read as a collision/retry)', async () => {
    // The collision check keys on meta.changes (0 = taken). A network failure
    // is NOT a collision: it must reject, not be swallowed into { claimed:false }
    // and silently retry/loop. Inject a D1ClientError-like throw on the claim
    // INSERT and assert createQuote rejects, the loop never advances, and
    // nothing was written.
    const client = fakeClient();
    const innerQuery = client.query.bind(client);
    let claimAttempts = 0;
    client.query = async (sql, params = []) => {
      if (/INSERT OR IGNORE INTO quote_payloads/.test(sql)) {
        claimAttempts += 1;
        const err = new Error('Sin conexión con la base de datos');
        err.network = true; // structural flag the real D1ClientError carries
        throw err;
      }
      return innerQuery(sql, params);
    };

    await expect(createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' }))
      .rejects.toThrow(/conexión/i);
    // the error short-circuited the very first claim — no swallow, no retry loop
    expect(claimAttempts).toBe(1);
    // and nothing landed (no orphan flat/payload row)
    expect(client.quotes.size).toBe(0);
    expect(client.payloads.size).toBe(0);
  });
});

// ── getQuote ─────────────────────────────────────────────────────
describe('getQuote', () => {
  test('returns null for a missing id', async () => {
    const client = fakeClient();
    expect(await getQuote(client, 'PP-2026-9999')).toBeNull();
  });

  test('returns { quote, version } where version is the cloud token', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const got = await getQuote(client, 'PP-2026-0001');
    expect(got.version).toBe(1);
    expect(got.quote.version).toBe(1);
  });
});

// ── listQuotes ───────────────────────────────────────────────────
describe('listQuotes', () => {
  test('maps flat rows to renderer-friendly list rows, newest-first, no payload fetch', async () => {
    const client = fakeClient();
    // The flat `ts` column (mapped to the list row's `date`) drives the order;
    // give each a distinct ts so newest-first is observable.
    await createQuote(client, sampleDraft({ ts: '2026-01-01T10:00:00.000Z', customer: { name: 'Vieja', phone: '600' } }), { now: '2026-01-01T10:00:00.000Z' });
    await createQuote(client, sampleDraft({ ts: '2026-06-01T10:00:00.000Z', customer: { name: 'Media', phone: '611' } }), { now: '2026-06-01T10:00:00.000Z' });
    await createQuote(client, sampleDraft({ ts: '2026-12-01T10:00:00.000Z', customer: { name: 'Nueva', phone: '622' } }), { now: '2026-12-01T10:00:00.000Z' });

    client.calls.length = 0; // observe only listQuotes' statements
    const list = await listQuotes(client);
    expect(list).toHaveLength(3);
    // newest-first
    expect(list.map((q) => q.customer.name)).toEqual(['Nueva', 'Media', 'Vieja']);

    // renderer-friendly shape (what renderHistoryList reads)
    const top = list[0];
    expect(top.id).toBe('PP-2026-0003');
    expect(top.date).toBe('2026-12-01T10:00:00.000Z');
    expect(top.user).toBe('Alberto');
    expect(top.customer.name).toBe('Nueva');
    expect(top.total_vat_inc).toBe(622.8);
    expect(top.status).toBe('pending');
    expect(top.pack_id).toBe('crew_full');

    // no payload SELECT happened during the list
    const touchedPayloads = client.calls.some((c) => /quote_payloads/.test(c.sql || ''));
    expect(touchedPayloads).toBe(false);
  });

  test('returns [] when there are no quotes', async () => {
    const client = fakeClient();
    expect(await listQuotes(client)).toEqual([]);
  });
});

// ── searchQuotes ─────────────────────────────────────────────────
describe('searchQuotes', () => {
  test('empty query returns all', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-01-01T10:00:00.000Z' });
    await createQuote(client, sampleDraft(), { now: '2026-02-01T10:00:00.000Z' });
    expect(await searchQuotes(client, '')).toHaveLength(2);
    expect(await searchQuotes(client, '   ')).toHaveLength(2);
  });

  test('filters case-insensitively on id, user, customer.name', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft({ user: 'Carlos', customer: { name: 'Lobito FC', phone: '600' } }), { now: '2026-01-01T10:00:00.000Z' });
    await createQuote(client, sampleDraft({ user: 'Beatriz', customer: { name: 'Marina Club', phone: '700' } }), { now: '2026-02-01T10:00:00.000Z' });

    expect(await searchQuotes(client, 'lobito')).toHaveLength(1);
    expect(await searchQuotes(client, 'carlos')).toHaveLength(1);
    expect((await searchQuotes(client, 'pp-2026-0001')).map((q) => q.id)).toEqual(['PP-2026-0001']);
  });
});

// ── replaceQuote ─────────────────────────────────────────────────
describe('replaceQuote', () => {
  test('returns null for an unknown id', async () => {
    const client = fakeClient();
    expect(await replaceQuote(client, 'PP-2026-9999', sampleDraft(), null)).toBeNull();
  });

  test('current version: bumps version, pins id+date, preserves status, returns { quote }', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    // simulate a status change on the flat row (authoritative) before the edit
    const flat = client.quotes.get('PP-2026-0001');
    client.quotes.set('PP-2026-0001', { ...flat, status: 'accepted', status_ts: '2026-06-13T09:00:00.000Z' });

    const edit = sampleDraft({
      user: 'Editado',
      total_vat_inc: 700, sale_base: 580, margin_pct: 0.41,
      totals: { total_vat_inc: 700, sale_base: 580, vat: 120, total_cost: 350, margin: 0.41 },
      // an edit must NOT be able to change workflow state:
      status: 'rejected', status_ts: 'BAD',
    });
    const res = await replaceQuote(client, 'PP-2026-0001', edit, { version: 1 }, { now: '2026-06-12T12:00:00.000Z' });
    expect(res.conflict).toBeUndefined();
    expect(res.quote).toBeDefined();
    expect(res.quote.id).toBe('PP-2026-0001');
    expect(res.quote.date).toBe('2026-06-12T10:00:00.000Z'); // date pinned from existing
    expect(res.quote.user).toBe('Editado');
    expect(res.quote.version).toBe(2);
    expect(res.quote.updated_at).toBe('2026-06-12T12:00:00.000Z');
    // status preserved from the existing record, NOT taken from the edit
    expect(res.quote.status).toBe('accepted');
    expect(res.quote.status_ts).toBe('2026-06-13T09:00:00.000Z');

    // the payload landed at version 2 with the edited total
    const p = client.payloads.get('PP-2026-0001');
    expect(p.version).toBe(2);
    expect(JSON.parse(p.payload).total_vat_inc).toBe(700);
  });

  test('falls back to the existing version when no `expected` is given', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const res = await replaceQuote(client, 'PP-2026-0001', sampleDraft({ user: 'X' }), null, { now: '2026-06-12T12:00:00.000Z' });
    expect(res.quote.version).toBe(2);
  });

  test('stale `expected` version → { conflict: true } and no write', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    // bump to version 2 so an expected:1 is now stale
    await replaceQuote(client, 'PP-2026-0001', sampleDraft({ user: 'first edit' }), { version: 1 }, { now: '2026-06-12T11:00:00.000Z' });

    const res = await replaceQuote(client, 'PP-2026-0001', sampleDraft({ user: 'conflicting' }), { version: 1 }, { now: '2026-06-12T12:00:00.000Z' });
    expect(res).toEqual({ conflict: true });
    // payload still at the first edit (version 2), not overwritten
    const p = client.payloads.get('PP-2026-0001');
    expect(p.version).toBe(2);
    expect(JSON.parse(p.payload).user).toBe('first edit');
  });

  test('accepts a bare numeric `expected`', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const res = await replaceQuote(client, 'PP-2026-0001', sampleDraft({ user: 'numeric token' }), 1, { now: '2026-06-12T12:00:00.000Z' });
    expect(res.quote.version).toBe(2);
    const stale = await replaceQuote(client, 'PP-2026-0001', sampleDraft({ user: 'stale' }), 1, { now: '2026-06-12T13:00:00.000Z' });
    expect(stale).toEqual({ conflict: true });
  });
});

// ── setStatus ────────────────────────────────────────────────────
describe('setStatus', () => {
  test('returns the overlaid quote (updated|null contract) and updates the authoritative flat row, no payload version bump', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const updated = await setStatus(client, 'PP-2026-0001', 'accepted', '2026-06-13T09:00:00.000Z');
    // Uniform contract: a full quote, not { ok, id, status }
    expect(updated).not.toBeNull();
    expect(updated.id).toBe('PP-2026-0001');
    expect(updated.status).toBe('accepted');
    expect(updated.status_ts).toBe('2026-06-13T09:00:00.000Z');

    // flat row mutated
    const flat = client.quotes.get('PP-2026-0001');
    expect(flat.status).toBe('accepted');
    expect(flat.status_ts).toBe('2026-06-13T09:00:00.000Z');

    // payload version untouched (status is workflow, not a content edit)
    expect(client.payloads.get('PP-2026-0001').version).toBe(1);
    expect(updated.version).toBe(1);

    // getQuote overlays the authoritative status onto the payload
    const got = await getQuote(client, 'PP-2026-0001');
    expect(got.quote.status).toBe('accepted');
    expect(got.version).toBe(1);
  });

  test('returns null for an unknown id (UPDATE changes 0), never falsely reports success', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const res = await setStatus(client, 'PP-2026-9999', 'accepted', '2026-06-13T09:00:00.000Z');
    expect(res).toBeNull();
    // the real quote was untouched
    expect(client.quotes.get('PP-2026-0001').status).toBe('pending');
  });

  test('returns null for a shape-invalid id without any query', async () => {
    const client = fakeClient();
    client.calls.length = 0;
    expect(await setStatus(client, '../evil', 'accepted', 't')).toBeNull();
    const mutated = client.calls.some((c) => /UPDATE|SELECT/i.test(c.sql || ''));
    expect(mutated).toBe(false);
  });

  test('rejects an invalid status without any write (fail-fast, non-network)', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    client.calls.length = 0;
    await expect(setStatus(client, 'PP-2026-0001', 'bogus', '2026-06-13T09:00:00.000Z'))
      .rejects.toThrow(/no válido/i);
    // no UPDATE ran
    const mutated = client.calls.some((c) => /UPDATE/i.test(c.sql || ''));
    expect(mutated).toBe(false);
    // status unchanged
    expect(client.quotes.get('PP-2026-0001').status).toBe('pending');
  });
});

// ── setDepositPaid ───────────────────────────────────────────────
describe('setDepositPaid', () => {
  const PAID = { amount: 249, at: '2026-09-04T10:00:00.000Z', by: 'Mostrador' };
  const NOW = '2026-09-04T10:00:00.000Z';

  test('returns the overlaid quote: payment recorded, status accepted, version untouched', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const updated = await setDepositPaid(client, q.id, PAID, { now: NOW });
    expect(updated.deposit_paid).toEqual(PAID);
    expect(updated.status).toBe('accepted');
    expect(updated.status_ts).toBe(NOW);
    expect(updated.version).toBe(1);
    expect((await getQuote(client, q.id)).quote.deposit_paid).toEqual(PAID);
  });

  test('clearing returns the quote to pending with deposit_paid null', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft());
    await setDepositPaid(client, q.id, PAID, { now: NOW });
    client.calls.length = 0;
    const cleared = await setDepositPaid(client, q.id, null, { now: NOW });
    expect(cleared.status).toBe('pending');
    expect(cleared.deposit_paid).toBeNull();
    expect(client.calls.some((c) => /DELETE FROM quote_deposits/.test(c.sql))).toBe(true);
    expect(client.calls.some((c) => /INSERT INTO quote_deposits/.test(c.sql))).toBe(false);
  });

  test('orphan payload (no flat row): returns null and writes NO deposit row', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft());
    client.quotes.delete(q.id); // simulate a lost flat insert after the payload claim
    client.calls.length = 0;
    expect(await setDepositPaid(client, q.id, PAID, { now: NOW })).toBeNull();
    expect(client.calls.some((c) => /INSERT INTO quote_deposits/.test(c.sql))).toBe(false);
  });

  test('returns null for an unknown id and for a shape-invalid id (no query)', async () => {
    const client = fakeClient();
    expect(await setDepositPaid(client, 'PP-2026-9999', PAID, { now: NOW })).toBeNull();
    client.calls.length = 0;
    expect(await setDepositPaid(client, '../evil', PAID, { now: NOW })).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  test('rejects a bad amount BEFORE any network call', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft());
    client.calls.length = 0;
    await expect(setDepositPaid(client, q.id, { amount: 0, at: NOW, by: null }, { now: NOW }))
      .rejects.toThrow(/importe/i);
    expect(client.calls).toHaveLength(0);
  });

  test('replaceQuote preserves the stored payment and drops one smuggled in the draft', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft());
    await setDepositPaid(client, q.id, PAID, { now: NOW });
    const { version } = await getQuote(client, q.id);
    const res = await replaceQuote(client, q.id, sampleDraft({ user: 'Edited', deposit_paid: { amount: 1, at: NOW, by: 'x' } }), version);
    expect(res.quote.deposit_paid).toEqual(PAID);
    expect(res.quote.status).toBe('accepted');
    expect(res.quote.version).toBe(2);
    expect(JSON.parse(client.payloads.get(q.id).payload).deposit_paid).toEqual(PAID);
  });

  test('createQuote never writes a deposit_paid carried by the draft', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft({ deposit_paid: PAID }));
    expect(q.deposit_paid).toBeUndefined();
    expect(JSON.parse(client.payloads.get(q.id).payload).deposit_paid).toBeUndefined();
    expect((await getQuote(client, q.id)).quote.deposit_paid).toBeNull();
  });

  test('listQuotes rows carry deposit_paid (null when unpaid)', async () => {
    const client = fakeClient();
    const a = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const b = await createQuote(client, sampleDraft(), { now: '2026-06-13T10:00:00.000Z' });
    await setDepositPaid(client, b.id, PAID, { now: NOW });
    const rows = await listQuotes(client);
    expect(rows.find((r) => r.id === a.id).deposit_paid).toBeNull();
    expect(rows.find((r) => r.id === b.id).deposit_paid).toEqual(PAID);
  });

  test('getQuote returns the RIGHT row when several quotes exist', async () => {
    const client = fakeClient();
    const a = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const b = await createQuote(client, sampleDraft(), { now: '2026-06-13T10:00:00.000Z' });
    await setStatus(client, a.id, 'rejected', NOW);
    await setDepositPaid(client, b.id, PAID, { now: NOW });
    expect((await getQuote(client, a.id)).quote.status).toBe('rejected');
    expect((await getQuote(client, a.id)).quote.deposit_paid).toBeNull();
    expect((await getQuote(client, b.id)).quote.status).toBe('accepted');
    expect((await getQuote(client, b.id)).quote.deposit_paid).toEqual(PAID);
  });
});

// ── deleteQuote ──────────────────────────────────────────────────
describe('deleteQuote', () => {
  test('removes the quote (subsequent getQuote → null) and returns the removed quote', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const removed = await deleteQuote(client, 'PP-2026-0001');
    expect(removed).not.toBeNull();
    expect(removed.id).toBe('PP-2026-0001');
    expect(removed.opt).toEqual(sampleDraft().opt);
    expect(await getQuote(client, 'PP-2026-0001')).toBeNull();
    // child + flat + payload rows are all gone
    expect(client.quotes.has('PP-2026-0001')).toBe(false);
    expect(client.payloads.has('PP-2026-0001')).toBe(false);
    expect(client.items.filter((i) => i.quote_id === 'PP-2026-0001')).toHaveLength(0);
    expect(client.addons.filter((a) => a.quote_id === 'PP-2026-0001')).toHaveLength(0);
  });

  test('returns null for a missing id (and does not delete anything)', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    expect(await deleteQuote(client, 'PP-2026-9999')).toBeNull();
    expect(client.quotes.has('PP-2026-0001')).toBe(true);
  });
});

// ── id-shape guard (traversal / bad input) ───────────────────────
describe('id-shape guard', () => {
  const badIds = ['../x', '..\\settings', '', 'PP-2026', 'config', null, undefined, 42, {}];

  test('get/replace/delete return null for invalid ids and never mutate', async () => {
    const client = fakeClient();
    await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    client.calls.length = 0;
    for (const bad of badIds) {
      expect(await getQuote(client, bad)).toBeNull();
      expect(await replaceQuote(client, bad, sampleDraft(), null)).toBeNull();
      expect(await deleteQuote(client, bad)).toBeNull();
    }
    // no mutating statement (INSERT/UPDATE/DELETE) ran for a bad id
    const mutated = client.calls.some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql || ''));
    expect(mutated).toBe(false);
    // the real quote is untouched
    expect(client.quotes.has('PP-2026-0001')).toBe(true);
    expect(client.payloads.has('PP-2026-0001')).toBe(true);
  });
});

// ── new cloud-quotes ops, exercised directly ─────────────────────
describe('tryClaimFullQuote', () => {
  test('claims a free id (flat + payload + child rows land), returns { claimed: true }', async () => {
    const client = fakeClient();
    const res = await tryClaimFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    expect(res).toEqual({ claimed: true });
    expect(client.payloads.has('PP-2026-0001')).toBe(true);
    expect(client.quotes.has('PP-2026-0001')).toBe(true);
    expect(client.items.filter((i) => i.quote_id === 'PP-2026-0001')).toHaveLength(1);
    expect(client.addons.filter((a) => a.quote_id === 'PP-2026-0001')).toHaveLength(1);
  });

  test('a taken id → { claimed: false } and the existing payload is untouched (writes nothing)', async () => {
    const client = fakeClient();
    const sentinel = JSON.stringify({ id: 'PP-2026-0001', sentinel: true });
    client.payloads.set('PP-2026-0001', { payload: sentinel, version: 5, updated_at: 'x' });

    const res = await tryClaimFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    expect(res).toEqual({ claimed: false });
    // payload untouched
    const p = client.payloads.get('PP-2026-0001');
    expect(p.version).toBe(5);
    expect(JSON.parse(p.payload)).toEqual({ id: 'PP-2026-0001', sentinel: true });
    // and NO flat/child row was written for the lost claim
    expect(client.quotes.has('PP-2026-0001')).toBe(false);
    expect(client.items.filter((i) => i.quote_id === 'PP-2026-0001')).toHaveLength(0);
  });

  test('validates the flat row before any write (fail-fast, non-network)', async () => {
    const client = fakeClient();
    await expect(tryClaimFullQuote(client, sampleFullQuote({ pack_id: undefined })))
      .rejects.toThrow(/presupuesto/i);
    expect(client.calls).toHaveLength(0);
  });
});

describe('deleteFullQuote', () => {
  test('removes child + flat + payload rows', async () => {
    const client = fakeClient();
    await tryClaimFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    const res = await deleteFullQuote(client, 'PP-2026-0001');
    expect(res).toEqual({ ok: true });
    expect(client.quotes.has('PP-2026-0001')).toBe(false);
    expect(client.payloads.has('PP-2026-0001')).toBe(false);
    expect(client.items.filter((i) => i.quote_id === 'PP-2026-0001')).toHaveLength(0);
    expect(client.addons.filter((a) => a.quote_id === 'PP-2026-0001')).toHaveLength(0);

    // child rows are deleted BEFORE the flat quotes row (FK order)
    const itemsIdx = client.calls.findIndex((c) => /DELETE FROM quote_items/.test(c.sql || ''));
    const addonsIdx = client.calls.findIndex((c) => /DELETE FROM quote_addons/.test(c.sql || ''));
    const flatIdx = client.calls.findIndex((c) => /DELETE FROM quotes\b/.test(c.sql || ''));
    expect(itemsIdx).toBeGreaterThanOrEqual(0);
    expect(addonsIdx).toBeGreaterThanOrEqual(0);
    expect(flatIdx).toBeGreaterThan(itemsIdx);
    expect(flatIdx).toBeGreaterThan(addonsIdx);
  });
});
