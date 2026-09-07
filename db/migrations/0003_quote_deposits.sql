-- 0003_quote_deposits.sql — the paid-deposit ("señal") workflow fact, kept
-- separate from the versioned payload (a deposit mark must not bump the
-- content version) and from the flat `quotes` row (SQLite's column-add has
-- no IF NOT EXISTS guard — see 0002). CREATE ... IF NOT EXISTS keeps the
-- file idempotent for the runner (lib/db-migrator.js). Absent row = not
-- paid. The flat `quotes` row still owns status/status_ts: marking a
-- deposit paid also sets status = 'accepted' there (lib/cloud-quotes.js).
CREATE TABLE IF NOT EXISTS quote_deposits (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id),
  amount   REAL NOT NULL,
  paid_at  TEXT NOT NULL,
  paid_by  TEXT
);
