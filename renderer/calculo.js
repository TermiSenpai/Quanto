// ============================================================
// Quanto · Calculation logic (pure)
// ============================================================
// Pure functions: given (cfg, options) they return the result.
// They never touch the DOM, the filesystem, or globals, which is
// what lets us test them in isolation (see CLAUDE.md §7).
//
// Schema: v4 (English keys) for both the config they consume and
// the result they produce. User-facing strings (error messages,
// pack/tier names that come from the config) stay in Spanish.
//
// v4 unifies the old four pack calculators into a single generic
// `calculatePack(cfg, packId, opt)` driven entirely by the config:
//   - 'bundle'     packs price the whole pack at `bundle_prices`
//                  keyed by the option-combo string × tier.
//   - 'components' packs sum each component's own product price.
// Options (sides, hood, …) are declared in the config, not here.
//
// `opt` input shape:
//   opt = {
//     options:    { <optionId>: <selectedValueId>, ... },
//     packs:      <number>,                          // bundle packs
//     quantities: { <componentId>: <qty>, ... },     // components packs
//     lines:      [ { product:<id>, quantity:<n> } ],// free_components only
//     qty_3xl, qty_4xl, qty_5xl,                      // size counts (def 0)
//     addons:     { <addonId>: <qty>, ... }           // selected addons
//   }
// ============================================================

/**
 * Returns the volume tier for a quantity, or null if it fits none
 * (quantity < the first tier's `from`).
 */
export function getTier(cfg, quantity) {
  for (const t of cfg.tiers) {
    const meetsMin = quantity >= t.from;
    const meetsMax = (t.to === null || t.to === undefined) || (quantity <= t.to);
    if (meetsMin && meetsMax) return t;
  }
  return null;
}

/**
 * Returns the default supplier price for a product: the supplier
 * flagged `is_default: true`, or the first one as a fallback.
 */
function defaultSupplierPrice(product) {
  const suppliers = Array.isArray(product.suppliers) ? product.suppliers : [];
  const def = suppliers.find(s => s && s.is_default) || suppliers[0];
  return def ? def.price : undefined;
}

/**
 * Optional configurable extras (addons) in euros.
 *
 * Driven by `cfg.addons`. Each selected addon contributes
 * `qty * price`; if the addon `price` is already VAT-included we use
 * it as-is, otherwise we gross it up by the VAT rate. We return both
 * the VAT-free subtotal (`no_vat`) and the VAT-included total
 * (`vat_inc`), mirroring the old `calculateExtras` contract so the
 * rest of the flow (which treats totals as VAT-included) keeps working.
 *
 * @param cfg
 * @param selection  { <addonId>: <qty>, ... }
 * @returns { no_vat, vat_inc, detail }
 */
export function calculateAddons(cfg, selection) {
  const sel = selection || {};
  const addons = cfg.addons || {};
  const vat = (cfg.parameters && cfg.parameters.vat) || 0;

  let noVat = 0;
  let vatInc = 0;
  const detail = {};

  for (const [id, qty] of Object.entries(sel)) {
    const n = qty || 0;
    if (n <= 0) continue;
    const addon = addons[id];
    if (!addon) continue;
    detail[id] = n;
    if (addon.vat_included) {
      // Price already includes VAT: split out the net part.
      vatInc += n * addon.price;
      noVat += n * (addon.price / (1 + vat));
    } else {
      noVat += n * addon.price;
      vatInc += n * addon.price * (1 + vat);
    }
  }

  return { no_vat: noVat, vat_inc: vatInc, detail };
}

/**
 * Real cost of producing one finished garment (supplier base + DTF +
 * pressing + waste + labor + overhead + prorated shipping).
 *
 * @param cfg                          full configuration
 * @param productId                    key of cfg.products (BEAGLE, etc.)
 * @param sides                        1 or 2
 * @param tier                         the already-resolved tier object
 * @param totalGarmentsForShipping     total garments of the order for proration
 */
