# Plan 1 — Fundación cloud (cliente D1 + migraciones + ensamblador)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** los tres cimientos de la v5 como módulos puros y testeados — cliente
REST de D1, sistema de migraciones aplicadas por la app, y ensamblador
bidireccional entidades↔`cfg` v4 — sin tocar UI, main ni preload.

**Architecture:** todo vive en `lib/` siguiendo las reglas de
`ARCHITECTURE.md` §3: módulos CommonJS puros (el cliente recibe `fetch`
inyectable; el loader es el único que toca `fs`), un test por módulo, cero
dependencias nuevas. El ensamblador es la pieza clave: hace que `calculo.js` y
`validateConfigSchema` funcionen igual con datos de D1 que con el archivo.

**Tech Stack:** Node (CommonJS), Vitest, `fetch` nativo. Nada más.

**Rama:** `feat/v5-foundation` desde `main` (tras mergear el refactor o en
paralelo — este plan no toca los archivos de las ondas 10–11).

**Convenciones de los tests:** inglés, un archivo por módulo en `tests/`,
mismo estilo que los existentes (`describe`/`test` de Vitest).

---

### Task 1: `lib/d1-client.js` — petición autenticada y errores

**Files:**
- Create: `lib/d1-client.js`
- Test: `tests/d1-client.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { describe, test, expect, vi } = require('vitest');
const { createD1Client, D1ClientError } = require('../lib/d1-client.js');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/d1-client.test.js`
Expected: FAIL — `Cannot find module '../lib/d1-client.js'`

- [ ] **Step 3: Write minimal implementation**

```js
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
  client._request = request;
  return client;
}

module.exports = { createD1Client, D1ClientError };
```

(`client._request` se usa internamente en la Task 2; no se expone en preload
jamás — este módulo solo lo usa main.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/d1-client.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/d1-client.js tests/d1-client.test.js
git commit -m "feat(cloud): D1 REST client core with auth and error mapping"
```

---

### Task 2: `lib/d1-client.js` — bases de datos y consultas

**Files:**
- Modify: `lib/d1-client.js`
- Test: `tests/d1-client.test.js` (añadir un `describe`)

- [ ] **Step 1: Write the failing tests** (añadir al archivo existente)

```js
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
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm vitest run tests/d1-client.test.js`
Expected: FAIL — `client.listDatabases is not a function`

- [ ] **Step 3: Implement** (añadir métodos al objeto `client` antes del `return`)

```js
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/d1-client.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/d1-client.js tests/d1-client.test.js
git commit -m "feat(cloud): D1 client database discovery, query and exec"
```

---

### Task 3: `db/migrations/0001_init.sql` — esquema inicial completo

**Files:**
- Create: `db/migrations/0001_init.sql`
- Modify: `package.json` (añadir `"db/**/*"` a `build.files`)

- [ ] **Step 1: Create the SQL file** — contenido íntegro (es el esquema de
`planes/v5-cloud-sync.md` §3 con las convenciones transversales aplicadas):

```sql
-- 0001_init.sql — esquema inicial Quanto v5 (aditivo desde aquí; jamás editar este archivo después de publicado)

CREATE TABLE IF NOT EXISTS parameters (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('number','string','boolean')));

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, web TEXT, notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  extra_cost_3xl REAL NOT NULL, target_margin REAL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT);

CREATE TABLE IF NOT EXISTS product_suppliers (
  product_id TEXT NOT NULL REFERENCES products(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  ref TEXT, price REAL NOT NULL, min_order INTEGER, is_default INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, supplier_id));

CREATE TABLE IF NOT EXISTS product_prices (
  product_id TEXT NOT NULL REFERENCES products(id),
  sides TEXT NOT NULL, tier TEXT NOT NULL, price REAL NOT NULL,
  PRIMARY KEY (product_id, sides, tier));

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, from_qty INTEGER NOT NULL,
  to_qty INTEGER, time_reduction REAL NOT NULL, position INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, price REAL NOT NULL,
  vat_included INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL,
  applies_to TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT);

CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, icon TEXT,
  pricing_mode TEXT NOT NULL CHECK (pricing_mode IN ('bundle','components')),
  min_total INTEGER NOT NULL, target_margin REAL,
  free_components INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT);

