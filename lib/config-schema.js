// ============================================================
// PackPrice · Strict config schema validator (v3)
// ============================================================
// Goes beyond `validateConfigShape` (lib/config-parser.js): it
// walks every field the calculator depends on and returns a list
// of errors with a precise dotted path. Used in `config:read` to
// fail fast with a human-readable message in Spanish so the admin
// can fix the file before any calculation produces NaN.
//
// Validates the v3 schema (English keys). A v2 config must go
// through `migrateConfig` (lib/migrations.js) first — this module
// rejects v2 input up front to prevent leaks of the old shape.
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
  'buffer_3xl_eur_pack',
  'surcharge_4xl_eur',
  'surcharge_5xl_eur',
  'roly_shipping_eur_bundle',
  'garments_per_bundle',
  'dtf_eur_meter',
  'dtf_meters_two_sides',
  'dtf_meters_one_side',
  'pressing_eur_side',
  'minutes_two_sides_base',
  'minutes_one_side_base'
];

const REQUIRED_ROLY_MODELS = ['BEAGLE', 'CLASICA', 'URBAN'];

const PRICE_GROUPS_CREW = ['without_hood', 'with_hood'];
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
    return ['El config está en formato v2 y debe migrarse a v3 antes de validar (migrateConfig).'];
  }

  validateParameters(cfg.parameters, errors);
  validateRolyModels(cfg.roly_models, errors);
  validateTiers(cfg.tiers, errors);
  validatePacks(cfg, errors);
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

  // Optional extras. Accept absence; reject negatives.
  for (const key of ['extra_name_eur', 'extra_short_sleeve_eur', 'extra_long_sleeve_eur']) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`"parameters.${key}" debe ser un número >= 0 (recibido: ${describe(value)}).`);
    }
  }
}

// ------------------------------------------------------------
// Roly models
// ------------------------------------------------------------
function validateRolyModels(models, errors) {
  if (!isPlainObject(models)) {
    errors.push('Falta la sección "roly_models" o no es un objeto.');
    return;
  }
  for (const key of REQUIRED_ROLY_MODELS) {
    const path = `roly_models.${key}`;
    const model = models[key];
    if (!isPlainObject(model)) {
      errors.push(`Falta el modelo "${path}".`);
      continue;
    }
    if (typeof model.name !== 'string' || model.name.trim() === '') {
      errors.push(`"${path}.name" debe ser un texto no vacío.`);
    }
    if (typeof model.ref !== 'string') {
      errors.push(`"${path}.ref" debe ser un texto.`);
    }
    if (!Number.isFinite(model.price)) {
      errors.push(`"${path}.price" debe ser un número.`);
    } else if (model.price < 0) {
      errors.push(`"${path}.price" no puede ser negativo (recibido: ${model.price}).`);
    }
  }
}

// ------------------------------------------------------------
// Tiers (volume tiers)
// ------------------------------------------------------------
function validateTiers(tiers, errors) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push('"tiers" debe ser un array con al menos un tramo.');
    return;
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
}

// ------------------------------------------------------------
// Packs
// ------------------------------------------------------------
function validatePacks(cfg, errors) {
  const packs = cfg.packs;
  if (!isPlainObject(packs)) {
    errors.push('Falta la sección "packs" o no es un objeto.');
    return;
  }
  if (Object.keys(packs).length === 0) {
    errors.push('La sección "packs" está vacía.');
    return;
  }

  const tierIds = Array.isArray(cfg.tiers)
    ? cfg.tiers.filter(t => t && typeof t.id === 'string').map(t => t.id)
    : [];

  for (const [packId, pack] of Object.entries(packs)) {
    const path = `packs.${packId}`;
    if (!isPlainObject(pack)) {
      errors.push(`"${path}" debe ser un objeto.`);
      continue;
    }
    if (typeof pack.type !== 'string') {
      errors.push(`"${path}.type" debe ser un texto.`);
      continue;
    }
    if (typeof pack.name !== 'string' || pack.name.trim() === '') {
      errors.push(`"${path}.name" debe ser un texto no vacío.`);
    }

    if (pack.type === 'crew') {
      validatePriceGroup(pack.prices, path + '.prices', tierIds, /*crew*/ true, errors);
      requirePositiveNumber(pack.min, path + '.min', errors);
    } else if (pack.type === 'single') {
      if (typeof pack.model !== 'string') {
        errors.push(`"${path}.model" debe ser un texto.`);
      } else if (cfg.roly_models && !cfg.roly_models[pack.model]) {
        errors.push(`"${path}.model" referencia un modelo que no existe en "roly_models": ${pack.model}.`);
      }
      validatePriceGroup(pack.prices, path + '.prices', tierIds, /*crew*/ false, errors);
      requirePositiveNumber(pack.min, path + '.min', errors);
    } else if (pack.type === 'mixed') {
      requirePositiveNumber(pack.min_total, path + '.min_total', errors);
      if (!isPlainObject(pack.reference_packs)) {
        errors.push(`"${path}.reference_packs" debe ser un objeto.`);
      } else {
        for (const [model, refPackId] of Object.entries(pack.reference_packs)) {
          if (typeof refPackId !== 'string' || !packs[refPackId]) {
            errors.push(`"${path}.reference_packs.${model}" apunta a un pack inexistente: ${describe(refPackId)}.`);
          }
        }
      }
    } else if (pack.type === 'custom') {
      requirePositiveNumber(pack.min_total, path + '.min_total', errors);
      if (!isPlainObject(pack.reference_models)) {
        errors.push(`"${path}.reference_models" debe ser un objeto.`);
      } else {
        for (const [model, refPackId] of Object.entries(pack.reference_models)) {
          if (typeof refPackId !== 'string' || !packs[refPackId]) {
            errors.push(`"${path}.reference_models.${model}" apunta a un pack inexistente: ${describe(refPackId)}.`);
          }
        }
      }
    } else {
      errors.push(`"${path}.type" tiene un valor no soportado: ${describe(pack.type)}.`);
    }
  }
}

function validatePriceGroup(prices, path, tierIds, isCrew, errors) {
  if (!isPlainObject(prices)) {
    errors.push(`Falta "${path}" o no es un objeto.`);
    return;
  }

  if (isCrew) {
    for (const group of PRICE_GROUPS_CREW) {
      const groupPrices = prices[group];
      if (!isPlainObject(groupPrices)) {
        errors.push(`Falta "${path}.${group}" o no es un objeto.`);
        continue;
      }
      for (const face of PRICE_FACES) {
        validatePriceFace(groupPrices[face], `${path}.${group}.${face}`, tierIds, errors);
      }
    }
  } else {
    for (const face of PRICE_FACES) {
      validatePriceFace(prices[face], `${path}.${face}`, tierIds, errors);
    }
  }
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
  REQUIRED_PARAMETERS,
  REQUIRED_ROLY_MODELS
};
