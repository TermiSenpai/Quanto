// ============================================================
// PackPrice · PDF template gallery view-model (pure)
// ============================================================
// Maps the template list (built-ins + custom) plus the current
// company selection into the small view-model the settings gallery
// renders. Pure and DOM-free so it can be unit-tested without the
// renderer; the DOM glue (cards, iframe, color input) stays in app.js.
//
// The renderer is a native ES module and CANNOT require the CommonJS
// lib/pdf-templates.js, so the list of built-ins arrives over IPC
// (pdf:list-templates). This helper only shapes that list — it never
// renders template HTML (that happens in a sandboxed iframe fed by
// main's pdf:preview).
//
// User-facing strings stay Spanish (CLAUDE.md §2).
// ============================================================

/**
 * Builds the gallery view-model: the ordered list of selectable cards
 * and which one is currently active.
 *
 * Selection resolution: the stored `selectedId` wins when it still
 * exists in the list; otherwise we fall back to `defaultId` (when it
 * exists), then to the first card. This keeps the gallery from showing
 * "nothing selected" when a company points at a custom template that
 * was archived on another PC, or has no selection yet.
 *
 * @param {Array<{id:string, name:string}>} templates - built-ins first, then custom
 * @param {string} [selectedId] - company.pdf_template
 * @param {object} [options]
 * @param {string} [options.defaultId='clasica'] - fallback selection
 * @param {Set<string>} [options.builtinIds] - which ids are built-in (drive the «personalizada» tag)
 * @returns {{cards: Array<{id:string, name:string, isBuiltin:boolean, isSelected:boolean}>, selectedId:(string|null)}}
 */
export function buildGalleryModel(templates, selectedId, options = {}) {
  const list = Array.isArray(templates) ? templates : [];
  const defaultId = options.defaultId || 'clasica';
  const builtinIds = options.builtinIds instanceof Set ? options.builtinIds : null;

  const ids = new Set(list.map((t) => t.id));
  let active = null;
  if (typeof selectedId === 'string' && ids.has(selectedId)) {
    active = selectedId;
  } else if (ids.has(defaultId)) {
    active = defaultId;
  } else if (list.length > 0) {
    active = list[0].id;
  }

  const cards = list.map((t) => ({
    id: t.id,
    name: t.name,
    // When the caller knows the built-in ids, mark the rest as custom so
    // the gallery can badge them; otherwise default to built-in (file
    // mode only ever lists built-ins).
    isBuiltin: builtinIds ? builtinIds.has(t.id) : true,
    isSelected: t.id === active
  }));

  return { cards, selectedId: active };
}
