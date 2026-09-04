# Quote Deposit (señal) — Design

**Date:** 2026-09-04
**Status:** Design approved by the owner; implementation plan pending.
**Plan:** `docs/superpowers/plans/2026-09-04-quote-deposit.md` (to be written)

---

## 1. Summary

The workshop asks every customer for a **minimum deposit ("señal") of 40 % of
the quote total** before launching an order. Today the app has no notion of it:
the counter computes the figure by hand, the paid deposit is not recorded
anywhere, and the quote PDF says nothing about it.

This design adds the deposit to the quote in three places:

1. **Step 3 (result screen).** The unimplemented "Próximos pasos" card
   (including its disabled "Enviar al cliente · Por email o WhatsApp" button)
   is removed; its slot next to the dark total card becomes a **"Señal" card**
   that shows the minimum deposit, lets the user adjust the percentage *for
   this quote only*, and lets them mark the deposit as **paid** with the amount
   actually received (sometimes slightly less or more than the minimum).
2. **Quote record + history.** The minimum travels with the quote as content;
   the payment is a **workflow fact** (like `status`) that can also be set from
   the history list without reopening the quote. Marking the deposit paid sets
   the quote to **Aceptado**; clearing it returns it to **Pendiente**.
3. **PDF.** Every built-in template prints the minimum deposit under the total
   and, when paid, the amount received, its date and the remaining balance.

### Decisions (confirmed with the owner)

| Question | Decision |
|---|---|
| Where can the deposit be marked paid? | Step 3 **and** the history list (customers usually pay days later). |
| Base and rounding of the minimum | 40 % of the **total with VAT**, rounded **up to the whole euro** (it is a minimum, so never below 40 %). |
| Is the percentage configurable? | The default lives in config (`quote_settings.deposit_pct`, 0.40). In step 3 it can be changed **per quote**; the minimum recomputes instantly. No admin/wizard editor. |
| Status coupling | Paid → `accepted` automatically. Clearing the payment → `pending`. The status chips stay free: marking `rejected` with a paid deposit is allowed (cancellation with retained deposit) and the deposit stays recorded. |
| What the PDF shows | Minimum deposit always (for quotes that carry it); when paid, also the amount received, its date and the remaining balance. |
| What is stored about the payment | Amount, automatic timestamp, and the team user name who marked it. No payment method. |
| History list | A green chip "Señal · Y €" when paid; otherwise a "Marcar señal" button with an inline amount form (no modal). Both with undo via the existing toast. |
| Step 3 layout | The whole "Próximos pasos" card goes away (it is a future feature); the "Señal" card takes its place. |

Out of scope (explicitly): a deposits KPI in Estadísticas; queuing the payment
mark in the offline outbox; a payment-method field; an admin/wizard editor for
the default percentage.

---

## 2. Approaches considered

**A. Payment as a workflow operation, like status (chosen).** The deposit has
two halves. The *minimum* (percentage + euros) is quote **content**: it is part
of the draft and is saved with the quote. The *payment* is **workflow**: a
dedicated operation that never bumps the content `version`, is preserved by
edits (in file mode it still moves the content-hash token, like a status
change), and in cloud mode lives in its own additive table next to the flat
status row. One operation writes the payment and flips the status. Cost: one
additive SQL migration, one new repository operation in both backends, one IPC
channel.

**B. Everything inside the quote content.** Marking the payment from the
history would be "reopen, patch, replace" with a version bump. Less backend
code, but every counter click could collide with an editor open on another PC
("Otro equipo cambió este presupuesto"), and the status flip would still need
its own write. Two writes and a worse experience. Rejected.

**C. A new status such as `accepted_paid`.** Breaks the `CHECK` constraint on
`quotes.status` (not additive), the stats and the chips. Rejected.

---

## 3. Data model

### 3.1 Config (shared catalog)

New optional key, next to validity and terms:

