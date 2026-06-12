// ============================================================
// Tests · lib/d1-client.js
// ============================================================
import { describe, test, expect, vi } from 'vitest';
import { createD1Client, D1ClientError } from '../lib/d1-client.js';

function fakeFetch(jsonBody, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({ ok, status, json: async () => jsonBody }));
}

describe('createD1Client', () => {
  test('rejects construction without a token', () => {
    expect(() => createD1Client({})).toThrow(D1ClientError);
  });

  test('sends Bearer token and JSON headers to the API base', async () => {
    const fetchImpl = fakeFetch({ success: true, result: [] });
    const client = createD1Client({ token: 'tok123', fetchImpl });
    await client.listAccounts();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok123',
          'Content-Type': 'application/json'
        })
      })
    );
  });

  test('throws D1ClientError with Cloudflare error detail on success:false', async () => {
    const fetchImpl = fakeFetch(
      { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
      { ok: false, status: 403 }
    );
    const client = createD1Client({ token: 'bad', fetchImpl });
    await expect(client.listAccounts()).rejects.toThrow(/Authentication error/);
    await expect(client.listAccounts()).rejects.toMatchObject({ status: 403 });
  });

  test('throws a clear error when the response body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new Error('bad json'); }
    }));
    const client = createD1Client({ token: 'tok', fetchImpl });
    await expect(client.listAccounts()).rejects.toThrow(/502/);
  });
});

describe('database operations', () => {
  const ACC = 'acc1';
  const DB = 'db-uuid-1';

  test('listDatabases hits the account d1 endpoint', async () => {
    const fetchImpl = fakeFetch({ success: true, result: [{ uuid: DB, name: 'packprice' }] });
    const client = createD1Client({ token: 't', accountId: ACC, fetchImpl });
    const dbs = await client.listDatabases();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/accounts/acc1/d1/database');
    expect(dbs[0].name).toBe('packprice');
  });

  test('findDatabaseByName returns the match or null', async () => {
    const fetchImpl = fakeFetch({ success: true, result: [{ uuid: DB, name: 'packprice' }] });
    const client = createD1Client({ token: 't', accountId: ACC, fetchImpl });
    expect((await client.findDatabaseByName('packprice')).uuid).toBe(DB);
    expect(await client.findDatabaseByName('otra')).toBeNull();
  });

  test('createDatabase POSTs the name', async () => {
    const fetchImpl = fakeFetch({ success: true, result: { uuid: DB, name: 'packprice' } });
    const client = createD1Client({ token: 't', accountId: ACC, fetchImpl });
    const db = await client.createDatabase('packprice');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ name: 'packprice' });
    expect(db.uuid).toBe(DB);
  });

  test('query sends sql+params and unwraps the first result set', async () => {
    const fetchImpl = fakeFetch({
      success: true,
      result: [{ results: [{ id: 'crew_full' }], success: true, meta: { changes: 0 } }]
    });
    const client = createD1Client({ token: 't', accountId: ACC, databaseId: DB, fetchImpl });
    const r = await client.query('SELECT id FROM packs WHERE id = ?', ['crew_full']);
    expect(fetchImpl.mock.calls[0][0]).toContain('/d1/database/db-uuid-1/query');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ sql: 'SELECT id FROM packs WHERE id = ?', params: ['crew_full'] });
    expect(r.results[0].id).toBe('crew_full');
    expect(r.meta.changes).toBe(0);
  });

  test('exec sends multi-statement sql without params and returns all result sets', async () => {
    const fetchImpl = fakeFetch({ success: true, result: [{ success: true }, { success: true }] });
    const client = createD1Client({ token: 't', accountId: ACC, databaseId: DB, fetchImpl });
    const r = await client.exec('CREATE TABLE a (x); CREATE TABLE b (y);');
    expect(r).toHaveLength(2);
  });
});