CREATE TABLE IF NOT EXISTS pack_options (
  pack_id TEXT NOT NULL REFERENCES packs(id),
  option_id TEXT NOT NULL, label TEXT NOT NULL,
  maps_product INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL,
  PRIMARY KEY (pack_id, option_id));

CREATE TABLE IF NOT EXISTS pack_option_values (
  pack_id TEXT NOT NULL, option_id TEXT NOT NULL, value_id TEXT NOT NULL,
  label TEXT NOT NULL, sides TEXT, maps_to_product TEXT REFERENCES products(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (pack_id, option_id, value_id));

CREATE TABLE IF NOT EXISTS pack_components (
  pack_id TEXT NOT NULL REFERENCES packs(id),
  component_id TEXT NOT NULL, label TEXT NOT NULL,
  product_id TEXT REFERENCES products(id), qty_per_pack INTEGER,
  position INTEGER NOT NULL,
  PRIMARY KEY (pack_id, component_id));

CREATE TABLE IF NOT EXISTS bundle_prices (
  pack_id TEXT NOT NULL REFERENCES packs(id),
  combo_key TEXT NOT NULL, tier TEXT NOT NULL, price REAL NOT NULL,
  PRIMARY KEY (pack_id, combo_key, tier));

CREATE TABLE IF NOT EXISTS company (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL, user TEXT NOT NULL,
  client_name TEXT NOT NULL, client_phone TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  pack_id TEXT NOT NULL, tier TEXT NOT NULL,
  total_units INTEGER NOT NULL,
  qty_3xl INTEGER NOT NULL DEFAULT 0,
  qty_4xl INTEGER NOT NULL DEFAULT 0,
  qty_5xl INTEGER NOT NULL DEFAULT 0,
  total_vat_inc REAL NOT NULL, sale_base REAL NOT NULL,
  margin_pct REAL NOT NULL, target_margin REAL, pvp_deviation_pct REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  status_ts TEXT,
  catalog_version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS quote_items (
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  product_id TEXT NOT NULL, sides TEXT NOT NULL, qty INTEGER NOT NULL,
  PRIMARY KEY (quote_id, product_id, sides));

CREATE TABLE IF NOT EXISTS quote_addons (
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  addon_id TEXT NOT NULL, qty INTEGER NOT NULL,
  PRIMARY KEY (quote_id, addon_id));

CREATE TABLE IF NOT EXISTS pdf_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  html TEXT NOT NULL, css TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT);

CREATE TABLE IF NOT EXISTS catalog_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalog_version INTEGER NOT NULL DEFAULT 1,
  schema_version INTEGER NOT NULL DEFAULT 1,
  min_app_version TEXT NOT NULL DEFAULT '5.0.0',
  migrating_since TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL DEFAULT 'init');

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, user TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL,
  diff_json TEXT NOT NULL, catalog_version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS snapshots (
  catalog_version INTEGER PRIMARY KEY, json TEXT NOT NULL, ts TEXT NOT NULL);

INSERT OR IGNORE INTO catalog_meta (id) VALUES (1);
```

- [ ] **Step 2: Add `db/**/*` to the packaged files** — en `package.json`,
dentro de `build.files`, añadir la línea `"db/**/*",` junto a `"lib/**/*"`.

- [ ] **Step 3: Sanity check del SQL en local** (Node trae `node:sqlite`
experimental solo en versiones nuevas; aquí basta una comprobación de sintaxis
con la propia suite — se hace en la Task 4 con el migrador y un cliente
falso). Verificar a mano: cada sentencia termina en `;`, ninguna línea
`PRIMARY KEY` huérfana.

Run: `git diff --stat`
Expected: 2 archivos cambiados.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0001_init.sql package.json
git commit -m "feat(cloud): initial D1 schema as bundled migration 0001"
```

---

### Task 4: `lib/migration-loader.js` — cargar migraciones empaquetadas

