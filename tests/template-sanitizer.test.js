// ============================================================
// Tests · lib/template-sanitizer.js — custom-template sanitizer
// ============================================================
// Custom PDF templates are SHARED DATA (loaded from the cloud
// pdf_templates store, possibly authored on another PC). Before we
// ever render one we sanitize it: strip/reject scripts, event
// handlers, javascript: URLs, dangerous elements, and external
// resource refs. Inline <style>, style= and {{…}} placeholders must
// survive untouched (the templates need CSS + the engine syntax).
// Pure module — no fs, no DOM.
// ============================================================

import { describe, test, expect } from 'vitest';
import { sanitizeTemplate } from '../lib/template-sanitizer.js';

describe('rejects dangerous constructs (throws a clear Spanish error)', () => {
  test('rejects <script>', () => {
    expect(() => sanitizeTemplate('<p>ok</p><script>alert(1)</script>')).toThrow(/script/i);
  });

  test('rejects an on* event attribute', () => {
    expect(() => sanitizeTemplate('<div onclick="x()">hi</div>')).toThrow(/evento|on|atributo/i);
  });

  test('rejects an onerror attribute', () => {
    expect(() => sanitizeTemplate('<img onerror="boom()">')).toThrow(/evento|on|atributo/i);
  });

  test('rejects a javascript: URL', () => {
    expect(() => sanitizeTemplate('<a href="javascript:alert(1)">x</a>')).toThrow(/javascript/i);
  });

  test('rejects <iframe>', () => {
    expect(() => sanitizeTemplate('<iframe src="x"></iframe>')).toThrow(/iframe/i);
  });

  test('rejects <object>', () => {
    expect(() => sanitizeTemplate('<object data="x"></object>')).toThrow(/object/i);
  });

  test('rejects <embed>', () => {
    expect(() => sanitizeTemplate('<embed src="x">')).toThrow(/embed/i);
  });

  test('rejects <link> (external stylesheet)', () => {
    expect(() => sanitizeTemplate('<link rel="stylesheet" href="x.css">')).toThrow(/link/i);
  });

  test('rejects <meta http-equiv>', () => {
    expect(() => sanitizeTemplate('<meta http-equiv="refresh" content="0;url=x">')).toThrow(/meta|http-equiv/i);
  });

  test('rejects an external http(s) src', () => {
    expect(() => sanitizeTemplate('<img src="http://evil.com/p.png">')).toThrow(/extern|recurso|http/i);
  });

  test('rejects an external https href', () => {
    expect(() => sanitizeTemplate('<a href="https://evil.com">x</a>')).toThrow(/extern|recurso|http/i);
  });

  test('rejects a protocol-relative // URL', () => {
    expect(() => sanitizeTemplate('<img src="//evil.com/p.png">')).toThrow(/extern|recurso/i);
  });

  test('rejects an external url() in inline CSS', () => {
    expect(() => sanitizeTemplate('<div style="background:url(https://evil.com/x.png)">x</div>')).toThrow(/extern|recurso|url/i);
  });

  test('rejects an external url() inside <style>', () => {
    expect(() => sanitizeTemplate('<style>body{background:url(//evil.com/x.png)}</style>')).toThrow(/extern|recurso|url/i);
  });

  // --- @import bare-string external CSS (bypasses url()) ---
  test('rejects @import "http://…" bare string', () => {
    expect(() => sanitizeTemplate('<style>@import "http://evil.com/x.css";</style>')).toThrow(/extern|recurso|import/i);
  });

  test("rejects @import 'https://…' bare string (single quotes)", () => {
    expect(() => sanitizeTemplate("<style>@import 'https://evil.com/x.css';</style>")).toThrow(/extern|recurso|import/i);
  });

  test('rejects @import "//evil/…" protocol-relative bare string', () => {
    expect(() => sanitizeTemplate('<style>@import "//evil.com/x.css";</style>')).toThrow(/extern|recurso|import/i);
  });

  // --- entity/whitespace-obfuscated javascript:/vbscript: schemes ---
  test('rejects a javascript: scheme with an entity-encoded colon (&#58;)', () => {
    expect(() => sanitizeTemplate('<a href="javascript&#58;alert(1)">x</a>')).toThrow(/javascript/i);
  });

  test('rejects a javascript: scheme with a hex entity colon (&#x3a;)', () => {
    expect(() => sanitizeTemplate('<a href="javascript&#x3a;alert(1)">x</a>')).toThrow(/javascript/i);
  });

  test('rejects a javascript: scheme with intra-scheme whitespace (tab)', () => {
    expect(() => sanitizeTemplate('<a href="java\tscript:alert(1)">x</a>')).toThrow(/javascript/i);
  });

  test('rejects a javascript: scheme with intra-scheme whitespace (newline)', () => {
    expect(() => sanitizeTemplate('<a href="java\nscript:alert(1)">x</a>')).toThrow(/javascript/i);
  });

  test('rejects a vbscript: scheme with an entity-encoded colon', () => {
    expect(() => sanitizeTemplate('<a href="vbscript&#58;msgbox(1)">x</a>')).toThrow(/javascript|vbscript/i);
  });
});

describe('keeps legitimate content intact', () => {
  test('allows inline <style> with safe CSS', () => {
    const html = '<style>body{font-family:serif;color:#111}</style><p>Hola</p>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('allows inline style= attributes', () => {
    const html = '<div style="color:#3D7BD9;padding:8px">x</div>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('keeps {{…}} placeholders untouched', () => {
    const html = '<p>{{ company.name }} — {{#each items}}{{this.concept}}{{/each}}</p>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('allows a data: image URI (self-contained, no network)', () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('allows a local-ish relative anchor without protocol', () => {
    const html = '<a href="#section">x</a>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('allows a data: url() in CSS', () => {
    const html = '<div style="background:url(data:image/gif;base64,R0lGOD)">x</div>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('allows a data: @import (self-contained, no network)', () => {
    const html = '<style>@import "data:text/css,body{margin:0}";</style><p>x</p>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('allows a template without any @import', () => {
    const html = '<style>body{color:#111}</style><p>Hola</p>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('allows a data: image href (base64 colon present, not a scheme)', () => {
    const html = '<a href="data:image/png;base64,iVBORw0KGgo=">x</a>';
    expect(sanitizeTemplate(html)).toBe(html);
  });

  test('returns a string for a full safe document', () => {
    const html = '<!doctype html><html><head><style>p{margin:0}</style></head><body><p>{{x}}</p></body></html>';
    expect(sanitizeTemplate(html)).toBe(html);
  });
});

describe('input validation', () => {
  test('throws on a non-string input', () => {
    expect(() => sanitizeTemplate(null)).toThrow();
    expect(() => sanitizeTemplate(42)).toThrow();
  });
});
