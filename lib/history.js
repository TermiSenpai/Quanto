// ============================================================
// PackPrice · Local quote history (presupuestos)
// ============================================================
// Persists computed quotes per PC in `<userData>/presupuestos.json`
// as a single JSON array. Per the plan (V3 in PLAN_Calculadora.md
// and CLAUDE.md §9.2), this is local-only — the NAS holds config,
// not history.
//
// Why a single JSON array (not JSONL):
//   - We never append from multiple writers; a single Electron
//     process writes locally.
//   - The expected upper bound is ~thousands of entries (years of
//     workshop output), well within JSON.parse range.
//   - Atomic-rename writes (.tmp -> rename) avoid half-written
//     files if the process is killed mid-write.
//
// IDs follow `PP-YYYY-NNNN` with NNNN reset every calendar year
// (zero-padded to 4 digits, growing past 4 if needed).
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { migrateQuote } = require('./migrations');

const HISTORY_FILE_NAME = 'presupuestos.json';
const ID_PREFIX = 'PP';

// Sane upper bound for a single quote draft. A legitimate quote is a
// few KB; anything past this is a bug or a malicious renderer trying
// to balloon the local history file. 500 KB leaves enormous headroom.
const MAX_QUOTE_BYTES = 500 * 1024;

/**
 * Returns the absolute path of the history file inside the given
 * userData directory.
 */
function historyPathFor(userDataDir) {
  return path.join(userDataDir, HISTORY_FILE_NAME);
}

/**
 * Reads all quotes, migrating v2 entries to v3 lazily. Returns []
 * when the file does not exist. Throws on parse error so callers
 * can surface the issue (we do NOT silently ignore corruption —
 * that would mask data loss).
 *
 * The first time a PC opens a v2 history, it is migrated to v3,
 * backed up to `<file>.bak-pre-v3`, and rewritten. Idempotent.
 */
function readAllQuotes(userDataDir) {
  const filePath = historyPathFor(userDataDir);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (content === '') return [];
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error('El archivo de historial no contiene un array.');
  }

  const needsMigration = parsed.some(q => q && typeof q === 'object'
    && (('fecha' in q) || ('usuario' in q) || ('cliente' in q) || ('totales' in q)));
  if (!needsMigration) return parsed;

  const migrated = parsed.map(migrateQuote);
  try { fs.copyFileSync(filePath, filePath + '.bak-pre-v3'); } catch (_) {}
  writeAllQuotes(userDataDir, migrated);
  return migrated;
}

/**
 * Atomically writes the quote array. Writes to a sibling .tmp
 * file and renames; on Windows, fs.renameSync replaces the target.
 */
function writeAllQuotes(userDataDir, quotes) {
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  const filePath = historyPathFor(userDataDir);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(quotes, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Computes the next sequential id for the given year, looking at
 * the existing quotes. Pure: takes the array, returns the id
 * string. The store wrapper handles the IO.
 *
 * @param {Array<{id:string}>} existing
 * @param {number} year
 * @returns {string}
 */
function nextIdForYear(existing, year) {
  const prefix = `${ID_PREFIX}-${year}-`;
  let max = 0;
  for (const q of existing) {
    if (typeof q?.id !== 'string' || !q.id.startsWith(prefix)) continue;
    const tail = q.id.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = max + 1;
  return prefix + String(next).padStart(4, '0');
}

/**
 * Saves a new quote and returns it (with id, fecha and persisted).
 * Mutates only the file: callers receive a fresh object.
 *
 * @param {string} userDataDir
 * @param {object} draft   the quote payload (without id/fecha)
 * @param {object} [opts]
 * @param {Date}   [opts.now]  for tests
 * @returns {object} the saved quote
 */
function saveQuote(userDataDir, draft, opts = {}) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('El presupuesto debe ser un objeto.');
  }
  // Bound the serialized size so a buggy/compromised renderer cannot
  // balloon the local history file. We measure the draft as received.
  let serialized;
  try {
    serialized = JSON.stringify(draft);
  } catch (_) {
    throw new Error('El presupuesto no se puede serializar.');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf-8') > MAX_QUOTE_BYTES) {
    throw new Error('El presupuesto es demasiado grande.');
  }
  const now = opts.now || new Date();
  const all = readAllQuotes(userDataDir);
  const id = nextIdForYear(all, now.getFullYear());
  const saved = {
    id,
    date: now.toISOString(),
    ...draft
  };
  all.push(saved);
  writeAllQuotes(userDataDir, all);
  return saved;
}

/**
 * Returns quotes sorted newest first.
 */
function listQuotes(userDataDir) {
  const all = readAllQuotes(userDataDir);
  return all.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/**
 * Substring search across id, customer.name, and user. Case
 * insensitive. Empty query returns all (sorted newest first).
 */
function searchQuotes(userDataDir, query) {
  const all = listQuotes(userDataDir);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter(quote => {
    const haystack = [
      quote.id,
      quote.user,
      quote.customer?.name,
      quote.customer?.phone
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Deletes by id. Returns the removed quote or null.
 */
function deleteQuote(userDataDir, id) {
  const all = readAllQuotes(userDataDir);
  const idx = all.findIndex(q => q?.id === id);
  if (idx === -1) return null;
  const [removed] = all.splice(idx, 1);
  writeAllQuotes(userDataDir, all);
  return removed;
}

/**
 * Reads a single quote by id (or null).
 */
function getQuote(userDataDir, id) {
  const all = readAllQuotes(userDataDir);
  return all.find(q => q?.id === id) || null;
}

module.exports = {
  HISTORY_FILE_NAME,
  MAX_QUOTE_BYTES,
  historyPathFor,
  nextIdForYear,
  saveQuote,
  listQuotes,
  searchQuotes,
  deleteQuote,
  getQuote
};
