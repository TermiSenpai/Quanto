# Quote Deposit (señal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the minimum deposit ("señal", default 40 % of the total with VAT, rounded up to the euro) to every quote, let the workshop mark it paid (step 3 or history → quote becomes *Aceptado*), and print it on the PDF.

**Architecture:** The deposit has two halves. The **minimum** (`quote.deposit = { pct, min_amount }`) is quote content computed in the renderer and saved with the draft. The **payment** (`quote.deposit_paid = { amount, at, by } | null`) is a workflow fact like `status`: written only by a new repository operation `setDepositPaid` (file: JSON rewrite; cloud: additive `quote_deposits` table + status flip), never bumping the content version, preserved by edits. One IPC channel `quotes:set-deposit` exposes it. The PDF context prints the stored minimum and the payment.

**Tech Stack:** Electron main (CommonJS, Node 24), vanilla ESM renderer (no build step), Vitest, Cloudflare D1 over REST (`lib/d1-client.js`), bundled SQL migrations (`db/migrations/`).

**Spec:** `docs/superpowers/specs/2026-09-04-quote-deposit-design.md` (read it first — §3 data model, §4 backends, §5 step 3, §6 history, §7 PDF).

**Conventions to respect (CLAUDE.md):** `'use strict'`, 2-space indent, semicolons, single quotes, English code, Spanish user strings, no new deps, no domain numbers outside `config.default.js`/config, Spanish `throw` messages, tests ship with every calculation/schema change. Run a single test file with `pnpm vitest run tests/<file>.test.js`; the full suite with `pnpm test`.

---

## File structure

| File | Responsibility in this feature |
|---|---|
| `config.default.js` | `DEFAULT_DEPOSIT_PCT`, `quote_settings.deposit_pct` in the scaffold, `applyQuoteSettingsDefaults(cfg)` |
| `lib/config-schema.js` | validates `quote_settings.deposit_pct ∈ [0, 1]` |
| `main.js` | applies the default in `config:read` (file mode); `quotes:set-deposit` handler; `quoteRepo(...).setDepositPaid`; cache list row |
| `lib/cloud-bootstrap.js` | applies the default in `toValidatedConfig` (cloud mode, all load paths) |
| `preload.js` | `setQuoteDeposit({ id, paid })` |
| `renderer/deposit.js` (new) | pure deposit arithmetic + input parsers (the ONLY home of the formula) |
| `renderer/history.js` | `buildQuoteDraft` carries `deposit`; `renderDepositCell` / `renderDepositForm`; deposit column |
| `renderer/app.js` | step-3 "Señal" card (replaces "Próximos pasos"), persist flow, history deposit actions, copy summary |
| `renderer/styles.css` | `.deposit-card*`, `.quote-chip--deposit`, `.deposit-form*`; removes `.next-steps*` |
| `lib/quote-store-helpers.js` | `normalizeDepositPaid(paid)` and `withoutDepositPaid(draft)` shared by both backends |
| `lib/quote-repo-file.js` | `setDepositPaid`; create/replace strip/pin `deposit_paid` |
| `db/migrations/0003_quote_deposits.sql` (new) | additive table for the payment fact |
| `lib/cloud-quotes.js` | `setQuoteDeposit`, `depositFromRow`; LEFT JOIN in `getFullQuote`/`listFullQuotes`; cascade delete |
| `lib/quote-repo-cloud.js` | `setDepositPaid` façade; create/replace strip/pin; list rows carry `deposit_paid` |
| `lib/pdf-templates.js` | deposit context fields, `DEPOSIT_ROWS` in the 6 built-ins, confirmation text, demo quote |
| `tests/…` | one test file per touched module (see each task) |
| `CLAUDE.md`, `ARCHITECTURE.md`, `docs/UI-UX.md` | documentation |

---

### Task 1: Config default + schema validation

**Files:**
- Modify: `config.default.js` (constants block ~line 29, `buildEmptyConfig` `quote_settings` ~line 78, exports ~line 85)
- Modify: `lib/config-schema.js` (`validateQuoteSettings` ~line 481)
- Modify: `tests/fixtures/config-v4-full.js` (`QUOTE_SETTINGS` ~line 262)
- Test: `tests/config-default.test.js`, `tests/config-schema.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/config-default.test.js` (add `DEFAULT_DEPOSIT_PCT, applyQuoteSettingsDefaults` to the existing named import from `'../config.default.js'`):

```js
describe('deposit defaults (quote_settings.deposit_pct)', () => {
  it('buildEmptyConfig carries the default deposit percentage', () => {
    expect(DEFAULT_DEPOSIT_PCT).toBe(0.4);
    expect(buildEmptyConfig().quote_settings.deposit_pct).toBe(DEFAULT_DEPOSIT_PCT);
  });

  it('applyQuoteSettingsDefaults returns the SAME reference when deposit_pct is present', () => {
    const cfg = buildEmptyConfig();
    expect(applyQuoteSettingsDefaults(cfg)).toBe(cfg);
    const custom = { quote_settings: { deposit_pct: 0.5 } };
    expect(applyQuoteSettingsDefaults(custom)).toBe(custom);
  });

  it('fills a missing deposit_pct without touching the input or the other keys', () => {
    const cfg = { version: '4.0.0', quote_settings: { validity_days: 15 } };
    const out = applyQuoteSettingsDefaults(cfg);
    expect(out).not.toBe(cfg);
    expect(out.quote_settings).toEqual({ validity_days: 15, deposit_pct: 0.4 });
    expect(cfg.quote_settings).toEqual({ validity_days: 15 });
    expect(out.version).toBe('4.0.0');
  });

  it('creates quote_settings when the whole object is absent, filling ONLY deposit_pct', () => {
    const out = applyQuoteSettingsDefaults({ version: '4.0.0' });
    expect(out.quote_settings).toEqual({ deposit_pct: 0.4 });
  });

  it('is idempotent', () => {
    const once = applyQuoteSettingsDefaults({ version: '4.0.0' });
    expect(applyQuoteSettingsDefaults(once)).toBe(once);
  });
});
```

Append to `tests/config-schema.test.js`:

```js
describe('quote_settings.deposit_pct', () => {
  test('accepts the bounds 0 and 1 and a fraction in between', () => {
    for (const v of [0, 0.4, 1]) {
      const cfg = makeConfig();
      cfg.quote_settings.deposit_pct = v;
      expect(collectConfigErrors(cfg)).toEqual([]);
    }
  });

  test('accepts a config without deposit_pct (optional key)', () => {
    const cfg = makeConfig();
    delete cfg.quote_settings.deposit_pct;
    expect(collectConfigErrors(cfg)).toEqual([]);
  });

  test.each([['0.4'], [1.5], [-0.1], [NaN]])('rejects %p naming the field', (bad) => {
    const cfg = makeConfig();
    cfg.quote_settings.deposit_pct = bad;
    expect(collectConfigErrors(cfg).join('\n')).toMatch(/quote_settings\.deposit_pct/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/config-default.test.js tests/config-schema.test.js`
Expected: FAIL — `DEFAULT_DEPOSIT_PCT` is undefined / `applyQuoteSettingsDefaults is not a function`; the schema `rejects` cases fail because no error is produced.

- [ ] **Step 3: Implement in `config.default.js`**

Add after `DEFAULT_TARGET_MARGIN`:

```js
// The default minimum deposit ("señal") a quote asks for, as a fraction
// of the total with VAT (0.4 = 40 %). This file is the single home for
// schema-level default numbers: it reaches configs through
// buildEmptyConfig (new catalogs) and applyQuoteSettingsDefaults
// (catalogs that predate the key). Never hardcoded anywhere else
// (CLAUDE.md hard rule §2.2).
const DEFAULT_DEPOSIT_PCT = 0.4;
```

In `buildEmptyConfig`, change the `quote_settings` block to:

```js
    quote_settings: {
      validity_days: 30,
      terms: 'Precios IVA incluido. Validez 30 días desde la fecha de emisión.',
      deposit_pct: DEFAULT_DEPOSIT_PCT
    }
```

Add before `module.exports`:

```js
/**
 * Fills `quote_settings.deposit_pct` with DEFAULT_DEPOSIT_PCT when a config
 * predates the key. Pure and idempotent: returns the SAME reference when
 * nothing is missing (callers can detect "untouched" by identity, like
 * migrateConfig), else a shallow copy with a copied quote_settings. Fills
 * ONLY deposit_pct on purpose: filling validity_days/terms would change
 * the PDFs of catalogs that left them undefined.
 *
 * @param {object} cfg
 * @returns {object} cfg itself, or a filled shallow copy
 */
function applyQuoteSettingsDefaults(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const qs = cfg.quote_settings;
  const hasQs = qs && typeof qs === 'object' && !Array.isArray(qs);
  if (hasQs && Number.isFinite(qs.deposit_pct)) return cfg;
  return {
    ...cfg,
    quote_settings: { ...(hasQs ? qs : {}), deposit_pct: DEFAULT_DEPOSIT_PCT }
  };
}
```

Export both: add `DEFAULT_DEPOSIT_PCT,` and `applyQuoteSettingsDefaults` to `module.exports`.

- [ ] **Step 4: Implement the schema check in `lib/config-schema.js`**

Inside `validateQuoteSettings`, after the `validity_days` check:

```js
  if (qs.deposit_pct !== undefined && qs.deposit_pct !== null) {
    if (!Number.isFinite(qs.deposit_pct) || qs.deposit_pct < 0 || qs.deposit_pct > 1) {
      errors.push(`"quote_settings.deposit_pct" debe ser un número entre 0 y 1 (recibido: ${describe(qs.deposit_pct)}).`);
    }
  }
```

(`describe` already exists in that module — it is used for `company.brand_color`.)

- [ ] **Step 5: Keep the "full v4" fixture full**

In `tests/fixtures/config-v4-full.js`, change `QUOTE_SETTINGS` to:

```js
const QUOTE_SETTINGS = {
  validity_days: 30,
  terms:         'Precios IVA incluido. Validez 30 días desde la fecha de emisión. La aceptación implica conformidad con las condiciones del taller.',
  deposit_pct:   0.4
};
```

- [ ] **Step 6: Run the tests to verify they pass, then the full suite**

Run: `pnpm vitest run tests/config-default.test.js tests/config-schema.test.js`
Expected: PASS.
Run: `pnpm test`
Expected: PASS (the fixture change round-trips through `catalog-assembler`/`backend-contract` untouched).

- [ ] **Step 7: Commit**

```bash
git add config.default.js lib/config-schema.js tests/fixtures/config-v4-full.js tests/config-default.test.js tests/config-schema.test.js
git commit -m "feat(config): default deposit percentage (quote_settings.deposit_pct)"
```

---

### Task 2: Apply the default at the two config hand-off points

**Files:**
- Modify: `lib/cloud-bootstrap.js` (requires ~line 34; `toValidatedConfig` ~line 163)
- Modify: `main.js` (require ~line 31; `config:read` handler ~line 974)
- Test: `tests/cloud-bootstrap.test.js` (inside `describe('loadCatalog')`)

- [ ] **Step 1: Write the failing test**

Add inside `describe('loadCatalog', …)` in `tests/cloud-bootstrap.test.js`:

```js
  test('fills quote_settings.deposit_pct from the schema default when the cloud rows predate it', async () => {
    const legacyCompany = entities.company.filter((r) => r.key !== 'quote_settings.deposit_pct');
    const client = fakeCatalogClient({ ...entities, company: legacyCompany });
    const { bootstrap } = makeBootstrap(client);
    const res = await bootstrap.loadCatalog(SETTINGS);
    expect(res.ok).toBe(true);
    expect(res.config.quote_settings.deposit_pct).toBe(0.4);
    // The other quote settings are untouched (only deposit_pct is defaulted).
    expect(res.config.quote_settings.validity_days).toBe(30);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/cloud-bootstrap.test.js -t "deposit_pct"`
Expected: FAIL — `deposit_pct` is `undefined`.

- [ ] **Step 3: Implement in `lib/cloud-bootstrap.js`**

