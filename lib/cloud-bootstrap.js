// ============================================================
// Quanto · Cloud bootstrap orchestration (v5 read path)
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
const { writeEntities } = require('./catalog-writer');
const { readAuditLog, listSnapshots, restoreSnapshot } = require('./cloud-history');
const { applyMigrations, acquireMigrationLock, releaseMigrationLock } = require('./db-migrator');
const { readCache, writeCache } = require('./catalog-cache');
const { validateConfigSchema } = require('./config-schema');
const { uploadQuote, updateQuoteStatus, fetchStatsData } = require('./cloud-quotes');
const { loadPdfTemplate, listPdfTemplates, listAllPdfTemplateIds, insertPdfTemplate } = require('./cloud-pdf-templates');
const { sanitizeTemplate } = require('./template-sanitizer');
const { enqueueQuote, enqueueStatus, flushOutbox } = require('./quote-outbox');
const { computeStats } = require('./stats');

// One fixed database name per customer account: PC-2 with the same
// token finds the base PC-1 provisioned (planes/v5-cloud-sync.md §5).
const DB_NAME = 'packprice';

const LOCKED_MESSAGE =
  'Otro equipo está migrando la base de datos en este momento — espera un minuto y vuelve a intentarlo.';

// Per-id entity type → its catalog table. The renderer's version map is
// keyed by entity type (pack/product/supplier/addon); the rows come back
// keyed by table name from loadEntities. This bridges the two.
const VERSIONED_ENTITIES = {
  pack: 'packs',
  product: 'products',
  supplier: 'suppliers',
  addon: 'addons'
};

// Last-resort author when no name is configured for this PC. The audit
// log must always carry someone; a generic placeholder beats an empty
// string (CLAUDE.md §2 — v5 audit is the protection, not a password).
const DEFAULT_AUTHOR = 'Equipo';

// Bounds on a custom PDF template, mirroring lib/history.js MAX_QUOTE_BYTES:
// the html/name are otherwise unbounded, and the row is re-fetched +
// sanitized on every export/preview by every PC, so a multi-MB paste would
// balloon the shared D1 row. A legitimate template is a few KB; 256 KB
// leaves enormous headroom, and 80 chars is plenty for a gallery name.
const MAX_TEMPLATE_NAME_CHARS = 80;
const MAX_TEMPLATE_HTML_BYTES = 256 * 1024;

