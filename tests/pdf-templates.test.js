// ============================================================
// Tests · lib/pdf-templates.js — 6 built-ins + context + brand
// ============================================================
// The built-in PDF templates are engine-syntax HTML+CSS strings.
// buildQuoteContext flattens a quote into the render context;
// brandColors derives the dark/soft tints from a base hex; and
// renderQuote picks a template (built-in or a provided custom
// {html}) and renders it. Pure module — no fs, no DOM.
// ============================================================

import { describe, test, expect } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  buildQuoteContext,
  brandColors,
  renderQuote,
  renderPreview,
  listBuiltinTemplates,
  APP_ACCENT
} from '../lib/pdf-templates.js';

const SAMPLE_CREW_QUOTE = {
  id: 'PP-2026-0042',
  date: '2026-05-11T14:32:00Z',
  user: 'Alberto',
  config_version: '4.0.0',
  customer: { name: 'Peña Lobito', phone: '600 000 000' },
  result: {
    pack: 'Pack Peña (camiseta + sudadera)',
    tier: '10-24 uds',
    quantity: 12,
    total_quantity: 12,
    unit_price: 25.95,
    subtotal: 311.40,
    surcharges: 0,
    extras_no_vat: 0,
    total_vat_inc: 311.40,
    sale_base: 257.36,
    vat: 54.04,
    qty_3xl: 0, qty_4xl: 0, qty_5xl: 0
  },
  totals: { total_vat_inc: 311.40, sale_base: 257.36, vat: 54.04 }
};

const SAMPLE_MIXED_QUOTE = {
  id: 'PP-2026-0007',
  date: '2026-05-11T10:00:00Z',
  user: 'María',
  customer: { name: 'Marina', phone: '611 111 111' },
  result: {
    pack: 'Pack mixto sudaderas',
    pricing_mode: 'components',
    tier: '10-24 uds',
    total_quantity: 12,
    quantity: 12,
    breakdown: [
      { model: 'CLASICA', name: 'Sudadera sin capucha', quantity: 5, sides: 2, unit_price: 14.95, subtotal: 74.75 },
      { model: 'URBAN', name: 'Sudadera con capucha', quantity: 7, sides: 2, unit_price: 16.95, subtotal: 118.65 }
    ],
    subtotal: 193.40,
    surcharges: 11,
    surcharge_lines: [
      { size: '4XL', quantity: 2, unit_price: 3, subtotal: 6 },
      { size: '5XL+', quantity: 1, unit_price: 5, subtotal: 5 }
    ],
    extras_no_vat: 7.5,
    extras_vat_inc: 9.075,
    total_vat_inc: 213.475,
    sale_base: 176.43,
    vat: 37.05,
    qty_3xl: 1, qty_4xl: 2, qty_5xl: 1
  }
};

const SAMPLE_BUNDLE_QUOTE = {
  id: 'PP-2026-0100',
  date: '2026-05-11T10:00:00Z',
  customer: { name: 'Peña Bundle', phone: '622 000 000' },
  result: {
    pricing_mode: 'bundle',
    pack: 'Pack Peña (camiseta + sudadera)',
    tier: '10-24 uds',
    total_quantity: 12, quantity: 12,
    unit_price: 25.95, subtotal: 311.40,
    surcharges: 0, extras_no_vat: 0,
    total_vat_inc: 311.40, sale_base: 257.36, vat: 54.04,
    breakdown: [{
      model: 'crew_full', name: 'Pack Peña', quantity: 12, sides: 2, unit_price: 25.95, subtotal: 311.40,
      components: [
        { model: 'BEAGLE',  name: 'Camiseta', quantity: 12, unit_price: 11.55, subtotal: 138.60 },
        { model: 'CLASICA', name: 'Sudadera', quantity: 12, unit_price: 14.40, subtotal: 172.80 }
      ]
    }]
  }
};

const BUILTIN_IDS = ['clasica', 'moderna', 'compacta', 'detallada', 'corporativa', 'formulario'];

// Rough balance check: a self-contained document should open and close
// the same number of <body>/<table> tags (a crude well-formedness probe
// against truncated templates).
function balanced(html, tag) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
  return open === close;
}

