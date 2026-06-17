// ============================================================
// Canonical v4 full-catalog fixture (English keys)
// ============================================================
// The catalog that used to be config.default.js's buildDefaultConfig().
// The product no longer ships a default catalog (the first-run wizard
// builds it from blank), so this full v4 seed is preserved HERE, ONLY
// as a test fixture, so tests that need a complete, valid catalog keep
// one. Copied verbatim from the pre-rename config.default.js
// (git show HEAD:config.default.js).
//
// User-facing values (product `name`, tier `label`, addon `label`,
// pack `name`/`description`, company data, `terms`) stay in Spanish
// because they are rendered to the user (mirrors the original file).
// ============================================================

'use strict';

const VERSION = '4.0.0';
const ADMIN_PASSWORD_DEFAULT = 'fuzfuz2026';
const DEFAULT_TARGET_MARGIN = 0.35;

// --- Base parameters ---
// Note: the legacy fixed `buffer_3xl_eur_pack` is gone; 3XL cost is now
// a per-garment `extra_cost_3xl` on each product (see below).
const PARAMETERS = {
  labor_eur_hour:           15,
  vat:                      0.21,
  waste_pct:                0.10,
  overhead_eur_garment:     0.30,
  surcharge_4xl_eur:        3,
  surcharge_5xl_eur:        5,
  roly_shipping_eur_bundle: 5.90,
  garments_per_bundle:      40,
  dtf_eur_meter:            1.25,
  dtf_meters_two_sides:     0.60,
  dtf_meters_one_side:      0.30,
  pressing_eur_side:        0.30,
  minutes_two_sides_base:   7,
  minutes_one_side_base:    5,
  default_target_margin:    DEFAULT_TARGET_MARGIN,
  // Psychological rounding applied to recommended prices: round UP to
  // the nearest value ending in this many cents (0.95 → x,95 / x,Y5).
  price_rounding_ending:    0.95
};

// --- Suppliers (provider registry) ---
const SUPPLIERS = {
  ROLY: { name: 'Roly', web: '', notes: '' }
};

// --- Products (garments) ---
// IDs (BEAGLE, CLASICA, URBAN) are catalog identifiers, uppercase.
// `name` values are rendered → Spanish. `category` groups products and
// decides which addons apply. `prices` is the per-garment price table
// (sides × tier), used directly by 'components' packs and as the basis
// for recommended prices. Each product lists one or more suppliers;
// exactly one is `is_default: true` and its `price` feeds cost.
// NOTE: per-product/per-pack `target_margin` is seeded here but not yet
// read by the engine (recommendedPrice currently uses
// parameters.default_target_margin); the admin/recommended-price UI
// (later phase) will consume the per-entry override.
const PRODUCTS = {
  BEAGLE: {
    name:           'Camiseta',
    category:       'tshirt',
    extra_cost_3xl: 0.40,
    target_margin:  DEFAULT_TARGET_MARGIN,
    suppliers: [
      { supplier: 'ROLY', ref: 'CA65540558', price: 1.7325, min_order: 0, is_default: true }
    ],
    prices: {
      two_sides: { T1: 11.99, T2: 10.99, T3: 9.99, T4: 8.99 },
      one_side:  { T1: 9.99,  T2: 8.99,  T3: 8.45, T4: 7.99 }
    }
  },
  CLASICA: {
    name:           'Sudadera sin capucha',
    category:       'hoodie',
    extra_cost_3xl: 0.60,
    target_margin:  DEFAULT_TARGET_MARGIN,
    suppliers: [
      { supplier: 'ROLY', ref: 'SU10700558', price: 6.2475, min_order: 0, is_default: true }
    ],
    prices: {
      two_sides: { T1: 14.95, T2: 13.95, T3: 12.95, T4: 12.45 },
      one_side:  { T1: 12.95, T2: 11.95, T3: 10.95, T4: 10.45 }
    }
  },
  URBAN: {
    name:           'Sudadera con capucha',
    category:       'hoodie',
    extra_cost_3xl: 0.60,
    target_margin:  DEFAULT_TARGET_MARGIN,
    suppliers: [
      { supplier: 'ROLY', ref: 'SU1067050258', price: 7.8750, min_order: 0, is_default: true }
    ],
    prices: {
      two_sides: { T1: 16.95, T2: 15.95, T3: 14.95, T4: 13.95 },
      one_side:  { T1: 14.95, T2: 13.95, T3: 12.95, T4: 11.95 }
    }
  }
};

