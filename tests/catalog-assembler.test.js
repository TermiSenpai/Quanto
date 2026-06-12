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
});
