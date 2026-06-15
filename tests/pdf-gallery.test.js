// Tests for the PDF template gallery view-model (renderer/pdf-gallery.js).
// Pure mapping: list + current selection → cards + resolved selection.

import { describe, test, expect } from 'vitest';
import { buildGalleryModel } from '../renderer/pdf-gallery.js';

const BUILTINS = [
  { id: 'clasica', name: 'Clásica' },
  { id: 'moderna', name: 'Moderna' },
  { id: 'compacta', name: 'Compacta' }
];

describe('buildGalleryModel', () => {
  test('marks the stored selection as active', () => {
    const { cards, selectedId } = buildGalleryModel(BUILTINS, 'moderna');
    expect(selectedId).toBe('moderna');
    expect(cards.find((c) => c.id === 'moderna').isSelected).toBe(true);
    expect(cards.filter((c) => c.isSelected)).toHaveLength(1);
  });

  test('falls back to the default id when the selection is unknown', () => {
    const { selectedId, cards } = buildGalleryModel(BUILTINS, 'does-not-exist');
    expect(selectedId).toBe('clasica');
    expect(cards.find((c) => c.id === 'clasica').isSelected).toBe(true);
  });

  test('falls back to the default id when no selection is stored', () => {
    const { selectedId } = buildGalleryModel(BUILTINS, undefined);
    expect(selectedId).toBe('clasica');
  });

  test('falls back to the first card when even the default is absent', () => {
    const list = [{ id: 'moderna', name: 'Moderna' }, { id: 'compacta', name: 'Compacta' }];
    const { selectedId } = buildGalleryModel(list, undefined, { defaultId: 'clasica' });
    expect(selectedId).toBe('moderna');
  });

  test('honours a custom default id', () => {
    const { selectedId } = buildGalleryModel(BUILTINS, null, { defaultId: 'compacta' });
    expect(selectedId).toBe('compacta');
  });

  test('flags custom templates when the built-in id set is provided', () => {
    const list = [...BUILTINS, { id: 'mi-plantilla', name: 'Mi plantilla' }];
    const builtinIds = new Set(BUILTINS.map((t) => t.id));
    const { cards } = buildGalleryModel(list, 'mi-plantilla', { builtinIds });
    const custom = cards.find((c) => c.id === 'mi-plantilla');
    expect(custom.isBuiltin).toBe(false);
    expect(custom.isSelected).toBe(true);
    expect(cards.find((c) => c.id === 'clasica').isBuiltin).toBe(true);
  });

  test('treats every card as built-in when no id set is provided', () => {
    const { cards } = buildGalleryModel(BUILTINS, 'clasica');
    expect(cards.every((c) => c.isBuiltin)).toBe(true);
  });

  test('returns no selection for an empty list', () => {
    const { cards, selectedId } = buildGalleryModel([], 'clasica');
    expect(cards).toEqual([]);
    expect(selectedId).toBeNull();
  });

  test('does not mutate the input list', () => {
    const list = [{ id: 'clasica', name: 'Clásica' }];
    const copy = JSON.parse(JSON.stringify(list));
    buildGalleryModel(list, 'clasica');
    expect(list).toEqual(copy);
  });
});
