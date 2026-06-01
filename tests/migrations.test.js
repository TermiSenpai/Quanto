// ============================================================
// Tests · lib/migrations.js (v2 → v3 data migrations)
// ============================================================
// Covers the universal rules from the migration plan §6.2:
//   - migrateConfig(v2-complete) === v3-expected (canonical fixture)
//   - migrateConfig(v3) === v3 (no-op, same reference)
//   - migrateConfig(migrateConfig(v2)) === migrateConfig(v2) (idempotent)
//   - migrateConfig({version:'2.0.0'}) with missing fields → throws
//   - migrateQuote / migrateSettings / normalizeAuditEntry round-trips
// ============================================================

import { describe, test, expect } from 'vitest';
import {
  migrateConfig,
  migrateQuote,
  migrateResult,
  migrateSettings,
  normalizeAuditEntry
} from '../lib/migrations.js';
import { buildDefaultConfig } from '../config.default.js';
import { buildV2Config } from './fixtures/config-v2.js';

describe('migrateConfig — v2 → v3 round-trip', () => {
  test('a complete v2 config migrates to exactly the v3 defaults', () => {
    const v2 = buildV2Config({ fecha_actualizacion: 'X-DATE', modificado_por: 'Y-USER' });
    const expected = buildDefaultConfig({ updated_at: 'X-DATE', modified_by: 'Y-USER' });
    expect(migrateConfig(v2)).toEqual(expected);
  });

  test('top-level meta keys are renamed', () => {
    const v3 = migrateConfig(buildV2Config({ fecha_actualizacion: 'D', modificado_por: 'U' }));
    expect(v3.version).toBe('3.0.0');
    expect(v3.updated_at).toBe('D');
    expect(v3.modified_by).toBe('U');
    expect(v3.fecha_actualizacion).toBeUndefined();
    expect(v3.modificado_por).toBeUndefined();
  });

  test('admin.clave becomes admin.password', () => {
    const v3 = migrateConfig(buildV2Config());
    expect(v3.admin.password).toBe('fuzfuz2026');
    expect(v3.admin.clave).toBeUndefined();
  });

  test('parameters keys are renamed', () => {
    const v3 = migrateConfig(buildV2Config());
    expect(v3.parameters.vat).toBe(0.21);
    expect(v3.parameters.labor_eur_hour).toBe(15);
    expect(v3.parameters.dtf_meters_two_sides).toBe(0.40);
    expect(v3.parameters.iva).toBeUndefined();
    expect(v3.parameters.mo_eur_hora).toBeUndefined();
  });

  test('roly model keys are renamed, ids and user-facing values kept', () => {
    const v3 = migrateConfig(buildV2Config());
    expect(v3.roly_models.BEAGLE.name).toBe('Camiseta'); // Spanish on purpose
    expect(v3.roly_models.BEAGLE.price).toBe(1.7325);
    expect(v3.roly_models.BEAGLE.nombre).toBeUndefined();
  });

  test('tier keys are renamed, T-ids and labels kept', () => {
    const v3 = migrateConfig(buildV2Config());
    expect(v3.tiers.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(v3.tiers[0].label).toBe('10-24 uds'); // Spanish on purpose
    expect(v3.tiers[0].from).toBe(10);
    expect(v3.tiers[0].to).toBe(24);
    expect(v3.tiers[3].to).toBeNull();
    expect(v3.tiers[0].desde).toBeUndefined();
  });

  test('pack ids, types, price keys and references are renamed', () => {
    const v3 = migrateConfig(buildV2Config());

    // Pack ids
    expect(v3.packs.crew_full).toBeDefined();
    expect(v3.packs.tshirts_only).toBeDefined();
    expect(v3.packs.hoodies_mixed).toBeDefined();
    expect(v3.packs.custom).toBeDefined();
    expect(v3.packs.pena_completa).toBeUndefined();

    // Type values
    expect(v3.packs.crew_full.type).toBe('crew');
    expect(v3.packs.tshirts_only.type).toBe('single');
    expect(v3.packs.hoodies_mixed.type).toBe('mixed');
    expect(v3.packs.custom.type).toBe('custom');

    // Price structure (T-ids preserved)
    expect(v3.packs.crew_full.prices.without_hood.two_sides.T1).toBe(25.95);
    expect(v3.packs.crew_full.prices.with_hood.one_side.T4).toBe(22.95);
    expect(v3.packs.tshirts_only.prices.one_side.T3).toBe(8.45);

    // Reference maps (keys = model ids; values = renamed pack ids)
    expect(v3.packs.hoodies_mixed.reference_packs.CLASICA).toBe('classic_only');
    expect(v3.packs.custom.reference_models.BEAGLE).toBe('tshirts_only');
  });

  test('company and quote_settings are renamed; terms text kept', () => {
    const v3 = migrateConfig(buildV2Config());
    expect(v3.company.name).toBe('Mi Taller DTF');
    expect(v3.company.tax_id).toBe('');
    expect(v3.quote_settings.validity_days).toBe(30);
    expect(v3.quote_settings.terms).toMatch(/IVA incluido/); // Spanish on purpose
    expect(v3.empresa).toBeUndefined();
    expect(v3.presupuesto).toBeUndefined();
  });
});

describe('migrateConfig — idempotence and guards', () => {
  test('a v3 config is returned untouched (same reference)', () => {
    const v3 = buildDefaultConfig();
    expect(migrateConfig(v3)).toBe(v3);
  });

  test('migrating twice equals migrating once', () => {
    const v2 = buildV2Config();
    const once = migrateConfig(v2);
    const twice = migrateConfig(migrateConfig(v2));
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
