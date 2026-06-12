'use strict';

const API_BASE = 'https://api.cloudflare.com/client/v4';

class D1ClientError extends Error {
  constructor(message, { status = null, errors = [] } = {}) {
    super(message);
    this.name = 'D1ClientError';
    this.status = status;
    this.errors = errors;
  }
}

function createD1Client({ token, accountId = null, databaseId = null, fetchImpl = globalThis.fetch, baseUrl = API_BASE } = {}) {
  if (!token) throw new D1ClientError('Falta el token de API de Cloudflare');

  async function request(method, path, body) {
    const res = await fetchImpl(baseUrl + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new D1ClientError('Respuesta no válida de Cloudflare (HTTP ' + res.status + ')', { status: res.status });
    }
    if (!res.ok || json.success === false) {
      const errors = (json && json.errors) || [];
      const detail = errors.map((e) => e.message).join('; ');
      throw new D1ClientError('Cloudflare rechazó la petición: ' + (detail || 'HTTP ' + res.status), { status: res.status, errors });
    }
    return json.result;
  }

  const client = {
    accountId,
    databaseId,
    async listAccounts() {
      return request('GET', '/accounts');
    }
  };
  client.listDatabases = async function (account = accountId) {
    return request('GET', `/accounts/${account}/d1/database`);
  };
  client.findDatabaseByName = async function (name, account = accountId) {
    const dbs = await client.listDatabases(account);
    return dbs.find((d) => d.name === name) || null;
  };
  client.createDatabase = async function (name, account = accountId) {
    return request('POST', `/accounts/${account}/d1/database`, { name });
  };
  client.query = async function (sql, params = [], db = databaseId, account = accountId) {
    const result = await request('POST', `/accounts/${account}/d1/database/${db}/query`, { sql, params });
    return result[0];
  };
  client.exec = async function (sqlText, db = databaseId, account = accountId) {
    return request('POST', `/accounts/${account}/d1/database/${db}/query`, { sql: sqlText });
  };
  client._request = request;
  return client;
}

module.exports = { createD1Client, D1ClientError };
