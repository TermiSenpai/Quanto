// ============================================================
// PackPrice · Strict config schema validator (v4)
// ============================================================
// Goes beyond `validateConfigShape` (lib/config-parser.js): it
// walks every field the calculator depends on and returns a list
// of errors with a precise dotted path. Used in `config:read` to
// fail fast with a human-readable message in Spanish so the admin
// can fix the file before any calculation produces NaN.
//
// Validates the v4 schema (English keys). A v2/v3 config must go
// through `migrateConfig` (lib/migrations.js) first — this module
// rejects older input up front to prevent leaks of the old shape.
//
// Why a separate module:
//   - Pure: no fs, no Electron, no globals -> trivial to unit test.
//   - English identifiers per CLAUDE.md §2.
//   - User-facing messages remain in Spanish (CLAUDE.md §4.5).
// ============================================================

'use strict';

const REQUIRED_PARAMETERS = [
  'labor_eur_hour',
  'vat',
  'waste_pct',
  'overhead_eur_garment',
  'surcharge_4xl_eur',
  'surcharge_5xl_eur',
  'roly_shipping_eur_bundle',
  'garments_per_bundle',
  'dtf_eur_meter',
  'dtf_meters_two_sides',
  'dtf_meters_one_side',
  'pressing_eur_side',
  'minutes_two_sides_base',
  'minutes_one_side_base',
  'default_target_margin',
  'price_rounding_ending'
];

const PRICE_FACES = ['two_sides', 'one_side'];

/**
 * Validates a parsed config object. Returns a list of error
 * messages (empty when the config is valid). Each message is
 * Spanish-facing, includes the dotted path of the offending
 * field, and is safe to display to the admin user verbatim.
 *
 * @param {object} cfg
 * @returns {string[]} list of human-readable error messages
 */
function collectConfigErrors(cfg) {
  const errors = [];

  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['El config debe ser un objeto.'];
  }

  if (typeof cfg.version !== 'string' || cfg.version.trim() === '') {
    errors.push('Falta o está vacío el campo "version".');
  } else if (/^2\./.test(cfg.version)) {
    return ['El config está en formato v2 y debe migrarse a v4 antes de validar (migrateConfig).'];
  } else if (/^3\./.test(cfg.version)) {
    return ['El config está en formato v3 y debe migrarse a v4 antes de validar (migrateConfig).'];
  }

  validateParameters(cfg.parameters, errors);
  validateSuppliers(cfg.suppliers, errors);
  const tierIds = validateTiers(cfg.tiers, errors);
  validateProducts(cfg, tierIds, errors);
  validateAddons(cfg.addons, errors);
  validatePacks(cfg, tierIds, errors);
  validateCompany(cfg.company, errors);
  validateQuoteSettings(cfg.quote_settings, errors);
  validateAdmin(cfg.admin, errors);

  return errors;
}

/**
 * Throws an Error with the joined list of validation errors when
 * the config is invalid. Use this in main.js right after parsing
 * (and migrating) a config to short-circuit downstream code with a
 * clear message.
 *
 * @param {object} cfg
 * @throws {Error}
 */
function validateConfigSchema(cfg) {
  const errors = collectConfigErrors(cfg);
  if (errors.length === 0) return;
  const detail = errors.length === 1
    ? errors[0]
    : `Se han detectado ${errors.length} problemas:\n• ${errors.join('\n• ')}`;
  throw new Error(`Config inválido. ${detail}`);
}

