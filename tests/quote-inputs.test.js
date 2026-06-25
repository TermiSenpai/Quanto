// ============================================================
// quote-inputs.js tests — planInputs + optFromPlan (pure, Node)
// ============================================================
// Covers all three pack modes: bundle (crew_full), components
// (hoodies_mixed), and free_components (custom). Each mode has:
//   1. A `planInputs` smoke test (expected plan shape).
//   2. A round-trip test: optFromPlan(pack, planInputs(pack, opt))
//      deep-equals the original opt.
// No DOM, no globals — Vitest environment: 'node'.
// ============================================================
import { describe, test, expect } from 'vitest';
import { planInputs, optFromPlan } from '../renderer/quote-inputs.js';
import { buildFullConfigV4 } from './fixtures/config-v4-full.js';

const CFG = buildFullConfigV4();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-equal check that also validates there are no extra keys. */
function deepEq(a, b) {
  expect(a).toStrictEqual(b);
}

// ---------------------------------------------------------------------------
// Mode: bundle  (pack = crew_full)
// ---------------------------------------------------------------------------
describe('planInputs — bundle mode (crew_full)', () => {
  const pack = CFG.packs.crew_full;

  // A representative opt for crew_full: 12 packs, hood=with_hood, sides=two_sides,
  // one addon (name × 3), and some 3XL garments.
  const opt = {
    options:  { hood: 'with_hood', sides: 'two_sides' },
    addons:   { name: 3 },
    qty_3xl:  2,
    qty_4xl:  0,
    qty_5xl:  0,
    packs:    12
  };

  test('planInputs returns correct plan', () => {
    const plan = planInputs(pack, opt);

    expect(plan.mode).toBe('bundle');
    deepEq(plan.options, { hood: 'with_hood', sides: 'two_sides' });
    deepEq(plan.addons, { name: 3 });
    deepEq(plan.sizes, { qty_3xl: 2, qty_4xl: 0, qty_5xl: 0 });
    expect(plan.packs).toBe(12);
    expect(plan.quantities).toBeNull();
    expect(plan.lines).toBeNull();
  });

  test('round-trip: optFromPlan(pack, planInputs(pack, opt)) deep-equals opt', () => {
    const reconstructed = optFromPlan(pack, planInputs(pack, opt));
    deepEq(reconstructed, opt);
  });
});

// ---------------------------------------------------------------------------
// Mode: components  (pack = hoodies_mixed — two components: classic + urban)
// ---------------------------------------------------------------------------
describe('planInputs — components mode (hoodies_mixed)', () => {
  const pack = CFG.packs.hoodies_mixed;

  // A representative opt for hoodies_mixed: 15 classic, 10 urban.
  const opt = {
    options:    { sides: 'one_side' },
    addons:     { long_sleeve: 5 },
    qty_3xl:    0,
    qty_4xl:    1,
    qty_5xl:    0,
    quantities: { classic: 15, urban: 10 }
  };

  test('planInputs returns correct plan', () => {
    const plan = planInputs(pack, opt);

    expect(plan.mode).toBe('components');
    deepEq(plan.options, { sides: 'one_side' });
    deepEq(plan.addons, { long_sleeve: 5 });
    deepEq(plan.sizes, { qty_3xl: 0, qty_4xl: 1, qty_5xl: 0 });
    expect(plan.packs).toBeNull();
    deepEq(plan.quantities, { classic: 15, urban: 10 });
    expect(plan.lines).toBeNull();
  });

  test('round-trip: optFromPlan(pack, planInputs(pack, opt)) deep-equals opt', () => {
    const reconstructed = optFromPlan(pack, planInputs(pack, opt));
    deepEq(reconstructed, opt);
  });
});

// ---------------------------------------------------------------------------
// Mode: free_components  (pack = custom)
// ---------------------------------------------------------------------------
describe('planInputs — free mode (custom)', () => {
  const pack = CFG.packs.custom;

  // A representative opt for the custom pack: two free lines.
  const opt = {
    options: { sides: 'two_sides' },
    addons:  {},
    qty_3xl: 0,
    qty_4xl: 0,
    qty_5xl: 0,
    lines:   [
      { product: 'BEAGLE', quantity: 20 },
      { product: 'URBAN',  quantity: 5  }
    ]
  };

  test('planInputs returns correct plan', () => {
    const plan = planInputs(pack, opt);

    expect(plan.mode).toBe('free');
    deepEq(plan.options, { sides: 'two_sides' });
    deepEq(plan.addons, {});
    deepEq(plan.sizes, { qty_3xl: 0, qty_4xl: 0, qty_5xl: 0 });
    expect(plan.packs).toBeNull();
    expect(plan.quantities).toBeNull();
    deepEq(plan.lines, [
      { product: 'BEAGLE', quantity: 20 },
      { product: 'URBAN',  quantity: 5  }
    ]);
  });

  test('round-trip: optFromPlan(pack, planInputs(pack, opt)) deep-equals opt', () => {
    const reconstructed = optFromPlan(pack, planInputs(pack, opt));
    deepEq(reconstructed, opt);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('planInputs — edge cases', () => {
  test('addons with qty=0 are excluded from plan', () => {
    const pack = CFG.packs.crew_full;
    const opt = {
      options:  { hood: 'without_hood', sides: 'one_side' },
      addons:   { name: 0, short_sleeve: 0 },
      qty_3xl:  0, qty_4xl: 0, qty_5xl: 0,
      packs:    10
    };
    const plan = planInputs(pack, opt);
    // Zero-quantity addons must be stripped (mirrors collectInputs behaviour).
    deepEq(plan.addons, {});
  });

  test('missing opt fields default gracefully', () => {
    const pack = CFG.packs.tshirts_only;
    // Minimal opt — no addons, no sizes, quantities absent.
    const opt = {
      options:    { sides: 'two_sides' },
      quantities: { tshirt: 30 }
    };
    const plan = planInputs(pack, opt);
    expect(plan.mode).toBe('components');
    deepEq(plan.sizes, { qty_3xl: 0, qty_4xl: 0, qty_5xl: 0 });
    deepEq(plan.addons, {});
  });

  test('optFromPlan reconstructs an opt with no addons correctly', () => {
    const pack = CFG.packs.crew_full;
    const opt = {
      options:  { hood: 'without_hood', sides: 'two_sides' },
      addons:   {},
      qty_3xl:  0, qty_4xl: 0, qty_5xl: 0,
      packs:    20
    };
    deepEq(optFromPlan(pack, planInputs(pack, opt)), opt);
  });
});
