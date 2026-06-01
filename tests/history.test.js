// ============================================================
// Tests · lib/history.js — v3
// ============================================================
import { describe, test, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  saveQuote,
  listQuotes,
  searchQuotes,
  deleteQuote,
  getQuote,
  nextIdForYear,
  historyPathFor,
  HISTORY_FILE_NAME
} from '../lib/history.js';

const dirs = [];
afterAll(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-history-'));
  dirs.push(dir);
  return dir;
}

describe('historyPathFor', () => {
  test('returns the file inside the userData directory', () => {
    const dir = makeUserData();
    expect(historyPathFor(dir)).toBe(path.join(dir, HISTORY_FILE_NAME));
  });
});

describe('nextIdForYear', () => {
  test('starts at 0001 when there are no entries for the year', () => {
    expect(nextIdForYear([], 2026)).toBe('PP-2026-0001');
  });

  test('takes max+1 of the same year only', () => {
    const existing = [
      { id: 'PP-2025-0010' },
      { id: 'PP-2026-0003' },
      { id: 'PP-2026-0001' },
      { id: 'PP-2026-0007' }
    ];
    expect(nextIdForYear(existing, 2026)).toBe('PP-2026-0008');
    expect(nextIdForYear(existing, 2027)).toBe('PP-2027-0001');
  });

  test('ignores malformed ids', () => {
    const existing = [{ id: 'BAD' }, { id: null }, { id: 'PP-2026-NaN' }];
    expect(nextIdForYear(existing, 2026)).toBe('PP-2026-0001');
  });

  test('grows beyond 4 digits when needed', () => {
    const existing = [{ id: 'PP-2026-9999' }];
    expect(nextIdForYear(existing, 2026)).toBe('PP-2026-10000');
  });
});

describe('saveQuote', () => {
  test('persists the quote with assigned id and ISO date', () => {
    const dir = makeUserData();
    const quote = saveQuote(dir, {
      user: 'Alberto',
      pack: 'crew',
      total_vat_inc: 311.40
    }, { now: new Date('2026-05-11T14:32:00Z') });
    expect(quote.id).toBe('PP-2026-0001');
    expect(quote.date).toBe('2026-05-11T14:32:00.000Z');
    expect(quote.total_vat_inc).toBe(311.40);

    const onDisk = listQuotes(dir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].id).toBe('PP-2026-0001');
  });

  test('rejects non-object payloads', () => {
    const dir = makeUserData();
    expect(() => saveQuote(dir, null)).toThrow();
    expect(() => saveQuote(dir, 'oops')).toThrow();
  });

  test('correlative ids reset per year', () => {
    const dir = makeUserData();
    saveQuote(dir, { foo: 1 }, { now: new Date('2026-01-01T10:00:00Z') });
    saveQuote(dir, { foo: 2 }, { now: new Date('2026-12-31T10:00:00Z') });
    const a = saveQuote(dir, { foo: 3 }, { now: new Date('2027-01-02T10:00:00Z') });
    expect(a.id).toBe('PP-2027-0001');
  });
});

describe('listQuotes', () => {
  test('returns [] when no file exists', () => {
    expect(listQuotes(makeUserData())).toEqual([]);
  });

  test('newest first by date', () => {
    const dir = makeUserData();
    saveQuote(dir, { tag: 'old' }, { now: new Date('2026-01-01T10:00:00Z') });
    saveQuote(dir, { tag: 'mid' }, { now: new Date('2026-06-01T10:00:00Z') });
    saveQuote(dir, { tag: 'new' }, { now: new Date('2026-12-01T10:00:00Z') });
    const all = listQuotes(dir);
    expect(all.map(q => q.tag)).toEqual(['new', 'mid', 'old']);
  });
});

