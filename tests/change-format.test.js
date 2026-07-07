import { describe, test, expect } from 'vitest';
import {
  parsePath, entityTypeLabel, entityName, kindBadge, fieldLabel, formatValue,
  humanizeChange, groupChanges, renderChangeGroup, renderEntityValues, escHtml
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

describe('formatValue', () => {
  test('euro fields', () => {
    expect(formatValue('product', 'suppliers[0].price', 3.5)).toBe('3,50 €');
    expect(formatValue('product', 'prices.two_sides.T1', 12)).toBe('12,00 €');
    expect(formatValue('addon', 'price', 2)).toBe('2,00 €');
    expect(formatValue('parameters', 'labor_eur_hour', 15)).toBe('15,00 €');
  });
  test('percent fields', () => {
    expect(formatValue('product', 'target_margin', 0.35)).toBe('35 %');
    expect(formatValue('parameters', 'vat', 0.21)).toBe('21 %');
    expect(formatValue('parameters', 'waste_pct', 0.1)).toBe('10 %');
  });
  test('booleans', () => {
    expect(formatValue('product', 'suppliers[0].is_default', true)).toBe('Sí');
    expect(formatValue('pack', 'free_components', false)).toBe('No');
  });
  test('pricing_mode mapping', () => {
    expect(formatValue('pack', 'pricing_mode', 'bundle')).toBe('Por unidad');
    expect(formatValue('pack', 'pricing_mode', 'components')).toBe('Por componentes');
  });
  test('text, empty, null, number', () => {
    expect(formatValue('supplier', 'name', 'Valento')).toBe('«Valento»');
    expect(formatValue('supplier', 'web', '')).toBe('(vacío)');
    expect(formatValue('supplier', 'notes', null)).toBe('(vacío)');
    expect(formatValue('pack', 'min_total', 12)).toBe('12');
  });
  test('object value never shows JSON', () => {
    expect(formatValue('supplier', '', { name: 'x' })).toBe('(varios datos)');
  });
});

describe('humanizeChange', () => {
  test('change with explicit entityType (relative path)', () => {
    expect(humanizeChange({ path: 'name', before: 'A', after: 'B', kind: 'change' }, 'supplier'))
      .toBe('Nombre: «A» → «B»');
  });
  test('add field', () => {
    expect(humanizeChange({ path: 'price', after: 2, kind: 'add' }, 'addon'))
      .toBe('Precio (€/ud): 2,00 €');
  });
  test('remove field', () => {
    expect(humanizeChange({ path: 'web', before: 'x.com', kind: 'remove' }, 'supplier'))
      .toBe('Web: se quita («x.com»)');
  });
  test('derives entityType from a full path when not given', () => {
    expect(humanizeChange({ path: 'parameters.vat', before: 0.21, after: 0.1, kind: 'change' }))
      .toBe('IVA aplicado: 21 % → 10 %');
  });
});

describe('groupChanges', () => {
  test('groups flat full-path changes by entity, detects edit', () => {
    const groups = groupChanges([
      { path: 'suppliers.S1.name', before: 'A', after: 'B', kind: 'change' },
      { path: 'suppliers.S1.web', before: '', after: 'b.com', kind: 'add' },
      { path: 'parameters.vat', before: 0.21, after: 0.1, kind: 'change' }
    ]);
    const s = groups.find(g => g.id === 'S1');
    expect(s.entityType).toBe('supplier');
    expect(s.kind).toBe('edit');
    expect(s.fieldChanges).toHaveLength(2);
    const p = groups.find(g => g.entityType === 'parameters');
    expect(p.id).toBeNull();
    expect(p.kind).toBe('edit');
  });
  test('whole-entity add → kind add, no field rows, name from object', () => {
    const groups = groupChanges([
      { path: 'suppliers.S2', before: undefined, after: { name: 'Valento' }, kind: 'add' }
    ]);
    expect(groups[0]).toMatchObject({ entityType: 'supplier', id: 'S2', kind: 'add', name: 'Valento' });
    expect(groups[0].fieldChanges).toEqual([]);
  });
  test('whole-entity remove → kind remove, name from old object', () => {
    const groups = groupChanges([
      { path: 'products.P1', before: { name: 'Camiseta' }, after: undefined, kind: 'remove' }
    ]);
    expect(groups[0]).toMatchObject({ entityType: 'product', id: 'P1', kind: 'remove', name: 'Camiseta' });
  });
});

describe('renderChangeGroup', () => {
  test('edit group renders badge, name and humanized rows, no JSON/paths', () => {
    const html = renderChangeGroup({
      entityType: 'product', id: 'BEAGLE', kind: 'edit', name: 'Camiseta',
      fieldChanges: [{ path: 'target_margin', before: 0.35, after: 0.4, kind: 'change' }]
    });
    expect(html).toContain('Editado');
    expect(html).toContain('Producto');
    expect(html).toContain('Camiseta');
    expect(html).toContain('Margen objetivo');
    expect(html).toContain('35 %');
    expect(html).toContain('40 %');
    expect(html).not.toContain('target_margin');
    expect(html).not.toContain('{');
  });
  test('add group renders only the summary line', () => {
    const html = renderChangeGroup({ entityType: 'supplier', id: 'S1', kind: 'add', name: 'Valento', fieldChanges: [] });
    expect(html).toContain('Nuevo');
    expect(html).toContain('Proveedor');
    expect(html).toContain('Valento');
    expect(html).not.toContain('{');
  });
  test('escapes malicious names', () => {
    const html = renderChangeGroup({ entityType: 'supplier', id: 'S1', kind: 'add', name: '<img>', fieldChanges: [] });
    expect(html).not.toContain('<img>');
    expect(html).toContain('&lt;img&gt;');
  });
});

describe('renderEntityValues', () => {
  test('renders friendly key:value rows (conflict columns), no JSON', () => {
    const html = renderEntityValues('supplier', { name: 'Valento', web: '' });
    expect(html).toContain('Nombre');
    expect(html).toContain('Valento');
    expect(html).toContain('Web');
    expect(html).not.toContain('{');
  });
  test('null slice → muted no-data row', () => {
    expect(renderEntityValues('supplier', null)).toContain('sin datos');
  });
});