// --- Volume tiers --- (`label` values rendered → Spanish)
const TIERS = [
  { id: 'T1', label: '10-24 uds', from: 10,  to: 24,   time_reduction: 0    },
  { id: 'T2', label: '25-49 uds', from: 25,  to: 49,   time_reduction: 0.10 },
  { id: 'T3', label: '50-99 uds', from: 50,  to: 99,   time_reduction: 0.15 },
  { id: 'T4', label: '100+ uds',  from: 100, to: null, time_reduction: 0.20 }
];

// --- Addons (optional configurable extras) ---
// `price` is WITHOUT VAT unless `vat_included` is true. `cost` is the
// real internal cost (DTF/labor) so margin stays honest. `applies_to`
// is a list of product categories the addon can be added to ('*' = any).
const ADDONS = {
  name:         { label: 'Nombre',      price: 1.5, vat_included: false, cost: 0.20, applies_to: ['*'] },
  short_sleeve: { label: 'Manga corta', price: 1.5, vat_included: false, cost: 0.20, applies_to: ['tshirt'] },
  long_sleeve:  { label: 'Manga larga', price: 3,   vat_included: false, cost: 0.40, applies_to: ['hoodie'] }
};

// --- Packs --- (`name`/`description` rendered → Spanish)
//
// pricing_mode:
//   'bundle'     → the pack is sold as a unit at its own `bundle_prices`
//                  table, keyed by the option-combo string (option-value
//                  ids joined with '|' in declared option order) × tier.
//                  Input is a number of packs; each pack contributes the
//                  `qty_per_pack` of every component to the garment count.
//   'components' → each component is billed at its product's own price
//                  (product.prices[sidesKey][tier]). Input is a quantity
//                  per component; the tier is computed on the sum.
//
// `options` declare selectable attributes (sides, hood, …). An option may
// carry `maps_product` to swap which product a component uses based on the
// chosen value (how the crew pack picks CLASICA vs URBAN by hood).
// `free_components: true` lets the user add arbitrary product lines (custom).
const PACKS = {
  crew_full: {
    name:          'Pack Peña (camiseta + sudadera)',
    description:   'Camiseta + sudadera por persona',
    icon:          'i-pack',
    pricing_mode:  'bundle',
    min_total:     10,
    target_margin: DEFAULT_TARGET_MARGIN,
    options: [
      { id: 'hood',  label: 'Capucha',
        values: [{ id: 'without_hood', label: 'Sin capucha' }, { id: 'with_hood', label: 'Con capucha' }],
        maps_product: { component: 'sweatshirt', without_hood: 'CLASICA', with_hood: 'URBAN' } },
      { id: 'sides', label: 'Caras',
        values: [{ id: 'one_side', label: '1 cara', sides: 1 }, { id: 'two_sides', label: '2 caras', sides: 2 }] }
    ],
    components: [
      { id: 'tshirt',     label: 'Camiseta', product: 'BEAGLE',  qty_per_pack: 1 },
      { id: 'sweatshirt', label: 'Sudadera', product: 'CLASICA', qty_per_pack: 1 }
    ],
    // keyed: `${hood}|${sides}` × tier  (IVA incl., as before)
    bundle_prices: {
      'without_hood|two_sides': { T1: 25.95, T2: 24.95, T3: 23.95, T4: 22.95 },
      'without_hood|one_side':  { T1: 22.95, T2: 21.95, T3: 20.95, T4: 19.95 },
      'with_hood|two_sides':    { T1: 28.95, T2: 27.95, T3: 26.95, T4: 25.95 },
      'with_hood|one_side':     { T1: 25.95, T2: 24.95, T3: 23.95, T4: 22.95 }
    }
  },

  tshirts_only: {
    name:          'Pack solo camisetas',
    description:   'Solo camisetas',
    icon:          'i-shirt',
    pricing_mode:  'components',
    min_total:     10,
    target_margin: DEFAULT_TARGET_MARGIN,
    options: [
      { id: 'sides', label: 'Caras',
        values: [{ id: 'one_side', label: '1 cara', sides: 1 }, { id: 'two_sides', label: '2 caras', sides: 2 }] }
    ],
    components: [
      { id: 'tshirt', label: 'Camisetas', product: 'BEAGLE' }
    ]
  },

  classic_only: {
    name:          'Pack solo sudaderas sin capucha',
    description:   'Solo sudaderas sin capucha',
    icon:          'i-hoodie',
    pricing_mode:  'components',
    min_total:     10,
    target_margin: DEFAULT_TARGET_MARGIN,
    options: [
      { id: 'sides', label: 'Caras',
        values: [{ id: 'one_side', label: '1 cara', sides: 1 }, { id: 'two_sides', label: '2 caras', sides: 2 }] }
    ],
    components: [
      { id: 'sweatshirt', label: 'Sudaderas', product: 'CLASICA' }
    ]
  },

  urban_only: {
    name:          'Pack solo sudaderas con capucha',
    description:   'Solo sudaderas con capucha',
    icon:          'i-hoodie',
    pricing_mode:  'components',
    min_total:     10,
    target_margin: DEFAULT_TARGET_MARGIN,
    options: [
      { id: 'sides', label: 'Caras',
        values: [{ id: 'one_side', label: '1 cara', sides: 1 }, { id: 'two_sides', label: '2 caras', sides: 2 }] }
    ],
    components: [
      { id: 'sweatshirt', label: 'Sudaderas', product: 'URBAN' }
    ]
  },

  hoodies_mixed: {
    name:          'Pack mixto sudaderas (capucha + sin capucha)',
    description:   'Mezcla de sudaderas con y sin capucha',
    icon:          'i-hoodie',
    pricing_mode:  'components',
    min_total:     10,
    target_margin: DEFAULT_TARGET_MARGIN,
    options: [
      { id: 'sides', label: 'Caras',
        values: [{ id: 'one_side', label: '1 cara', sides: 1 }, { id: 'two_sides', label: '2 caras', sides: 2 }] }
    ],
    components: [
      { id: 'classic', label: 'Sin capucha', product: 'CLASICA' },
      { id: 'urban',   label: 'Con capucha', product: 'URBAN' }
    ]
  },

  custom: {
    name:            'Pack personalizado',
    description:     'Elige productos y cantidades libremente',
    icon:            'i-pack',
    pricing_mode:    'components',
    min_total:       10,
    target_margin:   DEFAULT_TARGET_MARGIN,
    free_components: true,
    options: [
      { id: 'sides', label: 'Caras',
        values: [{ id: 'one_side', label: '1 cara', sides: 1 }, { id: 'two_sides', label: '2 caras', sides: 2 }] }
    ],
    components: []
  }
};

