// ============================================================
// PackPrice - Default configuration
// ============================================================
// These are the initial values used to create the config.js file
// on the NAS when it does not exist on first boot.
//
// Source: PLAN_Calculadora.md (sections 2 and 3) and the real
// values in use from the test config (CONFIG TEST/config.js).
//
// This module is used ONLY in the main process (main.js). The
// renderer always works with the copy read from disk.
//
// Schema: v3 (English keys). User-facing values (model `name`,
// tier `label`, `terms` text, company data) stay in Spanish
// because they are rendered to the user. See CLAUDE.md §2.
// ============================================================

'use strict';

const VERSION = '3.0.0';
const ADMIN_PASSWORD_DEFAULT = 'fuzfuz2026';

// --- Base parameters (plan section 2.1) ---
const PARAMETERS = {
  labor_eur_hour:          15,
  vat:                     0.21,
  waste_pct:               0.10,
  overhead_eur_garment:    0.30,
  buffer_3xl_eur_pack:     0.40,
  surcharge_4xl_eur:       3,
  surcharge_5xl_eur:       5,
  roly_shipping_eur_bundle: 5.90,
  garments_per_bundle:     40,
  dtf_eur_meter:           1.25,
  dtf_meters_two_sides:    0.40,
  dtf_meters_one_side:     0.20,
  pressing_eur_side:       0.30,
  minutes_two_sides_base:  7,
  minutes_one_side_base:   5,
  // Optional extras (prices WITHOUT VAT — VAT is applied when added to the total)
  extra_name_eur:          1.5,
  extra_short_sleeve_eur:  1.5,
  extra_long_sleeve_eur:   3
};

// --- Roly models (plan section 2.2) ---
// IDs (BEAGLE, CLASICA, URBAN) are supplier catalog identifiers and
// stay uppercase. `name` values are rendered to the user → Spanish.
const ROLY_MODELS = {
  BEAGLE: {
    name:  'Camiseta',
    ref:   'CA65540558',
    price: 1.7325
  },
  CLASICA: {
    name:  'Sudadera sin capucha',
    ref:   'SU10700558',
    price: 6.2475
  },
  URBAN: {
    name:  'Sudadera con capucha',
    ref:   'SU1067050258',
    price: 7.8750
  }
};

// --- Volume tiers (plan section 2.3) ---
// `label` values are rendered to the user → Spanish.
const TIERS = [
  { id: 'T1', label: '10-24 uds', from: 10,  to: 24,   time_reduction: 0    },
  { id: 'T2', label: '25-49 uds', from: 25,  to: 49,   time_reduction: 0.10 },
  { id: 'T3', label: '50-99 uds', from: 50,  to: 99,   time_reduction: 0.15 },
  { id: 'T4', label: '100+ uds',  from: 100, to: null, time_reduction: 0.20 }
];

// --- Commercial packs (plan section 3) ---
// `name` values are rendered to the user → Spanish.
const PACKS = {
  crew_full: {
    type: 'crew',
    name: 'Pack Peña (camiseta + sudadera)',
    min:  10,
    prices: {
      without_hood: {
        two_sides: { T1: 25.95, T2: 24.95, T3: 23.95, T4: 22.95 },
        one_side:  { T1: 22.95, T2: 21.95, T3: 20.95, T4: 19.95 }
      },
      with_hood: {
        two_sides: { T1: 28.95, T2: 27.95, T3: 26.95, T4: 25.95 },
        one_side:  { T1: 25.95, T2: 24.95, T3: 23.95, T4: 22.95 }
      }
    }
  },

  tshirts_only: {
    type:  'single',
    name:  'Pack solo camisetas',
    min:   10,
    model: 'BEAGLE',
    prices: {
      two_sides: { T1: 11.99, T2: 10.99, T3: 9.99, T4: 8.99 },
      one_side:  { T1: 9.99,  T2: 8.99,  T3: 8.45, T4: 7.99 }
    }
  },

  classic_only: {
    type:  'single',
    name:  'Pack solo sudaderas sin capucha',
    min:   10,
    model: 'CLASICA',
    prices: {
      two_sides: { T1: 14.95, T2: 13.95, T3: 12.95, T4: 12.45 },
      one_side:  { T1: 12.95, T2: 11.95, T3: 10.95, T4: 10.45 }
    }
  },

  urban_only: {
    type:  'single',
    name:  'Pack solo sudaderas con capucha',
    min:   10,
    model: 'URBAN',
    prices: {
      two_sides: { T1: 16.95, T2: 15.95, T3: 14.95, T4: 13.95 },
      one_side:  { T1: 14.95, T2: 13.95, T3: 12.95, T4: 11.95 }
    }
  },

  hoodies_mixed: {
    type:      'mixed',
    name:      'Pack mixto sudaderas (capucha + sin capucha)',
    min_total: 10,
    reference_packs: {
      CLASICA: 'classic_only',
      URBAN:   'urban_only'
    }
  },

  custom: {
    type:      'custom',
    name:      'Pack personalizado',
    min_total: 10,
    // Each Roly model is billed at the price of the single pack
    // referenced here. If a new model is added, add its pairing.
    reference_models: {
      BEAGLE:  'tshirts_only',
      CLASICA: 'classic_only',
      URBAN:   'urban_only'
    }
  }
};

// --- Company and quote template (used in the PDF) ---
// Values are rendered to the customer → Spanish.
const COMPANY = {
  name:    'Mi Taller DTF',
  tax_id:  '',
  address: '',
  phone:   '',
  email:   '',
  web:     ''
};

const QUOTE_SETTINGS = {
  validity_days: 30,
  terms:         'Precios IVA incluido. Validez 30 días desde la fecha de emisión. La aceptación implica conformidad con las condiciones del taller.'
};

/**
 * Returns a fresh configuration object with the plan defaults.
 * Each call returns an independent copy, safe to mutate.
 *
 * @param {object} [meta] - optional metadata (modified_by, etc.)
 * @returns {object} configuration ready to serialize to config.js
 */
function buildDefaultConfig(meta = {}) {
  return {
    version:     VERSION,
    updated_at:  meta.updated_at || new Date().toLocaleString('es-ES'),
    modified_by: meta.modified_by || 'sistema (auto)',
    admin: {
      password: ADMIN_PASSWORD_DEFAULT
    },
    parameters:  JSON.parse(JSON.stringify(PARAMETERS)),
    roly_models: JSON.parse(JSON.stringify(ROLY_MODELS)),
    tiers:       JSON.parse(JSON.stringify(TIERS)),
    packs:       JSON.parse(JSON.stringify(PACKS)),
    company:     JSON.parse(JSON.stringify(COMPANY)),
    quote_settings: JSON.parse(JSON.stringify(QUOTE_SETTINGS))
  };
}

module.exports = {
  buildDefaultConfig,
  VERSION,
  ADMIN_PASSWORD_DEFAULT
};
