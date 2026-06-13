// ============================================================
// SVG chart helpers (renderer/charts.js)
// ============================================================
// charts.js is a hand-rolled, dependency-free SVG charting module
// (CLAUDE.md rule 9 forbids chart libraries). It is PURE: each function
// takes data + opts and returns a self-contained `<svg>…</svg>` string —
// no DOM, no window, no fetch. The renderer injects the string later
// (Task 5C). These tests pin the structure (rect/polyline/line counts),
// the XSS-safe escaping of cfg/D1 labels, the empty-state fallback, the
// accessibility `<desc>`, and that no "NaN"/"undefined"/"Infinity" ever
// leaks into the output.
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  barChartH,
  barChartV,
  groupedBars,
  lineChart,
  histogram
} from '../renderer/charts.js';

// Count occurrences of a tag like <rect / <polyline / <line in an SVG string.
function count(svg, tag) {
  const m = svg.match(new RegExp(`<${tag}[\\s>]`, 'g'));
  return m ? m.length : 0;
}

// Shared sanity assertions every produced SVG must satisfy.
function assertSafe(svg) {
  expect(typeof svg).toBe('string');
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  expect(svg).not.toMatch(/NaN/);
  expect(svg).not.toMatch(/undefined/);
  expect(svg).not.toMatch(/Infinity/);
  // Top-level accessibility description (UI-UX §2.8).
  expect(svg).toMatch(/<desc>/);
}

