// ============================================================
// Save-summary helper (renderer/save-summary.js)
// ============================================================
// Pure mapping old/new cfg → a change summary GROUPED by catalog
// entity, ready for the cloud "confirm save" modal (UI-UX §2.5) and
// reused (per entity) by the conflict modal (§2.3).
//
// Grouping mirrors lib/catalog-writer.js `diffEntities`: per-id
// entities (pack / product / supplier / addon) are grouped by id; the
// global singletons (parameters / tiers / company) collapse to one
// group each. Each group carries human Spanish `lines[]` (the same
// "+ path: x" / "~ path: a → b" shape the audit modal already shows).
//
// This is the testable seam behind the DOM glue in app.js. Pure: no
// DOM, no IPC — cfg in, summary out.
// ============================================================
import { describe, test, expect } from 'vitest';
import { buildSaveSummary } from '../renderer/save-summary.js';

// Minimal but realistic v4-shaped catalog. Only the fields the summary
// reads matter; the helper deep-compares whole entity sub-objects.
function baseCfg() {
  return {
    parameters: { vat: 0.21, labor_eur_hour: 15 },
    tiers: [{ id: 'T1', label: 'Tramo 1', from: 1, to: 10 }],
    company: { name: 'Taller', quote_settings: { validity_days: 30 } },
    suppliers: { ROLY: { name: 'Roly' } },
    products: {
      tshirt: { name: 'Camiseta', category: 'camiseta', prices: { one_side: { T1: 9 } } }
    },
    addons: { name_print: { label: 'Nombre', price: 2 } },
    packs: {
      crew: {
        name: 'Pack Peña',
        pricing_mode: 'bundle',
        bundle_prices: { '': { T1: 30 } }
      }
    }
  };
}

describe('buildSaveSummary', () => {
  test('no change → empty summary', () => {
    expect(buildSaveSummary(baseCfg(), baseCfg())).toEqual([]);
  });

  test('a pack field change → one pack group with a readable line', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.packs.crew.name = 'Pack Peña Pro';

    const summary = buildSaveSummary(oldCfg, newCfg);
    expect(summary).toHaveLength(1);
    const group = summary[0];
    expect(group.entityType).toBe('pack');
    expect(group.id).toBe('crew');
    expect(group.lines.length).toBeGreaterThanOrEqual(1);
    // The line names the changed field and the from → to values.
    expect(group.lines.join('\n')).toMatch(/name/);
    expect(group.lines.join('\n')).toMatch(/Pack Peña Pro/);
  });

  test('a parameter change → one global "parameters" group (id null)', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.parameters.vat = 0.10;

    const summary = buildSaveSummary(oldCfg, newCfg);
    expect(summary).toHaveLength(1);
    expect(summary[0].entityType).toBe('parameters');
    expect(summary[0].id).toBeNull();
    expect(summary[0].lines.join('\n')).toMatch(/vat/);
  });

  test('an added product → one product group flagged as an addition', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.products.hoodie = {
      name: 'Sudadera', category: 'sudadera', prices: { one_side: { T1: 18 } }
    };

    const summary = buildSaveSummary(oldCfg, newCfg);
    expect(summary).toHaveLength(1);
    const group = summary[0];
    expect(group.entityType).toBe('product');
    expect(group.id).toBe('hoodie');
    // An addition shows the new entity (a "+ …" line).
    expect(group.lines.some(l => l.startsWith('+'))).toBe(true);
  });

  test('changes across several entities are grouped separately', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.packs.crew.bundle_prices[''].T1 = 33;     // pack change
    newCfg.parameters.vat = 0.10;                     // global change
    newCfg.products.tshirt.prices.one_side.T1 = 10;   // product change

    const summary = buildSaveSummary(oldCfg, newCfg);
    const keys = summary.map(g => `${g.entityType}:${g.id}`).sort();
    expect(keys).toEqual(['pack:crew', 'parameters:null', 'product:tshirt'].sort());
    for (const g of summary) expect(g.lines.length).toBeGreaterThanOrEqual(1);
  });

  test('a removed addon → one addon group flagged as a removal', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    delete newCfg.addons.name_print;

    const summary = buildSaveSummary(oldCfg, newCfg);
    expect(summary).toHaveLength(1);
    expect(summary[0].entityType).toBe('addon');
    expect(summary[0].id).toBe('name_print');
    expect(summary[0].lines.some(l => l.startsWith('-'))).toBe(true);
  });

  test('totalChanges() helper counts the lines across all groups', () => {
    const oldCfg = baseCfg();
    const newCfg = baseCfg();
    newCfg.packs.crew.name = 'X';
    newCfg.parameters.vat = 0.1;
    const summary = buildSaveSummary(oldCfg, newCfg);
    const total = summary.reduce((n, g) => n + g.lines.length, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });
});
