// ============================================================
// PackPrice · opt-out error reporter (PRD R19, v5 §5b)
// ============================================================
// Sends a scrubbed error payload (see lib/error-scrubber.js) to the
// developer-owned error endpoint using the Sentry "store" protocol —
// plain `fetch`, NO SDK, zero new dependencies. The endpoint (a Sentry
// free-tier / GlitchTip project) is the developer's, accepted as a
// third-party element alongside GitHub Releases; it carries no customer
// data (the scrubber guarantees the whitelist).
//
// Two hard guarantees:
//   - Opt-out: if reporting is disabled or no DSN is configured, this
//     does NOTHING and never touches the network.
//   - Crash-proof: a telemetry failure must NEVER throw — it would
//     otherwise mask the very error we were trying to report. Every
//     path returns { sent:false, error? } instead.
//
// Network only ever happens in the main process (the caller injects
// `fetchImpl`, so this module is testable and side-effect free).
// ============================================================

'use strict';

// ------------------------------------------------------------------
// DEVELOPER-OWNED CONSTANT — set this to the real Sentry/GlitchTip DSN
// before shipping a release. Left EMPTY on purpose so the feature is a
// no-op until the owner opts in by filling it (an empty DSN disables
// reporting regardless of the user toggle). The DSN is a public ingest
// key, not a secret, and carries no customer data.
// TODO(owner): paste your Sentry/GlitchTip project DSN here, e.g.
//   'https://<public_key>@<org>.ingest.sentry.io/<project_id>'
// ------------------------------------------------------------------
const DEFAULT_DSN = '';

const SENTRY_CLIENT = 'packprice-fetch/1';

/**
 * Parses a Sentry DSN into the store endpoint URL + the auth header.
 * Returns null when the DSN is missing or malformed (the caller then
 * treats it as "not configured" — a no-op, never an error).
 *
 * DSN shape: https://<public_key>@<host>[:port]/<path...>/<project_id>
 */
function parseDsn(dsn) {
  if (typeof dsn !== 'string' || dsn === '') return null;
  let u;
  try {
    u = new URL(dsn);
  } catch (_) {
    return null;
  }
  const publicKey = u.username;
  if (!publicKey) return null;
  // The project id is the last non-empty path segment; anything before it
  // is an optional path prefix (self-hosted GlitchTip behind a sub-path).
  const segments = u.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!projectId) return null;
  const prefix = segments.length > 0 ? `/${segments.join('/')}` : '';
  const endpoint = `${u.protocol}//${u.host}${prefix}/api/${projectId}/store/`;
  const auth = [
    'Sentry sentry_version=7',
    `sentry_client=${SENTRY_CLIENT}`,
    `sentry_key=${publicKey}`
  ].join(', ');
  return { endpoint, auth };
}

/**
 * Wraps the scrubbed payload in a minimal Sentry-compatible event. We
 * map our whitelist onto Sentry fields without an SDK; the server is
 * tolerant of extra/missing fields.
 */
function buildEnvelope(payload) {
  const p = payload || {};
  return {
    platform: 'node',
    level: 'error',
    timestamp: Date.now() / 1000,
    release: p.app_version || undefined,
    exception: {
      values: [{
        type: p.type || 'Error',
        value: p.message || '',
        stacktrace: p.stack ? { frames: [], raw: p.stack } : undefined
      }]
    },
    // Our extra whitelist fields travel as tags/extra — never business data.
    tags: {
      app_version: p.app_version || undefined,
      schema_version: p.schema_version != null ? String(p.schema_version) : undefined,
      data_source: p.data_source || undefined,
      arch: p.arch || undefined
    },
    extra: {
      os: p.os || undefined
    }
  };
}

/**
 * Reports a scrubbed error payload. Opt-out and crash-proof.
 *
 * @param {object} payload  the scrubbed whitelist payload
 * @param {object} [options]
 * @param {string} [options.dsn=DEFAULT_DSN]
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {boolean} [options.enabled]
 * @returns {Promise<{sent:boolean, error?:string, status?:number}>}
 */
async function reportError(payload, options = {}) {
  try {
    const opts = options || {};
    const enabled = opts.enabled;
    const dsn = opts.dsn !== undefined ? opts.dsn : DEFAULT_DSN;
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    // Opt-out / not-configured short-circuits — NO network at all.
    if (!enabled || !dsn || !fetchImpl) {
      return { sent: false };
    }

    const parsed = parseDsn(dsn);
    if (!parsed) {
      // A malformed DSN is treated as "not configured", never an error.
      return { sent: false };
    }

    const body = JSON.stringify(buildEnvelope(payload));
    const res = await fetchImpl(parsed.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': parsed.auth
      },
      body
    });

    if (res && res.ok) {
      return { sent: true, status: res.status };
    }
    return { sent: false, status: res ? res.status : undefined };
  } catch (err) {
    // The whole point: a reporter failure must never escape. Swallow it
    // and hand the caller a flag so it can log locally if it wants.
    return { sent: false, error: (err && err.message) ? err.message : String(err) };
  }
}

module.exports = {
  reportError,
  parseDsn,
  buildEnvelope,
  DEFAULT_DSN
};
