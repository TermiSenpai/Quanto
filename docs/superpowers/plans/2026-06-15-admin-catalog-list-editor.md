# Admin Catalog: List + Search + Focused Editor + Responsive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the admin catalog tabs (Productos, Packs, Proveedores, Complementos) into a compact searchable list that opens a focused, full-width single-entity editor (master/detail) with collapsible sections, and make the admin modal scale fluidly with the window.

**Architecture:** Each catalog tab has two views inside the same modal — a **list** (search bar + compact rows + "Añadir") and an **editor** (one entity, extracted from today's per-entity form, with long sections wrapped in native `<details>`). All UI state (current view, entity id, per-tab search text, closed sections) lives in `state` (outside the DOM) because `showAdminTab()` re-renders the whole tab on every structural action. The save model is unchanged: fields write to `CFG` live and the single footer "Guardar" persists everything. Responsive width comes from `min(1380px, 95vw)` on `.modal` and an `auto-fit` `.admin-grid`.

**Tech Stack:** Vanilla JS (ES modules), HTML, CSS — no build step, no framework, no new deps. Tests: Vitest (Node, no DOM) for pure render/mutation functions; DOM wiring verified by manual smoke (`pnpm dev`).

**Spec:** `docs/superpowers/specs/2026-06-15-admin-catalog-list-editor-design.md`

**Conventions (from CLAUDE.md):** `'use strict'`-style ES modules already in use; `const` by default; 2-space indent; single quotes; semicolons. **UI strings Spanish, identifiers/comments English.** All interpolated values escaped with `esc()`. Do not weaken security invariants. Do NOT use `git --no-verify`/`--force`. Per repo rule #10, confirm with the user before the first commit; the commit steps below are the recipe, not permission.

**Test commands:**
- Single file: `pnpm exec vitest run tests/admin.test.js`
- Filter by name: `pnpm exec vitest run tests/admin.test.js -t "normalizeText"`
- Full suite: `pnpm test`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `renderer/admin.js` | Pure render + mutation helpers | Add search helpers, list renderers, editor renderers, collapsible/toolbar helpers; make `add*` return the new id; update router; **remove** old `renderAdminSuppliers/Products/Addons/Packs` (replaced by list+editor) |
| `renderer/app.js` | Orchestration: modal, IPC, wiring | Extend `state`; route list/editor in `showAdminTab`; wire search filter, edit/add/back navigation, `<details>` persistence |
| `renderer/styles.css` | Styling | New classes for list/search/editor/details; responsive `.modal` + `.admin-grid` |
| `tests/admin.test.js` | Unit tests for admin.js | Add tests for helpers, lists, editors, `add*` id; migrate form-field assertions from removed functions to the editor renderers |

---

## Task 1: Search helpers (`normalizeText`, `matchesQuery`)

Pure, accent-insensitive matching used by every list renderer and the live DOM filter.

**Files:**
- Modify: `renderer/admin.js` (add near the `esc` helper, ~line 73)
- Test: `tests/admin.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/admin.test.js` (import the two new symbols in the existing top `import { ... } from '../renderer/admin.js'` block):

```js
// at top, extend the existing admin.js import with:
//   normalizeText, matchesQuery

describe('search helpers', () => {
  test('normalizeText lowercases and strips accents', () => {
    expect(normalizeText('Camiseta Básica')).toBe('camiseta basica');
    expect(normalizeText('SUDADERA')).toBe('sudadera');
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(123)).toBe('123');
  });

  test('matchesQuery is accent- and case-insensitive', () => {
    const hay = normalizeText('CAMISETA Camiseta básica tshirt');
    expect(matchesQuery(hay, 'basica')).toBe(true);   // no accent typed
    expect(matchesQuery(hay, 'BÁSICA')).toBe(true);    // accent + caps typed
    expect(matchesQuery(hay, 'tshirt')).toBe(true);
    expect(matchesQuery(hay, 'polo')).toBe(false);
  });

  test('an empty query matches everything', () => {
    expect(matchesQuery(normalizeText('anything'), '')).toBe(true);
    expect(matchesQuery(normalizeText('anything'), '   ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "search helpers"`
Expected: FAIL — `normalizeText is not defined` (or import error).

- [ ] **Step 3: Implement the helpers**

In `renderer/admin.js`, after the `esc` function (after line 72), add:

```js
// ------------------------------------------------------------
// Search helpers (admin catalog lists)
// ------------------------------------------------------------
/** Lowercase + strip diacritics, so "basica" matches "Básica". */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase();
}

/** True when `query` (normalized) is contained in an already-
 *  normalized `haystack`. An empty/whitespace query matches all. */
export function matchesQuery(haystack, query) {
  const q = normalizeText(query).trim();
  if (!q) return true;
  return haystack.includes(q);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/admin.test.js -t "search helpers"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): accent-insensitive search helpers"
```

---

## Task 2: `add*` actions return the created id

The editor opens on the freshly-created entity, so `app.js` needs its id back.

**Files:**
- Modify: `renderer/admin.js` — `addSupplier` (~871), `addProduct` (~898), `addAddon`, `addPack`
- Test: `tests/admin.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/admin.test.js`:

```js
describe('add actions return the created id', () => {
  test('add-supplier returns its id', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-supplier' });
    expect(r.id).toBe('SUPPLIER_1');
    expect(cfg.suppliers[r.id]).toBeDefined();
  });

  test('add-product returns its id', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-product' });
    expect(r.id).toBe('PRODUCT_1');
    expect(cfg.products[r.id]).toBeDefined();
  });

  test('add-addon returns its id', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-addon' });
    expect(r.id).toBe('addon_1');
    expect(cfg.addons[r.id]).toBeDefined();
  });

  test('add-pack returns its id', () => {
    const cfg = freshCfg();
    const r = executeAdminAction(cfg, { action: 'add-pack' });
    expect(r.id).toBe('pack_1');
    expect(cfg.packs[r.id]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "add actions return the created id"`
Expected: FAIL — `r.id` is `undefined`.

- [ ] **Step 3: Implement — return `id` from each add function**

In `renderer/admin.js`, change the four return statements:

`addSupplier` (currently `return { dirty: true };` after assigning `cfg.suppliers[id]`):
```js
  cfg.suppliers[id] = { name: 'Nuevo proveedor', web: '', notes: '' };
  return { dirty: true, id };
```

`addProduct` (final return):
```js
    prices
  };
  return { dirty: true, id };
```

`addAddon` — locate `function addAddon(cfg)`; it ends with `return { dirty: true };`. Change to `return { dirty: true, id };` (the local variable is `id`, from `nextId(cfg.addons, 'addon_')`).

`addPack` — locate `function addPack(cfg)`; it currently does `cfg.packs[id] = pack;` then `return { dirty: true };`. Change to:
```js
  cfg.packs[id] = pack;
  return { dirty: true, id };
```

> Do NOT change `addTier`, `addProductSupplier`, `addPackComponent`, etc. — those edit within an entity and the caller does not navigate.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/admin.test.js -t "add actions return the created id"`
Expected: PASS (4 tests). Then run the whole admin file to confirm no regression: `pnpm exec vitest run tests/admin.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): add actions return the created entity id"
```

---

## Task 3: Shared list/editor helpers (`renderListToolbar`, `wrapCollapsible`)

Reusable building blocks so the four entities share one search bar and one collapsible.

**Files:**
- Modify: `renderer/admin.js`
- Test: `tests/admin.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/admin.test.js` (extend the admin.js import with `renderListToolbar, wrapCollapsible`):

```js
describe('renderListToolbar', () => {
  test('emits a search input pre-filled with the query and a count', () => {
    const html = renderListToolbar('cami', 1, 4);
    expect(html).toContain('class="admin-search"');
    expect(html).toContain('class="admin-search__input"');
    expect(html).toContain('value="cami"');
    expect(html).toContain('1 de 4');
  });

  test('escapes the query value', () => {
    const html = renderListToolbar('"<x>', 0, 0);
    expect(html).not.toContain('"<x>');
    expect(html).toContain('&quot;&lt;x&gt;');
  });
});

