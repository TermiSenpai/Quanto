import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEPS,
  parametersComplete,
  stepErrors,
  wizardReady
} from '../renderer/wizard-validation.js';

// A blank config like the one `config:empty` returns: every parameter key
// present but null, all collections empty. (A representative subset of the
// real parameter keys is enough — parametersComplete checks ALL keys present.)
function emptyCfg() {
  return {
    parameters: { labor_eur_hour: null, vat: null, dtf_eur_meter: null, price_rounding_ending: null },
    tiers: [], suppliers: {}, products: {}, packs: {}, addons: {}, company: { name: '' }
  };
}
function withFullParameters(cfg) {
  for (const k of Object.keys(cfg.parameters)) cfg.parameters[k] = 1;
  return cfg;
}

describe('wizard-validation', () => {
  it('lists the steps in dependency order', () => {
    expect(WIZARD_STEPS.map(s => s.id)).toEqual([
      'parameters', 'tiers', 'suppliers', 'products', 'packs', 'addons', 'company'
    ]);
  });

  it('parametersComplete is false until every parameter is a finite number >= 0', () => {
    const cfg = emptyCfg();
    expect(parametersComplete(cfg)).toBe(false);
    withFullParameters(cfg);
    expect(parametersComplete(cfg)).toBe(true);
    cfg.parameters.labor_eur_hour = null;
    expect(parametersComplete(cfg)).toBe(false);
  });

  it('rejects negative or non-numeric parameters', () => {
    const cfg = withFullParameters(emptyCfg());
    cfg.parameters.dtf_eur_meter = -1;
    expect(parametersComplete(cfg)).toBe(false);
  });

  it('treats an empty parameters object as incomplete', () => {
    expect(parametersComplete({ parameters: {} })).toBe(false);
  });

  it('stepErrors(parameters) reports the missing costs', () => {
    const errs = stepErrors(emptyCfg(), 'parameters');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some(e => /coste/i.test(e))).toBe(true);
  });

  it('stepErrors require at least one item for tiers/suppliers/products/packs', () => {
    const cfg = emptyCfg();
    expect(stepErrors(cfg, 'tiers')).toContain('Añade al menos un tramo.');
    expect(stepErrors(cfg, 'suppliers')).toContain('Añade al menos un proveedor.');
    expect(stepErrors(cfg, 'products')).toContain('Añade al menos un producto.');
    expect(stepErrors(cfg, 'packs')).toContain('Añade al menos un pack.');
  });

  it('addons and company steps have no hard minimums', () => {
    const cfg = emptyCfg();
    expect(stepErrors(cfg, 'addons')).toEqual([]);
    expect(stepErrors(cfg, 'company')).toEqual([]);
  });

  it('wizardReady is true only when every step minimum is met', () => {
    const cfg = withFullParameters(emptyCfg());
    expect(wizardReady(cfg)).toBe(false);
    cfg.tiers = [{ id: 'T1' }];        // count-only gate; deep validity is validateConfigSchema's job
    cfg.suppliers = { SUP: {} };
    cfg.products = { P: {} };
    expect(wizardReady(cfg)).toBe(false);
    cfg.packs = { k: {} };
    expect(wizardReady(cfg)).toBe(true);
  });
});
