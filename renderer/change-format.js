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

import { parameterLabel } from './admin.js';

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

// ------------------------------------------------------------
// Field label helpers
// ------------------------------------------------------------

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
    let out = i !== null ? `${head} ${i + 1}` : head;
    // optional nested values[j] for options
    let rest = segs.slice(1);
    if (rest[0] && rest[0].startsWith('values')) {
      const j = indexOf(rest[0]);
      out += j !== null ? ` · Valor ${j + 1}` : ' · Valor';
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

// ------------------------------------------------------------
// Value formatting
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// Change humanizer and grouper
// ------------------------------------------------------------

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