Add to the requires:

```js
const { applyQuoteSettingsDefaults } = require('../config.default');
```

In `toValidatedConfig`, replace the final `return config;` with:

```js
    // Optional keys that newer app versions introduced get their schema
    // default here, in memory — the next Empresa save persists them.
    return applyQuoteSettingsDefaults(config);
```

- [ ] **Step 4: Implement in `main.js`**

Change the require on line 31 to:

```js
const { SCHEMA_VERSION, ADMIN_PASSWORD_PLACEHOLDER, buildEmptyConfig, applyQuoteSettingsDefaults } = require('./config.default');
```

In the `config:read` handler (file branch), change the success return to:

```js
    // Optional keys newer versions introduced (quote_settings.deposit_pct)
    // are defaulted in memory only — never by rewriting config.js on boot.
    return { ok: true, config: stripAdminPassword(applyQuoteSettingsDefaults(config)), info };
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/cloud-bootstrap.test.js`
Expected: PASS (the existing `expectedConfig` equality still holds: the fixture now carries `deposit_pct: 0.4`).

- [ ] **Step 6: Commit**

```bash
git add lib/cloud-bootstrap.js main.js tests/cloud-bootstrap.test.js
git commit -m "feat(config): apply the deposit default at the config hand-off (file + cloud)"
```

---

### Task 3: Pure deposit arithmetic (`renderer/deposit.js`)

**Files:**
- Create: `renderer/deposit.js`
- Test: `tests/deposit.test.js` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/deposit.test.js`:

```js
// ============================================================
// Deposit ("señal") arithmetic (renderer/deposit.js)
// ============================================================
// Pure helpers behind the step-3 "Señal" card and the history inline
// form: the minimum (percentage of the VAT-inclusive total, rounded UP
// to the euro), the remaining balance, and the two input parsers.
// The percentage is always an argument — the default lives in config.
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

  test('a float artefact never bumps an exact result (100 × 0.7 = 70.00000000000001 → 70)', () => {
    expect(depositMinimum(100, 0.7)).toBe(70);
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

  test('rejects 0, above 100, blanks and garbage', () => {
    expect(parseDepositPct('0')).toBeNull();
    expect(parseDepositPct('101')).toBeNull();
    expect(parseDepositPct('')).toBeNull();
    expect(parseDepositPct('abc')).toBeNull();
    expect(parseDepositPct(null)).toBeNull();
  });
});

describe('parseDepositAmount', () => {
  test('parses euros with comma or dot decimals, rounded to cents', () => {
    expect(parseDepositAmount('494')).toBe(494);
    expect(parseDepositAmount('493,82')).toBe(493.82);
    expect(parseDepositAmount('493.826')).toBe(493.83);
  });

  test('rejects zero, negatives, blanks and garbage', () => {
    expect(parseDepositAmount('0')).toBeNull();
    expect(parseDepositAmount('-5')).toBeNull();
    expect(parseDepositAmount('')).toBeNull();
    expect(parseDepositAmount('cinco')).toBeNull();
  });
});

