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
