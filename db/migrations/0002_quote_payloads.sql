-- 0002_quote_payloads.sql — full reopenable quote JSON, separate from the flat
-- stats columns in `quotes`. CREATE ... IF NOT EXISTS keeps the file idempotent
-- (the runner may re-exec a file after a crash — lib/db-migrator.js).
--
-- Why a separate table rather than adding a column to `quotes`: SQLite's
-- column-add has no IF NOT EXISTS guard, so a re-exec after a crash would
-- throw "duplicate column name". A separate CREATE TABLE IF NOT EXISTS is
-- the only additive change the runner can safely re-run.
--
-- The flat `quotes` row (db/migrations/0001_init.sql) keeps feeding stats
-- and owns the authoritative status/status_ts; this table only stores the
-- reopenable payload + its optimistic-concurrency version.
CREATE TABLE IF NOT EXISTS quote_payloads (
  quote_id TEXT PRIMARY KEY,
  payload  TEXT NOT NULL,
  version  INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