// --- Company and quote template (used in the PDF) --- (rendered → Spanish)
const COMPANY = {
  name:    'Mi Taller DTF',
  tax_id:  '',
  address: '',
  phone:   '',
  email:   '',
  web:     '',
  // Shared PDF settings (v5, Plan 6): the selected built-in template id
  // and the brand color used by the color templates (Moderna/Corporativa).
  // Shared data so every PC prints alike. brand_color seeds the app accent.
  pdf_template: 'clasica',
  brand_color:  '#3D7BD9'
};

const QUOTE_SETTINGS = {
  validity_days: 30,
  terms:         'Precios IVA incluido. Validez 30 días desde la fecha de emisión. La aceptación implica conformidad con las condiciones del taller.'
};

/**
 * Returns a fresh, independent copy of the full v4 catalog. Mirrors the
 * old buildDefaultConfig() exactly so tests that need a complete, valid
 * config keep a faithful one.
 *
 * @param {object} [meta] - optional metadata (modified_by, updated_at)
 * @returns {object} configuration ready to serialize / validate
 */
function buildFullConfigV4(meta = {}) {
  return {
    version:     VERSION,
    updated_at:  meta.updated_at || '01/01/2026, 0:00:00',
    modified_by: meta.modified_by || 'fixture',
    admin: { password: ADMIN_PASSWORD_DEFAULT },
    parameters:     JSON.parse(JSON.stringify(PARAMETERS)),
    suppliers:      JSON.parse(JSON.stringify(SUPPLIERS)),
    products:       JSON.parse(JSON.stringify(PRODUCTS)),
    tiers:          JSON.parse(JSON.stringify(TIERS)),
    addons:         JSON.parse(JSON.stringify(ADDONS)),
    packs:          JSON.parse(JSON.stringify(PACKS)),
    company:        JSON.parse(JSON.stringify(COMPANY)),
    quote_settings: JSON.parse(JSON.stringify(QUOTE_SETTINGS))
  };
}

module.exports = { buildFullConfigV4 };
