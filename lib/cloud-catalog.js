// ============================================================
// PackPrice · Cloud catalog read path + initial seed
// ============================================================
// Reads the normalized catalog out of the customer's D1 database
// (one SELECT per table, archived entities filtered out) and seeds
// an empty, freshly-provisioned base with the default catalog from
// the first-run wizard (planes/v5-cloud-sync.md §4, §5; plan 2A).
//
// Pure module: the D1 client is injected, no fs, no Electron. Real
// per-entity writes (versioned UPDATEs, audit, snapshots) are Plan 3
// — seedCatalog here is ONLY the one-shot initial population.
// ============================================================

'use strict';

// The 13 catalog tables, in FK-safe order (parents before children)
// so the seed inserts never trip D1's foreign-key enforcement. Keys
// match the lib/catalog-assembler.js disassemble output exactly.
const ENTITY_TABLES = [
  'parameters',
  'suppliers',
  'products',
  'product_suppliers',
  'product_prices',
  'tiers',
  'addons',
  'packs',
  'pack_options',
  'pack_option_values',
  'pack_components',
  'bundle_prices',
  'company'
];

// Tables with an archived_at column (soft delete): reads exclude
// archived rows so the calc engine never prices retired entities.
const ARCHIVABLE_TABLES = new Set(['suppliers', 'products', 'addons', 'packs']);

// Cloudflare D1 caps bound parameters at 100 per query; the seed
// chunks each table's multi-row INSERT to stay under it.
const MAX_BOUND_PARAMS = 100;

const MISSING_META_MESSAGE =
  'La base de datos D1 no tiene los metadatos del catálogo (catalog_meta) — base sin inicializar o dañada';

async function readMetaRow(client) {
  const res = await client.query('SELECT * FROM catalog_meta WHERE id = 1');
  const row = (res.results || [])[0];
  if (!row) throw new Error(MISSING_META_MESSAGE);
  return row;
}

/**
 * Loads the full catalog: one SELECT per entity table plus the meta
 * row. The result feeds lib/catalog-assembler.js `assemble()` and
 * the local cache (lib/catalog-cache.js).
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @returns {Promise<{entities: object, meta: {catalogVersion: number, schemaVersion: number, minAppVersion: string}}>}
 */
async function loadEntities(client) {
  const entities = {};
  for (const table of ENTITY_TABLES) {
    const sql = ARCHIVABLE_TABLES.has(table)
      ? `SELECT * FROM ${table} WHERE archived_at IS NULL`
      : `SELECT * FROM ${table}`;
    const res = await client.query(sql);
    entities[table] = res.results || [];
  }
  const row = await readMetaRow(client);
  return {
    entities,
    meta: {
      catalogVersion: row.catalog_version,
      schemaVersion: row.schema_version,
      minAppVersion: row.min_app_version
    }
  };
}

/**
 * Cheap freshness probe (the «¿Hay cambios?» check): just the
 * catalog_version number, no entity traffic.
 *
 * @param {object} client - D1 client
 * @returns {Promise<number>}
 */
async function getCatalogVersion(client) {
  const res = await client.query('SELECT catalog_version FROM catalog_meta WHERE id = 1');
  const row = (res.results || [])[0];
  if (!row) throw new Error(MISSING_META_MESSAGE);
  return Number(row.catalog_version);
}

/**
 * One-shot initial population of a freshly-provisioned EMPTY base
 * (0 rows in products) with a disassembled catalog. Populated base
 * → no-op `{ seeded: false }`, so re-running the wizard can never
 * clobber a teammate's data. INSERT OR IGNORE + parameterized
 * multi-row VALUES, chunked under D1's bound-parameter cap.
 *
 * @param {object} client - D1 client
 * @param {object} entities - disassemble() output (uniform row keys per table)
 * @param {object} opts
 * @param {string} opts.user - stamped into catalog_meta.updated_by
 * @param {() => string} opts.now - ISO-8601 timestamp source
 * @returns {Promise<{seeded: boolean}>}
 */
async function seedCatalog(client, entities, { user, now }) {
  const probe = await client.query('SELECT COUNT(*) AS n FROM products');
  if (probe.results[0].n > 0) return { seeded: false };

  for (const table of ENTITY_TABLES) {
    const rows = entities[table] || [];
    if (rows.length === 0) continue;
    // disassemble() emits uniform keys per table, so the first row's
    // columns hold for the whole table.
    const columns = Object.keys(rows[0]);
    const rowsPerChunk = Math.max(1, Math.floor(MAX_BOUND_PARAMS / columns.length));
    for (let i = 0; i < rows.length; i += rowsPerChunk) {
      const chunk = rows.slice(i, i + rowsPerChunk);
      const placeholders = chunk.map(() => '(' + columns.map(() => '?').join(', ') + ')').join(', ');
      await client.query(
        `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
        chunk.flatMap((row) => columns.map((col) => row[col]))
      );
    }
  }

  await client.query(
    'UPDATE catalog_meta SET updated_by = ?, updated_at = ? WHERE id = 1',
    [user, now()]
  );
  return { seeded: true };
}

module.exports = { ENTITY_TABLES, loadEntities, getCatalogVersion, seedCatalog };
