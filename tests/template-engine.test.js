// ============================================================
// Tests · lib/template-engine.js — QWeb-style template engine
// ============================================================
// A tiny, dependency-free template engine. Everything it
// substitutes is HTML-escaped (the XSS guarantee): the values are
// data, the template provides the only markup. No raw/unescaped
// form exists. Pure module — no fs, no DOM.
// ============================================================

import { describe, test, expect } from 'vitest';
import { render } from '../lib/template-engine.js';

describe('variables', () => {
  test('substitutes a simple variable', () => {
    expect(render('Hola {{ name }}', { name: 'Ana' })).toBe('Hola Ana');
  });

  test('resolves a dotted path', () => {
    expect(render('{{ company.name }}', { company: { name: 'Taller' } })).toBe('Taller');
  });

  test('resolves a deeply nested dotted path', () => {
    const ctx = { a: { b: { c: 'deep' } } };
    expect(render('{{ a.b.c }}', ctx)).toBe('deep');
  });

  test('tolerates whitespace inside the mustache', () => {
    expect(render('{{name}}|{{  name  }}', { name: 'X' })).toBe('X|X');
  });

  test('a missing path renders an empty string (never undefined/leftover)', () => {
    expect(render('[{{ missing }}]', {})).toBe('[]');
    expect(render('[{{ a.b.c }}]', { a: {} })).toBe('[]');
  });

  test('renders numbers and zero', () => {
    expect(render('{{ n }}', { n: 0 })).toBe('0');
    expect(render('{{ n }}', { n: 12.5 })).toBe('12.5');
  });

  test('a null/undefined value renders empty', () => {
    expect(render('[{{ a }}][{{ b }}]', { a: null, b: undefined })).toBe('[][]');
  });
});

describe('escaping (the XSS guarantee)', () => {
  test('escapes HTML-special characters in values', () => {
    const out = render('{{ v }}', { v: `<script>alert("x")&'</script>` });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#39;');
  });

  test('escapes inside #each items', () => {
    const out = render('{{#each xs}}{{ this }}{{/each}}', { xs: ['<b>'] });
    expect(out).toBe('&lt;b&gt;');
  });

  test('there is no raw/unescaped form — triple mustache is treated as text/var', () => {
    // We only support the escaped double-mustache. A triple brace must
    // never emit raw HTML.
    const out = render('{{ v }}', { v: '<i>x</i>' });
    expect(out).not.toContain('<i>');
  });
});

describe('#each', () => {
  test('iterates an array of primitives with {{this}}', () => {
    expect(render('{{#each xs}}[{{this}}]{{/each}}', { xs: ['a', 'b', 'c'] })).toBe('[a][b][c]');
  });

  test('iterates an array of objects with {{this.x}} and bare {{x}}', () => {
    const ctx = { rows: [{ q: 1, p: 'a' }, { q: 2, p: 'b' }] };
    expect(render('{{#each rows}}{{this.q}}={{p}};{{/each}}', ctx)).toBe('1=a;2=b;');
  });

  test('exposes {{@index}}', () => {
    expect(render('{{#each xs}}{{@index}}:{{this}} {{/each}}', { xs: ['a', 'b'] })).toBe('0:a 1:b ');
  });

  test('renders nothing for an empty array', () => {
    expect(render('A{{#each xs}}{{this}}{{/each}}B', { xs: [] })).toBe('AB');
  });

  test('renders nothing for a missing array', () => {
    expect(render('A{{#each xs}}{{this}}{{/each}}B', {})).toBe('AB');
  });

  test('supports nested #each blocks', () => {
    const ctx = { groups: [{ items: ['a', 'b'] }, { items: ['c'] }] };
    const out = render('{{#each groups}}<g>{{#each items}}{{this}}{{/each}}</g>{{/each}}', ctx);
    expect(out).toBe('<g>ab</g><g>c</g>');
  });

  test('outer context is reachable from a nested each via dotted path', () => {
    const ctx = { title: 'T', rows: [{ v: 1 }, { v: 2 }] };
    const out = render('{{#each rows}}{{v}}{{/each}}{{title}}', ctx);
    expect(out).toBe('12T');
  });
});

describe('#if / else', () => {
  test('renders the truthy branch', () => {
    expect(render('{{#if on}}YES{{/if}}', { on: true })).toBe('YES');
    expect(render('{{#if on}}YES{{/if}}', { on: false })).toBe('');
  });

  test('renders else when falsy', () => {
    expect(render('{{#if on}}A{{else}}B{{/if}}', { on: false })).toBe('B');
    expect(render('{{#if on}}A{{else}}B{{/if}}', { on: true })).toBe('A');
  });

  test('treats a non-empty string / non-zero number as truthy', () => {
    expect(render('{{#if v}}Y{{/if}}', { v: 'x' })).toBe('Y');
    expect(render('{{#if v}}Y{{/if}}', { v: 0 })).toBe('');
    expect(render('{{#if v}}Y{{/if}}', { v: '' })).toBe('');
  });

  test('treats a non-empty array as truthy and an empty array as falsy', () => {
    expect(render('{{#if xs}}Y{{else}}N{{/if}}', { xs: [1] })).toBe('Y');
    expect(render('{{#if xs}}Y{{else}}N{{/if}}', { xs: [] })).toBe('N');
  });

  test('tests a dotted path', () => {
    expect(render('{{#if a.b}}Y{{/if}}', { a: { b: 1 } })).toBe('Y');
    expect(render('{{#if a.b}}Y{{/if}}', { a: {} })).toBe('');
  });

  test('if can wrap variable substitution', () => {
    expect(render('{{#if name}}Hola {{name}}{{/if}}', { name: 'Ana' })).toBe('Hola Ana');
  });

  test('if can be nested inside each', () => {
    const ctx = { rows: [{ big: true, n: 1 }, { big: false, n: 2 }] };
    const out = render('{{#each rows}}{{#if big}}[{{n}}]{{/if}}{{/each}}', ctx);
    expect(out).toBe('[1]');
  });
});

describe('errors and well-formedness', () => {
  test('throws a clear Spanish error on an unclosed #each', () => {
    expect(() => render('{{#each xs}}{{this}}', { xs: [1] })).toThrow(/each/i);
  });

  test('throws a clear Spanish error on an unclosed #if', () => {
    expect(() => render('{{#if v}}x', { v: 1 })).toThrow(/if/i);
  });

  test('throws on a stray {{/each}} with no opening', () => {
    expect(() => render('{{/each}}', {})).toThrow();
  });

  test('leaves no leftover mustaches on a successful render', () => {
    const ctx = { a: 'x', xs: [{ v: 1 }], on: true };
    const out = render('{{a}}{{#each xs}}{{v}}{{/each}}{{#if on}}!{{/if}}', ctx);
    expect(out).not.toContain('{{');
    expect(out).not.toContain('}}');
  });

  test('plain text without mustaches is returned unchanged', () => {
    expect(render('<p>hello</p>', {})).toBe('<p>hello</p>');
  });
});
