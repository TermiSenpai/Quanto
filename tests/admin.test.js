// ============================================================
// Admin editor tests (renderer/admin.js) — v4 catalog builder
// ============================================================
// The render functions are pure (return HTML strings) and the
// mutation helpers mutate a `cfg` object, so we can test both in
// Node without a DOM. Where practical we assert that the mutated
// config still passes the strict v4 schema validator.
//
// Confirmations: admin.js guards window.confirm, returning true
// when `window` is absent (Node), so destructive actions proceed
// without stubbing.
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  renderAdminParameters,
  renderAdminSuppliers,
  renderAdminProducts,
  renderAdminAddons,
  renderAdminTiers,
  renderAdminPacks,
  renderAdminTabContent,
  updateConfigFromInput,
  executeAdminAction
} from '../renderer/admin.js';
import { buildDefaultConfig } from '../config.default.js';
import { collectConfigErrors } from '../lib/config-schema.js';

function freshCfg() {
  return buildDefaultConfig({ modified_by: 'tester' });
}

/** Fake input/select/checkbox for updateConfigFromInput. */
function fakeInput(cfgPath, type, valueOrChecked) {
  if (type === 'checkbox') {
    return { dataset: { cfgPath }, type, checked: valueOrChecked };
  }
  return { dataset: { cfgPath }, type, value: String(valueOrChecked) };
}

function expectValid(cfg) {
  const errors = collectConfigErrors(cfg);
  expect(errors).toEqual([]);
}

// ============================================================
// Parameters editor (v4 keys)
// ============================================================
describe('renderAdminParameters', () => {
  const html = renderAdminParameters(freshCfg());

  test('renders the new v4 param keys', () => {
    expect(html).toContain('data-cfg-path="parameters.default_target_margin"');
    expect(html).toContain('data-cfg-path="parameters.price_rounding_ending"');
    expect(html).toContain('data-cfg-path="parameters.vat"');
    expect(html).toContain('data-cfg-path="parameters.surcharge_4xl_eur"');
  });

  test('does NOT render the removed v3 param keys', () => {
    expect(html).not.toContain('buffer_3xl_eur_pack');
    expect(html).not.toContain('extra_name_eur');
    expect(html).not.toContain('extra_short_sleeve_eur');
    expect(html).not.toContain('extra_long_sleeve_eur');
  });

  test('no longer shows the "Extras opcionales" group', () => {
    expect(html).not.toContain('Extras opcionales');
  });
});

// ============================================================
// updateConfigFromInput
// ============================================================
describe('updateConfigFromInput', () => {
  test('writes a number to the right data-cfg-path', () => {
    const cfg = freshCfg();
    updateConfigFromInput(cfg, fakeInput('parameters.vat', 'number', '0.10'));
    expect(cfg.parameters.vat).toBe(0.10);
  });

  test('empty number becomes null', () => {
    const cfg = freshCfg();
    updateConfigFromInput(cfg, fakeInput('parameters.surcharge_4xl_eur', 'number', ''));
    expect(cfg.parameters.surcharge_4xl_eur).toBeNull();
  });

  test('writes text verbatim into a nested path', () => {
    const cfg = freshCfg();
    updateConfigFromInput(cfg, fakeInput('products.BEAGLE.name', 'text', 'Camiseta Premium'));
    expect(cfg.products.BEAGLE.name).toBe('Camiseta Premium');
  });

  test('writes a checkbox boolean', () => {
    const cfg = freshCfg();
    updateConfigFromInput(cfg, fakeInput('addons.name.vat_included', 'checkbox', true));
    expect(cfg.addons.name.vat_included).toBe(true);
  });

  test('writes a select value into a supplier sub-path', () => {
    const cfg = freshCfg();
    updateConfigFromInput(cfg, fakeInput('products.BEAGLE.suppliers.0.ref', 'text', 'NEW-REF'));
    expect(cfg.products.BEAGLE.suppliers[0].ref).toBe('NEW-REF');
  });

  test('invalid path does not throw or mutate', () => {
    const cfg = freshCfg();
    updateConfigFromInput(cfg, fakeInput('nope.also_nope.deep', 'text', 'x'));
    expect(cfg.nope).toBeUndefined();
  });
});