export function calculateGarmentCost(cfg, productId, sides, tier, totalGarmentsForShipping) {
  const product = cfg.products[productId];
  if (!product) {
    throw new Error(`Producto desconocido: ${productId}.`);
  }
  const p = cfg.parameters;

  const baseProduct = defaultSupplierPrice(product) || 0;
  const dtfMeters = (sides === 2) ? p.dtf_meters_two_sides : p.dtf_meters_one_side;
  const dtf = dtfMeters * p.dtf_eur_meter;
  const pressing = sides * p.pressing_eur_side;

  const numBundles = Math.ceil(totalGarmentsForShipping / p.garments_per_bundle);
  const shippingPerGarment = (numBundles * p.roly_shipping_eur_bundle) / totalGarmentsForShipping;

  const subtotalPreWaste = baseProduct + shippingPerGarment + dtf + pressing;
  const waste = subtotalPreWaste * p.waste_pct;

  const baseMinutes = (sides === 2) ? p.minutes_two_sides_base : p.minutes_one_side_base;
  const realMinutes = baseMinutes * (1 - tier.time_reduction);
  const labor = (realMinutes / 60) * p.labor_eur_hour;

  const overhead = p.overhead_eur_garment;

  return {
    total: baseProduct + shippingPerGarment + dtf + pressing + waste + labor + overhead
  };
}

/**
 * Recommended price for a unit of cost `costPerUnit` at the given
 * `targetMargin`, rounded UP to the next price whose cents end at
 * `cfg.parameters.price_rounding_ending` (0.95 → next x,95).
 *
 * Price is computed on the SAME basis as the cost passed in: an ex-VAT
 * cost yields an ex-VAT price (no VAT gross-up happens here). The
 * returned margin is `price - costPerUnit` and `margin_pct` is over the
 * price, so the UI can show "this rounding gives you X% margin".
 *
 *   cost 10, margin 0.35 → 10/0.65 = 15.3846 → round up → 15.95
 *
 * @param cfg
 * @param costPerUnit  internal cost of one unit
 * @param targetMargin fraction in [0,1)
 * @returns { price, raw_price, margin, margin_pct }
 */
export function recommendedPrice(cfg, costPerUnit, targetMargin) {
  const ending = cfg.parameters.price_rounding_ending;
  const margin = (targetMargin === undefined || targetMargin === null)
    ? cfg.parameters.default_target_margin
    : targetMargin;

  const rawPrice = (margin >= 1) ? Infinity : costPerUnit / (1 - margin);
  const price = roundUpToEnding(rawPrice, ending);

  // Real margin at the rounded price (margin over the price itself).
  const realMargin = price - costPerUnit;
  const realMarginPct = (Number.isFinite(price) && price > 0) ? (realMargin / price) : 0;

  return {
    price,
    raw_price: rawPrice,
    margin: realMargin,
    margin_pct: realMarginPct
  };
}

/**
 * Rounds `value` UP to the next number whose fractional part equals
 * `ending` (e.g. ending 0.95 → 15.3846 → 15.95; 15.95 stays 15.95;
 * 15.96 → 16.95). `ending` must be in [0, 1).
 */
