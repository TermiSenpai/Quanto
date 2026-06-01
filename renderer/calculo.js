// ============================================================
// PackPrice · Calculation logic (pure)
// ============================================================
// Pure functions: given (cfg, options) they return the result.
// They never touch the DOM, the filesystem, or globals, which is
// what lets us test them in isolation (see CLAUDE.md §7).
//
// Schema: v3 (English keys) for both the config they consume and
// the result they produce. User-facing strings (error messages,
// pack/tier names that come from the config) stay in Spanish.
// ============================================================

/**
 * Computes optional extras (name, printed sleeves) in euros.
 *
 * Config prices (extra_*_eur) are WITHOUT VAT. We return both the
 * VAT-free subtotal (what the user "ordered") and its VAT-included
 * equivalent, to add to the total the rest of the flow treats as
 * VAT-included. With no extras everything is 0.
 *
 * @param cfg
 * @param extras  { names, short_sleeves, long_sleeves }
 */
export function calculateExtras(cfg, extras) {
  const e = extras || {};
  const p = cfg.parameters;
  const names        = e.names         || 0;
  const shortSleeves = e.short_sleeves || 0;
  const longSleeves  = e.long_sleeves  || 0;

  const noVat = names        * (p.extra_name_eur         || 0)
             + shortSleeves  * (p.extra_short_sleeve_eur || 0)
             + longSleeves   * (p.extra_long_sleeve_eur  || 0);
  const vatInc = noVat * (1 + (p.vat || 0));

  return {
    no_vat: noVat,
    vat_inc: vatInc,
    detail: { names, short_sleeves: shortSleeves, long_sleeves: longSleeves }
  };
}

/**
 * Returns the volume tier for a quantity, or null if it fits none
 * (quantity < the first tier's `from`).
 */
export function getTier(cfg, quantity) {
  for (const t of cfg.tiers) {
    const meetsMin = quantity >= t.from;
    const meetsMax = (t.to === null) || (quantity <= t.to);
    if (meetsMin && meetsMax) return t;
  }
  return null;
}

/**
 * Real cost of producing one finished garment (Roly + DTF +
 * pressing + waste + labor + overhead + prorated shipping).
 *
 * @param cfg                          full configuration
 * @param modelId                      key of cfg.roly_models (BEAGLE, etc.)
 * @param sides                        1 or 2
 * @param tier                         the already-resolved tier object
 * @param totalGarmentsForShipping     total garments of the order for proration
 */
export function calculateGarmentCost(cfg, modelId, sides, tier, totalGarmentsForShipping) {
  const m = cfg.roly_models[modelId];
  const p = cfg.parameters;

  const baseRoly = m.price;
  const dtfMeters = (sides === 2) ? p.dtf_meters_two_sides : p.dtf_meters_one_side;
  const dtf = dtfMeters * p.dtf_eur_meter;
  const pressing = sides * p.pressing_eur_side;

  const numBundles = Math.ceil(totalGarmentsForShipping / p.garments_per_bundle);
  const shippingPerGarment = (numBundles * p.roly_shipping_eur_bundle) / totalGarmentsForShipping;

  const subtotalPreWaste = baseRoly + shippingPerGarment + dtf + pressing;
  const waste = subtotalPreWaste * p.waste_pct;

  const baseMinutes = (sides === 2) ? p.minutes_two_sides_base : p.minutes_one_side_base;
  const realMinutes = baseMinutes * (1 - tier.time_reduction);
  const labor = (realMinutes / 60) * p.labor_eur_hour;

  const overhead = p.overhead_eur_garment;

  return {
    total: baseRoly + shippingPerGarment + dtf + pressing + waste + labor + overhead
  };
}

/**
 * Crew pack: combines a BEAGLE t-shirt + a hoodie (CLASICA or URBAN
 * depending on `hood`). The tier is computed on the number of packs.
 */
