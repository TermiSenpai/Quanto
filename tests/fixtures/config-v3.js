// ============================================================
// Canonical v3 config fixture (English keys)
// ============================================================
// This is the v3 shape produced by the old v2→v3 migration: English
// structural keys, `roly_models`, pack `type` + `prices`/`model`/
// `reference_*`, and the `buffer_3xl_eur_pack` + `extra_*_eur`
// parameters that v4 dropped.
//
// Used by tests/migrations.test.js to exercise the v3→v4 migration
// in isolation (independent of the v2→v3 step). Keep it frozen at
// the v3 defaults so it stays a meaningful regression anchor.
// ============================================================

'use strict';

const PARAMETERS = {
  labor_eur_hour:           15,
  vat:                      0.21,
  waste_pct:                0.10,
  overhead_eur_garment:     0.30,
  buffer_3xl_eur_pack:      0.40,
  surcharge_4xl_eur:        3,
  surcharge_5xl_eur:        5,
  roly_shipping_eur_bundle: 5.90,
  garments_per_bundle:      40,
  dtf_eur_meter:            1.25,
  dtf_meters_two_sides:     0.40,
  dtf_meters_one_side:      0.20,
  pressing_eur_side:        0.30,
  minutes_two_sides_base:   7,
  minutes_one_side_base:    5,
  extra_name_eur:           1.5,
  extra_short_sleeve_eur:   1.5,
  extra_long_sleeve_eur:    3
};

const ROLY_MODELS = {
  BEAGLE:  { name: 'Camiseta',                ref: 'CA65540558',   price: 1.7325 },
  CLASICA: { name: 'Sudadera sin capucha',    ref: 'SU10700558',   price: 6.2475 },
  URBAN:   { name: 'Sudadera con capucha',    ref: 'SU1067050258', price: 7.8750 }
};

const TIERS = [
  { id: 'T1', label: '10-24 uds', from: 10,  to: 24,   time_reduction: 0    },
  { id: 'T2', label: '25-49 uds', from: 25,  to: 49,   time_reduction: 0.10 },
  { id: 'T3', label: '50-99 uds', from: 50,  to: 99,   time_reduction: 0.15 },
  { id: 'T4', label: '100+ uds',  from: 100, to: null, time_reduction: 0.20 }
];

const PACKS = {
  crew_full: {
    type:   'crew',
    name:   'Pack Peña (camiseta + sudadera)',
    min:    10,
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
    type:   'single',
    name:   'Pack solo camisetas',
    min:    10,
    model:  'BEAGLE',
    prices: {
      two_sides: { T1: 11.99, T2: 10.99, T3: 9.99, T4: 8.99 },
      one_side:  { T1: 9.99,  T2: 8.99,  T3: 8.45, T4: 7.99 }
    }
  },
  classic_only: {
    type:   'single',
    name:   'Pack solo sudaderas sin capucha',
    min:    10,
    model:  'CLASICA',
    prices: {
      two_sides: { T1: 14.95, T2: 13.95, T3: 12.95, T4: 12.45 },
      one_side:  { T1: 12.95, T2: 11.95, T3: 10.95, T4: 10.45 }
    }
  },
  urban_only: {
    type:   'single',
    name:   'Pack solo sudaderas con capucha',
    min:    10,
    model:  'URBAN',
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
    reference_models: {
      BEAGLE:  'tshirts_only',
      CLASICA: 'classic_only',
      URBAN:   'urban_only'
    }
  }
};

const COMPANY = {
  name: 'Mi Taller DTF', tax_id: '', address: '', phone: '', email: '', web: ''
};

const QUOTE_SETTINGS = {
  validity_days: 30,
  terms: 'Precios IVA incluido. Validez 30 días desde la fecha de emisión. La aceptación implica conformidad con las condiciones del taller.'
};

/**
 * Returns a fresh v3 config object. Each call is an independent copy.
 *
 * @param {object} [meta] - { modified_by, updated_at }
 */
function buildV3Config(meta = {}) {
  return {
    version:     '3.0.0',
    updated_at:  meta.updated_at || '1/1/2026, 00:00:00',
    modified_by: meta.modified_by || 'sistema (auto)',
    admin:       { password: 'fuzfuz2026' },
    parameters:  JSON.parse(JSON.stringify(PARAMETERS)),
    roly_models: JSON.parse(JSON.stringify(ROLY_MODELS)),
    tiers:       JSON.parse(JSON.stringify(TIERS)),
    packs:       JSON.parse(JSON.stringify(PACKS)),
    company:     JSON.parse(JSON.stringify(COMPANY)),
    quote_settings: JSON.parse(JSON.stringify(QUOTE_SETTINGS))
  };
}

module.exports = {
  buildV3Config,
  V3_VERSION: '3.0.0'
};
