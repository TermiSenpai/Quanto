import { describe, test, expect } from 'vitest';
import {
  parsePath, entityTypeLabel, entityName, kindBadge, fieldLabel
} from '../renderer/change-format.js';

describe('parsePath', () => {
  test('per-id entity field', () => {
    expect(parsePath('suppliers.SUPPLIER_1.name'))
      .toEqual({ entityType: 'supplier', id: 'SUPPLIER_1', rel: 'name' });
  });
  test('per-id nested array field', () => {
    expect(parsePath('products.BEAGLE.suppliers[0].price'))
      .toEqual({ entityType: 'product', id: 'BEAGLE', rel: 'suppliers[0].price' });
  });
  test('entity root (whole add/remove) → empty rel', () => {
    expect(parsePath('suppliers.SUPPLIER_1'))
      .toEqual({ entityType: 'supplier', id: 'SUPPLIER_1', rel: '' });
  });
  test('global singleton', () => {
    expect(parsePath('parameters.vat'))
      .toEqual({ entityType: 'parameters', id: null, rel: 'vat' });
  });
  test('global with array index', () => {
    expect(parsePath('tiers[1].to'))
      .toEqual({ entityType: 'tiers', id: null, rel: '[1].to' });
  });
  test('unknown top-level section falls back to itself', () => {
    expect(parsePath('weird.path')).toEqual({ entityType: 'weird', id: null, rel: 'path' });
  });
});

describe('entityTypeLabel', () => {
  test('maps known types', () => {
    expect(entityTypeLabel('supplier')).toBe('Proveedor');
    expect(entityTypeLabel('product')).toBe('Producto');
    expect(entityTypeLabel('pack')).toBe('Pack');
    expect(entityTypeLabel('addon')).toBe('Complemento');
    expect(entityTypeLabel('parameters')).toBe('Parámetros de cálculo');
    expect(entityTypeLabel('tiers')).toBe('Tramos por volumen');
    expect(entityTypeLabel('company')).toBe('Empresa');
  });
});

describe('entityName', () => {
  test('prefers name, then label, then id', () => {
    expect(entityName('supplier', { name: 'Valento' }, 'SUPPLIER_1')).toBe('Valento');
    expect(entityName('addon', { label: 'Bolsillo' }, 'a1')).toBe('Bolsillo');
    expect(entityName('product', {}, 'BEAGLE')).toBe('BEAGLE');
    expect(entityName('product', null, 'BEAGLE')).toBe('BEAGLE');
  });
});

describe('kindBadge', () => {
  test('label + css class per kind', () => {
    expect(kindBadge('add')).toEqual({ label: 'Nuevo', cls: 'add' });
    expect(kindBadge('remove')).toEqual({ label: 'Eliminado', cls: 'remove' });
    expect(kindBadge('edit')).toEqual({ label: 'Editado', cls: 'change' });
  });
});

describe('fieldLabel', () => {
  test('supplier fields', () => {
    expect(fieldLabel('supplier', 'name')).toBe('Nombre');
    expect(fieldLabel('supplier', 'web')).toBe('Web');
    expect(fieldLabel('supplier', 'notes')).toBe('Notas');
  });
  test('product simple + indexed + nested-table fields', () => {
    expect(fieldLabel('product', 'target_margin')).toBe('Margen objetivo');
    expect(fieldLabel('product', 'extra_cost_3xl')).toBe('Coste extra 3XL');
    expect(fieldLabel('product', 'suppliers[0].price')).toBe('Proveedor 1 · Precio base');
    expect(fieldLabel('product', 'prices.two_sides.T1')).toBe('PVP · 2 caras · Tramo T1');
    expect(fieldLabel('product', 'prices.one_side.T3')).toBe('PVP · 1 cara · Tramo T3');
  });
  test('pack fields', () => {
    expect(fieldLabel('pack', 'pricing_mode')).toBe('Modo de precio');
    expect(fieldLabel('pack', 'free_components')).toBe('Componentes libres');
    expect(fieldLabel('pack', 'options[0].values[1].label')).toBe('Opción 1 · Valor 2 · Etiqueta');
    expect(fieldLabel('pack', 'bundle_prices.two_sides.T1')).toBe('PVP · two_sides · Tramo T1');
  });
  test('addon fields', () => {
    expect(fieldLabel('addon', 'label')).toBe('Etiqueta');
    expect(fieldLabel('addon', 'vat_included')).toBe('IVA incluido');
  });
  test('parameters reuse admin labels', () => {
    expect(fieldLabel('parameters', 'vat')).toBe('IVA aplicado');
    expect(fieldLabel('parameters', 'default_target_margin')).toBe('Margen objetivo por defecto');
  });
  test('tiers indexed fields', () => {
    expect(fieldLabel('tiers', '[0].to')).toBe('Tramo 1 · Hasta');
    expect(fieldLabel('tiers', '[2].label')).toBe('Tramo 3 · Etiqueta');
  });
  test('unknown field → readable fallback, never dotted/JSON', () => {
    const out = fieldLabel('product', 'mystery_field');
    expect(out).not.toContain('.');
    expect(out.length).toBeGreaterThan(0);
  });
});