// ============================================================
// Suppliers
// ============================================================
describe('suppliers actions', () => {
  test('add-supplier creates a SUPPLIER_n and stays schema-valid', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-supplier' });
    expect(r.dirty).toBe(true);
    expect(cfg.suppliers.SUPPLIER_1).toBeDefined();
    expect(typeof cfg.suppliers.SUPPLIER_1.name).toBe('string');
    expectValid(cfg);
  });

  test('cannot remove a supplier in use by a product', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'remove-supplier', id: 'ROLY' });
    expect(r.error).toBeTruthy();
    expect(cfg.suppliers.ROLY).toBeDefined();
  });

  test('can remove an unused supplier', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-supplier' }); // SUPPLIER_1, unused
    const r = executeAdminAction(cfg, { action: 'remove-supplier', id: 'SUPPLIER_1' });
    expect(r.dirty).toBe(true);
    expect(cfg.suppliers.SUPPLIER_1).toBeUndefined();
    expectValid(cfg);
  });

  test('render disables remove for an in-use supplier', () => {
    const html = renderAdminSuppliers(freshCfg());
    expect(html).toMatch(/data-action="remove-supplier" data-id="ROLY"[\s\S]*?disabled/);
  });
});

// ============================================================
// Products
// ============================================================
describe('products actions', () => {
  test('add-product creates a valid product with one default supplier and full price tables', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-product' });
    expect(r.dirty).toBe(true);
    const id = 'PRODUCT_1';
    const p = cfg.products[id];
    expect(p).toBeDefined();
    expect(p.suppliers.filter(s => s.is_default)).toHaveLength(1);
    // price tables cover both faces for every current tier
    for (const face of ['two_sides', 'one_side']) {
      for (const t of cfg.tiers) {
        expect(p.prices[face][t.id]).toBe(0);
      }
    }
    expectValid(cfg);
  });

  test('cannot remove a product used by a pack component', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'remove-product', id: 'BEAGLE' });
    expect(r.error).toBeTruthy();
    expect(cfg.products.BEAGLE).toBeDefined();
  });

  test('cannot remove a product referenced via maps_product', () => {
    const cfg = freshCfg();
    // URBAN is only referenced by crew_full's maps_product (with_hood).
    const r = executeAdminAction(cfg, { action: 'remove-product', id: 'URBAN' });
    expect(r.error).toBeTruthy();
  });

  test('add and remove a product supplier; default is preserved', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-product-supplier', id: 'BEAGLE' });
    expect(cfg.products.BEAGLE.suppliers).toHaveLength(2);
    // Removing the default promotes another to default.
    executeAdminAction(cfg, { action: 'remove-product-supplier', id: 'BEAGLE', idx: '0' });
    expect(cfg.products.BEAGLE.suppliers).toHaveLength(1);
    expect(cfg.products.BEAGLE.suppliers.filter(s => s.is_default)).toHaveLength(1);
    expectValid(cfg);
  });

  test('set-default-supplier marks exactly one default', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-product-supplier', id: 'BEAGLE' });
    executeAdminAction(cfg, { action: 'set-default-supplier', id: 'BEAGLE', idx: '1' });
    const defs = cfg.products.BEAGLE.suppliers.filter(s => s.is_default);
    expect(defs).toHaveLength(1);
    expect(cfg.products.BEAGLE.suppliers[1].is_default).toBe(true);
    expectValid(cfg);
  });

  test('apply-recommended-product fills every cell with a positive price', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'apply-recommended-product', id: 'BEAGLE' });
    expect(r.dirty).toBe(true);
    for (const face of ['two_sides', 'one_side']) {
      for (const t of cfg.tiers) {
        expect(cfg.products.BEAGLE.prices[face][t.id]).toBeGreaterThan(0);
      }
    }
    expectValid(cfg);
  });

  test('render replaces "Modelos Roly" with product fields', () => {
    const html = renderAdminProducts(freshCfg());
    expect(html).toContain('data-cfg-path="products.BEAGLE.name"');
    expect(html).toContain('data-cfg-path="products.BEAGLE.extra_cost_3xl"');
    expect(html).toContain('Aplicar PVP recomendado');
    expect(html).not.toContain('roly_models');
  });
});