describe('formatDepositPct / pctToPercentInput', () => {
  test('formats a fraction as a Spanish percentage label', () => {
    expect(formatDepositPct(0.4)).toBe('40 %');
    expect(formatDepositPct(0.125)).toBe('12,5 %');
    expect(formatDepositPct(undefined)).toBe('');
  });

  test('turns a fraction into the number the input shows', () => {
    expect(pctToPercentInput(0.4)).toBe(40);
    expect(pctToPercentInput(0.125)).toBe(12.5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/deposit.test.js`
Expected: FAIL — cannot resolve `../renderer/deposit.js`.

- [ ] **Step 3: Create `renderer/deposit.js`**

```js
// ============================================================
// Quanto · Quote deposit ("señal") arithmetic (pure, renderer)
// ============================================================
// The workshop asks for a minimum deposit before launching an order: a
// percentage of the quote total (VAT included), rounded UP to the whole
// euro because it is a minimum. This module is the single home of that
// arithmetic plus the two input parsers the step-3 card and the history
// inline form share. No DOM, no IPC, no config access: the percentage is
// always an argument (its default lives in config — CLAUDE.md §2.2).
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
 * Rounds to cents BEFORE ceiling so a float artefact such as
 * 70.00000000000001 never becomes 71. 0 for a non-positive/invalid input.
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/deposit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/deposit.js tests/deposit.test.js
git commit -m "feat(quotes): pure deposit arithmetic (renderer/deposit.js)"
```

---

### Task 4: The quote draft carries the deposit minimum

**Files:**
- Modify: `renderer/history.js` (`buildQuoteDraft` ~line 133)
- Test: `tests/history-draft.test.js`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('buildQuoteDraft', …)` in `tests/history-draft.test.js`:

```js
  test('carries the deposit content (pct + min_amount) and never a payment', () => {
    const draft = buildQuoteDraft(BASE_RESULT, { ...BASE_CTX, deposit: { pct: 0.4, min_amount: 41 } });
    expect(draft.deposit).toEqual({ pct: 0.4, min_amount: 41 });
    expect('deposit_paid' in draft).toBe(false);
  });

  test('deposit is null when the context has none', () => {
    expect(buildQuoteDraft(BASE_RESULT, BASE_CTX).deposit).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/history-draft.test.js`
Expected: FAIL — `draft.deposit` is `undefined`.

- [ ] **Step 3: Implement**

In `buildQuoteDraft`, extend the JSDoc `ctx` line to `{ user, configVersion, customer?, packId?, opt?, deposit? }` and add after `opt: ctx.opt || null`:

```js
    // Deposit minimum for this quote (content — design 2026-09-04 §3.2).
    // The payment (`deposit_paid`) is workflow and NEVER travels in a draft.
    deposit: ctx.deposit
      ? { pct: ctx.deposit.pct, min_amount: ctx.deposit.min_amount }
      : null
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/history-draft.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/history.js tests/history-draft.test.js
git commit -m "feat(quotes): quote draft carries the deposit minimum"
```

---

### Task 5: Shared helpers + file backend `setDepositPaid`

**Files:**
- Modify: `lib/quote-store-helpers.js` (add two helpers + exports)
- Modify: `lib/quote-repo-file.js` (`createQuote` ~line 106, `replaceQuote` ~line 273, new `setDepositPaid` after `setStatus`, exports)
- Test: `tests/quote-store-helpers.test.js`, `tests/quote-repo-file.test.js`

- [ ] **Step 1: Write the failing helper tests**

Append to `tests/quote-store-helpers.test.js`:

```js
import { normalizeDepositPaid, withoutDepositPaid } from '../lib/quote-store-helpers.js';

describe('normalizeDepositPaid', () => {
  const AT = '2026-09-04T10:00:00.000Z';

  test('null/undefined mean "not paid" and pass through as null', () => {
    expect(normalizeDepositPaid(null)).toBeNull();
    expect(normalizeDepositPaid(undefined)).toBeNull();
  });

  test('rounds the amount to cents and blanks an empty `by`', () => {
    expect(normalizeDepositPaid({ amount: 120.006, at: AT, by: '  ' }))
      .toEqual({ amount: 120.01, at: AT, by: null });
    expect(normalizeDepositPaid({ amount: '121', at: AT, by: 'Mostrador' }))
      .toEqual({ amount: 121, at: AT, by: 'Mostrador' });
  });

  test('rejects a non-positive or non-numeric amount with a Spanish error', () => {
    expect(() => normalizeDepositPaid({ amount: 0, at: AT })).toThrow(/importe/i);
    expect(() => normalizeDepositPaid({ amount: -5, at: AT })).toThrow(/importe/i);
    expect(() => normalizeDepositPaid({ amount: 'x', at: AT })).toThrow(/importe/i);
  });

  test('rejects a missing or unparsable timestamp', () => {
    expect(() => normalizeDepositPaid({ amount: 10 })).toThrow(/fecha/i);
    expect(() => normalizeDepositPaid({ amount: 10, at: 'ayer' })).toThrow(/fecha/i);
  });

  test('rejects a non-object', () => {
    expect(() => normalizeDepositPaid(5)).toThrow(/objeto/i);
    expect(() => normalizeDepositPaid([1])).toThrow(/objeto/i);
  });
});

describe('withoutDepositPaid', () => {
  test('returns the same draft when it carries no payment', () => {
    const d = { user: 'a' };
    expect(withoutDepositPaid(d)).toBe(d);
  });

  test('drops deposit_paid from a copy, leaving the input untouched', () => {
    const d = { user: 'a', deposit_paid: { amount: 1 } };
    const out = withoutDepositPaid(d);
    expect(out).toEqual({ user: 'a' });
    expect(d.deposit_paid).toEqual({ amount: 1 });
  });
});
```

- [ ] **Step 2: Write the failing file-backend tests**

Add `setDepositPaid` to the named import of `tests/quote-repo-file.test.js` and append:

```js
// ── setDepositPaid ───────────────────────────────────────────
describe('setDepositPaid', () => {
  const PAID = { amount: 121, at: '2026-09-04T10:00:00.000Z', by: 'Mostrador' };

  test('records the payment, sets status accepted + status_ts, keeps version', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-09-01T10:00:00Z') });
    const updated = setDepositPaid(folder, q.id, PAID, { now: '2026-09-04T10:00:00.000Z' });
    expect(updated.deposit_paid).toEqual(PAID);
    expect(updated.status).toBe('accepted');
    expect(updated.status_ts).toBe('2026-09-04T10:00:00.000Z');
    expect(updated.version).toBe(1);
    expect(getQuote(folder, q.id).quote).toEqual(updated);
  });

  test('clearing (null) removes the payment and returns the quote to pending', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT);
    setDepositPaid(folder, q.id, PAID, { now: '2026-09-04T10:00:00.000Z' });
    const cleared = setDepositPaid(folder, q.id, null, { now: '2026-09-05T10:00:00.000Z' });
    expect('deposit_paid' in cleared).toBe(false);
    expect(cleared.status).toBe('pending');
    expect(cleared.status_ts).toBe('2026-09-05T10:00:00.000Z');
    expect(cleared.version).toBe(1);
  });

  test('normalizes the amount to cents and a blank `by` to null', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT);
    const updated = setDepositPaid(folder, q.id, { amount: 120.006, at: PAID.at, by: '  ' });
    expect(updated.deposit_paid).toEqual({ amount: 120.01, at: PAID.at, by: null });
  });

  test('rejects a non-positive amount BEFORE any write', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT);
    expect(() => setDepositPaid(folder, q.id, { amount: 0, at: PAID.at, by: null })).toThrow(/importe/i);
    expect(getQuote(folder, q.id).quote.status).toBe('pending');
  });

  test('returns null for an unknown or shape-invalid id', () => {
    const folder = makeFolder();
    expect(setDepositPaid(folder, 'PP-2026-9999', PAID)).toBeNull();
    expect(setDepositPaid(folder, '../evil', PAID)).toBeNull();
  });

  test('replaceQuote preserves the stored payment and ignores one smuggled in the draft', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT, { now: new Date('2026-09-01T10:00:00Z') });
    setDepositPaid(folder, q.id, PAID, { now: '2026-09-04T10:00:00.000Z' });
    const token = getQuote(folder, q.id);
    const res = replaceQuote(
      folder, q.id,
      { ...DRAFT, user: 'Edited', deposit_paid: { amount: 1, at: PAID.at, by: 'x' } },
      token, { now: new Date('2026-09-06T10:00:00Z') }
    );
    expect(res.quote.deposit_paid).toEqual(PAID);
    expect(res.quote.status).toBe('accepted');
    expect(res.quote.version).toBe(2);
    expect(res.quote.user).toBe('Edited');
  });

  test('replaceQuote of an unpaid quote stays unpaid (no key)', () => {
    const folder = makeFolder();
    const q = createQuote(folder, DRAFT);
    const token = getQuote(folder, q.id);
    const res = replaceQuote(folder, q.id, { ...DRAFT, deposit_paid: { amount: 9, at: PAID.at, by: null } }, token);
    expect('deposit_paid' in res.quote).toBe(false);
  });

  test('createQuote drops a deposit_paid carried by the draft', () => {
    const folder = makeFolder();
    const q = createQuote(folder, { ...DRAFT, deposit_paid: PAID });
    expect('deposit_paid' in q).toBe(false);
    expect('deposit_paid' in getQuote(folder, q.id).quote).toBe(false);
  });
});
```

- [ ] **Step 3: Run both files to verify they fail**

Run: `pnpm vitest run tests/quote-store-helpers.test.js tests/quote-repo-file.test.js`
Expected: FAIL — the helpers and `setDepositPaid` are not exported.

- [ ] **Step 4: Implement the helpers in `lib/quote-store-helpers.js`**

Add before `module.exports`:

```js
/**
 * Validates the paid-deposit ("señal") fact both backends persist —
 * design 2026-09-04 §4.1. `null`/`undefined` mean "not paid" and pass
 * through as null. Otherwise `amount` must be a finite number > 0
 * (rounded to cents), `at` a parsable ISO timestamp and `by` a string
 * or null. Throws a Spanish error BEFORE any IO so a bad amount never
 * reaches a file or D1.
 *
 * @param {{amount:number, at:string, by?:(string|null)} | null | undefined} paid
 * @returns {{amount:number, at:string, by:(string|null)} | null}
 */
function normalizeDepositPaid(paid) {
  if (paid === null || paid === undefined) return null;
  if (typeof paid !== 'object' || Array.isArray(paid)) {
    throw new Error('La señal debe ser un objeto o null.');
  }
  const amount = Number(paid.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('El importe de la señal debe ser un número mayor que cero.');
  }
  if (typeof paid.at !== 'string' || Number.isNaN(Date.parse(paid.at))) {
    throw new Error('La fecha de la señal no es válida.');
  }
  const by = typeof paid.by === 'string' && paid.by.trim() ? paid.by.trim() : null;
  return { amount: Math.round(amount * 100) / 100, at: paid.at, by };
}

/**
 * The payment is workflow (written only by setDepositPaid), so a draft can
 * never smuggle it in on create or edit. Returns the same object when
 * there is nothing to strip.
 *
 * @param {object} draft
 * @returns {object}
 */
function withoutDepositPaid(draft) {
  if (!draft || typeof draft !== 'object' || draft.deposit_paid === undefined) return draft;
  const copy = { ...draft };
  delete copy.deposit_paid;
  return copy;
}
```

Update the exports:

```js
module.exports = {
  PENDING_ID_PREFIX, quotesFolder, isPendingId, newPendingId,
  normalizeDepositPaid, withoutDepositPaid
};
```

- [ ] **Step 5: Implement in `lib/quote-repo-file.js`**

Add to the requires:

```js
const { normalizeDepositPaid, withoutDepositPaid } = require('./quote-store-helpers');
```

In `createQuote`, change `...draft,` inside `record` to `...withoutDepositPaid(draft),`.

In `replaceQuote`, change the `merged` construction to:

```js
  const merged = {
    ...withoutDepositPaid(draft),
    // Pin identity
    id: existing.id,
    date: existing.date,
    // Pin workflow fields from existing (they may be undefined)
    status: existing.status,
    status_ts: existing.status_ts,
    cloud_id: existing.cloud_id,
    deposit_paid: existing.deposit_paid,
    // Bump revision
    version: (Number.isFinite(existing.version) ? existing.version : 1) + 1,
    updated_at: now.toISOString(),
  };
```

and after `if (merged.cloud_id === undefined) delete merged.cloud_id;` add:

```js
  if (merged.deposit_paid === undefined) delete merged.deposit_paid;
```

Add after `setStatus`:

```js
/**
 * Records (or clears) the paid deposit ("señal") of a quote and flips its
 * workflow status in the SAME atomic write: paid → 'accepted', cleared →
 * 'pending' (design 2026-09-04 §4.1). Like setStatus this is workflow,
 * not a content edit: `version` is NOT bumped, so an open editor's
 * conflict token stays valid. The payment is validated before any IO.
 *
 * @param {string} folder
 * @param {string} id
 * @param {{amount:number, at:string, by?:(string|null)} | null} paid
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO timestamp for status_ts (default: now)
 * @returns {object | null} the updated quote, or null when the id is absent
 */
function setDepositPaid(folder, id, paid, opts = {}) {
  const clean = normalizeDepositPaid(paid); // throws a Spanish error on a bad amount
  if (!isValidId(id)) return null; // traversal guard: treat a bad id as absent
  const filePath = path.join(folder, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  const quote = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (clean) quote.deposit_paid = clean;
  else delete quote.deposit_paid;
  quote.status = clean ? 'accepted' : 'pending';
  quote.status_ts = opts.now || new Date().toISOString();
  // NOTE: version is deliberately NOT bumped — a deposit mark is workflow.

  const body = serializeOrThrow(quote);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, body, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return quote;
}
```

Add `setDepositPaid,` to `module.exports` (after `setStatus,`).

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/quote-store-helpers.test.js tests/quote-repo-file.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/quote-store-helpers.js lib/quote-repo-file.js tests/quote-store-helpers.test.js tests/quote-repo-file.test.js
git commit -m "feat(quotes): file backend setDepositPaid (workflow op, no version bump)"
```

---

### Task 6: Cloud data layer — migration 0003 + `setQuoteDeposit`

**Files:**
- Create: `db/migrations/0003_quote_deposits.sql`
- Modify: `lib/cloud-quotes.js` (`getFullQuote` ~line 324, `listFullQuotes` ~line 361, `deleteFullQuote` ~line 457, new `setQuoteDeposit` + `depositFromRow`, exports)
- Test: `tests/quote-repo-cloud.test.js` (fake client + new describes)

- [ ] **Step 1: Extend the fake client in `tests/quote-repo-cloud.test.js`**

Inside `fakeClient()` add a third table and a helper (after `const calls = [];`):

```js
  const deposits = new Map();       // quote_id → { amount, paid_at, paid_by }

  // getFullQuote/listFullQuotes LEFT JOIN quote_deposits: expose the
  // deposit columns (null when unpaid) on every flat row they return.
  function withDeposit(row) {
    const d = deposits.get(row.id);
    return {
      ...row,
      deposit_amount: d ? d.amount : null,
      deposit_paid_at: d ? d.paid_at : null,
      deposit_paid_by: d ? d.paid_by : null
    };
  }
```

Expose it in the returned object (`calls, quotes, payloads, deposits,`), and add these branches to `query()` **before** the `UPDATE quotes SET` branch:

```js
      if (/INSERT INTO quote_deposits/.test(sql)) {
        // upsert: [quote_id, amount, paid_at, paid_by]
        const [quote_id, amount, paid_at, paid_by] = params;
        deposits.set(quote_id, { amount, paid_at, paid_by });
        return { results: [], meta: { changes: 1 } };
      }
      if (/DELETE FROM quote_deposits/.test(sql)) {
        const had = deposits.delete(params[0]);
        return { results: [], meta: { changes: had ? 1 : 0 } };
      }
```

Change the two `SELECT … FROM quotes` shapes so they honour the join alias:

```js
        if (/WHERE (q\.)?id = \?/.test(sql)) {
          const row = quotes.get(params[0]);
          return { results: row ? [withDeposit(row)] : [], meta: {} };
        }
        …
        // plain list
        return { results: [...quotes.values()].map(withDeposit), meta: {} };
```

- [ ] **Step 2: Write the failing tests**

Add `setQuoteDeposit, deleteFullQuote` to the named import from `'../lib/cloud-quotes.js'`, then append:

```js
// ── Migration 0003 ───────────────────────────────────────────────
describe('0003_quote_deposits migration', () => {
  test('the loader picks up 0003 right after 0002', () => {
    const ids = loadMigrations(REAL_MIGRATIONS).map((m) => m.id);
    expect(ids.indexOf('0003_quote_deposits')).toBe(ids.indexOf('0002_quote_payloads') + 1);
  });

  test('0003 creates quote_deposits with CREATE TABLE IF NOT EXISTS (no ALTER)', () => {
    const m = loadMigrations(REAL_MIGRATIONS).find((x) => x.id === '0003_quote_deposits');
    expect(m.sql).toMatch(/CREATE TABLE IF NOT EXISTS quote_deposits/);
    expect(m.sql).not.toMatch(/ALTER TABLE/i);
    expect(m.sql).toMatch(/quote_id\s+TEXT PRIMARY KEY/);
    expect(m.sql).toMatch(/amount\s+REAL NOT NULL/);
    expect(m.sql).toMatch(/paid_at\s+TEXT NOT NULL/);
  });

  test('applyMigrations runs 0003 once; a second run is a no-op (ledger)', async () => {
    const migrations = loadMigrations(REAL_MIGRATIONS);
    const client = fakeMigratorClient();
    const opts = { user: 'PC-Test', appVersion: '5.2.0-beta', now: () => '2026-09-04T10:00:00.000Z' };
    expect(await applyMigrations(client, migrations, opts)).toContain('0003_quote_deposits');
    expect(await applyMigrations(client, migrations, opts)).toEqual([]);
  });
});

// ── setQuoteDeposit ──────────────────────────────────────────────
describe('setQuoteDeposit', () => {
  const PAID = { amount: 249, at: '2026-09-04T10:00:00.000Z', by: 'Mostrador' };
  const NOW = '2026-09-04T10:00:00.000Z';

  test('paid: flips the flat status to accepted FIRST, then upserts quote_deposits', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    client.calls.length = 0;
    const res = await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: PAID, now: NOW });
    expect(res).toEqual({ ok: true, changes: 1 });
    expect(client.calls[0].sql).toBe('UPDATE quotes SET status = ?, status_ts = ? WHERE id = ?');
    expect(client.calls[0].params).toEqual(['accepted', NOW, 'PP-2026-0001']);
    expect(client.calls[1].sql).toMatch(/INSERT INTO quote_deposits[^]*ON CONFLICT\(quote_id\) DO UPDATE/);
    expect(client.calls[1].params).toEqual(['PP-2026-0001', 249, PAID.at, 'Mostrador']);
    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote.status).toBe('accepted');
    expect(quote.deposit_paid).toEqual(PAID);
    expect(quote.version).toBe(1); // payload untouched
  });

  test('clear: status back to pending and the deposit row deleted', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: PAID, now: NOW });
    client.calls.length = 0;
    const res = await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: null, now: NOW });
    expect(res).toEqual({ ok: true, changes: 1 });
    expect(client.calls[0].params).toEqual(['pending', NOW, 'PP-2026-0001']);
    expect(client.calls[1].sql).toBe('DELETE FROM quote_deposits WHERE quote_id = ?');
    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote.status).toBe('pending');
    expect(quote.deposit_paid).toBeNull();
  });

  test('unknown id: the status UPDATE reports 0 changes and NOTHING else is written', async () => {
    const client = fakeClient();
    const res = await setQuoteDeposit(client, { id: 'PP-2026-9999', paid: PAID, now: NOW });
    expect(res).toEqual({ ok: false, changes: 0 });
    expect(client.calls).toHaveLength(1);
  });

  test('getFullQuote: the join is authoritative — a stale payload copy of deposit_paid is overridden with null', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote({ deposit_paid: { amount: 1, at: NOW, by: 'stale' } }));
    const quote = await getFullQuote(client, 'PP-2026-0001');
    expect(quote.deposit_paid).toBeNull();
  });

  test('listFullQuotes rows carry the deposit columns (null when unpaid)', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    await saveFullQuote(client, sampleFullQuote({ id: 'PP-2026-0002', ts: '2026-06-13T10:00:00.000Z' }));
    await setQuoteDeposit(client, { id: 'PP-2026-0002', paid: PAID, now: NOW });
    const list = await listFullQuotes(client);
    const byId = Object.fromEntries(list.map((r) => [r.id, r]));
    expect(byId['PP-2026-0001'].deposit_amount).toBeNull();
    expect(byId['PP-2026-0002'].deposit_amount).toBe(249);
    expect(byId['PP-2026-0002'].deposit_paid_at).toBe(PAID.at);
    const sql = client.calls.at(-1).sql;
    expect(sql).toMatch(/LEFT JOIN quote_deposits/);
  });

  test('deleteFullQuote also deletes the deposit row', async () => {
    const client = fakeClient();
    await saveFullQuote(client, sampleFullQuote());
    await setQuoteDeposit(client, { id: 'PP-2026-0001', paid: PAID, now: NOW });
    await deleteFullQuote(client, 'PP-2026-0001');
    expect(client.calls.some((c) => c.sql === 'DELETE FROM quote_deposits WHERE quote_id = ?')).toBe(true);
    expect(client.deposits.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/quote-repo-cloud.test.js`
Expected: FAIL — `0003_quote_deposits` missing; `setQuoteDeposit` not exported.

- [ ] **Step 4: Create `db/migrations/0003_quote_deposits.sql`**

```sql
-- 0003_quote_deposits.sql — the paid-deposit ("señal") workflow fact, kept
-- separate from the versioned payload (a deposit mark must not bump the
-- content version) and from the flat `quotes` row (SQLite's column-add has
-- no IF NOT EXISTS guard — see 0002). CREATE ... IF NOT EXISTS keeps the
-- file idempotent for the runner (lib/db-migrator.js). Absent row = not
-- paid. The flat `quotes` row still owns status/status_ts: marking a
-- deposit paid also sets status = 'accepted' there (lib/cloud-quotes.js).
CREATE TABLE IF NOT EXISTS quote_deposits (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id),
  amount   REAL NOT NULL,
  paid_at  TEXT NOT NULL,
  paid_by  TEXT
);
```

- [ ] **Step 5: Implement in `lib/cloud-quotes.js`**

Add after `updateQuoteStatus`:

```js
/**
 * Records or clears the paid deposit ("señal") of a quote and flips its
 * status on the flat row: paid → 'accepted', cleared → 'pending' (design
 * 2026-09-04 §4.1). The status UPDATE runs FIRST and doubles as the
 * existence check: changes 0 → unknown id → nothing else is written and
 * { ok:false, changes:0 } is returned. Then the quote_deposits row is
 * upserted (paid) or deleted (cleared). The payload `version` is untouched —
 * a deposit mark is workflow, not content (mirrors updateQuoteStatus).
 *
 * Residual non-atomicity (no Worker, no transaction — same class as
 * updateFullQuote): if the deposit write throws after the status UPDATE,
 * the row reads 'accepted' with no deposit; the error propagates (CLAUDE.md
 * hard rule §4) and a retry repeats both statements idempotently.
 *
 * @param {object} client - D1 client
 * @param {object} args
 * @param {string} args.id - human quote id
 * @param {{amount:number, at:string, by:(string|null)}|null} args.paid - already
 *   normalized by lib/quote-store-helpers.js normalizeDepositPaid
 * @param {string} args.now - ISO timestamp for status_ts
 * @returns {Promise<{ok:boolean, changes:number}>}
 */
async function setQuoteDeposit(client, { id, paid, now }) {
  const res = await updateQuoteStatus(client, { id, status: paid ? 'accepted' : 'pending', now });
  if ((res.changes || 0) === 0) return { ok: false, changes: 0 };
  if (paid) {
    await client.query(
      'INSERT INTO quote_deposits (quote_id, amount, paid_at, paid_by) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(quote_id) DO UPDATE SET amount = excluded.amount, paid_at = excluded.paid_at, paid_by = excluded.paid_by',
      [id, paid.amount, paid.at, paid.by]
    );
  } else {
    await client.query('DELETE FROM quote_deposits WHERE quote_id = ?', [id]);
  }
  return { ok: true, changes: 1 };
}

/**
 * Maps the LEFT-JOINed deposit columns of a flat row to the canonical
 * `deposit_paid` value: the object when a row exists, null otherwise.
 *
 * @param {object} row - a row carrying deposit_amount / deposit_paid_at / deposit_paid_by
 * @returns {{amount:number, at:string, by:(string|null)} | null}
 */
function depositFromRow(row) {
  if (!row || row.deposit_amount === null || row.deposit_amount === undefined) return null;
  return {
    amount: row.deposit_amount,
    at: row.deposit_paid_at,
    by: row.deposit_paid_by === undefined ? null : row.deposit_paid_by
  };
}
```

In `getFullQuote`, replace the flat-row SELECT and overlay with:

```js
  // Overlay the authoritative version + status + paid deposit from the flat
  // row (LEFT JOIN: one query). The overlay ALWAYS sets deposit_paid —
  // object or null — so a stale copy inside the payload can never win.
  const flatRes = await client.query(
    'SELECT q.status, q.status_ts, d.amount AS deposit_amount, d.paid_at AS deposit_paid_at, d.paid_by AS deposit_paid_by '
    + 'FROM quotes q LEFT JOIN quote_deposits d ON d.quote_id = q.id WHERE q.id = ?',
    [id]
  );
  const flatRow = (flatRes.results || [])[0];
  quote.version = payloadRow.version;
  if (flatRow) {
    quote.status = flatRow.status;
    quote.status_ts = flatRow.status_ts;
    quote.deposit_paid = depositFromRow(flatRow);
  }
  return quote;
```

In `listFullQuotes`, replace the SQL with:

```js
  const res = await client.query(
    'SELECT q.id, q.user, q.client_name, q.pack_id, q.total_vat_inc, q.status, q.ts, '
    + 'd.amount AS deposit_amount, d.paid_at AS deposit_paid_at, d.paid_by AS deposit_paid_by '
    + 'FROM quotes q LEFT JOIN quote_deposits d ON d.quote_id = q.id ORDER BY q.ts DESC'
  );
```

In `deleteFullQuote`, add as the FIRST statement:

```js
  await client.query('DELETE FROM quote_deposits WHERE quote_id = ?', [id]);
```

Add `setQuoteDeposit,` and `depositFromRow,` to `module.exports`.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/quote-repo-cloud.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0003_quote_deposits.sql lib/cloud-quotes.js tests/quote-repo-cloud.test.js
git commit -m "feat(cloud): quote_deposits table (0003) + setQuoteDeposit data layer"
```

---

### Task 7: Cloud façade `setDepositPaid`

**Files:**
- Modify: `lib/quote-repo-cloud.js` (requires ~line 23, `createQuote` ~line 77, `listQuotes` ~line 123, `replaceQuote` ~line 183, new `setDepositPaid`, exports)
- Test: `tests/quote-repo-cloud-facade.test.js` (fake client + new describe)

- [ ] **Step 1: Extend the façade fake client**

In `fakeClient()` of `tests/quote-repo-cloud-facade.test.js`, add a deposits table and a helper after `const calls = [];`:

```js
  const deposits = new Map(); // quote_id → { amount, paid_at, paid_by }

  // getFullQuote/listFullQuotes LEFT JOIN quote_deposits: expose the
  // deposit columns (null when unpaid) on every flat row they return.
  function withDeposit(row) {
    const d = deposits.get(row.id);
    return {
      ...row,
      deposit_amount: d ? d.amount : null,
      deposit_paid_at: d ? d.paid_at : null,
      deposit_paid_by: d ? d.paid_by : null
    };
  }
```

Expose it in the returned object (`calls, quotes, payloads, items, addons, deposits,`). Add these two branches to `query()` **before** the `DELETE FROM quotes` branch:

```js
      if (/INSERT INTO quote_deposits/.test(sql)) {
        // upsert: [quote_id, amount, paid_at, paid_by]
        const [quote_id, amount, paid_at, paid_by] = params;
        deposits.set(quote_id, { amount, paid_at, paid_by });
        return { results: [], meta: { changes: 1 } };
      }
      if (/DELETE FROM quote_deposits/.test(sql)) {
        const had = deposits.delete(params[0]);
        return { results: [], meta: { changes: had ? 1 : 0 } };
      }
```

Change the two `SELECT … FROM quotes` shapes so they honour the join alias:

```js
        if (/WHERE (q\.)?id = \?/.test(sql)) {
          const row = quotes.get(params[0]);
          return { results: row ? [withDeposit(row)] : [], meta: {} };
        }
        …
        // plain list (listFullQuotes) — flat rows + deposit columns
        return { results: [...quotes.values()].map(withDeposit), meta: {} };
```

- [ ] **Step 2: Write the failing tests**

Add `setDepositPaid` to the named import from `'../lib/quote-repo-cloud.js'` and append:

```js
// ── setDepositPaid ───────────────────────────────────────────────
describe('setDepositPaid', () => {
  const PAID = { amount: 249, at: '2026-09-04T10:00:00.000Z', by: 'Mostrador' };
  const NOW = '2026-09-04T10:00:00.000Z';

  test('returns the overlaid quote: payment recorded, status accepted, version untouched', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const updated = await setDepositPaid(client, q.id, PAID, { now: NOW });
    expect(updated.deposit_paid).toEqual(PAID);
    expect(updated.status).toBe('accepted');
    expect(updated.status_ts).toBe(NOW);
    expect(updated.version).toBe(1);
    expect((await getQuote(client, q.id)).quote.deposit_paid).toEqual(PAID);
  });

  test('clearing returns the quote to pending with deposit_paid null', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft());
    await setDepositPaid(client, q.id, PAID, { now: NOW });
    const cleared = await setDepositPaid(client, q.id, null, { now: NOW });
    expect(cleared.status).toBe('pending');
    expect(cleared.deposit_paid).toBeNull();
  });

  test('returns null for an unknown id and for a shape-invalid id (no query)', async () => {
    const client = fakeClient();
    expect(await setDepositPaid(client, 'PP-2026-9999', PAID, { now: NOW })).toBeNull();
    client.calls.length = 0;
    expect(await setDepositPaid(client, '../evil', PAID, { now: NOW })).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  test('rejects a bad amount BEFORE any network call', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft());
    client.calls.length = 0;
    await expect(setDepositPaid(client, q.id, { amount: 0, at: NOW, by: null }, { now: NOW }))
      .rejects.toThrow(/importe/i);
    expect(client.calls).toHaveLength(0);
  });

  test('replaceQuote preserves the stored payment and drops one smuggled in the draft', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft());
    await setDepositPaid(client, q.id, PAID, { now: NOW });
    const { version } = await getQuote(client, q.id);
    const res = await replaceQuote(client, q.id, sampleDraft({ user: 'Edited', deposit_paid: { amount: 1, at: NOW, by: 'x' } }), version);
    expect(res.quote.deposit_paid).toEqual(PAID);
    expect(res.quote.status).toBe('accepted');
    expect(res.quote.version).toBe(2);
    expect(JSON.parse(client.payloads.get(q.id).payload).deposit_paid).toEqual(PAID);
  });

  test('createQuote never writes a deposit_paid carried by the draft', async () => {
    const client = fakeClient();
    const q = await createQuote(client, sampleDraft({ deposit_paid: PAID }));
    expect(q.deposit_paid).toBeUndefined();
    expect(JSON.parse(client.payloads.get(q.id).payload).deposit_paid).toBeUndefined();
    expect((await getQuote(client, q.id)).quote.deposit_paid).toBeNull();
  });

  test('listQuotes rows carry deposit_paid (null when unpaid)', async () => {
    const client = fakeClient();
    const a = await createQuote(client, sampleDraft(), { now: '2026-06-12T10:00:00.000Z' });
    const b = await createQuote(client, sampleDraft(), { now: '2026-06-13T10:00:00.000Z' });
    await setDepositPaid(client, b.id, PAID, { now: NOW });
    const rows = await listQuotes(client);
    expect(rows.find((r) => r.id === a.id).deposit_paid).toBeNull();
    expect(rows.find((r) => r.id === b.id).deposit_paid).toEqual(PAID);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/quote-repo-cloud-facade.test.js`
Expected: FAIL — `setDepositPaid` is not exported.

- [ ] **Step 4: Implement in `lib/quote-repo-cloud.js`**

Requires:

```js
const {
  tryClaimFullQuote,
  getFullQuote,
  listFullQuotes,
  updateFullQuote,
  deleteFullQuote,
  updateQuoteStatus,
  setQuoteDeposit,
  depositFromRow,
  nextCloudQuoteId,
} = require('./cloud-quotes');
const { normalizeDepositPaid, withoutDepositPaid } = require('./quote-store-helpers');
```

In `createQuote`, change `...draft,` inside `record` to `...withoutDepositPaid(draft),`.

In `listQuotes`, add to the mapped row: `deposit_paid: depositFromRow(row),`.

In `replaceQuote`, change the `merged` construction to:

```js
  const merged = {
    ...withoutDepositPaid(draft),
    // Pin identity from the stored record
    id: existing.id,
    date: existing.date,
    // Preserve workflow state from the stored record (an edit never changes it)
    status: existing.status,
    status_ts: existing.status_ts,
    deposit_paid: existing.deposit_paid || null,
    updated_at: isoNow,
  };
```

Add after `setStatus`:

```js
/**
 * Records or clears a quote's paid deposit ("señal") and flips its status
 * (paid → accepted, cleared → pending) — the cloud parallel of
 * lib/quote-repo-file.js setDepositPaid, same updated|null contract. The
 * payment is validated BEFORE any network call; the flat row is written by
 * lib/cloud-quotes.js setQuoteDeposit; the payload version is untouched.
 *
 * @param {object} client - D1 client
 * @param {string} id
 * @param {{amount:number, at:string, by?:(string|null)} | null} paid
 * @param {object} [opts]
 * @param {string} [opts.now] - ISO timestamp for status_ts
 * @returns {Promise<object | null>} the overlaid quote, or null when absent
 */
async function setDepositPaid(client, id, paid, opts = {}) {
  const clean = normalizeDepositPaid(paid); // throws a Spanish error on a bad amount
  if (!isValidId(id)) return null; // shape guard: treat a bad id as absent
  const now = opts.now || new Date().toISOString();
  const res = await setQuoteDeposit(client, { id, paid: clean, now });
  if (!res.ok) return null; // unknown id → not found
  return getFullQuote(client, id);
}
```

Add `setDepositPaid,` to `module.exports`.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/quote-repo-cloud-facade.test.js tests/quote-repo-cloud.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/quote-repo-cloud.js tests/quote-repo-cloud-facade.test.js
git commit -m "feat(cloud): setDepositPaid in the cloud quote façade"
```

---

### Task 8: IPC — `quotes:set-deposit` + preload

**Files:**
- Modify: `main.js` (`quoteListRow` ~line 240, `quoteRepo` both branches ~lines 165–235, new handler after `quotes:update` ~line 1710)
- Modify: `preload.js` (~line 109)

No unit tests exist for `main.js`/`preload.js` (they are wiring); the repositories are tested in Tasks 5–7 and the flow is smoke-tested in Task 12.

- [ ] **Step 1: Expose the op through `quoteRepo(settings)`**

Cloud branch — add after `setStatus`:

```js
      async setDepositPaid(id, paid, now) {
        return quoteRepoCloud.setDepositPaid(client, id, paid, { now });
      },
```

File branch — add after `setStatus`:

```js
    async setDepositPaid(id, paid, now) {
      return quoteRepoFile.setDepositPaid(folder, id, paid, { now });
    },
```

- [ ] **Step 2: Carry the payment in the cache list row**

In `quoteListRow`, add `deposit_paid: q.deposit_paid || null,` after `status: q.status,`.

- [ ] **Step 3: Add the handler after `quotes:update`**

```js
// Who marked the deposit: the cloud user name when set, else the local one,
// else null — unlike cloudAuthor there is NO 'Equipo' fallback: the record
// should say "unknown" rather than invent an author.
function depositAuthor(settings) {
  const s = settings || {};
  return (s.cloud && s.cloud.user_name) || s.user_name || null;
}

// Records or clears a quote's paid deposit ("señal") — workflow, not a
// content edit (no version bump). The backend marks the quote accepted
// (paid) or pending (cleared) in the same write. NOT queued offline: the
// renderer shows the standard offline notice and the mark is redone from
// the history once the backend is back (design 2026-09-04 §4.2).
ipcMain.handle('quotes:set-deposit', async (event, payload) => {
  const settings = readSettings();
  const { id, paid } = payload || {};
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'Falta el identificador del presupuesto.' };
  }
  const now = new Date().toISOString();
  const stamped = paid ? { amount: paid.amount, at: now, by: depositAuthor(settings) } : null;
  try {
    const updated = await quoteRepo(settings).setDepositPaid(id, stamped, now);
    if (!updated) return { ok: false, error: `No se encontró el presupuesto ${id}.` };
    logger.info('quote deposit updated', { id, paid: Boolean(stamped) });
    upsertCachedQuote(updated);
    return { ok: true, quote: updated };
  } catch (err) {
    if (isBackendUnreachable(err)) {
      logger.warn('quotes:set-deposit backend unreachable', { id, error: err.message });
      return { ok: false, offline: true, error: err.message };
    }
    logger.error('quote deposit update failed', { id, error: err.message });
    return { ok: false, error: err.message };
  }
});
```

- [ ] **Step 4: Expose it in `preload.js`**

After `updateQuote:` add:

```js
  // Record/clear a quote's paid deposit ({ id, paid: { amount } | null }).
  // Main stamps the timestamp + author; the backend flips the status.
  setQuoteDeposit:    (data)  => ipcRenderer.invoke('quotes:set-deposit', data),
