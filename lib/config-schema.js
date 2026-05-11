// ============================================================
// PackPrice · Strict config schema validator
// ============================================================
// Goes beyond `validarFormaConfig` (lib/config-parser.js, legacy):
// it walks every field the calculator depends on and returns a
// list of errors with a precise dotted path. Used in `config:read`
// to fail fast with a human-readable message in Spanish so the
// admin can fix the file before any calculation produces NaN.
//
// Why a separate module:
//   - Pure: no fs, no Electron, no globals -> trivial to unit test.
//   - English identifiers per CLAUDE.md §2 (new code policy).
//   - User-facing messages remain in Spanish (CLAUDE.md §4.5).
// ============================================================

'use strict';

const REQUIRED_PARAMETERS = [
  'mo_eur_hora',
  'iva',
  'merma_pct',
  'indirectos_eur_prenda',
  'buffer_3xl_eur_pack',
  'recargo_4xl_eur',
  'recargo_5xl_eur',
  'envio_roly_eur_bulto',
  'prendas_por_bulto',
  'dtf_eur_metro',
  'dtf_metros_2caras',
  'dtf_metros_1cara',
  'planchado_eur_cara',
  'minutos_2caras_base',
  'minutos_1cara_base'
];

const REQUIRED_ROLY_MODELS = ['BEAGLE', 'CLASICA', 'URBAN'];

const PVP_GROUPS_PENA = ['sin_capucha', 'con_capucha'];
const PVP_FACES = ['dos_caras', 'una_cara'];

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
  }

  validateParameters(cfg.parametros, errors);
  validateRolyModels(cfg.modelos_roly, errors);
  validateTramos(cfg.tramos, errors);
  validatePacks(cfg, errors);
  validateAdmin(cfg.admin, errors);

  return errors;
}

