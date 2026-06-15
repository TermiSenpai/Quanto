// ============================================================
// PackPrice · Cloudflare D1 REST client
// ============================================================
// Talks directly to Cloudflare's REST API (api.cloudflare.com)
// to read/write the customer's own D1 database. There is NO
// Worker and NO server-side code — per the documented debate in
// CLAUDE.md (2026-06-12, cloud storage without backend), the app
// self-provisions and queries D1 over plain HTTPS.
//
// Constraints:
//   - Main-process only. The renderer never imports this module
//     and the API token must never reach the renderer.
//   - Zero dependencies: native fetch, injectable (`fetchImpl`)
//     so tests run without network access.
//   - All failures surface as D1ClientError with Spanish,
//     user-presentable messages (fail-fast, no silent swallowing).
// ============================================================

'use strict';

const API_BASE = 'https://api.cloudflare.com/client/v4';

class D1ClientError extends Error {
  constructor(message, { status = null, errors = [], cause, network = false } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'D1ClientError';
    this.status = status;
    this.errors = errors;
    // Structural transport-failure flag: true ONLY when fetch itself
    // rejected (offline/DNS/TLS — Cloudflare was never reached). Server
    // rejections (HTTP 4xx/5xx, success:false) keep it false. The offline
    // outbox enqueue keys off this flag, never off the error text — a
    // server-rejected (malformed) quote must surface as a failure, not be
    // retried forever (CLAUDE.md hard rule §4 / §6, cloud-bootstrap).
    this.network = Boolean(network);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createD1Client({ token, accountId = null, databaseId = null, fetchImpl = globalThis.fetch, sleepImpl = defaultSleep, baseUrl = API_BASE } = {}) {
  if (!token) throw new D1ClientError('Falta el token de API de Cloudflare');

  // Ids are validated before building URLs: an undefined id would
  // otherwise produce a syntactically valid but wrong endpoint
  // (e.g. /accounts/null/...) and a confusing Cloudflare 404.
  function requireAccount(account) {
    if (account === null || account === undefined) {
      throw new D1ClientError('Falta el identificador de la cuenta de Cloudflare');
    }
    return account;
  }

  function requireDatabase(db) {
    if (db === null || db === undefined) {
      throw new D1ClientError('Falta el identificador de la base de datos D1');
    }
    return db;
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (err) {
      // fetch itself rejecting means we never reached Cloudflare
      // (offline, DNS, TLS) — map it to a message the user can act on.
      // network:true is the ONLY true offline signal (the outbox enqueues
      // on it); server rejections below stay network:false.
      throw new D1ClientError('No se pudo conectar con Cloudflare — comprueba la conexión a internet', { cause: err, network: true });
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new D1ClientError('Respuesta no válida de Cloudflare (HTTP ' + res.status + ')', { status: res.status });
    }
    // Cloudflare can answer HTTP 200 with success:false, so both
    // signals are checked.
    if (!res.ok || json.success === false) {
      const errors = (json && json.errors) || [];
      const detail = errors.map((e) => e.message).join('; ');
      throw new D1ClientError('Cloudflare rechazó la petición: ' + (detail || 'HTTP ' + res.status), { status: res.status, errors });
    }
    return json.result;
  }

  // Method defaults read `client.accountId` / `client.databaseId`
  // (live properties, not the constructor closure) so callers can
  // assign the uuid returned by createDatabase and keep using the
  // same client during first-run provisioning.
  const client = {
    accountId,
    databaseId,

    async listAccounts() {
      return request('GET', '/accounts');
    },

    async listDatabases(account = client.accountId) {
      return request('GET', `/accounts/${requireAccount(account)}/d1/database`);
    },

    async findDatabaseByName(name, account = client.accountId) {
      const dbs = await client.listDatabases(account);
      return dbs.find((d) => d.name === name) || null;
    },

    async createDatabase(name, account = client.accountId) {
      return request('POST', `/accounts/${requireAccount(account)}/d1/database`, { name });
    },

    async query(sql, params = [], db = client.databaseId, account = client.accountId) {
      const result = await request('POST', `/accounts/${requireAccount(account)}/d1/database/${requireDatabase(db)}/query`, { sql, params });
      return result[0];
    },

    async exec(sqlText, db = client.databaseId, account = client.accountId) {
      return request('POST', `/accounts/${requireAccount(account)}/d1/database/${requireDatabase(db)}/query`, { sql: sqlText });
    },

    // Full SQL dump of the database (the pre-migration backup of
    // planes/v5-cloud-sync.md §6, step 2). Cloudflare's export is
    // asynchronous: the first POST starts it, follow-up POSTs resend
    // the bookmark until a signed download URL is ready. The exact
    // polling shape is not pinned by Cloudflare's docs, so the loop is
    // deliberately tolerant: it accepts `signed_url` / `at_bookmark`
    // both at the top level of `result` and nested under
    // `result.result` (both depths observed in the wild).
    async exportDatabase({ db = client.databaseId, account = client.accountId, pollIntervalMs = 1000, maxPolls = 60 } = {}) {
      const path = `/accounts/${requireAccount(account)}/d1/database/${requireDatabase(db)}/export`;
      let bookmark = null;
      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) await sleepImpl(pollIntervalMs);
        const body = bookmark === null
          ? { output_format: 'polling' }
          : { output_format: 'polling', current_bookmark: bookmark };
        const result = await request('POST', path, body);
        const signedUrl = (result && result.signed_url) || (result && result.result && result.result.signed_url) || null;
        if (signedUrl) return downloadSignedUrl(signedUrl);
        bookmark = (result && result.at_bookmark) || (result && result.result && result.result.at_bookmark) || bookmark;
      }
      throw new D1ClientError('La exportación de la base de datos D1 no terminó tras ' + maxPolls + ' intentos — vuelve a intentarlo en unos minutos');
    }
  };

  // The signed URL is a pre-authorized R2 link: it must be fetched
  // WITHOUT the Authorization header (sending the API token to a
  // non-Cloudflare-API host would leak it).
  async function downloadSignedUrl(url) {
    let res;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      throw new D1ClientError('No se pudo descargar la copia exportada de la base de datos D1', { cause: err });
    }
    if (!res.ok) {
      throw new D1ClientError('No se pudo descargar la copia exportada de la base de datos D1 (HTTP ' + res.status + ')', { status: res.status });
    }
    return res.text();
  }
  return client;
}

module.exports = { createD1Client, D1ClientError };
