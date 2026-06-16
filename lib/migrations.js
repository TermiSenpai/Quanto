// ============================================================
// Quanto · Data migrations (v2 → v3 → v4)
// ============================================================
// This is the SINGLE place that knows about the old data shapes
// (v2 Spanish keys, v3 English keys). Every other module assumes
// pure v4. Migration functions run when data ENTERS the system:
//
//   migrateConfig(raw)         → config.js on the NAS (chains v2→v3→v4)
//   migrateQuote(raw)          → presupuestos.json entries (local)
//   migrateSettings(raw)       → settings.json (per-PC, %APPDATA%)
//   normalizeAuditEntry(raw)   → audit.log lines (append-only NAS)
//
// All are idempotent: feeding an already-current value returns it
// unchanged (same reference for v4 config, so config-store's
// `didMigrate = migrated !== raw` keeps working). See CLAUDE.md
// §6.3 and planes/migracion-codigo-ingles.md.
//
// User-facing values (model `name`, tier `label`, `terms`, company
// data, pack `name`) are NOT translated — only the structural keys.
// ============================================================

'use strict';

const { DEFAULT_TARGET_MARGIN } = require('../config.default.js');

// ------------------------------------------------------------
// Rename tables (v2 key → v3 key)
// ------------------------------------------------------------
const PARAMETER_KEY_MAP = {
  mo_eur_hora:           'labor_eur_hour',
  iva:                   'vat',
  merma_pct:             'waste_pct',
  indirectos_eur_prenda: 'overhead_eur_garment',
  buffer_3xl_eur_pack:   'buffer_3xl_eur_pack',
  recargo_4xl_eur:       'surcharge_4xl_eur',
  recargo_5xl_eur:       'surcharge_5xl_eur',
  envio_roly_eur_bulto:  'roly_shipping_eur_bundle',
  prendas_por_bulto:     'garments_per_bundle',
  dtf_eur_metro:         'dtf_eur_meter',
  dtf_metros_2caras:     'dtf_meters_two_sides',
  dtf_metros_1cara:      'dtf_meters_one_side',
  planchado_eur_cara:    'pressing_eur_side',
  minutos_2caras_base:   'minutes_two_sides_base',
  minutos_1cara_base:    'minutes_one_side_base',
  extra_nombre_eur:      'extra_name_eur',
  extra_manga_corta_eur: 'extra_short_sleeve_eur',
  extra_manga_larga_eur: 'extra_long_sleeve_eur'
};

const PACK_ID_MAP = {
  pena_completa:   'crew_full',
  solo_camisetas:  'tshirts_only',
  solo_clasica:    'classic_only',
  solo_urban:      'urban_only',
  sudaderas_mixto: 'hoodies_mixed',
  personalizado:   'custom'
};

const PACK_TYPE_MAP = {
  pena:          'crew',
  individual:    'single',
  mixto:         'mixed',
  personalizado: 'custom'
};

const PRICE_KEY_MAP = {
  con_capucha: 'with_hood',
  sin_capucha: 'without_hood',
  dos_caras:   'two_sides',
  una_cara:    'one_side'
};

const COMPANY_KEY_MAP = {
  nombre:    'name',
  cif:       'tax_id',
  direccion: 'address',
  telefono:  'phone',
  email:     'email',
  web:       'web'
};

const QUOTE_SETTINGS_KEY_MAP = {
  validez_dias: 'validity_days',
  condiciones:  'terms'
};

const TIER_KEY_MAP = {
  id:               'id',
  etiqueta:         'label',
  desde:            'from',
  hasta:            'to',
  reduccion_tiempo: 'time_reduction'
};

const ROLY_MODEL_KEY_MAP = {
  nombre: 'name',
  ref:    'ref',
  precio: 'price'
};

// Calculation result shape (§4.2). `pack`, `subtotal` keep their name.
const RESULT_KEY_MAP = {
  tramo:           'tier',
  cantidad:        'quantity',
  cantidad_total:  'total_quantity',
  pvp_unitario:    'unit_price',
  cant_4xl:        'qty_4xl',
  cant_5xl:        'qty_5xl',
  caras:           'sides',
  recargos:        'surcharges',
  extras_sin_iva:  'extras_no_vat',
  extras_detalle:  'extras_detail',
  total_iva_inc:   'total_vat_inc',
  base_venta:      'sale_base',
  iva:             'vat',
  coste_unitario:  'unit_cost',
  coste_total:     'total_cost',
  margen:          'margin',
  margen_pct:      'margin_pct',
  desglose:        'breakdown',
  es_mixto:        'is_mixed',
  es_personalizado: 'is_custom'
};

