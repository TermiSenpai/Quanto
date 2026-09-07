// ============================================================
// Tests · lib/cloud-quotes.js full-quote ops + 0002 migration
// ============================================================
// Phase B (shared quote store), cloud backend data layer:
//   - db/migrations/0002_quote_payloads.sql (separate payload table)
//   - saveFullQuote / getFullQuote / listFullQuotes / updateFullQuote
//   - nextCloudQuoteId (PP-YYYY-NNNN, per-year max+1)
//
// Pure module: the D1 client is injected. The fake client below
// models BOTH the flat `quotes` row (INSERT OR IGNORE on the human
// id PK) and the `quote_payloads` row (INSERT OR REPLACE + the
// version-guarded UPDATE) realistically enough to assert the
// round-trip and the optimistic-concurrency conflict.
// ============================================================

import path from 'node:path';
import { describe, test, expect } from 'vitest';
import {
  saveFullQuote,
  getFullQuote,
  listFullQuotes,
  updateFullQuote,
  nextCloudQuoteId,
  setQuoteDeposit,
  deleteFullQuote
} from '../lib/cloud-quotes.js';
import { loadMigrations } from '../lib/migration-loader.js';
import { applyMigrations } from '../lib/db-migrator.js';

const REAL_MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

// ── The canonical reopenable quote (CLAUDE.md §9 / B2 spec) ──────
function sampleFullQuote(overrides = {}) {
  return {
    id: 'PP-2026-0001',
    ts: '2026-06-12T10:00:00.000Z',
    date: '2026-06-12T10:00:00.000Z',
    updated_at: '2026-06-12T10:00:00.000Z',
    version: 1,
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
    items: [
      { product_id: 'BEAGLE', sides: 'two_sides', qty: 24 }
    ],
    addons: [
      { addon_id: 'name', qty: 24 }
    ],
    ...overrides
  };
}

// ── Fake D1 client modelling quotes + quote_payloads ─────────────
// Tracks two in-memory tables and records every statement. It honours
// just the SQL this module emits: INSERT OR IGNORE INTO quotes (id PK),
// INSERT OR IGNORE INTO quote_payloads (create-only), the version-guarded
// payload UPDATE, the stat UPDATE on quotes (params mapped back onto the
// SET columns so the new values are actually stored), and the SELECTs of
// getFullQuote / listFullQuotes / nextCloudQuoteId.
function fakeClient() {
  const quotes = new Map();         // id → flat row object
  const payloads = new Map();       // quote_id → { payload, version, updated_at }
  const calls = [];
  const deposits = new Map();       // quote_id → { amount, paid_at, paid_by }

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
    // INSERT OR IGNORE INTO quotes (col, col, ...) VALUES (?, ?, ...)
    const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim());
    // a single-row insert (saveFullQuote inserts one row)
    const row = {};
    cols.forEach((c, i) => { row[c] = params[i]; });
    if (!quotes.has(row.id)) {
      quotes.set(row.id, { status: 'pending', status_ts: null, ...row });
    }
    return { results: [], meta: { changes: quotes.has(row.id) ? 1 : 0 } };
  }

  return {
    calls,
    quotes,
    payloads,
    deposits,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/INSERT OR IGNORE INTO quotes/.test(sql)) {
        return insertOrIgnoreQuotes(sql, params);
      }
      if (/INSERT OR IGNORE INTO quote_items/.test(sql) || /INSERT OR IGNORE INTO quote_addons/.test(sql)) {
        return { results: [], meta: { changes: 1 } };
      }
      if (/INSERT OR IGNORE INTO quote_payloads/.test(sql)) {
        // version is a SQL literal (1) in the statement, so it is NOT a bound
        // param: params are [quote_id, payload, updated_at] in that order.
        // OR IGNORE → create-only: an existing payload is left untouched.
        const [quote_id, payload, updated_at] = params;
        if (payloads.has(quote_id)) return { results: [], meta: { changes: 0 } };
        payloads.set(quote_id, { payload, version: 1, updated_at });
        return { results: [], meta: { changes: 1 } };
      }
      if (/UPDATE quote_payloads SET payload/.test(sql)) {
        // ... WHERE quote_id = ? AND version = ?
        const [payload, updated_at, quote_id, expectedVersion] = params;
        const cur = payloads.get(quote_id);
        if (cur && cur.version === expectedVersion) {
          payloads.set(quote_id, { payload, version: cur.version + 1, updated_at });
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 0 } };
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
      if (/UPDATE quotes SET/.test(sql)) {
        // stat update: parse the SET columns ("col = ?, col = ?, ...") and map
        // the leading params onto them so the NEW values are actually stored;
        // the trailing param is the id (WHERE id = ?). This lets a test assert
        // the refreshed columns carry the new payload values, not just that the
        // statement ran.
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
          next._statUpdated = true;
          quotes.set(id, next);
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 0 } };
      }
      if (/SELECT [^]*FROM quote_payloads/i.test(sql)) {
        const id = params[0];
        const p = payloads.get(id);
        return { results: p ? [{ quote_id: id, payload: p.payload, version: p.version, updated_at: p.updated_at }] : [], meta: {} };
      }
      if (/SELECT [^]*FROM quotes/i.test(sql)) {
        // Two shapes: by id (getFullQuote overlay) and the list/year scan.
        if (/WHERE (q\.)?id = \?/.test(sql)) {
          const row = quotes.get(params[0]);
          return { results: row ? [withDeposit(row)] : [], meta: {} };
        }
        if (/LIKE \?/.test(sql)) {
          // nextCloudQuoteId: SELECT id ... WHERE id LIKE 'PP-YYYY-%'
          const like = String(params[0]);
          const prefix = like.replace(/%$/, '');
          const rows = [...quotes.values()].filter((r) => String(r.id).startsWith(prefix)).map((r) => ({ id: r.id }));
          return { results: rows, meta: {} };
        }
        // plain list
        return { results: [...quotes.values()].map(withDeposit), meta: {} };
      }
      return { results: [], meta: { changes: 0 } };
    },
    async exec(sqlText) {
      calls.push({ exec: sqlText });
      return [{ success: true }];
    }
  };
}