// ============================================================
// Addons
// ============================================================
describe('addons actions', () => {
  test('add-addon creates a valid addon', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-addon' });
    expect(r.dirty).toBe(true);
    expect(cfg.addons.addon_1).toBeDefined();
    expect(cfg.addons.addon_1.applies_to).toEqual(['*']);
    expectValid(cfg);
  });

  test('remove-addon deletes it', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'remove-addon', id: 'name' });
    expect(r.dirty).toBe(true);
    expect(cfg.addons.name).toBeUndefined();
    expectValid(cfg);
  });

  test('toggle-addon-category swaps between "*" and specific categories', () => {
    const cfg = freshCfg();
    // 'name' starts as ['*']; toggling a specific category drops '*'.
    executeAdminAction(cfg, { action: 'toggle-addon-category', id: 'name', cat: 'tshirt' });
    expect(cfg.addons.name.applies_to).toEqual(['tshirt']);
    // toggling it off again falls back to '*' (never empty).
    executeAdminAction(cfg, { action: 'toggle-addon-category', id: 'name', cat: 'tshirt' });
    expect(cfg.addons.name.applies_to).toEqual(['*']);
    expectValid(cfg);
  });
});

// ============================================================
// Tiers cascade (now over products.prices and bundle_prices)
// ============================================================
describe('tier add/remove cascade', () => {
  test('add-tier adds the new tier id to every product price face', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-tier' });
    const newId = 'T5';
    expect(cfg.tiers.map(t => t.id)).toContain(newId);
    for (const p of Object.values(cfg.products)) {
      expect(p.prices.two_sides[newId]).toBeDefined();
      expect(p.prices.one_side[newId]).toBeDefined();
    }
  });

  test('add-tier adds the new tier id to every bundle pack combo', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-tier' });
    const newId = 'T5';
    const crew = cfg.packs.crew_full;
    for (const combo of Object.keys(crew.bundle_prices)) {
      expect(crew.bundle_prices[combo][newId]).toBeDefined();
    }
    expectValid(cfg);
  });

  test('add-tier copies the previous last tier value (not zero) for products', () => {
    const cfg = freshCfg();
    const beforeT4 = cfg.products.BEAGLE.prices.two_sides.T4;
    executeAdminAction(cfg, { action: 'add-tier' });
    expect(cfg.products.BEAGLE.prices.two_sides.T5).toBe(beforeT4);
  });

  test('remove-tier removes that tier id from products and bundle packs', () => {
    const cfg = freshCfg();
    const idx = cfg.tiers.findIndex(t => t.id === 'T2');
    executeAdminAction(cfg, { action: 'remove-tier', idx: String(idx) });
    expect(cfg.tiers.map(t => t.id)).not.toContain('T2');
    expect(cfg.products.BEAGLE.prices.two_sides.T2).toBeUndefined();
    for (const combo of Object.keys(cfg.packs.crew_full.bundle_prices)) {
      expect(cfg.packs.crew_full.bundle_prices[combo].T2).toBeUndefined();
    }
    expectValid(cfg);
  });

  test('cannot remove the last remaining tier', () => {
    const cfg = freshCfg();
    cfg.tiers = [cfg.tiers[0]];
    const r = executeAdminAction(cfg, { action: 'remove-tier', idx: '0' });
    expect(r.error).toBeTruthy();
  });
});

