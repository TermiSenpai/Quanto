// ============================================================
// Tests de la lógica de cálculo (renderer/calculo.js)
// ============================================================
// Cubrimos los casos del PLAN_Calculadora.md y los bordes de tramo.
// Las funciones son puras: reciben (cfg, opciones) y devuelven el
// resultado.
//
// renderer/calculo.js todavía consume el esquema v2 (se migra en
// Onda 6), así que alimentamos el fixture v2 canónico en vez de
// buildDefaultConfig (que ya emite v3).
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  getTramo,
  calcularExtras,
  calcularCostePrenda,
  calcularPackPena,
  calcularPackIndividual,
  calcularPackMixto,
  calcularPackPersonalizado
} from '../renderer/calculo.js';
import { buildV2Config } from './fixtures/config-v2.js';

const CFG = buildV2Config();

// Tolerancia de 1 céntimo para evitar fragilidad por flotantes.
const EUR = 0.01;

describe('getTramo', () => {
  test.each([
    [9,    null],
    [10,   'T1'],
    [24,   'T1'],
    [25,   'T2'],
    [49,   'T2'],
    [50,   'T3'],
    [99,   'T3'],
    [100,  'T4'],
    [9999, 'T4']
  ])('cantidad=%i → %s', (cant, esperado) => {
    const t = getTramo(CFG, cant);
    if (esperado === null) {
      expect(t).toBeNull();
    } else {
      expect(t).not.toBeNull();
      expect(t.id).toBe(esperado);
    }
  });
});

describe('calcularExtras', () => {
  test('sin extras devuelve ceros', () => {
    const r = calcularExtras(CFG, {});
    expect(r.sin_iva).toBe(0);
    expect(r.iva_inc).toBe(0);
  });

  test('aplica IVA encima del subtotal sin IVA', () => {
    // 2 nombres × 1.5 + 1 manga corta × 1.5 + 1 manga larga × 3 = 7.5 sin IVA
    // con IVA 21% → 9.075
    const r = calcularExtras(CFG, {
      nombres: 2,
      mangas_cortas: 1,
      mangas_largas: 1
    });
    expect(r.sin_iva).toBeCloseTo(7.5, 4);
    expect(r.iva_inc).toBeCloseTo(9.075, 4);
  });
});