// ── Migration 0002 ───────────────────────────────────────────────
describe('0002_quote_payloads migration', () => {
  test('the loader picks up 0002 after 0001', () => {
    const migrations = loadMigrations(REAL_MIGRATIONS);
    const ids = migrations.map((m) => m.id);
    expect(ids).toContain('0002_quote_payloads');
    expect(ids.indexOf('0002_quote_payloads')).toBe(ids.indexOf('0001_init') + 1);
  });

  test('0002 creates quote_payloads with CREATE TABLE IF NOT EXISTS', () => {
    const migrations = loadMigrations(REAL_MIGRATIONS);
    const m = migrations.find((x) => x.id === '0002_quote_payloads');
    expect(m.sql).toMatch(/CREATE TABLE IF NOT EXISTS quote_payloads/);
    // separate table, NOT an ALTER ... ADD COLUMN (SQLite can't guard it)
    expect(m.sql).not.toMatch(/ALTER TABLE/i);
    expect(m.sql).toMatch(/quote_id\s+TEXT PRIMARY KEY/);
    expect(m.sql).toMatch(/payload\s+TEXT NOT NULL/);
    expect(m.sql).toMatch(/version\s+INTEGER NOT NULL/);
  });

  test('applyMigrations runs 0002 once; a second run is a no-op (ledger)', async () => {
    const migrations = loadMigrations(REAL_MIGRATIONS);
    const client = fakeMigratorClient();
    const opts = { user: 'PC-Test', appVersion: '5.0.0-beta', now: () => '2026-06-12T10:00:00.000Z' };

    const done1 = await applyMigrations(client, migrations, opts);
    expect(done1).toContain('0002_quote_payloads');

    const done2 = await applyMigrations(client, migrations, opts);
    expect(done2).toEqual([]); // ledger has it now
  });

  test('re-executing the 0002 SQL does not throw (CREATE IF NOT EXISTS)', async () => {
    const migrations = loadMigrations(REAL_MIGRATIONS);
    const m = migrations.find((x) => x.id === '0002_quote_payloads');
    const client = fakeMigratorClient();
    await expect(client.exec(m.sql)).resolves.toBeTruthy();
    await expect(client.exec(m.sql)).resolves.toBeTruthy();
  });
});