```js
quote_settings: {
  validity_days: 30,
  terms: '…',
  deposit_pct: 0.4      // fraction, 0–1; default minimum deposit
}
```

- `config.default.js` gains `DEFAULT_DEPOSIT_PCT = 0.4` (next to
  `DEFAULT_TARGET_MARGIN`), includes `deposit_pct` in `buildEmptyConfig()`, and
  exports a pure `applyQuoteSettingsDefaults(cfg)` that returns **the same
  reference** when `quote_settings.deposit_pct` is already a finite number and
  otherwise a shallow copy with it filled from `DEFAULT_DEPOSIT_PCT` (creating
  `quote_settings` when the whole object is absent). It fills
  **only** `deposit_pct` — filling `terms`/`validity_days` would change the
  PDFs of existing catalogs that left them undefined on purpose.
- The default is applied **in memory** at the two hand-off points to the
  renderer, never by rewriting files on boot: `main.js` `config:read` (file
  mode, after `readAndMigrateConfig` + `validateConfigSchema`) and
  `lib/cloud-bootstrap.js` `toValidatedConfig` (cloud mode, after `assemble`).
  It is persisted naturally on the next admin save (file: whole config;
  cloud: the next save that really edits the `company`/`quote_settings`
  entity — the save diff is computed against a defaulted baseline, so a
  legacy catalog never reports a phantom change). This keeps the "a v4
  config is returned untouched" invariant of `lib/migrations.js` and
  avoids a mass rewrite of every customer's `config.js`.
- `lib/config-schema.js` `validateQuoteSettings`: `deposit_pct`, when defined,
  must be a finite number in `[0, 1]` (Spanish error otherwise).
- The renderer reads `CFG.quote_settings.deposit_pct` and **never hardcodes a
  fallback** (hard rule §2.2); main guarantees the key.

### 3.2 Quote record

Two new fields on the canonical saved-quote record (`ARCHITECTURE.md` §4.3b):

```js
{
  …,
  deposit: {              // CONTENT — written by the draft on create/edit
    pct: 0.4,             //   fraction used for this quote (config default or per-quote override)
    min_amount: 494       //   whole euros: ceil(round2(totals.total_vat_inc × pct))
  },
  deposit_paid: {         // WORKFLOW — written only by quotes:set-deposit; null/absent = not paid
    amount: 500,          //   euros received, 2 decimals, > 0
    at: '2026-09-04T…Z',  //   ISO timestamp stamped by main
    by: 'Mostrador'       //   settings.user_name at the time (null when blank)
  },
  status,                 // set to 'accepted' / 'pending' by the deposit op (§4.1);
  status_ts               //   the history chips may still change it afterwards (§1)
}
```

Rules:

- `deposit` is built by `buildQuoteDraft` (`renderer/history.js`) from the
  step-3 card and is replaced on every edit, like `totals` — so a re-edited
  order recomputes the minimum from the new total with the same per-quote
  percentage. Quotes saved before this feature have no `deposit` until they
  are edited and saved again; they still allow "Marcar señal" (the renderer
  computes the default amount from the config percentage at that moment).
- `deposit_paid` is **never taken from the draft**. `replaceQuote` in both
  backends pins it from the stored record exactly as it pins `status` /
  `status_ts` today (absent stays absent). `createQuote` ignores any
  `deposit_paid` in a draft (the façade strips it).
- The minimum formula lives in **one** pure renderer module,
  `renderer/deposit.js` (ESM, DOM-free, tested):
  - `depositMinimum(totalVatInc, pct)` → `Math.ceil(round2(total × pct))`,
    `0` when either input is not a positive finite number. Rounding to cents
    first avoids `400.00000000000006 → 401`.
  - `depositRemaining(totalVatInc, paidAmount)` → `max(0, round2(total − paid))`.
  - `parseDepositPct(text)` → fraction or `null` (accepts `0`–`100` (0 % = no
    minimum deposit); decimals allowed, comma or dot; Spanish grouping dots
    are stripped when a comma marks the decimals, an ambiguous dot-group such
    as `1.234` is rejected).
  - `parseDepositAmount(text)` → euros rounded to cents or `null` (must be
    `> 0`).
  The PDF context (`lib/pdf-templates.js`) does **not** recompute the minimum:
  it prints `quote.deposit.min_amount` and derives only the remaining balance
  (a subtraction, tested).