// ------------------------------------------------------------
// Parameters
// ------------------------------------------------------------
function validateParameters(params, errors) {
  if (!isPlainObject(params)) {
    errors.push('Falta la sección "parameters" o no es un objeto.');
    return;
  }
  for (const key of REQUIRED_PARAMETERS) {
    const path = `parameters.${key}`;
    const value = params[key];
    if (value === undefined || value === null) {
      errors.push(`Falta "${path}".`);
      continue;
    }
    if (!Number.isFinite(value)) {
      errors.push(`"${path}" debe ser un número (recibido: ${describe(value)}).`);
      continue;
    }
    if (value < 0) {
      errors.push(`"${path}" no puede ser negativo (recibido: ${value}).`);
    }
  }

  if (Number.isFinite(params.vat) && (params.vat < 0 || params.vat > 1)) {
    errors.push(`"parameters.vat" debe estar entre 0 y 1 (recibido: ${params.vat}). Usa 0.21 para 21%.`);
  }
  if (Number.isFinite(params.waste_pct) && (params.waste_pct < 0 || params.waste_pct > 1)) {
    errors.push(`"parameters.waste_pct" debe estar entre 0 y 1 (recibido: ${params.waste_pct}).`);
  }
  if (Number.isFinite(params.garments_per_bundle) && params.garments_per_bundle < 1) {
    errors.push(`"parameters.garments_per_bundle" debe ser >= 1 (recibido: ${params.garments_per_bundle}).`);
  }
  if (Number.isFinite(params.default_target_margin)
      && (params.default_target_margin < 0 || params.default_target_margin >= 1)) {
    errors.push(`"parameters.default_target_margin" debe estar en [0, 1) (recibido: ${params.default_target_margin}).`);
  }
  if (Number.isFinite(params.price_rounding_ending)
      && (params.price_rounding_ending < 0 || params.price_rounding_ending >= 1)) {
    errors.push(`"parameters.price_rounding_ending" debe estar en [0, 1) (recibido: ${params.price_rounding_ending}).`);
  }
}

// ------------------------------------------------------------
// Suppliers
// ------------------------------------------------------------
function validateSuppliers(suppliers, errors) {
  if (!isPlainObject(suppliers)) {
    errors.push('Falta la sección "suppliers" o no es un objeto.');
    return;
  }
  if (Object.keys(suppliers).length === 0) {
    errors.push('La sección "suppliers" está vacía.');
    return;
  }
  for (const [id, supplier] of Object.entries(suppliers)) {
    const path = `suppliers.${id}`;
    if (!isPlainObject(supplier)) {
      errors.push(`"${path}" debe ser un objeto.`);
      continue;
    }
    if (typeof supplier.name !== 'string' || supplier.name.trim() === '') {
      errors.push(`"${path}.name" debe ser un texto no vacío.`);
    }
  }
}

