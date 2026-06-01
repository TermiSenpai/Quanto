// ============================================================
// PackPrice · Admin mode editor
// ============================================================
// Pure render functions (return HTML strings), plus controlled
// config mutations:
//   - applyConfigInput  (a field change)
//   - runAdminAction    (add/remove a row)
//
// Orchestration (open/close modal, login, IPC) lives in app.js.
// Config schema: v3 (English keys). User-facing labels stay in
// Spanish (CLAUDE.md §4.5).
// ============================================================

// ------------------------------------------------------------
// Parameters: grouped by category so they are easier to find.
// Each group is a titled section; the "Impuestos y recargos"
// group is highlighted because it holds VAT and the surcharges
// that change most often.
// ------------------------------------------------------------
const PARAMETER_GROUPS = [
  { title: 'Impuestos y recargos', highlight: true, items: [
    { key: 'vat',                  label: 'IVA aplicado',           hint: 'Decimal: 0.21 = 21%', step: 0.01, min: 0, max: 1 },
    { key: 'surcharge_4xl_eur',    label: 'Recargo 4XL (€/prenda)', hint: 'Se factura al cliente', step: 0.01, min: 0 },
    { key: 'surcharge_5xl_eur',    label: 'Recargo 5XL+ (€/prenda)', step: 0.01, min: 0 },
    { key: 'buffer_3xl_eur_pack',  label: 'Buffer 3XL (€/pack peña)', hint: 'Colchón interno · no se factura', step: 0.01, min: 0 }
  ]},
  { title: 'Extras opcionales (sin IVA)', items: [
    { key: 'extra_name_eur',         label: 'Nombre (€/ud)',         hint: 'Sin IVA · se factura al cliente', step: 0.01, min: 0 },
    { key: 'extra_short_sleeve_eur', label: 'Manga corta (€/manga)', hint: 'Sin IVA', step: 0.01, min: 0 },
    { key: 'extra_long_sleeve_eur',  label: 'Manga larga (€/manga)', hint: 'Sin IVA', step: 0.01, min: 0 }
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
    { key: 'roly_shipping_eur_bundle', label: 'Envío Roly (€/bulto)', step: 0.01, min: 0 },
    { key: 'garments_per_bundle',      label: 'Prendas por bulto', step: 1, min: 1 }
  ]}
];

// Crew/single price-structure keys with their Spanish UI labels.
const HOOD_VARIANTS = [['without_hood', 'Sin capucha'], ['with_hood', 'Con capucha']];
const SIDES_VARIANTS = [['two_sides', '2 caras'], ['one_side', '1 cara']];

// ------------------------------------------------------------
// Escape helper
// ------------------------------------------------------------
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ------------------------------------------------------------
// Color per pack: deterministic — depends on the pack index in
// the config so each pack keeps the same hue between re-renders.
// ------------------------------------------------------------
const PACK_COLOR_TOKENS = [
  '--pack-color-1', '--pack-color-2', '--pack-color-3',
  '--pack-color-4', '--pack-color-5', '--pack-color-6'
];

