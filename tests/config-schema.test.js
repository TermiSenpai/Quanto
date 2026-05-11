// ============================================================
// Tests · lib/config-schema.js (strict validator)
// ============================================================
// Goal: every "broken config" we worry about must produce a
// message that names the offending field. Pure module — no fs,
// no Electron mocks needed.
// ============================================================

import { describe, test, expect } from 'vitest';
import {
  collectConfigErrors,
  validateConfigSchema,
  REQUIRED_PARAMETERS
} from '../lib/config-schema.js';
import { buildDefaultConfig } from '../config.default.js';

function makeConfig() {
  return buildDefaultConfig({ modificado_por: 'tester' });
}

describe('happy path', () => {
  test('the default config validates without errors', () => {
    expect(collectConfigErrors(makeConfig())).toEqual([]);
    expect(() => validateConfigSchema(makeConfig())).not.toThrow();
  });
});

describe('top-level shape', () => {
  test.each([
    [null],
    [undefined],
    [42],
    ['string'],
    [[]]
  ])('rejects non-object input (%p)', (input) => {
    const errors = collectConfigErrors(input);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/objeto/);
  });

  test('missing version is reported', () => {
    const cfg = makeConfig();
    delete cfg.version;
    const errors = collectConfigErrors(cfg);
    expect(errors.join('\n')).toMatch(/version/);
  });
});

describe('parameters', () => {
  test.each(REQUIRED_PARAMETERS)('reports when "parametros.%s" is missing', (key) => {
    const cfg = makeConfig();
    delete cfg.parametros[key];
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes(`parametros.${key}`))).toBe(true);
  });

  test('rejects negative parameters', () => {
    const cfg = makeConfig();
    cfg.parametros.iva = -0.05;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('parametros.iva'))).toBe(true);
  });

  test('rejects iva above 1 (e.g. someone wrote 21 instead of 0.21)', () => {
    const cfg = makeConfig();
    cfg.parametros.iva = 21;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /iva/.test(e) && /entre 0 y 1/.test(e))).toBe(true);
  });

  test('rejects non-numeric parameter', () => {
    const cfg = makeConfig();
    cfg.parametros.mo_eur_hora = 'fifteen';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('mo_eur_hora') && /número/.test(e))).toBe(true);
  });

  test('accepts a config without optional extras', () => {
    const cfg = makeConfig();
    delete cfg.parametros.extra_nombre_eur;
    delete cfg.parametros.extra_manga_corta_eur;
    delete cfg.parametros.extra_manga_larga_eur;
    expect(collectConfigErrors(cfg)).toEqual([]);
  });
});

describe('Roly models', () => {
  test('reports missing required model', () => {
    const cfg = makeConfig();
    delete cfg.modelos_roly.URBAN;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('modelos_roly.URBAN'))).toBe(true);
  });

  test('rejects negative price', () => {
    const cfg = makeConfig();
    cfg.modelos_roly.BEAGLE.precio = -1;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('BEAGLE.precio') && /negativo/.test(e))).toBe(true);
  });

  test('rejects non-string ref', () => {
    const cfg = makeConfig();
    cfg.modelos_roly.BEAGLE.ref = 12345;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => e.includes('BEAGLE.ref'))).toBe(true);
  });
});

describe('tramos', () => {
  test('rejects empty array', () => {
    const cfg = makeConfig();
    cfg.tramos = [];
    const errors = collectConfigErrors(cfg);
    expect(errors[0]).toMatch(/tramos/);
  });

  test('rejects overlapping tiers (descending order)', () => {
    const cfg = makeConfig();
    cfg.tramos = [
      { id: 'T1', etiqueta: '50-99', desde: 50, hasta: 99,   reduccion_tiempo: 0   },
      { id: 'T2', etiqueta: '10-49', desde: 10, hasta: 49,   reduccion_tiempo: 0.1 },
      { id: 'T3', etiqueta: '100+',  desde: 100, hasta: null, reduccion_tiempo: 0.2 }
    ];
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /solapa/.test(e))).toBe(true);
  });

  test('rejects tramo where hasta < desde', () => {
    const cfg = makeConfig();
    cfg.tramos[0].hasta = 5; // desde=10 > hasta=5
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /menor/.test(e))).toBe(true);
  });

  test('rejects tramo without id', () => {
    const cfg = makeConfig();
    cfg.tramos[0].id = '';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /id/.test(e))).toBe(true);
  });

  test('rejects reduccion_tiempo >= 1', () => {
    const cfg = makeConfig();
    cfg.tramos[1].reduccion_tiempo = 1.0;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /reduccion_tiempo/.test(e))).toBe(true);
  });
});

describe('packs', () => {
  test('rejects an empty packs section', () => {
    const cfg = makeConfig();
    cfg.packs = {};
    const errors = collectConfigErrors(cfg);
    expect(errors[0]).toMatch(/packs/);
  });

  test('reports missing PVP entry per tramo on pena pack', () => {
    const cfg = makeConfig();
    delete cfg.packs.pena_completa.pvp.sin_capucha.dos_caras.T1;
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /pena_completa.pvp.sin_capucha.dos_caras.T1/.test(e))).toBe(true);
  });

  test('individual pack with unknown modelo is flagged', () => {
    const cfg = makeConfig();
    cfg.packs.solo_camisetas.modelo = 'UFO';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /UFO/.test(e))).toBe(true);
  });

  test('mixto pack with broken packs_referencia', () => {
    const cfg = makeConfig();
    cfg.packs.sudaderas_mixto.packs_referencia.URBAN = 'no_existe';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /no_existe/.test(e))).toBe(true);
  });

  test('personalizado pack with broken modelo reference', () => {
    const cfg = makeConfig();
    cfg.packs.personalizado.modelos_referencia.BEAGLE = 'fake_pack';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /fake_pack/.test(e))).toBe(true);
  });

  test('unknown pack tipo is flagged', () => {
    const cfg = makeConfig();
    cfg.packs.solo_camisetas.tipo = 'banana';
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /banana/.test(e))).toBe(true);
  });
});

describe('admin', () => {
  test('rejects when admin.clave is missing and no tiene_clave flag', () => {
    const cfg = makeConfig();
    cfg.admin = {};
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /admin.clave/.test(e))).toBe(true);
  });

  test('accepts the renderer-side shape (tiene_clave=true, no raw clave)', () => {
    const cfg = makeConfig();
    cfg.admin = { tiene_clave: true };
    const errors = collectConfigErrors(cfg);
    expect(errors.some(e => /admin.clave/.test(e))).toBe(false);
  });
});

describe('validateConfigSchema (throwing wrapper)', () => {
  test('throws with all errors joined when invalid', () => {
    const cfg = makeConfig();
    delete cfg.parametros.iva;
    delete cfg.parametros.mo_eur_hora;
    expect(() => validateConfigSchema(cfg)).toThrow(/iva/);
    expect(() => validateConfigSchema(cfg)).toThrow(/mo_eur_hora/);
  });

  test('does not throw on the default config', () => {
    expect(() => validateConfigSchema(makeConfig())).not.toThrow();
  });
});