// A migrator-shaped fake (ledger-aware), mirroring tests/db-migrator.test.js.
function fakeMigratorClient(appliedIds = []) {
  const rows = appliedIds.map((id) => ({ id }));
  return {
    async exec() { return [{ success: true }]; },
    async query(sql, params = []) {
      if (/SELECT id FROM schema_migrations/.test(sql)) return { results: rows, meta: {} };
      if (/INSERT INTO schema_migrations/.test(sql)) { rows.push({ id: params[0] }); return { results: [], meta: { changes: 1 } }; }
      return { results: [], meta: {} };
    }
  };
}

// ── saveFullQuote ────────────────────────────────────────────────
describe('saveFullQuote', () => {
  test('inserts the flat quotes row and the payload (both OR IGNORE, version 1)', async () => {
    const client = fakeClient();
    const res = await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    expect(res.ok).toBe(true);
    expect(res.id).toBe('PP-2026-0001');

    // flat row landed
    expect(client.quotes.has('PP-2026-0001')).toBe(true);

    // payload landed with version 1
    const p = client.payloads.get('PP-2026-0001');
    expect(p).toBeTruthy();
    expect(p.version).toBe(1);
    expect(p.updated_at).toBe('2026-06-12T10:00:00.000Z');
    const parsed = JSON.parse(p.payload);
    expect(parsed.opt).toEqual(sampleFullQuote().opt);
    expect(parsed.result).toEqual(sampleFullQuote().result);
    expect(parsed.customer).toEqual({ name: 'Peña La Cuesta', phone: '600123123' });

    // the flat insert is OR IGNORE (idempotent on the human id PK)
    const flatInsert = client.calls.find((c) => /INSERT OR IGNORE INTO quotes/.test(c.sql || ''));
    expect(flatInsert).toBeTruthy();
    // the payload insert is create-only OR IGNORE (a stale replay must NOT
    // clobber an edited payload or reset its version — see saveFullQuote doc)
    const payloadInsert = client.calls.find((c) => /INSERT OR IGNORE INTO quote_payloads/.test(c.sql || ''));
    expect(payloadInsert).toBeTruthy();
    expect(payloadInsert.sql).not.toMatch(/INSERT OR REPLACE/);
    // version is a SQL literal 1 (create/first-save), not a bound param
    expect(payloadInsert.sql).toMatch(/VALUES \(\?, \?, 1, \?\)/);
  });

  test('validates the flat row before any network write (defense-in-depth)', async () => {
    const client = fakeClient();
    await expect(saveFullQuote(client, sampleFullQuote({ pack_id: undefined })))
      .rejects.toThrow(/presupuesto/i);
    expect(client.calls).toHaveLength(0);
  });

  test('is idempotent: re-saving the same quote does not duplicate (both OR IGNORE)', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T11:00:00.000Z' });
    expect(client.quotes.size).toBe(1);
    expect(client.payloads.size).toBe(1);
    // version stays 1 (saveFullQuote is create/first-save only)
    expect(client.payloads.get('PP-2026-0001').version).toBe(1);
  });

  test('a stale replay AFTER an edit does NOT clobber the edited payload or reset version', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    // edit it → version 2, new total
    const edited = sampleFullQuote({ total_vat_inc: 700, totals: { ...sampleFullQuote().totals, total_vat_inc: 700 } });
    await updateFullQuote(client, 'PP-2026-0001', edited, 1, { now: '2026-06-12T12:00:00.000Z' });
    expect(client.payloads.get('PP-2026-0001').version).toBe(2);

    // a delayed outbox replay of the ORIGINAL save fires again…
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T13:00:00.000Z' });
    // …and OR IGNORE leaves the edited payload + version untouched (no data loss)
    const p = client.payloads.get('PP-2026-0001');
    expect(p.version).toBe(2);
    expect(JSON.parse(p.payload).total_vat_inc).toBe(700);
  });
});