describe('wrapCollapsible', () => {
  test('wraps body in an open <details> carrying a section key', () => {
    const html = wrapCollapsible('Proveedores', '<p>body</p>', 'products:BEAGLE:suppliers');
    expect(html).toContain('<details class="admin-section" open');
    expect(html).toContain('data-section="products:BEAGLE:suppliers"');
    expect(html).toContain('<summary');
    expect(html).toContain('Proveedores');
    expect(html).toContain('<p>body</p>');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "renderListToolbar"`
Expected: FAIL — `renderListToolbar is not defined`.

- [ ] **Step 3: Implement the helpers**

In `renderer/admin.js`, after the search helpers from Task 1, add:

```js
// ------------------------------------------------------------
// List toolbar (search + count) and collapsible section
// ------------------------------------------------------------
const SEARCH_SVG =
  '<svg class="icon admin-search__icon"><use href="#i-search"/></svg>';
const CARET_SVG_SECTION =
  '<svg class="admin-section__caret" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

/** Search box + "N de M" count. The count is hidden until a query is
 *  active; `app.js` updates it live as the user types. */
export function renderListToolbar(query, count, total) {
  const q = query || '';
  return `
    <div class="admin-search">
      ${SEARCH_SVG}
      <input type="text" class="admin-search__input" placeholder="Buscar…"
             value="${esc(q)}" aria-label="Buscar en la lista">
    </div>
    <div class="admin-list-count"${q ? '' : ' hidden'}>${count} de ${total}</div>
  `;
}

/** Native collapsible. Always rendered open; app.js re-applies the
 *  user's collapsed sections (state.adminClosedSections) after render. */
export function wrapCollapsible(label, bodyHtml, sectionKey) {
  return `
    <details class="admin-section" open data-section="${esc(sectionKey)}">
      <summary class="admin-section__head">${CARET_SVG_SECTION}<span>${esc(label)}</span></summary>
      <div class="admin-section__body">${bodyHtml}</div>
    </details>
  `;
}
```

> The `#i-search` icon symbol is added in Task 10 (CSS/markup task). If it is missing the `<use>` simply renders nothing — harmless for tests and for an interim smoke.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/admin.test.js -t "renderListToolbar"` then `-t "wrapCollapsible"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): list toolbar and collapsible section helpers"
```

---

## Task 4: Suppliers — list + editor (establishes the pattern)

Suppliers are the simplest entity (3 fields), so they set the template the other three follow.

**Files:**
- Modify: `renderer/admin.js` — replace `renderAdminSuppliers` (lines ~125-168) with `renderSuppliersList` + `renderSupplierEditor`
- Test: `tests/admin.test.js`

- [ ] **Step 1: Write the failing tests**

In `tests/admin.test.js`, extend the import with `renderSuppliersList, renderSupplierEditor` and **remove** `renderAdminSuppliers` from the import. Replace the existing `describe('suppliers actions', ...)` render test (`'render disables remove for an in-use supplier'`) body to use the list, and add list/editor tests:

```js
describe('suppliers list + editor', () => {
  test('list shows a compact row per supplier with search data', () => {
    const html = renderSuppliersList(freshCfg(), '');
    expect(html).toContain('class="admin-search__input"');
    expect(html).toContain('class="admin-list__row"');
    expect(html).toContain('data-id="ROLY"');
    expect(html).toContain('data-edit="ROLY"');
    // compact list does NOT inline the editable fields
    expect(html).not.toContain('data-cfg-path="suppliers.ROLY.name"');
  });

  test('list pre-hides rows that do not match the query and counts matches', () => {
    const cfg = freshCfg();
    executeAdminAction(cfg, { action: 'add-supplier' }); // SUPPLIER_1 "Nuevo proveedor"
    const html = renderSuppliersList(cfg, 'roly');
    // ROLY row visible, the "Nuevo proveedor" row hidden
    expect(html).toMatch(/data-id="ROLY"[^>]*class="admin-list__row"|class="admin-list__row"[^>]*data-id="ROLY"/);
    expect(html).toMatch(/admin-list__row is-hidden[^>]*data-id="SUPPLIER_1"|data-id="SUPPLIER_1"[^>]*admin-list__row is-hidden/);
    expect(html).toContain('1 de 2');
  });

  test('list disables remove for an in-use supplier', () => {
    const html = renderSuppliersList(freshCfg(), '');
    expect(html).toMatch(/data-action="remove-supplier" data-id="ROLY"[\s\S]*?disabled/);
  });

  test('editor renders the single supplier form with editable fields', () => {
    const html = renderSupplierEditor(freshCfg(), 'ROLY');
    expect(html).toContain('class="admin-editor__head"');
    expect(html).toContain('data-back');
    expect(html).toContain('data-cfg-path="suppliers.ROLY.name"');
    expect(html).toContain('data-cfg-path="suppliers.ROLY.web"');
    // only ROLY, not other suppliers
    expect(html).not.toContain('data-cfg-path="suppliers.SUPPLIER_1.name"');
  });

  test('editor guards a missing id', () => {
    const html = renderSupplierEditor(freshCfg(), 'NOPE');
    expect(html).toContain('no encontrado');
  });
});
```

Also update the old `describe('suppliers actions')` test named `'render disables remove for an in-use supplier'` — **delete it** (its assertion now lives in the block above).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "suppliers list"`
Expected: FAIL — `renderSuppliersList is not defined`.

- [ ] **Step 3: Implement list + editor; remove the old function**

In `renderer/admin.js`, delete `renderAdminSuppliers` (lines ~125-168) and add in its place:

```js
// ============================================================
// SUPPLIERS — list + editor
// ============================================================
function supplierHaystack(id, s) {
  return buildHaystack([id, s.name]);
}

export function renderSuppliersList(cfg, query = '') {
  const entries = Object.entries(cfg.suppliers || {});
  const total = entries.length;
  let count = 0;
  let rows = '';
  for (const [id, s] of entries) {
    const inUse = isSupplierInUse(cfg, id);
    const hay = supplierHaystack(id, s);
    const show = matchesQuery(hay, query);
    if (show) count++;
    rows += `
      <div class="admin-list__row${show ? '' : ' is-hidden'}" data-id="${esc(id)}"
           data-edit="${esc(id)}" data-search="${esc(hay)}">
        <span class="admin-row__id">${esc(id)}</span>
        <strong class="admin-list__name">${esc(s.name || '—')}</strong>
        ${inUse ? '<span class="admin-list__meta">en uso</span>' : ''}
        <span class="admin-list__actions">
          <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(id)}">Editar</button>
          <button type="button" class="admin-row__remove"
                  data-action="remove-supplier" data-id="${esc(id)}"
                  ${inUse ? 'disabled title="Lo usa algún producto"' : 'title="Eliminar proveedor"'}
                  aria-label="Eliminar proveedor ${esc(id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </span>
      </div>
    `;
  }
  return `
    <p class="hint" style="margin-bottom: 12px;">Proveedores que abastecen los productos. No se puede eliminar un proveedor usado por algún producto.</p>
    ${renderListToolbar(query, count, total)}
    <div class="admin-list">
      ${rows}
      <div class="admin-empty"${count ? ' hidden' : ''}>Sin resultados${query ? ` para «${esc(query)}»` : ''}.</div>
    </div>
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-action="add-supplier">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir proveedor
      </button>
    </div>
  `;
}

export function renderSupplierEditor(cfg, id) {
  const s = cfg.suppliers?.[id];
  if (!s) return renderEditorNotFound('Proveedor');
  return `
    ${renderEditorHead(`Editar proveedor: ${esc(s.name || id)}`)}
    <div class="admin-grid">
      <label>Nombre
        <input type="text" value="${esc(s.name || '')}" data-cfg-path="suppliers.${esc(id)}.name">
      </label>
      <label>Web <span class="hint">opcional</span>
        <input type="text" value="${esc(s.web || '')}" data-cfg-path="suppliers.${esc(id)}.web">
      </label>
      <label>Notas <span class="hint">opcional</span>
        <input type="text" value="${esc(s.notes || '')}" data-cfg-path="suppliers.${esc(id)}.notes">
      </label>
    </div>
  `;
}
```

Add these two shared helpers once (place them right after `wrapCollapsible` in Task 3's block):

```js
/** Join parts into a normalized search haystack. */
export function buildHaystack(parts) {
  return normalizeText(parts.filter(v => v !== null && v !== undefined && v !== '').join(' '));
}

/** Editor header: back button + title (Spanish UI). */
function renderEditorHead(title) {
  return `
    <div class="admin-editor__head">
      <button type="button" class="btn btn-ghost" data-back>
        <svg class="icon"><use href="#i-chevron-left"/></svg> Volver a la lista
      </button>
      <h3 class="admin-editor__title">${esc(title)}</h3>
    </div>
  `;
}

function renderEditorNotFound(label) {
  return `
    ${renderEditorHead('No encontrado')}
    <p class="hint">${esc(label)} no encontrado. Vuelve a la lista.</p>
  `;
}
```

> `buildHaystack` is first used here (and again in Tasks 5-7); keep it exported so it stays unit-testable. It has no dedicated test of its own — it is exercised through the list-render tests that assert filtering.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/admin.test.js -t "suppliers"`
Expected: PASS. (The router test still references `renderAdminSuppliers` output indirectly via `renderAdminTabContent` — that is fixed in Task 8; until then `renderAdminTabContent('suppliers')` is broken, so run only the `-t "suppliers"` subset here.)

- [ ] **Step 5: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): suppliers list + focused editor"
```

---

## Task 5: Addons — list + editor

**Files:**
- Modify: `renderer/admin.js` — replace `renderAdminAddons` (lines ~332-390) with `renderAddonsList` + `renderAddonEditor`
- Test: `tests/admin.test.js`

- [ ] **Step 1: Write the failing tests**

Extend the import with `renderAddonsList, renderAddonEditor` and remove `renderAdminAddons`. Add:

```js
describe('addons list + editor', () => {
  test('list shows a row per addon with search data, no inline fields', () => {
    const html = renderAddonsList(freshCfg(), '');
    expect(html).toContain('class="admin-list__row"');
    expect(html).toContain('data-id="name"');
    expect(html).toContain('data-edit="name"');
    expect(html).not.toContain('data-cfg-path="addons.name.label"');
  });

  test('editor renders one addon, with category checkboxes and applies-to wrapped collapsible', () => {
    const html = renderAddonEditor(freshCfg(), 'name');
    expect(html).toContain('data-back');
    expect(html).toContain('data-cfg-path="addons.name.label"');
    expect(html).toContain('data-cfg-path="addons.name.price"');
    expect(html).toContain('data-action-change="toggle-addon-category" data-id="name"');
    expect(html).toContain('data-section="addons:name:applies"');
  });

  test('editor guards a missing id', () => {
    expect(renderAddonEditor(freshCfg(), 'NOPE')).toContain('no encontrado');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "addons list"`
Expected: FAIL — `renderAddonsList is not defined`.

- [ ] **Step 3: Implement; remove the old function**

In `renderer/admin.js`, delete `renderAdminAddons` and add:

```js
// ============================================================
// ADDONS — list + editor
// ============================================================
export function renderAddonsList(cfg, query = '') {
  const entries = Object.entries(cfg.addons || {});
  const total = entries.length;
  let count = 0;
  let rows = '';
  for (const [id, a] of entries) {
    const hay = buildHaystack([id, a.label]);
    const show = matchesQuery(hay, query);
    if (show) count++;
    rows += `
      <div class="admin-list__row${show ? '' : ' is-hidden'}" data-id="${esc(id)}"
           data-edit="${esc(id)}" data-search="${esc(hay)}">
        <span class="admin-row__id">${esc(id)}</span>
        <strong class="admin-list__name">${esc(a.label || '—')}</strong>
        <span class="admin-list__meta">${esc((a.price ?? 0))} €</span>
        <span class="admin-list__actions">
          <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(id)}">Editar</button>
          <button type="button" class="admin-row__remove"
                  data-action="remove-addon" data-id="${esc(id)}"
                  title="Eliminar complemento" aria-label="Eliminar complemento ${esc(id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </span>
      </div>
    `;
  }
  return `
    <p class="hint" style="margin-bottom: 12px;">Complementos opcionales (nombre, mangas, …). El precio es sin IVA salvo que marques «IVA incluido». «Aplica a» son categorías de producto, o «*» para todas.</p>
    ${renderListToolbar(query, count, total)}
    <div class="admin-list">
      ${rows}
      <div class="admin-empty"${count ? ' hidden' : ''}>Sin resultados${query ? ` para «${esc(query)}»` : ''}.</div>
    </div>
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-action="add-addon">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir complemento
      </button>
    </div>
  `;
}

export function renderAddonEditor(cfg, id) {
  const a = cfg.addons?.[id];
  if (!a) return renderEditorNotFound('Complemento');
  const categories = collectCategories(cfg);
  const appliesTo = Array.isArray(a.applies_to) ? a.applies_to : [];
  const all = ['*', ...categories];
  const appliesBody = `
    <div class="admin-grid">
      ${all.map(cat => `
        <label style="flex-direction: row; align-items: center; gap: 8px;">
          <input type="checkbox" ${appliesTo.includes(cat) ? 'checked' : ''}
                 data-action-change="toggle-addon-category" data-id="${esc(id)}" data-cat="${esc(cat)}">
          ${cat === '*' ? 'Todas (*)' : esc(cat)}
        </label>
      `).join('')}
    </div>
  `;
  return `
    ${renderEditorHead(`Editar complemento: ${esc(a.label || id)}`)}
    <div class="admin-grid">
      <label>Etiqueta
        <input type="text" value="${esc(a.label || '')}" data-cfg-path="addons.${esc(id)}.label">
      </label>
      <label>Precio (€/ud)
        <input type="number" step="0.01" min="0" value="${esc(a.price ?? 0)}" data-cfg-path="addons.${esc(id)}.price">
      </label>
      <label>Coste interno (€/ud) <span class="hint">para el margen</span>
        <input type="number" step="0.01" min="0" value="${esc(a.cost ?? 0)}" data-cfg-path="addons.${esc(id)}.cost">
      </label>
      <label style="flex-direction: row; align-items: center; gap: 8px;">
        <input type="checkbox" ${a.vat_included ? 'checked' : ''} data-cfg-path="addons.${esc(id)}.vat_included">
        El precio ya incluye IVA
      </label>
    </div>
    ${wrapCollapsible('Aplica a', appliesBody, `addons:${id}:applies`)}
  `;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/admin.test.js -t "addons"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): addons list + focused editor"
```

---

## Task 6: Products — list + editor (extraction)

The product form already exists in `renderAdminProducts` (lines ~173-303). Split it: the per-product loop body becomes `renderProductEditor(cfg, id)`; a new `renderProductsList` emits compact rows.

**Files:**
- Modify: `renderer/admin.js` — replace `renderAdminProducts` with `renderProductsList` + `renderProductEditor`
- Test: `tests/admin.test.js`

- [ ] **Step 1: Write the failing tests**

Extend the import with `renderProductsList, renderProductEditor` and remove `renderAdminProducts`. **Migrate** the two existing render assertions that used `renderAdminProducts`:
- In `describe('products actions')`, the test `'render replaces "Modelos Roly" with product fields'` → change `renderAdminProducts(freshCfg())` to `renderProductEditor(freshCfg(), 'BEAGLE')`.
- The test `'the "Por defecto" badge marks exactly one supplier per product...'` → change `renderAdminProducts(cfg)` to `renderProductEditor(cfg, 'BEAGLE')`, and update the badge/radio expectations to a **single** product: `expect(badges.length).toBe(1)` and keep `expect(radios.length).toBeGreaterThan(badges.length)`.

Then add:

```js
describe('products list + editor', () => {
  test('list shows a compact row per product (id, name, category) and search data', () => {
    const html = renderProductsList(freshCfg(), '');
    expect(html).toContain('class="admin-search__input"');
    expect(html).toContain('data-id="BEAGLE"');
    expect(html).toContain('data-edit="BEAGLE"');
    expect(html).not.toContain('data-cfg-path="products.BEAGLE.name"'); // not inline
  });

  test('list filters by category text too', () => {
    const cfg = freshCfg();
    const cat = cfg.products.BEAGLE.category;
    const html = renderProductsList(cfg, cat);
    expect(html).toMatch(/data-id="BEAGLE"[^>]*data-search="[^"]*"/);
    // a product in a different category is hidden
  });

  test('list disables remove for an in-use product', () => {
    const html = renderProductsList(freshCfg(), '');
    expect(html).toMatch(/data-action="remove-product" data-id="BEAGLE"[\s\S]*?disabled/);
  });

  test('editor renders one product with collapsible suppliers and price sections', () => {
    const html = renderProductEditor(freshCfg(), 'BEAGLE');
    expect(html).toContain('data-back');
    expect(html).toContain('data-cfg-path="products.BEAGLE.name"');
    expect(html).toContain('data-section="products:BEAGLE:suppliers"');
    expect(html).toContain('data-section="products:BEAGLE:prices"');
    expect(html).toContain('Aplicar PVP recomendado');
    expect(html).not.toContain('data-cfg-path="products.URBAN.name"'); // only BEAGLE
  });

  test('editor guards a missing id', () => {
    expect(renderProductEditor(freshCfg(), 'NOPE')).toContain('no encontrado');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "products list"`
Expected: FAIL — `renderProductsList is not defined`.

- [ ] **Step 3: Implement — split the existing function**

In `renderer/admin.js`, replace the whole `renderAdminProducts` function (lines ~173-303) with the two functions below.

`renderProductsList` (new compact list):
```js
export function renderProductsList(cfg, query = '') {
  const entries = Object.entries(cfg.products || {});
  const total = entries.length;
  let count = 0;
  let rows = '';
  for (const [id, p] of entries) {
    const inUse = isProductInUse(cfg, id);
    const hay = buildHaystack([id, p.name, p.category]);
    const show = matchesQuery(hay, query);
    if (show) count++;
    rows += `
      <div class="admin-list__row${show ? '' : ' is-hidden'}" data-id="${esc(id)}"
           data-edit="${esc(id)}" data-search="${esc(hay)}">
        <span class="admin-row__id">${esc(id)}</span>
        <strong class="admin-list__name">${esc(p.name || '—')}</strong>
        ${p.category ? `<span class="admin-list__meta">${esc(p.category)}</span>` : ''}
        ${inUse ? '<span class="admin-list__meta">en uso</span>' : ''}
        <span class="admin-list__actions">
          <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(id)}">Editar</button>
          <button type="button" class="admin-row__remove"
                  data-action="remove-product" data-id="${esc(id)}"
                  ${inUse ? 'disabled title="Lo usa algún pack"' : 'title="Eliminar producto"'}
                  aria-label="Eliminar producto ${esc(id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </span>
      </div>
    `;
  }
  return `
    <p class="hint" style="margin-bottom: 12px;">Cada producto tiene su categoría, coste extra de 3XL, margen objetivo, sus proveedores (uno por defecto) y su tabla de PVP por caras y tramo. No se puede eliminar un producto usado por algún pack.</p>
    ${renderListToolbar(query, count, total)}
    <div class="admin-list">
      ${rows}
      <div class="admin-empty"${count ? ' hidden' : ''}>Sin resultados${query ? ` para «${esc(query)}»` : ''}.</div>
    </div>
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-action="add-product">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir producto
      </button>
    </div>
  `;
}
```

`renderProductEditor` — this is the **extraction** of the current loop body (lines ~181-290), for a single `id`, with the *Proveedores* and *PVP* blocks wrapped in `wrapCollapsible`. Build it as:

```js
export function renderProductEditor(cfg, id) {
  const p = cfg.products?.[id];
  if (!p) return renderEditorNotFound('Producto');

  const supplierIds = Object.keys(cfg.suppliers || {});
  const categories = collectCategories(cfg);

  // --- Basic fields (from the old loop body, lines ~199-215) ---
  const basic = `
    <div class="admin-grid">
      <label>Nombre
        <input type="text" value="${esc(p.name || '')}" data-cfg-path="products.${esc(id)}.name">
      </label>
      <label>Categoría <span class="hint">agrupa y decide qué complementos aplican</span>
        <input type="text" list="cat-list-${esc(id)}" value="${esc(p.category || '')}" data-cfg-path="products.${esc(id)}.category">
        <datalist id="cat-list-${esc(id)}">${categories.map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>
      </label>
      <label>Coste extra 3XL (€) <span class="hint">colchón interno · no se factura</span>
        <input type="number" step="0.01" min="0" value="${esc(p.extra_cost_3xl ?? 0)}" data-cfg-path="products.${esc(id)}.extra_cost_3xl">
      </label>
      <label>Margen objetivo <span class="hint">decimal · vacío usa el global</span>
        <input type="number" step="0.01" min="0" max="0.99" value="${esc(p.target_margin ?? '')}" data-cfg-path="products.${esc(id)}.target_margin">
      </label>
    </div>
  `;

  // --- Suppliers sub-list (extract lines ~219-266 into `suppliersBody`) ---
  let suppliersBody = '';
  (p.suppliers || []).forEach((sup, sidx) => {
    const onlyOne = (p.suppliers || []).length <= 1;
    const supplierOptions = supplierIds.map(sid =>
      `<option value="${esc(sid)}" ${sid === sup.supplier ? 'selected' : ''}>${esc((cfg.suppliers[sid] || {}).name || sid)}</option>`
    ).join('');
    suppliersBody += `
      <div class="admin-row" style="margin-bottom: 8px;">
        <div class="admin-row__head">
          <div class="admin-row__title">
            <label style="flex-direction: row; align-items: center; gap: 6px; font-weight: 600;">
              <input type="radio" name="prod-default-${esc(id)}" ${sup.is_default ? 'checked' : ''}
                     data-action-change="set-default-supplier" data-id="${esc(id)}" data-idx="${esc(sidx)}">
              Usar por defecto
            </label>
            ${sup.is_default ? '<span class="badge badge--accent" style="margin-left: 6px;">Por defecto</span>' : ''}
          </div>
          <button type="button" class="admin-row__remove"
                  data-action="remove-product-supplier" data-id="${esc(id)}" data-idx="${esc(sidx)}"
                  ${onlyOne ? 'disabled title="Debe quedar al menos un proveedor"' : 'title="Quitar proveedor"'}
                  aria-label="Quitar proveedor">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Proveedor
            <select data-cfg-path="products.${esc(id)}.suppliers.${esc(sidx)}.supplier">${supplierOptions}</select>
          </label>
          <label>Referencia
            <input type="text" value="${esc(sup.ref || '')}" data-cfg-path="products.${esc(id)}.suppliers.${esc(sidx)}.ref">
          </label>
          <label>Precio base (€) <span class="hint">sin IVA, sin DTF</span>
            <input type="number" step="0.0001" min="0" value="${esc(sup.price ?? 0)}" data-cfg-path="products.${esc(id)}.suppliers.${esc(sidx)}.price">
          </label>
          <label>Pedido mínimo
            <input type="number" step="1" min="0" value="${esc(sup.min_order ?? 0)}" data-cfg-path="products.${esc(id)}.suppliers.${esc(sidx)}.min_order">
          </label>
        </div>
      </div>
    `;
  });
  suppliersBody += `
    <div class="admin-row-add" style="margin-bottom: 12px;">
      <button type="button" class="btn btn-ghost" data-action="add-product-supplier" data-id="${esc(id)}"
              ${supplierIds.length === 0 ? 'disabled title="Crea antes un proveedor"' : ''}>
        <svg class="icon"><use href="#i-plus"/></svg> Añadir proveedor a este producto
      </button>
    </div>
  `;

  // --- Price table (extract lines ~269-290 into `pricesBody`) ---
  let pricesBody = '';
  for (const [faceKey, faceLabel] of PRICE_FACES) {
    pricesBody += `<div class="admin-subhead">${faceLabel}</div>`;
    pricesBody += '<div class="admin-grid">';
    for (const t of cfg.tiers) {
      const value = p.prices?.[faceKey]?.[t.id];
      pricesBody += `
        <label>${esc(t.id)} · ${esc(t.label || '')}
          <input type="number" step="0.01" min="0" value="${esc(value ?? 0)}" data-cfg-path="products.${esc(id)}.prices.${esc(faceKey)}.${esc(t.id)}">
        </label>
      `;
    }
    pricesBody += '</div>';
  }
  pricesBody += `
    <div class="admin-row-add" style="margin-top: 6px;">
      <button type="button" class="btn btn-secondary" data-action="apply-recommended-product" data-id="${esc(id)}">
        <svg class="icon"><use href="#i-trend"/></svg> Aplicar PVP recomendado
      </button>
      <span class="hint" style="margin-left: 10px;">${esc(recommendedHint(cfg, p))}</span>
    </div>
  `;

  return `
    ${renderEditorHead(`Editar producto: ${esc(p.name || id)}`)}
    ${basic}
    ${wrapCollapsible('Proveedores', suppliersBody, `products:${id}:suppliers`)}
    ${wrapCollapsible('PVP por caras y tramo (IVA incl.)', pricesBody, `products:${id}:prices`)}
  `;
}
```

> The bodies above are the exact current markup with the `admin-mini-head` headings replaced by the `wrapCollapsible` label. Verify against lines 199-290 of the pre-change file if anything looks off.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/admin.test.js -t "products"`
Expected: PASS (the migrated badge/render tests + the new list/editor tests).

- [ ] **Step 5: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): products list + focused editor with collapsible sections"
```

---

## Task 7: Packs — list + editor (extraction)

Same split for packs (`renderAdminPacks`, lines ~445-529). The helpers `renderPackOptions`, `renderPackComponents`, `renderBundlePrices`, `packColorToken` stay unchanged.

**Files:**
- Modify: `renderer/admin.js` — replace `renderAdminPacks` with `renderPacksList` + `renderPackEditor`
- Test: `tests/admin.test.js`

- [ ] **Step 1: Write the failing tests**

Extend the import with `renderPacksList, renderPackEditor` and remove `renderAdminPacks`. Add:

```js
describe('packs list + editor', () => {
  test('list shows a row per pack with the colour dot and search data', () => {
    const html = renderPacksList(freshCfg(), '');
    expect(html).toContain('class="admin-search__input"');
    expect(html).toContain('data-id="crew_full"');
    expect(html).toContain('data-edit="crew_full"');
    expect(html).not.toContain('data-cfg-path="packs.crew_full.name"'); // not inline
  });

  test('editor renders one pack with collapsible options/components/prices', () => {
    const html = renderPackEditor(freshCfg(), 'crew_full');
    expect(html).toContain('data-back');
    expect(html).toContain('data-cfg-path="packs.crew_full.name"');
    expect(html).toContain('data-section="packs:crew_full:options"');
    expect(html).toContain('data-section="packs:crew_full:components"');
    expect(html).toContain('data-section="packs:crew_full:prices"');
    expect(html).not.toContain('data-cfg-path="packs.tshirts_only.name"'); // only crew_full
  });

  test('editor guards a missing id', () => {
    expect(renderPackEditor(freshCfg(), 'NOPE')).toContain('no encontrado');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "packs list"`
Expected: FAIL — `renderPacksList is not defined`.

- [ ] **Step 3: Implement — split the existing function**

In `renderer/admin.js`, replace `renderAdminPacks` (lines ~445-529) with:

```js
export function renderPacksList(cfg, query = '') {
  const entries = Object.entries(cfg.packs || {});
  const total = entries.length;
  let count = 0;
  let rows = '';
  let idx = 0;
  for (const [id, pack] of entries) {
    const colorToken = packColorToken(id, idx);
    idx++;
    const modeLabel = pack.pricing_mode === 'bundle' ? 'Por unidad' : 'Por componentes';
    const hay = buildHaystack([id, pack.name, pack.description]);
    const show = matchesQuery(hay, query);
    if (show) count++;
    rows += `
      <div class="admin-list__row${show ? '' : ' is-hidden'}" data-id="${esc(id)}"
           data-edit="${esc(id)}" data-search="${esc(hay)}" style="--pack-color: var(${colorToken});">
        <span class="admin-pack__dot"></span>
        <strong class="admin-list__name">${esc(pack.name || id)}</strong>
        <span class="admin-list__meta">${modeLabel}</span>
        <span class="admin-list__actions">
          <button type="button" class="btn btn-ghost btn-sm" data-edit="${esc(id)}">Editar</button>
          <button type="button" class="admin-row__remove"
                  data-action="remove-pack" data-id="${esc(id)}"
                  title="Eliminar pack" aria-label="Eliminar pack ${esc(id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </span>
      </div>
    `;
  }
  return `
    <p class="hint" style="margin-bottom: 16px;">Crea y edita packs completos: opciones (caras, capucha…), componentes (productos y, en packs por unidad, cuántos por pack) y, en modo «por unidad» (bundle), la tabla de PVP por combinación y tramo. Los packs «por componentes» usan el PVP de cada producto (pestaña Productos).</p>
    ${renderListToolbar(query, count, total)}
    <div class="admin-list">
      ${rows}
      <div class="admin-empty"${count ? ' hidden' : ''}>Sin resultados${query ? ` para «${esc(query)}»` : ''}.</div>
    </div>
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-action="add-pack">
        <svg class="icon"><use href="#i-plus"/></svg> Crear pack
      </button>
    </div>
  `;
}

export function renderPackEditor(cfg, id) {
  const pack = cfg.packs?.[id];
  if (!pack) return renderEditorNotFound('Pack');

  // Identity grid (from old loop body, lines ~470-499)
  const identity = `
    <div class="admin-grid">
      <label>Nombre
        <input type="text" value="${esc(pack.name || '')}" data-cfg-path="packs.${esc(id)}.name">
      </label>
      <label>Descripción
        <input type="text" value="${esc(pack.description || '')}" data-cfg-path="packs.${esc(id)}.description">
      </label>
      <label>Icono <span class="hint">id de icono (ej. i-pack)</span>
        <input type="text" value="${esc(pack.icon || '')}" data-cfg-path="packs.${esc(id)}.icon">
      </label>
      <label>Mínimo total (uds)
        <input type="number" step="1" min="1" value="${esc(pack.min_total ?? 1)}" data-cfg-path="packs.${esc(id)}.min_total">
      </label>
      <label>Margen objetivo <span class="hint">decimal · vacío usa el global</span>
        <input type="number" step="0.01" min="0" max="0.99" value="${esc(pack.target_margin ?? '')}" data-cfg-path="packs.${esc(id)}.target_margin">
      </label>
      <label>Modo de precio
        <select data-action-change="set-pricing-mode" data-id="${esc(id)}">
          <option value="bundle" ${pack.pricing_mode === 'bundle' ? 'selected' : ''}>Por unidad (bundle)</option>
          <option value="components" ${pack.pricing_mode === 'components' ? 'selected' : ''}>Por componentes</option>
        </select>
      </label>
      <label style="flex-direction: row; align-items: center; gap: 8px;">
        <input type="checkbox" ${pack.free_components ? 'checked' : ''}
               data-action-change="toggle-free-components" data-id="${esc(id)}">
        Componentes libres (el usuario elige productos)
      </label>
    </div>
  `;

  const productIds = Object.keys(cfg.products || {});

  // Components body (reuses the existing helpers).
  const componentsBody = pack.free_components
    ? '<p class="hint">Pack de componentes libres: el usuario añade líneas con cualquier producto del catálogo.</p>'
    : renderPackComponents(cfg, id, pack, productIds);

  // Prices body (reuses the existing helper).
  const pricesBody = pack.pricing_mode === 'bundle'
    ? renderBundlePrices(cfg, id, pack)
    : '<p class="hint">Este pack factura cada componente al PVP de su producto. Edita los precios en la pestaña <strong>Productos</strong>.</p>';

  return `
    ${renderEditorHead(`Editar pack: ${esc(pack.name || id)}`)}
    ${identity}
    ${wrapCollapsible('Opciones', renderPackOptions(cfg, id, pack), `packs:${id}:options`)}
    ${wrapCollapsible('Componentes', componentsBody, `packs:${id}:components`)}
    ${wrapCollapsible('Precios', pricesBody, `packs:${id}:prices`)}
  `;
}
```

> `renderPackOptions`, `renderPackComponents`, `renderBundlePrices` already emit their own `admin-mini-head` label inside; that is fine — the collapsible adds the section header above and the existing mini-head becomes a sub-label. If the doubled heading looks redundant in smoke (Task 11), drop the leading `<div class="admin-mini-head">…</div>` line inside those three helpers. Note it but do not block on it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/admin.test.js -t "packs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): packs list + focused editor with collapsible sections"
```

---

## Task 8: Router — route list vs editor

`renderAdminTabContent` gains `view` and `id` and dispatches catalog tabs to list or editor.

**Files:**
- Modify: `renderer/admin.js` — `renderAdminTabContent` (lines ~684-694)
- Test: `tests/admin.test.js` — the `describe('router')` block

- [ ] **Step 1: Update the router tests (they currently assume the old all-forms render)**

Replace the existing `describe('router')` `renderAdminTabContent` test with:

```js
describe('router', () => {
  test('catalog tabs default to the list view', () => {
    const cfg = freshCfg();
    const products = renderAdminTabContent(cfg, 'products');
    expect(products).toContain('class="admin-search__input"');
    expect(products).toContain('data-edit="BEAGLE"');

    expect(renderAdminTabContent(cfg, 'suppliers')).toContain('data-edit="ROLY"');
    expect(renderAdminTabContent(cfg, 'addons')).toContain('data-edit="name"');
    expect(renderAdminTabContent(cfg, 'packs')).toContain('data-edit="crew_full"');
  });

  test('catalog tabs render the editor when view=editor', () => {
    const cfg = freshCfg();
    expect(renderAdminTabContent(cfg, 'products', 'editor', 'BEAGLE'))
      .toContain('data-cfg-path="products.BEAGLE.name"');
    expect(renderAdminTabContent(cfg, 'packs', 'editor', 'crew_full'))
      .toContain('data-cfg-path="packs.crew_full.name"');
  });

  test('non-catalog tabs are unaffected', () => {
    const cfg = freshCfg();
    expect(renderAdminTabContent(cfg, 'parameters')).toContain('parameters.vat');
    expect(renderAdminTabContent(cfg, 'tiers')).toContain('tiers.0.label');
    expect(renderAdminTabContent(cfg, 'unknown')).toBe('');
  });

  test('unknown action returns an error', () => {
    expect(executeAdminAction(freshCfg(), { action: 'nope' }).error).toBeTruthy();
  });
});
```

Also fix the `describe('no v3 shape leaks in rendered HTML')` block: it calls the removed `renderAdminSuppliers/Products/Addons/Packs`. Replace its `all` array with:

```js
    const all = [
      renderAdminParameters(cfg),
      renderSuppliersList(cfg, ''),
      renderSupplierEditor(cfg, 'ROLY'),
      renderProductsList(cfg, ''),
      renderProductEditor(cfg, 'BEAGLE'),
      renderAddonsList(cfg, ''),
      renderAddonEditor(cfg, 'name'),
      renderAdminTiers(cfg),
      renderPacksList(cfg, ''),
      renderPackEditor(cfg, 'crew_full')
    ].join('\n');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/admin.test.js -t "router"`
Expected: FAIL — current `renderAdminTabContent` ignores `view`/`id` and routes `'products'` to the removed function (ReferenceError or wrong content).

- [ ] **Step 3: Implement the router**

In `renderer/admin.js`, replace `renderAdminTabContent`:

```js
export function renderAdminTabContent(cfg, tab, view = 'list', id = null) {
  switch (tab) {
    case 'parameters': return renderAdminParameters(cfg);
    case 'tiers':      return renderAdminTiers(cfg);
    case 'suppliers':  return view === 'editor' ? renderSupplierEditor(cfg, id) : renderSuppliersList(cfg, '');
    case 'products':   return view === 'editor' ? renderProductEditor(cfg, id)  : renderProductsList(cfg, '');
    case 'addons':     return view === 'editor' ? renderAddonEditor(cfg, id)    : renderAddonsList(cfg, '');
    case 'packs':      return view === 'editor' ? renderPackEditor(cfg, id)     : renderPacksList(cfg, '');
    default:           return '';
  }
}
```

> The list functions take a `query` but the router passes `''`; `app.js` passes the live query directly to the list renderers (Task 9), so the router default is fine for tests and first render.

- [ ] **Step 4: Run the full admin test file**

Run: `pnpm exec vitest run tests/admin.test.js`
Expected: PASS (entire file green — all migrations done).

- [ ] **Step 5: Run the whole suite (catch cross-file breakage)**

Run: `pnpm test`
Expected: PASS. (If `tests/admin-extras.test.js` or others imported a removed function, fix the import; none should, but confirm.)

- [ ] **Step 6: Commit**

```bash
git add renderer/admin.js tests/admin.test.js
git commit -m "feat(admin): route catalog tabs to list or focused editor"
```

---

## Task 9: Wire navigation, search, and section persistence in `app.js`

DOM wiring (not unit-tested here — verified by manual smoke in Task 11).

**Files:**
- Modify: `renderer/app.js` — `state` (~107), imports (~29), `showAdminTab` (~2393-2494), and the admin open/close handlers

- [ ] **Step 1: Extend `state`**

Replace the `state` object (lines ~107-112) with:

```js
const state = {
  packId: null,
  isAdmin: false,
  adminTab: 'parameters',
  showCosts: false,            // secret shortcut: 3 × "." toggles the view

  // Admin catalog list/editor (kept out of the DOM because showAdminTab
  // re-renders the whole tab on every structural action).
  adminView: 'list',           // 'list' | 'editor' (catalog tabs only)
  adminEditingId: null,        // entity id shown in the editor
  adminSearch: { products: '', packs: '', suppliers: '', addons: '' },
  adminClosedSections: new Set() // section keys the user collapsed
};
```

- [ ] **Step 2: Import the list renderers**

In the `import { ... } from './admin.js'` block (around line 29), add the four list renderers and the four editor renderers used by name only if needed. The router already dispatches, so `app.js` needs the **list** renderers only for live search re-render. Add to the import:

```js
  renderProductsList,
  renderPacksList,
  renderSuppliersList,
  renderAddonsList,
```

- [ ] **Step 3: Add a catalog-tab predicate and reset-on-switch**

Near `ADMIN_TAB_META` (around line 128), add:

```js
const CATALOG_TABS = new Set(['products', 'packs', 'suppliers', 'addons']);

function listRendererFor(tab) {
  switch (tab) {
    case 'products':  return renderProductsList;
    case 'packs':     return renderPacksList;
    case 'suppliers': return renderSuppliersList;
    case 'addons':    return renderAddonsList;
    default:          return null;
  }
}
```

In `showAdminTab(tab, opts)`, at the very top after `state.adminTab = tab;` (line ~2394), add a reset when arriving at a tab not via an in-tab re-render:

```js
  // Arriving at a tab (not an in-editor re-render) starts on the list.
  if (!opts.keepView) {
    state.adminView = 'list';
    state.adminEditingId = null;
  }
```

- [ ] **Step 4: Render list vs editor for catalog tabs**

In `showAdminTab`, the catalog tabs currently fall through to `cont.innerHTML = renderAdminTabContent(CFG, tab)` (line ~2439). Replace that single line with:

```js
  if (CATALOG_TABS.has(tab)) {
    const query = state.adminSearch[tab] || '';
    if (state.adminView === 'editor' && state.adminEditingId) {
      cont.innerHTML = renderAdminTabContent(CFG, tab, 'editor', state.adminEditingId);
    } else {
      cont.innerHTML = listRendererFor(tab)(CFG, query);
    }
  } else {
    cont.innerHTML = renderAdminTabContent(CFG, tab);
  }
```

- [ ] **Step 5: Wire the editor `<details>` persistence, search, and navigation**

After the existing `enhanceDropdowns(cont);` and the `data-cfg-path` / `data-action` wiring (after line ~2489, before the `scrollPrev` restore), add:

```js
  if (CATALOG_TABS.has(tab)) {
    // Editor: re-apply the user's collapsed sections and track toggles.
    cont.querySelectorAll('details[data-section]').forEach(d => {
      const key = d.dataset.section;
      if (state.adminClosedSections.has(key)) d.open = false;
      d.addEventListener('toggle', () => {
        if (d.open) state.adminClosedSections.delete(key);
        else state.adminClosedSections.add(key);
      });
    });

    // List: live search (DOM filter, no re-render so focus is kept).
    const searchInput = cont.querySelector('.admin-search__input');
    if (searchInput) {
      const countEl = cont.querySelector('.admin-list-count');
      const emptyEl = cont.querySelector('.admin-empty');
      const rowsEls = Array.from(cont.querySelectorAll('.admin-list__row'));
      const applyFilter = () => {
        const q = searchInput.value;
        state.adminSearch[tab] = q;
        let shown = 0;
        rowsEls.forEach(row => {
          const match = matchesQuery(row.dataset.search || '', q);
          row.classList.toggle('is-hidden', !match);
          if (match) shown++;
        });
        if (countEl) {
          countEl.textContent = `${shown} de ${rowsEls.length}`;
          countEl.hidden = !q.trim();
        }
        if (emptyEl) emptyEl.hidden = shown !== 0;
      };
      searchInput.addEventListener('input', applyFilter);
    }

    // List: open the editor on a row click. Bind to the ROW only — the
    // inner "Editar" button carries no data-action, so its click bubbles
    // up to this same handler (one open, not two). The remove button has
    // data-action, so we bail out and let its own handler run instead.
    cont.querySelectorAll('.admin-list__row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return; // remove button → skip
        state.adminView = 'editor';
        state.adminEditingId = row.dataset.edit;
        showAdminTab(tab, { keepView: true });
      });
    });
    const backBtn = cont.querySelector('[data-back]');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        state.adminView = 'list';
        state.adminEditingId = null;
        showAdminTab(tab, { keepView: true });
      });
    }
  }