// ------------------------------------------------------------
// Products
// ------------------------------------------------------------
function validateProducts(cfg, tierIds, errors) {
  const products = cfg.products;
  if (!isPlainObject(products)) {
    errors.push('Falta la sección "products" o no es un objeto.');
    return;
  }
  if (Object.keys(products).length === 0) {
    errors.push('La sección "products" está vacía.');
    return;
  }

  const supplierIds = isPlainObject(cfg.suppliers) ? Object.keys(cfg.suppliers) : [];

  for (const [id, product] of Object.entries(products)) {
    const path = `products.${id}`;
    if (!isPlainObject(product)) {
      errors.push(`"${path}" debe ser un objeto.`);
      continue;
    }
    if (typeof product.name !== 'string' || product.name.trim() === '') {
      errors.push(`"${path}.name" debe ser un texto no vacío.`);
    }
    if (typeof product.category !== 'string' || product.category.trim() === '') {
      errors.push(`"${path}.category" debe ser un texto no vacío.`);
    }
    if (product.extra_cost_3xl !== undefined && product.extra_cost_3xl !== null
        && (!Number.isFinite(product.extra_cost_3xl) || product.extra_cost_3xl < 0)) {
      errors.push(`"${path}.extra_cost_3xl" debe ser un número >= 0 (recibido: ${describe(product.extra_cost_3xl)}).`);
    }

    // Suppliers: at least one, exactly one default, finite price.
    if (!Array.isArray(product.suppliers) || product.suppliers.length === 0) {
      errors.push(`"${path}.suppliers" debe ser un array con al menos un proveedor.`);
    } else {
      let defaults = 0;
      product.suppliers.forEach((sup, idx) => {
        const sp = `${path}.suppliers[${idx}]`;
        if (!isPlainObject(sup)) {
          errors.push(`"${sp}" debe ser un objeto.`);
          return;
        }
        if (typeof sup.supplier !== 'string' || sup.supplier.trim() === '') {
          errors.push(`"${sp}.supplier" debe ser un texto no vacío.`);
        } else if (supplierIds.length && !supplierIds.includes(sup.supplier)) {
          errors.push(`"${sp}.supplier" referencia un proveedor inexistente: ${sup.supplier}.`);
        }
        if (!Number.isFinite(sup.price)) {
          errors.push(`"${sp}.price" debe ser un número (recibido: ${describe(sup.price)}).`);
        } else if (sup.price < 0) {
          errors.push(`"${sp}.price" no puede ser negativo (recibido: ${sup.price}).`);
        }
        if (sup.is_default === true) defaults += 1;
      });
      if (defaults === 0) {
        errors.push(`"${path}.suppliers" debe tener exactamente un proveedor con is_default:true (no hay ninguno).`);
      } else if (defaults > 1) {
        errors.push(`"${path}.suppliers" debe tener exactamente un proveedor con is_default:true (hay ${defaults}).`);
      }
    }

    // Price table: every tier id for both faces.
    if (!isPlainObject(product.prices)) {
      errors.push(`Falta "${path}.prices" o no es un objeto.`);
    } else {
      for (const face of PRICE_FACES) {
        validatePriceFace(product.prices[face], `${path}.prices.${face}`, tierIds, errors);
      }
    }
  }
}

// ------------------------------------------------------------
// Addons
// ------------------------------------------------------------
function validateAddons(addons, errors) {
  if (addons === undefined || addons === null) return; // addons are optional
  if (!isPlainObject(addons)) {
    errors.push('"addons" debe ser un objeto.');
    return;
  }
  for (const [id, addon] of Object.entries(addons)) {
    const path = `addons.${id}`;
    if (!isPlainObject(addon)) {
      errors.push(`"${path}" debe ser un objeto.`);
      continue;
    }
    if (typeof addon.label !== 'string' || addon.label.trim() === '') {
      errors.push(`"${path}.label" debe ser un texto no vacío.`);
    }
    if (!Number.isFinite(addon.price) || addon.price < 0) {
      errors.push(`"${path}.price" debe ser un número >= 0 (recibido: ${describe(addon.price)}).`);
    }
    if (addon.cost !== undefined && addon.cost !== null
        && (!Number.isFinite(addon.cost) || addon.cost < 0)) {
      errors.push(`"${path}.cost" debe ser un número >= 0 (recibido: ${describe(addon.cost)}).`);
    }
    if (!Array.isArray(addon.applies_to) || addon.applies_to.length === 0) {
      errors.push(`"${path}.applies_to" debe ser un array con al menos una categoría (o '*').`);
    }
  }
}