// ============================================================
// Packs builder
// ============================================================
describe('packs builder actions', () => {
  test('add-pack creates a valid components pack', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-pack' });
    expect(r.dirty).toBe(true);
    expect(cfg.packs.pack_1).toBeDefined();
    expect(cfg.packs.pack_1.pricing_mode).toBe('components');
    expect(cfg.packs.pack_1.components.length).toBeGreaterThan(0);
    expectValid(cfg);
  });

  test('add-pack with zero products yields a schema-valid pack', () => {
    const cfg = freshCfg();
    // Strip the catalog so products is empty when the pack is created;
    // remove packs first so the products are no longer in use.
    for (const id of Object.keys(cfg.packs)) delete cfg.packs[id];
    for (const id of Object.keys(cfg.products)) delete cfg.products[id];
    expect(Object.keys(cfg.products).length).toBe(0);

    const r = executeAdminAction(cfg, { action: 'add-pack' });
    expect(r.dirty).toBe(true);
    expect(cfg.packs.pack_1).toBeDefined();
    // With no products the pack must be free_components so its empty
    // `components` array is schema-valid (it would fail otherwise).
    expect(cfg.packs.pack_1.components).toEqual([]);
    expect(cfg.packs.pack_1.free_components).toBe(true);

    // The schema also forbids an empty `products` section, so the pack
    // is exercised inside an otherwise-valid catalog: only the pack's
    // own validity is under test, and it passes with no errors.
    cfg.products.PROBE = {
      name: 'Probe', category: 'general', extra_cost_3xl: 0, target_margin: 0.35,
      suppliers: [{ supplier: Object.keys(cfg.suppliers)[0], ref: '', price: 1, min_order: 0, is_default: true }],
      prices: Object.fromEntries(
        ['two_sides', 'one_side'].map(face => [face, Object.fromEntries(cfg.tiers.map(t => [t.id, 1]))])
      )
    };
    expect(collectConfigErrors(cfg)).toEqual([]);
  });

  test('remove-pack deletes it', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'remove-pack', id: 'tshirts_only' });
    expect(r.dirty).toBe(true);
    expect(cfg.packs.tshirts_only).toBeUndefined();
    expectValid(cfg);
  });

  test('switching a new pack to bundle creates valid bundle_prices for every combo×tier', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-pack' });
    executeAdminAction(cfg, { action: 'set-pricing-mode', id: 'pack_1', value: 'bundle' });
    const pack = cfg.packs.pack_1;
    expect(pack.pricing_mode).toBe('bundle');
    // sides option has 2 values → 2 combos, each must cover every tier.
    for (const combo of ['one_side', 'two_sides']) {
      expect(pack.bundle_prices[combo]).toBeDefined();
      for (const t of cfg.tiers) {
        expect(pack.bundle_prices[combo][t.id]).toBeDefined();
      }
    }
    expectValid(cfg);
  });

  test('a new components pack with free_components is creatable and valid', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-pack' });
    const r = executeAdminAction(cfg, { action: 'toggle-free-components', id: 'pack_1', checked: true });
    expect(r.dirty).toBe(true);
    expect(cfg.packs.pack_1.free_components).toBe(true);
    expect(cfg.packs.pack_1.components).toEqual([]);
    expectValid(cfg);
  });

  test('free_components cannot be enabled on a bundle pack', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-pack' });
    executeAdminAction(cfg, { action: 'set-pricing-mode', id: 'pack_1', value: 'bundle' });
    const r = executeAdminAction(cfg, { action: 'toggle-free-components', id: 'pack_1', checked: true });
    expect(r.error).toBeTruthy();
    expect(cfg.packs.pack_1.free_components).not.toBe(true);
  });

  test('add/remove option and option-value keep bundle_prices coherent', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-pack' });
    executeAdminAction(cfg, { action: 'set-pricing-mode', id: 'pack_1', value: 'bundle' });
    // Add a new option (1 value) → combos unchanged in count (cartesian
    // with a single value), still valid.
    executeAdminAction(cfg, { action: 'add-pack-option', id: 'pack_1' });
    expectValid(cfg);
    // Add a value to the new option → combos double; ensureBundlePrices fills them.
    const newOptIdx = cfg.packs.pack_1.options.length - 1;
    executeAdminAction(cfg, { action: 'add-option-value', id: 'pack_1', idx: String(newOptIdx) });
    expectValid(cfg);
  });

  test('add-pack-component appends a component referencing a product', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-pack', });
    const before = cfg.packs.pack_1.components.length;
    executeAdminAction(cfg, { action: 'add-pack-component', id: 'pack_1' });
    expect(cfg.packs.pack_1.components.length).toBe(before + 1);
    expect(cfg.products[cfg.packs.pack_1.components.at(-1).product]).toBeDefined();
    expectValid(cfg);
  });

  test('apply-recommended-pack fills bundle prices as the sum of components', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'apply-recommended-pack', id: 'crew_full' });
    expect(r.dirty).toBe(true);
    const pack = cfg.packs.crew_full;
    for (const combo of Object.keys(pack.bundle_prices)) {
      for (const t of cfg.tiers) {
        expect(pack.bundle_prices[combo][t.id]).toBeGreaterThan(0);
      }
    }
    expectValid(cfg);
  });

  test('apply-recommended-pack rejects a components pack', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'apply-recommended-pack', id: 'tshirts_only' });
    expect(r.error).toBeTruthy();
  });
});