```

Import `matchesQuery` from `./admin.js` (add to the same import block as Step 2).

- [ ] **Step 6: "Añadir" opens the new entity's editor**

The add buttons use `data-action="add-*"`, handled by the existing `runAction`. Update **both** branches of `runAction` (inside `showAdminTab`, around line ~2456) to (a) keep the editor view on re-render and (b) jump into the editor after a top-level add. Replace the existing error and dirty branches:

```js
    if (result && result.error) {
      await window.packprice.showError({
        titulo: 'Acción no permitida',
        mensaje: result.error
      });
      // Re-render so a rejected toggle snaps back — but stay where we are.
      showAdminTab(tab, { keepView: true, preserveScroll: true });
      return;
    }
    if (result && result.dirty) {
      if (CATALOG_TABS.has(tab) && result.id && String(dataset.action || '').startsWith('add-')) {
        state.adminView = 'editor';
        state.adminEditingId = result.id;
        showAdminTab(tab, { keepView: true });
      } else {
        showAdminTab(tab, { keepView: true, preserveScroll: true });
      }
      return;
    }
```

> Why `keepView: true` on the error branch too: a rejected action inside the editor (e.g. "can't remove the last supplier") must NOT kick the user back to the list. Structural actions **inside** the editor (e.g. `add-product-supplier`) re-render in place. Only top-level `add-*` (add-product/pack/supplier/addon) carries a `result.id` and switches to the editor.

- [ ] **Step 7: Reset view when the admin modal opens/closes**

Find where the admin modal is opened (search `showAdminTab(state.adminTab)` — around lines 2382 and 2765) and where it closes. At the open site and close site, reset:

```js
  state.adminView = 'list';
  state.adminEditingId = null;
  state.adminClosedSections.clear();