describe('barChartH', () => {
  test('renders one rect per item with escaped labels and title tooltips', () => {
    const svg = barChartH([
      { label: 'Pack peña', value: 12 },
      { label: 'Solo camisetas', value: 5 },
      { label: 'Mixto', value: 3 }
    ]);
    assertSafe(svg);
    // One bar rect per item.
    expect(count(svg, 'rect')).toBeGreaterThanOrEqual(3);
    expect(svg).toContain('Pack peña');
    expect(svg).toContain('Solo camisetas');
    // Native hover tooltip per bar.
    expect(count(svg, 'title')).toBeGreaterThanOrEqual(3);
  });

  test('escapes a malicious label (XSS from cfg/D1)', () => {
    const svg = barChartH([{ label: '<script>alert(1)</script>', value: 7 }]);
    assertSafe(svg);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('escapes ampersands and quotes', () => {
    const svg = barChartH([{ label: 'A & B "C" <D>', value: 1 }]);
    assertSafe(svg);
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;D&gt;');
    expect(svg).not.toMatch(/<D>/);
  });

  test('empty data → friendly empty-state, no broken axis', () => {
    const svg = barChartH([]);
    assertSafe(svg);
    expect(svg).toContain('Sin datos');
    expect(count(svg, 'rect')).toBe(0);
  });

  test('all-zero values do not divide by zero', () => {
    const svg = barChartH([{ label: 'a', value: 0 }, { label: 'b', value: 0 }]);
    assertSafe(svg);
  });
});

describe('barChartV', () => {
  test('renders one rect per item with escaped labels', () => {
    const svg = barChartV([
      { label: 'T1', value: 4 },
      { label: 'T2', value: 9 },
      { label: 'T3', value: 2 },
      { label: 'T4', value: 1 }
    ]);
    assertSafe(svg);
    expect(count(svg, 'rect')).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('T1');
    expect(svg).toContain('T4');
  });

  test('escapes malicious label', () => {
    const svg = barChartV([{ label: '<script>x</script>', value: 3 }]);
    assertSafe(svg);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('empty data → empty-state', () => {
    const svg = barChartV([]);
    assertSafe(svg);
    expect(svg).toContain('Sin datos');
    expect(count(svg, 'rect')).toBe(0);
  });
});

describe('groupedBars', () => {
  test('renders one rect per bar across all groups', () => {
    const svg = groupedBars([
      { label: 'Peña', bars: [{ value: 30, color: '#1FA86A', name: 'Real' }, { value: 35, color: '#D98A1F', name: 'Objetivo' }] },
      { label: 'Mixto', bars: [{ value: 28, color: '#1FA86A', name: 'Real' }, { value: 35, color: '#D98A1F', name: 'Objetivo' }] }
    ]);
    assertSafe(svg);
    // 2 groups × 2 bars = 4 rects (at least).
    expect(count(svg, 'rect')).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('Peña');
    expect(svg).toContain('Mixto');
  });

  test('escapes malicious group + bar labels', () => {
    const svg = groupedBars([
      { label: '<script>g</script>', bars: [{ value: 1, color: '#000', name: '<script>b</script>' }] }
    ]);
    assertSafe(svg);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('empty groups → empty-state', () => {
    const svg = groupedBars([]);
    assertSafe(svg);
    expect(svg).toContain('Sin datos');
    expect(count(svg, 'rect')).toBe(0);
  });

  test('group with empty bars array does not crash or NaN', () => {
    const svg = groupedBars([{ label: 'X', bars: [] }]);
    assertSafe(svg);
  });
});

describe('lineChart', () => {
  test('renders one polyline per series over an axis', () => {
    const svg = lineChart([
      { name: 'Presupuestado', color: '#3D7BD9', points: [10, 20, 15, 30] },
      { name: 'Aceptado', color: '#1FA86A', points: [5, 12, 9, 18] }
    ]);
    assertSafe(svg);
    expect(count(svg, 'polyline')).toBe(2);
    expect(svg).toContain('Presupuestado');
    expect(svg).toContain('Aceptado');
    // Axis lines present.
    expect(count(svg, 'line')).toBeGreaterThanOrEqual(1);
  });

  test('accepts {x,y} point objects', () => {
    const svg = lineChart([
      { name: 'S', color: '#3D7BD9', points: [{ x: 0, y: 1 }, { x: 1, y: 4 }, { x: 2, y: 2 }] }
    ]);
    assertSafe(svg);
    expect(count(svg, 'polyline')).toBe(1);
  });

  test('escapes malicious series name', () => {
    const svg = lineChart([{ name: '<script>s</script>', color: '#000', points: [1, 2, 3] }]);
    assertSafe(svg);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('empty series → empty-state, no polyline', () => {
    const svg = lineChart([]);
    assertSafe(svg);
    expect(svg).toContain('Sin datos');
    expect(count(svg, 'polyline')).toBe(0);
  });

  test('single flat series (all equal y) does not divide by zero', () => {
    const svg = lineChart([{ name: 'flat', color: '#000', points: [5, 5, 5] }]);
    assertSafe(svg);
    expect(count(svg, 'polyline')).toBe(1);
  });

  test('series with a single point still renders safely', () => {
    const svg = lineChart([{ name: 'one', color: '#000', points: [7] }]);
    assertSafe(svg);
  });
});

describe('histogram', () => {
  test('renders one rect per bucket with escaped labels', () => {
    const svg = histogram([
      { label: '-20%', count: 2 },
      { label: '-10%', count: 5 },
      { label: '0%', count: 9 },
      { label: '+10%', count: 1 }
    ]);
    assertSafe(svg);
    expect(count(svg, 'rect')).toBeGreaterThanOrEqual(4);
    expect(svg).toContain('-20%');
    expect(svg).toContain('+10%');
  });

  test('escapes malicious bucket label', () => {
    const svg = histogram([{ label: '<script>h</script>', count: 3 }]);
    assertSafe(svg);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('empty buckets → empty-state', () => {
    const svg = histogram([]);
    assertSafe(svg);
    expect(svg).toContain('Sin datos');
    expect(count(svg, 'rect')).toBe(0);
  });

  test('all-zero counts do not divide by zero', () => {
    const svg = histogram([{ label: 'a', count: 0 }, { label: 'b', count: 0 }]);
    assertSafe(svg);
  });
});

describe('determinism + opts', () => {
  test('same input produces the same SVG string', () => {
    const data = [{ label: 'x', value: 3 }, { label: 'y', value: 7 }];
    expect(barChartH(data)).toBe(barChartH(data));
    expect(barChartV(data)).toBe(barChartV(data));
  });

  test('respects custom width/height', () => {
    const svg = barChartH([{ label: 'a', value: 1 }], { width: 500, height: 240 });
    assertSafe(svg);
    expect(svg).toContain('width="500"');
    expect(svg).toContain('height="240"');
  });

  test('tolerates non-finite/NaN values without leaking them', () => {
    const svg = barChartH([
      { label: 'bad', value: NaN },
      { label: 'inf', value: Infinity },
      { label: 'ok', value: 4 }
    ]);
    assertSafe(svg);
  });

  test('tolerates missing/non-string labels', () => {
    const svg = barChartH([{ value: 5 }, { label: 123, value: 2 }]);
    assertSafe(svg);
  });
});
