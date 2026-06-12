-- 0001_init.sql — esquema inicial PackPrice v5 (aditivo desde aquí; jamás editar este archivo después de publicado)

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