describe('BUILTIN_TEMPLATES', () => {
  test('exposes exactly the 6 expected ids', () => {
    expect(BUILTIN_TEMPLATES.map(t => t.id)).toEqual(BUILTIN_IDS);
  });

  test('each has id, name and html string', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.html).toBe('string');
      expect(t.html.length).toBeGreaterThan(0);
    }
  });

  test('no built-in references external resources', () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.html).not.toMatch(/https?:\/\//);
      expect(t.html).not.toMatch(/src\s*=\s*["']?\/\//);
      expect(t.html).not.toMatch(/<\s*link\b/i);
      expect(t.html).not.toMatch(/url\(\s*["']?https?:/i);
    }
  });

  test('no built-in contains a signature block (digital quotes)', () => {
    // Digital quotes have no signatures. We look for signature-line
    // markup, not the substring "firma" (which appears inside the
    // {{confirmation}} placeholder name, con-FIRMA-tion).
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.html).not.toMatch(/\bfirma\b/i);
      expect(t.html).not.toMatch(/firmado/i);
      expect(t.html).not.toMatch(/firma del/i);
    }
  });
});

describe('brandColors', () => {
  test('derives color/dark/soft from a valid hex', () => {
    const b = brandColors('#3D7BD9');
    expect(b.color.toLowerCase()).toBe('#3d7bd9');
    expect(b.dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(b.soft).toMatch(/^#[0-9a-f]{6}$/i);
    expect(b.dark.toLowerCase()).not.toBe(b.color.toLowerCase());
    expect(b.soft.toLowerCase()).not.toBe(b.color.toLowerCase());
  });

  test('accepts a 3-digit shorthand hex', () => {
    const b = brandColors('#08f');
    expect(b.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test('dark is darker and soft is lighter than the base', () => {
    const lum = (hex) => {
      const h = hex.replace('#', '');
      return parseInt(h.slice(0, 2), 16) + parseInt(h.slice(2, 4), 16) + parseInt(h.slice(4, 6), 16);
    };
    const b = brandColors('#3D7BD9');
    expect(lum(b.dark)).toBeLessThan(lum(b.color));
    expect(lum(b.soft)).toBeGreaterThan(lum(b.color));
  });

  test('falls back to the app accent on an invalid hex', () => {
    for (const bad of [null, undefined, '', 'red', '#xyz', '12345', '#1234']) {
      expect(brandColors(bad).color.toLowerCase()).toBe(APP_ACCENT.toLowerCase());
    }
  });
});

describe('buildQuoteContext', () => {
  test('flattens company, quote and client fields', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, {
      company: { name: 'Imprenta Santander', tax_id: 'B-1', phone: '942', email: 'a@b.c', web: 'w', address: 'Calle 1' },
      quoteSettings: { validity_days: 30, terms: 'Condiciones de prueba.' }
    });
    expect(ctx.company.name).toBe('Imprenta Santander');
    expect(ctx.company.tax_id).toBe('B-1');
    expect(ctx.quote.id).toBe('PP-2026-0042');
    expect(ctx.client.name).toBe('Peña Lobito');
    expect(ctx.client.phone).toBe('600 000 000');
    expect(ctx.conditions).toBe('Condiciones de prueba.');
  });

  test('builds line items for a single-pack result', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, {});
    expect(Array.isArray(ctx.items)).toBe(true);
    expect(ctx.items.length).toBe(1);
    expect(ctx.items[0].concept).toContain('Pack Peña');
    expect(ctx.items[0].qty).toBe('12');
  });

  test('builds one line item per breakdown entry', () => {
    const ctx = buildQuoteContext(SAMPLE_MIXED_QUOTE, {});
    expect(ctx.items.length).toBe(2);
    expect(ctx.items[0].concept).toContain('Sudadera sin capucha');
    expect(ctx.items[1].concept).toContain('Sudadera con capucha');
  });

  test('computes totals (base/vat/total) as formatted strings', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, {});
    // base = Σ rows (12 × 21.45 = 257.40); the IVA line absorbs the
    // rounding drift against the charged total (311.40 − 257.40).
    expect(ctx.totals.total).toMatch(/311[,.]40/);
    expect(ctx.totals.base).toMatch(/257[,.]40/);
    expect(ctx.totals.vat).toMatch(/54[,.]00/);
  });

  test('derives a valid_until from date + validity_days', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, { quoteSettings: { validity_days: 1, terms: '' } });
    expect(ctx.quote.valid_until).toContain('12/05/2026');
  });

  test('itemizes bundle components as one line each', () => {
    const ctx = buildQuoteContext(SAMPLE_BUNDLE_QUOTE, {});
    expect(ctx.items.length).toBe(2);
    expect(ctx.items[0].concept).toContain('Camiseta');
    expect(ctx.items[1].concept).toContain('Sudadera');
  });

  test('shows ex-VAT unit prices (net), not the VAT-inc PVP', () => {
    const ctx = buildQuoteContext(SAMPLE_MIXED_QUOTE, {});
    // 74.75 / 1.21 / 5 ≈ 12.36 (net), never the 14.95 PVP
    expect(ctx.items[0].unit).not.toMatch(/14[,.]95/);
  });

  test('itemizes extras when the result carries extras_lines', () => {
    const withExtras = {
      ...SAMPLE_MIXED_QUOTE,
      result: {
        ...SAMPLE_MIXED_QUOTE.result,
        extras_lines: [{ id: 'name', name: 'Nombre', quantity: 3, unit_price: 1.815, subtotal: 5.445, vat_included: false }]
      }
    };
    const ctx = buildQuoteContext(withExtras, {});
    expect(ctx.extras_lines.length).toBe(1);
    expect(ctx.extras_lines[0].concept).toBe('Nombre');
  });

  test('itemizes the large-size surcharge per size (qty + ex-VAT unit)', () => {
    const ctx = buildQuoteContext(SAMPLE_MIXED_QUOTE, {});
    expect(ctx.surcharge_lines.length).toBe(2);
    expect(ctx.surcharge_lines[0].concept).toMatch(/4XL/);
    expect(ctx.surcharge_lines[0].qty).toBe('2');
    expect(ctx.surcharge_lines[0].unit).not.toBe('—');
  });

  test('legacy surcharge_line/extras_line derive from the same table rows', () => {
    const ctx = buildQuoteContext(SAMPLE_MIXED_QUOTE, {});
    // surcharge rows: 2 × 2.48 + 1 × 4.13 = 9.09 net
    expect(ctx.has_surcharge).toBe(true);
    expect(ctx.surcharge_line.subtotal).toMatch(/9[,.]09/);
    // extras (legacy collapsed, no extras_lines in the result): 7.50 net
    expect(ctx.has_extras).toBe(true);
    expect(ctx.extras_line.concept).toBe('Extras opcionales (sin IVA)');
    expect(ctx.extras_line.subtotal).toMatch(/7[,.]50/);
  });

  test('keeps per_person for a single-line quote (custom templates)', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, {});
    expect(ctx.has_per_person).toBe(true);
    expect(ctx.per_person).toMatch(/25[,.]95/);
  });

  test('keeps per_person for an itemized bundle (one pack per person)', () => {
    const ctx = buildQuoteContext(SAMPLE_BUNDLE_QUOTE, {});
    expect(ctx.items.length).toBe(2);
    expect(ctx.has_per_person).toBe(true);
    expect(ctx.per_person).toMatch(/25[,.]95/);
  });

  test('marks special sizes present when 4XL/5XL exist', () => {
    const ctx = buildQuoteContext(SAMPLE_MIXED_QUOTE, {});
    expect(ctx.has_special_sizes).toBe(true);
    expect(ctx.special_sizes).toMatch(/4XL/);
  });

  test('omits special sizes when none', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, {});
    expect(ctx.has_special_sizes).toBe(false);
  });

  test('exposes a brand object and a confirmation note', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, { brand: brandColors('#3D7BD9') });
    expect(ctx.brand.color.toLowerCase()).toBe('#3d7bd9');
    expect(typeof ctx.confirmation).toBe('string');
    expect(ctx.confirmation.length).toBeGreaterThan(0);
  });

  test('exposes a logo data URI when provided', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE, { logoDataUri: 'data:image/png;base64,AAAA' });
    expect(ctx.logo).toBe('data:image/png;base64,AAAA');
    expect(ctx.has_logo).toBe(true);
  });
});

