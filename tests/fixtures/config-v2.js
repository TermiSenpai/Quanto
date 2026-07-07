// ============================================================
// Canonical v2 config fixture (Spanish keys)
// ============================================================
// This is exactly what `config.default.js:buildDefaultConfig()`
// emitted before the v3 migration (schema 2.0.0). Two callers need
// it:
//
//   1. tests/migrations.test.js — canonical input for the
//      migrateConfig(v2) === v3 round-trip and idempotence tests.
//   2. tests/calculo.test.js — renderer/calculo.js still consumes
//      the v2 shape until Onda 6, so its tests feed this fixture.
//
// Keep it frozen at the v2 defaults: changing it would silently
// weaken the migration round-trip test. Once calculo.js is migrated
// (Onda 6), only the migration tests will depend on it.
// ============================================================

'use strict';

const VERSION = '2.0.0';
const ADMIN_CLAVE_DEFAULT = 'fuzfuz2026';

const PARAMETROS = {
  mo_eur_hora:           15,
  iva:                   0.21,
  merma_pct:             0.10,
  indirectos_eur_prenda: 0.30,
  buffer_3xl_eur_pack:   0.40,
  recargo_4xl_eur:       3,
  recargo_5xl_eur:       5,
  envio_roly_eur_bulto:  5.90,
  prendas_por_bulto:     40,
  dtf_eur_metro:         1.25,
  dtf_metros_2caras:     0.40,
  dtf_metros_1cara:      0.20,
  planchado_eur_cara:    0.30,
  minutos_2caras_base:   7,
  minutos_1cara_base:    5,
  extra_nombre_eur:      1.5,
  extra_manga_corta_eur: 1.5,
  extra_manga_larga_eur: 3
};

const MODELOS_ROLY = {
  BEAGLE: {
    nombre: 'Camiseta',
    ref:    'CA65540558',
    precio: 1.7325
  },
  CLASICA: {
    nombre: 'Sudadera sin capucha',
    ref:    'SU10700558',
    precio: 6.2475
  },
  URBAN: {
    nombre: 'Sudadera con capucha',
    ref:    'SU1067050258',
    precio: 7.8750
  }
};

const TRAMOS = [
  { id: 'T1', etiqueta: '10-24 uds', desde: 10,  hasta: 24,   reduccion_tiempo: 0    },
  { id: 'T2', etiqueta: '25-49 uds', desde: 25,  hasta: 49,   reduccion_tiempo: 0.10 },
  { id: 'T3', etiqueta: '50-99 uds', desde: 50,  hasta: 99,   reduccion_tiempo: 0.15 },
  { id: 'T4', etiqueta: '100+ uds',  desde: 100, hasta: null, reduccion_tiempo: 0.20 }
];

const PACKS = {
  pena_completa: {
    tipo:   'pena',
    nombre: 'Pack Peña (camiseta + sudadera)',
    min:    10,
    pvp: {
      sin_capucha: {
        dos_caras: { T1: 25.95, T2: 24.95, T3: 23.95, T4: 22.95 },
        una_cara:  { T1: 22.95, T2: 21.95, T3: 20.95, T4: 19.95 }
      },
      con_capucha: {
        dos_caras: { T1: 28.95, T2: 27.95, T3: 26.95, T4: 25.95 },
        una_cara:  { T1: 25.95, T2: 24.95, T3: 23.95, T4: 22.95 }
      }
    }
  },

  solo_camisetas: {
    tipo:   'individual',
    nombre: 'Pack solo camisetas',
    min:    10,
    modelo: 'BEAGLE',
    pvp: {
      dos_caras: { T1: 11.99, T2: 10.99, T3: 9.99, T4: 8.99 },
      una_cara:  { T1: 9.99,  T2: 8.99,  T3: 8.45, T4: 7.99 }
    }
  },

  solo_clasica: {
    tipo:   'individual',
    nombre: 'Pack solo sudaderas sin capucha',
    min:    10,
    modelo: 'CLASICA',
    pvp: {
      dos_caras: { T1: 14.95, T2: 13.95, T3: 12.95, T4: 12.45 },
      una_cara:  { T1: 12.95, T2: 11.95, T3: 10.95, T4: 10.45 }
    }
  },

  solo_urban: {
    tipo:   'individual',
    nombre: 'Pack solo sudaderas con capucha',
    min:    10,
    modelo: 'URBAN',
    pvp: {
      dos_caras: { T1: 16.95, T2: 15.95, T3: 14.95, T4: 13.95 },
      una_cara:  { T1: 14.95, T2: 13.95, T3: 12.95, T4: 11.95 }
    }
  },

  sudaderas_mixto: {
    tipo:      'mixto',
    nombre:    'Pack mixto sudaderas (capucha + sin capucha)',
    min_total: 10,
    packs_referencia: {
      CLASICA: 'solo_clasica',
      URBAN:   'solo_urban'
    }
  },

  personalizado: {
    tipo:      'personalizado',
    nombre:    'Pack personalizado',
    min_total: 10,
    modelos_referencia: {
      BEAGLE:  'solo_camisetas',
      CLASICA: 'solo_clasica',
      URBAN:   'solo_urban'
    }
  }
};

const EMPRESA = {
  nombre:    'Mi Taller DTF',
  cif:       '',
  direccion: '',
  telefono:  '',
  email:     '',
  web:       ''
};

const PRESUPUESTO = {
  validez_dias: 30,
  condiciones:  'Precios IVA incluido. Validez 30 días desde la fecha de emisión. La aceptación implica conformidad con las condiciones del taller.'
};

/**
 * Returns a fresh v2 config object. Each call is an independent
 * copy, safe to mutate. Mirrors the old buildDefaultConfig signature.
 *
 * @param {object} [meta] - { modificado_por, fecha_actualizacion }
 */
function buildV2Config(meta = {}) {
  return {
    version:             VERSION,
    fecha_actualizacion: meta.fecha_actualizacion || '1/1/2026, 00:00:00',
    modificado_por:      meta.modificado_por || 'sistema (auto)',
    admin: {
      clave: ADMIN_CLAVE_DEFAULT
    },
    parametros:   JSON.parse(JSON.stringify(PARAMETROS)),
    modelos_roly: JSON.parse(JSON.stringify(MODELOS_ROLY)),
    tramos:       JSON.parse(JSON.stringify(TRAMOS)),
    packs:        JSON.parse(JSON.stringify(PACKS)),
    empresa:      JSON.parse(JSON.stringify(EMPRESA)),
    presupuesto:  JSON.parse(JSON.stringify(PRESUPUESTO))
  };
}

module.exports = {
  buildV2Config,
  V2_VERSION: VERSION,
  V2_ADMIN_CLAVE_DEFAULT: ADMIN_CLAVE_DEFAULT
};