export function packColorToken(packId, idx) {
  return PACK_COLOR_TOKENS[idx % PACK_COLOR_TOKENS.length];
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
          <input type="number"${stepAttr}${minAttr}${maxAttr} value="${valueAttr}" data-cfg-path="parameters.${it.key}">
        </label>
      `;
    }
    html += '</div></div>';
  }
  return html;
}

// ============================================================
// ROLY MODELS
// ============================================================
export function renderAdminModels(cfg) {
  let html = '<p class="hint" style="margin-bottom: 12px;">Modelos Roly que se usan como base de cada pack. No se pueden eliminar los que estén en uso.</p>';

  for (const [id, m] of Object.entries(cfg.roly_models)) {
    const inUse = isModelInUse(cfg, id);
    html += `
      <div class="admin-row">
        <div class="admin-row__head">
          <div class="admin-row__title">
            <span class="admin-row__id">${esc(id)}</span>
            <strong>${esc(m.name || '—')}</strong>
            ${inUse ? '<span class="badge badge--neutral" style="margin-left: 6px;">en uso</span>' : ''}
          </div>
          <button type="button" class="admin-row__remove"
                  data-action="remove-model" data-id="${esc(id)}"
                  ${inUse ? 'disabled title="Está siendo usado por algún pack"' : 'title="Eliminar modelo"'}
                  aria-label="Eliminar modelo ${esc(id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Nombre
            <input type="text" value="${esc(m.name || '')}" data-cfg-path="roly_models.${id}.name">
          </label>
          <label>Referencia Roly
            <input type="text" value="${esc(m.ref || '')}" data-cfg-path="roly_models.${id}.ref">
          </label>
          <label>Precio base (€) <span class="hint">sin IVA, sin DTF</span>
            <input type="number" step="0.0001" min="0" value="${m.price ?? 0}" data-cfg-path="roly_models.${id}.price">
          </label>
        </div>
      </div>
    `;
  }

  html += `
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-action="add-model">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir modelo
      </button>
    </div>
  `;
  return html;
}

// ============================================================
// TIERS
// ============================================================
export function renderAdminTiers(cfg) {
  let html = '<p class="hint" style="margin-bottom: 12px;">Cada tramo activa un PVP distinto en cada pack. Si añades o eliminas tramos los packs se ajustan automáticamente y mantienen los valores existentes.</p>';

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
                  data-action="remove-tier" data-idx="${i}"
                  ${disableRemove ? 'disabled title="Debe quedar al menos un tramo"' : 'title="Eliminar tramo"'}
                  aria-label="Eliminar tramo ${esc(t.id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Etiqueta
            <input type="text" value="${esc(t.label || '')}" data-cfg-path="tiers.${i}.label">
          </label>
          <label>Reducción de tiempo <span class="hint">decimal · 0.10 = 10%</span>
            <input type="number" step="0.01" min="0" max="1" value="${t.time_reduction ?? 0}" data-cfg-path="tiers.${i}.time_reduction">
          </label>
          <label>Desde (uds)
            <input type="number" min="1" step="1" value="${t.from ?? 0}" data-cfg-path="tiers.${i}.from">
          </label>
          <label>Hasta (uds) <span class="hint">vacío = sin límite</span>
            <input type="number" min="1" step="1" value="${t.to === null || t.to === undefined ? '' : t.to}" data-cfg-path="tiers.${i}.to">
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
// PACKS (prices) — each pack with its color
// ============================================================
export function renderAdminPacks(cfg) {
  let html = '<p class="hint" style="margin-bottom: 16px;">PVP por tramo, IVA incluido. Cada pack tiene un color para localizarlo a simple vista. El pack mixto reusa los precios de los packs que referencia.</p>';

  let idx = 0;
  for (const [id, pack] of Object.entries(cfg.packs)) {
    const colorToken = packColorToken(id, idx);
    idx++;

    if (pack.type === 'mixed') {
      html += `
        <section class="admin-pack" style="--pack-color: var(${colorToken});">
          <header class="admin-pack__head">
            <span class="admin-pack__dot"></span>
            <h4>${esc(pack.name)}</h4>
          </header>
          <div class="admin-pack__body">
            <p class="hint">Reusa los PVP de
              <strong>${esc(pack.reference_packs?.CLASICA || '—')}</strong> y
              <strong>${esc(pack.reference_packs?.URBAN || '—')}</strong>.
              Si quieres cambiar precios, edítalos en sus packs originales.
            </p>
          </div>
        </section>
      `;
      continue;
    }

    if (pack.type === 'custom') {
      const refs = Object.entries(pack.reference_models || {})
        .map(([model, refId]) => `<strong>${esc(model)}</strong> → <code>${esc(refId)}</code>`)
        .join(' · ');
      html += `
        <section class="admin-pack" style="--pack-color: var(${colorToken});">
          <header class="admin-pack__head">
            <span class="admin-pack__dot"></span>
            <h4>${esc(pack.name)}</h4>
          </header>
          <div class="admin-pack__body">
            <p class="hint">
              Mínimo total: <strong>${pack.min_total ?? '—'}</strong> prendas.
              Cada modelo factura al PVP del pack indicado:
              ${refs || '—'}.
              Edita los precios en cada pack individual.
            </p>
          </div>
        </section>
      `;
      continue;
    }

    html += `<section class="admin-pack" style="--pack-color: var(${colorToken});">`;
    html += `
      <header class="admin-pack__head">
        <span class="admin-pack__dot"></span>
        <h4>${esc(pack.name)}</h4>
      </header>
      <div class="admin-pack__body">
    `;

    if (pack.type === 'crew') {
      for (const [hoodKey, hoodLabel] of HOOD_VARIANTS) {
        for (const [sidesKey, sidesLabel] of SIDES_VARIANTS) {
          html += `<div class="admin-mini-head">${hoodLabel} · ${sidesLabel}</div>`;
          html += '<div class="admin-grid">';
          for (const t of cfg.tiers) {
            const value = pack.prices?.[hoodKey]?.[sidesKey]?.[t.id];
            html += `
              <label>${esc(t.id)} · ${esc(t.label || '')}
                <input type="number" step="0.01" min="0" value="${value ?? 0}" data-cfg-path="packs.${id}.prices.${hoodKey}.${sidesKey}.${t.id}">
              </label>
            `;
          }
          html += '</div>';
        }
      }
    } else if (pack.type === 'single') {
      for (const [sidesKey, sidesLabel] of SIDES_VARIANTS) {
        html += `<div class="admin-mini-head">${sidesLabel}</div>`;
        html += '<div class="admin-grid">';
        for (const t of cfg.tiers) {
          const value = pack.prices?.[sidesKey]?.[t.id];
          html += `
            <label>${esc(t.id)} · ${esc(t.label || '')}
              <input type="number" step="0.01" min="0" value="${value ?? 0}" data-cfg-path="packs.${id}.prices.${sidesKey}.${t.id}">
            </label>
          `;
        }
        html += '</div>';
      }
    }

    html += '</div></section>';
  }
  return html;
}

// ============================================================
// Tab router
// ============================================================
export function renderAdminTabContent(cfg, tab) {
  switch (tab) {
    case 'parameters': return renderAdminParameters(cfg);
    case 'models':     return renderAdminModels(cfg);
    case 'tiers':      return renderAdminTiers(cfg);
    case 'packs':      return renderAdminPacks(cfg);
    default:           return '';
  }
}

// ============================================================
// Mutations
// ============================================================

/**
 * Applies the value entered in an input with data-cfg-path to the
 * config. Distinguishes by input type:
 *   - number → parseFloat (or null if empty)
 *   - text   → string as-is (no trim, to avoid moving the cursor)
 *
 * @param {object} cfg
 * @param {HTMLInputElement} input
 */
export function applyConfigInput(cfg, input) {
  const path = input.dataset.cfgPath.split('.');
  let value;
  if (input.type === 'text') {
    value = input.value;
  } else if (input.type === 'number') {
    value = input.value === '' ? null : parseFloat(input.value);
    if (Number.isNaN(value)) value = null;
  } else {
    value = input.value;
  }

  let obj = cfg;
  for (let i = 0; i < path.length - 1; i++) {
    if (!(path[i] in obj)) return; // invalid path, do not mutate
    obj = obj[path[i]];
  }
  obj[path[path.length - 1]] = value;
}

/**
 * Runs a row action (add/remove tier or model). Returns
 * { error?: string, dirty?: boolean }; on error the caller must
 * show it and NOT refresh.
 */
export function runAdminAction(cfg, dataset) {
  const action = dataset.action;

  if (action === 'add-tier')     return addTier(cfg);
  if (action === 'remove-tier')  return removeTier(cfg, parseInt(dataset.idx, 10));
  if (action === 'add-model')    return addModel(cfg);
  if (action === 'remove-model') return removeModel(cfg, dataset.id);

  return { error: `Acción desconocida: ${action}` };
}

// ------------------------------------------------------------
// Tiers
// ------------------------------------------------------------
function addTier(cfg) {
  const tiers = cfg.tiers;
  const newId = nextTierId(cfg);
  const last = tiers[tiers.length - 1];

  // If the last one had to:null (open-ended), close it so the new
  // one continues. Heuristic: the new one starts at
  // (last.to||last.from)+1 and is also left open (to:null).
  let from = 1;
  if (last) {
    if (last.to === null || last.to === undefined) {
      from = (last.from || 0) + 1;
      last.to = (last.from || 0); // keep it coherent; user will readjust
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

  // Cascade: add a price entry in every non-mixed pack, copying the
  // previous last tier's values if they existed (so the user does
  // not start from zero).
  for (const pack of Object.values(cfg.packs)) {
    if (pack.type === 'crew') {
      for (const [hoodKey] of HOOD_VARIANTS) {
        for (const [sidesKey] of SIDES_VARIANTS) {
          if (!pack.prices[hoodKey]) pack.prices[hoodKey] = {};
          if (!pack.prices[hoodKey][sidesKey]) pack.prices[hoodKey][sidesKey] = {};
          const prev = last ? pack.prices[hoodKey][sidesKey][last.id] : null;
          pack.prices[hoodKey][sidesKey][newId] = prev ?? 0;
        }
      }
    } else if (pack.type === 'single') {
      for (const [sidesKey] of SIDES_VARIANTS) {
        if (!pack.prices[sidesKey]) pack.prices[sidesKey] = {};
        const prev = last ? pack.prices[sidesKey][last.id] : null;
        pack.prices[sidesKey][newId] = prev ?? 0;
      }
    }
  }
  return { dirty: true };
}

function removeTier(cfg, idx) {
  const tiers = cfg.tiers;
  if (tiers.length <= 1) return { error: 'Debe quedar al menos un tramo.' };
  const tier = tiers[idx];
  if (!tier) return { error: 'Tramo no encontrado.' };

  const ok = window.confirm(
    `¿Eliminar el tramo "${tier.label || tier.id}"? Se quitará el PVP correspondiente de todos los packs.`
  );
  if (!ok) return { dirty: false };

  tiers.splice(idx, 1);

  for (const pack of Object.values(cfg.packs)) {
    if (pack.type === 'crew') {
      for (const [hoodKey] of HOOD_VARIANTS) {
        for (const [sidesKey] of SIDES_VARIANTS) {
          if (pack.prices?.[hoodKey]?.[sidesKey]) delete pack.prices[hoodKey][sidesKey][tier.id];
        }
      }
    } else if (pack.type === 'single') {
      for (const [sidesKey] of SIDES_VARIANTS) {
        if (pack.prices?.[sidesKey]) delete pack.prices[sidesKey][tier.id];
      }
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
// Roly models
// ------------------------------------------------------------
function addModel(cfg) {
  const id = nextModelId(cfg);
  cfg.roly_models[id] = {
    name:  'Nuevo modelo',
    ref:   '',
    price: 0
  };
  return { dirty: true };
}

function removeModel(cfg, id) {
  if (!cfg.roly_models[id]) return { error: 'Modelo no encontrado.' };
  if (isModelInUse(cfg, id)) {
    return { error: `El modelo ${id} está en uso por algún pack y no se puede eliminar.` };
  }
  const ok = window.confirm(`¿Eliminar el modelo ${id}?`);
  if (!ok) return { dirty: false };
  delete cfg.roly_models[id];
  return { dirty: true };
}

function nextModelId(cfg) {
  let n = 1;
  while (cfg.roly_models[`MODELO_${n}`]) n++;
  return `MODELO_${n}`;
}

/**
 * A model is "in use" if:
 *   - Some single pack points to it as pack.model.
 *   - It is one of the hardcoded crew-pack models (BEAGLE/CLASICA/
 *     URBAN), since calculateCrewPack references them by id directly.
 */
function isModelInUse(cfg, id) {
  for (const p of Object.values(cfg.packs)) {
    if (p.model === id) return true;
  }
  if (id === 'BEAGLE' || id === 'CLASICA' || id === 'URBAN') return true;
  return false;
}
