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
// Exactness is guaranteed for the default seed; for arbitrary configs
// the rebuilt object is semantically equivalent (explicit `false`
// flags and empty collections normalize away).
//
// Real-shape note vs the original plan: `option.maps_product` is an
// object that, besides the value-id → product-id mapping, carries a
// `component` key naming the component the mapping swaps. The
// pack_options row therefore keeps both a `maps_product` 0/1 flag
// and a `maps_component` (TEXT, nullable) with that target.
// ============================================================

'use strict';

// Non-scalars cannot reach here: validateConfigSchema constrains
// cfg.parameters values to number | boolean | string.
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

function castParameter(row) {
  if (row.type === 'number') return Number(row.value);
  if (row.type === 'boolean') return row.value === 'true';
  return row.value;
}

function byPosition(a, b) { return a.position - b.position; }

// Fail fast on a dangling foreign key (corrupt cache or D1 rows)
// instead of letting a bare TypeError surface later.
function requireParent(map, id, table) {
  const parent = map[id];
  if (!parent) {
    throw new Error('Catálogo dañado: la fila de ' + table + ' referencia un id inexistente: ' + id);
  }
  return parent;
}

function parseJsonValue(raw, table, context) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Catálogo dañado: valor JSON inválido en ' + table + ' (' + context + ')', { cause: err });
  }
}

/**
 * Rebuilds a v4 config object from flat entity row arrays. The
 * inverse of `disassemble`: optional keys are re-emitted only when
 * the row carries a value, so the output matches the file-mode shape
 * exactly. Row order does not matter; `position` restores ordering.
 *
 * @param {object} entities - entity row arrays (disassemble shape)
 * @param {object} meta - { version, updated_at, modified_by }
 * @returns {object} v4 config object (without the `admin` section)
 */
function assemble(entities, meta) {
  const parameters = {};
  for (const row of entities.parameters) parameters[row.key] = castParameter(row);

  const suppliers = {};
  for (const s of entities.suppliers) {
    suppliers[s.id] = { name: s.name, ...(s.web != null && { web: s.web }), ...(s.notes != null && { notes: s.notes }) };
  }

  const products = {};
  for (const p of entities.products) {
    products[p.id] = {
      name: p.name, category: p.category, extra_cost_3xl: p.extra_cost_3xl,
      ...(p.target_margin != null && { target_margin: p.target_margin }),
      suppliers: [], prices: {}
    };
  }
  for (const link of entities.product_suppliers) {
    requireParent(products, link.product_id, 'product_suppliers').suppliers.push({
      supplier: link.supplier_id, ...(link.ref != null && { ref: link.ref }),
      price: link.price, ...(link.min_order != null && { min_order: link.min_order }),
      is_default: link.is_default === 1
    });
  }
  for (const cell of entities.product_prices) {
    const prices = requireParent(products, cell.product_id, 'product_prices').prices;
    (prices[cell.sides] ||= {})[cell.tier] = cell.price;
  }

  const tiers = [...entities.tiers].sort(byPosition).map((t) => ({
    id: t.id, label: t.label, from: t.from_qty, to: t.to_qty ?? null,
    time_reduction: t.time_reduction
  }));

  const addons = {};
  for (const a of entities.addons) {
    addons[a.id] = {
      label: a.label, price: a.price, vat_included: a.vat_included === 1,
      cost: a.cost, applies_to: parseJsonValue(a.applies_to, 'addons', a.id)
    };
  }

  const packs = {};
  for (const pk of entities.packs) {
    packs[pk.id] = {
      name: pk.name,
      ...(pk.description != null && { description: pk.description }),
      ...(pk.icon != null && { icon: pk.icon }),
      pricing_mode: pk.pricing_mode, min_total: pk.min_total,
      ...(pk.target_margin != null && { target_margin: pk.target_margin }),
      ...(pk.free_components === 1 && { free_components: true }),
      options: [], components: []
    };
  }
  const optionsByPack = {};
  for (const o of [...entities.pack_options].sort(byPosition)) {
    const values = entities.pack_option_values
      .filter((v) => v.pack_id === o.pack_id && v.option_id === o.option_id)
      .sort(byPosition);
    const option = {
      id: o.option_id, label: o.label,
      values: values.map((v) => ({ id: v.value_id, label: v.label, ...(v.sides != null && { sides: v.sides }) }))
    };
    if (o.maps_product === 1) {
      option.maps_product = {};
      if (o.maps_component != null) option.maps_product.component = o.maps_component;
      for (const v of values) if (v.maps_to_product != null) option.maps_product[v.value_id] = v.maps_to_product;
    }
    (optionsByPack[o.pack_id] ||= []).push(option);
  }
  for (const [packId, options] of Object.entries(optionsByPack)) {
    requireParent(packs, packId, 'pack_options').options = options;
  }
  for (const c of [...entities.pack_components].sort(byPosition)) {
    requireParent(packs, c.pack_id, 'pack_components').components.push({
      id: c.component_id, label: c.label,
      ...(c.product_id != null && { product: c.product_id }),
      ...(c.qty_per_pack != null && { qty_per_pack: c.qty_per_pack })
    });
  }
  for (const cell of entities.bundle_prices) {
    const pk = requireParent(packs, cell.pack_id, 'bundle_prices');
    ((pk.bundle_prices ||= {})[cell.combo_key] ||= {})[cell.tier] = cell.price;
  }

  const company = {};
  const quote_settings = {};
  for (const row of entities.company) {
    const value = parseJsonValue(row.value, 'company', row.key);
    if (row.key.startsWith('company.')) company[row.key.slice('company.'.length)] = value;
    else if (row.key.startsWith('quote_settings.')) quote_settings[row.key.slice('quote_settings.'.length)] = value;
  }

  return {
    version: meta.version, updated_at: meta.updated_at, modified_by: meta.modified_by,
    parameters, suppliers, products, tiers, addons, packs, company, quote_settings
  };
}

module.exports = { disassemble, assemble };
