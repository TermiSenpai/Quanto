// ============================================================
// Tests · lib/settings-privacy.js (token redaction + write merge)
// ============================================================
// The Cloudflare API token lives only in the per-PC settings.json.
// redactSettings is what settings:read sends to the renderer (token
// → has_token flag); mergeSettingsWrite is what settings:write does
// to re-attach the secret the renderer never had. The two must
// round-trip: redact → renderer → merge never loses the token, and
// only the explicit clear_token escape hatch drops it.
// ============================================================

import { describe, test, expect } from 'vitest';
import { redactSettings, mergeSettingsWrite } from '../lib/settings-privacy.js';

const STORED = {
  config_path: 'C:\\x\\config.js',
  user_name: 'Alberto',
  data_source: 'cloud',
  cloud: { token: 'tok-secret', account_id: 'acc-1', database_id: 'db-1', user_name: 'Alberto' }
};

// ------------------------------------------------------------
// redactSettings
// ------------------------------------------------------------
describe('redactSettings', () => {
  test('replaces cloud.token with has_token: true and never leaks the secret', () => {
    const out = redactSettings(STORED);
    expect(out.cloud.token).toBeUndefined();
    expect(out.cloud.has_token).toBe(true);
    expect(out.cloud.account_id).toBe('acc-1');
    expect(out.cloud.database_id).toBe('db-1');
    expect(JSON.stringify(out)).not.toContain('tok-secret');
    // Pure: the stored object is untouched.
    expect(STORED.cloud.token).toBe('tok-secret');
  });

  test('has_token is false for a missing or empty token', () => {
    expect(redactSettings({ cloud: {} }).cloud.has_token).toBe(false);
    expect(redactSettings({ cloud: { token: '' } }).cloud.has_token).toBe(false);
  });

  test('passes through settings without a cloud section (and null) unchanged', () => {
    expect(redactSettings(null)).toBeNull();
    const fileOnly = { config_path: 'C:\\x.js', user_name: 'A' };
    expect(redactSettings(fileOnly)).toBe(fileOnly);
  });
});

// ------------------------------------------------------------
// mergeSettingsWrite
// ------------------------------------------------------------
describe('mergeSettingsWrite', () => {
  test('round-trip: a redacted settings:read payload written back keeps the token', () => {
    // What the renderer does on every save: read (redacted) → write.
    const incoming = redactSettings(STORED);
    const merged = mergeSettingsWrite(STORED, incoming);
    expect(merged.cloud.token).toBe('tok-secret');
    // The has_token view flag is never persisted to disk.
    expect(merged.cloud.has_token).toBeUndefined();
    expect(merged.data_source).toBe('cloud');
  });

  test('incoming cloud: {} preserves the stored token', () => {
    const merged = mergeSettingsWrite(STORED, { user_name: 'Bea', cloud: {} });
    expect(merged.cloud.token).toBe('tok-secret');
    expect(merged.user_name).toBe('Bea');
  });

  test('empty-string incoming token also preserves the stored one', () => {
    const merged = mergeSettingsWrite(STORED, { cloud: { token: '' } });
    expect(merged.cloud.token).toBe('tok-secret');
  });

  test('omitted cloud keeps the whole stored cloud section', () => {
    const merged = mergeSettingsWrite(STORED, { user_name: 'Bea' });
    expect(merged.cloud).toEqual(STORED.cloud);
  });

  test('an incoming token wins over the stored one', () => {
    const merged = mergeSettingsWrite(STORED, { cloud: { token: 'tok-new' } });
    expect(merged.cloud.token).toBe('tok-new');
  });

  test('clear_token: true drops the token and is itself never persisted', () => {
    const merged = mergeSettingsWrite(STORED, { cloud: { clear_token: true, account_id: 'acc-1' } });
    expect(merged.cloud.token).toBeUndefined();
    expect(merged.cloud.clear_token).toBeUndefined();
    expect(merged.cloud.account_id).toBe('acc-1');
  });

  test('clear_token wins even when the incoming payload carries a token', () => {
    const merged = mergeSettingsWrite(STORED, { cloud: { clear_token: true, token: 'tok-new' } });
    expect(merged.cloud.token).toBeUndefined();
  });

  test('preserves stored data_source when the incoming payload omits it', () => {
    const merged = mergeSettingsWrite(STORED, { user_name: 'Bea' });
    expect(merged.data_source).toBe('cloud');
  });

  test('an incoming data_source wins (switching back to file)', () => {
    const merged = mergeSettingsWrite(STORED, { data_source: 'file' });
    expect(merged.data_source).toBe('file');
  });

  test('tolerates empty or null stored settings (first boot)', () => {
    expect(mergeSettingsWrite(null, { user_name: 'A' })).toEqual({ user_name: 'A' });
    expect(mergeSettingsWrite({}, { cloud: { token: 'tok-1' } }).cloud.token).toBe('tok-1');
  });
});