function roundUpToEnding(value, ending) {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const candidate = floor + ending;
  // Tiny epsilon so a value already exactly at the ending is not
  // pushed to the next integer by float noise.
  if (candidate >= value - 1e-9) return round2(candidate);
  return round2(floor + 1 + ending);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------
// Generic pack calculation
// ------------------------------------------------------------
/**
 * Computes a full quote for any pack, bundle or components.
 *
 * @param cfg     full v4 configuration
 * @param packId  key of cfg.packs
 * @param opt     see the file header for the input shape
 * @returns result object (see the bottom of this function) or
 *          `{ error }` with a Spanish message on any validation failure
 */
export function calculatePack(cfg, packId, opt) {
  const o = opt || {};
  const pack = cfg.packs[packId];
  if (!pack) {
    return { error: `No existe el pack "${packId}".` };
  }

  const selectedOptions = o.options || {};

  // --- Resolve the "sides" info from the selected option values. ---
  // The option value carrying a numeric `sides` defines both the
  // number of sides (cost) and the price-table key (`one_side` /
  // `two_sides`). All seed packs have a sides option.
  let sidesNum = 1;
  let sidesKey = null;
  for (const option of (pack.options || [])) {
    const selectedId = selectedOptions[option.id];
    const value = (option.values || []).find(v => v.id === selectedId);
    if (value && Number.isFinite(value.sides)) {
      sidesNum = value.sides;
      sidesKey = value.id;
    }
  }
  if (sidesKey === null) {
    // No sides option selected: fall back to a price-table key the
    // products actually expose (one_side by convention).
    sidesKey = 'one_side';
  }

  const qty3xl = o.qty_3xl || 0;
  const qty4xl = o.qty_4xl || 0;
  const qty5xl = o.qty_5xl || 0;

  // --- Build the list of component lines with resolved products. ---
  // Each line: { id, label, productId, quantity }.
  let lines;
  let packsN = 0;

  if (pack.free_components) {
    const rawLines = (o.lines || []).filter(l => l && (l.quantity || 0) > 0);
    if (rawLines.length === 0) {
      return { error: 'Añade al menos una línea con cantidad mayor que cero.' };
    }
    lines = [];
    for (const l of rawLines) {
      if (!cfg.products[l.product]) {
        return { error: `El producto "${l.product}" no existe en el catálogo.` };
      }
      lines.push({
        id: l.product,
        label: cfg.products[l.product].name,
        productId: l.product,
        quantity: l.quantity
      });
    }
  } else if (pack.pricing_mode === 'bundle') {
    packsN = o.packs || 0;
    if (packsN <= 0) {
      return { error: 'Indica un número de packs mayor que cero.' };
    }
    lines = (pack.components || []).map(c => ({
      id: c.id,
      label: c.label,
      productId: resolveComponentProduct(pack, c, selectedOptions),
      quantity: packsN * (c.qty_per_pack || 1)
    }));
  } else {
    // components pack with fixed components, quantity per component.
    const quantities = o.quantities || {};
    lines = (pack.components || []).map(c => ({
      id: c.id,
      label: c.label,
      productId: resolveComponentProduct(pack, c, selectedOptions),
      quantity: quantities[c.id] || 0
    }));
    if (lines.every(l => l.quantity <= 0)) {
      return { error: 'Indica al menos una cantidad mayor que cero.' };
    }
  }

  // Validate resolved products exist (maps_product could point nowhere).
  for (const l of lines) {
    if (!l.productId || !cfg.products[l.productId]) {
      return { error: `El componente "${l.label || l.id}" no resuelve a un producto válido.` };
    }
  }

  const total = lines.reduce((s, l) => s + l.quantity, 0);

  if (total < pack.min_total) {
    return { error: `Mínimo ${pack.min_total} unidades en total para "${pack.name}".` };
  }
  if (total <= 0) {
    return { error: 'Indica al menos una cantidad mayor que cero.' };
  }

  const tier = getTier(cfg, total);
  if (!tier) {
    return { error: `No hay un tramo de precio definido para ${total} unidades.` };
  }

  if (qty3xl + qty4xl + qty5xl > total) {
    return { error: 'Las tallas grandes (3XL/4XL/5XL) no pueden superar el número de prendas del pedido.' };
  }

  // --- Revenue (IVA-incl `subtotal`) + breakdown. ---
  let subtotal = 0;
  let topUnitPrice = 0;
  const breakdown = [];

  if (pack.pricing_mode === 'bundle') {
    const comboKey = (pack.options || []).map(option => selectedOptions[option.id]).join('|');
    const priceRow = (pack.bundle_prices || {})[comboKey];
    const bundlePrice = priceRow ? priceRow[tier.id] : undefined;
    if (bundlePrice === undefined || bundlePrice === null) {
      return { error: `Falta el PVP del pack para la combinación "${comboKey}" (${tier.id}).` };
    }
    subtotal = packsN * bundlePrice;
    topUnitPrice = bundlePrice;

    // Represent the bundle as a single row (qty = packs, unit = bundle
    // price per pack), keeping the component composition for the PDF.
    breakdown.push({
      model: packId,
      name: pack.name,
      quantity: packsN,
      sides: sidesNum,
      unit_price: bundlePrice,
      subtotal,
      components: lines.map(l => ({
        model: l.productId,
        name: cfg.products[l.productId].name,
        quantity: l.quantity
      }))
    });
  } else {
    for (const l of lines) {
      const product = cfg.products[l.productId];
      const priceTable = (product.prices || {})[sidesKey] || {};
      const unitPrice = priceTable[tier.id];
      if (unitPrice === undefined || unitPrice === null) {
        return { error: `Falta el PVP de "${product.name}" (${sidesKey}, ${tier.id}).` };
      }
      const lineSubtotal = l.quantity * unitPrice;
      subtotal += lineSubtotal;
      breakdown.push({
        model: l.productId,
        name: product.name,
        quantity: l.quantity,
        sides: sidesNum,
        unit_price: unitPrice,
        subtotal: lineSubtotal
      });
    }
    // For a single-component components pack, the top-level unit_price
    // is that product's unit price; for multi-line packs leave it 0.
    topUnitPrice = (lines.length === 1) ? breakdown[0].unit_price : 0;
  }

  // --- Cost (ex-VAT). ---
  let garmentsCost = 0;
  let maxExtra3xl = 0;
  for (const l of lines) {
    const product = cfg.products[l.productId];
    const unitCost = calculateGarmentCost(cfg, l.productId, sidesNum, tier, total).total;
    garmentsCost += l.quantity * unitCost;
    // MAX over the products actually in this order: conservative, the
    // shop must never lose money on the size mix (we charge the worst
    // case for the 3XL units, which are a buffer, not billed to client).
    if (Number.isFinite(product.extra_cost_3xl) && product.extra_cost_3xl > maxExtra3xl) {
      maxExtra3xl = product.extra_cost_3xl;
    }
  }
  const cost3xl = qty3xl * maxExtra3xl;

  const addons = calculateAddons(cfg, o.addons);
  const addonsCost = addonsTotalCost(cfg, o.addons);

  const totalCost = garmentsCost + cost3xl + addonsCost;

  // --- Surcharges billed to the client (4XL/5XL; 3XL is NOT). ---
  const surcharges = (qty4xl * cfg.parameters.surcharge_4xl_eur)
                   + (qty5xl * cfg.parameters.surcharge_5xl_eur);

  // --- Totals. ---
  const totalVatInc = subtotal + surcharges + addons.vat_inc;
  const saleBase = totalVatInc / (1 + cfg.parameters.vat);
  const vat = totalVatInc - saleBase;
  const margin = saleBase - totalCost;
  const marginPct = saleBase > 0 ? (margin / saleBase) : 0;

  // Per-unit headline including addons (IVA inc). Base per unit is the bundle
  // price per pack, or the average garment PVP for components. Size surcharges
  // (4XL/5XL) are NOT folded in here — they stay a separate line.
  const extrasVatInc = addons.vat_inc;
  const unitsForExtras = (pack.pricing_mode === 'bundle') ? packsN : total;
  const baseUnit = (pack.pricing_mode === 'bundle') ? topUnitPrice : (subtotal / total);
  const unitPriceWithExtras = baseUnit + (unitsForExtras > 0 ? extrasVatInc / unitsForExtras : 0);

  return {
    pack_id: packId,
    pricing_mode: pack.pricing_mode,
    pack: pack.name,
    tier: tier.label,
    options: selectedOptions,
    total_quantity: total,
    quantity: total,
    unit_price: topUnitPrice,
    breakdown,
    subtotal,
    surcharges,
    extras_no_vat: addons.no_vat,
    extras_vat_inc: extrasVatInc,
    unit_price_with_extras: unitPriceWithExtras,
    extras_detail: addons.detail,
    total_vat_inc: totalVatInc,
    sale_base: saleBase,
    vat,
    total_cost: totalCost,
    margin,
    margin_pct: marginPct,
    qty_3xl: qty3xl,
    qty_4xl: qty4xl,
    qty_5xl: qty5xl
  };
}

/**
 * Resolves which product a component uses, honoring any option's
 * `maps_product` whose `component` matches this component's id.
 */
function resolveComponentProduct(pack, component, selectedOptions) {
  let productId = component.product;
  for (const option of (pack.options || [])) {
    const map = option.maps_product;
    if (map && map.component === component.id) {
      const selectedId = selectedOptions[option.id];
      if (selectedId !== undefined && map[selectedId] !== undefined) {
        productId = map[selectedId];
      }
    }
  }
  return productId;
}

/** Internal real cost of the selected addons (ex-VAT, by `addon.cost`). */
function addonsTotalCost(cfg, selection) {
  const sel = selection || {};
  const addons = cfg.addons || {};
  let cost = 0;
  for (const [id, qty] of Object.entries(sel)) {
    const n = qty || 0;
    if (n <= 0) continue;
    const addon = addons[id];
    if (!addon) continue;
    cost += n * (addon.cost || 0);
  }
  return cost;
}
