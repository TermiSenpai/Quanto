// ============================================================
// Tests · lib/cloud-pdf-templates.js — custom PDF template reads
// ============================================================
// Reads custom (user-authored) PDF templates out of the customer's
// D1 `pdf_templates` table. Archived rows are excluded. Pure: the
// D1 client is injected. The HTML these return is UNTRUSTED — the
// caller sanitizes it before render (lib/template-sanitizer.js).
// ============================================================

import { describe, test, expect, vi } from 'vitest';
import { loadPdfTemplate, listPdfTemplates, insertPdfTemplate, listAllPdfTemplateIds } from '../lib/cloud-pdf-templates.js';

function fakeClient(rowsBySql) {
  return {
    query: vi.fn(async (sql) => {
      for (const [needle, results] of rowsBySql) {
        if (sql.includes(needle)) return { results };
      }
      return { results: [] };
    })
  };
}

describe('loadPdfTemplate', () => {
  test('returns the matching template row', async () => {
    const client = fakeClient([
      ['FROM pdf_templates', [{ id: 'mine', name: 'Mía', html: '<p>{{quote.id}}</p>', css: 'p{color:#111}' }]]
    ]);
    const tpl = await loadPdfTemplate(client, 'mine');
    expect(tpl.id).toBe('mine');
    expect(tpl.name).toBe('Mía');
    expect(tpl.html).toContain('{{quote.id}}');
    expect(tpl.css).toContain('color:#111');
  });

  test('passes the id as a bound parameter (not interpolated)', async () => {
    const client = fakeClient([['FROM pdf_templates', [{ id: 'x', name: 'X', html: '<p>x</p>', css: '' }]]]);
    await loadPdfTemplate(client, 'x');
    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['x']);
  });

  test('excludes archived templates (WHERE archived_at IS NULL)', async () => {
    const client = fakeClient([['FROM pdf_templates', [{ id: 'x', name: 'X', html: '<p>x</p>', css: '' }]]]);
    await loadPdfTemplate(client, 'x');
    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/archived_at IS NULL/);
  });

  test('returns null when not found', async () => {
    const client = fakeClient([['FROM pdf_templates', []]]);
    expect(await loadPdfTemplate(client, 'nope')).toBeNull();
  });
});

describe('listPdfTemplates', () => {
  test('returns id+name pairs for the gallery (no html/css payload)', async () => {
    const client = fakeClient([
      ['FROM pdf_templates', [
        { id: 'a', name: 'A', html: 'x', css: '' },
        { id: 'b', name: 'B', html: 'y', css: '' }
      ]]
    ]);
    const list = await listPdfTemplates(client);
    expect(list).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  });

  test('excludes archived templates', async () => {
    const client = fakeClient([['FROM pdf_templates', []]]);
    await listPdfTemplates(client);
    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/archived_at IS NULL/);
  });

  test('returns an empty array when there are none', async () => {
    const client = fakeClient([['FROM pdf_templates', []]]);
    expect(await listPdfTemplates(client)).toEqual([]);
  });
});

describe('listAllPdfTemplateIds', () => {
  test('returns every id INCLUDING archived (no archived_at filter)', async () => {
    const client = fakeClient([
      ['FROM pdf_templates', [{ id: 'a' }, { id: 'b' }, { id: 'gone' }]]
    ]);
    const ids = await listAllPdfTemplateIds(client);
    expect(ids).toEqual(['a', 'b', 'gone']);
    // The dedup needs archived rows too, so this query must NOT filter them.
    const [sql] = client.query.mock.calls[0];
    expect(sql).not.toMatch(/archived_at/);
  });

  test('returns an empty array when there are none', async () => {
    const client = fakeClient([['FROM pdf_templates', []]]);
    expect(await listAllPdfTemplateIds(client)).toEqual([]);
  });
});

describe('insertPdfTemplate', () => {
  test('inserts id+name+html with bound parameters (no interpolation)', async () => {
    const client = { query: vi.fn(async () => ({ results: [] })) };
    const out = await insertPdfTemplate(client, {
      id: 'mi-plantilla', name: 'Mi plantilla', html: '<p>{{quote.id}}</p>', now: '2026-06-13T00:00:00Z'
    });
    expect(out).toEqual({ id: 'mi-plantilla', name: 'Mi plantilla' });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO pdf_templates/);
    // id, name, html bound; css empty; timestamps from `now`.
    expect(params[0]).toBe('mi-plantilla');
    expect(params[1]).toBe('Mi plantilla');
    expect(params[2]).toBe('<p>{{quote.id}}</p>');
    expect(params[3]).toBe('');
    expect(params).toContain('2026-06-13T00:00:00Z');
  });
});
