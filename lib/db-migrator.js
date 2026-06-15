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
 * Tries to take the migration lock. Returns the exact `lockTs` it
 * wrote into `migrating_since` when this PC now holds the lock —
 * the caller MUST keep it and pass it back to releaseMigrationLock,
 * which only clears its own lock. A fresh foreign lock returns null
 * (caller should wait and re-read); a lock older than `staleMinutes`
 * is stolen.
 *
 * `now()` must return a UTC ISO-8601 timestamp; it is normalized via
 * `new Date(now()).toISOString()` so every stored lockTs has the same
 * millisecond format and the lexicographic staleness/ownership
 * comparisons are uniform across PCs.
 *
 * If catalog_meta does not exist yet the base is brand new: this is
 * the first migration and no other PC can be racing over a table
 * that is not there — acquire succeeds (the later release matches
 * nothing and is harmless). Only that specific error is tolerated;
 * anything else (network, auth) propagates (fail-fast).
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} opts
 * @param {() => string} opts.now - UTC ISO-8601 timestamp source
 * @param {number} [opts.staleMinutes=10]
 * @returns {Promise<string|null>} the lockTs held, or null if not acquired
 */
async function acquireMigrationLock(client, { now, staleMinutes = 10 }) {
  const lockTs = new Date(now()).toISOString();
  const staleCutoff = new Date(new Date(lockTs).getTime() - staleMinutes * 60000).toISOString();
  let res;
  try {
    res = await client.query(
      'UPDATE catalog_meta SET migrating_since = ? WHERE migrating_since IS NULL OR migrating_since < ?',
      [lockTs, staleCutoff]
    );
  } catch (err) {
    if (/no such table/i.test(err.message)) return lockTs;
    throw err;
  }
  return (res.meta && res.meta.changes) === 1 ? lockTs : null;
}

/**
 * Releases the migration lock — but ONLY if we still own it. The
 * conditional WHERE means a stale PC (whose lock was stolen after
 * `staleMinutes`) cannot wipe the new owner's lock: its release
 * simply matches 0 rows.
 *
 * @param {object} client - D1 client
 * @param {object} opts
 * @param {string} opts.lockTs - the value acquireMigrationLock returned
 */
async function releaseMigrationLock(client, { lockTs }) {
  await client.query(
    'UPDATE catalog_meta SET migrating_since = NULL WHERE migrating_since = ?',
    [lockTs]
  );
}

module.exports = { applyMigrations, acquireMigrationLock, releaseMigrationLock };
