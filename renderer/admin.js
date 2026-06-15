// ============================================================
// PackPrice · Admin mode editor (v4 catalog builder)
// ============================================================
// Pure render functions (return HTML strings) plus controlled
// config mutations. No DOM, no IPC, no globals beyond an optional
// `window.confirm` for destructive actions (guarded so the module
// stays unit-testable in Node).
//
//   - updateConfigFromInput  (a single field change)
//   - executeAdminAction     (add/remove a row)
//
// Orchestration (open/close modal, login, IPC, save/diff) lives in
// app.js. Config schema: v4 (English keys). The user can create and
// edit the WHOLE catalog from here: suppliers, products (multi-
// supplier), addons, tiers and packs (bundle or components).
//
// User-facing labels stay in Spanish (CLAUDE.md §4.5); identifiers
// are English (§2). All interpolated values are escaped with `esc`.
// ============================================================

import {
  recommendedPrice,
  calculateGarmentCost,
  getTier
} from './calculo.js';

// ------------------------------------------------------------
// Parameters: grouped by category so they are easier to find.
// v4 keys only: the legacy "Extras opcionales" group (now addons)
// and `buffer_3xl_eur_pack` (now per-product `extra_cost_3xl`) are
// gone; `default_target_margin` and `price_rounding_ending` are new.
// ------------------------------------------------------------
const PARAMETER_GROUPS = [
  { title: 'Impuestos y recargos', highlight: true, items: [
    { key: 'vat',                  label: 'IVA aplicado',            hint: 'Decimal: 0.21 = 21%', step: 0.01, min: 0, max: 1 },
    { key: 'surcharge_4xl_eur',    label: 'Recargo 4XL (€/prenda)',  hint: 'Se factura al cliente', step: 0.01, min: 0 },
    { key: 'surcharge_5xl_eur',    label: 'Recargo 5XL+ (€/prenda)', hint: 'Se factura al cliente', step: 0.01, min: 0 }
  ]},
  { title: 'Precios recomendados', items: [
    { key: 'default_target_margin', label: 'Margen objetivo por defecto', hint: 'Decimal · 0.35 = 35%', step: 0.01, min: 0, max: 0.99 },
    { key: 'price_rounding_ending', label: 'Redondeo de PVP (céntimos)', hint: '0.95 → precios acabados en ,95', step: 0.01, min: 0, max: 0.99 }
  ]},
  { title: 'Mano de obra y costes', items: [
    { key: 'labor_eur_hour',        label: 'Mano de obra (€/hora)', step: 0.5, min: 0 },
    { key: 'overhead_eur_garment',  label: 'Indirectos (€/prenda)', step: 0.01, min: 0 }
  ]},
  { title: 'Producción DTF', items: [
    { key: 'waste_pct',            label: 'Merma (decimal)', hint: '0.10 = 10%', step: 0.01, min: 0, max: 1 },
    { key: 'dtf_eur_meter',        label: 'DTF (€/metro)', step: 0.01, min: 0 },
    { key: 'dtf_meters_two_sides', label: 'DTF metros · 2 caras', step: 0.05, min: 0 },
    { key: 'dtf_meters_one_side',  label: 'DTF metros · 1 cara', step: 0.05, min: 0 },
    { key: 'pressing_eur_side',    label: 'Planchado (€/cara)', step: 0.01, min: 0 }
  ]},
  { title: 'Tiempos y envío', items: [
    { key: 'minutes_two_sides_base',   label: 'Minutos por prenda · 2 caras', step: 0.5, min: 0 },
    { key: 'minutes_one_side_base',    label: 'Minutos por prenda · 1 cara', step: 0.5, min: 0 },
    { key: 'roly_shipping_eur_bundle', label: 'Envío proveedor (€/bulto)', step: 0.01, min: 0 },
    { key: 'garments_per_bundle',      label: 'Prendas por bulto', step: 1, min: 1 }
  ]}
];

// The two price-table faces every product/bundle exposes.
const PRICE_FACES = [['two_sides', '2 caras', 2], ['one_side', '1 cara', 1]];

// ------------------------------------------------------------
// Escape helper
// ------------------------------------------------------------
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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

// ------------------------------------------------------------
// Color per pack: deterministic by index so each pack keeps its hue.
// ------------------------------------------------------------
const PACK_COLOR_TOKENS = [
  '--pack-color-1', '--pack-color-2', '--pack-color-3',
  '--pack-color-4', '--pack-color-5', '--pack-color-6'
];

export function packColorToken(packId, idx) {
  return PACK_COLOR_TOKENS[idx % PACK_COLOR_TOKENS.length];
}

/** Confirm wrapper: returns true outside a browser (tests) so the
 *  mutation helpers stay testable without stubbing window. */
function confirmAction(message) {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return window.confirm(message);
  }
  return true;
}