// ── getFullQuote ─────────────────────────────────────────────────
describe('getFullQuote', () => {
  test('round-trips the full payload and overlays authoritative status from quotes', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });

    // simulate a status change on the flat row (the authoritative source)
    const flat = client.quotes.get('PP-2026-0001');
    client.quotes.set('PP-2026-0001', { ...flat, status: 'accepted', status_ts: '2026-06-13T09:00:00.000Z' });

    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote.id).toBe('PP-2026-0001');
    expect(quote.opt).toEqual(sampleFullQuote().opt);
    expect(quote.result).toEqual(sampleFullQuote().result);
    expect(quote.totals.total_vat_inc).toBe(622.8);
    expect(quote.version).toBe(1);
    // status comes from the flat quotes row, not from the payload
    expect(quote.status).toBe('accepted');
    expect(quote.status_ts).toBe('2026-06-13T09:00:00.000Z');
  });

  test('returns null when the payload row is absent', async () => {
    const client = fakeClient();
    expect(await getFullQuote(client, 'PP-2026-9999')).toBeNull();
  });

  test('throws a Spanish error when the stored payload JSON is corrupt', async () => {
    const client = fakeClient();
    client.payloads.set('PP-2026-0001', { payload: '{not valid json', version: 1, updated_at: 't' });
    client.quotes.set('PP-2026-0001', { id: 'PP-2026-0001', status: 'pending', status_ts: null });
    await expect(getFullQuote(client, 'PP-2026-0001')).rejects.toThrow(/presupuesto/i);
  });

  test('when the flat row is MISSING, keeps the payload version and its own status/status_ts', async () => {
    // Pins the else-path of the overlay: status is authoritative from the flat
    // row only WHEN PRESENT; with no flat row the payload's own values stand.
    const client = fakeClient();
    client.payloads.set('PP-2026-0001', {
      payload: JSON.stringify(sampleFullQuote({ status: 'rejected', status_ts: '2026-06-14T08:00:00.000Z' })),
      version: 3,
      updated_at: '2026-06-14T08:00:00.000Z'
    });
    // no client.quotes entry for this id

    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote).toBeTruthy();
    expect(quote.version).toBe(3); // from the payload row
    expect(quote.status).toBe('rejected'); // payload's own value, not overlaid
    expect(quote.status_ts).toBe('2026-06-14T08:00:00.000Z');
  });
});

// ── listFullQuotes ───────────────────────────────────────────────
describe('listFullQuotes', () => {
  test('reads the flat quotes columns only (no payload needed)', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    await saveFullQuote(client, sampleFullQuote({ id: 'PP-2026-0002', customer: { name: 'Otra', phone: '611' } }), { now: '2026-06-12T11:00:00.000Z' });

    const list = await listFullQuotes(client);
    expect(list).toHaveLength(2);
    const ids = list.map((q) => q.id).sort();
    expect(ids).toEqual(['PP-2026-0001', 'PP-2026-0002']);

    // the list query never touched quote_payloads
    const touchedPayloads = client.calls.some((c) => /quote_payloads/.test(c.sql || '') && /SELECT/i.test(c.sql || ''));
    // (saveFullQuote does not SELECT payloads, so this is purely from listFullQuotes)
    const listCall = client.calls.filter((c) => /SELECT/i.test(c.sql || '') && /FROM quotes/i.test(c.sql || ''));
    expect(listCall.length).toBeGreaterThan(0);
    expect(touchedPayloads).toBe(false);
  });
});