// Derives the per-entity optimistic-concurrency version map the renderer
// echoes back on save: each versioned table's rows carry a `version`
// column (db/migrations/0001_init.sql), and the catalog-wide counter
// comes from catalog_meta. Pure: reads the rows loadEntities returned.
function deriveVersions(entities, catalogVersion) {
  const versions = { catalogVersion, pack: {}, product: {}, supplier: {}, addon: {} };
  for (const [type, table] of Object.entries(VERSIONED_ENTITIES)) {
    for (const row of entities[table] || []) versions[type][row.id] = row.version;
  }
  return versions;
}

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
 * @param {string} deps.cachePath - catalog cache file (%APPDATA%\Quanto\cache\catalog.json)
 * @param {string} deps.backupDir - pre-migration dumps (%APPDATA%\Quanto\backups)
 * @param {string} deps.userDataDir - per-PC data root (%APPDATA%\Quanto); the offline quote outbox lives under its cache/
 * @param {string} deps.schemaVersion - v4 schema tag (config.default SCHEMA_VERSION), stamped into the migration ledger
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
  userDataDir,
  schemaVersion,
  appVersion,
  now = () => new Date().toISOString(),
  timeoutMs = 5000,
  log = () => {}
}) {
  // The cfg `version` is the v4 schema tag (e.g. '4.0.0'), not the
  // catalog_version counter — same value the file mode writes.
  const configVersion = schemaVersion;

  function clientFromSettings(settings) {
    const cloud = (settings && settings.cloud) || {};
    return createClient({ token: cloud.token, accountId: cloud.account_id, databaseId: cloud.database_id });
  }

  // The catalog edit author for the audit log + catalog_meta: prefer the
  // cloud-specific name, fall back to the PC's general name, then a
  // generic placeholder (the audit must always carry someone — CLAUDE.md
  // §2: v5 replaces the admin password with author + audit + snapshot).
  // Mirrors main.js cloudAuthor so the IPC handler stays thin wiring.
  function resolveAuthor(settings) {
    const s = settings || {};
    return (s.cloud && s.cloud.user_name) || s.user_name || DEFAULT_AUTHOR;
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
    // The per-entity version map travels alongside the config so the
    // renderer can echo it back on save (optimistic concurrency); it is
    // cached too, so the offline cache-fallback can still answer it.
    const versions = deriveVersions(entities, meta.catalogVersion);
    writeCache(cachePath, { fetchedAt, catalogVersion: meta.catalogVersion, entities, versions });
    // We just proved the cloud is reachable, so this is the natural
    // moment to drain any quote/status queued while offline. Best-effort:
    // a flush problem must never break the catalog load (planes/v5 §7).
    await flushOutboxBestEffort(settings, client);
    return { ok: true, config, source: 'cloud', catalogVersion: meta.catalogVersion, fetchedAt, versions };
  }

  // Drains the offline quote outbox after a confirmed-reachable cloud.
  // Reuses the live client so it shares the proven connection. Logged,
  // never thrown — the catalog load is the contract, the flush is a bonus.
  async function flushOutboxBestEffort(settings, client) {
    if (!userDataDir) return;
    try {
      const res = await flushOutbox(userDataDir, client, { uploadQuote, updateQuoteStatus, now });
      if (res.uploaded || res.statusesApplied || res.remaining || res.error) {
        log('outbox flushed on sync', res);
      }
    } catch (err) {
      // flushOutbox already swallows per-item + corrupt-queue errors, but
      // a truly unexpected throw here is still non-fatal to the load.
      log('outbox flush failed (non-fatal)', { error: err.message });
    }
  }

  // A true network failure (offline / DNS / TLS — fetch never reached
  // Cloudflare) means the quote/status must be queued, not lost. Anything
  // else — a server rejection (HTTP 4xx/5xx, success:false), a local
  // validation error, a bad status — is a client/data bug surfaced as
  // { ok:false }; queuing it would poison the outbox (retried forever on
  // every sync). So we key strictly off the structural D1ClientError.network
  // flag (set ONLY at the fetch-reject site in lib/d1-client.js), never off
  // the brittle error text.
  function isOffline(err) {
    return Boolean(err && err.network === true);
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

        // No seeding here: a fresh install builds its catalog through the
        // first-run wizard, which then calls seedInitial() with the user's
        // own catalog. Provision only ensures the DB + migrated schema.
        return { ok: true, databaseId: db.uuid, seeded: false };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    /**
     * catalog:seed-initial → seeds the freshly-provisioned (empty) DB with
     * the catalog the first-run wizard collected. seedCatalog no-ops on
     * already-populated data, so a teammate's catalog is never clobbered.
     * @returns { ok, seeded } | { ok:false, error }
     */
    async seedInitial(settings, { config, user } = {}) {
      try {
        const client = clientFromSettings(settings);
        const { seeded } = await seedCatalog(client, disassemble(config), { user, now });
        return { ok: true, seeded };
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
          // Versions ride along from the cache; a pre-versions cache (or
          // one whose rows still carry their version column) is re-derived
          // so the renderer always gets a map to echo back on save.
          const versions = cached.versions || deriveVersions(cached.entities, cached.catalogVersion);
          const result = {
            ok: true, config, source: 'cache',
            catalogVersion: cached.catalogVersion, fetchedAt: cached.fetchedAt,
            versions,
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
    },

    /**
     * catalog:save → guarded per-entity write of an edited catalog.
     *
     * The diff baseline (oldCfg) is the CURRENT cloud state, re-loaded
     * here — never the renderer's stale copy — so writeEntities diffs
     * against what is really stored. `expectedVersions` is what detects a
     * concurrent edit: it is the version map the renderer held when it
     * loaded. When the renderer omits it (rare; e.g. a direct save before
     * a fresh load), we fall back to the just-loaded authoritative
     * versions, which means the guards can never trip — documented and
     * acceptable, since there is no baseline to compare against.
     *
     * Cache is refreshed ONLY on a fully clean save (conflicts.length ===
     * 0): a partial conflict still leaves the renderer's local copy stale
     * for the conflicted entities, and the cache must mirror a coherent
     * committed state, so it is left untouched until the re-save lands.
     *
     * @param {object} settings - per-PC settings (carries cloud.token)
     * @param {object} args
     * @param {object} args.newCfg - the edited full cfg to persist
     * @param {object} [args.expectedVersions] - versions the renderer loaded
     * @param {string} args.user - author, stamped into audit + catalog_meta
     * @returns {Promise<{ok:boolean, catalogVersion:number, conflicts:object[], results:object[]}>}
     */
    async saveCatalog(settings, { newCfg, expectedVersions, user }) {
      const client = clientFromSettings(settings);
      // Authoritative baseline: re-load the current cloud catalog so the
      // diff is against reality and the version map (when the renderer
      // sent none) is the live one.
      const { entities, meta } = await loadEntities(client);
      const oldCfg = assemble(entities, {
        version: configVersion, updated_at: now(), modified_by: 'nube'
      });
      const versions = expectedVersions || deriveVersions(entities, meta.catalogVersion);

      const res = await writeEntities(client, { oldCfg, newCfg, user, now, expectedVersions: versions });

      // Refresh the local cache only on a clean save (no conflicts):
      // re-disassemble the persisted cfg and stamp the new versions so the
      // next offline boot starts from the just-saved state.
      if (res.conflicts.length === 0) {
        const fetchedAt = now();
        const newEntities = disassemble(newCfg);
        const newVersions = bumpVersions(versions, res);
        newVersions.catalogVersion = res.catalogVersion;
        writeCache(cachePath, {
          fetchedAt, catalogVersion: res.catalogVersion, entities: newEntities, versions: newVersions
        });
      }

      return { ok: res.ok, catalogVersion: res.catalogVersion, conflicts: res.conflicts, results: res.results };
    },

    /** audit:list → the cloud change history, newest-first (mapped + diff parsed) */
    async getAudit(settings, { limit, offset } = {}) {
      const client = clientFromSettings(settings);
      return readAuditLog(client, { limit, offset });
    },

    /** snapshots:list → the version list, newest-first */
    async getSnapshots(settings) {
      const client = clientFromSettings(settings);
      return listSnapshots(client);
    },

    /**
     * snapshots:restore → forward-only rollback to a prior version.
     *
     * Delegates to lib/cloud-history.js restoreSnapshot (which goes
     * through the same guarded, audited writeEntities path as a normal
     * edit), stamping the configured author. On a clean restore the local
     * cache is refreshed by re-fetching the now-restored catalog from the
     * cloud, so the next offline boot — and the freshness probe — start
     * from the restored state (fetchFromCloud rewrites the cache with the
     * new version + per-entity version map).
     *
     * @param {object} settings - per-PC settings (carries cloud.token + author)
     * @param {object} args
     * @param {number} args.version - the snapshot version to restore
     * @returns {Promise<{ok:boolean, catalogVersion:number}>}
     */
    async restore(settings, { version } = {}) {
      const client = clientFromSettings(settings);
      const user = resolveAuthor(settings);
      const res = await restoreSnapshot(client, { version, user, now });
      // Refresh the cache only on a clean restore: re-fetch the restored
      // catalog so the cache mirrors the true committed state (new version
      // + the per-entity versions the live rows now carry). A conflicted
      // restore (rare — restore uses the live versions, so it normally
      // wins) leaves the cache untouched, like saveCatalog.
      if (res.ok) {
        try {
          await fetchFromCloud(settings);
        } catch (err) {
          // The restore itself committed; a failed cache refresh is
          // non-fatal (the next load re-pulls). Never silently swallow it.
          log('snapshots:restore cache refresh failed (non-fatal)', { error: err.message });
        }
      }
      return res;
    },

    /**
     * quotes:upload → idempotent quote upload with offline enqueue.
     *
     * The local history (lib/history.js) is already the per-PC source of
     * truth; this mirrors the quote to the shared cloud. On a network
     * failure the quote is queued (lib/quote-outbox.js) and drained on the
     * next successful sync — never lost, never duplicated (UUID PK +
     * INSERT OR IGNORE). The token never leaves main.
     *
     * @param {object} settings - per-PC settings (carries cloud.token)
     * @param {object} args
     * @param {object} args.quote - the cloud quote (lib/cloud-quotes.js shape)
     * @returns {Promise<{ok:boolean, id:string, queued?:boolean, error?:string}>}
     */
    async saveQuote(settings, { quote } = {}) {
      const client = clientFromSettings(settings);
      try {
        return await uploadQuote(client, quote);
      } catch (err) {
        if (isOffline(err) && userDataDir) {
          enqueueQuote(userDataDir, quote);
          log('quote queued (offline)', { id: quote && quote.id, error: err.message });
          return { ok: true, queued: true, id: quote && quote.id };
        }
        log('quotes:upload failed', { error: err.message });
        return { ok: false, error: err.message, id: quote && quote.id };
      }
    },

    /**
     * quotes:set-status → mark a quote accepted/rejected/pending, with
     * offline enqueue. An invalid status is a client bug, surfaced as
     * { ok:false } without ever queuing (lib/cloud-quotes.js validates
     * before any network call). A network failure queues the change.
     *
     * @param {object} settings
     * @param {object} args
     * @param {string} args.id
     * @param {string} args.status - pending | accepted | rejected
     * @returns {Promise<{ok:boolean, id:string, status:string, queued?:boolean, error?:string}>}
     */
    async setQuoteStatus(settings, { id, status } = {}) {
      const client = clientFromSettings(settings);
      const ts = now();
      try {
        return await updateQuoteStatus(client, { id, status, now: ts });
      } catch (err) {
        if (isOffline(err) && userDataDir) {
          enqueueStatus(userDataDir, { id, status, ts });
          log('quote status queued (offline)', { id, status, error: err.message });
          return { ok: true, queued: true, id, status };
        }
        // Validation error or any other non-network failure: surfaced,
        // never queued (a bad status would keep failing forever).
        return { ok: false, error: err.message, id, status };
      }
    },

    /**
     * stats:get → fetch the raw rows in the date range AND compute the
     * statistics here (in main, with the loaded cfg) so the renderer only
     * paints. Returns the COMPUTED stats object, never the raw rows.
     *
     * @param {object} settings
     * @param {object} range
     * @param {string} range.from - inclusive ISO lower bound
     * @param {string} range.to - inclusive ISO upper bound
     * @returns {Promise<{ok:boolean, stats?:object, offline?:boolean, error?:string}>}
     */
    async getStats(settings, { from, to } = {}) {
      const client = clientFromSettings(settings);
      try {
        const data = await withTimeout(fetchStatsData(client, { from, to }));
        // Resolve names + target margins from the live catalog. Re-loading
        // here keeps the renderer free of cfg plumbing for stats.
        const { entities } = await withTimeout(loadEntities(client));
        const cfg = assemble(entities, {
          version: configVersion, updated_at: now(), modified_by: 'nube'
        });
        const stats = computeStats(data, cfg);
        return { ok: true, stats };
      } catch (err) {
        // Stats need the network (no Worker, no local aggregate) — surface
        // an offline result so the screen shows the standard offline note.
        log('stats:get failed', { error: err.message });
        return { ok: false, offline: true, error: err.message };
      }
    },

    /**
     * Loads one custom PDF template by id from the shared store. Returns
     * the raw row { id, name, html, css } (or null) — UNTRUSTED HTML the
     * caller must sanitize before render. Custom templates are a cloud
     * feature (file mode has the built-ins only). (Plan 6.)
     *
     * @param {object} settings - per-PC settings (carries cloud.token)
     * @param {string} id
     * @returns {Promise<{id:string,name:string,html:string,css:string}|null>}
     */
    async getPdfTemplate(settings, id) {
      const client = clientFromSettings(settings);
      return loadPdfTemplate(client, id);
    },

    /**
     * Lists the custom PDF templates (id + name) for the gallery. (Plan 6,
     * consumed by the settings UI in Task 6B.)
     *
     * @param {object} settings
     * @returns {Promise<Array<{id:string,name:string}>>}
     */
    async listPdfTemplates(settings) {
      const client = clientFromSettings(settings);
      return listPdfTemplates(client);
    },

    /**
     * Saves a user-authored custom PDF template into the shared store
     * (Task 6B «Añadir plantilla personalizada…»). The HTML is SANITIZED
     * here (lib/template-sanitizer.js) before it is ever stored — a
     * rejected template (script/iframe/external resource) throws and is
     * never persisted, so a malicious template can't reach any other PC.
     *
     * The id is a slug derived from the name (deduped against existing
     * ids), keeping the gallery readable. Custom templates are a CLOUD
     * feature: file mode has no store (the caller gates on cloud mode).
     *
     * @param {object} settings
     * @param {object} args
     * @param {string} args.name
     * @param {string} args.html - raw, untrusted (sanitized here)
     * @returns {Promise<{ok:boolean, id?:string, name?:string, error?:string}>}
     */
    async savePdfTemplate(settings, { name, html } = {}) {
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (!trimmedName) {
        return { ok: false, error: 'Ponle un nombre a la plantilla.' };
      }
      if (typeof html !== 'string' || html.trim().length === 0) {
        return { ok: false, error: 'La plantilla está vacía. Pega el HTML+CSS de la plantilla.' };
      }
      // Bound the input BEFORE sanitize/insert: the row is re-fetched +
      // sanitized on every export/preview by every PC, so an unbounded paste
      // would balloon the shared D1 row (fail-fast, like history.js).
      if (trimmedName.length > MAX_TEMPLATE_NAME_CHARS) {
        return { ok: false, error: 'El nombre de la plantilla es demasiado largo (máximo 80 caracteres).' };
      }
      if (Buffer.byteLength(html, 'utf-8') > MAX_TEMPLATE_HTML_BYTES) {
        return { ok: false, error: 'La plantilla es demasiado grande (máximo 256 KB).' };
      }
      let safe;
      try {
        // The sanitizer throws a plain Spanish message naming the
        // violation; surface it verbatim to the user (UI-UX §2.5).
        safe = sanitizeTemplate(html);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      const client = clientFromSettings(settings);
      // Dedup the slug against ALL ids — archived rows included — so a reused
      // slug can't collide on the PRIMARY KEY (a soft-deleted row keeps its
      // id) and fail with a misleading generic error.
      const usedIds = new Set(await listAllPdfTemplateIds(client));
      const id = uniqueTemplateId(trimmedName, usedIds);
      try {
        const saved = await insertPdfTemplate(client, { id, name: trimmedName, html: safe, now: now() });
        return { ok: true, id: saved.id, name: saved.name };
      } catch (err) {
        log('pdf:save-template failed', { error: err.message });
        return { ok: false, error: 'No se pudo guardar la plantilla en la nube. Revisa tu conexión y vuelve a intentarlo.' };
      }
    }
  };
}

// Derives a URL-safe, readable id from a template name, deduping against
// the ids already in use (custom-<n> for an empty/clashing slug). Pure.
function uniqueTemplateId(name, usedIds) {
  // Keep only ASCII alphanumerics from the (lowercased) name as id chars;
  // everything else (spaces, accents, punctuation) becomes a hyphen
  // separator. A blank result falls back to a generic base. Pure.
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'plantilla';
  if (!usedIds.has(base)) return base;
  let n = 2;
  while (usedIds.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// Advances the per-entity version map to match what writeEntities just
// committed: every written/created per-id entity bumped its row version
// by one, and a removed entity drops out of the map. Pure; clones the
// baseline so the caller's map is never mutated.
function bumpVersions(expectedVersions, res) {
  const next = {
    catalogVersion: expectedVersions.catalogVersion,
    pack: { ...expectedVersions.pack },
    product: { ...expectedVersions.product },
    supplier: { ...expectedVersions.supplier },
    addon: { ...expectedVersions.addon }
  };
  for (const r of res.results) {
    if (!next[r.entityType]) continue; // globals carry no per-id version
    if (r.status === 'deleted') {
      delete next[r.entityType][r.id];
    } else if (r.status === 'written') {
      // A fresh create lands at version 1; an update is the prior + 1.
      const prior = next[r.entityType][r.id];
      next[r.entityType][r.id] = prior === undefined ? 1 : prior + 1;
    }
  }
  return next;
}

module.exports = { createCloudBootstrap, DB_NAME, CODES };