// ============================================================
// PARAMETERS
// ============================================================
export function renderAdminParameters(cfg) {
  let html = '<p class="hint" style="margin-bottom: 16px;">Variables que afectan al cálculo. <strong>Impuestos y recargos</strong> es el grupo que más cambia.</p>';

  for (const group of PARAMETER_GROUPS) {
    html += `<div class="admin-group">`;
    html += `<div class="admin-group__title ${group.highlight ? 'is-highlight' : ''}">${esc(group.title)}</div>`;
    html += '<div class="admin-grid">';
    for (const it of group.items) {
      const value = cfg.parameters[it.key];
      const valueAttr = (value === null || value === undefined) ? '' : value;
      const stepAttr = it.step !== undefined ? ` step="${it.step}"` : '';
      const minAttr  = it.min  !== undefined ? ` min="${it.min}"`   : '';
      const maxAttr  = it.max  !== undefined ? ` max="${it.max}"`   : '';
      html += `
        <label>${esc(it.label)}${it.hint ? ` <span class="hint">${esc(it.hint)}</span>` : ''}
          <input type="number"${stepAttr}${minAttr}${maxAttr} value="${esc(valueAttr)}" data-cfg-path="parameters.${esc(it.key)}">
        </label>
      `;
    }
    html += '</div></div>';
  }
  return html;
}

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

// ============================================================
// PRODUCTS — list + editor (replaces v3 "Modelos Roly")
// ============================================================
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