const EXTRAS_DETAIL_KEY_MAP = {
  nombres:       'names',
  mangas_cortas: 'short_sleeves',
  mangas_largas: 'long_sleeves'
};

const BREAKDOWN_KEY_MAP = {
  modelo:   'model',
  nombre:   'name',
  cantidad: 'quantity',
  pvp:      'price',
  caras:    'sides'
};

const EXTRA_KEY_MAP = {
  capucha: 'hood',
  modelo:  'model',
  caras:   'sides'
};

const QUOTE_META_KEY_MAP = {
  fecha:   'date',
  usuario: 'user',
  tipo:    'type'
};

const CUSTOMER_KEY_MAP = {
  nombre:    'name',
  telefono:  'phone',
  email:     'email',
  notas:     'notes'
};

// ------------------------------------------------------------
// Generic helpers
// ------------------------------------------------------------
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Renames the keys of a flat object using `map`. Keys absent from
 * the map are kept as-is, so unknown extra fields survive.
 */
function renameKeys(obj, map) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[map[key] || key] = value;
  }
  return out;
}

// ------------------------------------------------------------
// Config (config.js on the NAS)
// ------------------------------------------------------------
/**
 * Migrates a parsed config to v4, chaining v2→v3→v4 as needed.
 * Idempotent: a v4 config is returned untouched (same reference, so
 * the lazy-migration store can compare by identity). A v2 or v3
 * input yields a NEW object. Throws a clear (Spanish) error if the
 * input is not a plain object or lacks the required v2 sections.
 *
 * @param {object} raw  parsed config (v2, v3 or v4)
 * @returns {object} v4 config
 */
function migrateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('Config inválido: se esperaba un objeto.');
  }
  if (typeof raw.version === 'string' && /^4\./.test(raw.version)) {
    return raw; // already v4 — same reference
  }
  const v3 = (typeof raw.version === 'string' && /^3\./.test(raw.version))
    ? raw
    : mapConfigV2ToV3(raw);
  return migrateConfigV3ToV4(v3);
}

function mapConfigV2ToV3(raw) {
  const requiredV2 = ['parametros', 'modelos_roly', 'tramos', 'packs', 'admin'];
  for (const section of requiredV2) {
    if (!(section in raw)) {
      throw new Error(`No se puede migrar el config: falta la sección "${section}".`);
    }
  }

  const admin = isPlainObject(raw.admin) ? raw.admin : {};
  const migratedAdmin = {};
  for (const [key, value] of Object.entries(admin)) {
    if (key === 'clave') migratedAdmin.password = value;
    else if (key === 'tiene_clave') migratedAdmin.has_password = value;
    else migratedAdmin[key] = value;
  }

  return {
    version:     '3.0.0',
    updated_at:  raw.fecha_actualizacion,
    modified_by: raw.modificado_por,
    admin:       migratedAdmin,
    parameters:  renameKeys(raw.parametros, PARAMETER_KEY_MAP),
    roly_models: mapRolyModels(raw.modelos_roly),
    tiers:       (raw.tramos || []).map(tier => renameKeys(tier, TIER_KEY_MAP)),
    packs:       mapPacks(raw.packs),
    company:     raw.empresa ? renameKeys(raw.empresa, COMPANY_KEY_MAP) : undefined,
    quote_settings: raw.presupuesto ? renameKeys(raw.presupuesto, QUOTE_SETTINGS_KEY_MAP) : undefined
  };
}

function mapRolyModels(models) {
  const out = {};
  for (const [id, model] of Object.entries(models || {})) {
    out[id] = renameKeys(model, ROLY_MODEL_KEY_MAP);
  }
  return out;
}

function mapPacks(packs) {
  const out = {};
  for (const [oldId, pack] of Object.entries(packs || {})) {
    const newId = PACK_ID_MAP[oldId] || oldId;
    out[newId] = mapPack(pack);
  }
  return out;
}

