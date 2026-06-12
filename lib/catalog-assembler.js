// ============================================================
// PackPrice · Catalog assembler (cfg v4 ↔ normalized entities)
// ============================================================
// Bidirectional bridge between the v4 config object (the shape the
// calc engine and validateConfigSchema consume) and the flat entity
// rows stored in Cloudflare D1 (planes/v5-cloud-sync.md §3). It is
// also the local↔cloud migrator. Pure module: no I/O, no Electron.
//
// Source of truth for the v4 shape: config.default.js
// (buildDefaultConfig). The round-trip contract is exact:
//   assemble(disassemble(cfg), meta) deep-equals cfg minus `admin`.
//
// Real-shape note vs the original plan: `option.maps_product` is an
// object that, besides the value-id → product-id mapping, carries a
// `component` key naming the component the mapping swaps. The
// pack_options row therefore keeps both a `maps_product` 0/1 flag
// and a `maps_component` (TEXT, nullable) with that target.
// ============================================================

'use strict';

function jsType(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

/**
 * Explodes a v4 config object into flat entity row arrays, one per
 * normalized table. Never emits the `admin` section nor the
 * version/updated_at/modified_by metadata (those live in catalog_meta).
 *
 * @param {object} cfg - validated v4 config object
 * @returns {object} entity row arrays keyed by table name
 */
function disassemble(cfg) {
  const parameters = Object.entries(cfg.parameters).map(([key, value]) => ({
    key, value: String(value), type: jsType(value)
  }));

  const suppliers = Object.entries(cfg.suppliers).map(([id, s]) => ({
    id, name: s.name, web: s.web ?? null, notes: s.notes ?? null
  }));

  const products = [];
  const product_suppliers = [];
  const product_prices = [];
  for (const [id, p] of Object.entries(cfg.products)) {
    products.push({
      id, name: p.name, category: p.category,
      extra_cost_3xl: p.extra_cost_3xl, target_margin: p.target_margin ?? null
    });
    for (const link of p.suppliers) {
      product_suppliers.push({
        product_id: id, supplier_id: link.supplier, ref: link.ref ?? null,
        price: link.price, min_order: link.min_order ?? null,
        is_default: link.is_default ? 1 : 0
      });
    }
    for (const [sides, byTier] of Object.entries(p.prices)) {
      for (const [tier, price] of Object.entries(byTier)) {
        product_prices.push({ product_id: id, sides, tier, price });
      }
    }
  }

  const tiers = cfg.tiers.map((t, i) => ({
    id: t.id, label: t.label, from_qty: t.from, to_qty: t.to ?? null,
    time_reduction: t.time_reduction, position: i
  }));

  const addons = Object.entries(cfg.addons).map(([id, a]) => ({
    id, label: a.label, price: a.price, vat_included: a.vat_included ? 1 : 0,
    cost: a.cost, applies_to: JSON.stringify(a.applies_to)
  }));

  const packs = [];
  const pack_options = [];
  const pack_option_values = [];
  const pack_components = [];
  const bundle_prices = [];
  for (const [id, pk] of Object.entries(cfg.packs)) {
    packs.push({
      id, name: pk.name, description: pk.description ?? null, icon: pk.icon ?? null,
      pricing_mode: pk.pricing_mode, min_total: pk.min_total,
      target_margin: pk.target_margin ?? null,
      free_components: pk.free_components ? 1 : 0
    });
    (pk.options || []).forEach((option, oi) => {
      const mapping = option.maps_product || null;
      pack_options.push({
        pack_id: id, option_id: option.id, label: option.label,
        maps_product: mapping ? 1 : 0,
        maps_component: mapping ? (mapping.component ?? null) : null,
        position: oi
      });
      (option.values || []).forEach((value, vi) => {
        pack_option_values.push({
          pack_id: id, option_id: option.id, value_id: value.id,
          label: value.label, sides: value.sides ?? null,
          maps_to_product: mapping ? (mapping[value.id] ?? null) : null,
          position: vi
        });
      });
    });
    (pk.components || []).forEach((component, ci) => {
      pack_components.push({
        pack_id: id, component_id: component.id, label: component.label,
        product_id: component.product ?? null,
        qty_per_pack: component.qty_per_pack ?? null, position: ci
      });
    });
    for (const [combo_key, byTier] of Object.entries(pk.bundle_prices || {})) {
      for (const [tier, price] of Object.entries(byTier)) {
        bundle_prices.push({ pack_id: id, combo_key, tier, price });
      }
    }
  }

  const company = [
    ...Object.entries(cfg.company).map(([k, v]) => ({ key: 'company.' + k, value: JSON.stringify(v) })),
    ...Object.entries(cfg.quote_settings).map(([k, v]) => ({ key: 'quote_settings.' + k, value: JSON.stringify(v) }))
  ];

  return {
    parameters, suppliers, products, product_suppliers, product_prices,
    tiers, addons, packs, pack_options, pack_option_values, pack_components,
    bundle_prices, company
  };
}

module.exports = { disassemble };
