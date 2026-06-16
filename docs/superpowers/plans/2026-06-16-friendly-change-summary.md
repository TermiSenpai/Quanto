# Friendly Change Summary (no raw JSON) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw paths/JSON shown when saving/auditing catalog changes with friendly, per-entity messages (badge + name + human field rows with formatted values), driven by one shared pure module.

**Architecture:** A new pure renderer module `renderer/change-format.js` turns structured diff entries (`{path, before, after, kind}`) into human Spanish text and grouped HTML. The five display sites (file confirm, cloud confirm, conflict modal, file audit, cloud history) all route through it. `renderer/save-summary.js` is refactored to emit structured groups instead of pre-formatted strings. `main.js`/`lib/` and the persisted `audit.log` format are untouched.

**Tech Stack:** Vanilla JS ES modules (renderer, no build), HTML, CSS. Tests: Vitest (Node, no DOM) for the pure module + adapted save-summary/admin-extras tests. DOM glue verified by `node --check` + manual smoke.

**Spec:** `docs/superpowers/specs/2026-06-16-friendly-change-summary-design.md`

**Conventions (CLAUDE.md):** ES modules, `const`, 2-space indent, single quotes, semicolons. **UI strings Spanish, identifiers/comments English.** Escape every interpolation. No new deps. No `git --no-verify`/`--force`. Per rule #10, confirm with the user before the first commit; commit steps are the recipe, not permission.

**Test commands:**
- A pure file: `pnpm exec vitest run tests/change-format.test.js`
- By name: `pnpm exec vitest run tests/change-format.test.js -t "formatValue"`
- Full suite: `pnpm test`

---

## Key facts from the codebase (read before starting)