```

- [ ] **Step 5: Syntax-check main and preload, run the suite**

Run: `node --check main.js && node --check preload.js && pnpm test`
Expected: no syntax errors; suite PASS.

- [ ] **Step 6: Commit**

```bash
git add main.js preload.js
git commit -m "feat(ipc): quotes:set-deposit handler + preload setQuoteDeposit"
```

---

### Task 9: PDF — deposit rows and confirmation in the 6 built-ins

**Files:**
- Modify: `lib/pdf-templates.js` (`buildQuoteContext` ~lines 132–245, `LINES_ROWS` ~line 253, the six templates' `table.totals` CSS + total row, `DEMO_QUOTE` ~line 700)
- Test: `tests/pdf-templates.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/pdf-templates.test.js`:

```js
// ── Deposit ("señal") ────────────────────────────────────────
const UNPAID_QUOTE = { ...SAMPLE_CREW_QUOTE, deposit: { pct: 0.4, min_amount: 125 } }; // 311.40 × 0.4 = 124.56 → 125
const PAID_QUOTE = {
  ...UNPAID_QUOTE,
  status: 'accepted',
  deposit_paid: { amount: 130, at: '2026-09-04T10:00:00.000Z', by: 'Mostrador' }
};

describe('buildQuoteContext — deposit', () => {
  test('a quote without deposit exposes the flags off and empty strings', () => {
    const ctx = buildQuoteContext(SAMPLE_CREW_QUOTE);
    expect(ctx.has_deposit).toBe(false);
    expect(ctx.deposit_paid).toBe(false);
    expect(ctx.deposit_min).toBe('');
    expect(ctx.deposit_remaining).toBe('');
    expect(ctx.confirmation).not.toMatch(/señal/i);
  });

  test('an unpaid deposit prints the minimum and asks for it in the confirmation', () => {
    const ctx = buildQuoteContext(UNPAID_QUOTE, { company: { phone: '942 000 000' } });
    expect(ctx.has_deposit).toBe(true);
    expect(ctx.deposit_pct).toBe('40 %');
    expect(ctx.deposit_min).toBe('125,00 €');
    expect(ctx.deposit_paid).toBe(false);
    expect(ctx.confirmation).toContain('942 000 000');
    expect(ctx.confirmation).toContain('señal mínima de 125,00 €');
    expect(ctx.confirmation).toContain('No requiere firma');
  });

  test('a paid deposit prints amount, date and remaining balance; the confirmation says accepted', () => {
    const ctx = buildQuoteContext(PAID_QUOTE);
    expect(ctx.deposit_paid).toBe(true);
    expect(ctx.deposit_paid_amount).toBe('130,00 €');
    expect(ctx.deposit_paid_date).toBe('04/09/2026');
    expect(ctx.deposit_remaining).toBe('181,40 €');
    expect(ctx.confirmation).toContain('Señal de 130,00 € recibida el 04/09/2026');
    expect(ctx.confirmation).toContain('presupuesto aceptado');
    expect(ctx.confirmation).toContain('Resto pendiente: 181,40 €');
  });

  test('a legacy quote (no stored minimum) marked paid from the history still prints the payment', () => {
    const ctx = buildQuoteContext({ ...SAMPLE_CREW_QUOTE, deposit_paid: { amount: 100, at: '2026-09-04T10:00:00.000Z', by: null } });
    expect(ctx.has_deposit).toBe(false);
    expect(ctx.deposit_paid).toBe(true);
    expect(ctx.deposit_remaining).toBe('211,40 €');
  });

  test('the remaining balance never goes negative', () => {
    const ctx = buildQuoteContext({ ...PAID_QUOTE, deposit_paid: { amount: 999, at: '2026-09-04T10:00:00.000Z', by: null } });
    expect(ctx.deposit_remaining).toBe('0,00 €');
  });

  test('formats a fractional percentage in Spanish', () => {
    const ctx = buildQuoteContext({ ...UNPAID_QUOTE, deposit: { pct: 0.125, min_amount: 39 } });
    expect(ctx.deposit_pct).toBe('12,5 %');
  });
});

