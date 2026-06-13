// ============================================================
// Tests · lib/cloud-quotes.js (quote upload, status, stats data)
// ============================================================
// Pure module: the D1 client is injected. A fake client mirrors
// lib/d1-client.js query(sql, params) → { results, meta } and records
// every statement so the tests can pin the exact SQL/params and prove
// INSERT OR IGNORE idempotency, the status validation and the date
// filter of fetchStatsData.
// ============================================================

import { describe, test, expect } from 'vitest';
import {
  buildQuoteRows,
  uploadQuote,
  updateQuoteStatus,
  fetchStatsData,
  validateQuoteRow,
  QUOTE_STATUSES
} from '../lib/cloud-quotes.js';

// A representative cloud quote as the renderer would build it.
function sampleQuote(overrides = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    ts: '2026-06-12T10:00:00.000Z',
    user: 'Alberto',
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
    catalog_version: 7,
    items: [
      { product_id: 'BEAGLE', sides: 'two_sides', qty: 24 },
      { product_id: 'CLASICA', sides: 'two_sides', qty: 24 }
    ],
    addons: [
      { addon_id: 'name', qty: 24 }
    ],
    ...overrides
  };
}

// Fake client mirroring d1-client: records statements, returns the
// shape query() returns ({ results, meta }).
function fakeClient(answers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      for (const [re, fn] of Object.entries(answers)) {
        if (new RegExp(re).test(sql)) return fn(sql, params);
      }
      return { results: [], meta: { changes: 1 } };
    }
  };
}

describe('QUOTE_STATUSES', () => {
  test('are exactly the three allowed values (matches the CHECK in 0001_init.sql)', () => {
    expect(QUOTE_STATUSES).toEqual(['pending', 'accepted', 'rejected']);
  });
});

describe('buildQuoteRows', () => {
  test('maps the quote to rows matching the D1 columns', () => {
    const { quote, items, addons } = buildQuoteRows(sampleQuote());
    expect(quote).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      ts: '2026-06-12T10:00:00.000Z',
      user: 'Alberto',
      client_name: 'Peña La Cuesta',
      client_phone: '600123123',
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
      catalog_version: 7
    });
    expect(items).toEqual([
      { quote_id: '11111111-2222-3333-4444-555555555555', product_id: 'BEAGLE', sides: 'two_sides', qty: 24 },
      { quote_id: '11111111-2222-3333-4444-555555555555', product_id: 'CLASICA', sides: 'two_sides', qty: 24 }
    ]);
    expect(addons).toEqual([
      { quote_id: '11111111-2222-3333-4444-555555555555', addon_id: 'name', qty: 24 }
    ]);
  });

  test('accepts flat client_name/client_phone when no customer object is given', () => {
    const { quote } = buildQuoteRows(sampleQuote({ customer: undefined, client_name: 'Directo', client_phone: '611' }));
    expect(quote.client_name).toBe('Directo');
    expect(quote.client_phone).toBe('611');
  });

  test('tolerates missing optional fields (sizes default 0, deviation/target null, no items/addons)', () => {
    const { quote, items, addons } = buildQuoteRows({
      id: 'u1', ts: 't', user: 'u', customer: { name: 'C', phone: 'p' },
      valid_until: 'v', pack_id: 'p1', tier: 'T1', total_units: 10,
      total_vat_inc: 100, sale_base: 80, margin_pct: 0.2, catalog_version: 3
    });
    expect(quote.qty_3xl).toBe(0);
    expect(quote.qty_4xl).toBe(0);
    expect(quote.qty_5xl).toBe(0);
    expect(quote.target_margin).toBeNull();
    expect(quote.pvp_deviation_pct).toBeNull();
    expect(items).toEqual([]);
    expect(addons).toEqual([]);
  });
});

describe('validateQuoteRow', () => {
  // Required NOT NULL fields with the primitive type the D1 column expects.
  const REQUIRED_STRINGS = ['id', 'ts', 'user', 'client_name', 'client_phone', 'valid_until', 'pack_id', 'tier'];
  const REQUIRED_NUMBERS = ['total_units', 'total_vat_inc', 'sale_base', 'margin_pct', 'catalog_version'];

  test('accepts a well-formed row built from a sample quote', () => {
    const { quote } = buildQuoteRows(sampleQuote());
    expect(() => validateQuoteRow(quote)).not.toThrow();
  });

  for (const field of REQUIRED_STRINGS) {
    test(`throws a Spanish error when the string field "${field}" is missing`, () => {
      const { quote } = buildQuoteRows(sampleQuote());
      delete quote[field];
      expect(() => validateQuoteRow(quote)).toThrow(/presupuesto/i);
    });
  }

  for (const field of REQUIRED_NUMBERS) {
    test(`throws a Spanish error when the number field "${field}" is missing`, () => {
      const { quote } = buildQuoteRows(sampleQuote());
      delete quote[field];
      expect(() => validateQuoteRow(quote)).toThrow(/presupuesto/i);
    });

    test(`throws a Spanish error when the number field "${field}" is the wrong type`, () => {
      const { quote } = buildQuoteRows(sampleQuote());
      quote[field] = 'not-a-number';
      expect(() => validateQuoteRow(quote)).toThrow(/presupuesto/i);
    });
  }

  test('the validation error is NOT a network error (so it is never queued)', () => {
    const { quote } = buildQuoteRows(sampleQuote());
    delete quote.pack_id;
    try {
      validateQuoteRow(quote);
      throw new Error('expected throw');
    } catch (err) {
      // No structural network flag → cloud-bootstrap will surface, not queue.
      expect(err.network).toBeFalsy();
    }
  });
});

