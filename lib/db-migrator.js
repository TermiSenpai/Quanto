// ============================================================
// PackPrice · idempotent app-side migration runner
// ============================================================
// Applies the bundled SQL migrations (lib/migration-loader.js)
// against a D1 client, recording each applied id in a
// schema_migrations table so re-runs are no-ops. Pure module:
// the client is injected, no fs, no network of its own.
// The `migrating_since` lock (acquire/release below) implements the
// «CANDADO» step of planes/v5-cloud-sync.md §6: a conditional UPDATE
// on the single catalog_meta row so only one PC migrates at a time;
// a lock older than `staleMinutes` is an orphaned migration and may
// be stolen. applyMigrations() is the «MIGRAR» step of that diagram.
//
// CONTRACT: each migration .sql file MUST be internally
// idempotent (IF NOT EXISTS / OR IGNORE), because exec() and the
// ledger INSERT are two separate HTTP calls, not atomic — a crash
// between them makes the next run re-execute the whole file.
// ============================================================

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

/**
 * Tries to take the migration lock. Returns true when this PC now
 * holds it. A fresh foreign lock returns false (caller should wait
 * and re-read); a lock older than `staleMinutes` is stolen.
 *
 * If catalog_meta does not exist yet the base is brand new: this is
 * the first migration and no other PC can be racing over a table
 * that is not there — acquire succeeds. Only that specific error is
 * tolerated; anything else (network, auth) propagates (fail-fast).
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} opts
 * @param {() => string} opts.now - ISO-8601 timestamp source
 * @param {number} [opts.staleMinutes=10]
 * @returns {Promise<boolean>}
 */
async function acquireMigrationLock(client, { now, staleMinutes = 10 }) {
  const lockTs = now();
  const staleCutoff = new Date(new Date(lockTs).getTime() - staleMinutes * 60000).toISOString();
  let res;
  try {
    res = await client.query(
      'UPDATE catalog_meta SET migrating_since = ? WHERE migrating_since IS NULL OR migrating_since < ?',
      [lockTs, staleCutoff]
    );
  } catch (err) {
    if (/no such table/i.test(err.message)) return true;
    throw err;
  }
  return (res.meta && res.meta.changes) === 1;
}

async function releaseMigrationLock(client) {
  await client.query('UPDATE catalog_meta SET migrating_since = NULL');
}

module.exports = { applyMigrations, acquireMigrationLock, releaseMigrationLock };
