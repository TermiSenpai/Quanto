// ============================================================
// Tests · lib/catalog-assembler.js
// ============================================================
// The source of truth for the v4 shape is config.default.js
// (buildDefaultConfig). The round-trip test is the arbiter: the
// assembler must reproduce the default catalog exactly (minus admin).
// ============================================================
import { describe, test, expect } from 'vitest';
import { disassemble, assemble } from '../lib/catalog-assembler.js';
import { buildDefaultConfig } from '../config.default.js';
import { collectConfigErrors, validateConfigSchema } from '../lib/config-schema.js';

describe('disassemble', () => {
  const cfg = buildDefaultConfig();
  const e = disassemble(cfg);

  test('parameters become typed key-value rows', () => {
    const vat = e.parameters.find((p) => p.key === 'vat');
    expect(vat).toBeTruthy();
    expect(vat.type).toBe('number');
    expect(Number(vat.value)).toBe(cfg.parameters.vat);
  });

  test('every product produces its rows, supplier links and price cells', () => {
    expect(e.products.map((p) => p.id).sort()).toEqual(Object.keys(cfg.products).sort());
    const anyProductId = Object.keys(cfg.products)[0];
    const product = cfg.products[anyProductId];
    const priceRows = e.product_prices.filter((r) => r.product_id === anyProductId);
    const expectedCells = Object.values(product.prices).reduce((n, tiers) => n + Object.keys(tiers).length, 0);
    expect(priceRows).toHaveLength(expectedCells);
    const links = e.product_suppliers.filter((r) => r.product_id === anyProductId);
    expect(links).toHaveLength(product.suppliers.length);
  });

  test('tiers keep their order via position', () => {
    expect(e.tiers.map((t) => t.position)).toEqual(cfg.tiers.map((_, i) => i));
    expect(e.tiers[0].from_qty).toBe(cfg.tiers[0].from);
  });

  test('packs expand into options, values, components and bundle prices', () => {
    expect(e.packs.map((p) => p.id).sort()).toEqual(Object.keys(cfg.packs).sort());
    const bundleId = Object.keys(cfg.packs).find((id) => cfg.packs[id].pricing_mode === 'bundle');
    const bundle = cfg.packs[bundleId];
    const cells = e.bundle_prices.filter((r) => r.pack_id === bundleId);
    const expected = Object.values(bundle.bundle_prices).reduce((n, tiers) => n + Object.keys(tiers).length, 0);
    expect(cells).toHaveLength(expected);
  });

  test('company and quote_settings rows are JSON-encoded values', () => {
    const name = e.company.find((r) => r.key === 'company.name');
    expect(JSON.parse(name.value)).toBe(cfg.company.name);
    const validity = e.company.find((r) => r.key === 'quote_settings.validity_days');
    expect(JSON.parse(validity.value)).toBe(cfg.quote_settings.validity_days);
  });

  test('never emits the admin section', () => {
    const json = JSON.stringify(e);
    expect(json).not.toContain('password');
  });
});

