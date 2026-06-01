// ============================================================
// Tests · lib/config-schema.js (strict validator) — v4
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

  test('a v3 config is rejected up front (must migrate first)', () => {
    const cfg = makeConfig();
    cfg.version = '3.0.0';
    const errors = collectConfigErrors(cfg);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/v3/);
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

  test('default_target_margin and price_rounding_ending are required', () => {
    expect(REQUIRED_PARAMETERS).toContain('default_target_margin');
    expect(REQUIRED_PARAMETERS).toContain('price_rounding_ending');
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

  test('rejects price_rounding_ending >= 1', () => {
    const cfg = makeConfig();
    cfg.parameters.price_rounding_ending = 1.5;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /price_rounding_ending/.test(e))).toBe(true);
  });
});

describe('suppliers', () => {
  test('rejects a missing suppliers section', () => {
    const cfg = makeConfig();
    delete cfg.suppliers;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /suppliers/.test(e))).toBe(true);
  });

  test('rejects a supplier without name', () => {
    const cfg = makeConfig();
    cfg.suppliers.ROLY.name = '';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /suppliers.ROLY.name/.test(e))).toBe(true);
  });
});

describe('products', () => {
  test('reports a product without suppliers', () => {
    const cfg = makeConfig();
    cfg.products.BEAGLE.suppliers = [];
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /products.BEAGLE.suppliers/.test(e))).toBe(true);
  });

  test('requires exactly one default supplier', () => {
    const cfg = makeConfig();
    cfg.products.BEAGLE.suppliers[0].is_default = false;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /is_default/.test(e))).toBe(true);
  });

  test('rejects more than one default supplier', () => {
    const cfg = makeConfig();
    cfg.products.BEAGLE.suppliers.push({ supplier: 'ROLY', ref: 'Z', price: 2, min_order: 0, is_default: true });
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /is_default/.test(e))).toBe(true);
  });

  test('rejects a non-finite supplier price', () => {
    const cfg = makeConfig();
    cfg.products.BEAGLE.suppliers[0].price = 'free';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /price/.test(e))).toBe(true);
  });

  test('reports a missing price entry per tier', () => {
    const cfg = makeConfig();
    delete cfg.products.BEAGLE.prices.two_sides.T1;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /products.BEAGLE.prices.two_sides.T1/.test(e))).toBe(true);
  });

  test('rejects a supplier referencing an unknown provider', () => {
    const cfg = makeConfig();
    cfg.products.BEAGLE.suppliers[0].supplier = 'GHOST';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /GHOST/.test(e))).toBe(true);
  });
});

describe('addons', () => {
  test('rejects an addon without label', () => {
    const cfg = makeConfig();
    cfg.addons.name.label = '';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /addons.name.label/.test(e))).toBe(true);
  });

  test('rejects a negative addon price', () => {
    const cfg = makeConfig();
    cfg.addons.name.price = -1;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /addons.name.price/.test(e))).toBe(true);
  });

  test('rejects applies_to that is not an array', () => {
    const cfg = makeConfig();
    cfg.addons.name.applies_to = 'all';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /applies_to/.test(e))).toBe(true);
  });
});

describe('tiers', () => {
  test('rejects empty array', () => {
    const cfg = makeConfig();
    cfg.tiers = [];
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /tiers/.test(e))).toBe(true);
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
    expect(errors.some(e => /packs/.test(e))).toBe(true);
  });

  test('rejects an invalid pricing_mode', () => {
    const cfg = makeConfig();
    cfg.packs.tshirts_only.pricing_mode = 'banana';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /banana/.test(e))).toBe(true);
  });

  test('reports a bundle price missing for a combo × tier', () => {
    const cfg = makeConfig();
    delete cfg.packs.crew_full.bundle_prices['without_hood|two_sides'].T1;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /crew_full.bundle_prices.without_hood\|two_sides.T1/.test(e))).toBe(true);
  });

  test('reports a missing bundle combo entirely', () => {
    const cfg = makeConfig();
    delete cfg.packs.crew_full.bundle_prices['with_hood|one_side'];
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /with_hood\|one_side/.test(e))).toBe(true);
  });

  test('components pack referencing an unknown product is flagged', () => {
    const cfg = makeConfig();
    cfg.packs.tshirts_only.components[0].product = 'UFO';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /UFO/.test(e))).toBe(true);
  });

  test('maps_product pointing to an unknown product is flagged', () => {
    const cfg = makeConfig();
    cfg.packs.crew_full.options[0].maps_product.with_hood = 'NOPE';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /NOPE/.test(e))).toBe(true);
  });

  test('missing min_total is flagged', () => {
    const cfg = makeConfig();
    delete cfg.packs.tshirts_only.min_total;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /min_total/.test(e))).toBe(true);
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