// ============================================================
// Router
// ============================================================
describe('router', () => {
  test('renderAdminTabContent routes every v4 tab', () => {
    const cfg = freshCfg();
    expect(renderAdminTabContent(cfg, 'parameters')).toContain('parameters.vat');
    expect(renderAdminTabContent(cfg, 'suppliers')).toContain('suppliers.ROLY.name');
    expect(renderAdminTabContent(cfg, 'products')).toContain('products.BEAGLE.name');
    expect(renderAdminTabContent(cfg, 'addons')).toContain('addons.name.label');
    expect(renderAdminTabContent(cfg, 'tiers')).toContain('tiers.0.label');
    expect(renderAdminTabContent(cfg, 'packs')).toContain('packs.crew_full.name');
    expect(renderAdminTabContent(cfg, 'unknown')).toBe('');
  });

  test('unknown action returns an error', () => {
    expect(executeAdminAction(freshCfg(), { action: 'nope' }).error).toBeTruthy();
  });
});

// ============================================================
// End-to-end: build a full catalog from scratch via actions only
// ============================================================
describe('full catalog build flow (acceptance)', () => {
  test('create supplier + product(2 suppliers, recommended prices) + addon + bundle + components packs → valid', () => {
    const cfg = freshCfg();

    // 1) A second supplier.
    executeAdminAction(cfg, { action: 'add-supplier' }); // SUPPLIER_1
    updateConfigFromInput(cfg, fakeInput('suppliers.SUPPLIER_1.name', 'text', 'Stanley'));

    // 2) A new product with two suppliers and recommended prices.
    executeAdminAction(cfg, { action: 'add-product' }); // PRODUCT_1
    updateConfigFromInput(cfg, fakeInput('products.PRODUCT_1.name', 'text', 'Polo'));
    updateConfigFromInput(cfg, fakeInput('products.PRODUCT_1.category', 'text', 'polo'));
    updateConfigFromInput(cfg, fakeInput('products.PRODUCT_1.suppliers.0.price', 'number', '3.50'));
    executeAdminAction(cfg, { action: 'add-product-supplier', id: 'PRODUCT_1' });
    updateConfigFromInput(cfg, fakeInput('products.PRODUCT_1.suppliers.1.supplier', 'text', 'SUPPLIER_1'));
    updateConfigFromInput(cfg, fakeInput('products.PRODUCT_1.suppliers.1.price', 'number', '3.10'));
    executeAdminAction(cfg, { action: 'apply-recommended-product', id: 'PRODUCT_1' });
    expect(cfg.products.PRODUCT_1.suppliers).toHaveLength(2);
    expect(cfg.products.PRODUCT_1.suppliers.filter(s => s.is_default)).toHaveLength(1);

    // 3) A new addon, applied to the new category.
    executeAdminAction(cfg, { action: 'add-addon' }); // addon_1
    updateConfigFromInput(cfg, fakeInput('addons.addon_1.label', 'text', 'Bolsillo'));
    updateConfigFromInput(cfg, fakeInput('addons.addon_1.price', 'number', '2'));
    executeAdminAction(cfg, { action: 'toggle-addon-category', id: 'addon_1', cat: 'polo' });

    // 4) A bundle pack from scratch.
    executeAdminAction(cfg, { action: 'add-pack' }); // pack_1
    executeAdminAction(cfg, { action: 'set-pricing-mode', id: 'pack_1', value: 'bundle' });
    executeAdminAction(cfg, { action: 'apply-recommended-pack', id: 'pack_1' });

    // 5) A components pack from scratch (free components).
    executeAdminAction(cfg, { action: 'add-pack' }); // pack_2
    executeAdminAction(cfg, { action: 'toggle-free-components', id: 'pack_2', checked: true });

    // The whole produced config must validate against the v4 schema.
    expectValid(cfg);
  });
});

// ============================================================
// No leftover v3 references in any rendered output
// ============================================================
describe('no v3 shape leaks in rendered HTML', () => {
  test('renders contain no v3 identifiers', () => {
    const cfg = freshCfg();
    const all = [
      renderAdminParameters(cfg),
      renderAdminSuppliers(cfg),
      renderAdminProducts(cfg),
      renderAdminAddons(cfg),
      renderAdminTiers(cfg),
      renderAdminPacks(cfg)
    ].join('\n');
    expect(all).not.toContain('roly_models');
    expect(all).not.toContain('pack.type');
    expect(all).not.toContain('reference_packs');
    expect(all).not.toContain('reference_models');
    expect(all).not.toContain('buffer_3xl_eur_pack');
    expect(all).not.toContain('extra_name_eur');
  });
});
