// ============================================================
// Tests · lib/pdf-template.js — v3
// ============================================================
import { describe, test, expect } from 'vitest';
import { renderQuoteHtml, DEFAULT_COMPANY, DEFAULT_QUOTE_SETTINGS } from '../lib/pdf-template.js';

const SAMPLE_CREW_QUOTE = {
  id: 'PP-2026-0042',
  date: '2026-05-11T14:32:00Z',
  user: 'Alberto',
  config_version: '3.0.0-beta',
  customer: { name: 'Peña Lobito', phone: '600 000 000' },
  result: {
    pack: 'Pack Peña (camiseta + sudadera)',
    tier: '10-24 uds',
    quantity: 12,
    unit_price: 25.95,
    subtotal: 311.40,
    surcharges: 0,
    extras_no_vat: 0,
    total_vat_inc: 311.40,
    sale_base: 257.36,
    vat: 54.04
  },
  totals: {
    total_vat_inc: 311.40,
    sale_base: 257.36,
    vat: 54.04
  }
};

const SAMPLE_MIXED_QUOTE = {
  id: 'PP-2026-0007',
  date: '2026-05-11T10:00:00Z',
  user: 'María',
  customer: { name: 'Marina' },
  result: {
    pack: 'Pack mixto sudaderas',
    tier: '10-24 uds',
    total_quantity: 12,
    breakdown: [
      { model: 'CLASICA', name: 'Sudadera sin capucha', quantity: 5, price: 14.95, subtotal: 74.75 },
      { model: 'URBAN',   name: 'Sudadera con capucha', quantity: 7, price: 16.95, subtotal: 118.65 }
    ],
    subtotal: 193.40,
    surcharges: 11,
    extras_no_vat: 7.5,
    total_vat_inc: 213.475,
    sale_base: 176.43,
    vat: 37.05
  }
};

describe('renderQuoteHtml — basic shape', () => {
  test('returns a complete HTML document', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<\/html>\s*$/);
  });

  test('embeds the quote id', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE);
    expect(html).toContain('PP-2026-0042');
  });

  test('embeds totals formatted in EUR', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE);
    expect(html).toMatch(/311[,.]40\s?€/);
  });
});

describe('renderQuoteHtml — single-pack rows', () => {
  test('renders one row when breakdown is absent', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE);
    expect((html.match(/<tr>/g) || []).length).toBeGreaterThanOrEqual(2); // header + 1 line
    expect(html).toContain('Pack Peña');
    expect(html).toContain('25,95');
  });
});

describe('renderQuoteHtml — multi-line (breakdown)', () => {
  test('renders one row per breakdown entry', () => {
    const html = renderQuoteHtml(SAMPLE_MIXED_QUOTE);
    expect(html).toContain('Sudadera sin capucha');
    expect(html).toContain('Sudadera con capucha');
    expect(html).toMatch(/74[,.]75/);
    expect(html).toMatch(/118[,.]65/);
  });

  test('shows surcharge and extras lines when present', () => {
    const html = renderQuoteHtml(SAMPLE_MIXED_QUOTE);
    expect(html).toMatch(/Recargo tallas grandes/);
    expect(html).toMatch(/Extras opcionales/);
  });
});

describe('renderQuoteHtml — company / quoteSettings overrides', () => {
  test('applies the supplied company fields', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE, {
      company: { name: 'Imprenta Santander', tax_id: 'B-12345678', phone: '942 00 00 00' }
    });
    expect(html).toContain('Imprenta Santander');
    expect(html).toContain('B-12345678');
    expect(html).toContain('942 00 00 00');
  });

  test('falls back to defaults when no company is supplied', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE);
    expect(html).toContain(DEFAULT_COMPANY.name);
  });

  test('uses quoteSettings.terms override', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE, {
      quoteSettings: { terms: 'Condiciones particulares de prueba.', validity_days: 15 }
    });
    expect(html).toContain('Condiciones particulares de prueba.');
  });

  test('embeds the valid-until date computed from date + days', () => {
    const html = renderQuoteHtml(SAMPLE_CREW_QUOTE, {
      quoteSettings: { ...DEFAULT_QUOTE_SETTINGS, validity_days: 1 }
    });
    expect(html).toContain('Válido hasta');
    expect(html).toContain('12/05/2026'); // 11/05/2026 + 1 day
  });
});

describe('renderQuoteHtml — security', () => {
  test('escapes HTML in customer name', () => {
    const evil = {
      ...SAMPLE_CREW_QUOTE,
      customer: { name: '<script>alert(1)</script>' }
    };
    const html = renderQuoteHtml(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes HTML in user name and pack name', () => {
    const evil = {
      ...SAMPLE_CREW_QUOTE,
      user: '<img onerror=x>',
      result: { ...SAMPLE_CREW_QUOTE.result, pack: '<b>Boom</b>' }
    };
    const html = renderQuoteHtml(evil);
    expect(html).not.toContain('<img onerror=x>');
    expect(html).not.toContain('<b>Boom</b>');
  });
});

describe('renderQuoteHtml — empty / partial input', () => {
  test('handles missing result without throwing', () => {
    const html = renderQuoteHtml({ id: 'PP-2026-0001', date: '2026-05-11T00:00:00Z' });
    expect(html).toContain('PP-2026-0001');
  });

  test('renders even when no customer is provided', () => {
    const noCustomer = { ...SAMPLE_CREW_QUOTE, customer: undefined };
    const html = renderQuoteHtml(noCustomer);
    expect(html).toContain('Cliente');
  });
});