describe('renderQuote — every built-in renders clean', () => {
  for (const id of BUILTIN_IDS) {
    test(`'${id}' renders the crew quote with no leftover mustaches`, () => {
      const html = renderQuote(SAMPLE_CREW_QUOTE, {
        templateId: id,
        company: { name: 'Taller DTF', tax_id: 'B-9', phone: '942', email: '', web: '', address: '' },
        quoteSettings: { validity_days: 30, terms: 'Condiciones del taller.' },
        brand: brandColors('#3D7BD9')
      });
      expect(html).not.toContain('{{');
      expect(html).not.toContain('}}');
      expect(html).toContain('PP-2026-0042');
      expect(html).toContain('Taller DTF');
      expect(balanced(html, 'body')).toBe(true);
      expect(balanced(html, 'table')).toBe(true);
      expect(balanced(html, 'html')).toBe(true);
    });

    test(`'${id}' renders the mixed quote (breakdown + special sizes)`, () => {
      const html = renderQuote(SAMPLE_MIXED_QUOTE, {
        templateId: id,
        company: { name: 'Taller DTF' },
        quoteSettings: { validity_days: 30, terms: 'X' },
        brand: brandColors('#3D7BD9')
      });
      expect(html).not.toContain('{{');
      expect(html).toContain('Sudadera sin capucha');
      expect(html).toContain('Sudadera con capucha');
    });

    test(`'${id}' no longer prints a per-person figure`, () => {
      const html = renderQuote(SAMPLE_CREW_QUOTE, {
        templateId: id, company: { name: 'T' }, quoteSettings: { terms: '' }, brand: brandColors('#3D7BD9')
      });
      expect(html).not.toMatch(/por\s+persona/i);
    });

    test(`'${id}' no longer prints the "Tallas con recargo" summary`, () => {
      const html = renderQuote(SAMPLE_MIXED_QUOTE, {
        templateId: id, company: { name: 'T' }, quoteSettings: { terms: '' }, brand: brandColors('#3D7BD9')
      });
      expect(html).not.toMatch(/Tallas con recargo/i);
    });
  }
});

