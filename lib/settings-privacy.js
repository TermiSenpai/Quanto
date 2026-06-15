// ============================================================
// PackPrice · settings.json token privacy (redact + merge)
// ============================================================
// The Cloudflare API token lives ONLY in the per-PC settings.json,
// never in the renderer (CLAUDE.md hard rule via the v5 debate).
//
//   redactSettings(stored)        → what settings:read sends out:
//     cloud.token is dropped and replaced by a `has_token` boolean
//     so the wizard can tell "configured" from "missing" without
//     ever holding the secret. Pure: the input is never mutated.
//
//   mergeSettingsWrite(stored, in) → what settings:write persists:
//     re-attaches the token the renderer never had and preserves the
//     stored data_source/cloud when an incoming payload omits them,
//     so a renderer round-trip can never wipe what only main knows.
//     The `cloud.clear_token: true` escape hatch is the ONLY way to
//     drop the token, and that flag is itself never persisted.
//
// Pure and dependency-free so it can be unit-tested in isolation.
// ============================================================

'use strict';

/**
 * Returns a renderer-safe copy of `settings`: the Cloudflare token is
 * replaced by a `has_token` boolean. Pure — the input is returned
 * untouched when there is no cloud section (and `null` passes
 * straight through).
 *
 * @param {object|null} settings
 * @returns {object|null}
 */
function redactSettings(settings) {
  if (!settings || typeof settings !== 'object' || !settings.cloud) return settings;
  const { token, ...cloudRest } = settings.cloud;
  return {
    ...settings,
    cloud: { ...cloudRest, has_token: typeof token === 'string' && token.length > 0 }
  };
}

/**
 * Merges a (validated) incoming settings payload over what is stored
 * on disk, preserving the secrets and storage choice the renderer
 * never carries:
 *   - stored `data_source` is kept when the payload omits it;
 *   - the stored opt-out toggles (`error_reports_enabled`,
 *     `check_updates_on_start`) are kept when the payload omits them, so
 *     saving one toggle never wipes the other (Plan 7B);
 *   - the stored `cloud` section is kept whole when the payload omits
 *     `cloud`;
 *   - the stored `cloud.token` is kept when the incoming cloud lacks
 *     a non-empty one (an empty-string token never overwrites);
 *   - an incoming non-empty token wins;
 *   - `incoming.cloud.clear_token === true` is the explicit escape
 *     hatch that drops the token (winning even over an incoming
 *     token), and the flag itself is never persisted;
 *   - the `has_token` view flag is never persisted.
 * Tolerates a null/empty `stored` (first boot).
 *
 * @param {object|null} stored
 * @param {object} incoming
 * @returns {object}
 */
function mergeSettingsWrite(stored, incoming) {
  const current = (stored && typeof stored === 'object') ? stored : {};
  const merged = { ...incoming };

  if (merged.data_source === undefined && current.data_source !== undefined) {
    merged.data_source = current.data_source;
  }

  // Opt-out toggles: a payload that writes one must not drop the other
  // (each toggle persists independently — Plan 7B). Keep the stored
  // value whenever the incoming payload omits the field.
  for (const field of ['error_reports_enabled', 'check_updates_on_start']) {
    if (merged[field] === undefined && current[field] !== undefined) {
      merged[field] = current[field];
    }
  }

  if (incoming.cloud === undefined) {
    // No cloud section in the payload: keep the stored one whole.
    if (current.cloud !== undefined) merged.cloud = current.cloud;
    return merged;
  }

  // The incoming cloud section may carry view-only / control flags
  // (has_token, clear_token) that must never reach disk.
  const { has_token, clear_token, token: incomingToken, ...cloudRest } = incoming.cloud;
  const cloud = { ...cloudRest };
  const storedToken = current.cloud && current.cloud.token;

  if (clear_token === true) {
    // Explicit escape hatch: drop the token regardless of any
    // incoming token. The flag itself is dropped above.
  } else if (typeof incomingToken === 'string' && incomingToken !== '') {
    cloud.token = incomingToken;
  } else if (typeof storedToken === 'string' && storedToken !== '') {
    cloud.token = storedToken;
  }

  merged.cloud = cloud;
  return merged;
}

module.exports = { redactSettings, mergeSettingsWrite };
