// ============================================================
// Quanto - First-run catalog wizard (renderer)
// ============================================================
// Builds the whole catalog from blank, reusing the admin editor's
// render + mutation functions. The config is held in memory and only
// persisted at the end (file: config:create / cloud: catalog:seed-initial).
//
// The catalog steps reuse renderer/admin.js verbatim: each step renders
// one admin "tab" into #catwiz-body and replicates the admin editor's
// master/detail navigation (matched 1:1 with app.js showAdminTab):
//   - a list row click (.admin-list__row, except the [data-action] remove
//     button) opens that entity's editor (row.dataset.edit -> editingId);
//   - the editor's [data-back] button returns to the list;
//   - field edits ([data-cfg-path]) write straight into the config with no
//     re-render (cursor/scroll preserved);
//   - structural actions ([data-action] buttons + [data-action-change]
//     live controls) mutate via executeAdminAction and re-render in place;
//     a top-level add-* that returns a new id jumps into its editor.
// Because every structural action re-renders #catwiz-body, all UI state
// lives here (view/editingId), never in the DOM — same as the admin tab.
// ============================================================

'use strict';

import { el, show, hide } from './format.js';
import { enhanceDropdowns } from './dropdown.js';
import {
  renderAdminTabContent,
  updateConfigFromInput,
  executeAdminAction,
  esc
} from './admin.js';
import { WIZARD_STEPS, stepErrors, wizardReady } from './wizard-validation.js';

// Steps whose body is an admin tab (master/detail). 'company' is bespoke.
const ADMIN_TAB_STEPS = new Set(['parameters', 'tiers', 'suppliers', 'products', 'packs', 'addons']);

// Catalog tabs that have a list <-> editor view (vs. flat tabs like
// parameters/tiers, which render a single form with no detail view).
const MASTER_DETAIL_STEPS = new Set(['suppliers', 'products', 'packs', 'addons']);

let cfg = null;        // in-memory config being built
let stepIndex = 0;     // index into WIZARD_STEPS
let view = 'list';     // 'list' | 'editor' for master/detail tabs
let editingId = null;  // current entity id in editor view
let onDone = null;     // async (cfg) => void  (persist + boot app)

export async function startCatalogWizard({ mode, userName, done }) {
  cfg = await window.packprice.getEmptyConfig({ modificadoPor: userName });
  if (cfg && cfg.company) cfg.company.name = '';
  stepIndex = 0; view = 'list'; editingId = null; onDone = done;
  el('catalog-wizard').dataset.mode = mode;
  bindNav();
  hide('setup-wizard');
  show('catalog-wizard');
  renderStep();
}

let navBound = false;
function bindNav() {
  if (navBound) return;
  navBound = true;
  el('btn-catwiz-back').addEventListener('click', goBack);
  el('btn-catwiz-next').addEventListener('click', goNext);
  el('btn-catwiz-finish').addEventListener('click', finish);
}

function currentStep() { return WIZARD_STEPS[stepIndex]; }

function renderSteps() {
  el('catwiz-steps').innerHTML = WIZARD_STEPS.map((s, i) => {
    const cls = i === stepIndex ? 'is-current' : (i < stepIndex ? 'is-done' : '');
    return `<li class="wizard-steps__dot ${cls}">${esc(s.label)}</li>`;
  }).join('');
}

function renderStep() {
  const step = currentStep();
  hideError();
  const body = el('catwiz-body');
  if (ADMIN_TAB_STEPS.has(step.id)) {
    const useEditor = MASTER_DETAIL_STEPS.has(step.id) && view === 'editor' && editingId;
    body.innerHTML = renderAdminTabContent(cfg, step.id, useEditor ? 'editor' : 'list', editingId);
  } else if (step.id === 'company') {
    body.innerHTML = renderCompanyStep(cfg);
  }
  enhanceDropdowns(body);
  bindBody(step.id);
  renderSteps();
  refreshGate();
}