### 3.3 Cloud schema (additive)

`db/migrations/0003_quote_deposits.sql`:

```sql
-- 0003_quote_deposits.sql — the paid-deposit workflow fact, separate from the
-- payload (never versioned) and from the flat `quotes` row (SQLite ALTER has
-- no IF NOT EXISTS guard — see 0002). Absent row = not paid.
CREATE TABLE IF NOT EXISTS quote_deposits (
  quote_id TEXT PRIMARY KEY REFERENCES quotes(id),
  amount   REAL NOT NULL,
  paid_at  TEXT NOT NULL,
  paid_by  TEXT
);
```

File mode needs no schema change: the two fields are keys in `<id>.json`.

---

## 4. Backends and IPC

### 4.1 Repository operation (both backends, same contract)

`setDepositPaid(id, paid, { now })` where `paid` is `{ amount, at, by }` or
`null`:

- Validates `amount` (finite, `> 0`) before any IO; throws a Spanish error
  otherwise. A shape-invalid id is treated as unknown (`null`), mirroring
  `setStatus`.
- Writes `deposit_paid` **and** `status = paid ? 'accepted' : 'pending'` with
  `status_ts = now`. It is the **only** writer of `deposit_paid`.
- Does **not** bump `version` (workflow, not content — same rule as
  `setStatus`). Cloud mode: the version token of an open editor stays valid.
  File mode: the token is a content hash, so a deposit write from another PC
  makes that editor's next save show the standard (spurious but safe)
  conflict dialog; Sobrescribir keeps the pinned `deposit_paid`. To keep the
  SAME PC's editor consistent, `quotes:set-deposit` returns a fresh token
  (see §4.2).
- Returns the updated full quote, or `null` for an unknown id (the same
  `updated | null` contract as `setStatus`).
- `createQuote` and `replaceQuote` in **both** backends drop any
  `deposit_paid` carried by a draft: create never writes it; replace pins it
  from the stored record (absent stays absent), exactly like `status`.

**File (`lib/quote-repo-file.js`).** Read `<id>.json`, set/delete
`deposit_paid`, set `status`/`status_ts`, atomic `.tmp` + rename. `replaceQuote`
adds `deposit_paid: existing.deposit_paid` to its pinned fields (deleted when
undefined). `listQuotes` already returns full records, so list rows carry
`deposit_paid` for free.

**Cloud (`lib/quote-repo-cloud.js` + `lib/cloud-quotes.js`).**
- `setQuoteDeposit(client, { id, paid, now })` in `cloud-quotes.js`:
  1. `UPDATE quotes SET status = ?, status_ts = ? WHERE id = ?` — `changes 0`
     ⇒ unknown id ⇒ return `null` with nothing else written.
  2. `paid` ⇒ SQLite upsert `INSERT INTO quote_deposits … ON CONFLICT(quote_id)
     DO UPDATE SET amount = excluded.amount, paid_at = …, paid_by = …`;
     `null` ⇒ `DELETE FROM quote_deposits WHERE quote_id = ?`.
  3. The façade re-fetches with `getFullQuote` and returns it.
  Residual non-atomicity (no Worker, no transaction — same class as
  `updateFullQuote`): if step 2 throws after step 1, the status is flipped
  without the deposit row; the error propagates to the user (hard rule §2.4)
  and a retry repeats both steps. Documented in the module header.
- `getFullQuote` overlays `deposit_paid` from a `LEFT JOIN quote_deposits` in
  the existing flat-row SELECT (one query, no extra round-trip). The overlay
  **always** sets `deposit_paid` — the object when a row exists, `null`
  otherwise — so a stale copy inside the payload JSON can never win (same
  precedent as `status`). The renderer treats `null` and absent alike.