export function calculateCrewPack(cfg, opt) {
  const { quantity, hood, sides, qty_4xl, qty_5xl, extras } = opt;
  const pack = cfg.packs.crew_full;

  if (quantity < pack.min) {
    return { error: `Mínimo ${pack.min} packs para "${pack.name}".` };
  }

  const tier = getTier(cfg, quantity);
  const sidesKey = (sides === 2) ? 'two_sides' : 'one_side';
  const hoodKey  = (hood === 'with') ? 'with_hood' : 'without_hood';
  const unitPrice = pack.prices[hoodKey][sidesKey][tier.id];

  const totalGarments = quantity * 2;
  const hoodieModel = (hood === 'with') ? 'URBAN' : 'CLASICA';
  const tshirtCost = calculateGarmentCost(cfg, 'BEAGLE', sides, tier, totalGarments);
  const hoodieCost = calculateGarmentCost(cfg, hoodieModel, sides, tier, totalGarments);
  const buffer3xl = cfg.parameters.buffer_3xl_eur_pack;
  const packCost = tshirtCost.total + hoodieCost.total + buffer3xl;

  return calculateTotals(cfg, {
    pack: pack.name, tier: tier.label, quantity,
    unit_price: unitPrice, unit_cost: packCost,
    qty_4xl, qty_5xl, extras,
    extra_detail: { hood: hoodKey, sides }
  });
}

/**
 * Single packs: t-shirts only, CLASICA only, URBAN only.
 */
export function calculateSinglePack(cfg, packId, opt) {
  const { quantity, sides, qty_4xl, qty_5xl, extras } = opt;
  const pack = cfg.packs[packId];

  if (quantity < pack.min) {
    return { error: `Mínimo ${pack.min} unidades para "${pack.name}".` };
  }

  const tier = getTier(cfg, quantity);
  const sidesKey = (sides === 2) ? 'two_sides' : 'one_side';
  const unitPrice = pack.prices[sidesKey][tier.id];

  const unitCost = calculateGarmentCost(cfg, pack.model, sides, tier, quantity);

  return calculateTotals(cfg, {
    pack: pack.name, tier: tier.label, quantity,
    unit_price: unitPrice, unit_cost: unitCost.total,
    qty_4xl, qty_5xl, extras,
    extra_detail: { model: pack.model, sides }
  });
}

/**
 * Mixed hoodie pack: combines X CLASICA + Y URBAN. The tier is
 * computed on the sum; each hoodie is billed at its single price.
 */
export function calculateMixedPack(cfg, opt) {
  const { qty_classic, qty_urban, sides, qty_4xl, qty_5xl, extras } = opt;
  const pack = cfg.packs.hoodies_mixed;
  const total = qty_classic + qty_urban;

  if (total < pack.min_total) {
    return { error: `Mínimo ${pack.min_total} sudaderas en total.` };
  }
  if (qty_classic === 0 && qty_urban === 0) {
    return { error: 'Indica al menos una cantidad mayor que cero.' };
  }

  const tier = getTier(cfg, total);
  const sidesKey = (sides === 2) ? 'two_sides' : 'one_side';

  const priceClassic = cfg.packs[pack.reference_packs.CLASICA].prices[sidesKey][tier.id];
  const priceUrban   = cfg.packs[pack.reference_packs.URBAN].prices[sidesKey][tier.id];

  const subtotal = (qty_classic * priceClassic) + (qty_urban * priceUrban);
  const surcharges = (qty_4xl * cfg.parameters.surcharge_4xl_eur)
                   + (qty_5xl * cfg.parameters.surcharge_5xl_eur);
  const extrasCalc = calculateExtras(cfg, extras);
  const totalVatInc = subtotal + surcharges + extrasCalc.vat_inc;

  const costClassic = calculateGarmentCost(cfg, 'CLASICA', sides, tier, total);
  const costUrban   = calculateGarmentCost(cfg, 'URBAN',   sides, tier, total);
  const totalCost = (qty_classic * costClassic.total) + (qty_urban * costUrban.total);

  const saleBase = totalVatInc / (1 + cfg.parameters.vat);
  const vat = totalVatInc - saleBase;
  const margin = saleBase - totalCost;
  const marginPct = totalVatInc > 0 ? (margin / totalVatInc) : 0;

  return {
    pack: pack.name, tier: tier.label, is_mixed: true,
    total_quantity: total, qty_4xl, qty_5xl, sides,
    breakdown: [
      { model: 'CLASICA', name: cfg.roly_models.CLASICA.name, quantity: qty_classic, price: priceClassic, subtotal: qty_classic * priceClassic },
      { model: 'URBAN',   name: cfg.roly_models.URBAN.name,   quantity: qty_urban,   price: priceUrban,   subtotal: qty_urban * priceUrban }
    ],
    subtotal, surcharges,
    extras_no_vat: extrasCalc.no_vat, extras_detail: extrasCalc.detail,
    total_vat_inc: totalVatInc, sale_base: saleBase, vat,
    total_cost: totalCost, margin, margin_pct: marginPct
  };
}