```

Place the reset immediately before the `showAdminTab(state.adminTab)` call that opens the editor modal (line ~2382), and in the close handler for `#btn-cerrar-admin`.

- [ ] **Step 8: Manual smoke (no unit test for DOM wiring)**

Run: `pnpm dev`
Verify:
1. Open Admin → Productos: shows a search box + compact rows, all collapsed (no inline forms).
2. Type in the search box: rows filter live, "N de M" updates, cursor stays in the box.
3. Click a row / "Editar": opens the editor for that product; "← Volver" returns to the list with the search text preserved.
4. In the editor, collapse "PVP por caras y tramo", click "Añadir proveedor a este producto" → after re-render you are still in the editor and the section stays collapsed.
5. Click "Añadir producto" → editor opens directly on the new product.
6. Repeat spot-checks for Packs, Proveedores, Complementos.
7. Edit a field, "Guardar" at the footer still saves (conflict check intact).

- [ ] **Step 9: Commit**

```bash
git add renderer/app.js
git commit -m "feat(admin): wire list/editor navigation, live search, section persistence"
```

---

## Task 10: CSS — list, search, editor, collapsible, responsive modal

**Files:**
- Modify: `renderer/styles.css` — `.modal` (~1304), `.admin-grid` (~1449), and new classes; the breakpoints (~1700-1776)
- Modify: `renderer/index.html` — add the `#i-search` SVG symbol next to the other symbols (~line 13)

