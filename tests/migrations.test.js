// ============================================================
// Tests · lib/migrations.js (v2 → v3 → v4 data migrations)
// ============================================================
// Covers:
//   - migrateConfig chains v2 → v3 → v4 and v3 → v4
//   - migrateConfigV3ToV4 mapping (products, addons, packs, params)
//   - idempotency (v4 returned by same reference; double-migrate stable)
//   - a migrated config passes the v4 validator
//   - a migrated config reproduces the legacy prices via calculatePack
//   - migrateQuote / migrateSettings / normalizeAuditEntry round-trips
// ============================================================

import { describe, test, expect } from 'vitest';
import {
  migrateConfig,
  migrateConfigV3ToV4,
  migrateQuote,
  migrateResult,
  migrateSettings,
  normalizeAuditEntry
} from '../lib/migrations.js';
import { collectConfigErrors } from '../lib/config-schema.js';
import { calculatePack } from '../renderer/calculo.js';
import { buildV2Config } from './fixtures/config-v2.js';
import { buildV3Config } from './fixtures/config-v3.js';

describe('migrateConfig — chains to v4', () => {
  test('a v2 config migrates all the way to v4', () => {
    const v4 = migrateConfig(buildV2Config({ fecha_actualizacion: 'D', modificado_por: 'U' }));
    expect(v4.version).toBe('4.0.0');
    expect(v4.updated_at).toBe('D');
    expect(v4.modified_by).toBe('U');
    expect(v4.products).toBeDefined();
    expect(v4.suppliers).toBeDefined();
    expect(v4.addons).toBeDefined();
    expect(v4.roly_models).toBeUndefined(); // gone in v4
  });

  test('a v3 config migrates to v4', () => {
    const v4 = migrateConfig(buildV3Config({ modified_by: 'Alberto' }));
    expect(v4.version).toBe('4.0.0');
    expect(v4.modified_by).toBe('Alberto');
  });

  test('admin.password survives the chain', () => {
    const v4 = migrateConfig(buildV2Config());
    expect(v4.admin.password).toBe('fuzfuz2026');
  });
});