describe('assemble', () => {
  const cfg = buildDefaultConfig();
  const META = { version: cfg.version, updated_at: cfg.updated_at, modified_by: cfg.modified_by };

  test('rebuilds typed parameters', () => {
    const rebuilt = assemble(disassemble(cfg), META);
    expect(rebuilt.parameters.vat).toBe(cfg.parameters.vat);
    expect(typeof rebuilt.parameters.vat).toBe('number');
  });

  test('restores option/value/component ordering from position', () => {
    const entities = disassemble(cfg);
    const packId = Object.keys(cfg.packs)[0];
    const shuffled = {
      ...entities,
      pack_option_values: [...entities.pack_option_values].reverse(),
      pack_options: [...entities.pack_options].reverse(),
      pack_components: [...entities.pack_components].reverse()
    };
    const rebuilt = assemble(shuffled, META);
    expect(rebuilt.packs[packId].options.map((o) => o.id))
      .toEqual(cfg.packs[packId].options.map((o) => o.id));
  });

  test('decodes company and quote_settings JSON values', () => {
    const rebuilt = assemble(disassemble(cfg), META);
    expect(rebuilt.company).toEqual(cfg.company);
    expect(rebuilt.quote_settings).toEqual(cfg.quote_settings);
  });

  test('rejects a price row that references a non-existent product', () => {
    const entities = disassemble(cfg);
    entities.product_prices.push({ product_id: 'ghost', sides: '1', tier: 'T1', price: 9 });
    expect(() => assemble(entities, META)).toThrow(/inexistente/);
  });

  test('rejects a company row with invalid JSON', () => {
    const entities = disassemble(cfg);
    entities.company.push({ key: 'company.broken', value: '{not json' });
    expect(() => assemble(entities, META)).toThrow(/JSON inválido/);
  });

  test('assemble omits optional keys for NULL row values', () => {
    // Hand-built minimal rows: every nullable column is NULL. assemble
    // does not validate the schema, so the fixture only needs to be
    // structurally consistent, not pass validateConfigSchema.
    const entities = {
      parameters: [],
      suppliers: [{ id: 'sup1', name: 'Proveedor', web: null, notes: null }],
      products: [{ id: 'prod1', name: 'Camiseta', category: 'garment', extra_cost_3xl: 2, target_margin: null }],
      product_suppliers: [{ product_id: 'prod1', supplier_id: 'sup1', ref: null, price: 3, min_order: null, is_default: 1 }],
      product_prices: [{ product_id: 'prod1', sides: '1', tier: 'T1', price: 10 }],
      tiers: [{ id: 'T1', label: '10+', from_qty: 10, to_qty: null, time_reduction: 0, position: 0 }],
      addons: [],
      packs: [{
        id: 'pack1', name: 'Pack', description: null, icon: null,
        pricing_mode: 'per_unit', min_total: 0, target_margin: null, free_components: 0
      }],
      pack_options: [{ pack_id: 'pack1', option_id: 'opt1', label: 'Opción', maps_product: 0, maps_component: null, position: 0 }],
      pack_option_values: [{ pack_id: 'pack1', option_id: 'opt1', value_id: 'v1', label: 'Valor', sides: null, maps_to_product: null, position: 0 }],
      pack_components: [{ pack_id: 'pack1', component_id: 'c1', label: 'Comp', product_id: null, qty_per_pack: null, position: 0 }],
      bundle_prices: [],
      company: []
    };
    const rebuilt = assemble(entities, META);

    expect(Object.keys(rebuilt.suppliers.sup1)).toEqual(['name']);

    const product = rebuilt.products.prod1;
    expect(product).not.toHaveProperty('target_margin');
    expect(Object.keys(product.suppliers[0])).toEqual(['supplier', 'price', 'is_default']);

    // `to` is not optional in the v4 tier shape: a NULL to_qty stays an
    // explicit `to: null` (open-ended tier).
    expect(rebuilt.tiers[0].to).toBeNull();

    const pack = rebuilt.packs.pack1;
    expect(pack).not.toHaveProperty('description');
    expect(pack).not.toHaveProperty('icon');
    expect(pack).not.toHaveProperty('target_margin');
    expect(pack).not.toHaveProperty('free_components');
    expect(pack).not.toHaveProperty('bundle_prices');

    const option = pack.options[0];
    expect(option).not.toHaveProperty('maps_product');
    expect(Object.keys(option.values[0])).toEqual(['id', 'label']);

    expect(Object.keys(pack.components[0])).toEqual(['id', 'label']);
  });
});

describe('round-trip', () => {
  test('assemble(disassemble(cfg)) reproduces the default catalog exactly (minus admin)', () => {
    const cfg = buildDefaultConfig();
    const expected = { ...cfg };
    delete expected.admin;
    const rebuilt = assemble(disassemble(cfg), {
      version: cfg.version, updated_at: cfg.updated_at, modified_by: cfg.modified_by
    });
    expect(rebuilt).toEqual(expected);
  });

  test('the rebuilt config passes the strict v4 validator', () => {
    const cfg = buildDefaultConfig();
    const rebuilt = assemble(disassemble(cfg), {
      version: cfg.version, updated_at: cfg.updated_at, modified_by: cfg.modified_by
    });
    rebuilt.admin = cfg.admin;
    // collectConfigErrors returns the full list (empty when valid);
    // validateConfigSchema throws on any error and returns undefined.
    expect(collectConfigErrors(rebuilt)).toEqual([]);
    expect(() => validateConfigSchema(rebuilt)).not.toThrow();
  });
});
