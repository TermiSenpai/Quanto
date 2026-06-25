// ============================================================
// Quanto · Quote input mapping (pure)
// ============================================================
// Pure, DOM-free functions for converting a saved `opt` (the
// object produced by `collectInputs` in app.js) into a structured
// plan that describes what every step-2 field should hold, and
// for reconstructing `opt` from a plan (inverse direction).
//
// These are the bridge between persisted quote data and the DOM
// restoration logic in A3 (reopen-and-edit). Neither function
// touches the DOM, `window`, `document`, or any global.
//
// `opt` shape (from calculo.js header):
//   {
//     options:    { <optionId>: <selectedValueId> },
//     addons:     { <addonId>: <qty> },         // only qty > 0
//     qty_3xl:    <number>,
//     qty_4xl:    <number>,
//     qty_5xl:    <number>,
//     packs:      <number>,                     // bundle mode only
//     quantities: { <componentId>: <qty> },     // components mode only
//     lines:      [ { product, quantity } ]     // free mode only
//   }
//
// `plan` shape (returned by planInputs):
//   {
//     mode:       'bundle' | 'components' | 'free',
//     options:    { <optionId>: <valueId> },
//     addons:     { <addonId>: <qty> },         // only qty > 0
//     sizes:      { qty_3xl, qty_4xl, qty_5xl },
//     packs:      <number> | null,              // bundle only, else null
//     quantities: { <componentId>: <qty> } | null, // components only, else null
//     lines:      [ { product, quantity } ] | null  // free only, else null
//   }
// ============================================================

'use strict';

/**
 * Derives the mode string from a pack definition.
 * Mirrors the branch order of `collectInputs` exactly.
 *
 * @param {object} pack
 * @returns {'bundle' | 'components' | 'free'}
 */
function packMode(pack) {
  if (pack.free_components) return 'free';
  return pack.pricing_mode === 'bundle' ? 'bundle' : 'components';
}

/**
 * Coerces a value to a non-negative-ish integer, mirroring the DOM
 * helper `intFromInput` (`parseInt(value, 10) || 0`) so the mapping is
 * an exact inverse of `collectInputs`. A malformed stored value (a
 * stringified number, NaN, undefined) collapses to 0 instead of leaking
 * through, exactly as the form path would.
 */
function toInt(value) {
  return parseInt(value, 10) || 0;
}

/**
 * Converts a saved `opt` into a structured plan.
 * This is the exact inverse of `collectInputs` in app.js.
 *
 * @param {object} pack  - the pack definition from cfg.packs
 * @param {object} opt   - the opt object produced by collectInputs
 * @returns {object}     - plan (see module header for shape)
 */
export function planInputs(pack, opt) {
  const mode = packMode(pack);

  // Options: pass through as-is (already { optionId: valueId }).
  const options = Object.assign({}, opt.options || {});

  // Addons: coerce to integer and keep only positive quantities (mirrors collectInputs filter).
  const addons = {};
  for (const [id, qty] of Object.entries(opt.addons || {})) {
    const q = toInt(qty);
    if (q > 0) addons[id] = q;
  }

  // Sizes: coerce to integers via toInt (mirrors intFromInput), default 0.
  const sizes = {
    qty_3xl: toInt(opt.qty_3xl),
    qty_4xl: toInt(opt.qty_4xl),
    qty_5xl: toInt(opt.qty_5xl)
  };

  // Mode-specific fields — exactly three branches matching collectInputs.
  let packs = null;
  let quantities = null;
  let lines = null;

  if (mode === 'free') {
    // free_components: array of { product, quantity } lines.
    lines = (opt.lines || []).map(l => ({ product: l.product || '', quantity: toInt(l.quantity) }));
  } else if (mode === 'bundle') {
    packs = toInt(opt.packs);
  } else {
    // components: { componentId: qty } — keyed by component id, coerced.
    quantities = {};
    for (const [id, qty] of Object.entries(opt.quantities || {})) {
      quantities[id] = toInt(qty);
    }
  }

  return { mode, options, addons, sizes, packs, quantities, lines };
}

/**
 * Reconstructs the original `opt` object from a plan.
 * Used to prove the mapping is lossless (round-trip test).
 *
 * @param {object} pack  - the pack definition from cfg.packs
 * @param {object} plan  - the plan returned by planInputs
 * @returns {object}     - opt (same shape as collectInputs returns)
 */
export function optFromPlan(pack, plan) {
  const mode = packMode(pack);

  const sizes = plan.sizes || {};
  // Coerce addon quantities to integers for consistency with planInputs.
  const addons = {};
  for (const [id, qty] of Object.entries(plan.addons || {})) {
    const q = toInt(qty);
    if (q > 0) addons[id] = q;
  }
  const opt = {
    options:  Object.assign({}, plan.options || {}),
    addons,
    qty_3xl:  toInt(sizes.qty_3xl),
    qty_4xl:  toInt(sizes.qty_4xl),
    qty_5xl:  toInt(sizes.qty_5xl)
  };

  // Restore the mode-specific field, matching collectInputs branch order.
  if (mode === 'free') {
    opt.lines = (plan.lines || []).map(l => ({ product: l.product || '', quantity: toInt(l.quantity) }));
  } else if (mode === 'bundle') {
    opt.packs = toInt(plan.packs);
  } else {
    opt.quantities = {};
    for (const [id, qty] of Object.entries(plan.quantities || {})) {
      opt.quantities[id] = toInt(qty);
    }
  }

  return opt;
}