function mapPack(pack) {
  if (!isPlainObject(pack)) return pack;
  const out = {};
  for (const [key, value] of Object.entries(pack)) {
    switch (key) {
      case 'tipo':   out.type = PACK_TYPE_MAP[value] || value; break;
      case 'nombre': out.name = value; break;
      case 'modelo': out.model = value; break;
      case 'pvp':    out.prices = mapPrices(value); break;
      case 'packs_referencia':   out.reference_packs = mapReferenceMap(value); break;
      case 'modelos_referencia': out.reference_models = mapReferenceMap(value); break;
      default:       out[key] = value; // min, min_total, …
    }
  }
  return out;
}

/**
 * Recursively renames price-structure keys (con_capucha, sin_capucha,
 * dos_caras, una_cara) while leaving tier ids (T1..T4) and numeric
 * leaves untouched. Handles both crew (two levels) and single
 * (one level) price trees.
 */
function mapPrices(node) {
  if (!isPlainObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[PRICE_KEY_MAP[key] || key] = mapPrices(value);
  }
  return out;
}

/** Maps `{ <RolyModelId>: <pack_id> }`: keys stay, values are pack ids. */
function mapReferenceMap(refMap) {
  if (!isPlainObject(refMap)) return refMap;
  const out = {};
  for (const [modelId, packId] of Object.entries(refMap)) {
    out[modelId] = PACK_ID_MAP[packId] || packId;
  }
  return out;
}

// ------------------------------------------------------------
// Config v3 → v4
// ------------------------------------------------------------
// v4 generalizes the catalog: roly_models → products (with their own
// price table, suppliers and 3XL cost), the fixed extra_* params →
// configurable addons, and pack `type` → `pricing_mode` + declared
// options/components. See config.default.js for the frozen shape.

const PRODUCT_CATEGORY = {
  BEAGLE:  'tshirt',
  CLASICA: 'hoodie',
  URBAN:   'hoodie'
};

const PRODUCT_EXTRA_3XL = {
  tshirt: 0.40,
  hoodie: 0.60
};

const PACK_ICON = {
  crew_full:    'i-pack',
  tshirts_only: 'i-shirt',
  classic_only: 'i-hoodie',
  urban_only:   'i-hoodie',
  hoodies_mixed: 'i-hoodie',
  custom:       'i-pack'
};

/**
 * Migrates a v3 config to v4. Idempotent: a v4 input is returned
 * untouched (same reference). Pure: returns a fresh object for v3.
 *
 * @param {object} v3  a v3 config (English keys)
 * @returns {object} v4 config
 */
function migrateConfigV3ToV4(v3) {
  if (!isPlainObject(v3)) {
    throw new Error('Config inválido: se esperaba un objeto.');
  }
  if (typeof v3.version === 'string' && /^4\./.test(v3.version)) {
    return v3; // already v4
  }

  const rolyModels = isPlainObject(v3.roly_models) ? v3.roly_models : {};
  const v3packs = isPlainObject(v3.packs) ? v3.packs : {};

  // Index of single packs by their `model`, to copy price tables.
  const singlePriceByModel = {};
  for (const pack of Object.values(v3packs)) {
    if (pack && pack.type === 'single' && typeof pack.model === 'string' && isPlainObject(pack.prices)) {
      singlePriceByModel[pack.model] = pack.prices;
    }
  }

  const products = {};
  for (const [id, model] of Object.entries(rolyModels)) {
    const category = PRODUCT_CATEGORY[id] || 'other';
    const extra3xl = PRODUCT_EXTRA_3XL[category] !== undefined
      ? PRODUCT_EXTRA_3XL[category]
      : 0.40;
    products[id] = {
      name:           model.name,
      category,
      extra_cost_3xl: extra3xl,
      target_margin:  DEFAULT_TARGET_MARGIN,
      suppliers: [
        { supplier: 'ROLY', ref: model.ref, price: model.price, min_order: 0, is_default: true }
      ],
      prices: singlePriceByModel[id]
        ? JSON.parse(JSON.stringify(singlePriceByModel[id]))
        : {}
    };
  }

  const params = isPlainObject(v3.parameters) ? v3.parameters : {};
  const parameters = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'buffer_3xl_eur_pack') continue;
    if (key === 'extra_name_eur' || key === 'extra_short_sleeve_eur' || key === 'extra_long_sleeve_eur') continue;
    parameters[key] = value;
  }
  parameters.default_target_margin = DEFAULT_TARGET_MARGIN;
  parameters.price_rounding_ending = 0.95;

  const addons = {
    name:         { label: 'Nombre',      price: params.extra_name_eur != null ? params.extra_name_eur : 1.5, vat_included: false, cost: 0.20, applies_to: ['*'] },
    short_sleeve: { label: 'Manga corta', price: params.extra_short_sleeve_eur != null ? params.extra_short_sleeve_eur : 1.5, vat_included: false, cost: 0.20, applies_to: ['tshirt'] },
    long_sleeve:  { label: 'Manga larga', price: params.extra_long_sleeve_eur != null ? params.extra_long_sleeve_eur : 3, vat_included: false, cost: 0.40, applies_to: ['hoodie'] }
  };

  const packs = {};
  for (const [packId, pack] of Object.entries(v3packs)) {
    packs[packId] = mapPackV3ToV4(packId, pack);
  }

  return {
    version:     '4.0.0',
    updated_at:  v3.updated_at,
    modified_by: v3.modified_by,
    admin:       v3.admin,
    parameters,
    suppliers:   { ROLY: { name: 'Roly', web: '', notes: '' } },
    products,
    tiers:       v3.tiers,
    addons,
    packs,
    company:     v3.company,
    quote_settings: v3.quote_settings
  };
}