describe('renderQuote — deposit rows in every built-in', () => {
  for (const id of BUILTIN_IDS) {
    test(`'${id}' prints the three deposit rows when paid and none without a deposit`, () => {
      const opts = { templateId: id, company: { name: 'T' }, quoteSettings: { terms: '' }, brand: brandColors('#3D7BD9') };
      const paid = renderQuote(PAID_QUOTE, opts);
      expect(paid).toContain('Señal mínima (40 %)');
      expect(paid).toContain('125,00 €');
      expect(paid).toContain('Señal recibida (04/09/2026)');
      expect(paid).toContain('130,00 €');
      expect(paid).toContain('Resto pendiente');
      expect(paid).toContain('181,40 €');
      expect(paid).not.toContain('{{');
      const unpaid = renderQuote(UNPAID_QUOTE, opts);
      expect(unpaid).toContain('Señal mínima (40 %)');
      expect(unpaid).not.toContain('Señal recibida');
      const none = renderQuote(SAMPLE_CREW_QUOTE, opts);
      expect(none).not.toMatch(/Señal/);
    });
  }

  test('the settings-gallery preview carries the minimum deposit', () => {
    expect(renderPreview({ templateId: 'clasica' })).toContain('Señal mínima (40 %)');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/pdf-templates.test.js`
Expected: FAIL — `has_deposit` undefined, rows missing.

- [ ] **Step 3: Add the context fields and confirmation variants in `buildQuoteContext`**

Add a helper next to `fmtDate`:

```js
// 0.4 → "40 %", 0.125 → "12,5 %" (mirrors renderer/deposit.js formatDepositPct).
function fmtPct(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '';
  return (fraction * 100).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' %';
}
```

Replace the `confirmation` computation (the `const channel = …` block and the two-line ternary) with:

```js
  // Deposit ("señal" — design 2026-09-04 §7). The minimum is stored on the
  // quote as content (renderer/deposit.js computes it) and the payment is
  // workflow; nothing is recomputed here. The two blocks are independent:
  // a quote saved before the feature but marked paid from the history has
  // deposit_paid and no stored minimum.
  const deposit = quote?.deposit;
  const hasDeposit = Boolean(deposit && Number.isFinite(deposit.min_amount));
  const paid = quote?.deposit_paid;
  const depositPaid = Boolean(paid && Number.isFinite(paid.amount));
  const remaining = depositPaid ? Math.max(0, Math.round((total - paid.amount) * 100) / 100) : 0;

  // The digital-confirmation note (replaces a signature). Data-derived:
  // it points the customer to the company's own contact channels and, when
  // the quote carries a deposit, says what unlocks the order.
  const channel = [company.phone, company.email].filter(Boolean).join(' / ');
  const contact = channel
    ? `confírmelo por teléfono o email (${channel})`
    : 'confírmelo por teléfono o email';
  let confirmation;
  if (depositPaid) {
    confirmation = `Señal de ${fmtEur(paid.amount)} recibida el ${fmtDate(paid.at)}: presupuesto aceptado. Resto pendiente: ${fmtEur(remaining)}. No requiere firma.`;
  } else if (hasDeposit) {
    confirmation = `Presupuesto digital. Para aceptarlo, ${contact} y abone la señal mínima de ${fmtEur(deposit.min_amount)}; el pedido se lanza al recibir la señal. No requiere firma.`;
  } else {
    confirmation = `Presupuesto digital. Para aceptarlo, ${contact}. No requiere firma.`;
  }
```

Add to the returned context, after `confirmation`:

```js
    confirmation,
    has_deposit: hasDeposit,
    deposit_pct: hasDeposit ? fmtPct(deposit.pct) : '',
    deposit_min: hasDeposit ? fmtEur(deposit.min_amount) : '',
    deposit_paid: depositPaid,
    deposit_paid_amount: depositPaid ? fmtEur(paid.amount) : '',
    deposit_paid_date: depositPaid ? fmtDate(paid.at) : '',
    deposit_remaining: depositPaid ? fmtEur(remaining) : ''
```

- [ ] **Step 4: Add the shared rows and wire the six templates**

After `LINES_ROWS`, add:

```js
// Deposit rows under the total (design 2026-09-04 §7). Two independent
// {{#if}} blocks: the stored minimum, and the payment with the balance.
const DEPOSIT_ROWS = `{{#if has_deposit}}<tr class="deposit"><td>Señal mínima ({{deposit_pct}})</td><td class="num">{{deposit_min}}</td></tr>{{/if}}
    {{#if deposit_paid}}<tr class="deposit"><td>Señal recibida ({{deposit_paid_date}})</td><td class="num">{{deposit_paid_amount}}</td></tr>
    <tr class="deposit deposit--remaining"><td>Resto pendiente</td><td class="num">{{deposit_remaining}}</td></tr>{{/if}}`;
```

In **each** of the six templates, insert `    ${DEPOSIT_ROWS}` on the line right after the `<tr class="total">…</tr>` row (inside `<table class="totals">`), and add these two CSS rules right after the template's `table.totals tr.total td { … }` rule:

| Template | CSS to add |
|---|---|
| CLASICA | `table.totals tr.deposit td { font-size: 10pt; color: #333; padding-top: 4pt; }` / `table.totals tr.deposit--remaining td { font-weight: 700; color: #111; }` |
| MODERNA | `table.totals tr.deposit td { font-size: 10pt; color: {{brand.dark}}; }` / `table.totals tr.deposit--remaining td { font-weight: 700; }` |
| COMPACTA | `table.totals tr.deposit td { font-size: 8.5pt; color: #444; }` / `table.totals tr.deposit--remaining td { font-weight: 700; color: #222; }` |
| DETALLADA | `table.totals tr.deposit td { font-size: 10pt; color: #5b6577; }` / `table.totals tr.deposit--remaining td { font-weight: 700; color: #1a2230; }` |
| CORPORATIVA | `table.totals tr.deposit td { font-size: 10pt; color: {{brand.dark}}; }` / `table.totals tr.deposit--remaining td { font-weight: 700; }` |
| FORMULARIO | `table.totals tr.deposit td { font-size: 10pt; }` / `table.totals tr.deposit--remaining td { font-weight: 700; }` |

Example (CLASICA, after the edit):

```html
  <table class="totals">
    <tr><td>Subtotal (sin IVA)</td><td class="num">{{totals.base}}</td></tr>
    <tr><td>IVA</td><td class="num">{{totals.vat}}</td></tr>
    <tr class="total"><td>Total (IVA incl.)</td><td class="num">{{totals.total}}</td></tr>
    ${DEPOSIT_ROWS}
  </table>  {{#if has_conditions}}<div class="conditions"><h3>Condiciones</h3><p>{{conditions}}</p></div>{{/if}}
```

- [ ] **Step 5: Demo quote**

In `DEMO_QUOTE`, add after `customer: …`:

```js
  deposit: { pct: 0.4, min_amount: 264 }, // 659.90 × 0.4 = 263.96 → 264 (unpaid: the common case)
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/pdf-templates.test.js tests/cloud-pdf-templates.test.js tests/pdf-gallery.test.js`
Expected: PASS (the existing "no leftover mustaches" tests also cover the new `{{#if}}` blocks).

- [ ] **Step 7: Commit**

```bash
git add lib/pdf-templates.js tests/pdf-templates.test.js
git commit -m "feat(pdf): deposit rows + confirmation in the 6 built-in templates"
```

---

### Task 10: Step 3 — the "Señal" card replaces "Próximos pasos"

**Files:**
- Modify: `renderer/app.js` (imports ~line 64; `state` ~line 116; `selectPack` ~line 1475; `renderResult` ~lines 2115–2215; `copySummary` ~line 2425; `resetForm`/`backToSelection` ~line 2450; history `open` ~line 3580; `persistCurrentQuote` ~line 3834; `collectClientOrInvalid` ~line 3677)
- Modify: `renderer/styles.css` (remove `.next-steps*` ~lines 1174–1205; add `.deposit-card*`)

There are no DOM unit tests for `app.js`; the pure parts are covered by Tasks 3–4 and the flow is smoke-tested in Task 12. Keep each step's syntax check green.

- [ ] **Step 1: Import + state**

Add after the `planInputs` import:

```js
import {
  depositMinimum, parseDepositPct, parseDepositAmount, formatDepositPct, pctToPercentInput
} from './deposit.js';
```

Add to the `state` object after `editingQuoteToken`:

```js
  // Step-3 "Señal" card (design 2026-09-04 §5): the per-quote fraction
  // (null = config default) and the paid mark as typed ({ amount, edited }).
  deposit: { pct: null, paid: null },
  // The payment the stored quote on screen carries — diffed on save so
  // quotes:set-deposit runs only when the user changed it.
  depositStored: null,
```

Add these helpers right after the `state` object:

```js
/** The deposit fraction for the quote on screen: per-quote override, else config. */
function currentDepositPct() {
  if (Number.isFinite(state.deposit.pct)) return state.deposit.pct;
  return CFG.quote_settings.deposit_pct;
}

/** A fresh quote starts from the config percentage, unpaid. */
function resetDepositState() {
  state.deposit = { pct: null, paid: null };
  state.depositStored = null;
}

/** Total with VAT of a calc result OR a saved record (lastResult is both over its life). */
function totalVatIncOf(x) {
  if (!x) return 0;
  if (Number.isFinite(x.total_vat_inc)) return x.total_vat_inc;
  if (x.totals && Number.isFinite(x.totals.total_vat_inc)) return x.totals.total_vat_inc;
  if (x.result && Number.isFinite(x.result.total_vat_inc)) return x.result.total_vat_inc;
  return 0;
}
```

Call `resetDepositState();` as the first statement of `selectPack`, `resetForm` and `backToSelection` (after the existing `state.editingQuoteId = null;` lines).

- [ ] **Step 2: Replace the "Próximos pasos" card in `renderResult`**

Delete the whole `<article class="section-card">` that contains `<h3 class="h-card">Próximos pasos</h3>` (from its opening tag through its closing `</article>`), and put `${renderDepositCard(r)}` in its place. At the end of `renderResult` (after the `c.innerHTML = …;` statement) add `bindDepositCard(r);`.

- [ ] **Step 3: Add the card renderer, binder, collector and sync (after `renderResult`)**

```js
// ============================================================
// Step 3 · "Señal" card (design 2026-09-04 §5)
// ============================================================

function amountInputValue(n) {
  return Number.isFinite(n)
    ? n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
    : '';
}

function depositHintText(r, pct) {
  return `${formatDepositPct(pct)} de ${formatEur(totalVatIncOf(r))} · redondeado al euro hacia arriba`;
}

/**
 * Markup of the "Señal" card from `state.deposit`: the per-quote
 * percentage, the minimum it yields, and the paid mark with its amount.
 * bindDepositCard wires the inputs after the innerHTML swap.
 */
function renderDepositCard(r) {
  const pct = currentDepositPct();
  const total = totalVatIncOf(r);
  const min = depositMinimum(total, pct);
  const paid = state.deposit.paid;
  const stored = state.depositStored;
  const storedLine = stored
    ? `Señal recibida el ${formatValidDate(stored.at)}${stored.by ? ` por ${escapeHTML(stored.by)}` : ''}.`
    : 'Al guardar, el presupuesto pasará a Aceptado.';
  return `
      <article class="section-card deposit-card" id="deposit-card">
        <div class="section-card__head">
          <div>
            <h3 class="h-card">Señal</h3>
            <p class="text-secondary" style="font-size: 12px; margin-top: 2px;">Anticipo mínimo para lanzar el pedido.</p>
          </div>
          <span class="badge badge--neutral"><svg class="icon"><use href="#i-tag"/></svg> Anticipo</span>
        </div>
        <div class="field">
          <label class="field__label" for="deposit-pct">Porcentaje</label>
          <div class="deposit-card__pct">
            <input type="text" inputmode="decimal" id="deposit-pct" class="input" value="${pctToPercentInput(pct)}" autocomplete="off" aria-describedby="deposit-pct-error">
            <span class="text-muted">%</span>
          </div>
          <span id="deposit-pct-error" class="field__error hidden" role="alert">Indica un porcentaje entre 1 y 100.</span>
        </div>
        <div class="deposit-card__min">
          <span>Señal mínima</span>
          <strong class="text-mono" id="deposit-min">${formatEur(min)}</strong>
        </div>
        <p class="text-muted deposit-card__hint" id="deposit-hint">${depositHintText(r, pct)}</p>
        <label class="deposit-card__paid">
          <input type="checkbox" id="deposit-paid" ${paid ? 'checked' : ''}>
          <span>Señal pagada</span>
        </label>
        <div class="field ${paid ? '' : 'hidden'}" id="deposit-amount-field">
          <label class="field__label" for="deposit-amount">Importe recibido (€)</label>
          <input type="text" inputmode="decimal" id="deposit-amount" class="input" value="${amountInputValue(paid ? paid.amount : min)}" autocomplete="off" aria-describedby="deposit-amount-error">
          <span id="deposit-amount-error" class="field__error hidden" role="alert">Indica un importe mayor que cero.</span>
          <span class="text-muted" style="font-size: 12px;">${storedLine}</span>
        </div>
      </article>`;
}

/** Wires the card: live minimum on percentage input, paid toggle, amount. */
function bindDepositCard(r) {
  const pctInput = el('deposit-pct');
  const paidBox = el('deposit-paid');
  const amountInput = el('deposit-amount');
  if (!pctInput || !paidBox || !amountInput) return;
  const total = totalVatIncOf(r);

  pctInput.addEventListener('input', () => {
    const pct = parseDepositPct(pctInput.value);
    if (pct === null) { showFieldError('deposit-pct'); return; }
    clearFieldError('deposit-pct');
    state.deposit.pct = pct;
    const min = depositMinimum(total, pct);
    el('deposit-min').textContent = formatEur(min);
    el('deposit-hint').textContent = depositHintText(r, pct);
    // The paid amount follows the minimum until the user types their own.
    if (!state.deposit.paid || !state.deposit.paid.edited) {
      amountInput.value = amountInputValue(min);
      if (state.deposit.paid) state.deposit.paid = { amount: min, edited: false };
    }
  });

  paidBox.addEventListener('change', () => {
    const field = el('deposit-amount-field');
    if (paidBox.checked) {
      field.classList.remove('hidden');
      const typed = parseDepositAmount(amountInput.value);
      state.deposit.paid = { amount: typed ?? depositMinimum(total, currentDepositPct()), edited: false };
      amountInput.focus();
      amountInput.select();
    } else {
      field.classList.add('hidden');
      clearFieldError('deposit-amount');
      state.deposit.paid = null;
    }
  });

  amountInput.addEventListener('input', () => {
    const amount = parseDepositAmount(amountInput.value);
    if (amount === null) { showFieldError('deposit-amount'); return; }
    clearFieldError('deposit-amount');
    state.deposit.paid = { amount, edited: true };
  });
}

/**
 * Reads + validates the "Señal" card at save time (mirrors
 * collectClientOrInvalid). Returns { pct, min_amount, paid } with
 * paid = { amount } | null, or null when a field is invalid (inline error
 * shown, field focused).
 */
function collectDepositOrInvalid() {
  const total = totalVatIncOf(lastResult);
  const pctInput = el('deposit-pct');
  const paidBox = el('deposit-paid');
  const amountInput = el('deposit-amount');
  if (!pctInput || !paidBox || !amountInput) {
    // Card not on screen (defensive): config default, unpaid.
    const pct = CFG.quote_settings.deposit_pct;
    return { pct, min_amount: depositMinimum(total, pct), paid: null };
  }
  clearFieldError('deposit-pct');
  clearFieldError('deposit-amount');
  const pct = parseDepositPct(pctInput.value);
  if (pct === null) { showFieldError('deposit-pct'); pctInput.focus(); return null; }
  let paid = null;
  if (paidBox.checked) {
    const amount = parseDepositAmount(amountInput.value);
    if (amount === null) { showFieldError('deposit-amount'); amountInput.focus(); return null; }
    paid = { amount };
  }
  return { pct, min_amount: depositMinimum(total, pct), paid };
}

/**
 * Loads a stored quote's deposit into the card (reopen, or right after a
 * save): its per-quote percentage (else config) and its payment. Re-renders
 * the card so there is one markup source.
 */
function syncDepositCard(quote) {
  const deposit = quote && quote.deposit;
  const paid = quote && quote.deposit_paid;
  const hasPaid = Boolean(paid && Number.isFinite(paid.amount));
  state.deposit = {
    pct: deposit && Number.isFinite(deposit.pct) ? deposit.pct : null,
    paid: hasPaid ? { amount: paid.amount, edited: true } : null
  };
  state.depositStored = hasPaid ? { amount: paid.amount, at: paid.at, by: paid.by } : null;
  const card = el('deposit-card');
  if (!card) return;
  const r = quote.result || quote;
  card.outerHTML = renderDepositCard(r);
  bindDepositCard(r);
}
```

- [ ] **Step 4: Reopen flow**

In `onHistoryAction` (`action === 'open'`), add `syncDepositCard(quote);` immediately after **both** `syncClientCard(quote);` calls (editable branch and read-only branch).

- [ ] **Step 5: Persist flow**

In `persistCurrentQuote`, right after `const isEdit = …;` add:

```js
  const deposit = collectDepositOrInvalid();
  if (!deposit) return null; // inline error already shown
```

Add `deposit: { pct: deposit.pct, min_amount: deposit.min_amount }` to the `buildQuoteDraft` context (after `opt: lastOpt`).

Replace the final `return { quote: r.quote, queued };` with:

```js
  let saved = r.quote;
  // The paid mark is workflow (design §5 step 3): its own op AFTER the
  // content save, only when it changed, and only if the save reached the
  // backend (a queued save has no final id yet).
  const wanted = deposit.paid;                // { amount } | null
  const stored = saved.deposit_paid || null;  // what the backend holds now
  const changed = Boolean(wanted) !== Boolean(stored)
    || Boolean(wanted && stored && wanted.amount !== stored.amount);
  if (changed) {
    if (queued) {
      await window.packprice.showInfo({
        titulo: 'Señal pendiente',
        mensaje: 'La señal se podrá marcar desde el historial cuando el presupuesto se sincronice.'
      });
    } else {
      const d = await window.packprice.setQuoteDeposit({
        id: saved.id,
        paid: wanted ? { amount: wanted.amount } : null
      });
      if (d && d.ok && d.quote) {
        saved = d.quote;
      } else {
        await window.packprice.showError({
          titulo: 'No se pudo registrar la señal',
          mensaje: d && d.offline
            ? 'Sin conexión con el almacén de presupuestos. El presupuesto se guardó; marca la señal desde el historial cuando vuelva la conexión.'
            : ((d && d.error) || 'Error desconocido')
        });
      }
    }
  }
  syncDepositCard(saved);
  return { quote: saved, queued };
```

- [ ] **Step 6: Copy summary**

In `copySummary`, before `navigator.clipboard.writeText(...)`, add:

```js
  const pct = currentDepositPct();
  const min = depositMinimum(totalVatIncOf(r), pct);
  if (min > 0) lines.push(`Señal mínima (${formatDepositPct(pct)}): ${formatEur(min)}`);
  if (state.depositStored) {
    lines.push(`Señal recibida: ${formatEur(state.depositStored.amount)} (${formatValidDate(state.depositStored.at)})`);
  }
```

- [ ] **Step 7: CSS**

In `renderer/styles.css`, delete the `/* Próximos pasos */` block (`.next-steps`, `.next-steps__item`, `.next-steps__item:hover`, `.next-steps__icon`, `.next-steps__body*`) and add in its place:

```css
/* Señal (paso 3 · design 2026-09-04 §5) */
.deposit-card { gap: 12px; }
.deposit-card__pct { display: flex; align-items: center; gap: 8px; }
.deposit-card__pct .input { width: 96px; }
.deposit-card__min {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-tertiary);
}
.deposit-card__min strong { font-size: 22px; }
.deposit-card__hint { font-size: 12px; }
.deposit-card__paid {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  cursor: pointer;
}
```

- [ ] **Step 8: Syntax check + grep for leftovers**

Run: `node --input-type=module --check < renderer/app.js && grep -n "next-steps\|Próximos pasos\|WhatsApp" renderer/app.js renderer/styles.css renderer/index.html`
Expected: syntax OK; the grep prints nothing.

- [ ] **Step 9: Commit**

```bash
git add renderer/app.js renderer/styles.css
git commit -m "feat(ui): step-3 \"Señal\" card replaces \"Próximos pasos\""
```

---

### Task 11: History — deposit chip + inline "Marcar señal"

**Files:**
- Modify: `renderer/history.js` (new `renderDepositCell`, `renderDepositForm`; `renderHistoryList` row + header)
- Modify: `renderer/app.js` (`onHistoryAction` ~line 3536: two new actions + three helpers)
- Modify: `renderer/styles.css` (`.quote-chip--deposit`, `.deposit-form*`)
- Test: `tests/history-render.test.js` (new — `tests/history.test.js` already covers the legacy `lib/history.js`)

- [ ] **Step 1: Write the failing tests**

Create `tests/history-render.test.js`:

```js
// ============================================================
// History list rendering (renderer/history.js) — deposit column
// ============================================================
// Pure markup helpers behind the history modal: the deposit ("señal")
// cell (chip when paid / "Marcar señal" button / disabled for a
// pending id) and the inline amount form. No DOM, no IPC.
// ============================================================
import { describe, test, expect } from 'vitest';
import { renderHistoryList, renderDepositCell, renderDepositForm } from '../renderer/history.js';

const BASE = {
  id: 'PP-2026-0001', date: '2026-09-01T10:00:00.000Z', user: 'Ana',
  customer: { name: 'Peña' }, pack_id: 'crew', total_vat_inc: 300, status: 'pending'
};
const AT = '2026-09-04T10:00:00.000Z';

describe('renderDepositCell', () => {
  test('unpaid: a "Marcar señal" button carrying the row id', () => {
    const html = renderDepositCell(BASE);
    expect(html).toContain('data-action="deposit-mark"');
    expect(html).toContain('data-id="PP-2026-0001"');
    expect(html).toContain('Marcar señal');
    expect(html).not.toContain('disabled');
  });

  test('paid: a success chip with the amount; date + user in the title; clears on click', () => {
    const html = renderDepositCell({ ...BASE, status: 'accepted', deposit_paid: { amount: 121.5, at: AT, by: 'Mostrador' } });
    expect(html).toContain('quote-chip--deposit');
    expect(html).toContain('Señal · 121,50 €');
    expect(html).toContain('data-action="deposit-clear"');
    expect(html).toContain('04/09/2026');
    expect(html).toContain('por Mostrador');
  });

  test('pending (PP-PENDING-…): the button is disabled with the sync reason', () => {
    const html = renderDepositCell({ ...BASE, id: 'PP-PENDING-abc' });
    expect(html).toContain('disabled');
    expect(html).toMatch(/sincronice/);
  });

  test('escapes the user name (XSS)', () => {
    const html = renderDepositCell({ ...BASE, deposit_paid: { amount: 1, at: AT, by: '<img onerror=x>' } });
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;img');
  });
});

describe('renderDepositForm', () => {
  test('prefills the amount with two decimals and a comma, with confirm + cancel controls', () => {
    const html = renderDepositForm('PP-2026-0001', 494);
    expect(html).toContain('value="494,00"');
    expect(html).toContain('data-deposit-form="PP-2026-0001"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-deposit-cancel');
  });
});

describe('renderHistoryList — deposit column', () => {
  test('adds a "Señal" header and one deposit cell per row', () => {
    const html = renderHistoryList([
      BASE,
      { ...BASE, id: 'PP-2026-0002', deposit_paid: { amount: 50, at: AT, by: null } }
    ]);
    expect(html).toContain('<th>Señal</th>');
    expect((html.match(/data-action="deposit-mark"/g) || []).length).toBe(1);
    expect((html.match(/data-action="deposit-clear"/g) || []).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/history-render.test.js`
Expected: FAIL — `renderDepositCell` is not exported.

- [ ] **Step 3: Implement in `renderer/history.js`**

Add after `renderStatusChips`:

```js
/**
 * The deposit ("señal") cell of a history row (design 2026-09-04 §6): a
 * success chip with the amount when paid (click → clear), else a "Marcar
 * señal" button (click → inline amount form). A pending (PP-PENDING-…)
 * row gets the button disabled — its id is provisional until it syncs.
 */
export function renderDepositCell(quote) {
  const paid = quote.deposit_paid;
  if (paid && typeof paid.amount === 'number') {
    const when = paid.at ? formatDate(paid.at).slice(0, 10) : '';
    const title = `Recibida${when ? ' el ' + when : ''}${paid.by ? ' por ' + paid.by : ''} · clic para quitar`;
    return `<button type="button" class="quote-chip quote-chip--deposit is-active" data-action="deposit-clear" data-id="${esc(quote.id)}" title="${esc(title)}">Señal · ${esc(formatEur(paid.amount))}</button>`;
  }
  const pending = typeof quote.id === 'string' && quote.id.startsWith('PP-PENDING-');
  const attrs = pending
    ? 'disabled title="Pendiente de subir: marca la señal cuando se sincronice"'
    : 'title="Registrar la señal recibida"';
  return `<button type="button" class="btn btn-ghost btn-sm" data-action="deposit-mark" data-id="${esc(quote.id)}" ${attrs}>Marcar señal</button>`;
}

/**
 * The inline amount form that replaces the deposit cell while marking —
 * no modal, a counter click (UI-UX §2.7). `defaultAmount` is prefilled.
 */
export function renderDepositForm(quoteId, defaultAmount) {
  const value = typeof defaultAmount === 'number'
    ? defaultAmount.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
    : '';
  return `
    <form class="deposit-form" data-deposit-form="${esc(quoteId)}">
      <input type="text" inputmode="decimal" class="input deposit-form__amount" value="${esc(value)}" aria-label="Importe de la señal (€)" autocomplete="off">
      <span class="text-muted">€</span>
      <button type="submit" class="btn btn-primary btn-sm" title="Confirmar"><svg class="icon"><use href="#i-check"/></svg></button>
      <button type="button" class="btn btn-ghost btn-sm" data-deposit-cancel title="Cancelar"><svg class="icon"><use href="#i-x"/></svg></button>
    </form>`;
}
```

In `renderHistoryList`, add `<td>${renderDepositCell(q)}</td>` right after `<td>${renderStatusChips(q)}</td>`, and `<th>Señal</th>` right after `<th>Estado</th>`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/history-render.test.js tests/history-draft.test.js`
Expected: PASS.

- [ ] **Step 5: Orchestration in `renderer/app.js`**

Add `renderDepositCell` is not needed in app.js; import the form: extend the `./history.js` import to `{ renderHistoryList, buildQuoteDraft, renderDepositForm }`.

In `onHistoryAction`, before `if (action === 'delete')`:

```js
  if (action === 'deposit-mark') { await startDepositMark(id); return; }
  if (action === 'deposit-clear') { await clearQuoteDeposit(id); return; }
```

Add after `applyQuoteStatus`:

```js
// ============================================================
// History deposit actions (design 2026-09-04 §6)
// ============================================================

/**
 * Writes a deposit mark through the shared store; surfaces failures with
 * the same dialogs as the status chips. Returns true on success.
 */
async function applyQuoteDeposit(localId, paid) {
  const d = await window.packprice.setQuoteDeposit({ id: localId, paid });
  if (d && d.ok) return true;
  await window.packprice.showError({
    titulo: 'No se pudo registrar la señal',
    mensaje: d && d.offline
      ? 'Sin conexión con el almacén de presupuestos. Inténtalo cuando vuelva la conexión.'
      : ((d && d.error) || 'Error desconocido')
  });
  return false;
}

/**
 * "Marcar señal": swaps the cell for the inline amount form, prefilled
 * with the quote's stored minimum (or the config percentage for a quote
 * saved before the feature), then writes through quotes:set-deposit with
 * undo in the toast.
 */
async function startDepositMark(localId) {
  const body = el('history-body');
  const btn = body && body.querySelector(`[data-action="deposit-mark"][data-id="${CSS.escape(localId)}"]`);
  if (!btn) return;
  const cell = btn.closest('td');
  const r = await window.packprice.getQuote(localId);
  const quote = r && r.ok ? r.quote : null;
  if (!quote) return;
  const defaultAmount = quote.deposit && Number.isFinite(quote.deposit.min_amount)
    ? quote.deposit.min_amount
    : depositMinimum(totalVatIncOf(quote), CFG.quote_settings.deposit_pct);

  cell.innerHTML = renderDepositForm(localId, defaultAmount);
  const form = cell.querySelector('form');
  const input = form.querySelector('.deposit-form__amount');
  input.focus();
  input.select();
  form.querySelector('[data-deposit-cancel]').addEventListener('click', () => refreshHistory());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseDepositAmount(input.value);
    if (amount === null) { input.classList.add('input--error'); input.focus(); return; }
    const ok = await applyQuoteDeposit(localId, { amount });
    await refreshHistory();
    if (!ok) return;
    showStatusToast(`Señal registrada · ${formatEur(amount)}`, async () => {
      await applyQuoteDeposit(localId, null);
      await refreshHistory();
    });
  });
}

/** Clicking the paid chip: confirm, clear (→ Pendiente); undo re-marks the same amount. */
async function clearQuoteDeposit(localId) {
  const r = await window.packprice.getQuote(localId);
  const quote = r && r.ok ? r.quote : null;
  if (!quote || !quote.deposit_paid) return;
  const prevAmount = quote.deposit_paid.amount;
  const choice = await window.packprice.confirm({
    titulo: 'Quitar señal',
    mensaje: `¿Quitar la señal de ${formatEur(prevAmount)} del presupuesto ${localId}?`,
    detalle: 'El presupuesto volverá a Pendiente.',
    botones: ['Quitar', 'Cancelar'],
    defaultId: 1
  });
  if (choice !== 0) return;
  const ok = await applyQuoteDeposit(localId, null);
  await refreshHistory();
  if (!ok) return;
  showStatusToast('Señal eliminada', async () => {
    await applyQuoteDeposit(localId, { amount: prevAmount });
    await refreshHistory();
  });
}
```

- [ ] **Step 6: CSS**

Append after the `.quote-chip--rejected.is-active` rule in `renderer/styles.css`:

```css
.quote-chip--deposit.is-active {
  background: var(--success-soft); color: var(--success); border-color: var(--success);
}

/* Inline "Marcar señal" form in the history row (§2.7 — no modal) */
.deposit-form { display: inline-flex; align-items: center; gap: 6px; }
.deposit-form__amount { width: 96px; }
```

- [ ] **Step 7: Syntax check + suite**

Run: `node --input-type=module --check < renderer/app.js && pnpm test`
Expected: syntax OK; suite PASS.

- [ ] **Step 8: Commit**

```bash
git add renderer/history.js renderer/app.js renderer/styles.css tests/history-render.test.js
git commit -m "feat(ui): history deposit chip + inline \"Marcar señal\""
```

---

### Task 12: Documentation + smoke

**Files:**
- Modify: `CLAUDE.md` (§5 renderer list ~line 134; §8 smoke checklist ~line 200; §10 "Saved quote" ~line 280)
- Modify: `ARCHITECTURE.md` (repository table ~line 254; record shape ~line 265; §4.3b conflict bullet ~line 346; §6 shape ~line 580)
- Modify: `docs/UI-UX.md` (§1.4 flow ~line 59; §2.7 history paragraph ~line 373)
- Modify: `docs/superpowers/specs/2026-09-04-quote-deposit-design.md` (status line)

- [ ] **Step 1: CLAUDE.md**

§5: change `history.js/quote-inputs.js/` … `quote-reminder.js (quotes)` to `history.js/quote-inputs.js/quote-reminder.js/deposit.js (quotes)`.

§8 smoke checklist: append `; señal: cambiar el porcentaje en el paso 3, marcar pagada, guardar → historial en Aceptado con chip, PDF con las tres filas; quitar desde el historial → Pendiente → deshacer`.

§10, at the end of the "Saved quote / reopen-to-edit" bullet, add:

```
  **Deposit (señal):** `deposit = { pct, min_amount }` is content (the
  minimum, `ceil(total_vat_inc × pct)` in whole euros, computed only in
  `renderer/deposit.js`; `pct` defaults to `quote_settings.deposit_pct`);
  `deposit_paid = { amount, at, by } | null` is workflow, written only by
  `quotes:set-deposit` → `setDepositPaid` (file JSON / D1 `quote_deposits`),
  which also sets `status` accepted (paid) or pending (cleared) without
  bumping `version`. Edits preserve it like `status`. Design:
  `docs/superpowers/specs/2026-09-04-quote-deposit-design.md`.
```

- [ ] **Step 2: ARCHITECTURE.md**

Repository table row "Saved quotes (shared)": change the verbs to `` `create` / `get` / `list` / `search` / `replace` / `setStatus` / `setDepositPaid` / `delete` ``.

Record shape: add after `status_ts,`:

```js
  deposit: { pct, min_amount },   // content: minimum deposit for this quote (renderer/deposit.js)
  deposit_paid: { amount, at, by }, // workflow: paid deposit; null/absent = unpaid (set only by setDepositPaid)
```

§4.3b conflict bullet: change `so `setStatus` does **not** bump the version.` to `so `setStatus` and `setDepositPaid` (which also flips the status) do **not** bump the version. In cloud mode the payment lives in the additive `quote_deposits` table (0003) and is LEFT-JOINed onto the flat row on read.`

§6 shape line: change `quote_settings: { validity_days, terms }` to `quote_settings: { validity_days, terms, deposit_pct }`.

- [ ] **Step 3: docs/UI-UX.md**

§1.4: change `Resultado (precio grande, desglose, margen, PDF, guardar en historial)` to `Resultado (precio grande, señal mínima + pago, desglose, margen, PDF, guardar en historial)`.

§2.7, after the "**Datos del pedido (cambio asociado)**" paragraph, add:

```
**Señal (cambio asociado):** el paso 3 muestra una tarjeta «Señal» en el
hueco del antiguo «Próximos pasos»: porcentaje (por defecto el de config,
editable solo para ese pedido), señal mínima (redondeada al euro hacia
arriba) y casilla «Señal pagada» con el importe recibido. Al guardar con la
señal pagada el presupuesto pasa a **Aceptado**; quitarla lo devuelve a
Pendiente. En el historial, cada fila añade un chip verde «Señal · Y €» (clic
→ confirmar y quitar) o un botón «Marcar señal» que abre un mini formulario en
la propia fila (importe prefijado, sin modal) — ambos con deshacer en el
toast. El PDF imprime la señal mínima bajo el total y, si está pagada, la
recibida y el resto pendiente. Sin conexión (nube) la marca no se encola: se
avisa y se repite desde el historial.
```

- [ ] **Step 4: Spec status**

In the spec header change `**Status:** Design approved by the owner; implementation plan pending.` to `**Status:** Implemented (plan `docs/superpowers/plans/2026-09-04-quote-deposit.md`).`

- [ ] **Step 5: Full suite + smoke**

Run: `pnpm test`
Expected: PASS, all files.

Smoke (`pnpm dev`, file mode with a scratch config, then cloud if available):
1. Delete `%APPDATA%\Quanto\` → wizard → step 3 shows the "Señal" card with 40 % and the rounded-up minimum; no "Próximos pasos"/WhatsApp.
2. Change the percentage to 50 → minimum updates instantly; type `abc` → inline error.
3. Tick "Señal pagada" (amount prefilled) → Guardar → history shows the chip and **Aceptado**; reopen → card shows "Señal recibida el … por …".
4. Exportar PDF → rows "Señal mínima (50 %)", "Señal recibida (…)", "Resto pendiente"; the confirmation says "presupuesto aceptado".
5. History: click the chip → Quitar → Pendiente; toast Deshacer → chip back. "Marcar señal" on an unpaid quote → inline form → confirm → chip + Aceptado.
6. Copiar resumen → the pasted text ends with the "Señal mínima …" line.
7. Cloud mode (if a test database is available): the same, plus turning the network off before "Marcar señal" shows the offline notice and nothing changes.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md docs/UI-UX.md docs/superpowers/specs/2026-09-04-quote-deposit-design.md
git commit -m "docs: quote deposit (señal) in CLAUDE/ARCHITECTURE/UI-UX"
```

---

## Self-review notes

- **Spec coverage:** §3.1 → Tasks 1–2; §3.2 → Tasks 3–5, 7; §3.3 → Task 6; §4.1 → Tasks 5–7; §4.2 → Task 8; §5 → Task 10; §6 → Task 11; §7 → Task 9; §8 error handling → Tasks 5–8, 10–11 (dialogs); §9 tests → each task; §10 docs → Task 12.
- **Names used consistently:** `applyQuoteSettingsDefaults`, `DEFAULT_DEPOSIT_PCT`, `normalizeDepositPaid`, `withoutDepositPaid`, `setDepositPaid(id, paid, { now })` (file/cloud façades), `setQuoteDeposit(client, { id, paid, now })` (data layer), `depositFromRow`, `quotes:set-deposit` / `setQuoteDeposit({ id, paid })` (IPC), `renderDepositCard` / `bindDepositCard` / `collectDepositOrInvalid` / `syncDepositCard` / `currentDepositPct` / `resetDepositState` / `totalVatIncOf` (app.js), `renderDepositCell` / `renderDepositForm` (history.js), `depositMinimum` / `depositRemaining` / `parseDepositPct` / `parseDepositAmount` / `formatDepositPct` / `pctToPercentInput` (deposit.js).
- **Out of scope, on purpose:** stats KPI, outbox queuing of the mark, payment method, admin/wizard editor for `deposit_pct`.
- **XSS discipline (renderer):** the card, the history cell and the inline form are built as HTML strings, the way every other renderer view in this repo is (no sanitizer dependency — hard rule §2.9). Every interpolated value is either a number the code produced (`pctToPercentInput`, `amountInputValue`, `formatEur`) or a user string passed through `escapeHTML` (app.js) / `esc` (history.js): `stored.by`, `paid.by`, `quote.id`, the form's `value`. Keep that invariant when touching them; the `tests/history-render.test.js` XSS case guards the history side.