// ------------------------------------------------------------
// Tiers (volume tiers)  → returns the list of tier ids
// ------------------------------------------------------------
function validateTiers(tiers, errors) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push('"tiers" debe ser un array con al menos un tramo.');
    return [];
  }
  let prevTo = -Infinity;
  tiers.forEach((tier, index) => {
    const path = `tiers[${index}]`;
    if (!isPlainObject(tier)) {
      errors.push(`"${path}" debe ser un objeto.`);
      return;
    }
    if (typeof tier.id !== 'string' || tier.id.trim() === '') {
      errors.push(`"${path}.id" debe ser un texto no vacío.`);
    }
    if (!Number.isFinite(tier.from) || tier.from < 1) {
      errors.push(`"${path}.from" debe ser un número >= 1 (recibido: ${describe(tier.from)}).`);
    }
    if (tier.to !== null && tier.to !== undefined) {
      if (!Number.isFinite(tier.to)) {
        errors.push(`"${path}.to" debe ser un número o null (recibido: ${describe(tier.to)}).`);
      } else if (Number.isFinite(tier.from) && tier.to < tier.from) {
        errors.push(`"${path}.to" (${tier.to}) no puede ser menor que "from" (${tier.from}).`);
      }
    }
    if (Number.isFinite(tier.from) && tier.from <= prevTo) {
      errors.push(`"${path}.from" (${tier.from}) se solapa con el tramo anterior (to ${prevTo}).`);
    }
    if (tier.time_reduction !== undefined && tier.time_reduction !== null) {
      if (!Number.isFinite(tier.time_reduction) || tier.time_reduction < 0 || tier.time_reduction >= 1) {
        errors.push(`"${path}.time_reduction" debe estar en [0, 1) (recibido: ${describe(tier.time_reduction)}).`);
      }
    }
    prevTo = (tier.to === null || tier.to === undefined)
      ? Number.POSITIVE_INFINITY
      : tier.to;
  });

  return tiers.filter(t => t && typeof t.id === 'string').map(t => t.id);
}

// ------------------------------------------------------------
// Packs
// ------------------------------------------------------------
function validatePacks(cfg, tierIds, errors) {
  const packs = cfg.packs;
  if (!isPlainObject(packs)) {
    errors.push('Falta la sección "packs" o no es un objeto.');
    return;
  }
  if (Object.keys(packs).length === 0) {
    errors.push('La sección "packs" está vacía.');
    return;
  }

  const products = isPlainObject(cfg.products) ? cfg.products : {};

  for (const [packId, pack] of Object.entries(packs)) {
    const path = `packs.${packId}`;
    if (!isPlainObject(pack)) {
      errors.push(`"${path}" debe ser un objeto.`);
      continue;
    }
    if (typeof pack.name !== 'string' || pack.name.trim() === '') {
      errors.push(`"${path}.name" debe ser un texto no vacío.`);
    }
    if (pack.pricing_mode !== 'bundle' && pack.pricing_mode !== 'components') {
      errors.push(`"${path}.pricing_mode" debe ser 'bundle' o 'components' (recibido: ${describe(pack.pricing_mode)}).`);
      continue;
    }
    requirePositiveNumber(pack.min_total, path + '.min_total', errors);

    // Options must be a (possibly empty) array of well-formed options.
    if (pack.options !== undefined && !Array.isArray(pack.options)) {
      errors.push(`"${path}.options" debe ser un array.`);
    }

    // Components must reference existing products (unless free_components).
    if (!Array.isArray(pack.components)) {
      errors.push(`"${path}.components" debe ser un array.`);
    } else if (!pack.free_components) {
      pack.components.forEach((comp, idx) => {
        const cp = `${path}.components[${idx}]`;
        if (!isPlainObject(comp)) {
          errors.push(`"${cp}" debe ser un objeto.`);
          return;
        }
        if (typeof comp.product !== 'string' || comp.product.trim() === '') {
          errors.push(`"${cp}.product" debe ser un texto no vacío.`);
        } else if (!products[comp.product]) {
          errors.push(`"${cp}.product" referencia un producto inexistente: ${comp.product}.`);
        }
      });
      if (pack.components.length === 0) {
        errors.push(`"${path}.components" no puede estar vacío en un pack sin free_components.`);
      }
    }

    if (pack.pricing_mode === 'bundle') {
      validateBundlePrices(pack, path, tierIds, errors);
    }

    // Any maps_product target must reference existing products.
    for (const option of (Array.isArray(pack.options) ? pack.options : [])) {
      const map = option && option.maps_product;
      if (!isPlainObject(map)) continue;
      for (const [key, value] of Object.entries(map)) {
        if (key === 'component') continue;
        if (typeof value === 'string' && !products[value]) {
          errors.push(`"${path}.options.${option.id}.maps_product.${key}" referencia un producto inexistente: ${value}.`);
        }
      }
    }
  }
}

