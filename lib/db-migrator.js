// ============================================================
// PackPrice · idempotent app-side migration runner
// ============================================================
// Applies the bundled SQL migrations (lib/migration-loader.js)
// against a D1 client, recording each applied id in a
// schema_migrations table so re-runs are no-ops. Pure module:
// the client is injected, no fs, no network of its own.
// The `migrating_since` lock and pre-migration backup-export
// belong to Plan 2 — full contract in planes/v5-cloud-sync.md §6;
// this module is the «MIGRAR» step of that diagram.
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

module.exports = { applyMigrations };
