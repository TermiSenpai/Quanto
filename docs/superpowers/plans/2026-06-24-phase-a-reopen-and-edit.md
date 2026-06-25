# Phase A — Reopen & Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "reopen shows only the breakdown and can't be edited" bug by making a saved quote a fully reopenable record — store its raw inputs, rebuild the step-2 builder on reopen, and have an edited quote update the same entry.

**Architecture:** No storage move (quotes stay per-PC in `presupuestos.json`). The quote record gains `opt` (the raw builder inputs) plus `version`/`updated_at`. A new **pure** ESM module `renderer/quote-inputs.js` maps `opt` → the step-2 field plan (the testable inverse of `collectInputs`); a thin DOM applier in `app.js` uses it to repopulate the builder. `main`'s `quotes:save` learns to *replace* an existing quote when the draft carries an id.

**Tech Stack:** Electron (main = Node/CommonJS, renderer = vanilla ESM, no framework), Vitest in Node (no DOM — pure modules only), pnpm.

**Spec:** `docs/superpowers/specs/2026-06-24-shared-quotes-reopen-edit-design.md` (§5).

**Out of scope (Phase B):** sharing across devices, the folder/D1 backends, the cache/outbox, conflict dialogs. Phase A is single-PC and must ship green on its own.

---

## Norms (must hold for every task)

- **Renderer never touches fs/Node** — persistence only via `window.packprice.*`.
- **English code, Spanish user strings** — new identifiers/comments English; every message Spanish.
- **Tests are pure (Node, no DOM)** — DOM functions stay untested glue (like `collectInputs`); the *logic* lives in a pure module that IS tested. Do **not** add jsdom (no new deps / no build step).
- **No silent error swallow** — a legacy quote that can't be edited shows the existing notice; it never crashes (hard rule §4).
- **No domain numbers in code** — only structural limits (`MAX_QUOTE_BYTES`) live in code.
- **Minimal diff, frequent commits, no `--no-verify`. Commit only when asked.**

---

## File structure

**Created:**
- `renderer/quote-inputs.js` — pure ESM. `planInputs(pack, opt)` → a structured
  description of what every step-2 field should hold (the inverse of
  `collectInputs`). No DOM, no globals — unit-testable in Node.
- `tests/quote-inputs.test.js` — Vitest (ESM import, like `tests/calculo.test.js`),
  using `tests/fixtures/config-v4-full.js` for one pack of each mode.

**Modified:**
- `renderer/history.js` — `buildQuoteDraft` also stores `opt`.
- `renderer/app.js` — `applyInputs(packId, opt)` DOM applier; rewrite the `'open'`
  handler to rebuild the builder; `state.editingQuoteId` lifecycle;
  `persistCurrentQuote`/`saveCurrentQuote` route an edit to the same id.
- `lib/history.js` — `saveQuote` stamps `version: 1` + `updated_at`; new
  `replaceQuote(userDataDir, id, draft)`.
- `main.js` — `quotes:save` branches: draft with a known id → `replaceQuote`, else create.
- `tests/history.test.js` — cover `replaceQuote` + the new stamps.
- Docs: `CLAUDE.md`, `ARCHITECTURE.md` (quote record shape).

---

## Task A1: Persist the raw inputs (`opt`) in the saved quote

**Files:**
- Modify: `renderer/history.js` (`buildQuoteDraft`)
- Modify: `renderer/app.js` (`persistCurrentQuote` — pass `opt`)
- Test: `tests/history-draft.test.js` (new; imports `buildQuoteDraft` from `../renderer/history.js`)

**What:**
- `buildQuoteDraft(result, ctx)` adds `opt: ctx.opt || null` to the returned draft
  (keep every existing field). This is the only field the rest of Phase A needs.
- `persistCurrentQuote(client)` captures the live inputs once
  (`const opt = collectInputs();`) and passes `opt` in the `ctx` it already builds.
- The draft stays under `MAX_QUOTE_BYTES` (bounded in `lib/history.js` already).

**Tests (pure, Node):**
- `buildQuoteDraft(result, { opt })` includes `opt` verbatim and still includes
  `result`, `totals`, `customer`, `pack_id`.