export function renderProductEditor(cfg, id) {
  const p = cfg.products?.[id];
  if (!p) return renderEditorNotFound('Producto');

  const supplierIds = Object.keys(cfg.suppliers || {});
  const categories = collectCategories(cfg);

  // --- Basic fields ---
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

  // --- Suppliers sub-list ---
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

  // --- Price table (faces × tiers) ---
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

/** Short hint showing the recommended PVP for a product's two-sides
 *  first tier, so the admin sees what the button will fill. */
function recommendedHint(cfg, product) {
  const firstTier = cfg.tiers[0];
  if (!firstTier) return '';
  const id = findProductId(cfg, product);
  if (!id) return '';
  try {
    const cost = calculateGarmentCost(cfg, id, 2, firstTier, Math.max(firstTier.from, 1)).total;
    const margin = numberOr(product.target_margin, cfg.parameters.default_target_margin);
    const rec = recommendedPrice(cfg, cost, margin);
    return `Ej. 2 caras ${firstTier.id}: ~${rec.price.toFixed(2)} € (margen ${(rec.margin_pct * 100).toFixed(0)}%)`;
  } catch (_) {
    return '';
  }
}

function findProductId(cfg, product) {
  for (const [id, p] of Object.entries(cfg.products || {})) {
    if (p === product) return id;
  }
  return null;
}

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

// ============================================================
// TIERS
// ============================================================
export function renderAdminTiers(cfg) {
  let html = '<p class="hint" style="margin-bottom: 12px;">Cada tramo activa un PVP distinto. Si añades o eliminas tramos, las tablas de PVP de los productos y de los packs por unidad (bundle) se ajustan automáticamente y mantienen los valores existentes.</p>';

  cfg.tiers.forEach((t, i) => {
    const disableRemove = cfg.tiers.length <= 1;
    html += `
      <div class="admin-row">
        <div class="admin-row__head">
          <div class="admin-row__title">
            <span class="admin-row__id">${esc(t.id)}</span>
            <strong>${esc(t.label || '')}</strong>
          </div>
          <button type="button" class="admin-row__remove"
                  data-action="remove-tier" data-idx="${esc(i)}"
                  ${disableRemove ? 'disabled title="Debe quedar al menos un tramo"' : 'title="Eliminar tramo"'}
                  aria-label="Eliminar tramo ${esc(t.id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Etiqueta
            <input type="text" value="${esc(t.label || '')}" data-cfg-path="tiers.${esc(i)}.label">
          </label>
          <label>Reducción de tiempo <span class="hint">decimal · 0.10 = 10%</span>
            <input type="number" step="0.01" min="0" max="1" value="${esc(t.time_reduction ?? 0)}" data-cfg-path="tiers.${esc(i)}.time_reduction">
          </label>
          <label>Desde (uds)
            <input type="number" min="1" step="1" value="${esc(t.from ?? 0)}" data-cfg-path="tiers.${esc(i)}.from">
          </label>
          <label>Hasta (uds) <span class="hint">vacío = sin límite</span>
            <input type="number" min="1" step="1" value="${esc(t.to === null || t.to === undefined ? '' : t.to)}" data-cfg-path="tiers.${esc(i)}.to">
          </label>
        </div>
      </div>
    `;
  });

  html += `
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-action="add-tier">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir tramo
      </button>
    </div>
  `;
  return html;
}

// ============================================================
// PACKS (builder) — list + editor
// ============================================================
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

function renderPackOptions(cfg, id, pack) {
  let html = `<div class="admin-mini-head">Opciones</div>`;
  (pack.options || []).forEach((option, oidx) => {
    html += `
      <div class="admin-row" style="margin-bottom: 8px;">
        <div class="admin-row__head">
          <div class="admin-row__title">
            <span class="admin-row__id">${esc(option.id || `op${oidx}`)}</span>
            <strong>${esc(option.label || '')}</strong>
          </div>
          <button type="button" class="admin-row__remove"
                  data-action="remove-pack-option" data-id="${esc(id)}" data-idx="${esc(oidx)}"
                  title="Eliminar opción" aria-label="Eliminar opción">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Etiqueta
            <input type="text" value="${esc(option.label || '')}" data-cfg-path="packs.${esc(id)}.options.${esc(oidx)}.label">
          </label>
        </div>
        <div class="admin-mini-head">Valores</div>
    `;
    (option.values || []).forEach((value, vidx) => {
      const onlyOne = (option.values || []).length <= 1;
      const sidesVal = Number.isFinite(value.sides) ? value.sides : '';
      html += `
        <div class="admin-grid" style="grid-template-columns: 2fr 1fr auto; align-items: end;">
          <label>${esc(value.id || `v${vidx}`)} · etiqueta
            <input type="text" value="${esc(value.label || '')}" data-cfg-path="packs.${esc(id)}.options.${esc(oidx)}.values.${esc(vidx)}.label">
          </label>
          <label>Caras <span class="hint">vacío = no aplica</span>
            <input type="number" step="1" min="0" value="${esc(sidesVal)}" data-cfg-path="packs.${esc(id)}.options.${esc(oidx)}.values.${esc(vidx)}.sides">
          </label>
          <button type="button" class="admin-row__remove"
                  data-action="remove-option-value" data-id="${esc(id)}" data-idx="${esc(oidx)}" data-vidx="${esc(vidx)}"
                  ${onlyOne ? 'disabled title="Debe quedar al menos un valor"' : 'title="Quitar valor"'}
                  aria-label="Quitar valor">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
      `;
    });
    html += `
        <div class="admin-row-add" style="margin-top: 6px;">
          <button type="button" class="btn btn-ghost" data-action="add-option-value" data-id="${esc(id)}" data-idx="${esc(oidx)}">
            <svg class="icon"><use href="#i-plus"/></svg> Añadir valor
          </button>
        </div>
      </div>
    `;
  });
  html += `
    <div class="admin-row-add" style="margin-bottom: 12px;">
      <button type="button" class="btn btn-ghost" data-action="add-pack-option" data-id="${esc(id)}">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir opción
      </button>
    </div>
  `;
  return html;
}

function renderPackComponents(cfg, id, pack, productIds) {
  const isBundle = pack.pricing_mode === 'bundle';
  let html = `<div class="admin-mini-head">Componentes</div>`;
  (pack.components || []).forEach((comp, cidx) => {
    const productOptions = productIds.map(pid =>
      `<option value="${esc(pid)}" ${pid === comp.product ? 'selected' : ''}>${esc((cfg.products[pid] || {}).name || pid)}</option>`
    ).join('');
    html += `
      <div class="admin-row" style="margin-bottom: 8px;">
        <div class="admin-row__head">
          <div class="admin-row__title">
            <span class="admin-row__id">${esc(comp.id || `c${cidx}`)}</span>
            <strong>${esc(comp.label || '')}</strong>
          </div>
          <button type="button" class="admin-row__remove"
                  data-action="remove-pack-component" data-id="${esc(id)}" data-idx="${esc(cidx)}"
                  title="Quitar componente" aria-label="Quitar componente">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Etiqueta
            <input type="text" value="${esc(comp.label || '')}" data-cfg-path="packs.${esc(id)}.components.${esc(cidx)}.label">
          </label>
          <label>Producto
            <select data-cfg-path="packs.${esc(id)}.components.${esc(cidx)}.product">${productOptions}</select>
          </label>
          ${isBundle ? `
          <label>Cantidad por pack
            <input type="number" step="1" min="1" value="${esc(comp.qty_per_pack ?? 1)}" data-cfg-path="packs.${esc(id)}.components.${esc(cidx)}.qty_per_pack">
          </label>` : ''}
        </div>
      </div>
    `;
  });
  html += `
    <div class="admin-row-add" style="margin-bottom: 12px;">
      <button type="button" class="btn btn-ghost" data-action="add-pack-component" data-id="${esc(id)}"
              ${productIds.length === 0 ? 'disabled title="Crea antes un producto"' : ''}>
        <svg class="icon"><use href="#i-plus"/></svg> Añadir componente
      </button>
    </div>
  `;
  return html;
}

function renderBundlePrices(cfg, id, pack) {
  let html = `<div class="admin-mini-head">PVP por combinación y tramo (IVA incl.)</div>`;
  const combos = optionCombos(pack.options);
  for (const combo of combos) {
    if (!pack.bundle_prices) pack.bundle_prices = {};
    const row = pack.bundle_prices[combo] || {};
    html += `<div class="admin-subhead">${esc(comboLabel(pack, combo))}</div>`;
    html += '<div class="admin-grid">';
    for (const t of cfg.tiers) {
      const value = row[t.id];
      html += `
        <label>${esc(t.id)} · ${esc(t.label || '')}
          <input type="number" step="0.01" min="0" value="${esc(value ?? 0)}" data-cfg-path="packs.${esc(id)}.bundle_prices.${esc(combo)}.${esc(t.id)}">
        </label>
      `;
    }
    html += '</div>';
  }
  html += `
    <div class="admin-row-add" style="margin-top: 6px;">
      <button type="button" class="btn btn-secondary" data-action="apply-recommended-pack" data-id="${esc(id)}">
        <svg class="icon"><use href="#i-trend"/></svg> Aplicar PVP recomendado
      </button>
      <span class="hint" style="margin-left: 10px;">Suma el PVP recomendado de los componentes para cada combinación y tramo.</span>
    </div>
  `;
  return html;
}

/** Human label for a combo key like "with_hood|two_sides". */
function comboLabel(pack, combo) {
  if (combo === '') return 'Único';
  const parts = combo.split('|');
  const labels = [];
  (pack.options || []).forEach((option, i) => {
    const valId = parts[i];
    const value = (option.values || []).find(v => v.id === valId);
    labels.push(value ? (value.label || valId) : valId);
  });
  return labels.join(' · ');
}

// ============================================================
// Tab router
// ============================================================
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

// ============================================================
// Mutations
// ============================================================

/**
 * Applies the value entered in an input/select/checkbox with
 * data-cfg-path to the config. Distinguishes by control type:
 *   - checkbox → boolean (checked)
 *   - number   → parseFloat (or null if empty)
 *   - text/select → string as-is (no trim, to keep the cursor)
 *
 * @param {object} cfg
 * @param {HTMLInputElement|HTMLSelectElement} input
 */
export function updateConfigFromInput(cfg, input) {
  const path = input.dataset.cfgPath.split('.');
  let value;
  const type = input.type;
  if (type === 'checkbox') {
    value = !!input.checked;
  } else if (type === 'number') {
    value = input.value === '' ? null : parseFloat(input.value);
    if (Number.isNaN(value)) value = null;
  } else {
    value = input.value;
  }

  let obj = cfg;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (obj[key] === undefined || obj[key] === null) return; // invalid path
    obj = obj[key];
  }
  obj[path[path.length - 1]] = value;
}

