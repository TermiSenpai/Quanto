// ============================================================
// PackPrice · settings.json payload validator
// ============================================================
// The renderer sends a plain object to `settings:write`. We must
// never persist it raw: a compromised or buggy renderer could write
// unknown fields, huge strings, or non-string values into the local
// settings.json. This validator returns ONLY the known v3 fields,
// each checked for type and a sane length bound.
//
// Pure and dependency-free so it can be unit-tested in isolation.
// User-facing throw messages stay in Spanish (CLAUDE.md §4.5).
// ============================================================

'use strict';

const MAX_CONFIG_PATH = 500;
const MAX_USER_NAME = 100;
// Cloudflare API tokens are ~40 chars and account/database ids are
// 32-hex / UUID — the bounds are generous but still reject garbage.
const MAX_CLOUD_TOKEN = 300;
const MAX_CLOUD_ID = 100;

// v5 storage choice. Absent means 'file' (pre-v5 settings keep
// validating without migration — the default is applied at read
// time in main, never persisted on their behalf).
const DATA_SOURCES = ['file', 'cloud'];

// v5 product toggles (Plan 7A). Both are opt-OUT: absent means ON, so
// the defaults are applied at read time in main, never persisted on a
// user's behalf. The validator only checks the type when present.
const DEFAULT_ERROR_REPORTS_ENABLED = true;
const DEFAULT_CHECK_UPDATES_ON_START = true;

function takeString(source, out, field, max, label) {
  if (field in source && source[field] !== undefined) {
    const v = source[field];
    if (typeof v !== 'string') {
      throw new Error(`${label} debe ser texto.`);
    }
    if (v.length > max) {
      throw new Error(`${label} es demasiado largo (máx. ${max}).`);
    }
    out[field] = v;
  }
}

function takeBoolean(source, out, field, label) {
  if (field in source && source[field] !== undefined) {
    const v = source[field];
    if (typeof v !== 'boolean') {
      throw new Error(`${label} debe ser verdadero o falso.`);
    }
    out[field] = v;
  }
}

/**
 * Validates and sanitizes a settings payload coming from the
 * renderer. Returns a NEW object containing only the known fields
 * (`config_path`, `user_name`, and the v5 `data_source` /
 * `cloud: { token, account_id, database_id, user_name }`). Throws
 * an Error (Spanish) when the payload is not a plain object or a
 * field has the wrong type or exceeds its length bound.
 *
 * Fields are optional individually (the renderer may persist just
 * the user name or just the path), but unknown fields are dropped
 * silently — they are never an error, just ignored.
 *
 * @param {unknown} payload
 * @returns {{ config_path?: string, user_name?: string, data_source?: 'file'|'cloud', error_reports_enabled?: boolean, check_updates_on_start?: boolean, cloud?: { token?: string, account_id?: string, database_id?: string, user_name?: string } }}
 */
function validateSettingsPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Los ajustes deben ser un objeto.');
  }

  const out = {};

  if ('config_path' in payload && payload.config_path !== undefined) {
    const v = payload.config_path;
    if (typeof v !== 'string') {
      throw new Error('La ruta de configuración debe ser texto.');
    }
    if (v.length > MAX_CONFIG_PATH) {
      throw new Error(`La ruta de configuración es demasiado larga (máx. ${MAX_CONFIG_PATH}).`);
    }
    out.config_path = v;
  }

  if ('user_name' in payload && payload.user_name !== undefined) {
    const v = payload.user_name;
    if (typeof v !== 'string') {
      throw new Error('El nombre de usuario debe ser texto.');
    }
    if (v.length > MAX_USER_NAME) {
      throw new Error(`El nombre de usuario es demasiado largo (máx. ${MAX_USER_NAME}).`);
    }
    out.user_name = v;
  }

  // --- v5 cloud fields (additive — see planes/v5-cloud-sync.md) ---

  if ('data_source' in payload && payload.data_source !== undefined) {
    const v = payload.data_source;
    if (!DATA_SOURCES.includes(v)) {
      throw new Error("El origen de datos debe ser 'file' o 'cloud'.");
    }
    out.data_source = v;
  }

  // --- v5 product toggles (opt-out: error reports + update-on-start) ---
  takeBoolean(payload, out, 'error_reports_enabled', 'El envío de informes de error');
  takeBoolean(payload, out, 'check_updates_on_start', 'La comprobación de actualizaciones al iniciar');

  if ('cloud' in payload && payload.cloud !== undefined) {
    const cloud = payload.cloud;
    if (cloud === null || typeof cloud !== 'object' || Array.isArray(cloud)) {
      throw new Error('Los ajustes de nube deben ser un objeto.');
    }
    const cleanCloud = {};
    takeString(cloud, cleanCloud, 'token', MAX_CLOUD_TOKEN, 'El token de Cloudflare');
    takeString(cloud, cleanCloud, 'account_id', MAX_CLOUD_ID, 'El identificador de la cuenta de Cloudflare');
    takeString(cloud, cleanCloud, 'database_id', MAX_CLOUD_ID, 'El identificador de la base de datos D1');
    takeString(cloud, cleanCloud, 'user_name', MAX_USER_NAME, 'El nombre de usuario');
    out.cloud = cleanCloud;
  }

  return out;
}

module.exports = {
  validateSettingsPayload,
  MAX_CONFIG_PATH,
  MAX_USER_NAME,
  MAX_CLOUD_TOKEN,
  MAX_CLOUD_ID,
  DATA_SOURCES,
  DEFAULT_ERROR_REPORTS_ENABLED,
  DEFAULT_CHECK_UPDATES_ON_START
};
