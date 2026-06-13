// ============================================================
// PackPrice · Cloud bootstrap orchestration (v5 read path)
// ============================================================
// Everything the cloud IPC handlers need, behind one injectable
// factory so main.js stays 3-line wiring and the whole flow is
// unit-testable without Electron or network:
//
//   testToken      → cloud:test-token   (wizard step 1)
//   provision      → cloud:provision    (wizard step 2, §6 contract)
//   loadCatalog    → catalog:load       (boot: cloud → cache → error)
//   checkVersion   → catalog:check-version
//   refreshCatalog → catalog:refresh    (explicit, no silent fallback)
//
// Main-process only (it builds D1 clients holding the API token —
// nothing here may ever reach the renderer; the configs it returns
// are assemble() output, which carries no admin section and no
// token). Backups/cache touch fs via the injected paths; everything
// else is injected (planes/v5-impl-plan-2 §2B).
//
// The §6 migration-safety contract of cloud:provision:
//   acquire lock → backup-export (only if schema_migrations already
//   existed) → applyMigrations → verify (only when the catalog has
//   data) → release lock in finally. Verify/apply failure answers
//   { ok:false, code:'MIGRATION_FAILED', backupPath }.
//
// User-facing strings stay in Spanish (CLAUDE.md §6).
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { assemble, disassemble } = require('./catalog-assembler');
const { loadEntities, getCatalogVersion, seedCatalog } = require('./cloud-catalog');
const { applyMigrations, acquireMigrationLock, releaseMigrationLock } = require('./db-migrator');
const { readCache, writeCache } = require('./catalog-cache');
const { validateConfigSchema } = require('./config-schema');

// One fixed database name per customer account: PC-2 with the same
// token finds the base PC-1 provisioned (planes/v5-cloud-sync.md §5).
const DB_NAME = 'packprice';

const LOCKED_MESSAGE =
  'Otro equipo está migrando la base de datos en este momento — espera un minuto y vuelve a intentarlo.';

// Centralized failure codes so main.js and the renderer key off
// constants, not scattered string literals (values are the contract).
const CODES = {
  MIGRATION_LOCKED: 'MIGRATION_LOCKED',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  NO_CLOUD_NO_CACHE: 'NO_CLOUD_NO_CACHE'
};

/**
 * @param {object} deps
 * @param {(opts: {token: string, accountId?: string, databaseId?: string}) => object} deps.createClient - lib/d1-client.js factory
 * @param {() => Array<{id: string, sql: string}>} deps.loadMigrations - bundled migrations, pre-bound to db/migrations
 * @param {string} deps.cachePath - catalog cache file (%APPDATA%\packprice\cache\catalog.json)
 * @param {string} deps.backupDir - pre-migration dumps (%APPDATA%\packprice\backups)
 * @param {() => object} deps.buildDefaultConfig - seed source (config.default.js)
 * @param {string} deps.appVersion - stamped into the migration ledger
 * @param {() => string} [deps.now] - ISO-8601 timestamp source
 * @param {number} [deps.timeoutMs] - network cutoff for the read path
 * @param {(msg: string, meta?: object) => void} [deps.log] - sink for dropped cloud errors (never silently swallowed)
 */
