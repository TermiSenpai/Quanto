// ============================================================
// Quanto · Quote deposit ("señal") arithmetic (pure, renderer)
// ============================================================
// The workshop asks for a minimum deposit before launching an order: a
// percentage of the quote total (VAT included), rounded to cents before
// ceiling to the whole euro because it is a minimum. This module is the
// single home of that arithmetic plus the two input parsers the step-3
// card and the history inline form share. No DOM, no IPC, no config
// access: the percentage is always an argument (its default lives in
// config — CLAUDE.md §2.2).
// ============================================================

'use strict';

function round2(n) {
  return Math.round(n * 100) / 100;
}

// "40", "12,5", "493.82" → number; null for anything else. No thousands
// separators (the inputs are short amounts typed at the counter).
function parseLocaleNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Minimum deposit in whole euros for a VAT-inclusive total and a fraction.
 * Money is computed at cent precision FIRST, then ceiled to the euro:
 *   - a float artefact never rounds up (100 × 0.07 = 7.000000000000001 → 7,
 *     not 8);
 *   - a sub-cent remainder is not a real cent (2.01 × 0.5 = 1.005 → 1.00 → 1).
 * 0 for a non-positive/invalid input.
 *
 * @param {number} totalVatInc
 * @param {number} pct - fraction, e.g. 0.4
 * @returns {number} whole euros
 */
export function depositMinimum(totalVatInc, pct) {
  if (!Number.isFinite(totalVatInc) || totalVatInc <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.ceil(round2(totalVatInc * pct));
}

/** Balance still due after a paid deposit; never negative. */
export function depositRemaining(totalVatInc, paidAmount) {
  const total = Number.isFinite(totalVatInc) ? totalVatInc : 0;
  const paid = Number.isFinite(paidAmount) ? paidAmount : 0;
  return Math.max(0, round2(total - paid));
}

/**
 * Percentage typed in the card ("40", "12,5") → fraction (0.4, 0.125).
 * Accepts 1–100; null otherwise.
 */
export function parseDepositPct(text) {
  const n = parseLocaleNumber(text);
  if (n === null || n < 1 || n > 100) return null;
  return round2(n) / 100;
}

/** Amount in euros ("494", "493,82") → number to cents; must be > 0, else null. */
export function parseDepositAmount(text) {
  const n = parseLocaleNumber(text);
  if (n === null || n <= 0) return null;
  return round2(n);
}

/** 0.4 → "40 %", 0.125 → "12,5 %" (Spanish locale, up to 2 decimals). */
export function formatDepositPct(pct) {
  if (!Number.isFinite(pct)) return '';
  return (pct * 100).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' %';
}

/** The number the percentage input shows for a fraction: 0.4 → 40. */
export function pctToPercentInput(pct) {
  return Number.isFinite(pct) ? round2(pct * 100) : '';
}