- `renderer/admin-extras.js#renderChangeRow(change)` is shared by: file confirm (`renderDiffPreview`), file audit (`renderAuditTab` → `entry.changes`), and cloud history (`renderCloudAuditList` → `renderCloudDiff` → `entry.diff`). It consumes `{path, before, after, kind}`.
- **Path shapes differ:** file side (whole-config diff in main) → FULL paths like `suppliers.SUPPLIER_1.name`; cloud side (`lib/catalog-writer.js:202` diffs the entity slice) → RELATIVE paths like `name`, with `entityType`/`entityId` carried separately on the entry.
- Cloud confirm uses `renderer/save-summary.js#buildSaveSummary(oldCfg, newCfg)` → currently `{ entityType, id, lines: string[] }`.
- The conflict modal (`app.js#renderConflictBody`→`renderValueRows`) dumps the entity's `key: value` pairs raw (not a diff).
- `renderer/admin.js` holds the parameter label dictionary (`PARAMETER_GROUPS`, `key→label`); reuse it via a new export.
- `tests/save-summary.test.js` has a **drift-guard** asserting `buildSaveSummary` lines equal `lib/diff.js` lines. The refactor must keep an equivalent guard (compare structured `fieldChanges` formatted with `lib/diff.js#formatChangeLine`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `renderer/change-format.js` | The humanizer: path parsing, labels, value formatting, grouping, group HTML | **Create** |
| `renderer/admin.js` | Admin render + parameter labels | Add `export function parameterLabel(key)` |
| `renderer/save-summary.js` | Cloud confirm grouping | Refactor `buildSaveSummary`/`totalChanges` to structured groups |
| `renderer/admin-extras.js` | File confirm + audit/history render | Route `renderChangeRow`/`renderDiffPreview` through the humanizer |
| `renderer/app.js` | Cloud confirm + conflict render glue | `renderSaveSummary`/`renderValueRows`/`renderCloudAuditList` use the humanizer |
| `renderer/styles.css` | Styling | Badge + group + field-row styles |
| `tests/change-format.test.js` | Unit tests for the humanizer | **Create** |
| `tests/save-summary.test.js` | Cloud grouping tests + drift guard | Adapt to structured shape |
| `tests/admin-extras.test.js` | Audit/diff render tests | Adapt assertions to friendly output |

---

## Task 1: `change-format.js` — path & entity helpers

**Files:**
- Create: `renderer/change-format.js`
- Test: `tests/change-format.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/change-format.test.js`:

```js
import { describe, test, expect } from 'vitest';
import {
  parsePath, entityTypeLabel, entityName, kindBadge
} from '../renderer/change-format.js';

describe('parsePath', () => {
  test('per-id entity field', () => {
    expect(parsePath('suppliers.SUPPLIER_1.name'))
      .toEqual({ entityType: 'supplier', id: 'SUPPLIER_1', rel: 'name' });
  });
  test('per-id nested array field', () => {
    expect(parsePath('products.BEAGLE.suppliers[0].price'))
      .toEqual({ entityType: 'product', id: 'BEAGLE', rel: 'suppliers[0].price' });
  });
  test('entity root (whole add/remove) → empty rel', () => {
    expect(parsePath('suppliers.SUPPLIER_1'))
      .toEqual({ entityType: 'supplier', id: 'SUPPLIER_1', rel: '' });
  });
  test('global singleton', () => {
    expect(parsePath('parameters.vat'))
      .toEqual({ entityType: 'parameters', id: null, rel: 'vat' });
  });
  test('global with array index', () => {
    expect(parsePath('tiers[1].to'))
      .toEqual({ entityType: 'tiers', id: null, rel: '[1].to' });
  });
  test('unknown top-level section falls back to itself', () => {
    expect(parsePath('weird.path')).toEqual({ entityType: 'weird', id: null, rel: 'path' });
  });
});

describe('entityTypeLabel', () => {
  test('maps known types', () => {
    expect(entityTypeLabel('supplier')).toBe('Proveedor');
    expect(entityTypeLabel('product')).toBe('Producto');
    expect(entityTypeLabel('pack')).toBe('Pack');
    expect(entityTypeLabel('addon')).toBe('Complemento');
    expect(entityTypeLabel('parameters')).toBe('Parámetros de cálculo');
    expect(entityTypeLabel('tiers')).toBe('Tramos por volumen');
    expect(entityTypeLabel('company')).toBe('Empresa');
  });
});

describe('entityName', () => {
  test('prefers name, then label, then id', () => {
    expect(entityName('supplier', { name: 'Valento' }, 'SUPPLIER_1')).toBe('Valento');
    expect(entityName('addon', { label: 'Bolsillo' }, 'a1')).toBe('Bolsillo');
    expect(entityName('product', {}, 'BEAGLE')).toBe('BEAGLE');
    expect(entityName('product', null, 'BEAGLE')).toBe('BEAGLE');
  });
});

describe('kindBadge', () => {
  test('label + css class per kind', () => {
    expect(kindBadge('add')).toEqual({ label: 'Nuevo', cls: 'add' });
    expect(kindBadge('remove')).toEqual({ label: 'Eliminado', cls: 'remove' });
    expect(kindBadge('edit')).toEqual({ label: 'Editado', cls: 'change' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/change-format.test.js`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Implement the helpers**

Create `renderer/change-format.js`:

```js
// ============================================================
// Quanto · Change humanizer (pure, renderer)
// ============================================================
// Turns structured diff entries ({path, before, after, kind}) into
// friendly Spanish text and grouped HTML for every place that shows
// catalog changes: the file/cloud save-confirm modals, the conflict
// modal, and the file/cloud audit views.
//
// Pure: no DOM, no IPC. UI strings Spanish, identifiers/comments
// English (CLAUDE.md §2/§4.5). Never emits raw JSON or dotted paths;
// unknown fields get a readable fallback label.
// ============================================================

'use strict';

// cfg section name → singular entity type used across the UI.
const SECTION_TO_TYPE = {
  suppliers: 'supplier',
  products: 'product',
  addons: 'addon',
  packs: 'pack'
};

const GLOBAL_SECTIONS = new Set(['parameters', 'tiers', 'company']);

const ENTITY_TYPE_LABEL = {
  supplier: 'Proveedor',
  product: 'Producto',
  pack: 'Pack',
  addon: 'Complemento',
  parameters: 'Parámetros de cálculo',
  tiers: 'Tramos por volumen',
  company: 'Empresa'
};

/**
 * Splits a full diff path into entity type + id + entity-relative path.
 * - "suppliers.SUPPLIER_1.name" → { entityType:'supplier', id:'SUPPLIER_1', rel:'name' }
 * - "suppliers.SUPPLIER_1"      → { ..., rel:'' }  (whole-entity add/remove)
 * - "parameters.vat"           → { entityType:'parameters', id:null, rel:'vat' }
 * - "tiers[1].to"              → { entityType:'tiers', id:null, rel:'[1].to' }
 */
export function parsePath(fullPath) {
  const path = String(fullPath || '');
  // First segment is the section, up to the first '.' or '['.
  const m = /^([^.[]+)(.*)$/.exec(path);
  const section = m ? m[1] : path;
  let rest = m ? m[2] : '';

  if (GLOBAL_SECTIONS.has(section)) {
    // rest is ".vat" or "[1].to" → strip a leading dot only.
    const rel = rest.startsWith('.') ? rest.slice(1) : rest;
    return { entityType: section, id: null, rel };
  }

  const entityType = SECTION_TO_TYPE[section] || section;
  if (SECTION_TO_TYPE[section]) {
    // rest starts with ".<id>" then optional ".<rel>" / "[i]…".
    rest = rest.startsWith('.') ? rest.slice(1) : rest;
    const idMatch = /^([^.[]+)(.*)$/.exec(rest);
    const id = idMatch ? idMatch[1] : rest;
    let rel = idMatch ? idMatch[2] : '';
    rel = rel.startsWith('.') ? rel.slice(1) : rel;
    return { entityType, id, rel };
  }

  // Unknown section: treat as a global-ish fallback.
  const rel = rest.startsWith('.') ? rest.slice(1) : rest;
  return { entityType: section, id: null, rel };
}

export function entityTypeLabel(entityType) {
  return ENTITY_TYPE_LABEL[entityType] || entityType || 'Elemento';
}

/** Display name for an entity: name → label → id. */
export function entityName(entityType, entityObj, id) {
  const o = entityObj || {};
  return o.name || o.label || id || '';
}

/** Badge text + colour class (reuses audit-change--add/remove/change). */
export function kindBadge(kind) {
  if (kind === 'add') return { label: 'Nuevo', cls: 'add' };
  if (kind === 'remove') return { label: 'Eliminado', cls: 'remove' };
  return { label: 'Editado', cls: 'change' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/change-format.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/change-format.js tests/change-format.test.js
git commit -m "feat(change-format): path + entity helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `fieldLabel` dictionary (+ export `parameterLabel` from admin.js)

**Files:**
- Modify: `renderer/admin.js` (add `parameterLabel` export near `PARAMETER_GROUPS`, ~line 60)
- Modify: `renderer/change-format.js`
- Test: `tests/change-format.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/change-format.test.js` (extend the import with `fieldLabel`):

```js
describe('fieldLabel', () => {
  test('supplier fields', () => {
    expect(fieldLabel('supplier', 'name')).toBe('Nombre');
    expect(fieldLabel('supplier', 'web')).toBe('Web');
    expect(fieldLabel('supplier', 'notes')).toBe('Notas');
  });
  test('product simple + indexed + nested-table fields', () => {
    expect(fieldLabel('product', 'target_margin')).toBe('Margen objetivo');
    expect(fieldLabel('product', 'extra_cost_3xl')).toBe('Coste extra 3XL');
    expect(fieldLabel('product', 'suppliers[0].price')).toBe('Proveedor 1 · Precio base');
    expect(fieldLabel('product', 'prices.two_sides.T1')).toBe('PVP · 2 caras · Tramo T1');
    expect(fieldLabel('product', 'prices.one_side.T3')).toBe('PVP · 1 cara · Tramo T3');
  });
  test('pack fields', () => {
    expect(fieldLabel('pack', 'pricing_mode')).toBe('Modo de precio');
    expect(fieldLabel('pack', 'free_components')).toBe('Componentes libres');
    expect(fieldLabel('pack', 'options[0].values[1].label')).toBe('Opción 1 · Valor 2 · Etiqueta');
    expect(fieldLabel('pack', 'bundle_prices.two_sides.T1')).toBe('PVP · two_sides · Tramo T1');
  });
  test('addon fields', () => {
    expect(fieldLabel('addon', 'label')).toBe('Etiqueta');
    expect(fieldLabel('addon', 'vat_included')).toBe('IVA incluido');
  });
  test('parameters reuse admin labels', () => {
    expect(fieldLabel('parameters', 'vat')).toBe('IVA aplicado');
    expect(fieldLabel('parameters', 'default_target_margin')).toBe('Margen objetivo por defecto');
  });
  test('tiers indexed fields', () => {
    expect(fieldLabel('tiers', '[0].to')).toBe('Tramo 1 · Hasta');
    expect(fieldLabel('tiers', '[2].label')).toBe('Tramo 3 · Etiqueta');
  });
  test('unknown field → readable fallback, never dotted/JSON', () => {
    const out = fieldLabel('product', 'mystery_field');
    expect(out).not.toContain('.');
    expect(out.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run tests/change-format.test.js -t "fieldLabel"`
Expected: FAIL — `fieldLabel` undefined.

- [ ] **Step 3: Export `parameterLabel` from admin.js**

In `renderer/admin.js`, immediately after the `PARAMETER_GROUPS` array (after ~line 60), add:

```js
// Flat key → label map derived from PARAMETER_GROUPS, exported so the
// change humanizer can reuse the same Spanish parameter labels.
const PARAMETER_LABELS = Object.fromEntries(
  PARAMETER_GROUPS.flatMap(g => g.items.map(it => [it.key, it.label]))
);

/** Spanish label for a calculation parameter key (or the key itself). */
export function parameterLabel(key) {
  return PARAMETER_LABELS[key] || key;
}
```

- [ ] **Step 4: Implement `fieldLabel` in change-format.js**

In `renderer/change-format.js`, add the import at the top (after the `'use strict';` line — note ESM imports hoist; keep it with the other module code):

```js
import { parameterLabel } from './admin.js';
```

Then add:

```js
// Ordinal helpers for indexed paths: "suppliers[0]" → "Proveedor 1".
function relSegments(rel) {
  // Split "suppliers[0].price" → ['suppliers[0]', 'price'].
  return String(rel || '').split('.').filter(Boolean);
}
function indexOf(segment) {
  const m = /\[(\d+)\]/.exec(segment);
  return m ? Number(m[1]) : null;
}
function baseName(segment) {
  return segment.replace(/\[\d+\]/g, '');
}

const TIER_LABEL = { id: 'Id', label: 'Etiqueta', from: 'Desde', to: 'Hasta' };
const SUPPLIER_SUB = { supplier: 'Proveedor', ref: 'Referencia', price: 'Precio base', min_order: 'Pedido mínimo', is_default: 'Por defecto' };
const FACE_LABEL = { two_sides: '2 caras', one_side: '1 cara' };

const SIMPLE_LABELS = {
  supplier: { name: 'Nombre', web: 'Web', notes: 'Notas' },
  product: { name: 'Nombre', category: 'Categoría', extra_cost_3xl: 'Coste extra 3XL', target_margin: 'Margen objetivo' },
  pack: {
    name: 'Nombre', description: 'Descripción', icon: 'Icono', min_total: 'Mínimo total (uds)',
    target_margin: 'Margen objetivo', pricing_mode: 'Modo de precio', free_components: 'Componentes libres'
  },
  addon: { label: 'Etiqueta', price: 'Precio (€/ud)', cost: 'Coste interno (€/ud)', vat_included: 'IVA incluido', applies_to: 'Aplica a' },
  company: { name: 'Nombre' }
};

/** Human label for an entity-relative field path. Never returns a dotted path. */
export function fieldLabel(entityType, rel) {
  const r = String(rel || '');

  // Parameters: reuse the admin dictionary.
  if (entityType === 'parameters') return parameterLabel(r);

  // Tiers: "[i].field".
  if (entityType === 'tiers') {
    const segs = relSegments(r);
    const i = indexOf(segs[0] || '');
    const field = baseName(segs[1] || segs[0] || '');
    const tierPart = i !== null ? `Tramo ${i + 1}` : 'Tramo';
    return segs.length > 1 ? `${tierPart} · ${TIER_LABEL[field] || prettySegment(field)}` : tierPart;
  }

  // Product price table: "prices.two_sides.T1".
  if (entityType === 'product' && r.startsWith('prices.')) {
    const [, face, tier] = r.split('.');
    return `PVP · ${FACE_LABEL[face] || face} · Tramo ${tier}`;
  }
  // Product supplier sub-rows: "suppliers[0].price".
  if (entityType === 'product' && r.startsWith('suppliers')) {
    const segs = relSegments(r);
    const i = indexOf(segs[0]);
    const sub = baseName(segs[1] || '');
    return `Proveedor ${i !== null ? i + 1 : ''}`.trim() + (sub ? ` · ${SUPPLIER_SUB[sub] || prettySegment(sub)}` : '');
  }

  // Pack bundle price table: "bundle_prices.<combo>.T1".
  if (entityType === 'pack' && r.startsWith('bundle_prices.')) {
    const [, combo, tier] = r.split('.');
    return `PVP · ${combo || '(base)'} · Tramo ${tier}`;
  }
  // Pack options/components arrays.
  if (entityType === 'pack' && (r.startsWith('options') || r.startsWith('components'))) {
    const segs = relSegments(r);
    const head = segs[0].startsWith('options') ? 'Opción' : 'Componente';
    const i = indexOf(segs[0]);
    let out = `${head} ${i !== null ? i + 1 : ''}`.trim();
    // optional nested values[j] for options
    let rest = segs.slice(1);
    if (rest[0] && rest[0].startsWith('values')) {
      const j = indexOf(rest[0]);
      out += ` · Valor ${j !== null ? j + 1 : ''}`.trim();
      rest = rest.slice(1);
    }
    const field = baseName(rest[0] || '');
    const fieldLabels = { label: 'Etiqueta', sides: 'Caras', id: 'Id', product: 'Producto', qty_per_pack: 'Uds por pack' };
    return field ? `${out} · ${fieldLabels[field] || prettySegment(field)}` : out;
  }

  // Simple per-entity fields.
  const simple = SIMPLE_LABELS[entityType];
  if (simple) {
    const seg = baseName(relSegments(r)[0] || r);
    if (simple[seg]) return simple[seg];
  }

  // Fallback: never a dotted path — humanize the last meaningful segment.
  return prettyRel(r);
}

function prettySegment(seg) {
  const s = baseName(String(seg || '')).replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Campo';
}
function prettyRel(rel) {
  const segs = relSegments(rel).map(s => {
    const i = indexOf(s);
    const base = prettySegment(s);
    return i !== null ? `${base} ${i + 1}` : base;
  });
  return segs.join(' · ') || 'Campo';
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run tests/change-format.test.js -t "fieldLabel"` then the whole file `pnpm exec vitest run tests/change-format.test.js`
Expected: PASS. Also `pnpm exec vitest run tests/admin.test.js` (admin.js still green after the new export).

- [ ] **Step 6: Commit**

```bash
git add renderer/admin.js renderer/change-format.js tests/change-format.test.js
git commit -m "feat(change-format): field label dictionary; export parameterLabel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `formatValue` (units: € / % / Sí-No / «texto» / vacío)

**Files:**
- Modify: `renderer/change-format.js`
- Test: `tests/change-format.test.js`

- [ ] **Step 1: Write the failing tests**

Append (extend import with `formatValue`):

```js
describe('formatValue', () => {
  test('euro fields', () => {
    expect(formatValue('product', 'suppliers[0].price', 3.5)).toBe('3,50 €');
    expect(formatValue('product', 'prices.two_sides.T1', 12)).toBe('12,00 €');
    expect(formatValue('addon', 'price', 2)).toBe('2,00 €');
    expect(formatValue('parameters', 'labor_eur_hour', 15)).toBe('15,00 €');
  });
  test('percent fields', () => {
    expect(formatValue('product', 'target_margin', 0.35)).toBe('35 %');
    expect(formatValue('parameters', 'vat', 0.21)).toBe('21 %');
    expect(formatValue('parameters', 'waste_pct', 0.1)).toBe('10 %');
  });
  test('booleans', () => {
    expect(formatValue('product', 'suppliers[0].is_default', true)).toBe('Sí');
    expect(formatValue('pack', 'free_components', false)).toBe('No');
  });
  test('pricing_mode mapping', () => {
    expect(formatValue('pack', 'pricing_mode', 'bundle')).toBe('Por unidad');
    expect(formatValue('pack', 'pricing_mode', 'components')).toBe('Por componentes');
  });
  test('text, empty, null, number', () => {
    expect(formatValue('supplier', 'name', 'Valento')).toBe('«Valento»');
    expect(formatValue('supplier', 'web', '')).toBe('(vacío)');
    expect(formatValue('supplier', 'notes', null)).toBe('(vacío)');
    expect(formatValue('pack', 'min_total', 12)).toBe('12');
  });
  test('object value never shows JSON', () => {
    expect(formatValue('supplier', '', { name: 'x' })).toBe('(varios datos)');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run tests/change-format.test.js -t "formatValue"`
Expected: FAIL — `formatValue` undefined.

- [ ] **Step 3: Implement `formatValue`**

Add to `renderer/change-format.js`:

```js
const PERCENT_KEYS = new Set(['target_margin', 'default_target_margin', 'vat', 'waste_pct']);

function lastBase(rel) {
  const segs = relSegments(rel);
  return baseName(segs[segs.length - 1] || rel || '');
}

function isEuroField(entityType, rel) {
  if (rel.startsWith('prices.') || rel.startsWith('bundle_prices.')) return true;
  const seg = lastBase(rel);
  if (seg === 'price' || seg === 'cost' || seg === 'extra_cost_3xl') return true;
  if (seg.includes('eur')) return true; // labor_eur_hour, surcharge_4xl_eur, dtf_eur_meter, …
  return false;
}

function commaDecimals(n, decimals) {
  return Number(n).toFixed(decimals).replace('.', ',');
}

/** Friendly Spanish rendering of a value, unit-aware by field. */
export function formatValue(entityType, rel, value) {
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value === null || value === undefined || value === '') return '(vacío)';

  const seg = lastBase(rel);
  if (entityType === 'pack' && seg === 'pricing_mode') {
    return value === 'bundle' ? 'Por unidad' : value === 'components' ? 'Por componentes' : `«${value}»`;
  }
  if (typeof value === 'number') {
    if (PERCENT_KEYS.has(seg)) {
      const pct = value * 100;
      const txt = Number.isInteger(pct) ? String(pct) : commaDecimals(pct, 2);
      return `${txt} %`;
    }
    if (isEuroField(entityType, rel)) return `${commaDecimals(value, 2)} €`;
    return String(value).replace('.', ',');
  }
  if (typeof value === 'string') return `«${value}»`;
  return '(varios datos)'; // object/array leaf — never JSON
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/change-format.test.js`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add renderer/change-format.js tests/change-format.test.js
git commit -m "feat(change-format): unit-aware value formatting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `humanizeChange` + `groupChanges`

**Files:**
- Modify: `renderer/change-format.js`
- Test: `tests/change-format.test.js`

- [ ] **Step 1: Write the failing tests**

Append (extend import with `humanizeChange, groupChanges`):

```js
describe('humanizeChange', () => {
  test('change with explicit entityType (relative path)', () => {
    expect(humanizeChange({ path: 'name', before: 'A', after: 'B', kind: 'change' }, 'supplier'))
      .toBe('Nombre: «A» → «B»');
  });
  test('add field', () => {
    expect(humanizeChange({ path: 'price', after: 2, kind: 'add' }, 'addon'))
      .toBe('Precio (€/ud): 2,00 €');
  });
  test('remove field', () => {
    expect(humanizeChange({ path: 'web', before: 'x.com', kind: 'remove' }, 'supplier'))
      .toBe('Web: se quita («x.com»)');
  });
  test('derives entityType from a full path when not given', () => {
    expect(humanizeChange({ path: 'parameters.vat', before: 0.21, after: 0.1, kind: 'change' }))
      .toBe('IVA aplicado: 21 % → 10 %');
  });
});

describe('groupChanges', () => {
  test('groups flat full-path changes by entity, detects edit', () => {
    const groups = groupChanges([
      { path: 'suppliers.S1.name', before: 'A', after: 'B', kind: 'change' },
      { path: 'suppliers.S1.web', before: '', after: 'b.com', kind: 'add' },
      { path: 'parameters.vat', before: 0.21, after: 0.1, kind: 'change' }
    ]);
    const s = groups.find(g => g.id === 'S1');
    expect(s.entityType).toBe('supplier');
    expect(s.kind).toBe('edit');
    expect(s.fieldChanges).toHaveLength(2);
    const p = groups.find(g => g.entityType === 'parameters');
    expect(p.id).toBeNull();
    expect(p.kind).toBe('edit');
  });
  test('whole-entity add → kind add, no field rows, name from object', () => {
    const groups = groupChanges([
      { path: 'suppliers.S2', before: undefined, after: { name: 'Valento' }, kind: 'add' }
    ]);
    expect(groups[0]).toMatchObject({ entityType: 'supplier', id: 'S2', kind: 'add', name: 'Valento' });
    expect(groups[0].fieldChanges).toEqual([]);
  });
  test('whole-entity remove → kind remove, name from old object', () => {
    const groups = groupChanges([
      { path: 'products.P1', before: { name: 'Camiseta' }, after: undefined, kind: 'remove' }
    ]);
    expect(groups[0]).toMatchObject({ entityType: 'product', id: 'P1', kind: 'remove', name: 'Camiseta' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run tests/change-format.test.js -t "humanizeChange"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `renderer/change-format.js`:

```js
/**
 * One friendly line for a single field change. If `entityType` is given,
 * `change.path` is treated as entity-relative; otherwise it is parsed
 * from a full path.
 */
export function humanizeChange(change, entityType) {
  let type = entityType;
  let rel = change.path;
  if (!type) {
    const p = parsePath(change.path);
    type = p.entityType;
    rel = p.rel;
  }
  const label = fieldLabel(type, rel);
  if (change.kind === 'add') return `${label}: ${formatValue(type, rel, change.after)}`;
  if (change.kind === 'remove') return `${label}: se quita (${formatValue(type, rel, change.before)})`;
  return `${label}: ${formatValue(type, rel, change.before)} → ${formatValue(type, rel, change.after)}`;
}

/**
 * Groups a FLAT list of full-path changes by entity, detecting whether
 * the whole entity was added/removed (a single change whose rel is '')
 * vs edited. `cfg` (optional) resolves nicer entity names.
 * @returns {{entityType,id,name,kind,fieldChanges}[]}
 */
export function groupChanges(flatChanges, cfg) {
  const order = [];
  const map = new Map();
  for (const ch of flatChanges || []) {
    const { entityType, id, rel } = parsePath(ch.path);
    const key = `${entityType}:${id}`;
    if (!map.has(key)) {
      map.set(key, { entityType, id, kind: 'edit', name: '', fieldChanges: [] });
      order.push(key);
    }
    const g = map.get(key);
    if (rel === '') {
      // Whole-entity add/remove: summary line only.
      g.kind = ch.kind === 'add' ? 'add' : 'remove';
      const obj = ch.kind === 'add' ? ch.after : ch.before;
      g.name = entityName(entityType, obj, id);
    } else {
      g.fieldChanges.push({ path: rel, before: ch.before, after: ch.after, kind: ch.kind });
    }
  }
  // Resolve names for edit groups (and any add/remove without a name yet).
  for (const key of order) {
    const g = map.get(key);
    if (!g.name) {
      const obj = cfg && entitySlice(cfg, g.entityType, g.id);
      g.name = entityName(g.entityType, obj, g.id);
    }
  }
  return order.map(k => map.get(k));
}

function entitySlice(cfg, entityType, id) {
  const sections = { supplier: 'suppliers', product: 'products', addon: 'addons', pack: 'packs' };
  if (id && sections[entityType]) return (cfg[sections[entityType]] || {})[id];
  return cfg[entityType];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/change-format.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/change-format.js tests/change-format.test.js
git commit -m "feat(change-format): humanizeChange + groupChanges

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `renderChangeGroup` + `renderEntityValues` (shared HTML)

**Files:**
- Modify: `renderer/change-format.js`
- Test: `tests/change-format.test.js`

- [ ] **Step 1: Write the failing tests**

Append (extend import with `renderChangeGroup, renderEntityValues, escHtml`):

```js
describe('renderChangeGroup', () => {
  test('edit group renders badge, name and humanized rows, no JSON/paths', () => {
    const html = renderChangeGroup({
      entityType: 'product', id: 'BEAGLE', kind: 'edit', name: 'Camiseta',
      fieldChanges: [{ path: 'target_margin', before: 0.35, after: 0.4, kind: 'change' }]
    });
    expect(html).toContain('Editado');
    expect(html).toContain('Producto');
    expect(html).toContain('Camiseta');
    expect(html).toContain('Margen objetivo');
    expect(html).toContain('35 %');
    expect(html).toContain('40 %');
    expect(html).not.toContain('target_margin');
    expect(html).not.toContain('{');
  });
  test('add group renders only the summary line', () => {
    const html = renderChangeGroup({ entityType: 'supplier', id: 'S1', kind: 'add', name: 'Valento', fieldChanges: [] });
    expect(html).toContain('Nuevo');
    expect(html).toContain('Proveedor');
    expect(html).toContain('Valento');
    expect(html).not.toContain('{');
  });
  test('escapes malicious names', () => {
    const html = renderChangeGroup({ entityType: 'supplier', id: 'S1', kind: 'add', name: '<img>', fieldChanges: [] });
    expect(html).not.toContain('<img>');
    expect(html).toContain('&lt;img&gt;');
  });
});

describe('renderEntityValues', () => {
  test('renders friendly key:value rows (conflict columns), no JSON', () => {
    const html = renderEntityValues('supplier', { name: 'Valento', web: '' });
    expect(html).toContain('Nombre');
    expect(html).toContain('Valento');
    expect(html).toContain('Web');
    expect(html).not.toContain('{');
  });
  test('null slice → muted no-data row', () => {
    expect(renderEntityValues('supplier', null)).toContain('sin datos');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run tests/change-format.test.js -t "renderChangeGroup"`
Expected: FAIL.

- [ ] **Step 3: Implement the render helpers**

Add to `renderer/change-format.js`:

```js
/** Local HTML escape (renderer module stays self-contained). */
export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** One change group → HTML block (badge + entity + name + rows/summary). */
export function renderChangeGroup(group) {
  const badge = kindBadge(group.kind);
  const type = entityTypeLabel(group.entityType);
  const name = group.name ? ` · ${escHtml(group.name)}` : '';
  let body;
  if (group.kind === 'edit') {
    body = `<ul class="change-rows">` +
      group.fieldChanges.map(c => `<li class="change-row">${escHtml(humanizeChange(c, group.entityType))}</li>`).join('') +
      `</ul>`;
  } else {
    // add/remove: summary line only (name already in the header).
    body = '';
  }
  return `
    <div class="change-group change-group--${badge.cls}">
      <div class="change-group__head">
        <span class="change-badge change-badge--${badge.cls}">${badge.label}</span>
        <span class="change-group__entity">${escHtml(type)}${name}</span>
      </div>
      ${body}
    </div>
  `;
}

/** Friendly key:value rows for one entity slice (conflict columns). */
export function renderEntityValues(entityType, value) {
  if (value === null || value === undefined) {
    return '<li class="change-row change-row--muted">(sin datos)</li>';
  }
  if (typeof value !== 'object') {
    return `<li class="change-row">${escHtml(String(value))}</li>`;
  }
  return Object.entries(value).map(([k, v]) => {
    const label = fieldLabel(entityType, k);
    const val = (v && typeof v === 'object') ? '(varios datos)' : formatValue(entityType, k, v);
    return `<li class="change-row">${escHtml(label)}: ${escHtml(val)}</li>`;
  }).join('');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/change-format.test.js`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add renderer/change-format.js tests/change-format.test.js
git commit -m "feat(change-format): group + entity-values HTML renderers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Refactor `save-summary.js` to structured groups

**Files:**
- Modify: `renderer/save-summary.js`
- Test: `tests/save-summary.test.js`

- [ ] **Step 1: Update the tests to the structured shape**

In `tests/save-summary.test.js`, change the group assertions from `lines` to the new shape `{ entityType, id, kind, name, fieldChanges }`:

- `'a pack field change …'`: replace the `lines` assertions with:
```js
    expect(group.kind).toBe('edit');
    expect(group.name).toBe('Pack Peña Pro');
    expect(group.fieldChanges.length).toBeGreaterThanOrEqual(1);
    expect(group.fieldChanges.some(c => c.path === 'name' && c.after === 'Pack Peña Pro')).toBe(true);
```
- `'a parameter change …'`: replace last line with:
```js
    expect(summary[0].fieldChanges.some(c => c.path === 'vat')).toBe(true);
```
- `'an added product …'`: replace the `+` line check with:
```js
    expect(group.kind).toBe('add');
    expect(group.name).toBe('Sudadera');
    expect(group.fieldChanges).toEqual([]);
```
- `'changes across several entities …'`: replace the per-group `lines.length` loop with:
```js
    for (const g of summary) {
      if (g.kind === 'edit') expect(g.fieldChanges.length).toBeGreaterThanOrEqual(1);
    }
```
- `'a removed addon …'`: replace the `-` line check with:
```js
    expect(summary[0].kind).toBe('remove');
    expect(summary[0].name).toBe('Nombre'); // addon label from the old object
```
  (the removed addon `name_print` has `label: 'Nombre'` in `baseCfg`).
- `'totalChanges() helper …'`: keep, but `totalChanges` now counts field changes plus 1 per whole add/remove (see Step 3). Adjust to:
```js
    expect(totalChanges(summary)).toBeGreaterThanOrEqual(2);
```

For the **drift-guard** block, change `summaryLines` to format the structured field changes through `lib/diff.js`, and account for whole add/remove groups (which carry no `fieldChanges` but correspond to one lib line). Replace `summaryLines` with:

```js
  function summaryLines(oldCfg, newCfg) {
    const groups = buildSaveSummary(oldCfg, newCfg);
    const lines = [];
    for (const g of groups) {
      if (g.kind === 'add') {
        // whole-entity add → lib emits one "+ : {obj}" line for the slice
        const slice = sliceOf(newCfg, g.entityType, g.id);
        lines.push(...diffLib.diffObjects(undefined, slice).map(diffLib.formatChangeLine));
      } else if (g.kind === 'remove') {
        const slice = sliceOf(oldCfg, g.entityType, g.id);
        lines.push(...diffLib.diffObjects(slice, undefined).map(diffLib.formatChangeLine));
      } else {
        lines.push(...g.fieldChanges.map(diffLib.formatChangeLine));
      }
    }
    return lines;
  }
  function sliceOf(cfg, entityType, id) {
    const sec = { supplier: 'suppliers', product: 'products', addon: 'addons', pack: 'packs' }[entityType];
    return sec ? (cfg[sec] || {})[id] : cfg[entityType];
  }
```

And update the `totalChanges(...)` assertion at the end of the drift-guard loop to:
```js
      expect(totalChanges(buildSaveSummary(oldCfg, newCfg))).toBe(fromSummary.length);
```
(keeps the count aligned with produced lines).

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run tests/save-summary.test.js`
Expected: FAIL — groups have `lines`, not `kind/name/fieldChanges`.

- [ ] **Step 3: Refactor `buildSaveSummary` + `totalChanges`**

In `renderer/save-summary.js`, replace `buildSaveSummary` and `totalChanges` with structured output (keep the diff primitives `diffObjects`/`walk`/`deepEqual`/`formatChangeLine`/`stringify`/`IGNORE_PATHS` exactly as they are — the drift-guard still pins them):

```js
export function buildSaveSummary(oldCfg, newCfg) {
  const old = oldCfg || {};
  const next = newCfg || {};
  const out = [];

  for (const [entityType, section] of PER_ID) {
    const oldColl = old[section] || {};
    const newColl = next[section] || {};
    const ids = new Set([...Object.keys(oldColl), ...Object.keys(newColl)]);
    for (const id of ids) {
      const before = oldColl[id];
      const after = newColl[id];
      const changes = diffObjects(before, after);
      if (changes.length === 0) continue;
      const added = before === undefined && after !== undefined;
      const removed = before !== undefined && after === undefined;
      const kind = added ? 'add' : removed ? 'remove' : 'edit';
      const nameObj = (kind === 'remove') ? before : after;
      const name = (nameObj && (nameObj.name || nameObj.label)) || id;
      const fieldChanges = kind === 'edit' ? changes : [];
      out.push({ entityType, id, kind, name, fieldChanges });
    }
  }

  for (const entityType of GLOBALS) {
    const changes = diffObjects(old[entityType], next[entityType]);
    if (changes.length === 0) continue;
    out.push({ entityType, id: null, kind: 'edit', name: null, fieldChanges: changes });
  }

  return out;
}

/**
 * Total change count for the "Guardar N cambios" button: each edited
 * field counts once; a whole-entity add/remove counts as one.
 */
export function totalChanges(summary) {
  return (summary || []).reduce((n, g) => {
    if (g.kind === 'edit') return n + (g.fieldChanges ? g.fieldChanges.length : 0);
    return n + 1; // add / remove
  }, 0);
}
```

Update the module header comment (lines ~4-12) to say groups now carry `{ entityType, id, kind, name, fieldChanges }` instead of `lines`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/save-summary.test.js`
Expected: PASS (including the drift-guard).

- [ ] **Step 5: Commit**

```bash
git add renderer/save-summary.js tests/save-summary.test.js
git commit -m "refactor(save-summary): structured change groups (kind/name/fieldChanges)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire the file-mode confirm + both audit views (`admin-extras.js`)

**Files:**
- Modify: `renderer/admin-extras.js` (`renderChangeRow`, `renderDiffPreview`, `renderAuditTab`, `renderCloudAuditList`/`renderCloudDiff`)
- Test: `tests/admin-extras.test.js`

- [ ] **Step 1: Update/extend the tests**

Read `tests/admin-extras.test.js` first to match its imports/style. Then:
- Add an import: `import { humanizeChange } from '../renderer/change-format.js';` is NOT needed in the test; instead assert the rendered output is friendly.
- For `renderDiffPreview`: add a test that a whole-entity add does NOT render JSON and shows the friendly badge/name:
```js
test('renderDiffPreview humanizes a whole-entity add (no JSON, no path)', () => {
  const html = renderDiffPreview([
    { path: 'suppliers.SUPPLIER_1', before: undefined, after: { name: 'Valento', web: '', notes: '' }, kind: 'add' }
  ]);
  expect(html).toContain('Nuevo');
  expect(html).toContain('Proveedor');
  expect(html).toContain('Valento');
  expect(html).not.toContain('{');
  expect(html).not.toContain('suppliers.SUPPLIER_1');
});
test('renderDiffPreview humanizes a field change', () => {
  const html = renderDiffPreview([
    { path: 'products.BEAGLE.target_margin', before: 0.35, after: 0.4, kind: 'change' }
  ]);
  expect(html).toContain('Margen objetivo');
  expect(html).toContain('35 %');
  expect(html).toContain('40 %');
  expect(html).not.toContain('target_margin');
});
```
- For the file audit (`renderAuditTab`): adapt any existing assertion that expects a raw `path`/code to expect the humanized label instead (read the current test to see what it asserts; change `expect(...).toContain('packs.crew.name')` style to `toContain('Nombre')`). If the existing tests only check counts/structure, just add one friendly-output assertion.
- For cloud history (`renderCloudAuditList`): add a test that the entry's `entityType` drives labels:
```js
test('renderCloudAuditList humanizes with the entry entityType', () => {
  const html = renderCloudAuditList([
    { user: 'ana', ts: '2026-06-16T10:00:00Z', action: 'update', entityType: 'supplier', entityId: 'S1',
      diff: [{ path: 'name', before: 'A', after: 'B', kind: 'change' }] }
  ]);
  expect(html).toContain('Nombre');
  expect(html).toContain('«A»');
  expect(html).toContain('«B»');
  expect(html).not.toContain('path');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm exec vitest run tests/admin-extras.test.js`
Expected: FAIL on the new/updated assertions.

- [ ] **Step 3: Implement**

In `renderer/admin-extras.js`:

1. Add import at the top (after the header comment):
```js
import { humanizeChange, groupChanges, renderChangeGroup } from './change-format.js';
```

2. Replace `renderChangeRow(change)` with an entityType-aware friendly row:
```js
function renderChangeRow(change, entityType) {
  const kindClass = `audit-change--${esc(change.kind || 'change')}`;
  return `<li class="audit-change ${kindClass}">${esc(humanizeChange(change, entityType))}</li>`;
}
```
> `humanizeChange` derives the entity type from the full path when `entityType` is omitted (file audit), and uses the passed type for cloud rows.

3. Replace `renderDiffPreview(changes)` body to group + render:
```js
export function renderDiffPreview(changes) {
  if (!changes || changes.length === 0) {
    return '<p class="hint">No hay cambios pendientes que guardar.</p>';
  }
  const groups = groupChanges(changes);
  const n = changes.length;
  return `
    <p>Vas a guardar <strong>${n}</strong> cambio${n === 1 ? '' : 's'}:</p>
    ${groups.map(renderChangeGroup).join('')}
  `;
}
```

4. In `renderCloudDiff(diff)`, pass the entity type through. It is called from `renderCloudAuditList` per entry, so thread `entityType`:
```js
function renderCloudDiff(diff, entityType) {
  if (Array.isArray(diff)) {
    if (diff.length === 0) return '<p class="hint">Sin cambios registrados.</p>';
    return '<ul class="audit-changes">' + diff.map(c => renderChangeRow(c, entityType)).join('') + '</ul>';
  }
  if (typeof diff === 'string' && diff.length > 0) {
    return `<ul class="audit-changes"><li class="audit-change"><span class="muted">${esc(diff)}</span></li></ul>`;
  }
  return '<p class="hint">Sin cambios registrados.</p>';
}
```
And in `renderCloudAuditList`, change the body call to `renderCloudDiff(entry.diff, entry.entityType)`.

> `renderAuditTab` (file audit) keeps calling `changes.map(renderChangeRow)` — no entityType, so `humanizeChange` parses the full path. That is correct for file audit. (`renderChangeRow` now takes an optional 2nd arg; `.map` passes the index as the 2nd arg! Fix: change `changes.map(renderChangeRow)` to `changes.map(c => renderChangeRow(c))` so the index is not mistaken for entityType.)

5. In `renderAuditTab`, change `changes.map(renderChangeRow).join('')` to `changes.map(c => renderChangeRow(c)).join('')`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run tests/admin-extras.test.js` then `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/admin-extras.js tests/admin-extras.test.js
git commit -m "feat(admin): humanize file confirm + audit/history change rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire cloud confirm + conflict modal (`app.js`)

**Files:**
- Modify: `renderer/app.js` (`renderSaveSummary`, `renderSummaryLine` removal, `renderValueRows`)
- No new unit tests (DOM glue); verify via `node --check` + `pnpm test` stays green + manual smoke.

- [ ] **Step 1: Import the renderers**

Add to the existing `import { ... } from './change-format.js'` (create the import if none): in `app.js`, near the `save-summary.js` import (line ~51), add:
```js
import { renderChangeGroup, renderEntityValues } from './change-format.js';
```

- [ ] **Step 2: Replace `renderSaveSummary`**

Replace the `renderSaveSummary` function (app.js ~3044-3059) with:
```js
/** Renders the grouped save summary (entity → its humanized changes). */
function renderSaveSummary(summary) {
  const n = totalChanges(summary);
  const groups = summary.map(renderChangeGroup).join('');
  return `
    <p>Vas a guardar <strong>${n}</strong> cambio${n === 1 ? '' : 's'} como
       <strong>${escAttr(cloudAuthorName())}</strong>:</p>
    ${groups}
  `;
}
```
Then DELETE the now-unused `renderSummaryLine` function (app.js ~3065-3071).

- [ ] **Step 3: Humanize the conflict columns**

Replace `renderValueRows(value)` (app.js ~3257-3269) so it takes the entity type and uses the humanizer; update its two call sites in `renderConflictBody` to pass `entityType`:
```js
function renderConflictBody(conflict) {
  const { entityType, id, serverRow } = conflict;
  const mine = mineEntitySlice(entityType, id);
  return `
    <div class="conflict-entity">
      <div class="conflict-entity__title">${escAttr(entityLabel(entityType, id))}</div>
      <div class="conflict-cols">
        <div>
          <div class="conflict-col__head">Versión del servidor</div>
          <ul class="audit-changes">${renderEntityValues(entityType, serverRow)}</ul>
        </div>
        <div>
          <div class="conflict-col__head">La tuya</div>
          <ul class="audit-changes">${renderEntityValues(entityType, mine)}</ul>
        </div>
      </div>
    </div>
  `;
}
```
Then DELETE the old `renderValueRows` function (replaced by `renderEntityValues` from change-format.js).

> Note: `conflict.entityType` here is the singular type ('supplier'/'product'/…), which matches `renderEntityValues`/`fieldLabel`. Confirm by reading `mineEntitySlice` (it maps the same singular types).

- [ ] **Step 4: Verify**

Run: `node --check renderer/app.js` → OK.
Run: `pnpm test` → green (app.js is not unit-tested; confirm nothing import-related broke and save-summary/change-format tests pass).

- [ ] **Step 5: Manual smoke note**

Interactive `pnpm dev` smoke (open admin, add a supplier, Guardar → confirm modal shows "Nuevo · Proveedor · Valento" with no JSON; edit a price → "Precio base: 3,50 € → 3,80 €") is deferred to a human/orchestrator (cannot run headless). State this in the report.

- [ ] **Step 6: Commit**

```bash
git add renderer/app.js
git commit -m "feat(admin): humanize cloud confirm + conflict modal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Styling (badges, group, field rows)

**Files:**
- Modify: `renderer/styles.css`

- [ ] **Step 1: Add styles**

Append to `renderer/styles.css` (near the audit/diff styles section, after the `.audit-*` block ~line 1781+). Use existing design tokens; reuse the add/remove/change colour intent:
```css
/* ---- Friendly change summary (confirm/conflict/audit) ---- */
.change-group {
  border: 1px solid var(--border-subtle);
  border-left: 4px solid var(--border-strong);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  margin-bottom: 10px;
  background: var(--surface-secondary);
}
.change-group--add { border-left-color: var(--success, #2e7d32); }
.change-group--remove { border-left-color: var(--danger, #c62828); }
.change-group--change { border-left-color: var(--warning, #f9a825); }
.change-group__head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.change-group__entity { font-weight: 600; font-size: 13px; }
.change-badge {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
  padding: 2px 8px; border-radius: var(--radius-sm);
}
.change-badge--add { background: var(--success-soft, #e6f4ea); color: var(--success, #2e7d32); }
.change-badge--remove { background: var(--danger-soft, #fdecea); color: var(--danger, #c62828); }
.change-badge--change { background: var(--warning-soft, #fff8e1); color: var(--warning-text, #8a6d00); }
.change-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.change-row { font-size: 13px; color: var(--fg-secondary); }
.change-row--muted { color: var(--fg-muted); font-style: italic; }
```
> Before committing, grep `:root` in styles.css for the exact token names (`--success`, `--danger`, `--warning`, and their `-soft` variants). If a token is missing, use the closest existing one (e.g. the audit-change colours) rather than inventing a hex; keep the fallbacks shown above.

- [ ] **Step 2: Verify**

Run: `pnpm test` (unaffected, confirm green). Brace-balance check the appended block.

- [ ] **Step 3: Commit**

```bash
git add renderer/styles.css
git commit -m "style(admin): friendly change-summary badges and rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full verification + docs

**Files:**
- Modify: `docs/UI-UX.md`

- [ ] **Step 1: Full suite**

Run: `pnpm test` → fully green; record counts.
Run: `node --check renderer/app.js`, `node --check renderer/admin-extras.js`, `node --check renderer/admin.js`, `node --check renderer/change-format.js`, `node --check renderer/save-summary.js` → all OK.

- [ ] **Step 2: Docs**

In `docs/UI-UX.md`, update the save-confirmation / conflict / audit sections (§2.3/§2.5 and the audit section) to note that changes are shown in **friendly Spanish** (badge Nuevo/Editado/Eliminado + entity name + humanized field rows with formatted values), with no raw JSON or dotted paths, via the shared `renderer/change-format.js`. Keep it short, match the doc's tone.

- [ ] **Step 3: Manual smoke (deferred)**

State in the report that the interactive `pnpm dev` smoke across the four catalog entities (add/edit/remove → confirm modal; force a conflict; open audit/history) is deferred to a human/orchestrator with a display.

- [ ] **Step 4: Commit**

```bash
git add docs/UI-UX.md
git commit -m "docs(ui-ux): friendly change summary in confirm/conflict/audit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- §6 module + all functions → Tasks 1-5 (`parsePath`, `entityTypeLabel`, `entityName`, `kindBadge`, `fieldLabel`, `formatValue`, `humanizeChange`, `groupChanges`, `renderChangeGroup`, `renderEntityValues`) ✓
- §7 dictionary + value formatting → Tasks 2-3 ✓ (parameters reuse via `parameterLabel`)
- §8 site 1 file confirm → Task 7; site 2 cloud confirm → Task 8; site 3 conflict → Task 8; site 4 file audit → Task 7; site 5 cloud history → Task 7 ✓
- save-summary structured refactor + drift-guard preserved → Task 6 ✓
- styling → Task 9; verify + docs → Task 10 ✓
- No main/lib change, audit.log format intact → respected (only renderer files touched) ✓

**Placeholder scan:** No TBD/TODO; all code shown; the only "read current test/tokens first" notes are concrete verification steps, not deferred work. ✓

**Type consistency:** group shape `{ entityType, id, kind, name, fieldChanges }` used identically in Tasks 4/5/6; `humanizeChange(change, entityType?)`, `fieldLabel(entityType, rel)`, `formatValue(entityType, rel, value)`, `renderChangeGroup(group)`, `renderEntityValues(entityType, value)`, `parsePath`→`{entityType,id,rel}` consistent across tasks. `renderChangeRow(change, entityType?)` second-arg fix (avoid `.map` index) handled in Task 7. ✓
