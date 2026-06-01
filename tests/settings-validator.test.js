// ============================================================
// Tests · lib/settings-validator.js
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  validateSettingsPayload,
  MAX_CONFIG_PATH,
  MAX_USER_NAME
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