/**
 * Custom pack: the user adds N lines, each with its Roly model,
 * quantity and sides (1 or 2). The tier is computed on the total
 * sum of garments and each line is billed at the single price of
 * the pack that corresponds to that model (via `pack.reference_models`).
 *
 * @param cfg
 * @param opt  { lines:[{model,quantity,sides}], qty_4xl, qty_5xl }
 */
export function calculateCustomPack(cfg, opt) {
  const { lines, qty_4xl, qty_5xl, extras } = opt;
  const pack = cfg.packs.custom;

  const validLines = (lines || []).filter(l => l && l.quantity > 0);
  if (validLines.length === 0) {
    return { error: 'Añade al menos una línea con cantidad mayor que cero.' };
  }

  const total = validLines.reduce((s, l) => s + l.quantity, 0);
  if (total < pack.min_total) {
    return { error: `Mínimo ${pack.min_total} prendas en total.` };
  }

  const tier = getTier(cfg, total);
  if (!tier) {
    return { error: `No hay tramo definido para ${total} unidades.` };
  }

  const breakdown = [];
  let subtotal = 0;
  let totalCost = 0;

  for (const l of validLines) {
    const refPackId = pack.reference_models?.[l.model];
    const refPack = refPackId ? cfg.packs[refPackId] : null;
    if (!refPack || !refPack.prices) {
      return { error: `No hay PVP de referencia para el modelo ${l.model}.` };
    }
    const sidesKey = (l.sides === 2) ? 'two_sides' : 'one_side';
    const price = refPack.prices[sidesKey]?.[tier.id];
    if (price === undefined || price === null) {
      return { error: `Falta PVP de ${refPackId} (${sidesKey}, ${tier.id}).` };
    }

    const sub = l.quantity * price;
    subtotal += sub;

    const cost = calculateGarmentCost(cfg, l.model, l.sides, tier, total);
    totalCost += l.quantity * cost.total;

    const m = cfg.roly_models[l.model];
    breakdown.push({
      model: l.model,
      name: m ? m.name : l.model,
      quantity: l.quantity,
      sides: l.sides,
      price,
      subtotal: sub
    });
  }

  const surcharges = (qty_4xl * cfg.parameters.surcharge_4xl_eur)
                   + (qty_5xl * cfg.parameters.surcharge_5xl_eur);
  const extrasCalc = calculateExtras(cfg, extras);
  const totalVatInc = subtotal + surcharges + extrasCalc.vat_inc;
  const saleBase = totalVatInc / (1 + cfg.parameters.vat);
  const vat = totalVatInc - saleBase;
  const margin = saleBase - totalCost;
  const marginPct = totalVatInc > 0 ? (margin / totalVatInc) : 0;

  return {
    pack: pack.name, tier: tier.label, is_mixed: true, is_custom: true,
    total_quantity: total, qty_4xl, qty_5xl,
    breakdown,
    subtotal, surcharges,
    extras_no_vat: extrasCalc.no_vat, extras_detail: extrasCalc.detail,
    total_vat_inc: totalVatInc, sale_base: saleBase, vat,
    total_cost: totalCost, margin, margin_pct: marginPct
  };
}

/**
 * Computes subtotals, VAT and margins from quantity × price +
 * surcharges + optional extras. Shared by the crew pack and the
 * single packs (not the mixed one).
 */
export function calculateTotals(cfg, data) {
  const subtotal = data.quantity * data.unit_price;
  const surcharges = (data.qty_4xl * cfg.parameters.surcharge_4xl_eur)
                   + (data.qty_5xl * cfg.parameters.surcharge_5xl_eur);
  const extras = calculateExtras(cfg, data.extras);
  const totalVatInc = subtotal + surcharges + extras.vat_inc;
  const saleBase = totalVatInc / (1 + cfg.parameters.vat);
  const vat = totalVatInc - saleBase;
  const totalCost = data.quantity * data.unit_cost;
  const margin = saleBase - totalCost;
  const marginPct = totalVatInc > 0 ? (margin / totalVatInc) : 0;

  return {
    pack: data.pack, tier: data.tier, quantity: data.quantity,
    unit_price: data.unit_price, qty_4xl: data.qty_4xl, qty_5xl: data.qty_5xl,
    subtotal, surcharges,
    extras_no_vat: extras.no_vat, extras_detail: extras.detail,
    total_vat_inc: totalVatInc, sale_base: saleBase, vat,
    unit_cost: data.unit_cost, total_cost: totalCost,
    margin, margin_pct: marginPct,
    extra: data.extra_detail
  };
}
