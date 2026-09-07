// ============================================================
// Deposit ("señal") arithmetic (renderer/deposit.js)
// ============================================================
// Pure helpers behind the step-3 "Señal" card and the history inline
// form: the minimum (percentage of the VAT-inclusive total, rounded to
// cents before ceiling to the whole euro), the remaining balance, and
// the two input parsers. The percentage is always an argument — the
// default lives in config.
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  depositMinimum,
  depositRemaining,
  parseDepositPct,
  parseDepositAmount,
  formatDepositPct,
  pctToPercentInput
} from '../renderer/deposit.js';

describe('depositMinimum', () => {
  test('40 % of 1234.56 rounds UP to 494', () => {
    expect(depositMinimum(1234.56, 0.4)).toBe(494);
  });

  test('an exact multiple stays exact (1000 → 400, 250 → 100)', () => {
    expect(depositMinimum(1000, 0.4)).toBe(400);
    expect(depositMinimum(250, 0.4)).toBe(100);
  });

  test('rounds to cents BEFORE ceiling: a float artefact never bumps the euro (100 × 0.07 = 7.000000000000001 → 7)', () => {
    expect(depositMinimum(100, 0.07)).toBe(7);
  });

  test('rounds to cents BEFORE ceiling: a sub-cent remainder is not a cent (2.01 × 0.5 = 1.005 → 1)', () => {
    expect(depositMinimum(2.01, 0.5)).toBe(1);
  });

  test('one cent above a whole euro rounds up (100.02 × 0.5 = 50.01 → 51)', () => {
    expect(depositMinimum(100.02, 0.5)).toBe(51);
  });

  test('returns 0 for a non-positive or invalid total or fraction', () => {
    expect(depositMinimum(0, 0.4)).toBe(0);
    expect(depositMinimum(-10, 0.4)).toBe(0);
    expect(depositMinimum(NaN, 0.4)).toBe(0);
    expect(depositMinimum(100, 0)).toBe(0);
    expect(depositMinimum(100, undefined)).toBe(0);
  });
});

describe('depositRemaining', () => {
  test('total minus paid, to cents', () => {
    expect(depositRemaining(1234.56, 500)).toBe(734.56);
  });

  test('never negative when the customer paid more than the total', () => {
    expect(depositRemaining(100, 150)).toBe(0);
  });

  test('treats a missing payment as zero', () => {
    expect(depositRemaining(100, undefined)).toBe(100);
  });

  test('rounds to cents (0.3 − 0.1 is 0.19999999999999998 in floats → 0.2)', () => {
    expect(depositRemaining(0.3, 0.1)).toBe(0.2);
  });
});

describe('parseDepositPct', () => {
  test('parses a whole percentage into a fraction', () => {
    expect(parseDepositPct('40')).toBe(0.4);
    expect(parseDepositPct(40)).toBe(0.4);
  });

  test('accepts comma or dot decimals', () => {
    expect(parseDepositPct('12,5')).toBe(0.125);
    expect(parseDepositPct('12.5')).toBe(0.125);
  });

  test('rejects negatives, above 100, blanks and garbage', () => {
    expect(parseDepositPct('-1')).toBeNull();
    expect(parseDepositPct('101')).toBeNull();
    expect(parseDepositPct('')).toBeNull();
    expect(parseDepositPct('abc')).toBeNull();
    expect(parseDepositPct(null)).toBeNull();
  });

  test('accepts the bounds 0 and 100 (0 % = no minimum deposit)', () => {
    expect(parseDepositPct('0')).toBe(0);
    expect(parseDepositPct('1')).toBe(0.01);
    expect(parseDepositPct('100')).toBe(1);
  });

  test('rounds the percentage to two decimals (12,345 → 12,35 %)', () => {
    expect(parseDepositPct('12,345')).toBe(0.1235);
  });
});

describe('parseDepositAmount', () => {
  test('parses euros with comma or dot decimals, rounded to cents', () => {
    expect(parseDepositAmount('494')).toBe(494);
    expect(parseDepositAmount('493,82')).toBe(493.82);
    expect(parseDepositAmount('493,826')).toBe(493.83);
  });

  test('rejects zero, negatives, blanks and garbage', () => {
    expect(parseDepositAmount('0')).toBeNull();
    expect(parseDepositAmount('-5')).toBeNull();
    expect(parseDepositAmount('')).toBeNull();
    expect(parseDepositAmount('cinco')).toBeNull();
  });

  test('Spanish grouping: dots are stripped when a comma marks the decimals, an ambiguous dot-group is rejected', () => {
    expect(parseDepositAmount('1.234,56')).toBe(1234.56);
    expect(parseDepositAmount('1 234')).toBe(1234);
    expect(parseDepositAmount('1.234')).toBeNull();
    expect(parseDepositAmount('493.826')).toBeNull();
    expect(parseDepositAmount('1234.56')).toBe(1234.56);
  });
});

describe('formatDepositPct / pctToPercentInput', () => {
  test('formats a fraction as a Spanish percentage label', () => {
    expect(formatDepositPct(0.4)).toBe('40 %');
    expect(formatDepositPct(0.125)).toBe('12,5 %');
    expect(formatDepositPct(0.1234)).toBe('12,34 %');
    expect(formatDepositPct(undefined)).toBe('');
  });

  test('turns a fraction into the Spanish string the input shows', () => {
    expect(pctToPercentInput(0.4)).toBe('40');
    expect(pctToPercentInput(0.125)).toBe('12,5');
    expect(pctToPercentInput(undefined)).toBe('');
  });
});