// ------------------------------------------------------------
// Body wiring — mirrors app.js showAdminTab (master/detail nav, field
// edits, structural actions). Re-bound on every renderStep() because the
// whole body re-renders on each structural change.
// ------------------------------------------------------------
function bindBody(stepId) {
  const body = el('catwiz-body');

  // Field edits: write straight into cfg, no re-render (keeps cursor).
  body.querySelectorAll('[data-cfg-path]').forEach(input => {
    input.addEventListener('change', () => {
      updateConfigFromInput(cfg, input);
      refreshGate();
    });
  });

  // Structural actions: buttons (data-action) + live controls
  // (data-action-change on radios/checkboxes/selects) that mutate the
  // config and re-render afterwards.
  const runAction = (dataset) => {
    const result = executeAdminAction(cfg, dataset) || {};
    if (result.error) { showError(result.error); return; }
    if (!result.dirty) { return; } // e.g. a cancelled confirm: nothing changed
    // A top-level add-* (supplier/product/pack/addon) returns the new id;
    // jump straight into its editor. Other structural actions re-render in
    // place (they return no id), matching the admin editor.
    if (MASTER_DETAIL_STEPS.has(stepId) && result.id && String(dataset.action || '').startsWith('add-')) {
      view = 'editor';
      editingId = result.id;
    }
    renderStep();
  };

  body.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => runAction(btn.dataset));
  });

  body.querySelectorAll('[data-action-change]').forEach(ctrl => {
    ctrl.addEventListener('change', () => {
      runAction({
        action: ctrl.dataset.actionChange,
        id: ctrl.dataset.id,
        idx: ctrl.dataset.idx,
        vidx: ctrl.dataset.vidx,
        cat: ctrl.dataset.cat,
        value: ctrl.value,
        checked: ctrl.type === 'checkbox' ? ctrl.checked : undefined
      });
    });
  });

  if (!MASTER_DETAIL_STEPS.has(stepId)) return;

  // List: open the editor on a row click. Bind to the ROW; the inner
  // "Editar" button carries no data-action, so its click bubbles up here.
  // The remove button has data-action, so we bail and let its handler run.
  body.querySelectorAll('.admin-list__row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return; // remove button -> skip
      view = 'editor';
      editingId = row.dataset.edit;
      renderStep();
    });
  });

  // Editor: "back to list".
  const backBtn = body.querySelector('[data-back]');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      view = 'list';
      editingId = null;
      renderStep();
    });
  }
}

// ------------------------------------------------------------
// Company step (bespoke — the only step that is not an admin tab).
// ------------------------------------------------------------
function renderCompanyStep(c) {
  const co = c.company || {};
  const field = (key, label, type = 'text') =>
    `<label class="field"><span>${esc(label)}</span>
       <input type="${type}" data-cfg-path="company.${key}" value="${esc(co[key] ?? '')}"></label>`;
  return `<div class="wizard-company">
    <h2>Datos de tu empresa (para el PDF)</h2>
    ${field('name', 'Nombre comercial')}
    ${field('tax_id', 'NIF / CIF')}
    ${field('address', 'Dirección')}
    ${field('phone', 'Teléfono', 'tel')}
    ${field('email', 'Email', 'email')}
    ${field('web', 'Web')}
  </div>`;
}

// ------------------------------------------------------------
// Navigation gating + step movement.
// ------------------------------------------------------------
function refreshGate() {
  const errs = stepErrors(cfg, currentStep().id);
  const isLast = stepIndex === WIZARD_STEPS.length - 1;
  el('btn-catwiz-back').disabled = stepIndex === 0;
  el('btn-catwiz-next').classList.toggle('hidden', isLast);
  el('btn-catwiz-finish').classList.toggle('hidden', !isLast);
  if (isLast) {
    el('btn-catwiz-finish').disabled = !wizardReady(cfg);
  } else {
    el('btn-catwiz-next').disabled = errs.length > 0;
  }
}

function goNext() {
  const errs = stepErrors(cfg, currentStep().id);
  if (errs.length) { showError(errs[0]); return; }
  if (stepIndex < WIZARD_STEPS.length - 1) {
    stepIndex += 1; view = 'list'; editingId = null;
    renderStep();
  }
}

function goBack() {
  if (stepIndex > 0) { stepIndex -= 1; view = 'list'; editingId = null; renderStep(); }
}

async function finish() {
  if (!wizardReady(cfg)) { showError('Faltan datos mínimos en algún paso.'); return; }
  const btn = el('btn-catwiz-finish');
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Creando…';
  try {
    await onDone(cfg);
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
    btn.disabled = false; btn.textContent = original;
  }
}

function showError(msg) { el('catwiz-error').textContent = msg; show('catwiz-error'); }
function hideError() { hide('catwiz-error'); }