/**
 * Validates a bundle pack's `bundle_prices`: it must cover every
 * option-combo (the cartesian product of the option values, joined
 * with '|' in declared order) for every tier id.
 */
function validateBundlePrices(pack, path, tierIds, errors) {
  if (!isPlainObject(pack.bundle_prices)) {
    errors.push(`Falta "${path}.bundle_prices" o no es un objeto.`);
    return;
  }
  const combos = optionCombos(pack.options);
  for (const combo of combos) {
    const row = pack.bundle_prices[combo];
    if (!isPlainObject(row)) {
      errors.push(`Falta "${path}.bundle_prices.${combo}" o no es un objeto.`);
      continue;
    }
    for (const tierId of tierIds) {
      const value = row[tierId];
      if (value === undefined || value === null) {
        errors.push(`Falta PVP "${path}.bundle_prices.${combo}.${tierId}".`);
      } else if (!Number.isFinite(value) || value < 0) {
        errors.push(`"${path}.bundle_prices.${combo}.${tierId}" debe ser un número >= 0 (recibido: ${describe(value)}).`);
      }
    }
  }
}

/** Cartesian product of option value ids, joined with '|' in order. */
function optionCombos(options) {
  const opts = Array.isArray(options) ? options : [];
  let combos = [''];
  for (const option of opts) {
    const valueIds = (option.values || []).map(v => v.id);
    const next = [];
    for (const prefix of combos) {
      for (const id of valueIds) {
        next.push(prefix === '' ? id : `${prefix}|${id}`);
      }
    }
    combos = next;
  }
  return combos;
}

function validatePriceFace(faceObj, path, tierIds, errors) {
  if (!isPlainObject(faceObj)) {
    errors.push(`Falta "${path}" o no es un objeto.`);
    return;
  }
  for (const tierId of tierIds) {
    const value = faceObj[tierId];
    if (value === undefined || value === null) {
      errors.push(`Falta PVP "${path}.${tierId}".`);
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`"${path}.${tierId}" debe ser un número >= 0 (recibido: ${describe(value)}).`);
    }
  }
}

// ------------------------------------------------------------
// Company / quote settings
// ------------------------------------------------------------
function validateCompany(company, errors) {
  if (company === undefined || company === null) return; // optional
  if (!isPlainObject(company)) {
    errors.push('"company" debe ser un objeto.');
    return;
  }
  if (typeof company.name !== 'string') {
    errors.push('"company.name" debe ser un texto.');
  }
}

function validateQuoteSettings(qs, errors) {
  if (qs === undefined || qs === null) return; // optional
  if (!isPlainObject(qs)) {
    errors.push('"quote_settings" debe ser un objeto.');
    return;
  }
  if (qs.validity_days !== undefined && !Number.isFinite(qs.validity_days)) {
    errors.push('"quote_settings.validity_days" debe ser un número.');
  }
}

// ------------------------------------------------------------
// Admin section
// ------------------------------------------------------------
function validateAdmin(admin, errors) {
  if (!isPlainObject(admin)) {
    errors.push('Falta la sección "admin" o no es un objeto.');
    return;
  }
  // The renderer-side config has `has_password` (boolean) instead
  // of the raw `password`. Accept both shapes; reject neither.
  const hasRawPassword = typeof admin.password === 'string' && admin.password.length > 0;
  const hasFlag = admin.has_password === true;
  if (!hasRawPassword && !hasFlag) {
    errors.push('"admin.password" debe ser un texto no vacío (o has_password=true en el renderer).');
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requirePositiveNumber(value, path, errors) {
  if (value === undefined || value === null) {
    errors.push(`Falta "${path}".`);
    return;
  }
  if (!Number.isFinite(value) || value < 0) {
    errors.push(`"${path}" debe ser un número >= 0 (recibido: ${describe(value)}).`);
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return 'object';
  return String(value);
}

module.exports = {
  collectConfigErrors,
  validateConfigSchema,
  REQUIRED_PARAMETERS
};