const SIDES_OPTION = {
  id: 'sides',
  label: 'Caras',
  values: [
    { id: 'one_side', label: '1 cara', sides: 1 },
    { id: 'two_sides', label: '2 caras', sides: 2 }
  ]
};

function mapPackV3ToV4(packId, pack) {
  if (!isPlainObject(pack)) return pack;
  const icon = PACK_ICON[packId] || 'i-pack';
  const minTotal = (pack.min_total != null) ? pack.min_total
    : (pack.min != null ? pack.min : 10);

  if (pack.type === 'crew') {
    // crew → bundle. options [hood, sides]; components tshirt/sweatshirt
    // with maps_product. bundle_prices from prices[hood][sides][tier].
    const bundlePrices = {};
    const prices = isPlainObject(pack.prices) ? pack.prices : {};
    for (const hood of ['without_hood', 'with_hood']) {
      for (const sides of ['one_side', 'two_sides']) {
        const node = prices[hood] && prices[hood][sides];
        if (isPlainObject(node)) {
          bundlePrices[`${hood}|${sides}`] = JSON.parse(JSON.stringify(node));
        }
      }
    }
    return {
      name:          pack.name,
      description:   'Camiseta + sudadera por persona',
      icon,
      pricing_mode:  'bundle',
      min_total:     minTotal,
      target_margin: DEFAULT_TARGET_MARGIN,
      options: [
        {
          id: 'hood', label: 'Capucha',
          values: [
            { id: 'without_hood', label: 'Sin capucha' },
            { id: 'with_hood', label: 'Con capucha' }
          ],
          maps_product: { component: 'sweatshirt', without_hood: 'CLASICA', with_hood: 'URBAN' }
        },
        clone(SIDES_OPTION)
      ],
      components: [
        { id: 'tshirt',     label: 'Camiseta', product: 'BEAGLE',  qty_per_pack: 1 },
        { id: 'sweatshirt', label: 'Sudadera', product: 'CLASICA', qty_per_pack: 1 }
      ],
      bundle_prices: bundlePrices
    };
  }

  if (pack.type === 'single') {
    // single → components with one component referencing pack.model.
    return {
      name:          pack.name,
      description:   pack.name,
      icon,
      pricing_mode:  'components',
      min_total:     minTotal,
      target_margin: DEFAULT_TARGET_MARGIN,
      options: [clone(SIDES_OPTION)],
      components: [
        { id: componentIdForModel(pack.model), label: pack.name, product: pack.model }
      ]
    };
  }

  if (pack.type === 'mixed') {
    // mixed → components CLASICA + URBAN.
    return {
      name:          pack.name,
      description:   'Mezcla de sudaderas con y sin capucha',
      icon,
      pricing_mode:  'components',
      min_total:     minTotal,
      target_margin: DEFAULT_TARGET_MARGIN,
      options: [clone(SIDES_OPTION)],
      components: [
        { id: 'classic', label: 'Sin capucha', product: 'CLASICA' },
        { id: 'urban',   label: 'Con capucha', product: 'URBAN' }
      ]
    };
  }

  if (pack.type === 'custom') {
    // custom → components, free_components.
    return {
      name:            pack.name,
      description:     'Elige productos y cantidades libremente',
      icon,
      pricing_mode:    'components',
      min_total:       minTotal,
      target_margin:   DEFAULT_TARGET_MARGIN,
      free_components: true,
      options: [clone(SIDES_OPTION)],
      components: []
    };
  }

  // Unknown type: pass through (validator will flag it).
  return pack;
}

