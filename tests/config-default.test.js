// ============================================================
// Default schema tests (config.default.js) — v4
// ============================================================
// Guards against refactors that silently drop structural keys the
// rest of the app depends on.
// ============================================================
import { describe, test, expect } from 'vitest';
import { buildDefaultConfig, VERSION, ADMIN_PASSWORD_DEFAULT } from '../config.default.js';

describe('buildDefaultConfig', () => {
  test('returns the version and meta fields', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.version).toBe(VERSION);
    expect(VERSION).toMatch(/^4\./);
    expect(typeof cfg.updated_at).toBe('string');
    expect(typeof cfg.modified_by).toBe('string');
  });

  test('includes the default admin password', () => {
    expect(buildDefaultConfig().admin.password).toBe(ADMIN_PASSWORD_DEFAULT);
  });

  test('has every top-level v4 section', () => {
    const cfg = buildDefaultConfig();
    for (const section of [
      'parameters', 'suppliers', 'products', 'tiers',
      'addons', 'packs', 'company', 'quote_settings'
    ]) {
      expect(cfg[section]).toBeDefined();
    }
  });

  test('contains the expected packs', () => {
    const cfg = buildDefaultConfig();
    for (const id of [
      'crew_full',
      'tshirts_only',
      'classic_only',
      'urban_only',
      'hoodies_mixed',
      'custom'
    ]) {
      expect(cfg.packs[id]).toBeDefined();
    }
  });

  test('contains the expected products with a default supplier', () => {
    const cfg = buildDefaultConfig();
    for (const id of ['BEAGLE', 'CLASICA', 'URBAN']) {
      const p = cfg.products[id];
      expect(p).toBeDefined();
      expect(typeof p.name).toBe('string');
      expect(typeof p.category).toBe('string');
      const def = p.suppliers.find(s => s.is_default);
      expect(def).toBeDefined();
      expect(typeof def.price).toBe('number');
      expect(p.prices.two_sides).toBeDefined();
      expect(p.prices.one_side).toBeDefined();
    }
  });

  test('suppliers registry has Roly', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.suppliers.ROLY).toBeDefined();
    expect(cfg.suppliers.ROLY.name).toBe('Roly');
  });

  test('addons declare label, price and applies_to', () => {
    const cfg = buildDefaultConfig();
    for (const id of ['name', 'short_sleeve', 'long_sleeve']) {
      const a = cfg.addons[id];
      expect(a).toBeDefined();
      expect(typeof a.label).toBe('string');
      expect(typeof a.price).toBe('number');
      expect(Array.isArray(a.applies_to)).toBe(true);
    }
  });

  test('four tiers T1..T4 with T4 open-ended', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.tiers).toHaveLength(4);
    expect(cfg.tiers.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(cfg.tiers[3].to).toBeNull();
  });

  test('parameters include all critical numeric fields (v4)', () => {
    const cfg = buildDefaultConfig();
    const required = [
      'labor_eur_hour', 'vat', 'waste_pct', 'overhead_eur_garment',
      'surcharge_4xl_eur', 'surcharge_5xl_eur',
      'roly_shipping_eur_bundle', 'garments_per_bundle',
      'dtf_eur_meter', 'dtf_meters_two_sides', 'dtf_meters_one_side',
      'pressing_eur_side', 'minutes_two_sides_base', 'minutes_one_side_base',
      'default_target_margin', 'price_rounding_ending'
    ];
    for (const k of required) {
      expect(typeof cfg.parameters[k]).toBe('number');
    }
  });

  test('v3 parameters that v4 removed are gone', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.parameters.buffer_3xl_eur_pack).toBeUndefined();
    expect(cfg.parameters.extra_name_eur).toBeUndefined();
    expect(cfg.parameters.extra_short_sleeve_eur).toBeUndefined();
    expect(cfg.parameters.extra_long_sleeve_eur).toBeUndefined();
  });

  test('each call returns an independent copy (mutations do not leak)', () => {
    const a = buildDefaultConfig();
    const b = buildDefaultConfig();
    a.parameters.vat = 0.99;
    expect(b.parameters.vat).not.toBe(0.99);
  });

  test('respects meta.modified_by', () => {
    expect(buildDefaultConfig({ modified_by: 'Alberto' }).modified_by).toBe('Alberto');
  });
});
