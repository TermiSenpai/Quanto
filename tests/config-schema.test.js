// ============================================================
// Tests · lib/config-schema.js (strict validator) — v3
// ============================================================
// Goal: every "broken config" we worry about must produce a
// message that names the offending field. Pure module — no fs,
// no Electron mocks needed.
// ============================================================

import { describe, test, expect } from 'vitest';
import {
  collectConfigErrors,
  validateConfigSchema,
  REQUIRED_PARAMETERS
} from '../lib/config-schema.js';
import { buildDefaultConfig } from '../config.default.js';

function makeConfig() {
  return buildDefaultConfig({ modified_by: 'tester' });
}

describe('happy path', () => {
  test('the default config validates without errors', () => {
    expect(collectConfigErrors(makeConfig())).toEqual([]);
    expect(() => validateConfigSchema(makeConfig())).not.toThrow();
  });
});

describe('top-level shape', () => {
  test.each([
    [null],
    [undefined],
    [42],
    ['string'],
    [[]]
  ])('rejects non-object input (%p)', (input) => {
    const errors = collectConfigErrors(input);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/objeto/);
  });

  test('missing version is reported', () => {
    const cfg = makeConfig();
    delete cfg.version;
    const errors = collectConfigErrors(cfg);
    expect(errors.join('\n')).toMatch(/version/);
  });

  test('a v2 config is rejected up front (must migrate first)', () => {
    const cfg = makeConfig();
    cfg.version = '2.0.0';
    const errors = collectConfigErrors(cfg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/v2/);
    expect(errors[0]).toMatch(/migr/i);
  });
});

describe('parameters', () => {
  test.each(REQUIRED_PARAMETERS)('reports when "parameters.%s" is missing', (key) => {
    const cfg = makeConfig();
    delete cfg.parameters[key];
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes(`parameters.${key}`))).toBe(true);
  });

  test('rejects negative parameters', () => {
    const cfg = makeConfig();
    cfg.parameters.vat = -0.05;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('parameters.vat'))).toBe(true);
  });

  test('rejects vat above 1 (e.g. someone wrote 21 instead of 0.21)', () => {
    const cfg = makeConfig();
    cfg.parameters.vat = 21;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /vat/.test(e) && /entre 0 y 1/.test(e))).toBe(true);
  });

  test('rejects non-numeric parameter', () => {
    const cfg = makeConfig();
    cfg.parameters.labor_eur_hour = 'fifteen';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('labor_eur_hour') && /número/.test(e))).toBe(true);
  });

  test('accepts a config without optional extras', () => {
    const cfg = makeConfig();
    delete cfg.parameters.extra_name_eur;
    delete cfg.parameters.extra_short_sleeve_eur;
    delete cfg.parameters.extra_long_sleeve_eur;
    expect(collectConfigErrors(cfg)).toEqual([]);
  });
});

describe('Roly models', () => {
  test('reports missing required model', () => {
    const cfg = makeConfig();
    delete cfg.roly_models.URBAN;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('roly_models.URBAN'))).toBe(true);
  });

  test('rejects negative price', () => {
    const cfg = makeConfig();
    cfg.roly_models.BEAGLE.price = -1;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('BEAGLE.price') && /negativo/.test(e))).toBe(true);
  });

  test('rejects non-string ref', () => {
    const cfg = makeConfig();
    cfg.roly_models.BEAGLE.ref = 12345;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('BEAGLE.ref'))).toBe(true);
  });
});

describe('tiers', () => {
  test('rejects empty array', () => {
    const cfg = makeConfig();
    cfg.tiers = [];
    const errors = collectConfigErrors(cfg);
    expect(errors[0]).toMatch(/tiers/);
  });

  test('rejects overlapping tiers (descending order)', () => {
    const cfg = makeConfig();
    cfg.tiers = [
      { id: 'T1', label: '50-99', from: 50,  to: 99,   time_reduction: 0   },
      { id: 'T2', label: '10-49', from: 10,  to: 49,   time_reduction: 0.1 },
      { id: 'T3', label: '100+',  from: 100, to: null, time_reduction: 0.2 }
    ];
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /solapa/.test(e))).toBe(true);
  });

  test('rejects a tier where to < from', () => {
    const cfg = makeConfig();
    cfg.tiers[0].to = 5; // from=10 > to=5
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /menor/.test(e))).toBe(true);
  });

  test('rejects a tier without id', () => {
    const cfg = makeConfig();
    cfg.tiers[0].id = '';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /id/.test(e))).toBe(true);
  });

  test('rejects time_reduction >= 1', () => {
    const cfg = makeConfig();
    cfg.tiers[1].time_reduction = 1.0;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /time_reduction/.test(e))).toBe(true);
  });
});

describe('packs', () => {
  test('rejects an empty packs section', () => {
    const cfg = makeConfig();
    cfg.packs = {};
    const errors = collectConfigErrors(cfg);
    expect(errors[0]).toMatch(/packs/);
  });

  test('reports missing price entry per tier on crew pack', () => {
    const cfg = makeConfig();
    delete cfg.packs.crew_full.prices.without_hood.two_sides.T1;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /crew_full.prices.without_hood.two_sides.T1/.test(e))).toBe(true);
  });

  test('single pack with unknown model is flagged', () => {
    const cfg = makeConfig();
    cfg.packs.tshirts_only.model = 'UFO';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /UFO/.test(e))).toBe(true);
  });

  test('mixed pack with broken reference_packs', () => {
    const cfg = makeConfig();
    cfg.packs.hoodies_mixed.reference_packs.URBAN = 'no_existe';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /no_existe/.test(e))).toBe(true);
  });

  test('custom pack with broken model reference', () => {
    const cfg = makeConfig();
    cfg.packs.custom.reference_models.BEAGLE = 'fake_pack';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /fake_pack/.test(e))).toBe(true);
  });

  test('unknown pack type is flagged', () => {
    const cfg = makeConfig();
    cfg.packs.tshirts_only.type = 'banana';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /banana/.test(e))).toBe(true);
  });
});

describe('admin', () => {
  test('rejects when admin.password is missing and no has_password flag', () => {
    const cfg = makeConfig();
    cfg.admin = {};
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /admin.password/.test(e))).toBe(true);
  });

  test('accepts the renderer-side shape (has_password=true, no raw password)', () => {
    const cfg = makeConfig();
    cfg.admin = { has_password: true };
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /admin.password/.test(e))).toBe(false);
  });
});

describe('validateConfigSchema (throwing wrapper)', () => {
  test('throws with all errors joined when invalid', () => {
    const cfg = makeConfig();
    delete cfg.parameters.vat;
    delete cfg.parameters.labor_eur_hour;
    expect(() => validateConfigSchema(cfg)).toThrow(/vat/);
    expect(() => validateConfigSchema(cfg)).toThrow(/labor_eur_hour/);
  });

  test('does not throw on the default config', () => {
    expect(() => validateConfigSchema(makeConfig())).not.toThrow();
  });
});