/**
 * Runs a row/builder action. Returns { error?, dirty? }; on error
 * the caller must show it and NOT refresh.
 */
export function executeAdminAction(cfg, dataset) {
  const action = dataset.action || dataset.actionChange;
  const id = dataset.id;
  const idx = dataset.idx !== undefined ? parseInt(dataset.idx, 10) : undefined;
  const vidx = dataset.vidx !== undefined ? parseInt(dataset.vidx, 10) : undefined;

  switch (action) {
    // Tiers
    case 'add-tier':    return addTier(cfg);
    case 'remove-tier': return removeTier(cfg, idx);

    // Suppliers
    case 'add-supplier':    return addSupplier(cfg);
    case 'remove-supplier': return removeSupplier(cfg, id);

    // Products
    case 'add-product':              return addProduct(cfg);
    case 'remove-product':           return removeProduct(cfg, id);
    case 'add-product-supplier':     return addProductSupplier(cfg, id);
    case 'remove-product-supplier':  return removeProductSupplier(cfg, id, idx);
    case 'set-default-supplier':     return setDefaultSupplier(cfg, id, idx);
    case 'apply-recommended-product':return applyRecommendedProduct(cfg, id);

    // Addons
    case 'add-addon':              return addAddon(cfg);
    case 'remove-addon':           return removeAddon(cfg, id);
    case 'toggle-addon-category':  return toggleAddonCategory(cfg, id, dataset.cat);

    // Packs
    case 'add-pack':               return addPack(cfg);
    case 'remove-pack':            return removePack(cfg, id);
    case 'set-pricing-mode':       return setPricingMode(cfg, id, dataset.value);
    case 'toggle-free-components': return toggleFreeComponents(cfg, id, dataset.checked);
    case 'add-pack-option':        return addPackOption(cfg, id);
    case 'remove-pack-option':     return removePackOption(cfg, id, idx);
    case 'add-option-value':       return addOptionValue(cfg, id, idx);
    case 'remove-option-value':    return removeOptionValue(cfg, id, idx, vidx);
    case 'add-pack-component':     return addPackComponent(cfg, id);
    case 'remove-pack-component':  return removePackComponent(cfg, id, idx);
    case 'apply-recommended-pack': return applyRecommendedPack(cfg, id);

    default: return { error: `Acción desconocida: ${action}` };
  }
}