**Acceptance:** new saves carry `opt`; existing fields unchanged; `pnpm test` green.

**Commit:** `feat(quotes): store raw builder inputs (opt) in the saved quote`

---

## Task A2: Pure input-mapping module (`renderer/quote-inputs.js`)

**Files:**
- Create: `renderer/quote-inputs.js`
- Test: `tests/quote-inputs.test.js`

**What:** `planInputs(pack, opt)` returns a pure, DOM-free plan — the exact inverse
of `collectInputs` (`renderer/app.js` ~L1780):

```
{
  mode: 'bundle' | 'components' | 'free',   // derived from pack (free_components / pricing_mode)
  options: { [optionId]: valueId },          // selected radio per option
  addons:  { [addonId]: qty },               // only positive
  sizes:   { qty_3xl, qty_4xl, qty_5xl },
  packs:        <number> | null,             // bundle only
  quantities:   { [componentId]: qty } | null, // components only
  lines:        [ { product, quantity } ] | null // free only
}
```

Rules: read selections from `opt`; default missing values to 0/empty; never touch
the DOM. Keep the function small and obvious (mirror `collectInputs` branch-for-branch).

**Tests (pure, Node):** for one `bundle`, one `components`, and one
`free_components` pack from `tests/fixtures/config-v4-full.js`:
- `planInputs(pack, opt)` returns the expected plan for a representative `opt`.
- **Round-trip:** a tiny pure `optFromPlan(pack, plan)` reconstructs the original
  `opt` (assert deep equality) — proves the mapping is lossless for each mode.

**Acceptance:** all three modes round-trip; `pnpm test` green.

**Commit:** `feat(quotes): pure planInputs mapping (inverse of collectInputs)`

---

## Task A3: `applyInputs` DOM applier + reopen rebuilds the builder

**Files:**
- Modify: `renderer/app.js` (import `planInputs`; add `applyInputs`; rewrite `'open'`)

**What:**
- `import { planInputs } from './quote-inputs.js';`
- `applyInputs(packId, opt)` builds the plan and writes it to the DOM that
  `renderPackInputs(packId)` just created:
  - option radios `input[name="opt_<id>"][value="<valueId>"]`.checked
  - addon inputs `[data-addon-qty="<id>"]`.value
  - `cant_3xl/4xl/5xl`.value
  - bundle: `in_packs`.value; components: `in_comp_<idx>`.value
  - free: clear `#lineas-personalizado`, then append one `createCustomLine(...)`
    per `plan.lines` entry.
  This is **untested DOM glue** by project policy — its logic lives in `planInputs`.
- Rewrite the `'open'` branch of the history action handler:
  1. `getQuote(id)`; bail with the existing error dialog if absent.
  2. `result = quote.result || quote`; `opt = quote.opt`; `packId = result.pack_id || quote.pack_id`.
  3. If `packId` missing from `CFG.packs` **or** `opt` is absent → **read-only**
     path (Task A5): show the result, keep the current "no editable" notice, do
     **not** set `editingQuoteId`.
  4. Else: `selectPack(packId)` → `renderPackInputs(packId)` →
     `applyInputs(packId, opt)` → `syncClientCard(quote)` → `recomputePreview()`
     → `lastResult = result` → `renderResult(result)` → `goToScreen('resultado')`,
     and set `state.editingQuoteId = quote.id`.

**Tests:** none (DOM glue). Covered by the smoke checklist + Task A2's pure tests.

**Acceptance:** reopening a quote shows the desglose AND "Editar pedido" returns to
a fully populated step 2 (manual smoke).

**Commit:** `fix(quotes): reopen rebuilds the editable builder from stored inputs`

---

## Task A4: Editing a reopened quote updates the same entry

**Files:**
- Modify: `lib/history.js` (`saveQuote` stamps; new `replaceQuote`)
- Modify: `main.js` (`quotes:save` branch on `draft.id`)
- Modify: `renderer/app.js` (`persistCurrentQuote` sets `draft.id`; `editingQuoteId` lifecycle)
- Test: `tests/history.test.js`

