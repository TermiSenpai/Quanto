// ============================================================
// Tests · lib/settings-validator.js
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  validateSettingsPayload,
  MAX_CONFIG_PATH,
  MAX_USER_NAME,
  MAX_CLOUD_TOKEN,
  MAX_CLOUD_ID,
  DATA_SOURCES,
  DEFAULT_ERROR_REPORTS_ENABLED,
  DEFAULT_CHECK_UPDATES_ON_START
} from '../lib/settings-validator.js';

describe('validateSettingsPayload', () => {
  test('keeps only the known fields', () => {
    const out = validateSettingsPayload({
      config_path: '\\\\nas\\Packs\\config.js',
      user_name: 'Alberto'
    });
    expect(out).toEqual({
      config_path: '\\\\nas\\Packs\\config.js',
      user_name: 'Alberto'
    });
  });

  test('drops unknown fields silently', () => {
    const out = validateSettingsPayload({
      user_name: 'Alberto',
      evil: { __proto__: 1 },
      version: '99',
      ruta_config: 'legacy'
    });
    expect(out).toEqual({ user_name: 'Alberto' });
  });

  test('allows partial payloads', () => {
    expect(validateSettingsPayload({ user_name: 'A' })).toEqual({ user_name: 'A' });
    expect(validateSettingsPayload({ config_path: 'C:\\x.js' })).toEqual({ config_path: 'C:\\x.js' });
    expect(validateSettingsPayload({})).toEqual({});
  });

  test('rejects non-objects', () => {
    expect(() => validateSettingsPayload(null)).toThrow();
    expect(() => validateSettingsPayload('oops')).toThrow();
    expect(() => validateSettingsPayload(42)).toThrow();
    expect(() => validateSettingsPayload([])).toThrow();
  });

  test('rejects non-string fields', () => {
    expect(() => validateSettingsPayload({ config_path: 123 })).toThrow();
    expect(() => validateSettingsPayload({ user_name: {} })).toThrow();
  });

  test('rejects over-long fields', () => {
    expect(() => validateSettingsPayload({
      config_path: 'x'.repeat(MAX_CONFIG_PATH + 1)
    })).toThrow();
    expect(() => validateSettingsPayload({
      user_name: 'y'.repeat(MAX_USER_NAME + 1)
    })).toThrow();
  });

  test('accepts fields at the exact length bound', () => {
    const out = validateSettingsPayload({
      config_path: 'x'.repeat(MAX_CONFIG_PATH),
      user_name: 'y'.repeat(MAX_USER_NAME)
    });
    expect(out.config_path).toHaveLength(MAX_CONFIG_PATH);
    expect(out.user_name).toHaveLength(MAX_USER_NAME);
  });
});

// --- v5 cloud fields (additive: pre-v5 settings keep validating) ---

describe('validateSettingsPayload · data_source', () => {
  test('accepts the two known sources', () => {
    expect(DATA_SOURCES).toEqual(['file', 'cloud']);
    expect(validateSettingsPayload({ data_source: 'file' })).toEqual({ data_source: 'file' });
    expect(validateSettingsPayload({ data_source: 'cloud' })).toEqual({ data_source: 'cloud' });
  });

  test('is optional: existing settings without it keep validating unchanged', () => {
    const legacy = { config_path: 'Z:\\Packs\\config.js', user_name: 'Alberto' };
    expect(validateSettingsPayload(legacy)).toEqual(legacy);
  });

  test('rejects unknown or non-string sources', () => {
    expect(() => validateSettingsPayload({ data_source: 'nas' })).toThrow(/origen de datos/i);
    expect(() => validateSettingsPayload({ data_source: 7 })).toThrow(/origen de datos/i);
    expect(() => validateSettingsPayload({ data_source: ['cloud'] })).toThrow(/origen de datos/i);
  });
});