// ── updateFullQuote (optimistic concurrency) ─────────────────────
describe('updateFullQuote', () => {
  test('a stale expectedVersion returns { conflict: true } and does not touch the flat row', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    // current version is 1; pass a stale 0
    const updated = sampleFullQuote({ totals: { total_vat_inc: 999, sale_base: 800, vat: 199, total_cost: 400, margin: 0.4 }, total_vat_inc: 999, sale_base: 800, margin_pct: 0.4 });
    const res = await updateFullQuote(client, 'PP-2026-0001', updated, 0, { now: '2026-06-12T12:00:00.000Z' });
    expect(res).toEqual({ conflict: true });
    // payload unchanged (still version 1, original total)
    const p = client.payloads.get('PP-2026-0001');
    expect(p.version).toBe(1);
    expect(JSON.parse(p.payload).totals.total_vat_inc).toBe(622.8);
    // no stat UPDATE on the flat row happened
    expect(client.calls.some((c) => /UPDATE quotes SET/.test(c.sql || ''))).toBe(false);
  });

  test('the current version bumps to version+1 and updates the flat stat columns', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    const updated = sampleFullQuote({
      total_vat_inc: 700, sale_base: 580, margin_pct: 0.41,
      totals: { total_vat_inc: 700, sale_base: 580, vat: 120, total_cost: 350, margin: 0.41 }
    });
    const res = await updateFullQuote(client, 'PP-2026-0001', updated, 1, { now: '2026-06-12T12:00:00.000Z' });
    expect(res.version).toBe(2);
    expect(res.quote.id).toBe('PP-2026-0001');

    const p = client.payloads.get('PP-2026-0001');
    expect(p.version).toBe(2);
    expect(p.updated_at).toBe('2026-06-12T12:00:00.000Z');
    expect(JSON.parse(p.payload).total_vat_inc).toBe(700);

    // the flat quotes stat columns were updated (payload-first, then flat)
    const statUpd = client.calls.find((c) => /UPDATE quotes SET/.test(c.sql || ''));
    expect(statUpd).toBeTruthy();
    // the WHERE id = ? targets the same id
    expect(statUpd.params[statUpd.params.length - 1]).toBe('PP-2026-0001');

    // …and the NEW values actually landed on the flat row (the fake maps the
    // UPDATE params back onto the SET columns), so stats stay correct.
    const flat = client.quotes.get('PP-2026-0001');
    expect(flat.total_vat_inc).toBe(700);
    expect(flat.sale_base).toBe(580);
    expect(flat.margin_pct).toBe(0.41);
    // status/status_ts must NOT have been overwritten by the stat refresh
    expect(flat.status).toBe('pending');
    expect(flat.status_ts).toBeNull();
  });

  test('the payload UPDATE happens before the flat-row UPDATE', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote(), { now: '2026-06-12T10:00:00.000Z' });
    client.calls.length = 0; // reset to observe only the update sequence
    await updateFullQuote(client, 'PP-2026-0001', sampleFullQuote(), 1, { now: '2026-06-12T12:00:00.000Z' });
    const payloadIdx = client.calls.findIndex((c) => /UPDATE quote_payloads/.test(c.sql || ''));
    const flatIdx = client.calls.findIndex((c) => /UPDATE quotes SET/.test(c.sql || ''));
    expect(payloadIdx).toBeGreaterThanOrEqual(0);
    expect(flatIdx).toBeGreaterThan(payloadIdx);
  });
});

// ── nextCloudQuoteId ─────────────────────────────────────────────
describe('nextCloudQuoteId', () => {
  test('returns PP-YYYY-0001 for an empty year', async () => {
    const client = fakeClient();
    const id = await nextCloudQuoteId(client, 2026);
    expect(id).toBe('PP-2026-0001');
  });

  test('returns max+1 for the year (padded to 4 digits)', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote({ id: 'PP-2026-0003' }), { now: '2026-06-12T10:00:00.000Z' });
    await saveFullQuote(client, sampleFullQuote({ id: 'PP-2026-0007' }), { now: '2026-06-12T10:00:00.000Z' });
    const id = await nextCloudQuoteId(client, 2026);
    expect(id).toBe('PP-2026-0008');
  });

  test('scopes the counter to the requested year', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote({ id: 'PP-2025-0042' }), { now: '2025-06-12T10:00:00.000Z' });
    const id = await nextCloudQuoteId(client, 2026);
    expect(id).toBe('PP-2026-0001');
  });
});

// ── Migration 0003 ───────────────────────────────────────────────
describe('0003_quote_deposits migration', () => {
  test('the loader picks up 0003 right after 0002', () => {
    const ids = loadMigrations(REAL_MIGRATIONS).map((m) => m.id);
    expect(ids.indexOf('0003_quote_deposits')).toBe(ids.indexOf('0002_quote_payloads') + 1);
  });

  test('0003 creates quote_deposits with CREATE TABLE IF NOT EXISTS (no ALTER)', () => {
    const m = loadMigrations(REAL_MIGRATIONS).find((x) => x.id === '0003_quote_deposits');
    expect(m.sql).toMatch(/CREATE TABLE IF NOT EXISTS quote_deposits/);
    expect(m.sql).not.toMatch(/ALTER TABLE/i);
    expect(m.sql).toMatch(/quote_id\s+TEXT PRIMARY KEY/);
    expect(m.sql).toMatch(/REFERENCES quotes\(id\)/);
    expect(m.sql).toMatch(/amount\s+REAL NOT NULL/);
    expect(m.sql).toMatch(/paid_at\s+TEXT NOT NULL/);
  });

  test('applyMigrations runs 0003 once; a second run is a no-op (ledger)', async () => {
    const migrations = loadMigrations(REAL_MIGRATIONS);
    const client = fakeMigratorClient();
    const opts = { user: 'PC-Test', appVersion: '5.2.0-beta', now: () => '2026-09-04T10:00:00.000Z' };
    expect(await applyMigrations(client, migrations, opts)).toContain('0003_quote_deposits');
    expect(await applyMigrations(client, migrations, opts)).toEqual([]);
  });
});