describe('searchQuotes', () => {
  test('matches id substring case-insensitively', () => {
    const dir = makeUserData();
    saveQuote(dir, { tag: 'a' }, { now: new Date('2026-01-01T10:00:00Z') });
    saveQuote(dir, { tag: 'b' }, { now: new Date('2027-01-01T10:00:00Z') });
    expect(searchQuotes(dir, 'pp-2026').map(q => q.id)).toEqual(['PP-2026-0001']);
    expect(searchQuotes(dir, 'PP-2027').map(q => q.id)).toEqual(['PP-2027-0001']);
  });

  test('matches by customer name and user', () => {
    const dir = makeUserData();
    saveQuote(dir, { user: 'Alberto', customer: { name: 'Lobito' } });
    saveQuote(dir, { user: 'Carlos',  customer: { name: 'Marina' } });
    expect(searchQuotes(dir, 'lobito')).toHaveLength(1);
    expect(searchQuotes(dir, 'carlos')).toHaveLength(1);
    expect(searchQuotes(dir, 'in')).toHaveLength(1); // 'Marina' contains 'in'
  });

  test('empty query returns all', () => {
    const dir = makeUserData();
    saveQuote(dir, {});
    saveQuote(dir, {});
    expect(searchQuotes(dir, '')).toHaveLength(2);
    expect(searchQuotes(dir, '   ')).toHaveLength(2);
  });
});

describe('deleteQuote', () => {
  test('removes the quote and returns it', () => {
    const dir = makeUserData();
    const a = saveQuote(dir, { tag: 'a' });
    saveQuote(dir, { tag: 'b' });
    const removed = deleteQuote(dir, a.id);
    expect(removed.id).toBe(a.id);
    expect(listQuotes(dir).map(q => q.tag)).toEqual(['b']);
  });

  test('returns null when id is missing', () => {
    const dir = makeUserData();
    expect(deleteQuote(dir, 'nope')).toBeNull();
  });
});

describe('getQuote', () => {
  test('reads a single quote by id', () => {
    const dir = makeUserData();
    const a = saveQuote(dir, { tag: 'unique' });
    expect(getQuote(dir, a.id)).toMatchObject({ id: a.id, tag: 'unique' });
  });
});

describe('lazy v2 -> v3 migration of presupuestos.json', () => {
  test('migrates v2 entries on read and backs up the original', () => {
    const dir = makeUserData();
    const filePath = historyPathFor(dir);
    const v2 = [{
      id: 'PP-2026-0001',
      fecha: '2026-05-01T10:00:00.000Z',
      usuario: 'Alberto',
      cliente: { nombre: 'Club X', telefono: '600' },
      tipo: 'pena',
      totales: { total_iva_inc: 311.40, base_venta: 257.36, iva: 54.04 }
    }];
    fs.writeFileSync(filePath, JSON.stringify(v2, null, 2), 'utf-8');

    const all = listQuotes(dir);
    expect(all).toHaveLength(1);
    expect(all[0].date).toBe('2026-05-01T10:00:00.000Z');
    expect(all[0].user).toBe('Alberto');
    expect(all[0].customer).toEqual({ name: 'Club X', phone: '600' });
    expect(all[0].totals.total_vat_inc).toBe(311.40);
    expect(all[0].fecha).toBeUndefined();

    // The original v2 file was backed up and the file rewritten as v3
    expect(fs.existsSync(filePath + '.bak-pre-v3')).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(onDisk[0].user).toBe('Alberto');
    expect('usuario' in onDisk[0]).toBe(false);
  });

  test('a v3 history is not migrated again (no backup)', () => {
    const dir = makeUserData();
    saveQuote(dir, { user: 'A', customer: { name: 'X' } });
    const filePath = historyPathFor(dir);
    listQuotes(dir);
    expect(fs.existsSync(filePath + '.bak-pre-v3')).toBe(false);
  });
});

describe('persistence is atomic', () => {
  test('the .tmp file is gone after a successful save', () => {
    const dir = makeUserData();
    saveQuote(dir, { foo: 1 });
    expect(fs.existsSync(historyPathFor(dir))).toBe(true);
    expect(fs.existsSync(historyPathFor(dir) + '.tmp')).toBe(false);
  });

  test('survives Electron restart simulation', () => {
    const dir = makeUserData();
    saveQuote(dir, { tag: 'persist-me' });
    // simulate process restart by re-reading from scratch
    const fresh = listQuotes(dir);
    expect(fresh.some(q => q.tag === 'persist-me')).toBe(true);
  });
});