- [ ] **Step 1: Add the search icon symbol**

In `renderer/index.html`, next to the existing `<symbol id="i-pack" …>` (around line 13), add:

```html
<symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
```

(If an `i-search` symbol already exists, skip this step.)

- [ ] **Step 2: Responsive modal width + fluid grid**

In `renderer/styles.css`, change `.modal` `max-width` (line ~1308) from `920px` to:

```css
  max-width: min(1380px, 95vw);
```

Change `.admin-grid` `grid-template-columns` (line ~1451) from `1fr 1fr` to:

```css
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
```

- [ ] **Step 3: Add the new component styles**

Append to `renderer/styles.css` (near the other admin styles, after `.admin-row-add` ~line 1596):

```css
/* ---- Admin catalog: search bar + compact list ---- */
.admin-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 10px;
}
.admin-search__icon {
  position: absolute;
  left: 12px;
  color: var(--fg-muted);
  pointer-events: none;
}
.admin-search__input {
  width: 100%;
  padding-left: 38px;
}
.admin-list-count {
  font-size: 12px;
  color: var(--fg-muted);
  margin-bottom: 8px;
}
.admin-list { display: flex; flex-direction: column; gap: 8px; }
.admin-list__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-tertiary);
  cursor: pointer;
}
.admin-list__row:hover { border-color: var(--border-strong); }
.admin-list__row.is-hidden { display: none; }
.admin-list__name { font-size: 13px; flex: 1; min-width: 0; }
.admin-list__meta {
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.admin-list__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}
.btn-sm { padding: 5px 10px; font-size: 12px; }
.admin-empty {
  padding: 18px;
  text-align: center;
  color: var(--fg-muted);
  font-size: 13px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
}

/* ---- Admin catalog: focused editor ---- */
.admin-editor__head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.admin-editor__title { font-size: 16px; }

/* ---- Collapsible section (native <details>) ---- */
.admin-section {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.admin-section__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--fg-secondary);
  list-style: none;
  user-select: none;
}
.admin-section__head::-webkit-details-marker { display: none; }
.admin-section__caret { transition: transform 0.15s ease; flex-shrink: 0; }
.admin-section[open] > .admin-section__head .admin-section__caret { transform: rotate(180deg); }
.admin-section__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 14px 14px;
}
```

