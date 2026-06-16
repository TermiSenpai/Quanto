// ============================================================
// PackPrice · Change humanizer (pure, renderer)
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