describe('calcularPackPena (caso del plan §3.1)', () => {
  // 12 packs sin capucha, 2 caras → tramo T1, PVP 25.95 → 311.40 €
  test('12 packs sin capucha 2 caras = 311.40 €', () => {
    const r = calcularPackPena(CFG, {
      cantidad: 12,
      capucha: 'sin',
      caras: 2,
      cant_4xl: 0,
      cant_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.tramo).toMatch(/10-24/);
    expect(r.pvp_unitario).toBe(25.95);
    expect(r.total_iva_inc).toBeCloseTo(311.40, 2);
  });

  test('rechaza cantidad por debajo del mínimo', () => {
    const r = calcularPackPena(CFG, {
      cantidad: 5, capucha: 'sin', caras: 2, cant_4xl: 0, cant_5xl: 0
    });
    expect(r.error).toBeDefined();
  });

  test('cambia tramo y PVP cuando se cruza una frontera', () => {
    const r25 = calcularPackPena(CFG, {
      cantidad: 25, capucha: 'sin', caras: 2, cant_4xl: 0, cant_5xl: 0
    });
    expect(r25.pvp_unitario).toBe(24.95); // T2

    const r100 = calcularPackPena(CFG, {
      cantidad: 100, capucha: 'con', caras: 1, cant_4xl: 0, cant_5xl: 0
    });
    expect(r100.pvp_unitario).toBe(22.95); // T4 con_capucha una_cara
  });

  test('recargos 4XL/5XL+ se suman al total', () => {
    const base = calcularPackPena(CFG, {
      cantidad: 12, capucha: 'sin', caras: 2, cant_4xl: 0, cant_5xl: 0
    });
    const con = calcularPackPena(CFG, {
      cantidad: 12, capucha: 'sin', caras: 2, cant_4xl: 2, cant_5xl: 1
    });
    const recargoEsperado = 2 * 3 + 1 * 5; // 11 €
    expect(con.total_iva_inc - base.total_iva_inc).toBeCloseTo(recargoEsperado, 2);
  });
});

describe('calcularPackIndividual', () => {
  test('solo_camisetas T1 dos_caras 10 uds', () => {
    const r = calcularPackIndividual(CFG, 'solo_camisetas', {
      cantidad: 10, caras: 2, cant_4xl: 0, cant_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.pvp_unitario).toBe(11.99);
    expect(r.total_iva_inc).toBeCloseTo(119.90, 2);
  });

  test('rechaza por debajo del mínimo', () => {
    const r = calcularPackIndividual(CFG, 'solo_urban', {
      cantidad: 9, caras: 1, cant_4xl: 0, cant_5xl: 0
    });
    expect(r.error).toBeDefined();
  });
});

describe('calcularPackMixto (caso del plan)', () => {
  // 7 URBAN + 5 CLASICA, T1, 1 cara: 7×14.95 + 5×12.95 = 104.65 + 64.75 = 169.40
  // El plan menciona 193.40 que parece corresponder a 2 caras: 7×16.95 + 5×14.95 = 118.65 + 74.75 = 193.40
  test('7 URBAN + 5 CLASICA, 2 caras = 193.40 €', () => {
    const r = calcularPackMixto(CFG, {
      cant_clasica: 5,
      cant_urban: 7,
      caras: 2,
      cant_4xl: 0,
      cant_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.cantidad_total).toBe(12);
    expect(r.tramo).toMatch(/10-24/);
    expect(r.total_iva_inc).toBeCloseTo(193.40, 2);
  });

  test('rechaza si total < min', () => {
    const r = calcularPackMixto(CFG, {
      cant_clasica: 4, cant_urban: 4, caras: 2, cant_4xl: 0, cant_5xl: 0
    });
    expect(r.error).toBeDefined();
  });

  test('subtotal = suma de líneas', () => {
    const r = calcularPackMixto(CFG, {
      cant_clasica: 5, cant_urban: 7, caras: 2, cant_4xl: 0, cant_5xl: 0
    });
    const sumLineas = r.desglose.reduce((s, l) => s + l.subtotal, 0);
    expect(r.subtotal).toBeCloseTo(sumLineas, 2);
  });
});

describe('calcularPackPersonalizado', () => {
  test('mezcla cualquier combo a su PVP individual', () => {
    const r = calcularPackPersonalizado(CFG, {
      lineas: [
        { modelo: 'BEAGLE',  cantidad: 5,  caras: 2 },
        { modelo: 'CLASICA', cantidad: 3,  caras: 2 },
        { modelo: 'URBAN',   cantidad: 2,  caras: 1 }
      ],
      cant_4xl: 0, cant_5xl: 0
    });
    expect(r.error).toBeUndefined();
    expect(r.cantidad_total).toBe(10);
    // T1: BEAGLE 2c=11.99, CLASICA 2c=14.95, URBAN 1c=14.95
    // 5×11.99 + 3×14.95 + 2×14.95 = 59.95 + 44.85 + 29.90 = 134.70
    expect(r.subtotal).toBeCloseTo(134.70, 2);
  });

  test('rechaza líneas vacías', () => {
    const r = calcularPackPersonalizado(CFG, { lineas: [], cant_4xl: 0, cant_5xl: 0 });
    expect(r.error).toBeDefined();
  });

  test('rechaza si total < min', () => {
    const r = calcularPackPersonalizado(CFG, {
      lineas: [{ modelo: 'BEAGLE', cantidad: 5, caras: 2 }],
      cant_4xl: 0, cant_5xl: 0
    });
    expect(r.error).toBeDefined();
  });

  test('rechaza modelo sin pack de referencia', () => {
    const cfgRoto = buildV2Config();
    cfgRoto.modelos_roly.NUEVO = { nombre: 'X', ref: 'X', precio: 1 };
    const r = calcularPackPersonalizado(cfgRoto, {
      lineas: [
        { modelo: 'BEAGLE', cantidad: 9,  caras: 1 },
        { modelo: 'NUEVO',  cantidad: 1,  caras: 1 }
      ],
      cant_4xl: 0, cant_5xl: 0
    });
    expect(r.error).toMatch(/NUEVO/);
  });
});

describe('calcularCostePrenda', () => {
  test('coste BEAGLE 2 caras T1, lote 10', () => {
    const t1 = getTramo(CFG, 10);
    const r = calcularCostePrenda(CFG, 'BEAGLE', 2, t1, 10);
    // No bloqueamos un valor exacto (depende de muchos parámetros), pero
    // el coste debe ser positivo y razonable (entre 1 y 20 €).
    expect(r.total).toBeGreaterThan(1);
    expect(r.total).toBeLessThan(20);
  });

  test('reducción de tiempo en T4 baja el coste vs T1', () => {
    const t1 = getTramo(CFG, 10);
    const t4 = getTramo(CFG, 100);
    const c1 = calcularCostePrenda(CFG, 'URBAN', 2, t1, 10).total;
    const c4 = calcularCostePrenda(CFG, 'URBAN', 2, t4, 100).total;
    expect(c4).toBeLessThan(c1);
  });
});

describe('coherencia interna de calcularTotales', () => {
  test('base + IVA == total IVA inc', () => {
    const r = calcularPackPena(CFG, {
      cantidad: 30, capucha: 'con', caras: 2, cant_4xl: 1, cant_5xl: 1
    });
    expect(r.base_venta + r.iva).toBeCloseTo(r.total_iva_inc, EUR);
  });

  test('margen + coste_total + iva == total IVA inc', () => {
    const r = calcularPackPena(CFG, {
      cantidad: 30, capucha: 'con', caras: 2, cant_4xl: 0, cant_5xl: 0
    });
    expect(r.margen + r.coste_total + r.iva).toBeCloseTo(r.total_iva_inc, EUR);
  });
});