// ------------------------------------------------------------
// Tiers (cascade now updates products.prices and bundle_prices)
// ------------------------------------------------------------
function addTier(cfg) {
  const tiers = cfg.tiers;
  const newId = nextTierId(cfg);
  const last = tiers[tiers.length - 1];

  let from = 1;
  if (last) {
    if (last.to === null || last.to === undefined) {
      from = (last.from || 0) + 1;
      last.to = (last.from || 0);
    } else {
      from = last.to + 1;
    }
  }

  tiers.push({
    id:             newId,
    label:          `Tramo ${tiers.length + 1}`,
    from,
    to:             null,
    time_reduction: last ? (last.time_reduction ?? 0) : 0
  });

  const prevId = last ? last.id : null;

  // Cascade: every product price face gains the new tier (copying the
  // previous last tier so the admin does not start from zero).
  for (const product of Object.values(cfg.products || {})) {
    if (!product.prices) product.prices = {};
    for (const [faceKey] of PRICE_FACES) {
      if (!product.prices[faceKey]) product.prices[faceKey] = {};
      const prev = prevId ? product.prices[faceKey][prevId] : null;
      product.prices[faceKey][newId] = prev ?? 0;
    }
  }

  // Cascade: every bundle pack's bundle_prices gains the new tier.
  for (const pack of Object.values(cfg.packs || {})) {
    if (pack.pricing_mode !== 'bundle') continue;
    if (!pack.bundle_prices) pack.bundle_prices = {};
    for (const combo of optionCombos(pack.options)) {
      if (!pack.bundle_prices[combo]) pack.bundle_prices[combo] = {};
      const prev = prevId ? pack.bundle_prices[combo][prevId] : null;
      pack.bundle_prices[combo][newId] = prev ?? 0;
    }
  }
  return { dirty: true };
}

function removeTier(cfg, idx) {
  const tiers = cfg.tiers;
  if (tiers.length <= 1) return { error: 'Debe quedar al menos un tramo.' };
  const tier = tiers[idx];
  if (!tier) return { error: 'Tramo no encontrado.' };

  if (!confirmAction(`¿Eliminar el tramo "${tier.label || tier.id}"? Se quitará el PVP correspondiente de todos los productos y packs.`)) {
    return { dirty: false };
  }

  tiers.splice(idx, 1);

  for (const product of Object.values(cfg.products || {})) {
    for (const [faceKey] of PRICE_FACES) {
      if (product.prices?.[faceKey]) delete product.prices[faceKey][tier.id];
    }
  }
  for (const pack of Object.values(cfg.packs || {})) {
    if (pack.pricing_mode !== 'bundle' || !pack.bundle_prices) continue;
    for (const combo of Object.keys(pack.bundle_prices)) {
      if (pack.bundle_prices[combo]) delete pack.bundle_prices[combo][tier.id];
    }
  }
  return { dirty: true };
}