describe('migrateConfigV3ToV4 — mapping', () => {
  const v4 = migrateConfigV3ToV4(buildV3Config());

  test('suppliers registry has ROLY', () => {
    expect(v4.suppliers.ROLY).toEqual({ name: 'Roly', web: '', notes: '' });
  });

  test('products are built from roly_models with a default supplier', () => {
    expect(v4.products.BEAGLE.name).toBe('Camiseta');
    expect(v4.products.BEAGLE.category).toBe('tshirt');
    expect(v4.products.BEAGLE.extra_cost_3xl).toBe(0.40);
    expect(v4.products.CLASICA.category).toBe('hoodie');
    expect(v4.products.CLASICA.extra_cost_3xl).toBe(0.60);
    const def = v4.products.BEAGLE.suppliers.find(s => s.is_default);
    expect(def.supplier).toBe('ROLY');
    expect(def.ref).toBe('CA65540558');
    expect(def.price).toBe(1.7325);
  });

  test('product price table is copied from the matching single pack', () => {
    expect(v4.products.BEAGLE.prices.two_sides.T1).toBe(11.99);
    expect(v4.products.BEAGLE.prices.one_side.T3).toBe(8.45);
    expect(v4.products.URBAN.prices.two_sides.T1).toBe(16.95);
  });

  test('addons are built from the v3 extra_* params', () => {
    expect(v4.addons.name.price).toBe(1.5);
    expect(v4.addons.name.applies_to).toEqual(['*']);
    expect(v4.addons.short_sleeve.price).toBe(1.5);
    expect(v4.addons.short_sleeve.applies_to).toEqual(['tshirt']);
    expect(v4.addons.long_sleeve.price).toBe(3);
    expect(v4.addons.long_sleeve.applies_to).toEqual(['hoodie']);
    expect(v4.addons.long_sleeve.cost).toBe(0.40);
  });

  test('parameters drop v3-only keys and add v4 keys', () => {
    expect(v4.parameters.buffer_3xl_eur_pack).toBeUndefined();
    expect(v4.parameters.extra_name_eur).toBeUndefined();
    expect(v4.parameters.extra_short_sleeve_eur).toBeUndefined();
    expect(v4.parameters.extra_long_sleeve_eur).toBeUndefined();
    expect(v4.parameters.default_target_margin).toBe(0.35);
    expect(v4.parameters.price_rounding_ending).toBe(0.95);
    // kept params
    expect(v4.parameters.vat).toBe(0.21);
    expect(v4.parameters.labor_eur_hour).toBe(15);
  });

  test('crew pack becomes a bundle with the right combo prices', () => {
    const crew = v4.packs.crew_full;
    expect(crew.pricing_mode).toBe('bundle');
    expect(crew.bundle_prices['without_hood|two_sides'].T1).toBe(25.95);
    expect(crew.bundle_prices['with_hood|one_side'].T4).toBe(22.95);
    expect(crew.options.map(o => o.id)).toEqual(['hood', 'sides']);
    const hoodOption = crew.options.find(o => o.id === 'hood');
    expect(hoodOption.maps_product.with_hood).toBe('URBAN');
  });

  test('single packs become components packs', () => {
    expect(v4.packs.tshirts_only.pricing_mode).toBe('components');
    expect(v4.packs.tshirts_only.components[0].product).toBe('BEAGLE');
    expect(v4.packs.tshirts_only.min_total).toBe(10);
  });

  test('mixed pack becomes a two-component components pack', () => {
    const m = v4.packs.hoodies_mixed;
    expect(m.pricing_mode).toBe('components');
    expect(m.components.map(c => c.product)).toEqual(['CLASICA', 'URBAN']);
  });

  test('custom pack becomes free_components', () => {
    expect(v4.packs.custom.free_components).toBe(true);
    expect(v4.packs.custom.pricing_mode).toBe('components');
  });

  test('tiers, company, quote_settings, admin are carried over', () => {
    expect(v4.tiers.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(v4.company.name).toBe('Mi Taller DTF');
    expect(v4.quote_settings.validity_days).toBe(30);
    expect(v4.admin.password).toBe('fuzfuz2026');
  });
});

describe('migrateConfig — idempotence and guards', () => {
  test('a v4 config is returned untouched (same reference)', () => {
    const v4 = migrateConfigV3ToV4(buildV3Config());
    expect(migrateConfig(v4)).toBe(v4);
  });

  test('migrating twice equals migrating once (v2)', () => {
    const v2 = buildV2Config();
    const once = migrateConfig(v2);
    const twice = migrateConfig(migrateConfig(v2));
    expect(twice).toEqual(once);
  });

  test('migrating twice equals migrating once (v3)', () => {
    const v3 = buildV3Config();
    const once = migrateConfig(v3);
    const twice = migrateConfig(migrateConfig(v3));
    expect(twice).toEqual(once);
  });

  test('throws a clear error when required v2 sections are missing', () => {
    expect(() => migrateConfig({ version: '2.0.0' })).toThrow(/secci/i);
  });

  test('throws on non-object input', () => {
    expect(() => migrateConfig(null)).toThrow();
    expect(() => migrateConfig('nope')).toThrow();
  });
});

describe('migrated config validity + legacy parity', () => {
  test('a migrated (v2→v4) config passes the v4 validator', () => {
    const v4 = migrateConfig(buildV2Config());
    expect(collectConfigErrors(v4)).toEqual([]);
  });

  test('a migrated (v3→v4) config passes the v4 validator', () => {
    const v4 = migrateConfigV3ToV4(buildV3Config());
    expect(collectConfigErrors(v4)).toEqual([]);
  });

  test('crew pack reproduces the legacy 311.40 € figure', () => {
    const v4 = migrateConfig(buildV2Config());
    const r = calculatePack(v4, 'crew_full', {
      options: { hood: 'without_hood', sides: 'two_sides' },
      packs: 12
    });
    expect(r.error).toBeUndefined();
    expect(r.total_vat_inc).toBeCloseTo(311.40, 2);
  });

  test('mixed pack reproduces the legacy 193.40 € figure', () => {
    const v4 = migrateConfig(buildV2Config());
    const r = calculatePack(v4, 'hoodies_mixed', {
      options: { sides: 'two_sides' },
      quantities: { classic: 5, urban: 7 }
    });
    expect(r.error).toBeUndefined();
    expect(r.total_vat_inc).toBeCloseTo(193.40, 2);
  });
});

describe('migrateResult — calculation result keys', () => {
  test('renames top-level, breakdown, extras_detail and extra', () => {
    const v2 = {
      pack: 'Pack Peña', tramo: '10-24 uds', cantidad: 12,
      pvp_unitario: 25.95, total_iva_inc: 311.40, base_venta: 257.36,
      iva: 54.04, coste_total: 100, margen: 157.36, margen_pct: 0.5,
      es_mixto: false, subtotal: 311.40,
      extras_detalle: { nombres: 1, mangas_cortas: 0, mangas_largas: 2 },
      desglose: [
        { modelo: 'BEAGLE', nombre: 'Camiseta', cantidad: 12, pvp: 1.5, subtotal: 18, caras: 2 }
      ],
      extra: { capucha: 'sin_capucha', caras: 2 }
    };
    const v3 = migrateResult(v2);
    expect(v3.tier).toBe('10-24 uds');
    expect(v3.quantity).toBe(12);
    expect(v3.unit_price).toBe(25.95);
    expect(v3.total_vat_inc).toBe(311.40);
    expect(v3.sale_base).toBe(257.36);
    expect(v3.vat).toBe(54.04);
    expect(v3.total_cost).toBe(100);
    expect(v3.margin_pct).toBe(0.5);
    expect(v3.is_mixed).toBe(false);
    expect(v3.subtotal).toBe(311.40); // unchanged key
    expect(v3.pack).toBe('Pack Peña'); // unchanged key

    expect(v3.extras_detail).toEqual({ names: 1, short_sleeves: 0, long_sleeves: 2 });
    expect(v3.breakdown[0]).toEqual({
      model: 'BEAGLE', name: 'Camiseta', quantity: 12, price: 1.5, subtotal: 18, sides: 2
    });
    expect(v3.extra).toEqual({ hood: 'sin_capucha', sides: 2 });

    // Old keys gone
    expect(v3.tramo).toBeUndefined();
    expect(v3.total_iva_inc).toBeUndefined();
  });
});

describe('migrateQuote — stored quote', () => {
  const v2Quote = {
    id: 'PP-2026-0001',
    fecha: '2026-05-01T10:00:00.000Z',
    usuario: 'Alberto',
    tipo: 'pena',
    cliente: { nombre: 'Club X', telefono: '600000000', email: 'a@b.c', notas: 'urgente' },
    totales: {
      pack: 'Pack Peña', tramo: '10-24 uds', cantidad: 12,
      pvp_unitario: 25.95, total_iva_inc: 311.40, coste_total: 100, margen_pct: 0.5
    }
  };

  test('renames metadata, customer and embedded totals', () => {
    const v3 = migrateQuote(v2Quote);
    expect(v3.id).toBe('PP-2026-0001');
    expect(v3.date).toBe('2026-05-01T10:00:00.000Z');
    expect(v3.user).toBe('Alberto');
    expect(v3.type).toBe('pena'); // value kept; only the key is renamed
    expect(v3.customer).toEqual({
      name: 'Club X', phone: '600000000', email: 'a@b.c', notes: 'urgente'
    });
    expect(v3.totals.tier).toBe('10-24 uds');
    expect(v3.totals.unit_price).toBe(25.95);
    expect(v3.totals.total_vat_inc).toBe(311.40);

    // Old keys gone
    expect(v3.fecha).toBeUndefined();
    expect(v3.usuario).toBeUndefined();
    expect(v3.cliente).toBeUndefined();
    expect(v3.totales).toBeUndefined();
  });

  test('is idempotent', () => {
    const once = migrateQuote(v2Quote);
    const twice = migrateQuote(migrateQuote(v2Quote));
    expect(twice).toEqual(once);
  });

  test('throws on non-object input', () => {
    expect(() => migrateQuote(null)).toThrow();
  });
});

describe('migrateSettings', () => {
  test('renames per-PC settings keys', () => {
    expect(migrateSettings({ ruta_config: 'C:/Packs/config.js', nombre_usuario: 'Alberto' }))
      .toEqual({ config_path: 'C:/Packs/config.js', user_name: 'Alberto' });
  });

  test('is idempotent on v3 settings', () => {
    const v3 = { config_path: 'C:/x', user_name: 'Alberto' };
    expect(migrateSettings(v3)).toEqual(v3);
  });
});

describe('normalizeAuditEntry', () => {
  test('normalizes a v2 entry (usuario/cambios) to v3 (user/changes)', () => {
    const v2 = {
      timestamp: '2026-05-01T10:00:00.000Z',
      usuario: 'Alberto',
      app_version: '2.0.0',
      cambios: [{ path: 'parametros.iva', kind: 'edit', before: 0.21, after: 0.10 }]
    };
    expect(normalizeAuditEntry(v2)).toEqual({
      timestamp: '2026-05-01T10:00:00.000Z',
      user: 'Alberto',
      app_version: '2.0.0',
      changes: [{ path: 'parametros.iva', kind: 'edit', before: 0.21, after: 0.10 }]
    });
  });

  test('is idempotent on a v3 entry', () => {
    const v3 = { timestamp: 't', user: 'A', app_version: '3.0.0', changes: [] };
    expect(normalizeAuditEntry(v3)).toEqual(v3);
  });
});