function createCloudBootstrap({
  createClient,
  loadMigrations,
  cachePath,
  backupDir,
  buildDefaultConfig,
  appVersion,
  now = () => new Date().toISOString(),
  timeoutMs = 5000,
  log = () => {}
}) {
  // The cfg `version` is the v4 schema tag (e.g. '4.0.0'), not the
  // catalog_version counter — same value the file mode writes.
  const configVersion = buildDefaultConfig().version;

  function clientFromSettings(settings) {
    const cloud = (settings && settings.cloud) || {};
    return createClient({ token: cloud.token, accountId: cloud.account_id, databaseId: cloud.database_id });
  }

  // Boot must never hang on a half-dead connection: the whole read
  // is raced against a single timer (UI-UX §2.2 — 5 s cutoff).
  function withTimeout(promise) {
    let timer;
    const cutoff = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Cloudflare no respondió a tiempo (${timeoutMs} ms)`)), timeoutMs);
    });
    return Promise.race([promise, cutoff]).finally(() => clearTimeout(timer));
  }

  // assemble() output carries no admin section — by design, the
  // renderer never sees one in cloud mode (v5 removes the gate).
  // The has_password stub below exists ONLY to satisfy the file-era
  // validator and never leaves this function.
  // Throws a CLOUD_INVALID-tagged error so the read path can tell a
  // reachable-but-broken catalog apart from a network failure.
  function toValidatedConfig(entities, updatedAt) {
    const config = assemble(entities, {
      version: configVersion,
      // updated_at is the FETCH time, on purpose: catalog_meta keeps
      // the true author/edit time, but the UI "freshness" badge wants
      // when this PC last pulled from the cloud, not when the catalog
      // was last edited.
      updated_at: updatedAt,
      modified_by: 'nube'
    });
    try {
      validateConfigSchema({ ...config, admin: { has_password: true } });
    } catch (err) {
      err.cloudInvalid = true;
      throw err;
    }
    return config;
  }

  async function fetchFromCloud(settings) {
    const client = clientFromSettings(settings);
    const { entities, meta } = await withTimeout(loadEntities(client));
    const fetchedAt = now();
    const config = toValidatedConfig(entities, fetchedAt);
    writeCache(cachePath, { fetchedAt, catalogVersion: meta.catalogVersion, entities });
    return { ok: true, config, source: 'cloud', catalogVersion: meta.catalogVersion, fetchedAt };
  }

  // Was the cloud reachable but its catalog unusable (assemble/validate
  // rejected it)? Then it is NOT an offline failure.
  function isCloudInvalid(err) {
    return Boolean(err && err.cloudInvalid);
  }

  async function tableExists(client, name) {
    const res = await client.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]
    );
    return (res.results || []).length > 0;
  }

  function writeBackupDump(dump) {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    // ISO stamp with ':' and '.' flattened — Windows-safe file name.
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `pre-migration-${stamp}.sql`);
    fs.writeFileSync(backupPath, dump, 'utf-8');
    return backupPath;
  }

  // Post-migration sanity check (§6 «VERIFICAR»): only when the
  // catalog already has data — a fresh empty base has nothing to
  // assemble yet (its content arrives with the seed right after).
  async function verifyCatalog(client) {
    const probe = await client.query('SELECT COUNT(*) AS n FROM products');
    if (((probe.results || [])[0] || {}).n > 0) {
      const { entities } = await loadEntities(client);
      toValidatedConfig(entities, now());
    }
  }

  return {
    /** cloud:test-token → { ok, accounts: [{id, name}] } */
    async testToken({ token } = {}) {
      try {
        const client = createClient({ token });
        const accounts = await withTimeout(client.listAccounts());
        return { ok: true, accounts: accounts.map((a) => ({ id: a.id, name: a.name })) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /** cloud:provision → { ok, databaseId, seeded } (§6 contract) */
    async provision({ token, accountId, user } = {}) {
      try {
        const client = createClient({ token, accountId });
        let db = await client.findDatabaseByName(DB_NAME);
        if (!db) db = await client.createDatabase(DB_NAME);
        client.databaseId = db.uuid;

        const lockTs = await acquireMigrationLock(client, { now });
        if (lockTs === null) {
          return { ok: false, code: CODES.MIGRATION_LOCKED, error: LOCKED_MESSAGE };
        }

        let backupPath = null;
        try {
          // Backup BEFORE applying, but only when there is something
          // to protect: a base that never saw a migration is empty.
          if (await tableExists(client, 'schema_migrations')) {
            backupPath = writeBackupDump(await client.exportDatabase());
          }
          await applyMigrations(client, loadMigrations(), { user, appVersion, now });
          await verifyCatalog(client);
        } catch (err) {
          return { ok: false, code: CODES.MIGRATION_FAILED, error: err.message, backupPath };
        } finally {
          // A throw while releasing the lock must NEVER replace the
          // in-flight return (e.g. MIGRATION_FAILED + backupPath): a
          // throw from finally would clobber it. Swallow + log instead.
          try {
            await releaseMigrationLock(client, { lockTs });
          } catch (releaseErr) {
            log('cloud:provision lock release failed (non-fatal)', { error: releaseErr.message });
          }
        }

        // Seed only a base with an empty catalog; seedCatalog itself
        // no-ops on populated data, so a teammate's catalog is safe.
        const { seeded } = await seedCatalog(client, disassemble(buildDefaultConfig()), { user, now });
        return { ok: true, databaseId: db.uuid, seeded };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /** catalog:load → cloud → cache → { ok:false, code: CODES.NO_CLOUD_NO_CACHE } */
    async loadCatalog(settings) {
      let cloudError;
      try {
        return await fetchFromCloud(settings);
      } catch (err) {
        cloudError = err;
      }
      // The cloud failed: never drop the cause silently — log it and
      // carry it on the fallback result. `offline` means a network
      // failure ONLY; a reachable-but-invalid catalog is `cloud-invalid`.
      const cloudInvalid = isCloudInvalid(cloudError);
      log('catalog:load cloud failed, trying cache', {
        cloudInvalid, cloudError: cloudError.message
      });
      try {
        const cached = readCache(cachePath);
        if (cached) {
          const config = toValidatedConfig(cached.entities, cached.fetchedAt);
          const result = {
            ok: true, config, source: 'cache',
            catalogVersion: cached.catalogVersion, fetchedAt: cached.fetchedAt,
            cloudError: cloudError.message
          };
          if (cloudInvalid) result.reason = 'cloud-invalid';
          else result.offline = true;
          return result;
        }
        return { ok: false, code: CODES.NO_CLOUD_NO_CACHE, error: cloudError.message };
      } catch (cacheErr) {
        // Corrupt cache (or cache that assembles into an invalid
        // config): surfaced, never silently treated as data.
        return { ok: false, code: CODES.NO_CLOUD_NO_CACHE, error: cacheErr.message };
      }
    },

    /** catalog:check-version → { ok, current, remote, upToDate } */
    async checkVersion(settings) {
      try {
        const client = clientFromSettings(settings);
        const remote = await withTimeout(getCatalogVersion(client));
        const cached = readCache(cachePath);
        const current = cached ? cached.catalogVersion : null;
        return { ok: true, current, remote, upToDate: current === remote };
      } catch (err) {
        // getCatalogVersion is a network-only probe (no assemble), so
        // any failure here is offline/timeout — still never dropped.
        log('catalog:check-version failed', { cloudError: err.message });
        return { ok: false, offline: true, error: err.message, cloudError: err.message };
      }
    },

    /** catalog:refresh → like catalog:load but with NO silent cache fallback */
    async refreshCatalog(settings) {
      try {
        return await fetchFromCloud(settings);
      } catch (err) {
        // Explicit refresh fails loudly. Distinguish a network failure
        // (offline) from a reachable-but-invalid catalog (cloud-invalid).
        const cloudInvalid = isCloudInvalid(err);
        log('catalog:refresh failed', { cloudInvalid, cloudError: err.message });
        const result = { ok: false, error: err.message, cloudError: err.message };
        if (cloudInvalid) result.reason = 'cloud-invalid';
        else result.offline = true;
        return result;
      }
    }
  };
}

module.exports = { createCloudBootstrap, DB_NAME, CODES };
