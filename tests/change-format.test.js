import { describe, test, expect } from 'vitest';
import {
  parsePath, entityTypeLabel, entityName, kindBadge
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