describe('renderQuote — template selection', () => {
  test('falls back to clasica when templateId is missing', () => {
    const a = renderQuote(SAMPLE_CREW_QUOTE, {});
    const b = renderQuote(SAMPLE_CREW_QUOTE, { templateId: 'clasica' });
    expect(a).toBe(b);
  });

  test('falls back to clasica on an unknown id', () => {
    const a = renderQuote(SAMPLE_CREW_QUOTE, { templateId: 'does-not-exist' });
    const b = renderQuote(SAMPLE_CREW_QUOTE, { templateId: 'clasica' });
    expect(a).toBe(b);
  });

  test('renders a provided custom {html} template', () => {
    const html = renderQuote(SAMPLE_CREW_QUOTE, {
      custom: { html: '<div>Cliente: {{ client.name }} — {{ quote.id }}</div>' }
    });
    expect(html).toContain('Cliente: Peña Lobito');
    expect(html).toContain('PP-2026-0042');
  });
});

describe('renderQuote — security (XSS)', () => {
  test('escapes a malicious client name in every built-in', () => {
    const evil = {
      ...SAMPLE_CREW_QUOTE,
      customer: { name: '<script>alert(1)</script>', phone: '<img onerror=x>' }
    };
    for (const id of BUILTIN_IDS) {
      const html = renderQuote(evil, { templateId: id, company: { name: 'T' }, quoteSettings: { terms: '' } });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<img onerror=x>');
    }
  });
});

describe('renderQuote — brand colors in color templates', () => {
  test('moderna and corporativa embed the brand color', () => {
    const brand = brandColors('#FF6600');
    for (const id of ['moderna', 'corporativa']) {
      const html = renderQuote(SAMPLE_CREW_QUOTE, {
        templateId: id, company: { name: 'T' }, quoteSettings: { terms: '' }, brand
      });
      expect(html.toLowerCase()).toContain('#ff6600');
    }
  });
});

describe('listBuiltinTemplates — gallery list', () => {
  test('returns id+name only for every built-in, no html', () => {
    const list = listBuiltinTemplates();
    expect(list).toHaveLength(BUILTIN_TEMPLATES.length);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name']);
      expect(typeof item.id).toBe('string');
      expect(typeof item.name).toBe('string');
    }
  });
});

describe('renderPreview — settings preview (Task 6B)', () => {
  test('renders the demo quote with no leftover mustaches', () => {
    const html = renderPreview({ templateId: 'clasica' });
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('{{');
  });

  test('applies the brand color to a color template', () => {
    const html = renderPreview({ templateId: 'moderna', brandColor: '#0a8754' });
    expect(html.toLowerCase()).toContain('#0a8754');
  });

  test('escapes the demo client name (XSS guarantee even in preview)', () => {
    const html = renderPreview({ templateId: 'clasica' });
    expect(html).not.toContain('<demo>');
    expect(html).toContain('&lt;demo&gt;');
  });

  test('renders a provided pre-sanitized custom template', () => {
    const custom = { html: '<!doctype html><html><body><h1>{{company.name}}</h1></body></html>' };
    const html = renderPreview({ custom, company: { name: 'Taller Demo' } });
    expect(html).toContain('Taller Demo');
    expect(html).not.toContain('{{');
  });
});