- [ ] **Step 4: Responsive — list rows on narrow screens**

In the `@media (max-width: 600px)` block (around line 1740-1776), add:

```css
  .admin-list__row { flex-wrap: wrap; }
  .admin-list__actions { width: 100%; justify-content: flex-end; }
```

- [ ] **Step 5: Manual smoke (visual)**

Run: `pnpm dev`
Verify:
1. Search bar shows the lupa icon; rows look like a clean list.
2. Editor sections have a rotating caret; collapsing/expanding is smooth.
3. Resize the window wide → the modal grows toward ~1380px and `.admin-grid` shows more columns; narrow → it collapses to one column and the modal goes full-screen at ≤600px.

- [ ] **Step 6: Commit**

```bash
git add renderer/styles.css renderer/index.html
git commit -m "style(admin): list/search/editor/collapsible styles + responsive modal"
```

---

## Task 11: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (§5 project structure note if needed), `ARCHITECTURE.md` (only if a pattern changed), `docs/UI-UX.md` (admin states)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS, all files. Fix any failure before continuing.

- [ ] **Step 2: Full smoke per the repo checklist + this feature**

Run: `pnpm dev` and walk the CLAUDE.md §8 smoke checklist (first run with `%APPDATA%\packprice\` deleted; crew pack T1 with/without hood; mixed pack two quantities; admin conflict). Then this feature's flow from Task 9 Step 8 across all four catalog tabs.

- [ ] **Step 3: Update docs**

In `docs/UI-UX.md`, document the admin catalog list→editor states (list with search, focused editor with collapsible sections). Keep it short. If `ARCHITECTURE.md` describes the admin render flow, note the list/editor split and that UI state lives in `state` (re-applied after re-render). No schema or rule changed, so CLAUDE.md needs no rule edit.

- [ ] **Step 4: Commit**

```bash
git add docs/UI-UX.md ARCHITECTURE.md
git commit -m "docs(admin): document catalog list + focused editor UI"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Desplegables / index view → Tasks 6/7 list rows + Task 3 `wrapCollapsible` in editors ✓
- Buscador (4 tabs, accent-insensitive, live) → Task 1 helpers + Tasks 4-7 list `data-search` + Task 9 filter ✓
- Focused editor (master/detail, 4 entities) → Tasks 4-8 ✓
- Save model unchanged → Task 9 keeps `data-cfg-path`/footer save; no per-entity save ✓
- Responsive (both directions) → Task 10 `.modal` + `.admin-grid` + breakpoints ✓
- State outside DOM → Task 9 `state` extension ✓
- Add opens new editor → Task 2 (`id`) + Task 9 Step 6 ✓
- Non-catalog tabs untouched → Task 8 router keeps `parameters`/`tiers`/`audit` ✓

**Placeholder scan:** No TBD/TODO; all new code and tests are shown in full; extraction blocks for products/packs are reproduced verbatim with source line references. ✓

**Type consistency:** `normalizeText`, `matchesQuery`, `buildHaystack`, `renderListToolbar(query,count,total)`, `wrapCollapsible(label,body,sectionKey)`, `render{Suppliers,Products,Addons,Packs}List(cfg,query)`, `render{Supplier,Product,Addon,Pack}Editor(cfg,id)`, `renderAdminTabContent(cfg,tab,view,id)`, `add*` → `{dirty,id}`, `state.adminClosedSections` (Set), `data-edit`/`data-back`/`data-section`/`data-search` attributes — used consistently across tasks. ✓
