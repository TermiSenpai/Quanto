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

/**
 * Validates and sanitizes a settings payload coming from the
 * renderer. Returns a NEW object containing only the known fields
 * (`config_path`, `user_name`). Throws an Error (Spanish) when the
 * payload is not a plain object or a field has the wrong type or
 * exceeds its length bound.
 *
 * Fields are optional individually (the renderer may persist just
 * the user name or just the path), but unknown fields are dropped
 * silently — they are never an error, just ignored.
 *
 * @param {unknown} payload
 * @returns {{ config_path?: string, user_name?: string }}
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

  return out;
}

module.exports = {
  validateSettingsPayload,
  MAX_CONFIG_PATH,
  MAX_USER_NAME
};
