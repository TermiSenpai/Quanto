// ============================================================
// Tests · lib/pdf-template.js
// ============================================================
import { describe, test, expect } from 'vitest';
import { renderQuoteHtml, DEFAULT_EMPRESA, DEFAULT_PRESUPUESTO } from '../lib/pdf-template.js';

const SAMPLE_PENA_QUOTE = {
  id: 'PP-2026-0042',
  fecha: '2026-05-11T14:32:00Z',
  usuario: 'Alberto',
  config_version: '2.0.0-beta',
  cliente: { nombre: 'Peña Lobito', contacto: '600 000 000' },
  resultado: {
    pack: 'Pack Peña (camiseta + sudadera)',
    tramo: '10-24 uds',
    cantidad: 12,
    pvp_unitario: 25.95,
    subtotal: 311.40,
    recargos: 0,
    extras_sin_iva: 0,
    total_iva_inc: 311.40,
    base_venta: 257.36,
    iva: 54.04
  },
  totales: {
    total_iva_inc: 311.40,
    base_venta: 257.36,
    iva: 54.04
  }
};

const SAMPLE_MIXTO_QUOTE = {
  id: 'PP-2026-0007',
  fecha: '2026-05-11T10:00:00Z',
  usuario: 'María',
  cliente: { nombre: 'Marina' },
  resultado: {
    pack: 'Pack mixto sudaderas',
    tramo: '10-24 uds',
    cantidad_total: 12,
    desglose: [
      { modelo: 'CLASICA', nombre: 'Sudadera sin capucha', cantidad: 5, pvp: 14.95, subtotal: 74.75 },
      { modelo: 'URBAN',   nombre: 'Sudadera con capucha', cantidad: 7, pvp: 16.95, subtotal: 118.65 }
    ],
    subtotal: 193.40,
    recargos: 11,
    extras_sin_iva: 7.5,
    total_iva_inc: 213.475,
    base_venta: 176.43,
    iva: 37.05
  }
};

describe('renderQuoteHtml — basic shape', () => {
  test('returns a complete HTML document', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<\/html>\s*$/);
  });

  test('embeds the quote id', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE);
    expect(html).toContain('PP-2026-0042');
  });

  test('embeds totals formatted in EUR', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE);
    expect(html).toMatch(/311[,.]40\s?€/);
  });
});

describe('renderQuoteHtml — single-pack rows', () => {
  test('renders one row when desglose is absent', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE);
    expect((html.match(/<tr>/g) || []).length).toBeGreaterThanOrEqual(2); // header + 1 line
    expect(html).toContain('Pack Peña');
    expect(html).toContain('25,95');
  });
});

describe('renderQuoteHtml — multi-line (desglose)', () => {
  test('renders one row per desglose entry', () => {
    const html = renderQuoteHtml(SAMPLE_MIXTO_QUOTE);
    expect(html).toContain('Sudadera sin capucha');
    expect(html).toContain('Sudadera con capucha');
    expect(html).toMatch(/74[,.]75/);
    expect(html).toMatch(/118[,.]65/);
  });

  test('shows recargos and extras lines when present', () => {
    const html = renderQuoteHtml(SAMPLE_MIXTO_QUOTE);
    expect(html).toMatch(/Recargo tallas grandes/);
    expect(html).toMatch(/Extras opcionales/);
  });
});

describe('renderQuoteHtml — empresa / presupuesto overrides', () => {
  test('applies the supplied empresa fields', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE, {
      empresa: { nombre: 'Imprenta Santander', cif: 'B-12345678', telefono: '942 00 00 00' }
    });
    expect(html).toContain('Imprenta Santander');
    expect(html).toContain('B-12345678');
    expect(html).toContain('942 00 00 00');
  });

  test('falls back to defaults when no empresa is supplied', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE);
    expect(html).toContain(DEFAULT_EMPRESA.nombre);
  });

  test('uses presupuesto.condiciones override', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE, {
      presupuesto: { condiciones: 'Condiciones particulares de prueba.', validez_dias: 15 }
    });
    expect(html).toContain('Condiciones particulares de prueba.');
  });

  test('embeds the validez_hasta date computed from fecha + days', () => {
    const html = renderQuoteHtml(SAMPLE_PENA_QUOTE, {
      presupuesto: { ...DEFAULT_PRESUPUESTO, validez_dias: 1 }
    });
    expect(html).toContain('Válido hasta');
    expect(html).toContain('12/05/2026'); // 11/05/2026 + 1 day
  });
});

describe('renderQuoteHtml — security', () => {
  test('escapes HTML in client name', () => {
    const evil = {
      ...SAMPLE_PENA_QUOTE,
      cliente: { nombre: '<script>alert(1)</script>' }
    };
    const html = renderQuoteHtml(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes HTML in user name and pack name', () => {
    const evil = {
      ...SAMPLE_PENA_QUOTE,
      usuario: '<img onerror=x>',
      resultado: { ...SAMPLE_PENA_QUOTE.resultado, pack: '<b>Boom</b>' }
    };
    const html = renderQuoteHtml(evil);
    expect(html).not.toContain('<img onerror=x>');
    expect(html).not.toContain('<b>Boom</b>');
  });
});

describe('renderQuoteHtml — empty / partial input', () => {
  test('handles missing resultado without throwing', () => {
    const html = renderQuoteHtml({ id: 'PP-2026-0001', fecha: '2026-05-11T00:00:00Z' });
    expect(html).toContain('PP-2026-0001');
  });

  test('renders even when no cliente is provided', () => {
    const noClient = { ...SAMPLE_PENA_QUOTE, cliente: undefined };
    const html = renderQuoteHtml(noClient);
    expect(html).toContain('Cliente');
  });
});