function componentIdForModel(model) {
  if (model === 'BEAGLE') return 'tshirt';
  return 'sweatshirt';
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ------------------------------------------------------------
// Calculation result (used by quotes / PDF / history)
// ------------------------------------------------------------
/**
 * Renames a calculation result object to v3 keys, including its
 * nested `breakdown`, `extras_detail` and `extra` members.
 * Idempotent for already-v3 results (v3 keys are not in the maps).
 */
function migrateResult(result) {
  if (!isPlainObject(result)) return result;
  const out = renameKeys(result, RESULT_KEY_MAP);

  if (isPlainObject(out.extras_detail)) {
    out.extras_detail = renameKeys(out.extras_detail, EXTRAS_DETAIL_KEY_MAP);
  }
  if (Array.isArray(out.breakdown)) {
    out.breakdown = out.breakdown.map(item =>
      isPlainObject(item) ? renameKeys(item, BREAKDOWN_KEY_MAP) : item);
  }
  if (isPlainObject(out.extra)) {
    out.extra = renameKeys(out.extra, EXTRA_KEY_MAP);
  }
  return out;
}

// ------------------------------------------------------------
// Quote (presupuestos.json entries)
// ------------------------------------------------------------
/**
 * Migrates a stored quote to v3. Renames metadata (fecha, usuario,
 * tipo, cliente.*) and the embedded result keys. Idempotent.
 *
 * @param {object} raw
 * @returns {object} v3 quote
 */
function migrateQuote(raw) {
  if (!isPlainObject(raw)) {
    throw new Error('Presupuesto inválido: se esperaba un objeto.');
  }
  // Rename the embedded result first, then the metadata keys.
  const out = migrateResult(raw);
  const meta = renameKeys(out, QUOTE_META_KEY_MAP);

  if (isPlainObject(meta.cliente)) {
    meta.customer = renameKeys(meta.cliente, CUSTOMER_KEY_MAP);
    delete meta.cliente;
  }
  if (isPlainObject(meta.totales)) {
    meta.totals = migrateResult(meta.totales);
    delete meta.totales;
  }
  return meta;
}

// ------------------------------------------------------------
// Settings (settings.json, per-PC)
// ------------------------------------------------------------
const SETTINGS_KEY_MAP = {
  ruta_config:    'config_path',
  nombre_usuario: 'user_name'
};

/**
 * Migrates per-PC settings to v3. Idempotent.
 * @param {object} raw
 * @returns {object} v3 settings
 */
function migrateSettings(raw) {
  if (!isPlainObject(raw)) return raw;
  return renameKeys(raw, SETTINGS_KEY_MAP);
}

// ------------------------------------------------------------
// Audit entry (audit.log, append-only — never rewritten on disk)
// ------------------------------------------------------------
/**
 * Normalizes an audit log entry to v3 in memory. Accepts either
 * v2 (`usuario`, `cambios`) or v3 (`user`, `changes`) and returns
 * the v3 shape. The on-disk log stays bi-modal by design (§8 of
 * the migration plan).
 *
 * @param {object} raw
 * @returns {object} v3 audit entry
 */
function normalizeAuditEntry(raw) {
  if (!isPlainObject(raw)) return raw;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'usuario') out.user = value;
    else if (key === 'cambios') out.changes = value;
    else out[key] = value;
  }
  return out;
}

module.exports = {
  migrateConfig,
  migrateConfigV3ToV4,
  migrateQuote,
  migrateResult,
  migrateSettings,
  normalizeAuditEntry,
  // Rename tables exported for tests / downstream reuse.
  PARAMETER_KEY_MAP,
  PACK_ID_MAP,
  PACK_TYPE_MAP,
  PRICE_KEY_MAP,
  RESULT_KEY_MAP,
  PRODUCT_CATEGORY,
  PRODUCT_EXTRA_3XL
};