function nextTierId(cfg) {
  let max = 0;
  for (const t of cfg.tiers) {
    const m = /^T(\d+)$/.exec(t.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `T${max + 1}`;
}

// ------------------------------------------------------------
// Suppliers
// ------------------------------------------------------------
function addSupplier(cfg) {
  if (!cfg.suppliers) cfg.suppliers = {};
  const id = nextId(cfg.suppliers, 'SUPPLIER_');
  cfg.suppliers[id] = { name: 'Nuevo proveedor', web: '', notes: '' };
  return { dirty: true, id };
}

function removeSupplier(cfg, id) {
  if (!cfg.suppliers?.[id]) return { error: 'Proveedor no encontrado.' };
  if (isSupplierInUse(cfg, id)) {
    return { error: `El proveedor ${id} lo usa algún producto y no se puede eliminar.` };
  }
  if (!confirmAction(`¿Eliminar el proveedor ${id}?`)) return { dirty: false };
  delete cfg.suppliers[id];
  return { dirty: true };
}

function isSupplierInUse(cfg, id) {
  for (const product of Object.values(cfg.products || {})) {
    if ((product.suppliers || []).some(s => s.supplier === id)) return true;
  }
  return false;
}

// ------------------------------------------------------------
// Products
// ------------------------------------------------------------
function addProduct(cfg) {
  if (!cfg.products) cfg.products = {};
  const id = nextId(cfg.products, 'PRODUCT_');
  const supplierIds = Object.keys(cfg.suppliers || {});
  const defaultSupplier = supplierIds[0] || 'ROLY';

  const prices = {};
  for (const [faceKey] of PRICE_FACES) {
    prices[faceKey] = {};
    for (const t of cfg.tiers) prices[faceKey][t.id] = 0;
  }

  cfg.products[id] = {
    name:           'Nuevo producto',
    category:       'general',
    extra_cost_3xl: 0,
    target_margin:  numberOr(cfg.parameters?.default_target_margin, 0.35),
    suppliers: [
      { supplier: defaultSupplier, ref: '', price: 0, min_order: 0, is_default: true }
    ],
    prices
  };
  return { dirty: true, id };
}

function removeProduct(cfg, id) {
  if (!cfg.products?.[id]) return { error: 'Producto no encontrado.' };
  if (isProductInUse(cfg, id)) {
    return { error: `El producto ${id} lo usa algún pack y no se puede eliminar.` };
  }
  if (!confirmAction(`¿Eliminar el producto ${id}?`)) return { dirty: false };
  delete cfg.products[id];
  return { dirty: true };
}

function addProductSupplier(cfg, id) {
  const product = cfg.products?.[id];
  if (!product) return { error: 'Producto no encontrado.' };
  if (!Array.isArray(product.suppliers)) product.suppliers = [];
  const supplierIds = Object.keys(cfg.suppliers || {});
  if (supplierIds.length === 0) return { error: 'Crea antes un proveedor.' };
  const isFirst = product.suppliers.length === 0;
  product.suppliers.push({
    supplier: supplierIds[0],
    ref: '',
    price: 0,
    min_order: 0,
    is_default: isFirst
  });
  return { dirty: true };
}

function removeProductSupplier(cfg, id, idx) {
  const product = cfg.products?.[id];
  if (!product || !Array.isArray(product.suppliers)) return { error: 'Producto no encontrado.' };
  if (product.suppliers.length <= 1) return { error: 'Debe quedar al menos un proveedor.' };
  const removed = product.suppliers.splice(idx, 1)[0];
  // If we removed the default, promote the first remaining one.
  if (removed && removed.is_default && !product.suppliers.some(s => s.is_default)) {
    product.suppliers[0].is_default = true;
  }
  return { dirty: true };
}

function setDefaultSupplier(cfg, id, idx) {
  const product = cfg.products?.[id];
  if (!product || !Array.isArray(product.suppliers)) return { error: 'Producto no encontrado.' };
  product.suppliers.forEach((s, i) => { s.is_default = (i === idx); });
  return { dirty: true };
}

function applyRecommendedProduct(cfg, id) {
  const product = cfg.products?.[id];
  if (!product) return { error: 'Producto no encontrado.' };
  if (!product.prices) product.prices = {};
  const margin = numberOr(product.target_margin, cfg.parameters?.default_target_margin);

  for (const [faceKey, , sides] of PRICE_FACES) {
    if (!product.prices[faceKey]) product.prices[faceKey] = {};
    for (const tier of cfg.tiers) {
      // Proration uses a representative order size for the tier so
      // shipping per garment is realistic (the tier's `from`, min 1).
      const totalForShipping = Math.max(tier.from || 1, 1);
      const cost = calculateGarmentCost(cfg, id, sides, tier, totalForShipping).total;
      const rec = recommendedPrice(cfg, cost, margin);
      product.prices[faceKey][tier.id] = Number.isFinite(rec.price) ? rec.price : 0;
    }
  }
  return { dirty: true };
}

function isProductInUse(cfg, id) {
  for (const pack of Object.values(cfg.packs || {})) {
    for (const comp of (pack.components || [])) {
      if (comp.product === id) return true;
    }
    for (const option of (pack.options || [])) {
      const map = option.maps_product;
      if (!map) continue;
      for (const [k, v] of Object.entries(map)) {
        if (k !== 'component' && v === id) return true;
      }
    }
  }
  return false;
}

// ------------------------------------------------------------
// Addons
// ------------------------------------------------------------
function addAddon(cfg) {
  if (!cfg.addons) cfg.addons = {};
  const id = nextId(cfg.addons, 'addon_');
  cfg.addons[id] = {
    label: 'Nuevo complemento',
    price: 0,
    vat_included: false,
    cost: 0,
    applies_to: ['*']
  };
  return { dirty: true, id };
}

function removeAddon(cfg, id) {
  if (!cfg.addons?.[id]) return { error: 'Complemento no encontrado.' };
  if (!confirmAction(`¿Eliminar el complemento ${id}?`)) return { dirty: false };
  delete cfg.addons[id];
  return { dirty: true };
}

function toggleAddonCategory(cfg, id, cat) {
  const addon = cfg.addons?.[id];
  if (!addon) return { error: 'Complemento no encontrado.' };
  if (!Array.isArray(addon.applies_to)) addon.applies_to = [];
  const list = addon.applies_to;
  const at = list.indexOf(cat);
  if (cat === '*') {
    // Selecting '*' clears the specific categories (they are subsumed).
    if (at >= 0) {
      list.splice(at, 1);
    } else {
      addon.applies_to = ['*'];
    }
  } else {
    // Selecting a specific category drops '*' (no longer "all").
    const star = list.indexOf('*');
    if (star >= 0) list.splice(star, 1);
    if (at >= 0) list.splice(list.indexOf(cat), 1);
    else list.push(cat);
  }
  // Never leave it empty: fall back to '*'.
  if (addon.applies_to.length === 0) addon.applies_to = ['*'];
  return { dirty: true };
}

// ------------------------------------------------------------
// Packs (builder)
// ------------------------------------------------------------
function addPack(cfg) {
  if (!cfg.packs) cfg.packs = {};
  const id = nextId(cfg.packs, 'pack_');
  const productIds = Object.keys(cfg.products || {});

  const pack = {
    name:          'Nuevo pack',
    description:   '',
    icon:          'i-pack',
    pricing_mode:  'components',
    min_total:     10,
    target_margin: numberOr(cfg.parameters?.default_target_margin, 0.35),
    options: [
      { id: 'sides', label: 'Caras', values: [
        { id: 'one_side', label: '1 cara', sides: 1 },
        { id: 'two_sides', label: '2 caras', sides: 2 }
      ] }
    ],
    components: productIds.length
      ? [{ id: 'item', label: cfg.products[productIds[0]].name || 'Producto', product: productIds[0] }]
      : []
  };
  // Without products an empty `components` array only validates if the
  // pack lets the user pick products at quote time (free_components).
  if (productIds.length === 0) pack.free_components = true;
  cfg.packs[id] = pack;
  return { dirty: true, id };
}

function removePack(cfg, id) {
  if (!cfg.packs?.[id]) return { error: 'Pack no encontrado.' };
  if (!confirmAction(`¿Eliminar el pack ${id}?`)) return { dirty: false };
  delete cfg.packs[id];
  return { dirty: true };
}

function setPricingMode(cfg, id, mode) {
  const pack = cfg.packs?.[id];
  if (!pack) return { error: 'Pack no encontrado.' };
  if (mode !== 'bundle' && mode !== 'components') return { error: 'Modo de precio inválido.' };
  pack.pricing_mode = mode;
  if (mode === 'bundle') {
    pack.free_components = false; // bundles cannot have free components
    ensureBundlePrices(cfg, pack);
    // bundle components need qty_per_pack
    for (const comp of (pack.components || [])) {
      if (!Number.isFinite(comp.qty_per_pack)) comp.qty_per_pack = 1;
    }
  } else {
    delete pack.bundle_prices;
  }
  return { dirty: true };
}

function toggleFreeComponents(cfg, id, checked) {
  const pack = cfg.packs?.[id];
  if (!pack) return { error: 'Pack no encontrado.' };
  const enable = (checked === true || checked === 'true');
  if (enable) {
    if (pack.pricing_mode === 'bundle') {
      return { error: 'Un pack por unidad (bundle) no puede tener componentes libres. Cambia a «por componentes» primero.' };
    }
    pack.free_components = true;
    pack.components = [];
  } else {
    pack.free_components = false;
    if (!Array.isArray(pack.components) || pack.components.length === 0) {
      const productIds = Object.keys(cfg.products || {});
      pack.components = productIds.length
        ? [{ id: 'item', label: cfg.products[productIds[0]].name || 'Producto', product: productIds[0] }]
        : [];
    }
  }
  return { dirty: true };
}

function addPackOption(cfg, id) {
  const pack = cfg.packs?.[id];
  if (!pack) return { error: 'Pack no encontrado.' };
  if (!Array.isArray(pack.options)) pack.options = [];
  const optId = nextArrayId(pack.options, 'option');
  pack.options.push({
    id: optId,
    label: 'Nueva opción',
    values: [{ id: 'value_1', label: 'Valor 1' }]
  });
  if (pack.pricing_mode === 'bundle') ensureBundlePrices(cfg, pack);
  return { dirty: true };
}

function removePackOption(cfg, id, idx) {
  const pack = cfg.packs?.[id];
  if (!pack || !Array.isArray(pack.options)) return { error: 'Pack no encontrado.' };
  pack.options.splice(idx, 1);
  if (pack.pricing_mode === 'bundle') ensureBundlePrices(cfg, pack);
  return { dirty: true };
}

function addOptionValue(cfg, id, oidx) {
  const pack = cfg.packs?.[id];
  const option = pack?.options?.[oidx];
  if (!option) return { error: 'Opción no encontrada.' };
  if (!Array.isArray(option.values)) option.values = [];
  const valId = nextArrayId(option.values, 'value');
  option.values.push({ id: valId, label: 'Nuevo valor' });
  if (pack.pricing_mode === 'bundle') ensureBundlePrices(cfg, pack);
  return { dirty: true };
}

function removeOptionValue(cfg, id, oidx, vidx) {
  const pack = cfg.packs?.[id];
  const option = pack?.options?.[oidx];
  if (!option || !Array.isArray(option.values)) return { error: 'Opción no encontrada.' };
  if (option.values.length <= 1) return { error: 'Debe quedar al menos un valor.' };
  option.values.splice(vidx, 1);
  if (pack.pricing_mode === 'bundle') ensureBundlePrices(cfg, pack);
  return { dirty: true };
}

function addPackComponent(cfg, id) {
  const pack = cfg.packs?.[id];
  if (!pack) return { error: 'Pack no encontrado.' };
  const productIds = Object.keys(cfg.products || {});
  if (productIds.length === 0) return { error: 'Crea antes un producto.' };
  if (!Array.isArray(pack.components)) pack.components = [];
  const compId = nextArrayId(pack.components, 'component');
  const comp = {
    id: compId,
    label: cfg.products[productIds[0]].name || 'Producto',
    product: productIds[0]
  };
  if (pack.pricing_mode === 'bundle') comp.qty_per_pack = 1;
  pack.components.push(comp);
  return { dirty: true };
}

function removePackComponent(cfg, id, idx) {
  const pack = cfg.packs?.[id];
  if (!pack || !Array.isArray(pack.components)) return { error: 'Pack no encontrado.' };
  pack.components.splice(idx, 1);
  return { dirty: true };
}

function applyRecommendedPack(cfg, id) {
  const pack = cfg.packs?.[id];
  if (!pack) return { error: 'Pack no encontrado.' };
  if (pack.pricing_mode !== 'bundle') return { error: 'Solo aplica a packs por unidad (bundle).' };
  ensureBundlePrices(cfg, pack);

  const margin = numberOr(pack.target_margin, cfg.parameters?.default_target_margin);

  for (const combo of optionCombos(pack.options)) {
    const selected = comboToSelectedOptions(pack, combo);
    const sides = sidesFromSelection(pack, selected);
    for (const tier of cfg.tiers) {
      const totalForShipping = Math.max(tier.from || 1, 1);
      let sum = 0;
      let ok = true;
      for (const comp of (pack.components || [])) {
        const productId = resolveComponentProduct(pack, comp, selected);
        if (!productId || !cfg.products[productId]) { ok = false; break; }
        const cost = calculateGarmentCost(cfg, productId, sides, tier, totalForShipping).total;
        const rec = recommendedPrice(cfg, cost, margin);
        if (!Number.isFinite(rec.price)) { ok = false; break; }
        sum += rec.price * (comp.qty_per_pack || 1);
      }
      if (ok) pack.bundle_prices[combo][tier.id] = round2(sum);
    }
  }
  return { dirty: true };
}

// ------------------------------------------------------------
// Pack helpers
// ------------------------------------------------------------

/** Ensures `bundle_prices` covers every option-combo × tier, keeping
 *  existing values and dropping stale combos. */
function ensureBundlePrices(cfg, pack) {
  if (!pack.bundle_prices) pack.bundle_prices = {};
  const combos = optionCombos(pack.options);
  const valid = new Set(combos);
  // Drop combos no longer valid (option/value removed).
  for (const key of Object.keys(pack.bundle_prices)) {
    if (!valid.has(key)) delete pack.bundle_prices[key];
  }
  for (const combo of combos) {
    if (!pack.bundle_prices[combo]) pack.bundle_prices[combo] = {};
    for (const t of cfg.tiers) {
      if (pack.bundle_prices[combo][t.id] === undefined) {
        pack.bundle_prices[combo][t.id] = 0;
      }
    }
  }
}

/** Selected-options map ({optionId: valueId}) from a combo key. */
function comboToSelectedOptions(pack, combo) {
  const selected = {};
  const parts = combo === '' ? [] : combo.split('|');
  (pack.options || []).forEach((option, i) => {
    if (parts[i] !== undefined) selected[option.id] = parts[i];
  });
  return selected;
}

/** Number of sides implied by the selection (default 1). Mirrors
 *  calculo.js `calculatePack`: when several option values carry
 *  `sides`, the LAST match wins so the cost basis stays in lockstep. */
function sidesFromSelection(pack, selected) {
  let sides = 1;
  for (const option of (pack.options || [])) {
    const value = (option.values || []).find(v => v.id === selected[option.id]);
    if (value && Number.isFinite(value.sides)) sides = value.sides;
  }
  return sides;
}

/** Mirrors calculo.js resolveComponentProduct for the recommended sum. */
function resolveComponentProduct(pack, component, selectedOptions) {
  let productId = component.product;
  for (const option of (pack.options || [])) {
    const map = option.maps_product;
    if (map && map.component === component.id) {
      const selectedId = selectedOptions[option.id];
      if (selectedId !== undefined && map[selectedId] !== undefined) {
        productId = map[selectedId];
      }
    }
  }
  return productId;
}

// ------------------------------------------------------------
// Generic helpers
// ------------------------------------------------------------

/** Cartesian product of option value ids, joined with '|' in order.
 *  Mirrors lib/config-schema.js `optionCombos`. */
function optionCombos(options) {
  const opts = Array.isArray(options) ? options : [];
  let combos = [''];
  for (const option of opts) {
    const valueIds = (option.values || []).map(v => v.id);
    if (valueIds.length === 0) continue;
    const next = [];
    for (const prefix of combos) {
      for (const vId of valueIds) {
        next.push(prefix === '' ? vId : `${prefix}|${vId}`);
      }
    }
    combos = next;
  }
  return combos;
}

/** Next free `PREFIX<n>` key for an object map. */
function nextId(map, prefix) {
  let n = 1;
  while (map[`${prefix}${n}`]) n++;
  return `${prefix}${n}`;
}

/** Next free `<base>_<n>` id for an array of { id }. */
function nextArrayId(arr, base) {
  const ids = new Set((arr || []).map(x => x && x.id));
  let n = 1;
  while (ids.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Every distinct product category in the config (sorted). */
function collectCategories(cfg) {
  const cats = new Set();
  for (const product of Object.values(cfg.products || {})) {
    if (product.category) cats.add(product.category);
  }
  return Array.from(cats).sort();
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
