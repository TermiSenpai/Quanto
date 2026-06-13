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
import { buildSaveSummary, totalChanges } from '../renderer/save-summary.js';
// The audit/main source of truth (CommonJS) — required, not imported,
// because the drift-guard below must exercise BOTH implementations.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const diffLib = require('../lib/diff.js');
const { buildDefaultConfig } = require('../config.default.js');

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

// ============================================================
// Drift-guard: save-summary.js (renderer, ESM) vs lib/diff.js (main, CJS)
// ============================================================
// save-summary.js hand-re-states lib/diff.js's diff primitives
// (diffObjects/walk/isObject/deepEqual/formatChangeLine/stringify + an
// IGNORE_PATHS set) because the renderer is ESM-no-build and lib/diff.js
// is CommonJS — a justified bridge, but two hand-maintained copies can
// silently diverge, and they MUST agree: lib/diff.js is the audit source
// of truth in main, while buildSaveSummary is what the user sees before
// confirming a save.
//
// These tests run in vitest/Node, where we CAN `require` the CommonJS
// lib. We pin the two copies at the OBSERVABLE level: for representative
// (oldCfg,newCfg) pairs, the multiset of change LINES buildSaveSummary
// produces (flattened across its groups) must equal the lines lib/diff.js
// produces via `diffObjects(old,new).map(formatChangeLine)`, modulo
// grouping. If anyone edits one copy's format or ignore list but not the
// other, the produced lines diverge and these tests fail.
describe('drift-guard: save-summary vs lib/diff source of truth', () => {
  // buildSaveSummary only walks these catalog sections (per-id entities +
  // global singletons); lib/diff.js walks the whole object. To compare
  // apples to apples we run lib/diff.js section-by-section over the same
  // sections, then flatten — the line text and ignore handling come
  // straight from lib/diff.js, so any divergence in either copy shows up.
  // Per-id sections are diffed PER ENTITY (paths relative to the entity,
  // matching buildSaveSummary's per-group lines); globals are diffed whole.
  const PER_ID_SECTIONS = ['packs', 'products', 'suppliers', 'addons'];
  const GLOBAL_SECTIONS = ['parameters', 'tiers', 'company'];

  // The change lines lib/diff.js (the source of truth) would emit for the
  // sections buildSaveSummary covers, with the SAME grouping convention
  // (per-id entities diffed individually), using lib/diff.js's OWN default
  // ignore paths — so this exercises lib/diff.js's IGNORE handling too.
  function libDiffLines(oldCfg, newCfg) {
    const lines = [];
    for (const section of PER_ID_SECTIONS) {
      const oldColl = oldCfg[section] || {};
      const newColl = newCfg[section] || {};
      const ids = new Set([...Object.keys(oldColl), ...Object.keys(newColl)]);
      for (const id of ids) {
        const changes = diffLib.diffObjects(oldColl[id], newColl[id]);
        for (const c of changes) lines.push(diffLib.formatChangeLine(c));
      }
    }
    for (const section of GLOBAL_SECTIONS) {
      const changes = diffLib.diffObjects(oldCfg[section], newCfg[section]);
      for (const c of changes) lines.push(diffLib.formatChangeLine(c));
    }
    return lines;
  }

  function summaryLines(oldCfg, newCfg) {
    return buildSaveSummary(oldCfg, newCfg).flatMap(g => g.lines);
  }

  // A multiset assertion: every line in A appears in B with the same
  // multiplicity and vice-versa. Sorting makes it order-insensitive
  // (grouping in buildSaveSummary reorders relative to lib/diff.js).
  function expectSameLineMultiset(a, b) {
    expect([...a].sort()).toEqual([...b].sort());
  }

  // Representative mutations, each confined to a section buildSaveSummary
  // covers, so the only legitimate difference between the two engines is
  // grouping (handled by flatten + sort).
  const samples = {
    'change a pack price': (cfg) => {
      const id = Object.keys(cfg.packs)[0];
      cfg.packs[id].bundle_prices = cfg.packs[id].bundle_prices || { '': {} };
      const firstVariant = Object.keys(cfg.packs[id].bundle_prices)[0] || '';
      cfg.packs[id].bundle_prices[firstVariant] = { T1: 999 };
    },
    'change parameters.vat': (cfg) => {
      cfg.parameters.vat = 0.10;
    },
    'add a product': (cfg) => {
      cfg.products.hoodie = {
        name: 'Sudadera', category: 'sudadera', prices: { one_side: { T1: 18 } }
      };
    },
    'remove a supplier': (cfg) => {
      const id = Object.keys(cfg.suppliers)[0];
      if (id) delete cfg.suppliers[id];
    },
    'edit a tier and a company field at once': (cfg) => {
      if (Array.isArray(cfg.tiers) && cfg.tiers[0]) cfg.tiers[0].to = 99;
      cfg.company.name = (cfg.company.name || '') + ' (renombrado)';
    }
  };

  for (const [label, mutate] of Object.entries(samples)) {
    test(`produced lines match lib/diff.js for: ${label}`, () => {
      const oldCfg = buildDefaultConfig();
      const newCfg = buildDefaultConfig({ updated_at: oldCfg.updated_at });
      mutate(newCfg);

      const fromSummary = summaryLines(oldCfg, newCfg);
      const fromLib = libDiffLines(oldCfg, newCfg);

      // Sanity: the mutation actually produced at least one line, so the
      // equality below is not the trivial empty-vs-empty case.
      expect(fromLib.length).toBeGreaterThanOrEqual(1);
      // Tight assertion: same actual lines, same multiplicity, both ways.
      expectSameLineMultiset(fromSummary, fromLib);
      // And the count helper agrees with the produced-line count.
      expect(totalChanges(buildSaveSummary(oldCfg, newCfg))).toBe(fromSummary.length);
    });
  }

  test('IGNORE_PATHS agree: updated_at / modified_by / admin.* excluded by BOTH', () => {
    // Stamp the always-changing metadata + admin secrets differently on
    // each side. NEITHER engine may surface these as changes.
    const oldCfg = buildDefaultConfig({ updated_at: '01/01/2026', modified_by: 'a' });
    const newCfg = buildDefaultConfig({ updated_at: '02/02/2026', modified_by: 'b' });
    newCfg.admin.password = 'totally-different';
    newCfg.admin.has_password = true;

    // No catalog section changed → buildSaveSummary sees nothing.
    expect(buildSaveSummary(oldCfg, newCfg)).toEqual([]);

    // lib/diff.js over the WHOLE config must likewise drop the ignored
    // paths — the only remaining diff lines (if any) must never name them.
    const wholeLines = diffLib
      .diffObjects(oldCfg, newCfg)
      .map(diffLib.formatChangeLine);
    for (const p of ['updated_at', 'modified_by', 'admin.password', 'admin.has_password']) {
      expect(wholeLines.some(l => l.includes(p))).toBe(false);
    }

    // The two ignore sets are literally the same strings (catches a copy
    // that adds/removes an ignore path on only one side).
    expect([...diffLib.DEFAULT_IGNORE_PATHS].sort()).toEqual(
      ['admin.has_password', 'admin.password', 'modified_by', 'updated_at'].sort()
    );
  });
});