**What:**
- `lib/history.js`:
  - `saveQuote` (create): also set `version: 1` and `updated_at: now` on the saved object.
  - `replaceQuote(userDataDir, id, draft)`: read all; find by id (return `null` if
    absent); overwrite the editable fields from `draft` while **pinning** `id` and
    original `date`; set `updated_at: now` and `version: (existing.version||1)+1`;
    enforce `MAX_QUOTE_BYTES`; atomic write; return the merged quote. (Phase A is
    single-PC, so no mtime/version *guard* yet — that is Phase B.)
  - Export `replaceQuote`.
- `main.js` `quotes:save`: if `draft && draft.id` and a quote with that id exists →
  `replaceQuote(SETTINGS_DIR, draft.id, draft)`; else `saveQuoteToHistory(...)`.
  Log which path ran.
- `renderer/app.js`:
  - `persistCurrentQuote`: if `state.editingQuoteId`, set `draft.id = state.editingQuoteId`.
  - Clear `state.editingQuoteId` in `resetForm`, `backToSelection`, and `selectPack`
    (a fresh pack selection starts a new quote).
  - Add `editingQuoteId: null` to the `state` object literal.
  - After a successful edit-save, keep `editingQuoteId` (further edits keep updating
    the same id) and adjust the success dialog copy (e.g. "Presupuesto actualizado").

**Tests (pure, Node):**
- `replaceQuote` overwrites `result`/`opt`/`customer`, keeps `id` + `date`, sets
  `updated_at`, bumps `version`.
- `replaceQuote` on an unknown id returns `null` (no write).
- `saveQuote` stamps `version: 1` + `updated_at`.

**Acceptance:** reopen → change a quantity → save updates the same `PP-…` id (no new
row); `pnpm test` green.

**Commit:** `feat(quotes): editing a reopened quote updates the same entry`

---

## Task A5: Read-only fallback for non-editable quotes

**Files:**
- Modify: `renderer/app.js` (the `'open'` read-only branch from Task A3)

**What:** consolidate the guard so a quote that is **missing `opt`** (saved before
Phase A) or whose **`pack_id` no longer exists** opens read-only:
- show the result + PDF as today,
- keep the existing Spanish notice ("Se muestra el presupuesto guardado, pero no
  podrás editarlo…"),
- do not set `editingQuoteId` (so a later save can't silently overwrite it),
- never throw.

**Tests:** none (DOM). Manual smoke with a pre-Phase-A quote.

**Acceptance:** an old quote reopens, shows the desglose, exports PDF, and the editor
is disabled with a clear notice — no crash.

**Commit:** `fix(quotes): read-only reopen for legacy/orphaned quotes`

---

## Task A6: Docs + smoke

**Files:**
- Modify: `CLAUDE.md` (quote record now carries `opt`; reopen-edit behavior),
  `ARCHITECTURE.md` (the canonical quote record shape), the spec status line.

**Smoke checklist (manual, `pnpm dev`):**
- Save a bundle pack with a hood option + an addon + a 4XL → reopen → Editar pedido
  shows the same quantities/options/addon/size → change qty → save updates same id.
- Components pack with two component quantities → same round-trip.
- Free-components pack with two lines → reopen rebuilds both lines.
- A quote saved before Phase A reopens read-only with the notice, PDF still works.

**Commit:** `docs(quotes): document reopen-to-edit and the opt field`

---

## Self-review notes (coverage)

- Spec §5.1 store inputs → A1. §5.2 inverse mapping → A2. §5.3 reopen rebuild → A3.
  §5.4 edit-updates-same → A4. §5.5 legacy/orphaned → A5.
- No placeholders; the only untested code is DOM glue (project policy), whose logic
  is fully covered by the pure `planInputs` tests.

---

## Future improvements (foundation laid here, built later)

- **`version`/`updated_at` are written now** so Phase B can add optimistic-concurrency
  *guards* without another data-model change.
- **"Save as copy"** — a second save path that creates a new id from the current
  edit (the runner-up answer to the edit-save question).
- **Edit affordance** — surface an explicit "Editar" entry from the desglose for a
  reopened quote (today only "Editar pedido" exists), once Phase B adds the shared list.
- **Per-quote dirty check** — warn before leaving an unsaved edit.
