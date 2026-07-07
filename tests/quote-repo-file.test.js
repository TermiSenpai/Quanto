// ============================================================
// Tests · lib/quote-repo-file.js
// ============================================================
// Uses a real temp directory for each test group so the actual
// fs behaviour (wx flag, atomic rename, mtime, sha256) is exercised.
// Style mirrors tests/history.test.js.
// ============================================================

import { describe, test, expect, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  createQuote,
  getQuote,
  listQuotes,
  searchQuotes,
  replaceQuote,
  setStatus,
  deleteQuote,
  putQuoteIfAbsent,
  MAX_QUOTE_BYTES,
} from '../lib/quote-repo-file.js';

// ── helpers ──────────────────────────────────────────────────
const dirs = [];
afterAll(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function makeFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quanto-repo-file-'));
  dirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DRAFT = {
  user: 'Alberto',
  config_version: 4,
  customer: { name: 'Club Lobito', phone: '600000001' },
  pack_id: 'crew',
  opt: { qty: 10 },
  result: { price: 25 },
  totals: { total_vat_inc: 302.5, sale_base: 250, vat: 52.5, total_cost: 200, margin: 0.2 },
  valid_until: '2026-12-31',
  status: 'pending',
};

// ── createQuote ───────────────────────────────────────────────
describe('createQuote', () => {
  test('stamps id, date, version:1, updated_at and returns the saved quote', () => {
    const folder = makeFolder();
    const now = new Date('2026-05-11T14:32:00Z');
    const q = createQuote(folder, DRAFT, { now });
    expect(q.id).toBe('PP-2026-0001');
    expect(q.date).toBe('2026-05-11T14:32:00.000Z');
    expect(q.updated_at).toBe('2026-05-11T14:32:00.000Z');
    expect(q.version).toBe(1);
    expect(q.user).toBe('Alberto');
  });

  test('writes a <id>.json file in the folder', () => {
    const folder = makeFolder();
    const now = new Date('2026-06-01T10:00:00Z');
    const q = createQuote(folder, DRAFT, { now });
    const file = path.join(folder, `${q.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.id).toBe(q.id);
  });

  test('ids increment within the same year', () => {
    const folder = makeFolder();
    const q1 = createQuote(folder, DRAFT, { now: new Date('2026-03-01T10:00:00Z') });
    const q2 = createQuote(folder, DRAFT, { now: new Date('2026-03-01T10:00:00Z') });
    const q3 = createQuote(folder, DRAFT, { now: new Date('2026-03-01T10:00:00Z') });
    expect(q1.id).toBe('PP-2026-0001');
    expect(q2.id).toBe('PP-2026-0002');
    expect(q3.id).toBe('PP-2026-0003');
  });

  test('ids reset to 0001 in a new year', () => {
    const folder = makeFolder();
    createQuote(folder, DRAFT, { now: new Date('2026-12-31T10:00:00Z') });
    const q = createQuote(folder, DRAFT, { now: new Date('2027-01-01T10:00:00Z') });
    expect(q.id).toBe('PP-2027-0001');
  });

  test('exclusive create: pre-existing <id>.json causes the next id to be used', () => {
    const folder = makeFolder();
    // Manually pre-write PP-2026-0001.json so the first available slot is taken.
    const taken = path.join(folder, 'PP-2026-0001.json');
    fs.writeFileSync(taken, JSON.stringify({ id: 'PP-2026-0001', date: 'x' }), 'utf-8');
    const now = new Date('2026-05-11T10:00:00Z');
    // createQuote should see the existing file and land on 0002.
    const q = createQuote(folder, DRAFT, { now });
    expect(q.id).toBe('PP-2026-0002');
  });

  test('rejects a non-object draft', () => {
    const folder = makeFolder();
    expect(() => createQuote(folder, null)).toThrow();
    expect(() => createQuote(folder, 'oops')).toThrow();
    expect(() => createQuote(folder, [])).toThrow();
  });

  test('rejects an oversized draft', () => {
    const folder = makeFolder();
    const huge = { blob: 'x'.repeat(MAX_QUOTE_BYTES + 1) };
    expect(() => createQuote(folder, huge)).toThrow(/demasiado grande/);
    expect(listQuotes(folder)).toEqual([]);
  });
});

// ── getQuote ──────────────────────────────────────────────────
describe('getQuote', () => {
  test('returns { quote, mtime, sha256 } for an existing id', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-06-01T00:00:00Z') });
    const result = getQuote(folder, q.id);
    expect(result).not.toBeNull();
    expect(result.quote).toMatchObject({ id: q.id, user: 'Alberto' });
    expect(typeof result.mtime).toBe('number');
    expect(typeof result.sha256).toBe('string');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('returns null for a missing id', () => {
    const folder = makeFolder();
    expect(getQuote(folder, 'PP-2026-9999')).toBeNull();
  });

  test('sha256 matches the raw file contents', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-06-01T00:00:00Z') });
    const file = path.join(folder, `${q.id}.json`);
    const raw = fs.readFileSync(file);
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    const result = getQuote(folder, q.id);
    expect(result.sha256).toBe(expected);
  });
});

// ── listQuotes ────────────────────────────────────────────────
describe('listQuotes', () => {
  test('returns [] for an empty folder', () => {
    expect(listQuotes(makeFolder())).toEqual([]);
  });

  test('returns quotes sorted newest-first by date', () => {
    const folder = makeFolder();
    createQuote(folder, { ...DRAFT, user: 'old' }, { now: new Date('2026-01-01T10:00:00Z') });
    createQuote(folder, { ...DRAFT, user: 'mid' }, { now: new Date('2026-06-01T10:00:00Z') });
    createQuote(folder, { ...DRAFT, user: 'new' }, { now: new Date('2026-12-01T10:00:00Z') });
    const list = listQuotes(folder);
    expect(list.map(q => q.user)).toEqual(['new', 'mid', 'old']);
  });

  test('skips a corrupt .json file and still lists the others', () => {
    const folder = makeFolder();
    createQuote(folder, DRAFT, { now: new Date('2026-01-01T10:00:00Z') });
    // Inject a corrupt file
    fs.writeFileSync(path.join(folder, 'PP-2026-CORRUPT.json'), 'not-json', 'utf-8');
    const warnings = [];
    const list = listQuotes(folder, { log: msg => warnings.push(msg) });
    // The valid quote is still present
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('PP-2026-0001');
    // The corrupt file was logged
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('skips non-.json files silently', () => {
    const folder = makeFolder();
    createQuote(folder, DRAFT, { now: new Date('2026-01-01T10:00:00Z') });
    fs.writeFileSync(path.join(folder, 'README.txt'), 'ignore me', 'utf-8');
    const list = listQuotes(folder);
    expect(list).toHaveLength(1);
  });
});

// ── searchQuotes ──────────────────────────────────────────────
describe('searchQuotes', () => {
  test('empty query returns all quotes', () => {
    const folder = makeFolder();
    createQuote(folder, DRAFT, { now: new Date('2026-01-01T10:00:00Z') });
    createQuote(folder, DRAFT, { now: new Date('2026-02-01T10:00:00Z') });
    expect(searchQuotes(folder, '')).toHaveLength(2);
    expect(searchQuotes(folder, '   ')).toHaveLength(2);
  });

  test('matches on id (case-insensitive)', () => {
    const folder = makeFolder();
    createQuote(folder, DRAFT, { now: new Date('2026-01-01T10:00:00Z') });
    createQuote(folder, DRAFT, { now: new Date('2027-01-01T10:00:00Z') });
    expect(searchQuotes(folder, 'pp-2026').map(q => q.id)).toEqual(['PP-2026-0001']);
    expect(searchQuotes(folder, 'PP-2027').map(q => q.id)).toEqual(['PP-2027-0001']);
  });

  test('matches on customer.name and customer.phone', () => {
    const folder = makeFolder();
    createQuote(folder, { ...DRAFT, customer: { name: 'Lobito FC', phone: '600' } });
    createQuote(folder, { ...DRAFT, customer: { name: 'Marina Club', phone: '700' } });
    expect(searchQuotes(folder, 'lobito')).toHaveLength(1);
    expect(searchQuotes(folder, '700')).toHaveLength(1);
  });

  test('matches on user', () => {
    const folder = makeFolder();
    createQuote(folder, { ...DRAFT, user: 'Carlos' });
    createQuote(folder, { ...DRAFT, user: 'Beatriz' });
    expect(searchQuotes(folder, 'carlos')).toHaveLength(1);
    expect(searchQuotes(folder, 'beatriz')).toHaveLength(1);
  });
});

// ── replaceQuote ──────────────────────────────────────────────
describe('replaceQuote', () => {
  test('with a fresh token: overwrites, pins id+date, bumps version', () => {
    const folder = makeFolder();
    const now = new Date('2026-05-11T14:00:00Z');
    const q = createQuote(folder, { ...DRAFT, user: 'Original' }, { now });
    const token = getQuote(folder, q.id);
    const later = new Date('2026-05-11T15:00:00Z');
    const result = replaceQuote(folder, q.id, { ...DRAFT, user: 'Updated' }, token, { now: later });
    expect(result.conflict).toBeUndefined();
    expect(result.quote).toBeDefined();
    expect(result.quote.id).toBe(q.id);
    expect(result.quote.date).toBe(q.date);
    expect(result.quote.user).toBe('Updated');
    expect(result.quote.version).toBe(2);
    expect(result.quote.updated_at).toBe('2026-05-11T15:00:00.000Z');
  });

  test('with a stale token: returns { conflict: true } and does NOT write', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-05-11T14:00:00Z') });
    // Capture token BEFORE a second write.
    const staleToken = getQuote(folder, q.id);
    // Mutate the file to make the token stale.
    replaceQuote(folder, q.id, { ...DRAFT, user: 'Intermediate' }, staleToken, {
      now: new Date('2026-05-11T14:01:00Z'),
    });
    // Now staleToken.sha256 and staleToken.mtime are out of date.
    const conflictResult = replaceQuote(folder, q.id, { ...DRAFT, user: 'Conflict' }, staleToken, {
      now: new Date('2026-05-11T14:02:00Z'),
    });
    expect(conflictResult).toEqual({ conflict: true });
    // The file should still have 'Intermediate', not 'Conflict'.
    const onDisk = getQuote(folder, q.id);
    expect(onDisk.quote.user).toBe('Intermediate');
  });

  test('with no token: always overwrites (no conflict check)', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-05-11T14:00:00Z') });
    const result = replaceQuote(folder, q.id, { ...DRAFT, user: 'NoToken' }, null, {
      now: new Date('2026-05-11T15:00:00Z'),
    });
    expect(result.conflict).toBeUndefined();
    expect(result.quote.user).toBe('NoToken');
  });

  test('pins workflow fields (status, status_ts, cloud_id) from existing', () => {
    const folder = makeFolder();
    const q = createQuote(folder, {
      ...DRAFT,
      status: 'accepted',
      status_ts: '2026-06-01T10:00:00.000Z',
      cloud_id: 'uuid-abc',
    }, { now: new Date('2026-05-11T14:00:00Z') });
    const token = getQuote(folder, q.id);
    const result = replaceQuote(folder, q.id, {
      ...DRAFT,
      user: 'Changed',
      status: 'rejected',    // should be ignored (existing wins)
      status_ts: 'BAD',      // should be ignored
      cloud_id: 'uuid-EVIL', // should be ignored
    }, token, { now: new Date('2026-05-11T15:00:00Z') });
    expect(result.quote.status).toBe('accepted');
    expect(result.quote.status_ts).toBe('2026-06-01T10:00:00.000Z');
    expect(result.quote.cloud_id).toBe('uuid-abc');
  });

  test('carries draft status when existing entry has none', () => {
    const folder = makeFolder();
    // createQuote stamps whatever status the draft carries; remove it for this test
    const { status, status_ts, cloud_id, ...draftNoStatus } = DRAFT;
    const q = createQuote(folder, draftNoStatus, { now: new Date('2026-05-11T14:00:00Z') });
    const token = getQuote(folder, q.id);
    const result = replaceQuote(folder, q.id, { ...draftNoStatus, status: 'pending' }, token, {
      now: new Date('2026-05-11T15:00:00Z'),
    });
    expect(result.quote.status).toBe('pending');
  });

  test('bumps version across repeated edits (1 -> 2 -> 3)', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-05-11T14:00:00Z') });
    expect(q.version).toBe(1);
    const t1 = getQuote(folder, q.id);
    const r1 = replaceQuote(folder, q.id, DRAFT, t1, { now: new Date('2026-05-11T14:01:00Z') });
    expect(r1.quote.version).toBe(2);
    const t2 = getQuote(folder, q.id);
    const r2 = replaceQuote(folder, q.id, DRAFT, t2, { now: new Date('2026-05-11T14:02:00Z') });
    expect(r2.quote.version).toBe(3);
  });

  test('returns null for an unknown id', () => {
    const folder = makeFolder();
    expect(replaceQuote(folder, 'PP-2026-9999', DRAFT, null)).toBeNull();
  });

  test('rejects a non-object draft', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-05-11T14:00:00Z') });
    const token = getQuote(folder, q.id);
    expect(() => replaceQuote(folder, q.id, null, token)).toThrow();
    expect(() => replaceQuote(folder, q.id, 'bad', token)).toThrow();
    expect(() => replaceQuote(folder, q.id, [], token)).toThrow();
  });

  test('rejects an oversized draft', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-05-11T14:00:00Z') });
    const token = getQuote(folder, q.id);
    const huge = { blob: 'x'.repeat(MAX_QUOTE_BYTES + 1) };
    expect(() => replaceQuote(folder, q.id, huge, token)).toThrow(/demasiado grande/);
  });

  test('atomic write: .tmp file is absent after a successful replace', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-06-01T10:00:00Z') });
    const token = getQuote(folder, q.id);
    replaceQuote(folder, q.id, DRAFT, token, { now: new Date('2026-06-01T11:00:00Z') });
    const file = path.join(folder, `${q.id}.json`);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});

// ── setStatus ─────────────────────────────────────────────────
describe('setStatus', () => {
  test('updates status + status_ts and does NOT bump version', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-05-11T14:00:00Z') });
    expect(q.version).toBe(1);
    const updated = setStatus(folder, q.id, { status: 'accepted', status_ts: '2026-06-01T10:00:00.000Z' });
    expect(updated.status).toBe('accepted');
    expect(updated.status_ts).toBe('2026-06-01T10:00:00.000Z');
    // workflow change must NOT bump the content version (mirrors history.js)
    expect(updated.version).toBe(1);
    // persisted
    const onDisk = getQuote(folder, q.id);
    expect(onDisk.quote.status).toBe('accepted');
    expect(onDisk.quote.version).toBe(1);
  });

  test('accepts a status with no status_ts (leaves any existing one)', () => {
    const folder = makeFolder();
    const q = createQuote(folder, { ...DRAFT, status_ts: '2026-01-01T00:00:00.000Z' }, { now: new Date('2026-05-11T14:00:00Z') });
    const updated = setStatus(folder, q.id, { status: 'rejected' });
    expect(updated.status).toBe('rejected');
    expect(updated.status_ts).toBe('2026-01-01T00:00:00.000Z');
  });

  test('rejects an invalid status (throws Spanish, writes nothing)', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-05-11T14:00:00Z') });
    expect(() => setStatus(folder, q.id, { status: 'bogus' })).toThrow(/no válido/i);
    // the stored status is unchanged
    expect(getQuote(folder, q.id).quote.status).toBe('pending');
  });

  test('returns null for a missing id', () => {
    const folder = makeFolder();
    expect(setStatus(folder, 'PP-2026-9999', { status: 'accepted' })).toBeNull();
  });

  test('returns null for a traversal id and never writes outside the folder', () => {
    const folder = makeFolder();
    const parent = path.dirname(folder);
    const sentinel = path.join(parent, 'SENTINEL_STATUS.json');
    fs.writeFileSync(sentinel, JSON.stringify({ status: 'pending' }), 'utf-8');
    try {
      expect(setStatus(folder, '../SENTINEL_STATUS', { status: 'accepted' })).toBeNull();
      expect(JSON.parse(fs.readFileSync(sentinel, 'utf-8')).status).toBe('pending');
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  });

  test('atomic write: no .tmp left behind', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-06-01T10:00:00Z') });
    setStatus(folder, q.id, { status: 'accepted', status_ts: '2026-06-02T10:00:00.000Z' });
    const file = path.join(folder, `${q.id}.json`);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});

// ── deleteQuote ───────────────────────────────────────────────
describe('deleteQuote', () => {
  test('removes the file and returns the deleted quote', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-06-01T10:00:00Z') });
    const removed = deleteQuote(folder, q.id);
    expect(removed).not.toBeNull();
    expect(removed.id).toBe(q.id);
    expect(fs.existsSync(path.join(folder, `${q.id}.json`))).toBe(false);
    expect(listQuotes(folder)).toEqual([]);
  });

  test('returns null for a missing id', () => {
    const folder = makeFolder();
    expect(deleteQuote(folder, 'PP-2026-9999')).toBeNull();
  });
});

// ── id validation / path traversal ────────────────────────────
describe('id validation (path-traversal guard)', () => {
  // A grab-bag of ids that must never reach the filesystem as a path.
  const badIds = [
    '../config',
    '..\\settings',
    '../../settings.json',
    '..',
    '',
    'PP-2026',          // missing the sequence
    'PP-20-1',          // year not 4 digits
    'config',
    null,
    undefined,
    42,
    {},
  ];

  test('getQuote returns null for invalid ids and never reads outside the folder', () => {
    const folder = makeFolder();
    // Drop a sentinel file in the parent so a traversal would expose it.
    const parent = path.dirname(folder);
    const sentinel = path.join(parent, 'SENTINEL_SECRET.json');
    fs.writeFileSync(sentinel, JSON.stringify({ secret: true }), 'utf-8');
    try {
      for (const bad of badIds) {
        expect(getQuote(folder, bad)).toBeNull();
      }
      // Even a crafted traversal that would resolve to the sentinel returns null.
      expect(getQuote(folder, '../SENTINEL_SECRET')).toBeNull();
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  });

  test('deleteQuote returns null for invalid ids and does not unlink outside the folder', () => {
    const folder = makeFolder();
    const parent = path.dirname(folder);
    const sentinel = path.join(parent, 'SENTINEL_DELETE.json');
    fs.writeFileSync(sentinel, JSON.stringify({ keep: true }), 'utf-8');
    try {
      for (const bad of badIds) {
        expect(deleteQuote(folder, bad)).toBeNull();
      }
      // A traversal id resolving to the sentinel must NOT delete it.
      expect(deleteQuote(folder, '../SENTINEL_DELETE')).toBeNull();
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  });

  test('replaceQuote returns null for invalid ids and writes nothing outside the folder', () => {
    const folder = makeFolder();
    const parent = path.dirname(folder);
    const sentinel = path.join(parent, 'SENTINEL_REPLACE.json');
    fs.writeFileSync(sentinel, JSON.stringify({ original: true }), 'utf-8');
    try {
      for (const bad of badIds) {
        expect(replaceQuote(folder, bad, DRAFT, null)).toBeNull();
      }
      // A traversal id must not overwrite the sentinel.
      expect(replaceQuote(folder, '../SENTINEL_REPLACE', DRAFT, null)).toBeNull();
      const onDisk = JSON.parse(fs.readFileSync(sentinel, 'utf-8'));
      expect(onDisk).toEqual({ original: true });
      // No stray .tmp left behind in the parent either.
      expect(fs.existsSync(sentinel + '.tmp')).toBe(false);
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  });
});

// ── createQuote wx EEXIST retry ────────────────────────────────
describe('createQuote EEXIST retry behaviour', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('retries past EEXIST collisions and lands on a later id', () => {
    const folder = makeFolder();
    const now = new Date('2026-05-11T10:00:00Z');
    const real = fs.writeFileSync.bind(fs);
    let throwsLeft = 2; // first two writes "collide", third succeeds
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, body, opts) => {
      if (throwsLeft > 0 && opts && opts.flag === 'wx') {
        throwsLeft -= 1;
        const err = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      return real(file, body, opts);
    });
    const q = createQuote(folder, DRAFT, { now });
    // nextIdForYear keeps returning PP-2026-0001 (folder still empty after the
    // mocked throws), so the retry loop only succeeds once the mock stops
    // throwing — proving the EEXIST branch was exercised without crashing.
    expect(q.id).toBe('PP-2026-0001');
    expect(fs.existsSync(path.join(folder, 'PP-2026-0001.json'))).toBe(true);
  });

  test('throws the Spanish exhaustion error after MAX_ID_RETRIES collisions', () => {
    const folder = makeFolder();
    const now = new Date('2026-05-11T10:00:00Z');
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, body, opts) => {
      if (opts && opts.flag === 'wx') {
        const err = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      // (.tmp writes from other paths would pass through, but createQuote
      // only uses the wx flag.)
    });
    expect(() => createQuote(folder, DRAFT, { now }))
      .toThrow(/No se pudo asignar un identificador único/);
  });
});

// ── putQuoteIfAbsent (B5 one-time migration adapter) ──────────
describe('putQuoteIfAbsent', () => {
  // A quote with the local-history fields B5 must PRESERVE (id, date,
  // version, updated_at) — migration writes them as-is, no re-stamping.
  const EXISTING = {
    id: 'PP-2025-0007',
    date: '2025-09-01T08:00:00.000Z',
    version: 3,
    updated_at: '2025-09-15T12:00:00.000Z',
    user: 'Legacy',
    customer: { name: 'Viejo Cliente', phone: '600111222' },
    totals: { total_vat_inc: 121, sale_base: 100, vat: 21, total_cost: 80, margin: 0.2 },
    status: 'accepted',
  };

  test('writes <id>.json using the existing id and returns { migrated: true }', () => {
    const folder = makeFolder();
    const res = putQuoteIfAbsent(folder, EXISTING);
    expect(res).toEqual({ migrated: true });
    const file = path.join(folder, 'PP-2025-0007.json');
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // id/date/version/updated_at preserved verbatim (no re-stamp).
    expect(onDisk.id).toBe('PP-2025-0007');
    expect(onDisk.date).toBe('2025-09-01T08:00:00.000Z');
    expect(onDisk.version).toBe(3);
    expect(onDisk.updated_at).toBe('2025-09-15T12:00:00.000Z');
    expect(onDisk.status).toBe('accepted');
  });

  test('a second call with the same id returns { migrated: false } and does NOT overwrite', () => {
    const folder = makeFolder();
    expect(putQuoteIfAbsent(folder, EXISTING)).toEqual({ migrated: true });
    const file = path.join(folder, 'PP-2025-0007.json');
    const before = fs.readFileSync(file, 'utf-8');
    // Same id but different content — must be ignored (idempotent skip).
    const res = putQuoteIfAbsent(folder, { ...EXISTING, user: 'Tampered', version: 99 });
    expect(res).toEqual({ migrated: false });
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe(before); // on-disk content unchanged
  });

  test('creates the folder if it does not exist yet', () => {
    const parent = makeFolder();
    const folder = path.join(parent, 'presupuestos'); // not yet created
    expect(fs.existsSync(folder)).toBe(false);
    const res = putQuoteIfAbsent(folder, EXISTING);
    expect(res).toEqual({ migrated: true });
    expect(fs.existsSync(path.join(folder, 'PP-2025-0007.json'))).toBe(true);
  });

  test('throws a Spanish error for a malformed id (caller counts it as failed)', () => {
    const folder = makeFolder();
    expect(() => putQuoteIfAbsent(folder, { ...EXISTING, id: '../escape' }))
      .toThrow(/identificador/i);
    // Nothing leaked outside the folder.
    expect(listQuotes(folder)).toEqual([]);
  });

  test('rejects a non-object quote', () => {
    const folder = makeFolder();
    expect(() => putQuoteIfAbsent(folder, null)).toThrow();
    expect(() => putQuoteIfAbsent(folder, 'oops')).toThrow();
    expect(() => putQuoteIfAbsent(folder, [])).toThrow();
  });

  test('rejects an oversized quote', () => {
    const folder = makeFolder();
    const huge = { ...EXISTING, blob: 'x'.repeat(MAX_QUOTE_BYTES + 1) };
    expect(() => putQuoteIfAbsent(folder, huge)).toThrow(/demasiado grande/);
    expect(listQuotes(folder)).toEqual([]);
  });
});

// ── create→get→list round-trip ────────────────────────────────
describe('create → get → list round-trip', () => {
  test('full round-trip with three quotes', () => {
    const folder = makeFolder();
    const q1 = createQuote(folder, { ...DRAFT, user: 'A' }, { now: new Date('2026-01-01T10:00:00Z') });
    const q2 = createQuote(folder, { ...DRAFT, user: 'B' }, { now: new Date('2026-06-01T10:00:00Z') });
    const q3 = createQuote(folder, { ...DRAFT, user: 'C' }, { now: new Date('2026-12-01T10:00:00Z') });

    // getQuote returns each
    expect(getQuote(folder, q1.id).quote.user).toBe('A');
    expect(getQuote(folder, q2.id).quote.user).toBe('B');
    expect(getQuote(folder, q3.id).quote.user).toBe('C');

    // listQuotes returns all three newest-first
    const list = listQuotes(folder);
    expect(list).toHaveLength(3);
    expect(list.map(q => q.user)).toEqual(['C', 'B', 'A']);
  });
});