// ── setQuoteDeposit ──────────────────────────────────────────────
describe('setQuoteDeposit', () => {
  const PAID = { amount: 249, at: '2026-09-04T10:00:00.000Z', by: 'Mostrador' };
  const NOW = '2026-09-04T10:00:00.000Z';

  test('paid: flips the flat status to accepted FIRST, then upserts quote_deposits', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    client.calls.length = 0;
    const res = await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: PAID, now: NOW });
    expect(res).toEqual({ ok: true, changes: 1 });
    expect(client.calls[0].sql).toBe('UPDATE quotes SET status = ?, status_ts = ? WHERE id = ?');
    expect(client.calls[0].params).toEqual(['accepted', NOW, 'PP-2026-0001']);
    expect(client.calls[1].sql).toMatch(/INSERT INTO quote_deposits[^]*ON CONFLICT\(quote_id\) DO UPDATE/);
    expect(client.calls[1].params).toEqual(['PP-2026-0001', 249, PAID.at, 'Mostrador']);
    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote.status).toBe('accepted');
    expect(quote.deposit_paid).toEqual(PAID);
    expect(quote.version).toBe(1); // payload untouched
  });

  test('clear: status back to pending and the deposit row deleted', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: PAID, now: NOW });
    client.calls.length = 0;
    const res = await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: null, now: NOW });
    expect(res).toEqual({ ok: true, changes: 1 });
    expect(client.calls[0].params).toEqual(['pending', NOW, 'PP-2026-0001']);
    expect(client.calls[1].sql).toBe('DELETE FROM quote_deposits WHERE quote_id = ?');
    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote.status).toBe('pending');
    expect(quote.deposit_paid).toBeNull();
  });

  test('unknown id: the status UPDATE reports 0 changes and NOTHING else is written', async () => {
    const client = fakeClient();
    const res = await setQuoteDeposit(client, { id: 'PP-2026-9999', paid: PAID, now: NOW });
    expect(res).toEqual({ ok: false, changes: 0 });
    expect(client.calls).toHaveLength(1);
  });

  test('getFullQuote: the join is authoritative — a stale payload copy of deposit_paid is overridden with null', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote({ deposit_paid: { amount: 1, at: NOW, by: 'stale' } }));
    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote.deposit_paid).toBeNull();
  });

  test('listFullQuotes rows carry the deposit columns (null when unpaid)', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    await saveFullQuote(client, sampleFullQuote({ id: 'PP-2026-0002', ts: '2026-06-13T10:00:00.000Z' }));
    await setQuoteDeposit(client, { id: 'PP-2026-0002', paid: PAID, now: NOW });
    const list = await listFullQuotes(client);
    const byId = Object.fromEntries(list.map((r) => [r.id, r]));
    expect(byId['PP-2026-0001'].deposit_amount).toBeNull();
    expect(byId['PP-2026-0002'].deposit_amount).toBe(249);
    expect(byId['PP-2026-0002'].deposit_paid_at).toBe(PAID.at);
    const sql = client.calls.at(-1).sql;
    expect(sql).toMatch(/LEFT JOIN quote_deposits/);
  });

  test('deleteFullQuote also deletes the deposit row', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: PAID, now: NOW });
    await deleteFullQuote(client, 'PP-2026-0001');
    expect(client.calls.some((c) => c.sql === 'DELETE FROM quote_deposits WHERE quote_id = ?')).toBe(true);
    expect(client.deposits.size).toBe(0);
    // FK-mandated order: the deposit row (references quotes(id)) must be
    // deleted before the flat quotes row.
    const depIdx = client.calls.findIndex((c) => /DELETE FROM quote_deposits/.test(c.sql));
    const flatIdx = client.calls.findIndex((c) => /DELETE FROM quotes\b/.test(c.sql));
    expect(depIdx).toBeGreaterThanOrEqual(0);
    expect(depIdx).toBeLessThan(flatIdx);
  });
});