- `listFullQuotes` adds the same `LEFT JOIN`; the façade's list row gains
  `deposit_paid: { amount, at } | null`.
- `deleteFullQuote` also deletes from `quote_deposits`.
- `replaceQuote` pins `deposit_paid: existing.deposit_paid` like `status`.

### 4.2 IPC

- New channel `quotes:set-deposit`, preload method
  `setQuoteDeposit({ id, paid })` where `paid` is `{ amount }` or `null`.
- `main.js` handler: validates the shape, stamps `at = new Date().toISOString()`
  and `by` = the cloud user name when set, else `settings.user_name`, else
  `null` (the same resolution order as `cloudAuthor`, without its `'Equipo'`
  fallback), calls `quoteRepo(settings)
  .setDepositPaid(id, paid, { now })`, upserts the cache with the returned
  quote, logs `quote deposit updated { id, paid: bool }`. Returns
  `{ ok: true, quote, token }` (token re-read with `getQuote` after the
  write, so the renderer can refresh `state.editingQuoteToken` when it is
  editing that quote); unknown id ⇒ `{ ok: false, error: 'No se encontró el
  presupuesto <id>.' }`; backend unreachable ⇒ `{ ok: false, offline: true,
  error }` (no outbox — the renderer shows the standard offline notice, never
  a silent loss). Any other error ⇒ `{ ok: false, error }` + log. A
  provisional `PP-PENDING-…` id ⇒ `{ ok: false, pending: true, error }` (the
  create is still queued; the renderer shows the message). If the post-write
  token re-read fails, the reply is still `ok: true` with `token: null` (the
  renderer's next edit-save forces), and the failure is logged.
- `quotes:update` (status chips) is unchanged.

---

## 5. Step 3 — the "Señal" card

Rendered by `renderResult` in the slot of the removed "Próximos pasos" card
(`.resultado-grid`, next to `.result-hero`). The "Nuevo cálculo" shortcut goes
with the card; the existing "Cambiar pack" button it delegated to remains.

```
+-----------------------------------+
| SEÑAL                    [badge]  |
| Porcentaje    [ 40 ] %            |
| Señal mínima             494 €    |
| 40 % de 1.234,56 € · redondeado   |
| al euro hacia arriba              |
| [x] Señal pagada                  |
|     Importe recibido [ 494,00 ] € |
|     Al guardar pasará a Aceptado. |
+-----------------------------------+
```

Behaviour:

- **Percentage** input: prefilled from `quote.deposit.pct` (reopened quote) or
  `CFG.quote_settings.deposit_pct` (new quote), shown as a percent. Editing it
  recomputes the minimum on `input`, for **this quote only** (stored in
  `quote.deposit.pct`). Inline error (same `.field__error` pattern as the
  client card) when outside `0`–`100`.
- **Minimum** = `depositMinimum(r.total_vat_inc, pct)`, mono, whole euros.
- **"Señal pagada" checkbox** reveals the amount input, prefilled with the
  minimum, editable (2 decimals, `> 0`; inline error otherwise). A reopened
  paid quote shows it checked with the stored amount and a line "Señal
  recibida el dd/mm/aaaa por <usuario>". Unchecking and saving clears the
  payment (status back to Pendiente).
- **State** lives in `state.deposit = { pct, paid: { amount } | null }`, read
  by `collectDepositOrInvalid()` at save time (mirrors
  `collectClientOrInvalid`). "Limpiar", "Cambiar pack" and a new calculation
  reset `pct` to the config default and `paid` to `null`. Reopening a quote
  runs `syncDepositCard(quote)` right after `syncClientCard(quote)`.
- **Persistence** (in `persistCurrentQuote`, both for "Guardar presupuesto"
  and for the implicit save of "Exportar PDF"):
  1. `draft.deposit = { pct, min_amount }` is added to the content draft.
  2. Content is saved as today (create / replace with conflict handling).
  3. If the save was **not queued** and the card's paid state differs from the
     stored `deposit_paid` (checked ↔ absent, or a different amount), call
     `setQuoteDeposit`. On `ok`, the returned quote becomes `lastResult` (so
     the PDF exported right after prints the payment). On failure, show
     "No se pudo registrar la señal" with the backend message (offline notice
     when `offline: true`); the content save stands — nothing is lost, the
     mark can be redone from the history.
  4. If the save **was queued** (cloud, offline) and the paid state changed,
     show, after the existing "se sincronizará al reconectar" notice: "La
     señal se podrá marcar desde el historial cuando el presupuesto se
     sincronice." (the payment is not queued — explicit, never silent).
- **Copiar resumen** gains `Señal mínima (40 %): 494 €` and, when paid,
  `Señal recibida: 500,00 € (dd/mm/aaaa)`.

---

## 6. History list

New column after the status chips (`renderer/history.js`, pure render):

- Paid ⇒ chip `Señal · 500,00 €` (success tone, `title` = "Recibida el
  dd/mm/aaaa por <usuario>"), `data-action="deposit-clear"`.
- Not paid ⇒ ghost button `Marcar señal`, `data-action="deposit-mark"`.
- Pending (`PP-PENDING-…`) rows render the button disabled with the same
  "pendiente de subir" reason used for PDF export.

Orchestration (`renderer/app.js`):

- **Mark:** the cell swaps to an inline form `[ 494,00 ] € [✓] [✕]` (no
  modal — a cold counter click, as in UI-UX §2.7). The default amount is
  `quote.deposit.min_amount` from `getQuote(id)`, or, for a legacy quote
  without `deposit`, `depositMinimum(quote.totals.total_vat_inc,
  CFG.quote_settings.deposit_pct)`.
  Confirm ⇒ `setQuoteDeposit({ id, paid: { amount } })` ⇒ `refreshHistory()`
  ⇒ toast "Señal registrada · 494,00 €" with **Deshacer** (⇒
  `setQuoteDeposit({ id, paid: null })`).
- **Clear:** clicking the paid chip opens the existing confirm dialog
  ("Quitar señal", "El presupuesto volverá a Pendiente.", `[Quitar]`
  `[Cancelar]`) ⇒ `setQuoteDeposit({ id, paid: null })` ⇒ refresh ⇒ toast
  "Señal eliminada" with **Deshacer** (re-marks with the previous amount; the
  timestamp and user are re-stamped, as with a status undo).
- Failures use the same error/offline dialogs as the status chips.

---

## 7. PDF

`buildQuoteContext` (`lib/pdf-templates.js`) adds flat fields (flat booleans
because the built-ins use `{{#if flag}}`; values may be dotted):

| Field | Value |
|---|---|
| `has_deposit` | `quote.deposit` present with `min_amount > 0` |
| `deposit_pct` | `"40 %"` (Spanish locale, up to 2 decimals: `"12,5 %"`) |
| `deposit_min` | `"494,00 €"` |
| `deposit_paid` | `quote.deposit_paid` present |
| `deposit_paid_amount` | `"500,00 €"` |
| `deposit_paid_date` | `dd/mm/aaaa` of `deposit_paid.at` |
| `deposit_remaining` | `fmtEur(max(0, total − paid))` |

All six built-in templates add, after the total row of `table.totals`:

```html
{{#if has_deposit}}<tr class="deposit"><td>Señal mínima ({{deposit_pct}})</td><td class="num">{{deposit_min}}</td></tr>{{/if}}
{{#if deposit_paid}}<tr class="deposit"><td>Señal recibida ({{deposit_paid_date}})</td><td class="num">{{deposit_paid_amount}}</td></tr>
<tr class="deposit deposit--remaining"><td>Resto pendiente</td><td class="num">{{deposit_remaining}}</td></tr>{{/if}}
```

with a small `.deposit` style per template (regular weight, muted colour,
"Resto pendiente" bold). The confirmation line becomes:

- no deposit on the quote (legacy): unchanged;
- deposit, not paid: `Presupuesto digital. Para aceptarlo, confírmelo por
  teléfono o email (<canal>) y abone la señal mínima de <X>; el pedido se
  lanza al recibir la señal. No requiere firma.`;
- paid: `Señal de <Y> recibida el <dd/mm/aaaa>: presupuesto aceptado. Resto
  pendiente: <Z>. No requiere firma.`

`DEMO_QUOTE` gains `deposit: { pct: 0.4, min_amount: 264 }` (unpaid) so the
settings gallery previews the common case. Custom cloud templates are
untouched; they receive the new fields and may use them.

---

## 8. Error handling

- All validation is fail-fast and Spanish: percentage and amount in the
  renderer (inline), amount again in main and in each backend (throws).
- Unknown id, backend errors and offline follow the exact patterns of
  `quotes:update` (`{ ok:false, error | offline }`), surfaced with the
  existing dialogs. Nothing is swallowed; nothing is queued silently.
- Cloud residual non-atomicity (§4.1) is documented and recoverable by retry.

---

## 9. Testing

New or extended Vitest files (one per module, as usual):

- `tests/deposit.test.js` — `depositMinimum` (exact multiples, rounding up,
  the float trap, zero/invalid inputs), `depositRemaining` (never negative),
  both parsers (comma decimals, bounds).
- `tests/config-default.test.js` — scaffold carries `deposit_pct`;
  `applyQuoteSettingsDefaults` fills only when missing and returns the same
  reference otherwise.
- `tests/config-schema.test.js` — `deposit_pct` accepts `0`–`1`, rejects
  strings / `1.5` / `-0.1`.
- `tests/quote-repo-file.test.js`, `tests/quote-repo-cloud.test.js`,
  `tests/quote-repo-cloud-facade.test.js` — `setDepositPaid` writes payment +
  status without bumping `version`; clearing returns to `pending`; unknown id
  ⇒ `null`; invalid amount throws before IO; `replaceQuote` preserves
  `deposit_paid` and drops it from the draft; list rows expose
  `deposit_paid`; cloud SQL for upsert / delete / LEFT JOIN / cascade delete.
- `tests/migration-loader.test.js` — add a smoke test that the bundled
  `db/migrations/` folder lists `0003_quote_deposits` after `0002`.
- `tests/history-draft.test.js` — `buildQuoteDraft` emits `deposit` and never
  `deposit_paid`.
- `tests/history-render.test.js` (new; `tests/history.test.js` already covers
  the legacy `lib/history.js`) — the deposit cell of `renderHistoryList` for
  paid / unpaid / pending rows.
- `tests/pdf-templates.test.js` — context fields for the three cases; every
  built-in renders the deposit rows when present and none when absent; the
  confirmation text variants; demo preview carries the minimum.
- `tests/cloud-bootstrap.test.js` — loaded catalog carries `deposit_pct` when
  the `company` rows lack it.

Manual smoke (added to the CLAUDE.md checklist for this release): new quote
→ change percentage → mark paid → save → history shows the chip and Aceptado
→ PDF prints the three rows; clear from history → Pendiente → undo.

---

## 10. Documentation to update with the code

- `CLAUDE.md` §5 (module list: `renderer/deposit.js`, `db/migrations/0003`),
  §10 glossary ("Saved quote": the two deposit fields and the status rule).
- `ARCHITECTURE.md` §4.3b record shape + the repository operation table
  (`setDepositPaid`), §6 (`quote_settings.deposit_pct`).
- `docs/UI-UX.md` §1.4 (result screen) and §2.7 (history chip + inline mark).
- `docs/PRD.md` if it lists quote fields.
- Devlog entry only with the release, per `devlog/TEMPLATE.md`.