describe('validateSettingsPayload · cloud', () => {
  const CLOUD = {
    token: 'tok-abc123',
    account_id: 'a'.repeat(32),
    database_id: '123e4567-e89b-42d3-a456-426614174000',
    user_name: 'PC-Taller'
  };

  test('keeps the four known cloud fields', () => {
    expect(validateSettingsPayload({ cloud: CLOUD })).toEqual({ cloud: CLOUD });
  });

  test('allows partial cloud payloads and drops unknown cloud fields', () => {
    const out = validateSettingsPayload({
      cloud: { account_id: 'abc', has_token: true, evil: 'x' }
    });
    expect(out).toEqual({ cloud: { account_id: 'abc' } });
  });

  test('rejects a cloud section that is not a plain object', () => {
    expect(() => validateSettingsPayload({ cloud: 'token' })).toThrow(/nube/i);
    expect(() => validateSettingsPayload({ cloud: [] })).toThrow(/nube/i);
    expect(() => validateSettingsPayload({ cloud: 42 })).toThrow(/nube/i);
  });

  test('rejects non-string cloud fields', () => {
    expect(() => validateSettingsPayload({ cloud: { token: 9 } })).toThrow();
    expect(() => validateSettingsPayload({ cloud: { account_id: {} } })).toThrow();
    expect(() => validateSettingsPayload({ cloud: { database_id: null } })).toThrow();
    expect(() => validateSettingsPayload({ cloud: { user_name: false } })).toThrow();
  });

  test('rejects over-long cloud fields and accepts the exact bound', () => {
    expect(() => validateSettingsPayload({ cloud: { token: 't'.repeat(MAX_CLOUD_TOKEN + 1) } })).toThrow();
    expect(() => validateSettingsPayload({ cloud: { account_id: 'a'.repeat(MAX_CLOUD_ID + 1) } })).toThrow();
    expect(() => validateSettingsPayload({ cloud: { database_id: 'd'.repeat(MAX_CLOUD_ID + 1) } })).toThrow();
    expect(() => validateSettingsPayload({ cloud: { user_name: 'u'.repeat(MAX_USER_NAME + 1) } })).toThrow();
    const out = validateSettingsPayload({ cloud: { token: 't'.repeat(MAX_CLOUD_TOKEN) } });
    expect(out.cloud.token).toHaveLength(MAX_CLOUD_TOKEN);
  });

  test('a full v5 payload round-trips intact', () => {
    const payload = {
      config_path: 'Z:\\Packs\\config.js',
      user_name: 'Alberto',
      data_source: 'cloud',
      cloud: CLOUD
    };
    expect(validateSettingsPayload(payload)).toEqual(payload);
  });
});

// --- v5 product toggles: error reports + update-on-start (Plan 7A) ---

describe('validateSettingsPayload · product toggles', () => {
  test('defaults are both true (opt-out)', () => {
    expect(DEFAULT_ERROR_REPORTS_ENABLED).toBe(true);
    expect(DEFAULT_CHECK_UPDATES_ON_START).toBe(true);
  });

  test('accepts boolean error_reports_enabled', () => {
    expect(validateSettingsPayload({ error_reports_enabled: true }))
      .toEqual({ error_reports_enabled: true });
    expect(validateSettingsPayload({ error_reports_enabled: false }))
      .toEqual({ error_reports_enabled: false });
  });

  test('accepts boolean check_updates_on_start', () => {
    expect(validateSettingsPayload({ check_updates_on_start: true }))
      .toEqual({ check_updates_on_start: true });
    expect(validateSettingsPayload({ check_updates_on_start: false }))
      .toEqual({ check_updates_on_start: false });
  });

  test('rejects non-boolean toggle values', () => {
    expect(() => validateSettingsPayload({ error_reports_enabled: 'yes' })).toThrow();
    expect(() => validateSettingsPayload({ error_reports_enabled: 1 })).toThrow();
    expect(() => validateSettingsPayload({ check_updates_on_start: 'no' })).toThrow();
    expect(() => validateSettingsPayload({ check_updates_on_start: null })).toThrow();
  });

  test('toggles are optional: a payload without them is unchanged', () => {
    expect(validateSettingsPayload({ user_name: 'A' })).toEqual({ user_name: 'A' });
  });

  test('toggles round-trip alongside the rest of a v5 payload', () => {
    const payload = {
      user_name: 'Alberto',
      data_source: 'file',
      error_reports_enabled: false,
      check_updates_on_start: false
    };
    expect(validateSettingsPayload(payload)).toEqual(payload);
  });
});