**Files:**
- Create: `lib/migration-loader.js`
- Test: `tests/migration-loader.test.js`
- Create (fixtures): `tests/fixtures/migrations/0001_a.sql`, `0002_b.sql`, `notas.txt`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const path = require('node:path');
const { describe, test, expect } = require('vitest');
const { loadMigrations } = require('../lib/migration-loader.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'migrations');

describe('loadMigrations', () => {
  test('returns numbered .sql files sorted by id with their content', () => {
    const migrations = loadMigrations(FIXTURES);
    expect(migrations.map((m) => m.id)).toEqual(['0001_a', '0002_b']);
    expect(migrations[0].sql).toContain('CREATE TABLE');
  });

  test('ignores files that are not NNNN_name.sql', () => {
    const migrations = loadMigrations(FIXTURES);
    expect(migrations.some((m) => m.id.includes('notas'))).toBe(false);
  });

  test('throws a Spanish error if the directory does not exist', () => {
    expect(() => loadMigrations(path.join(FIXTURES, 'nope'))).toThrow(/migraciones/i);
  });
});
```

Fixtures: `0001_a.sql` → `CREATE TABLE a (x INTEGER);` · `0002_b.sql` →
`CREATE TABLE b (y INTEGER);` · `notas.txt` → `no soy una migración`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/migration-loader.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadMigrations(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    throw new Error('No se encontró la carpeta de migraciones: ' + dir);
  }
  return files
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      id: f.replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(dir, f), 'utf8')
    }));
}

module.exports = { loadMigrations };
```

- [ ] **Step 4: Run tests** → PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/migration-loader.js tests/migration-loader.test.js tests/fixtures/migrations/
git commit -m "feat(cloud): bundled SQL migration loader"
```

---

### Task 5: `lib/db-migrator.js` — aplicar migraciones, idempotente

**Files:**
- Create: `lib/db-migrator.js`
- Test: `tests/db-migrator.test.js`

- [ ] **Step 1: Write the failing test** — usa un cliente D1 falso en memoria
que registra qué SQL recibió:

```js
'use strict';
const { describe, test, expect } = require('vitest');
const { applyMigrations } = require('../lib/db-migrator.js');

function fakeClient(appliedIds = []) {
  const executed = [];
  const rows = appliedIds.map((id) => ({ id }));
  return {
    executed,
    async exec(sql) { executed.push(sql); return [{ success: true }]; },
    async query(sql, params = []) {
      executed.push(sql);
      if (/SELECT id FROM schema_migrations/.test(sql)) return { results: rows, meta: {} };
      if (/INSERT INTO schema_migrations/.test(sql)) { rows.push({ id: params[0] }); return { results: [], meta: { changes: 1 } }; }
      return { results: [], meta: {} };
    }
  };
}

const MIGRATIONS = [
  { id: '0001_init', sql: 'CREATE TABLE IF NOT EXISTS a (x);' },
  { id: '0002_more', sql: 'CREATE TABLE IF NOT EXISTS b (y);' }
];
const OPTS = { user: 'PC-Test', appVersion: '5.0.0-beta', now: () => '2026-06-12T10:00:00Z' };

describe('applyMigrations', () => {
  test('applies all pending migrations in order and records them', async () => {
    const client = fakeClient([]);
    const done = await applyMigrations(client, MIGRATIONS, OPTS);
    expect(done).toEqual(['0001_init', '0002_more']);
    const creates = client.executed.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS a') || s.startsWith('CREATE TABLE IF NOT EXISTS b'));
    expect(creates).toHaveLength(2);
  });

  test('is idempotent: a second run applies nothing', async () => {
    const client = fakeClient(['0001_init', '0002_more']);
    const done = await applyMigrations(client, MIGRATIONS, OPTS);
    expect(done).toEqual([]);
  });

  test('applies only the missing tail', async () => {
    const client = fakeClient(['0001_init']);
    const done = await applyMigrations(client, MIGRATIONS, OPTS);
    expect(done).toEqual(['0002_more']);
  });

  test('records user, app version and timestamp with each row', async () => {
    const client = fakeClient([]);
    await applyMigrations(client, [MIGRATIONS[0]], OPTS);
    const insert = client.executed.find((s) => /INSERT INTO schema_migrations/.test(s));
    expect(insert).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL, module not found

- [ ] **Step 3: Implement**

```js
'use strict';

const ENSURE_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  'id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, ' +
  'applied_by TEXT NOT NULL, app_version TEXT NOT NULL);';

async function applyMigrations(client, migrations, { user, appVersion, now }) {
  await client.exec(ENSURE_TABLE_SQL);
  const res = await client.query('SELECT id FROM schema_migrations ORDER BY id');
  const applied = new Set((res.results || []).map((row) => row.id));
  const done = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    await client.exec(migration.sql);
    await client.query(
      'INSERT INTO schema_migrations (id, applied_at, applied_by, app_version) VALUES (?, ?, ?, ?)',
      [migration.id, now(), user, appVersion]
    );
    done.push(migration.id);
  }
  return done;
}

module.exports = { applyMigrations };
```

> El candado `migrating_since` y el backup-export previos pertenecen al
> Plan 2 (necesitan `catalog_meta` viva y la API de export verificada); el
> contrato completo está en `planes/v5-cloud-sync.md` §6 y este módulo es el
> paso «MIGRAR» de ese diagrama.

- [ ] **Step 4: Run tests** → PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/db-migrator.js tests/db-migrator.test.js
git commit -m "feat(cloud): idempotent app-side migration runner"
```

---

### Task 6: `lib/catalog-assembler.js` — `disassemble(cfg)` → entidades

**Files:**
- Create: `lib/catalog-assembler.js`
- Test: `tests/catalog-assembler.test.js`

> **Fuente de verdad de la forma v4:** `config.default.js`
> (`buildDefaultConfig()`) y `ARCHITECTURE.md` §6. El test de round-trip de la
> Task 8 es el árbitro: si algún campo real difiere de lo aquí escrito
> (p. ej. la forma exacta de `maps_product`), se ajusta el ensamblador hasta
> que el round-trip sea exacto — nunca al revés.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { describe, test, expect } = require('vitest');
const { disassemble } = require('../lib/catalog-assembler.js');
const { buildDefaultConfig } = require('../config.default.js');

describe('disassemble', () => {
  const cfg = buildDefaultConfig();
  const e = disassemble(cfg);

  test('parameters become typed key-value rows', () => {
    const vat = e.parameters.find((p) => p.key === 'vat');
    expect(vat).toBeTruthy();
    expect(vat.type).toBe('number');
    expect(Number(vat.value)).toBe(cfg.parameters.vat);
  });

  test('every product produces its rows, supplier links and price cells', () => {
    expect(e.products.map((p) => p.id).sort()).toEqual(Object.keys(cfg.products).sort());
    const anyProductId = Object.keys(cfg.products)[0];
    const product = cfg.products[anyProductId];
    const priceRows = e.product_prices.filter((r) => r.product_id === anyProductId);
    const expectedCells = Object.values(product.prices).reduce((n, tiers) => n + Object.keys(tiers).length, 0);
    expect(priceRows).toHaveLength(expectedCells);
    const links = e.product_suppliers.filter((r) => r.product_id === anyProductId);
    expect(links).toHaveLength(product.suppliers.length);
  });

  test('tiers keep their order via position', () => {
    expect(e.tiers.map((t) => t.position)).toEqual(cfg.tiers.map((_, i) => i));
    expect(e.tiers[0].from_qty).toBe(cfg.tiers[0].from);
  });

  test('packs expand into options, values, components and bundle prices', () => {
    expect(e.packs.map((p) => p.id).sort()).toEqual(Object.keys(cfg.packs).sort());
    const bundleId = Object.keys(cfg.packs).find((id) => cfg.packs[id].pricing_mode === 'bundle');
    const bundle = cfg.packs[bundleId];
    const cells = e.bundle_prices.filter((r) => r.pack_id === bundleId);
    const expected = Object.values(bundle.bundle_prices).reduce((n, tiers) => n + Object.keys(tiers).length, 0);
    expect(cells).toHaveLength(expected);
  });

  test('company and quote_settings rows are JSON-encoded values', () => {
    const name = e.company.find((r) => r.key === 'company.name');
    expect(JSON.parse(name.value)).toBe(cfg.company.name);
    const validity = e.company.find((r) => r.key === 'quote_settings.validity_days');
    expect(JSON.parse(validity.value)).toBe(cfg.quote_settings.validity_days);
  });

  test('never emits the admin section', () => {
    const json = JSON.stringify(e);
    expect(json).not.toContain('password');
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL, module not found

- [ ] **Step 3: Implement `disassemble`**

```js
'use strict';

function jsType(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function disassemble(cfg) {
  const parameters = Object.entries(cfg.parameters).map(([key, value]) => ({
    key, value: String(value), type: jsType(value)
  }));

  const suppliers = Object.entries(cfg.suppliers).map(([id, s]) => ({
    id, name: s.name, web: s.web ?? null, notes: s.notes ?? null
  }));

  const products = [];
  const product_suppliers = [];
  const product_prices = [];
  for (const [id, p] of Object.entries(cfg.products)) {
    products.push({
      id, name: p.name, category: p.category,
      extra_cost_3xl: p.extra_cost_3xl, target_margin: p.target_margin ?? null
    });
    for (const link of p.suppliers) {
      product_suppliers.push({
        product_id: id, supplier_id: link.supplier, ref: link.ref ?? null,
        price: link.price, min_order: link.min_order ?? null,
        is_default: link.is_default ? 1 : 0
      });
    }
    for (const [sides, byTier] of Object.entries(p.prices)) {
      for (const [tier, price] of Object.entries(byTier)) {
        product_prices.push({ product_id: id, sides, tier, price });
      }
    }
  }

  const tiers = cfg.tiers.map((t, i) => ({
    id: t.id, label: t.label, from_qty: t.from, to_qty: t.to ?? null,
    time_reduction: t.time_reduction, position: i
  }));

  const addons = Object.entries(cfg.addons).map(([id, a]) => ({
    id, label: a.label, price: a.price, vat_included: a.vat_included ? 1 : 0,
    cost: a.cost, applies_to: JSON.stringify(a.applies_to)
  }));

  const packs = [];
  const pack_options = [];
  const pack_option_values = [];
  const pack_components = [];
  const bundle_prices = [];
  for (const [id, pk] of Object.entries(cfg.packs)) {
    packs.push({
      id, name: pk.name, description: pk.description ?? null, icon: pk.icon ?? null,
      pricing_mode: pk.pricing_mode, min_total: pk.min_total,
      target_margin: pk.target_margin ?? null,
      free_components: pk.free_components ? 1 : 0
    });
    (pk.options || []).forEach((option, oi) => {
      const mapping = option.maps_product || null;
      pack_options.push({
        pack_id: id, option_id: option.id, label: option.label,
        maps_product: mapping ? 1 : 0, position: oi
      });
      (option.values || []).forEach((value, vi) => {
        pack_option_values.push({
          pack_id: id, option_id: option.id, value_id: value.id,
          label: value.label, sides: value.sides ?? null,
          maps_to_product: mapping ? (mapping[value.id] ?? null) : null,
          position: vi
        });
      });
    });
    (pk.components || []).forEach((component, ci) => {
      pack_components.push({
        pack_id: id, component_id: component.id, label: component.label,
        product_id: component.product ?? null,
        qty_per_pack: component.qty_per_pack ?? null, position: ci
      });
    });
    for (const [combo_key, byTier] of Object.entries(pk.bundle_prices || {})) {
      for (const [tier, price] of Object.entries(byTier)) {
        bundle_prices.push({ pack_id: id, combo_key, tier, price });
      }
    }
  }

  const company = [
    ...Object.entries(cfg.company).map(([k, v]) => ({ key: 'company.' + k, value: JSON.stringify(v) })),
    ...Object.entries(cfg.quote_settings).map(([k, v]) => ({ key: 'quote_settings.' + k, value: JSON.stringify(v) }))
  ];

  return {
    parameters, suppliers, products, product_suppliers, product_prices,
    tiers, addons, packs, pack_options, pack_option_values, pack_components,
    bundle_prices, company
  };
}

module.exports = { disassemble };
```

- [ ] **Step 4: Run tests** → PASS (6 tests). Si alguno falla por la forma
real de `config.default.js` (p. ej. `maps_product`), ajustar el código a la
forma real — el default es la verdad.

- [ ] **Step 5: Commit**

```bash
git add lib/catalog-assembler.js tests/catalog-assembler.test.js
git commit -m "feat(cloud): catalog disassembler cfg -> normalized entities"
```

---

### Task 7: `lib/catalog-assembler.js` — `assemble(entities, meta)` → `cfg`

**Files:**
- Modify: `lib/catalog-assembler.js`
- Test: `tests/catalog-assembler.test.js` (añadir `describe`)

- [ ] **Step 1: Write the failing tests**

```js
const { assemble } = require('../lib/catalog-assembler.js');

describe('assemble', () => {
  const cfg = buildDefaultConfig();
  const META = { version: cfg.version, updated_at: cfg.updated_at, modified_by: cfg.modified_by };

  test('rebuilds typed parameters', () => {
    const rebuilt = assemble(disassemble(cfg), META);
    expect(rebuilt.parameters.vat).toBe(cfg.parameters.vat);
    expect(typeof rebuilt.parameters.vat).toBe('number');
  });

  test('restores option/value/component ordering from position', () => {
    const entities = disassemble(cfg);
    const packId = Object.keys(cfg.packs)[0];
    const shuffled = {
      ...entities,
      pack_option_values: [...entities.pack_option_values].reverse(),
      pack_options: [...entities.pack_options].reverse(),
      pack_components: [...entities.pack_components].reverse()
    };
    const rebuilt = assemble(shuffled, META);
    expect(rebuilt.packs[packId].options.map((o) => o.id))
      .toEqual(cfg.packs[packId].options.map((o) => o.id));
  });

  test('decodes company and quote_settings JSON values', () => {
    const rebuilt = assemble(disassemble(cfg), META);
    expect(rebuilt.company).toEqual(cfg.company);
    expect(rebuilt.quote_settings).toEqual(cfg.quote_settings);
  });
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL, `assemble is not a function`

- [ ] **Step 3: Implement `assemble`** (añadir al módulo y exportar)

```js
function castParameter(row) {
  if (row.type === 'number') return Number(row.value);
  if (row.type === 'boolean') return row.value === 'true';
  return row.value;
}

function byPosition(a, b) { return a.position - b.position; }

function assemble(entities, meta) {
  const parameters = {};
  for (const row of entities.parameters) parameters[row.key] = castParameter(row);

  const suppliers = {};
  for (const s of entities.suppliers) {
    suppliers[s.id] = { name: s.name, ...(s.web != null && { web: s.web }), ...(s.notes != null && { notes: s.notes }) };
  }

  const products = {};
  for (const p of entities.products) {
    products[p.id] = {
      name: p.name, category: p.category, extra_cost_3xl: p.extra_cost_3xl,
      ...(p.target_margin != null && { target_margin: p.target_margin }),
      suppliers: [], prices: {}
    };
  }
  for (const link of entities.product_suppliers) {
    products[link.product_id].suppliers.push({
      supplier: link.supplier_id, ...(link.ref != null && { ref: link.ref }),
      price: link.price, ...(link.min_order != null && { min_order: link.min_order }),
      is_default: link.is_default === 1
    });
  }
  for (const cell of entities.product_prices) {
    const prices = products[cell.product_id].prices;
    (prices[cell.sides] ||= {})[cell.tier] = cell.price;
  }

  const tiers = [...entities.tiers].sort(byPosition).map((t) => ({
    id: t.id, label: t.label, from: t.from_qty, to: t.to_qty ?? null,
    time_reduction: t.time_reduction
  }));

  const addons = {};
  for (const a of entities.addons) {
    addons[a.id] = {
      label: a.label, price: a.price, vat_included: a.vat_included === 1,
      cost: a.cost, applies_to: JSON.parse(a.applies_to)
    };
  }

  const packs = {};
  for (const pk of entities.packs) {
    packs[pk.id] = {
      name: pk.name,
      ...(pk.description != null && { description: pk.description }),
      ...(pk.icon != null && { icon: pk.icon }),
      pricing_mode: pk.pricing_mode, min_total: pk.min_total,
      ...(pk.target_margin != null && { target_margin: pk.target_margin }),
      ...(pk.free_components === 1 && { free_components: true }),
      options: [], components: []
    };
  }
  const optionsByPack = {};
  for (const o of [...entities.pack_options].sort(byPosition)) {
    const values = entities.pack_option_values
      .filter((v) => v.pack_id === o.pack_id && v.option_id === o.option_id)
      .sort(byPosition);
    const option = {
      id: o.option_id, label: o.label,
      values: values.map((v) => ({ id: v.value_id, label: v.label, ...(v.sides != null && { sides: v.sides }) }))
    };
    if (o.maps_product === 1) {
      option.maps_product = {};
      for (const v of values) if (v.maps_to_product != null) option.maps_product[v.value_id] = v.maps_to_product;
    }
    (optionsByPack[o.pack_id] ||= []).push(option);
  }
  for (const [packId, options] of Object.entries(optionsByPack)) packs[packId].options = options;
  for (const c of [...entities.pack_components].sort(byPosition)) {
    packs[c.pack_id].components.push({
      id: c.component_id, label: c.label,
      ...(c.product_id != null && { product: c.product_id }),
      ...(c.qty_per_pack != null && { qty_per_pack: c.qty_per_pack })
    });
  }
  for (const cell of entities.bundle_prices) {
    const pk = packs[cell.pack_id];
    ((pk.bundle_prices ||= {})[cell.combo_key] ||= {})[cell.tier] = cell.price;
  }

  const company = {};
  const quote_settings = {};
  for (const row of entities.company) {
    const value = JSON.parse(row.value);
    if (row.key.startsWith('company.')) company[row.key.slice('company.'.length)] = value;
    else if (row.key.startsWith('quote_settings.')) quote_settings[row.key.slice('quote_settings.'.length)] = value;
  }

  return {
    version: meta.version, updated_at: meta.updated_at, modified_by: meta.modified_by,
    parameters, suppliers, products, tiers, addons, packs, company, quote_settings
  };
}

module.exports = { disassemble, assemble };
```

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add lib/catalog-assembler.js tests/catalog-assembler.test.js
git commit -m "feat(cloud): catalog assembler entities -> cfg v4"
```

---

### Task 8: round-trip exacto + validador v4

**Files:**
- Test: `tests/catalog-assembler.test.js` (añadir `describe` final)

- [ ] **Step 1: Write the round-trip test**

```js
const { validateConfigSchema } = require('../lib/config-schema.js');

describe('round-trip', () => {
  test('assemble(disassemble(cfg)) reproduces the default catalog exactly (minus admin)', () => {
    const cfg = buildDefaultConfig();
    const expected = { ...cfg };
    delete expected.admin;
    const rebuilt = assemble(disassemble(cfg), {
      version: cfg.version, updated_at: cfg.updated_at, modified_by: cfg.modified_by
    });
    expect(rebuilt).toEqual(expected);
  });

  test('the rebuilt config passes the strict v4 validator', () => {
    const cfg = buildDefaultConfig();
    const rebuilt = assemble(disassemble(cfg), {
      version: cfg.version, updated_at: cfg.updated_at, modified_by: cfg.modified_by
    });
    rebuilt.admin = cfg.admin;
    const result = validateConfigSchema(rebuilt);
    expect(result.valid ?? result.ok ?? result === true).toBeTruthy();
  });
});
```

Notas para el ejecutor:
- Comprobar la firma real de `validateConfigSchema` en
  `lib/config-schema.js` (puede devolver `{valid, errors}`, `{ok, errors}` o
  lanzar) y dejar la aserción acorde — el test debe afirmar «no hay errores»,
  no una forma concreta inventada.
- Si `toEqual` falla por claves opcionales ausentes/`null` (p. ej.
  `description`), la regla es: **el ensamblador debe reproducir la forma del
  default exactamente** — ajustar los spreads condicionales de `assemble`
  hasta que el diff sea vacío.

- [ ] **Step 2: Run** → PASS tras los ajustes que dicte el default real

- [ ] **Step 3: Run the whole suite**

Run: `pnpm test`
Expected: todos verdes (los 200+ existentes + los nuevos; ningún test previo
roto — este plan no modificó ningún módulo existente).

- [ ] **Step 4: Commit**

```bash
git add tests/catalog-assembler.test.js
git commit -m "test(cloud): exact round-trip and v4 validator over assembled catalog"
```

---

### Task 9: cierre del plan

- [ ] **Step 1:** `pnpm test` verde completo.
- [ ] **Step 2:** `pnpm dev` arranca igual que antes (nada de este plan se
  ejecuta aún en runtime — verificación de no-regresión).
- [ ] **Step 3:** marcar la fase 0+1 como «módulos listos» en
  `planes/v5-impl-roadmap.md` y abrir PR de `feat/v5-foundation` a `main`
  (sin mergear hasta revisión del propietario).
- [ ] **Step 4:** escribir el documento de tareas del Plan 2 (asistente +
  lectura) con la skill writing-plans, ya con estos módulos reales delante.