describe('uploadQuote', () => {
  test('rejects a malformed quote BEFORE any network call (defense-in-depth)', async () => {
    const client = fakeClient();
    await expect(uploadQuote(client, sampleQuote({ pack_id: undefined })))
      .rejects.toThrow(/presupuesto/i);
    // Validation runs first → no SQL hit the client.
    expect(client.calls).toHaveLength(0);
  });

  test('INSERT OR IGNORE the quote, items and addons (idempotent by UUID PK)', async () => {
    const client = fakeClient();
    const res = await uploadQuote(client, sampleQuote());
    expect(res).toEqual({ ok: true, id: '11111111-2222-3333-4444-555555555555' });

    const quoteInsert = client.calls.find((c) => /INSERT OR IGNORE INTO quotes/.test(c.sql));
    expect(quoteInsert).toBeTruthy();
    // Idempotent: re-uploading the same UUID is harmless (OR IGNORE).
    expect(quoteInsert.sql).toMatch(/^INSERT OR IGNORE INTO quotes \(/);
    expect(quoteInsert.params[0]).toBe('11111111-2222-3333-4444-555555555555');

    const itemsInsert = client.calls.find((c) => /INSERT OR IGNORE INTO quote_items/.test(c.sql));
    expect(itemsInsert).toBeTruthy();
    expect(itemsInsert.params).toContain('BEAGLE');

    const addonsInsert = client.calls.find((c) => /INSERT OR IGNORE INTO quote_addons/.test(c.sql));
    expect(addonsInsert).toBeTruthy();
    expect(addonsInsert.params).toContain('name');
  });

  test('a quote with no items/addons inserts only the quote row', async () => {
    const client = fakeClient();
    await uploadQuote(client, sampleQuote({ items: [], addons: [] }));
    expect(client.calls.some((c) => /INSERT OR IGNORE INTO quotes/.test(c.sql))).toBe(true);
    expect(client.calls.some((c) => /quote_items/.test(c.sql))).toBe(false);
    expect(client.calls.some((c) => /quote_addons/.test(c.sql))).toBe(false);
  });

  test('every INSERT stays under D1\'s 100 bound-parameter cap', async () => {
    // 60 items × 4 cols = 240 params: must be chunked.
    const items = Array.from({ length: 60 }, (_, i) => ({ product_id: 'P' + i, sides: 'one_side', qty: 1 }));
    const client = fakeClient();
    await uploadQuote(client, sampleQuote({ items, addons: [] }));
    for (const c of client.calls) {
      expect(c.params.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('updateQuoteStatus', () => {
  test('UPDATE quotes SET status, status_ts WHERE id', async () => {
    const client = fakeClient();
    const res = await updateQuoteStatus(client, { id: 'q1', status: 'accepted', now: '2026-06-13T00:00:00.000Z' });
    expect(res).toEqual({ ok: true, id: 'q1', status: 'accepted' });
    const upd = client.calls[0];
    expect(upd.sql).toBe('UPDATE quotes SET status = ?, status_ts = ? WHERE id = ?');
    expect(upd.params).toEqual(['accepted', '2026-06-13T00:00:00.000Z', 'q1']);
  });

  test('rejects an invalid status with a Spanish error and never touches the client', async () => {
    const client = fakeClient();
    await expect(updateQuoteStatus(client, { id: 'q1', status: 'maybe', now: 't' }))
      .rejects.toThrow(/estado/i);
    expect(client.calls).toHaveLength(0);
  });

  test('accepts each of the three valid statuses', async () => {
    for (const status of QUOTE_STATUSES) {
      const client = fakeClient();
      const res = await updateQuoteStatus(client, { id: 'q1', status, now: 't' });
      expect(res.ok).toBe(true);
    }
  });
});

describe('fetchStatsData', () => {
  test('returns raw rows from all three tables filtered by the date range', async () => {
    const client = fakeClient({
      'FROM quotes': () => ({ results: [{ id: 'q1', ts: '2026-06-12T10:00:00.000Z' }], meta: {} }),
      'FROM quote_items': () => ({ results: [{ quote_id: 'q1', product_id: 'BEAGLE' }], meta: {} }),
      'FROM quote_addons': () => ({ results: [{ quote_id: 'q1', addon_id: 'name' }], meta: {} })
    });
    const out = await fetchStatsData(client, { from: '2026-06-01', to: '2026-06-30' });
    expect(out.quotes).toEqual([{ id: 'q1', ts: '2026-06-12T10:00:00.000Z' }]);
    expect(out.items).toEqual([{ quote_id: 'q1', product_id: 'BEAGLE' }]);
    expect(out.addons).toEqual([{ quote_id: 'q1', addon_id: 'name' }]);

    // The quotes query filters by ts within [from, to].
    const quotesQuery = client.calls.find((c) => /FROM quotes/.test(c.sql));
    expect(quotesQuery.sql).toMatch(/WHERE ts >= \? AND ts <= \?/);
    expect(quotesQuery.params).toEqual(['2026-06-01', '2026-06-30']);
  });

  test('only fetches items/addons for the quotes within the range', async () => {
    // With no quotes in range, there is nothing to join — items/addons empty.
    const client = fakeClient({
      'FROM quotes': () => ({ results: [], meta: {} })
    });
    const out = await fetchStatsData(client, { from: '2030-01-01', to: '2030-12-31' });
    expect(out.quotes).toEqual([]);
    expect(out.items).toEqual([]);
    expect(out.addons).toEqual([]);
  });
});
