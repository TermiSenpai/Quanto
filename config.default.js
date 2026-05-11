// ============================================================
// PackPrice - Configuración por defecto
// ============================================================
// Estos son los valores iniciales con los que se creará el
// archivo config.js en el NAS si no existe en el primer arranque.
//
// Fuente: PLAN_Calculadora.md (secciones 2 y 3) y los valores
// reales en uso del config test (CONFIG TEST/config.js).
//
// Este módulo se usa SOLO en el proceso principal (main.js).
// El renderer trabaja siempre con la copia leída de disco.
// ============================================================

'use strict';

const VERSION = '2.0.0';
const ADMIN_CLAVE_DEFAULT = 'fuzfuz2026';

// --- Parámetros base (sección 2.1 del plan) ---
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
  // Extras opcionales (precios SIN IVA — se les aplica IVA al sumarlos al total)
  extra_nombre_eur:      1.5,
  extra_manga_corta_eur: 1.5,
  extra_manga_larga_eur: 3
};

// --- Modelos Roly (sección 2.2 del plan) ---
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

// --- Tramos de volumen (sección 2.3 del plan) ---
const TRAMOS = [
  { id: 'T1', etiqueta: '10-24 uds',  desde: 10,  hasta: 24,   reduccion_tiempo: 0    },
  { id: 'T2', etiqueta: '25-49 uds',  desde: 25,  hasta: 49,   reduccion_tiempo: 0.10 },
  { id: 'T3', etiqueta: '50-99 uds',  desde: 50,  hasta: 99,   reduccion_tiempo: 0.15 },
  { id: 'T4', etiqueta: '100+ uds',   desde: 100, hasta: null, reduccion_tiempo: 0.20 }
];

// --- Packs comerciales (sección 3 del plan) ---
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
    // Cada modelo Roly se factura al PVP del pack individual indicado
    // aquí. Si en el futuro entra un modelo nuevo, añadir su pareja.
    modelos_referencia: {
      BEAGLE:  'solo_camisetas',
      CLASICA: 'solo_clasica',
      URBAN:   'solo_urban'
    }
  }
};

// --- Empresa y plantilla de presupuesto (usadas en el PDF) ---
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
 * Devuelve un objeto de configuración nuevo con los defaults del plan.
 * Cada llamada devuelve una copia independiente, segura para mutar.
 *
 * @param {object} [meta] - metadatos opcionales (modificado_por, etc.)
 * @returns {object} configuración lista para serializar a config.js
 */
function buildDefaultConfig(meta = {}) {
  return {
    version:             VERSION,
    fecha_actualizacion: meta.fecha_actualizacion || new Date().toLocaleString('es-ES'),
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
  buildDefaultConfig,
  VERSION,
  ADMIN_CLAVE_DEFAULT
};
