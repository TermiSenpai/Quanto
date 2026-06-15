// ============================================================
// Tests · lib/error-reporter.js
// ============================================================
// The reporter is the ONLY place that talks to the developer's error
// endpoint. Two non-negotiables (PRD R19):
//   1. It is opt-out: disabled or no DSN → it must NOT call fetch.
//   2. It must NEVER throw — a telemetry failure can never crash the
//      app or mask the original error.
import { describe, test, expect, vi } from 'vitest';
import { reportError, DEFAULT_DSN } from '../lib/error-reporter.js';

const PAYLOAD = {
  message: 'boom',
  stack: 'Error: boom\n    at x',
  type: 'Error',
  app_version: '5.0.0-beta',
  schema_version: 1,
  os: 'win32 10.0.26200',
  arch: 'x64',
  data_source: 'cloud'
};

const DSN = 'https://abc123@o0.ingest.example.com/42';

describe('reportError · opt-out gating', () => {
  test('disabled → no fetch, returns {sent:false}', async () => {
    const fetchImpl = vi.fn();
    const r = await reportError(PAYLOAD, { dsn: DSN, fetchImpl, enabled: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: false });
  });

  test('no DSN → no fetch, returns {sent:false}', async () => {
    const fetchImpl = vi.fn();
    const r = await reportError(PAYLOAD, { dsn: '', fetchImpl, enabled: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: false });
  });

  test('default DSN is a clearly-marked placeholder (empty by default)', () => {
    expect(DEFAULT_DSN).toBe('');
  });
});

describe('reportError · sending', () => {
  test('enabled + DSN → POSTs the scrubbed payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const r = await reportError(PAYLOAD, { dsn: DSN, fetchImpl, enabled: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(typeof url).toBe('string');
    expect(init.method).toBe('POST');
    // The body must carry our payload fields (the message text travels in
    // the Sentry exception value) and the version tag.
    const body = init.body;
    const event = JSON.parse(body);
    expect(event.exception.values[0].value).toBe('boom');
    expect(body).toContain('5.0.0-beta');
    expect(r.sent).toBe(true);
  });

  test('builds a Sentry-compatible request (auth header or DSN-derived URL)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await reportError(PAYLOAD, { dsn: DSN, fetchImpl, enabled: true });
    const [url, init] = fetchImpl.mock.calls[0];
    const headers = init.headers || {};
    const hasAuth = Object.keys(headers).some((k) => /sentry|auth/i.test(k));
    // Either the key travels in an X-Sentry-Auth header or it is encoded
    // in the URL; one of the two must hold for a Sentry-compatible POST.
    expect(hasAuth || /abc123/.test(url)).toBe(true);
  });
});

describe('reportError · never throws', () => {
  test('fetch rejection is swallowed → {sent:false, error}', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const r = await reportError(PAYLOAD, { dsn: DSN, fetchImpl, enabled: true });
    expect(r.sent).toBe(false);
    expect(r.error).toBeDefined();
  });

  test('a non-ok response is reported as not-sent, not thrown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const r = await reportError(PAYLOAD, { dsn: DSN, fetchImpl, enabled: true });
    expect(r.sent).toBe(false);
  });

  test('a malformed DSN never throws', async () => {
    const fetchImpl = vi.fn();
    const r = await reportError(PAYLOAD, { dsn: 'not a url', fetchImpl, enabled: true });
    expect(r.sent).toBe(false);
    // We do not require fetch to have been skipped, only that nothing threw.
  });

  test('a throwing fetchImpl (synchronous) is swallowed', async () => {
    const fetchImpl = () => { throw new Error('sync boom'); };
    const r = await reportError(PAYLOAD, { dsn: DSN, fetchImpl, enabled: true });
    expect(r.sent).toBe(false);
    expect(r.error).toBeDefined();
  });

  test('missing options object never throws', async () => {
    const r = await reportError(PAYLOAD);
    expect(r).toEqual({ sent: false });
  });
});