/**
 * Throws an Error with the joined list of validation errors when
 * the config is invalid. Use this in main.js right after parsing
 * a config to short-circuit downstream code with a clear message.
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
    errors.push('Falta la sección "parametros" o no es un objeto.');
    return;
  }
  for (const key of REQUIRED_PARAMETERS) {
    const path = `parametros.${key}`;
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

  if (Number.isFinite(params.iva) && (params.iva < 0 || params.iva > 1)) {
    errors.push(`"parametros.iva" debe estar entre 0 y 1 (recibido: ${params.iva}). Usa 0.21 para 21%.`);
  }
  if (Number.isFinite(params.merma_pct) && (params.merma_pct < 0 || params.merma_pct > 1)) {
    errors.push(`"parametros.merma_pct" debe estar entre 0 y 1 (recibido: ${params.merma_pct}).`);
  }
  if (Number.isFinite(params.prendas_por_bulto) && params.prendas_por_bulto < 1) {
    errors.push(`"parametros.prendas_por_bulto" debe ser >= 1 (recibido: ${params.prendas_por_bulto}).`);
  }

  // Optional extras (introduced in 2.x). Accept absence; reject negatives.
  for (const key of ['extra_nombre_eur', 'extra_manga_corta_eur', 'extra_manga_larga_eur']) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`"parametros.${key}" debe ser un número >= 0 (recibido: ${describe(value)}).`);
    }
  }
}

// ------------------------------------------------------------
// Roly models
// ------------------------------------------------------------
function validateRolyModels(models, errors) {
  if (!isPlainObject(models)) {
    errors.push('Falta la sección "modelos_roly" o no es un objeto.');
    return;
  }
  for (const key of REQUIRED_ROLY_MODELS) {
    const path = `modelos_roly.${key}`;
    const model = models[key];
    if (!isPlainObject(model)) {
      errors.push(`Falta el modelo "${path}".`);
      continue;
    }
    if (typeof model.nombre !== 'string' || model.nombre.trim() === '') {
      errors.push(`"${path}.nombre" debe ser un texto no vacío.`);
    }
    if (typeof model.ref !== 'string') {
      errors.push(`"${path}.ref" debe ser un texto.`);
    }
    if (!Number.isFinite(model.precio)) {
      errors.push(`"${path}.precio" debe ser un número.`);
    } else if (model.precio < 0) {
      errors.push(`"${path}.precio" no puede ser negativo (recibido: ${model.precio}).`);
    }
  }
}

// ------------------------------------------------------------
// Tramos (volume tiers)
// ------------------------------------------------------------
function validateTramos(tramos, errors) {
  if (!Array.isArray(tramos) || tramos.length === 0) {
    errors.push('"tramos" debe ser un array con al menos un tramo.');
    return;
  }
  let prevHasta = -Infinity;
  tramos.forEach((tramo, index) => {
    const path = `tramos[${index}]`;
    if (!isPlainObject(tramo)) {
      errors.push(`"${path}" debe ser un objeto.`);
      return;
    }
    if (typeof tramo.id !== 'string' || tramo.id.trim() === '') {
      errors.push(`"${path}.id" debe ser un texto no vacío.`);
    }
    if (!Number.isFinite(tramo.desde) || tramo.desde < 1) {
      errors.push(`"${path}.desde" debe ser un número >= 1 (recibido: ${describe(tramo.desde)}).`);
    }
    if (tramo.hasta !== null && tramo.hasta !== undefined) {
      if (!Number.isFinite(tramo.hasta)) {
        errors.push(`"${path}.hasta" debe ser un número o null (recibido: ${describe(tramo.hasta)}).`);
      } else if (Number.isFinite(tramo.desde) && tramo.hasta < tramo.desde) {
        errors.push(`"${path}.hasta" (${tramo.hasta}) no puede ser menor que "desde" (${tramo.desde}).`);
      }
    }
    if (Number.isFinite(tramo.desde) && tramo.desde <= prevHasta) {
      errors.push(`"${path}.desde" (${tramo.desde}) se solapa con el tramo anterior (hasta ${prevHasta}).`);
    }
    if (tramo.reduccion_tiempo !== undefined && tramo.reduccion_tiempo !== null) {
      if (!Number.isFinite(tramo.reduccion_tiempo) || tramo.reduccion_tiempo < 0 || tramo.reduccion_tiempo >= 1) {
        errors.push(`"${path}.reduccion_tiempo" debe estar en [0, 1) (recibido: ${describe(tramo.reduccion_tiempo)}).`);
      }
    }
    prevHasta = (tramo.hasta === null || tramo.hasta === undefined)
      ? Number.POSITIVE_INFINITY
      : tramo.hasta;
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

  const tramoIds = Array.isArray(cfg.tramos)
    ? cfg.tramos.filter(t => t && typeof t.id === 'string').map(t => t.id)
    : [];

  for (const [packId, pack] of Object.entries(packs)) {
    const path = `packs.${packId}`;
    if (!isPlainObject(pack)) {
      errors.push(`"${path}" debe ser un objeto.`);
      continue;
    }
    if (typeof pack.tipo !== 'string') {
      errors.push(`"${path}.tipo" debe ser un texto.`);
      continue;
    }
    if (typeof pack.nombre !== 'string' || pack.nombre.trim() === '') {
      errors.push(`"${path}.nombre" debe ser un texto no vacío.`);
    }

    if (pack.tipo === 'pena') {
      validatePvpGroup(pack.pvp, path + '.pvp', tramoIds, /*pena*/ true, errors);
      requirePositiveNumber(pack.min, path + '.min', errors);
    } else if (pack.tipo === 'individual') {
      if (typeof pack.modelo !== 'string') {
        errors.push(`"${path}.modelo" debe ser un texto.`);
      } else if (cfg.modelos_roly && !cfg.modelos_roly[pack.modelo]) {
        errors.push(`"${path}.modelo" referencia un modelo que no existe en "modelos_roly": ${pack.modelo}.`);
      }
      validatePvpGroup(pack.pvp, path + '.pvp', tramoIds, /*pena*/ false, errors);
      requirePositiveNumber(pack.min, path + '.min', errors);
    } else if (pack.tipo === 'mixto') {
      requirePositiveNumber(pack.min_total, path + '.min_total', errors);
      if (!isPlainObject(pack.packs_referencia)) {
        errors.push(`"${path}.packs_referencia" debe ser un objeto.`);
      } else {
        for (const [model, refPackId] of Object.entries(pack.packs_referencia)) {
          if (typeof refPackId !== 'string' || !packs[refPackId]) {
            errors.push(`"${path}.packs_referencia.${model}" apunta a un pack inexistente: ${describe(refPackId)}.`);
          }
        }
      }
    } else if (pack.tipo === 'personalizado') {
      requirePositiveNumber(pack.min_total, path + '.min_total', errors);
      if (!isPlainObject(pack.modelos_referencia)) {
        errors.push(`"${path}.modelos_referencia" debe ser un objeto.`);
      } else {
        for (const [model, refPackId] of Object.entries(pack.modelos_referencia)) {
          if (typeof refPackId !== 'string' || !packs[refPackId]) {
            errors.push(`"${path}.modelos_referencia.${model}" apunta a un pack inexistente: ${describe(refPackId)}.`);
          }
        }
      }
    } else {
      errors.push(`"${path}.tipo" tiene un valor no soportado: ${describe(pack.tipo)}.`);
    }
  }
}

function validatePvpGroup(pvp, path, tramoIds, isPena, errors) {
  if (!isPlainObject(pvp)) {
    errors.push(`Falta "${path}" o no es un objeto.`);
    return;
  }

  if (isPena) {
    for (const group of PVP_GROUPS_PENA) {
      const groupPvp = pvp[group];
      if (!isPlainObject(groupPvp)) {
        errors.push(`Falta "${path}.${group}" o no es un objeto.`);
        continue;
      }
      for (const face of PVP_FACES) {
        validatePvpFace(groupPvp[face], `${path}.${group}.${face}`, tramoIds, errors);
      }
    }
  } else {
    for (const face of PVP_FACES) {
      validatePvpFace(pvp[face], `${path}.${face}`, tramoIds, errors);
    }
  }
}

function validatePvpFace(faceObj, path, tramoIds, errors) {
  if (!isPlainObject(faceObj)) {
    errors.push(`Falta "${path}" o no es un objeto.`);
    return;
  }
  for (const tramoId of tramoIds) {
    const value = faceObj[tramoId];
    if (value === undefined || value === null) {
      errors.push(`Falta PVP "${path}.${tramoId}".`);
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`"${path}.${tramoId}" debe ser un número >= 0 (recibido: ${describe(value)}).`);
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
  // The renderer-side config has `tiene_clave` (boolean) instead
  // of the raw `clave`. Accept both shapes; reject neither.
  const hasRawClave = typeof admin.clave === 'string' && admin.clave.length > 0;
  const hasFlag = admin.tiene_clave === true;
  if (!hasRawClave && !hasFlag) {
    errors.push('"admin.clave" debe ser un texto no vacío (o tiene_clave=true en el renderer).');
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
