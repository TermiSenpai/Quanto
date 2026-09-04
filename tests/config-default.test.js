// ============================================================
// Default config tests (config.default.js) — empty-config builder
// ============================================================
// There is no longer a default catalog: config.default.js exports a
// schema version, the cost-parameter key list, and buildEmptyConfig()
// (a schema-shaped but EMPTY scaffold the first-run wizard fills). It
// also owns the quote deposit defaults (DEFAULT_DEPOSIT_PCT +
// applyQuoteSettingsDefaults). These guard the new exports and the
// "empty but shaped" contract.
// ============================================================
import { describe, it, expect } from 'vitest';
import * as configDefault from '../config.default.js';
import {
  SCHEMA_VERSION,
  PARAMETER_KEYS,
  buildEmptyConfig,
  DEFAULT_DEPOSIT_PCT,
  applyQuoteSettingsDefaults
} from '../config.default.js';
import { validateConfigSchema } from '../lib/config-schema.js';

describe('config.default (empty-config builder)', () => {
  it('exposes the v4 schema version', () => {
    expect(SCHEMA_VERSION).toBe('4.0.0');
  });

  it('no longer exports buildDefaultConfig (no default catalog)', () => {
    expect(configDefault.buildDefaultConfig).toBeUndefined();
  });

  it('buildEmptyConfig has the full v4 shape with EMPTY collections', () => {
    const cfg = buildEmptyConfig();
    expect(cfg.version).toBe('4.0.0');
    expect(cfg.suppliers).toEqual({});
    expect(cfg.products).toEqual({});
    expect(cfg.packs).toEqual({});
    expect(cfg.addons).toEqual({});
    expect(cfg.tiers).toEqual([]);
    expect(cfg.company).toBeTypeOf('object');
    expect(cfg.quote_settings).toBeTypeOf('object');
  });

  it('buildEmptyConfig nulls every cost parameter', () => {
    const cfg = buildEmptyConfig();
    expect(PARAMETER_KEYS.length).toBeGreaterThan(0);
    for (const key of PARAMETER_KEYS) {
      expect(cfg.parameters[key], `parameters.${key}`).toBeNull();
    }
  });

  it('buildEmptyConfig keeps a non-empty admin.password (schema compat)', () => {
    expect(typeof buildEmptyConfig().admin.password).toBe('string');
    expect(buildEmptyConfig().admin.password.length).toBeGreaterThan(0);
  });

  it('buildEmptyConfig is NOT yet valid (empty catalog), but becomes valid once minimal data is added', () => {
    expect(() => validateConfigSchema(buildEmptyConfig())).toThrow();

    const cfg = buildEmptyConfig();
    for (const key of PARAMETER_KEYS) cfg.parameters[key] = 1;
    cfg.parameters.vat = 0.21;
    cfg.parameters.waste_pct = 0.10;
    cfg.parameters.default_target_margin = 0.35;
    cfg.parameters.price_rounding_ending = 0.95;
    cfg.tiers = [{ id: 'T1', label: 'Único', from: 1, to: null, time_reduction: 0 }];
    cfg.suppliers = { SUP: { name: 'Prov', web: '', notes: '' } };
    cfg.products = {
      P: {
        name: 'Camiseta', category: 'tshirt', extra_cost_3xl: 0.4, target_margin: 0.35,
        suppliers: [{ supplier: 'SUP', ref: '', price: 2, min_order: 0, is_default: true }],
        prices: { two_sides: { T1: 9.95 }, one_side: { T1: 8.95 } }
      }
    };
    cfg.packs = {
      shirts: {
        name: 'Solo camisetas', description: '', icon: 'i-tshirt',
        pricing_mode: 'components', min_total: 1, target_margin: 0.35,
        options: [{ id: 'sides', label: 'Caras', values: [
          { id: 'one_side', label: '1 cara', sides: 1 },
          { id: 'two_sides', label: '2 caras', sides: 2 }
        ] }],
        components: [{ id: 'shirt', label: 'Camiseta', product: 'P' }]
      }
    };
    expect(() => validateConfigSchema(cfg)).not.toThrow();
  });
});

describe('deposit defaults (quote_settings.deposit_pct)', () => {
  it('buildEmptyConfig carries the default deposit percentage', () => {
    expect(DEFAULT_DEPOSIT_PCT).toBe(0.4);
    expect(buildEmptyConfig().quote_settings.deposit_pct).toBe(DEFAULT_DEPOSIT_PCT);
  });

  it('applyQuoteSettingsDefaults returns the SAME reference when deposit_pct is present', () => {
    const cfg = buildEmptyConfig();
    expect(applyQuoteSettingsDefaults(cfg)).toBe(cfg);
    const custom = { quote_settings: { deposit_pct: 0.5 } };
    expect(applyQuoteSettingsDefaults(custom)).toBe(custom);
    const zero = { quote_settings: { deposit_pct: 0 } };
    expect(applyQuoteSettingsDefaults(zero)).toBe(zero);
  });

  it('fills a missing deposit_pct without touching the input or the other keys', () => {
    const cfg = { version: '4.0.0', quote_settings: { validity_days: 15 } };
    const out = applyQuoteSettingsDefaults(cfg);
    expect(out).not.toBe(cfg);
    expect(out.quote_settings).toEqual({ validity_days: 15, deposit_pct: 0.4 });
    expect(cfg.quote_settings).toEqual({ validity_days: 15 });
    expect(out.version).toBe('4.0.0');
  });

  it('creates quote_settings when the whole object is absent, filling ONLY deposit_pct', () => {
    const out = applyQuoteSettingsDefaults({ version: '4.0.0' });
    expect(out.quote_settings).toEqual({ deposit_pct: 0.4 });
  });

  it('is idempotent', () => {
    const once = applyQuoteSettingsDefaults({ version: '4.0.0' });
    expect(applyQuoteSettingsDefaults(once)).toBe(once);
  });

  it('leaves a non-object input untouched', () => {
    expect(applyQuoteSettingsDefaults(null)).toBeNull();
    expect(applyQuoteSettingsDefaults(undefined)).toBeUndefined();
  });

  it('does not repair an out-of-range value — that is the validator\'s job', () => {
    const bad = { quote_settings: { deposit_pct: 1.5 } };
    expect(applyQuoteSettingsDefaults(bad)).toBe(bad);
  });
});
