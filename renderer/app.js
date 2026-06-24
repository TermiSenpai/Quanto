// ============================================================
// Quanto · Renderer (orchestration)
// ============================================================
// - Bootstrap and screen routing
// - DOM events
// - IPC calls to the main process via window.packprice
//
// Pure logic lives in:
//   - calculo.js  (pack calculation)
//   - admin.js    (admin editor rendering)
//   - format.js   (DOM/format helpers)
//
// Config and result data are v4 (English keys). The calculation flow
// is generic: it is driven entirely by the config (pack options,
// components, pricing_mode), so a new pack added to config renders and
// prices without code changes. HTML element IDs and CSS class names
// stay in their kebab-case form (CLAUDE.md §5.2/§5.3); user-facing
// strings stay in Spanish (§4.5).
// ============================================================

import { el, show, hide, intFromInput, formatEur, formatPct, deepClone } from './format.js';
import {
  calculatePack,
  calculateAddons,
  recommendedPrice,
  getTier
} from './calculo.js';
import {
  renderAdminTabContent,
  updateConfigFromInput,
  executeAdminAction,
  renderProductsList,
  renderPacksList,
  renderSuppliersList,
  renderAddonsList,
  matchesQuery
} from './admin.js';
import {
  renderAuditTab,
  renderDiffPreview,
  renderLogsModal,
  renderCloudAuditList,
  renderSnapshotsList
} from './admin-extras.js';
import {
  renderHistoryList,
  buildQuoteDraft
} from './history.js';
import { deriveDataStatus, formatFreshness, planRefreshTrigger } from './data-status.js';
import { buildGalleryModel } from './pdf-gallery.js';
import { buildSaveSummary, totalChanges } from './save-summary.js';
import { renderChangeGroup, renderEntityValues } from './change-format.js';
import { computeReminder } from './quote-reminder.js';
import {
  barChartH, barChartV, groupedBars, lineChart, histogram
} from './charts.js';
import {
  isEmptyStats, kpiTiles, packUsageBars, conversionGroups, weeklySeries,
  tierBars, marginGroups, deviationBuckets, topProductBars, topAddonBars,
  specialSizeBars, rangeForPeriod
} from './stats-view.js';
import { enhanceDropdowns } from './dropdown.js';
import { startCatalogWizard } from './catalog-wizard.js';

// ============================================================
// Module state
// ============================================================
let CFG = null;                  // current config loaded from the NAS
let SETTINGS = null;             // config_path + user_name
let adminConfigInfoAtOpen = null; // mtime + hash when admin opened (conflicts)
let CFG_BACKUP = null;           // copy for "Cancel changes"
let eventsBound = false;
let lastResult = null;           // useful for "Copy summary"

// v5 cloud: the last catalog load envelope drives the topbar indicator
// and the offline banner. In file mode it stays { source: 'file' }.
let DATA_STATE = { source: 'file' };
// Cloud wizard scratch state (token + accounts between steps). The
// token only lives here transiently and travels into main via
// provisionCloud; it is never written to CFG or surfaced after.
// `lastAccountId` lets the in-place Reintentar re-run provision with
// the same account, and `provisionInFlight` guards against re-entry.
let wizardCloud = { token: '', accounts: [], userName: '', lastAccountId: undefined };
let provisionInFlight = false;
// v5 cloud: the topbar "Actualizar" and the offline banner "Reintentar"
// share one refresh flow. This single flag guards both against
// double-clicks and re-entry (the busy button is whichever is visible).
let refreshInFlight = false;

// v5: the startup quote reminder runs once per boot, not on every cfg
// live-reload (refresh), so a dismissed banner stays dismissed.
let reminderChecked = false;
// Plan 7B: the app-version update check also runs once per boot (not on
// every refresh), and only when the per-PC toggle is on.
let updateChecked = false;
// v5 statistics screen scratch state: the active period and the last
// computed range, so "Aplicar"/re-render reuse the user's choice.
let statsState = { period: 'season', range: null };
const STATS_PERIOD_LABELS = {
  season: 'la temporada', '30d': 'los últimos 30 días',
  year: 'el último año', range: 'el rango elegido'
};

// v5 / Plan 6: PDF template gallery scratch state for the settings modal.
// The list (built-ins + cloud custom) and the built-in id set arrive over
// IPC (the renderer can't require the CommonJS templates module). The
// chosen id + brand color live on CFG.company (shared catalog data) and
// are persisted via the normal company save path (cloud saveCatalog /
// file config write). `selectedId` mirrors CFG.company.pdf_template while
// the modal is open so the preview/selection stay in sync without
// re-reading CFG on every interaction.
let pdfTpl = { templates: [], builtinIds: new Set(), selectedId: null, cloud: false };

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

// ============================================================
// Visual metadata per pack (card icon and description)
// ============================================================
// In v4 the icon and the description live in the config itself
// (`pack.icon` / `pack.description`). This helper reads them with a
// safe fallback so a brand-new pack added to the config renders
// without any code change.
function packMeta(pack) {
  return {
    icon: pack && pack.icon ? pack.icon : 'i-pack',
    desc: pack && pack.description ? pack.description : ''
  };
}

const ADMIN_TAB_META = {
  parameters: { title: 'Parámetros de cálculo', desc: 'Variables que afectan al coste interno, al recargo de tallas grandes y al PVP recomendado.' },
  suppliers:  { title: 'Proveedores',           desc: 'Registro de proveedores que abastecen los productos.' },
  products:   { title: 'Productos',             desc: 'Prendas del catálogo: proveedores, coste, margen y tabla de PVP.' },
  addons:     { title: 'Complementos',          desc: 'Extras opcionales (nombre, mangas…) con su precio y a qué categorías aplican.' },
  tiers:      { title: 'Tramos por volumen',    desc: 'Rangos de unidades que activan cada tramo y su reducción de tiempo.' },
  packs:      { title: 'Packs',                 desc: 'Crea y edita packs: opciones, componentes y PVP por unidad o por componentes.' },
  audit:      { title: 'Historial',              desc: 'Quién cambió qué y cuándo. En la nube también puedes restaurar versiones anteriores.' }
};

// Catalog tabs use the list↔editor (master/detail) flow; the other tabs
// (parameters, tiers, audit) render a single form straight from the router.
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

// v5 cloud Historial: how many audit entries to fetch per page. «Cargar
// más» appends another page at the next offset.
const AUDIT_PAGE_SIZE = 50;

// Cloud Historial scratch state (this session only): which sub-view is
// active, the audit entries loaded so far and the next offset to fetch.
// Reset every time the editor (re)opens the Historial tab in cloud mode.
let historyState = { view: 'audit', auditEntries: [], auditOffset: 0, auditDone: false };

// ============================================================
// Bootstrap: decide which screen to show
// ============================================================

async function bootstrap() {
  // Welcome-screen version label, pulled live from the app. It used to be
  // hardcoded in the HTML and drifted to a stale value; fire-and-forget so
  // a failure can never block boot.
  window.packprice.getAppVersion()
    .then((v) => { const e = el('bv-version'); if (e && v) e.textContent = 'v' + v; })
    .catch(() => {});

  // Any boot IPC (readSettings, loadCatalog, readConfig) can reject —
  // network blip, a corrupt settings.json, an unhandled main error. We
  // never want a blank window (hard rule #4: show it, don't swallow):
  // route the failure to the error screen with a Reintentar that
  // re-runs the whole boot.
  try {
    SETTINGS = await window.packprice.readSettings();

    // v5: cloud mode is configured → drive the screens off the cloud
    // read path (cloud → cache → error). The file-mode path below is
    // unchanged.
    if (SETTINGS && SETTINGS.data_source === 'cloud') {
      await loadCloudAndShowApp();
      return;
    }

    // No data source configured at all (no legacy file path AND not
    // cloud) → first-run wizard. A pre-v5 install with a config_path +
    // user_name still boots straight into file mode (no wizard), so
    // upgrades are seamless.
    const hasFileSetup = SETTINGS && SETTINGS.config_path && SETTINGS.user_name;
    if (!hasFileSetup) {
      showSetupWizard();
      return;
    }

    await loadConfigAndShowApp();
  } catch (err) {
    showBootErrorScreen(err);
  }
}

/**
 * Last-resort boot error screen: a thrown/rejected IPC during startup
 * (before any specific screen could render) lands here instead of a
 * blank window. Reuses #pantalla-error with a plain Spanish message and
 * a single Reintentar that re-runs bootstrap from scratch.
 */
function showBootErrorScreen(err) {
  hide('pantalla-app');
  hide('pantalla-bienvenida');
  hide('setup-wizard');
  show('pantalla-error');

  el('error-titulo').textContent = 'No se pudo iniciar Quanto';
  el('error-detalle').textContent =
    (err && (err.message || String(err))) || 'Error desconocido al arrancar.';
  el('error-hint').textContent =
    'Hubo un problema al arrancar. Comprueba tu conexión y la configuración, y vuelve a intentarlo.';
  el('error-hint').classList.remove('hidden');

  // Only Reintentar applies here — the file/cloud-specific actions need
  // a known data source, which we may not have yet.
  el('btn-error-crear-default').classList.add('hidden');
  el('btn-error-cambiar-ruta').classList.add('hidden');
  el('btn-error-modo-local').classList.add('hidden');

  el('btn-error-reintentar').onclick = () => { bootstrap(); };
}

// ============================================================
// v5 first-run wizard (UI-UX §2.0): Local vs Nube
// ============================================================
// Shown when no data source is configured. The Local branch reuses
// the existing file-path picker; the Nube branch walks 3 guided steps
// (account → token → provision). All network/navigation happens in
// main — the renderer only calls window.packprice.* (CSP intact).

let wizardEventsBound = false;

// The Cloudflare token-creation page, pre-filled via query template so
// the user only has to click "Create token". Plain https URL opened in
// the system browser by main (shell.openExternal), never here.
const CLOUDFLARE_SIGNUP_URL = 'https://dash.cloudflare.com/sign-up';
const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';

function showSetupWizard() {
  hide('pantalla-app');
  hide('pantalla-bienvenida');
  hide('pantalla-error');
  show('setup-wizard');
  showWizardView('wizard-choice');
  bindWizardEvents();
}

/** Toggles the wizard sub-views (choice / local / cloud). */
function showWizardView(id) {
  ['wizard-choice', 'wizard-local', 'wizard-cloud'].forEach(v => {
    el(v).classList.toggle('hidden', v !== id);
  });
}

function bindWizardEvents() {
  if (wizardEventsBound) return;
  wizardEventsBound = true;

  // --- Choice ---
  el('wizard-pick-local').addEventListener('click', openWizardLocal);
  el('wizard-pick-cloud').addEventListener('click', openWizardCloud);

  // --- Local branch ---
  el('btn-wizard-local-back').addEventListener('click', () => showWizardView('wizard-choice'));
  el('btn-wiz-explorar').addEventListener('click', async () => {
    // Local mode picks a FOLDER; config.js inside it is reused or created.
    const r = await window.packprice.selectConfigFolder();
    if (!r.cancelado) {
      el('wiz-ruta').value = r.carpeta;
      validateWizardLocalForm();
    }
  });
  el('wiz-nombre').addEventListener('input', validateWizardLocalForm);
  el('wiz-ruta').addEventListener('input', validateWizardLocalForm);
  el('btn-wiz-local-empezar').addEventListener('click', startWizardLocal);

  // --- Cloud branch ---
  el('btn-wizard-cloud-back').addEventListener('click', () => showWizardView('wizard-choice'));
  el('btn-cloud-signup').addEventListener('click', () => openExternalSafe(CLOUDFLARE_SIGNUP_URL));
  el('btn-cloud-step1-next').addEventListener('click', cloudStep1Next);
  el('btn-cloud-open-token').addEventListener('click', () => openExternalSafe(CLOUDFLARE_TOKEN_URL));
  el('cloud-token').addEventListener('input', () => {
    el('btn-cloud-step2-next').disabled = el('cloud-token').value.trim().length === 0;
  });
  el('btn-cloud-step2-back').addEventListener('click', () => showCloudStep(1));
  el('btn-cloud-step2-next').addEventListener('click', cloudStep2TestToken);
  el('btn-cloud-step3-back').addEventListener('click', () => showCloudStep(2));
  el('btn-cloud-provision').addEventListener('click', cloudProvision);
  // In-place recovery after a provision failure (single OR multi
  // account): Reintentar re-runs provision; Atrás returns to the token
  // step with the token preserved (UI-UX §2.0 — never a dead-end).
  el('btn-cloud-step3-retry').addEventListener('click', () => cloudProvision());
  el('btn-cloud-step3-back-fail').addEventListener('click', () => {
    hide('cloud-step3-fail-actions');
    hide('cloud-step3-error');
    showCloudStep(2);
  });
}

// --- Local branch -------------------------------------------------

function openWizardLocal() {
  showWizardView('wizard-local');
  hide('wiz-local-error');
  validateWizardLocalForm();
  // No default path: the user picks (or types) the folder where the data
  // lives. config.js inside it is reused if present, created if not.
  setTimeout(() => el('wiz-nombre').focus(), 50);
}

function validateWizardLocalForm() {
  const name = el('wiz-nombre').value.trim();
  const filePath = el('wiz-ruta').value.trim();
  el('btn-wiz-local-empezar').disabled = !(name && filePath);
}

async function startWizardLocal() {
  const name = el('wiz-nombre').value.trim();
  const folder = el('wiz-ruta').value.trim();
  hide('wiz-local-error');

  const btn = el('btn-wiz-local-empezar');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Comprobando ruta…';
  try {
    // The field holds a folder; resolve it to <folder>/config.js in main
    // (the renderer has no path module). The file is reused if present;
    // an empty folder triggers the first-run catalog wizard (below).
    const resolved = await window.packprice.folderConfigPath(folder);
    if (!resolved || !resolved.ruta) {
      el('wiz-local-error').textContent = 'No se pudo resolver la carpeta seleccionada.';
      show('wiz-local-error');
      return;
    }
    const filePath = resolved.ruta;

    const res = await ensureConfigFileReady(name, filePath, (msg) => {
      el('wiz-local-error').textContent = msg;
      show('wiz-local-error');
    });
    if (!res.ready && !res.needsWizard) return;

    // Persist file mode explicitly (data_source: 'file') so a later
    // boot never re-shows the wizard.
    SETTINGS = { config_path: filePath, user_name: name, data_source: 'file' };
    const saved = await window.packprice.writeSettings(SETTINGS);
    if (!saved.ok) {
      el('wiz-local-error').textContent = `No se pudo guardar la configuración local: ${saved.error}`;
      show('wiz-local-error');
      return;
    }

    if (res.needsWizard) {
      // Empty folder: build the catalog from blank, then create config.js.
      await startCatalogWizard({
        mode: 'file',
        userName: name,
        done: async (builtCfg) => {
          const created = await window.packprice.createConfig({
            ruta: filePath, config: builtCfg, modificadoPor: name
          });
          if (!created.ok) throw new Error(created.error || 'No se pudo crear el archivo.');
          hide('catalog-wizard');
          await loadConfigAndShowApp();
        }
      });
      return;
    }

    hide('setup-wizard');
    await loadConfigAndShowApp();
  } finally {
    btn.innerHTML = original;
    validateWizardLocalForm();
  }
}

/**
 * Shared file-mode setup helper: a MISSING-but-writable path signals the
 * first-run catalog wizard (the caller launches it and persists the built
 * config); an existing path is checked readable. Plain errors via `onError`.
 * @returns { ready, needsWizard? } — ready:false + needsWizard:true means
 *          "run the wizard"; ready:false alone means a reported failure.
 */
async function ensureConfigFileReady(name, filePath, onError) {
  const exist = await window.packprice.configExists(filePath);
  if (!exist.existe) {
    if (!exist.escribible) {
      onError('No se puede crear el archivo en esa ruta. Comprueba que el NAS está accesible y tienes permisos de escritura.');
      return { ready: false };
    }
    return { ready: false, needsWizard: true };
  }
  const r = await window.packprice.readConfig(filePath);
  if (!r.ok) {
    onError(`No se pudo leer el archivo: ${r.error}`);
    return { ready: false };
  }
  return { ready: true };
}

// --- Cloud branch -------------------------------------------------

function openWizardCloud() {
  wizardCloud = { token: '', accounts: [], userName: '', lastAccountId: undefined };
  showWizardView('wizard-cloud');
  showCloudStep(1);
  // Prefill the author name from settings if we already have one.
  const nameInput = el('cloud-nombre');
  if (nameInput && SETTINGS && SETTINGS.user_name) nameInput.value = SETTINGS.user_name;
  setTimeout(() => nameInput && nameInput.focus(), 50);
}

/** Switches the visible cloud step and updates the progress dots. */
function showCloudStep(n) {
  [1, 2, 3].forEach(i => {
    el(`cloud-step-${i}`).classList.toggle('hidden', i !== n);
  });
  document.querySelectorAll('#wizard-steps .wizard-steps__dot').forEach(dot => {
    const step = Number(dot.dataset.step);
    dot.classList.toggle('is-current', step === n);
    dot.classList.toggle('is-done', step < n);
  });
}

function cloudStep1Next() {
  wizardCloud.userName = el('cloud-nombre').value.trim();
  showCloudStep(2);
  el('btn-cloud-step2-next').disabled = el('cloud-token').value.trim().length === 0;
  setTimeout(() => el('cloud-token').focus(), 50);
}

async function cloudStep2TestToken() {
  const token = el('cloud-token').value.trim();
  hide('cloud-token-error');
  if (!token) return;

  const btn = el('btn-cloud-step2-next');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Comprobando…';
  try {
    const r = await window.packprice.testCloudToken({ token });
    if (!r || !r.ok) {
      // Plain language, never an HTTP code (UI-UX §2.0).
      el('cloud-token-error').textContent = 'Esa clave no funciona — vuelve a copiarla y pégala de nuevo.';
      show('cloud-token-error');
      return;
    }
    wizardCloud.token = token;
    wizardCloud.accounts = r.accounts || [];
    showCloudStep(3);
    prepareCloudStep3();
  } finally {
    btn.innerHTML = original;
    btn.disabled = el('cloud-token').value.trim().length === 0;
  }
}

/**
 * Step 3 entry: if the token grants access to several accounts, show
 * a picker; otherwise provision straight away with the only account.
 */
function prepareCloudStep3() {
  hide('cloud-step3-error');
  hide('cloud-step3-fail-actions');
  const accounts = wizardCloud.accounts;
  const pick = el('cloud-account-pick');
  const progress = el('cloud-progress');

  if (accounts.length > 1) {
    const select = el('cloud-account');
    select.innerHTML = accounts
      .map(a => `<option value="${escAttr(a.id)}">${escapeHTML(a.name)}</option>`)
      .join('');
    enhanceDropdowns(pick);
    pick.classList.remove('hidden');
    progress.classList.add('hidden');
    return;
  }

  // 0 or 1 accounts: no choice to make, provision directly. (0 is
  // unusual — testToken succeeded — but provision will surface a clear
  // error if the account is unusable.)
  pick.classList.add('hidden');
  const accountId = accounts[0] ? accounts[0].id : undefined;
  cloudProvision(accountId);
}

/**
 * Resolves the account to provision: an explicit string arg (single
 * account auto-provision) wins; otherwise the picker selection; then
 * the last account we tried (Reintentar); finally the first account.
 */
function resolveProvisionAccountId(accountIdArg) {
  if (typeof accountIdArg === 'string') return accountIdArg;
  const picker = el('cloud-account');
  const fromPicker = picker && !el('cloud-account-pick').classList.contains('hidden')
    ? picker.value
    : '';
  return fromPicker
    || wizardCloud.lastAccountId
    || (wizardCloud.accounts[0] && wizardCloud.accounts[0].id);
}

async function cloudProvision(accountIdArg) {
  // Guard re-entry: a second click (provision button, retry button, or
  // a programmatic call) while one is running is ignored (minor fix).
  if (provisionInFlight) return;

  hide('cloud-step3-error');
  hide('cloud-step3-fail-actions');
  el('cloud-account-pick').classList.add('hidden');
  const progress = el('cloud-progress');
  const msg = el('cloud-progress-msg');
  progress.classList.remove('hidden');
  msg.textContent = 'Buscando tu base de datos…';

  const accountId = resolveProvisionAccountId(accountIdArg);
  wizardCloud.lastAccountId = accountId;

  // Disable the provision button while in flight (mirrors the step-2
  // test-token button), so a double-click can't fire twice.
  provisionInFlight = true;
  const provisionBtn = el('btn-cloud-provision');
  if (provisionBtn) provisionBtn.disabled = true;

  // Persist the author name first so provision (which reads settings
  // for the audit author) has it.
  if (wizardCloud.userName) {
    await window.packprice.writeSettings({ user_name: wizardCloud.userName });
    SETTINGS = { ...(SETTINGS || {}), user_name: wizardCloud.userName };
  }

  // A gentle "creating…" message after a beat — provision finds or
  // creates the base; we cannot observe which from here, so we phrase
  // it as ongoing work (UI-UX §2.0).
  const creatingTimer = setTimeout(() => {
    msg.textContent = 'Preparando tu base de datos…';
  }, 1500);

  let r;
  try {
    r = await window.packprice.provisionCloud({ token: wizardCloud.token, accountId });
  } catch (err) {
    // A rejected IPC is just another failure: surface it, don't strand.
    r = { ok: false };
  } finally {
    clearTimeout(creatingTimer);
    provisionInFlight = false;
    if (provisionBtn) provisionBtn.disabled = false;
  }

  if (!r || !r.ok) {
    progress.classList.add('hidden');
    el('cloud-step3-error').textContent = cloudProvisionError(r);
    show('cloud-step3-error');
    // Never a dead-end: always offer Reintentar + Atrás in place,
    // whether the token reached 1 or many accounts. For a multi-account
    // token also re-show the picker so the user can switch account
    // before retrying.
    show('cloud-step3-fail-actions');
    if (wizardCloud.accounts.length > 1) {
      el('cloud-account-pick').classList.remove('hidden');
    }
    return;
  }

  msg.textContent = 'Base lista — configura tu catálogo…';

  // main has already persisted data_source: 'cloud' + the connection.
  // Re-read settings so SETTINGS reflects cloud mode. provisionInFlight was
  // cleared in the finally above, so the wizard's UI is not stranded.
  SETTINGS = await window.packprice.readSettings();

  // Provision only created an EMPTY, migrated DB. Build the catalog from
  // blank in the wizard, then seed it into the cloud before booting.
  await startCatalogWizard({
    mode: 'cloud',
    userName: (wizardCloud && wizardCloud.userName) || (SETTINGS && SETTINGS.user_name) || '',
    done: async (builtCfg) => {
      const seeded = await window.packprice.seedInitialCatalog({ config: builtCfg });
      if (!seeded.ok) throw new Error(seeded.error || 'No se pudo crear el catálogo en la nube.');
      hide('catalog-wizard');
      await loadCloudAndShowApp();
    }
  });
}

/** Plain-language message for a failed provision (never an HTTP code). */
function cloudProvisionError(r) {
  if (!r) return 'No se pudo conectar con la nube. Revisa tu conexión y vuelve a intentarlo.';
  if (r.code === 'MIGRATION_LOCKED') {
    return 'Otro equipo está preparando la base de datos ahora mismo. Espera un minuto y reinténtalo.';
  }
  if (r.code === 'MIGRATION_FAILED') {
    return 'No se pudo actualizar la base de datos. No se ha cambiado nada; vuelve a intentarlo más tarde.';
  }
  return 'No se pudo conectar con la nube. Revisa tu conexión y vuelve a intentarlo.';
}

/** Opens an external https URL via main; reports a plain error if it fails. */
async function openExternalSafe(url) {
  const r = await window.packprice.openExternal(url);
  if (r && !r.ok) {
    await window.packprice.showError({
      titulo: 'No se pudo abrir el navegador',
      mensaje: 'Abre esta dirección manualmente en tu navegador:',
      detalle: url
    });
  }
}

async function loadConfigAndShowApp() {
  const r = await window.packprice.readConfig(SETTINGS.config_path);
  if (!r.ok) {
    await showErrorScreen(r.error);
    return;
  }

  CFG = r.config;
  ensureDefaultPacks(CFG);
  // File mode: the indicator reads "Modo local"; no offline banner.
  DATA_STATE = { source: 'file' };
  hide('pantalla-bienvenida');
  hide('setup-wizard');
  hide('pantalla-error');
  show('pantalla-app');
  initApp();
}

// ============================================================
// v5 cloud: boot from D1 (with cache fallback), drive the screens
// off the loadCatalog envelope shape returned by main:
//   { ok, config, source, catalogVersion, fetchedAt, offline,
//     reason, code, cloudError }
// ============================================================
async function loadCloudAndShowApp() {
  const r = await window.packprice.loadCatalog();

  if (!r || !r.ok) {
    // The only non-ok cloud boot is NO_CLOUD_NO_CACHE (no network and
    // this PC has never cached the catalog) — UI-UX §2.4.
    await showCloudErrorScreen(r);
    return;
  }

  CFG = r.config;
  ensureDefaultPacks(CFG);
  // Keep the relevant envelope fields for the indicator + banner, plus
  // the per-entity `versions` map (v5 writes): the editor sends it back
  // on save as the optimistic-concurrency baseline (catalog:save).
  DATA_STATE = {
    source: r.source,
    catalogVersion: r.catalogVersion,
    fetchedAt: r.fetchedAt,
    offline: r.offline,
    reason: r.reason,
    versions: r.versions
  };
  hide('pantalla-bienvenida');
  hide('setup-wizard');
  hide('pantalla-error');
  show('pantalla-app');
  initApp();
}

/**
 * Defensive guard for the in-memory config. In v4 the schema is
 * migrated to its current shape in main (on read), so the renderer
 * should already receive a complete config. We only make sure the
 * top-level collections the renderer iterates over exist, to avoid
 * crashing on a partial/legacy file that slipped through.
 */
function ensureDefaultPacks(cfg) {
  if (!cfg.packs) cfg.packs = {};
  if (!cfg.products) cfg.products = {};
  if (!cfg.addons) cfg.addons = {};
  if (!cfg.parameters) cfg.parameters = {};
  if (!Array.isArray(cfg.tiers)) cfg.tiers = [];
}

async function showErrorScreen(detail) {
  hide('pantalla-app');
  hide('pantalla-bienvenida');
  hide('setup-wizard');
  show('pantalla-error');

  // Reset to the file-mode copy (it may have been switched to the cloud
  // variant on a previous boot) and hide the cloud-only action.
  el('error-titulo').textContent = 'No se pudo cargar la configuración';
  el('error-hint').textContent = 'Comprueba que el NAS está accesible y la ruta del config es correcta.';
  el('error-hint').classList.remove('hidden');
  el('btn-error-cambiar-ruta').classList.remove('hidden');
  el('btn-error-modo-local').classList.add('hidden');
  el('error-detalle').textContent = detail;

  const exist = await window.packprice.configExists(SETTINGS.config_path);
  const btnCreate = el('btn-error-crear-default');
  if (btnCreate) {
    if (!exist.existe && exist.escribible) {
      btnCreate.classList.remove('hidden');
    } else {
      btnCreate.classList.add('hidden');
    }
    // No default catalog any more: this recovery path launches the same
    // first-run wizard, then writes the catalog the user builds from blank.
    btnCreate.textContent = 'Configurar catálogo';
    btnCreate.onclick = async () => {
      await startCatalogWizard({
        mode: 'file',
        userName: SETTINGS.user_name,
        done: async (builtCfg) => {
          const created = await window.packprice.createConfig({
            ruta: SETTINGS.config_path,
            config: builtCfg,
            modificadoPor: SETTINGS.user_name
          });
          if (!created.ok) throw new Error(created.error || 'No se pudo crear el archivo.');
          hide('catalog-wizard');
          await loadConfigAndShowApp();
        }
      });
    };
  }

  el('btn-error-reintentar').onclick = async () => {
    await loadConfigAndShowApp();
  };
  el('btn-error-cambiar-ruta').onclick = async () => {
    // Local mode picks a FOLDER; resolve config.js inside it (main).
    const r = await window.packprice.selectConfigFolder();
    if (r.cancelado) return;
    const resolved = await window.packprice.folderConfigPath(r.carpeta);
    if (!resolved || !resolved.ruta) return;
    SETTINGS.config_path = resolved.ruta;
    await window.packprice.writeSettings(SETTINGS);
    await loadConfigAndShowApp();
  };
}

/**
 * v5 cloud boot error (UI-UX §2.4): no network and no cached catalog
 * (code NO_CLOUD_NO_CACHE). Two exits — retry the cloud read, or fall
 * back to local file mode by re-running the wizard's local branch.
 */
async function showCloudErrorScreen(result) {
  hide('pantalla-app');
  hide('pantalla-bienvenida');
  hide('setup-wizard');
  show('pantalla-error');

  el('error-titulo').textContent = 'No se pudo cargar el catálogo';
  el('error-detalle').textContent =
    'No hay conexión y este equipo aún no tiene datos guardados.';
  // The generic NAS hint does not apply here; hide it.
  el('error-hint').classList.add('hidden');

  // File-mode actions don't apply in cloud mode: only Reintentar +
  // "Usar modo local…".
  el('btn-error-crear-default').classList.add('hidden');
  el('btn-error-cambiar-ruta').classList.add('hidden');
  el('btn-error-modo-local').classList.remove('hidden');

  el('btn-error-reintentar').onclick = async () => {
    await loadCloudAndShowApp();
  };
  el('btn-error-modo-local').onclick = () => {
    // Reuse the wizard's local branch: pick a config file and switch
    // this PC to file mode. The wizard persists data_source: 'file'.
    showSetupWizard();
    openWizardLocal();
  };
}

// ============================================================
// Main app initialization
// ============================================================

function initApp() {
  el('info-usuario').textContent = (SETTINGS && SETTINGS.user_name) || '—';
  el('info-fecha-cfg').textContent = shortConfigDate(CFG.updated_at);
  el('cfg-version').textContent = CFG.version || '?';

  // Replace spans with config values
  document.querySelectorAll('[data-cfg]').forEach(span => {
    const key = span.dataset.cfg;
    if (CFG.parameters && CFG.parameters[key] !== undefined) {
      span.textContent = CFG.parameters[key];
    }
  });

  // v5: topbar indicator + offline banner reflect where the data came
  // from (file / live cloud / cache).
  refreshDataStatusUi();

  renderPackList();

  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }

  // v5: nudge about quotes waiting for an answer / about to expire. Run
  // once per boot (not on every cfg live-reload) so a refresh doesn't
  // re-pop a dismissed banner.
  if (!reminderChecked) {
    reminderChecked = true;
    maybeShowReminder();
  }

  // Plan 7B: app-version update check on boot (PRD R15). Once per boot,
  // only when the toggle is on, non-blocking, errors swallowed silently
  // (only the manual «Buscar ahora» surfaces errors).
  if (!updateChecked) {
    updateChecked = true;
    if (window.packprice && typeof window.packprice.onUpdateState === 'function') {
      window.packprice.onUpdateState(applyUpdateState);
    }
    maybeCheckForUpdate();
  }
}

// ============================================================
// v5 cloud: data-status indicator, refresh, offline banner
// ============================================================

const DATA_STATUS_TONE_CLASS = {
  connected: 'data-status--connected',
  offline: 'data-status--offline',
  local: 'data-status--local'
};

/**
 * Paints the topbar indicator and the offline banner from DATA_STATE.
 * Pure decision lives in data-status.js; this is the DOM glue.
 */
function refreshDataStatusUi() {
  const status = deriveDataStatus(DATA_STATE);
  const isCloud = SETTINGS && SETTINGS.data_source === 'cloud';

  const badge = el('data-status');
  const label = el('data-status-label');
  const refreshBtn = el('refresh-catalog');
  const legacyReload = el('btn-recargar');

  if (badge && label) {
    label.textContent = status.label;
    // Swap the badge tone class (reset known modifiers first).
    badge.classList.remove(...Object.values(DATA_STATUS_TONE_CLASS), 'badge--neutral');
    badge.classList.add(DATA_STATUS_TONE_CLASS[status.kind] || 'badge--neutral');
    // Swap the icon (text + icon, not colour alone — §2.8).
    const use = badge.querySelector('use');
    if (use) use.setAttribute('href', `#${status.icon}`);
    // The indicator is meaningful in cloud mode; in file mode the
    // legacy chips already say everything, so keep it hidden.
    badge.classList.toggle('hidden', !isCloud);
  }

  // Cloud reload uses the dedicated "Actualizar" button; file mode
  // keeps the legacy "Recargar". Only one is visible at a time.
  if (refreshBtn) refreshBtn.classList.toggle('hidden', !isCloud);
  if (legacyReload) legacyReload.classList.toggle('hidden', isCloud);

  refreshOfflineBanner();
}

/** Is the app currently serving cached (offline) data? */
function isOffline() {
  return DATA_STATE.source === 'cache';
}

/**
 * v5: are we in cloud storage mode? The catalog editor drops the
 * password gate and uses save-confirmation + per-entity conflict UX
 * (UI-UX §2.3/§2.5); file mode keeps its existing password gate.
 */
function isCloudMode() {
  return !!(SETTINGS && SETTINGS.data_source === 'cloud');
}

/** Author recorded on cloud writes (UI-UX §2.5 «Editando como …»). */
function cloudAuthorName() {
  const s = SETTINGS || {};
  return (s.cloud && s.cloud.user_name) || s.user_name || 'Equipo';
}

/**
 * Shows/hides the read-only offline banner (§2.2) and disables the
 * catalog editor (admin) while offline, with a plain-language tooltip.
 */
function refreshOfflineBanner() {
  const banner = el('offline-banner');
  const offline = isOffline();
  if (banner) {
    banner.classList.toggle('hidden', !offline);
    if (offline) {
      const dateEl = el('offline-banner-date');
      if (dateEl) dateEl.textContent = formatFreshness(DATA_STATE.fetchedAt);
    }
  }

  // Editing the catalog needs a live connection: disable the admin
  // entry while offline (UI-UX §2.2) with a tooltip explaining why.
  const adminBtn = el('btn-admin-toggle');
  if (adminBtn) {
    adminBtn.disabled = offline;
    adminBtn.title = offline ? 'No disponible sin conexión' : '';
  }
}

/**
 * Handler for the topbar "Actualizar" AND the offline banner
 * "Reintentar": check the remote version, and only pull when it
 * actually changed. A discreet toast confirms "Ya estás al día"; a
 * successful pull live-reloads cfg.
 *
 * Both triggers share one in-flight flag (planRefreshTrigger): a second
 * click while a refresh runs is ignored, and the busy feedback lands on
 * whichever button is actually visible (banner when offline, else the
 * topbar button). The flag clears in `finally` on success or failure.
 */
async function refreshCatalog() {
  const plan = planRefreshTrigger({ inFlight: refreshInFlight, offline: isOffline() });
  if (!plan.proceed) return;

  refreshInFlight = true;
  const busy = setRefreshBusy(true, plan.target);
  try {
    // Cheap probe first: GET version. If unchanged, no full download.
    const ver = await window.packprice.checkCatalogVersion();
    if (ver && ver.ok && ver.upToDate) {
      showToast('Ya estás al día');
      return;
    }

    const r = await window.packprice.refreshCatalog();
    if (!r || !r.ok) {
      // Refresh fails loudly (no silent cache fallback). Stay on the
      // current (possibly cached) data and tell the user plainly.
      await window.packprice.showError({
        titulo: 'No se pudo actualizar',
        mensaje: r && r.reason === 'cloud-invalid'
          ? 'La nube respondió pero el catálogo no es válido. Se mantienen los datos actuales.'
          : 'No hay conexión con la nube. Se mantienen los datos actuales.'
      });
      return;
    }

    // Live reload: swap cfg in place and re-render without losing the
    // current screen state more than necessary.
    CFG = r.config;
    ensureDefaultPacks(CFG);
    DATA_STATE = {
      source: r.source,
      catalogVersion: r.catalogVersion,
      fetchedAt: r.fetchedAt,
      offline: r.offline,
      reason: r.reason,
      versions: r.versions
    };
    initApp();
    if (state.packId && CFG.packs[state.packId]) {
      // Keep the user on their pack but refresh the inputs/preview.
      selectPack(state.packId);
    }
    showToast('Datos actualizados');
  } finally {
    refreshInFlight = false;
    // initApp() (on success) may have re-rendered the topbar/banner, so
    // restore busy state on the same element we marked. The banner could
    // have been hidden by a successful refresh — that's fine, restoring
    // a hidden button is harmless.
    setRefreshBusy(false, plan.target, busy);
  }
}

/**
 * Toggles busy feedback on the visible refresh trigger.
 *   - 'topbar' → #refresh-catalog (+ its label span).
 *   - 'banner' → #btn-offline-retry.
 * Returns a small snapshot ({ target, label }) used to restore the
 * original label when clearing busy. Pure DOM glue (no logic decision —
 * that lives in planRefreshTrigger).
 */
function setRefreshBusy(busy, target, restore) {
  if (target === 'banner') {
    const btn = el('btn-offline-retry');
    if (!btn) return null;
    const snapshot = { target, label: restore ? restore.label : btn.innerHTML };
    btn.disabled = busy;
    if (busy) {
      btn.innerHTML = '<span class="spinner"></span> Actualizando…';
    } else if (restore) {
      btn.innerHTML = restore.label;
    }
    return snapshot;
  }

  // topbar (default)
  const btn = el('refresh-catalog');
  const label = el('refresh-catalog-label');
  if (!btn) return null;
  const snapshot = { target, label: restore ? restore.label : (label ? label.textContent : '') };
  btn.disabled = busy;
  if (busy) {
    if (label) label.textContent = 'Actualizando…';
  } else if (label && restore) {
    label.textContent = restore.label;
  }
  return snapshot;
}

/** Discreet, auto-dismissing toast (UI-UX §2.1: never blocks). */
let toastTimer = null;
function showToast(message) {
  let toast = el('pp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'pp-toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = '<svg class="icon"><use href="#i-check"/></svg><span></span>';
    document.body.appendChild(toast);
  }
  // A plain toast has no action button: ensure any prior action is gone.
  toast.querySelector('span').textContent = message;
  const oldBtn = toast.querySelector('.toast__action');
  if (oldBtn) oldBtn.remove();
  toast.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2500);
}

/**
 * Toast with an undo action (UI-UX §2.7: status change is undoable via
 * toast). Reuses the #pp-toast element, appending a "Deshacer" button
 * that runs `onUndo` and hides the toast. Auto-dismisses after a beat.
 */
function showStatusToast(message, onUndo) {
  let toast = el('pp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'pp-toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = '<svg class="icon"><use href="#i-check"/></svg><span></span>';
    document.body.appendChild(toast);
  }
  toast.querySelector('span').textContent = message;
  let action = toast.querySelector('.toast__action');
  if (!action) {
    action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast__action';
    toast.appendChild(action);
  }
  action.textContent = 'Deshacer';
  action.onclick = async () => {
    toast.classList.remove('is-visible');
    if (typeof onUndo === 'function') await onUndo();
  };
  toast.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  // A little longer than a plain toast so there is time to undo.
  toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
    if (action) action.remove();
  }, 5000);
}

function shortConfigDate(date) {
  if (!date) return 'sin fecha';
  // "28/4/2026, 15:32:10" → "28/4 · 15:32"
  const [datePart, timePart = ''] = date.split(',');
  const shortTime = timePart.trim().split(':').slice(0, 2).join(':');
  const shortDate = datePart.split('/').slice(0, 2).join('/');
  return shortTime ? `${shortDate} · ${shortTime}` : shortDate;
}

function bindEvents() {
  el('btn-calcular').addEventListener('click', runCalculation);
  el('btn-reset').addEventListener('click', resetForm);
  el('btn-cambiar-pack').addEventListener('click', backToSelection);
  const btnChangePack2 = el('btn-cambiar-pack-2');
  if (btnChangePack2) btnChangePack2.addEventListener('click', backToSelection);
  const btnEdit = el('btn-editar-pedido');
  if (btnEdit) btnEdit.addEventListener('click', backToEdit);

  el('btn-recargar').addEventListener('click', reloadConfig);
  el('btn-ajustes').addEventListener('click', openSettings);

  // v5 cloud: refresh button + offline banner retry share the same flow.
  const btnRefresh = el('refresh-catalog');
  if (btnRefresh) btnRefresh.addEventListener('click', refreshCatalog);
  const btnOfflineRetry = el('btn-offline-retry');
  if (btnOfflineRetry) btnOfflineRetry.addEventListener('click', refreshCatalog);

  el('btn-admin-toggle').addEventListener('click', openAdmin);
  el('btn-cerrar-admin').addEventListener('click', closeAdmin);
  el('btn-guardar-config').addEventListener('click', saveConfigToNas);
  el('btn-cancelar-admin').addEventListener('click', cancelAdminChanges);

  // Logs viewer (admin footer)
  const btnViewLogs = el('btn-ver-logs');
  if (btnViewLogs) btnViewLogs.addEventListener('click', openLogs);
  const btnLogsClose = el('btn-logs-cerrar');
  if (btnLogsClose) btnLogsClose.addEventListener('click', closeLogs);
  const btnLogsClose2 = el('btn-cerrar-logs');
  if (btnLogsClose2) btnLogsClose2.addEventListener('click', closeLogs);
  const logsOverlay = el('logs-overlay');
  if (logsOverlay) {
    logsOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'logs-overlay') closeLogs();
    });
  }

  // History
  const btnHistory = el('btn-historial');
  if (btnHistory) btnHistory.addEventListener('click', openHistory);
  const btnHistoryClose = el('btn-history-cerrar');
  if (btnHistoryClose) btnHistoryClose.addEventListener('click', closeHistory);
  const btnHistoryClose2 = el('btn-cerrar-history');
  if (btnHistoryClose2) btnHistoryClose2.addEventListener('click', closeHistory);
  const historyOverlay = el('history-overlay');
  if (historyOverlay) {
    historyOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'history-overlay') closeHistory();
    });
  }
  const searchInput = el('history-search');
  if (searchInput) {
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refreshHistory, 150);
    });
  }
  const btnSaveQuote = el('btn-guardar-presupuesto');
  if (btnSaveQuote) btnSaveQuote.addEventListener('click', saveCurrentQuote);
  const btnExportPdf = el('btn-exportar-pdf');
  if (btnExportPdf) btnExportPdf.addEventListener('click', exportQuotePdf);

  // Client fields: clear the inline error as soon as the user types
  // (validation is on save/export, but the error must not linger).
  const clienteNombre = el('cliente-nombre');
  if (clienteNombre) clienteNombre.addEventListener('input', () => clearFieldError('cliente-nombre'));
  const clienteTel = el('cliente-telefono');
  if (clienteTel) clienteTel.addEventListener('input', () => clearFieldError('cliente-telefono'));

  // v5: Estadísticas screen + startup reminder banner.
  const btnStats = el('btn-estadisticas');
  if (btnStats) btnStats.addEventListener('click', openStats);
  const btnStatsBack = el('btn-stats-volver');
  if (btnStatsBack) btnStatsBack.addEventListener('click', closeStats);
  const statsPeriod = el('stats-period');
  if (statsPeriod) {
    statsPeriod.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-period]');
      if (btn) onStatsPeriod(btn.dataset.period);
    });
  }
  const btnStatsApply = el('btn-stats-apply');
  if (btnStatsApply) btnStatsApply.addEventListener('click', () => loadStats());

  const btnReminderReview = el('btn-reminder-review');
  if (btnReminderReview) btnReminderReview.addEventListener('click', () => {
    dismissReminder();
    openHistory();
  });
  const btnReminderDismiss = el('btn-reminder-dismiss');
  if (btnReminderDismiss) btnReminderDismiss.addEventListener('click', dismissReminder);

  // Plan 7B: dismiss the «versión nueva» notice (download is wired
  // per-show in maybeCheckForUpdate so it carries the release URL).
  const btnUpdateDismiss = el('btn-update-dismiss');
  if (btnUpdateDismiss) btnUpdateDismiss.addEventListener('click', () => hide('update-banner'));

  document.querySelectorAll('.admin-nav__item, .admin-tab').forEach(tab => {
    tab.addEventListener('click', () => showAdminTab(tab.dataset.tab));
  });

  el('admin-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'admin-overlay') closeAdmin();
  });

  // Settings modal
  el('btn-cerrar-ajustes').addEventListener('click', closeSettings);
  el('btn-aj-cancelar').addEventListener('click', closeSettings);
  el('btn-aj-guardar').addEventListener('click', saveSettings);
  el('btn-aj-explorar').addEventListener('click', async () => {
    // Local mode picks a FOLDER; config.js inside it is reused or created.
    const r = await window.packprice.selectConfigFolder();
    if (!r.cancelado) {
      el('aj-ruta').value = r.carpeta;
    }
  });
  el('ajustes-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'ajustes-overlay') closeSettings();
  });

  // Settings · Updates + Privacy (Plan 7B). Both toggles persist
  // immediately on change (per-PC prefs, like the PDF template choice),
  // so «Cancelar» never loses them; the buttons run their IPC actions.
  const checkUpdates = el('aj-check-updates');
  if (checkUpdates) checkUpdates.addEventListener('change', onCheckUpdatesToggle);
  const errorReports = el('aj-error-reports');
  if (errorReports) errorReports.addEventListener('change', onErrorReportsToggle);
  const btnBuscarUpdate = el('btn-aj-buscar-update');
  if (btnBuscarUpdate) btnBuscarUpdate.addEventListener('click', checkForUpdateNow);
  const btnUpdateRestart = el('btn-update-restart');
  if (btnUpdateRestart) {
    btnUpdateRestart.addEventListener('click', () => {
      btnUpdateRestart.disabled = true;
      window.packprice.installUpdateNow();
    });
  }
  const btnDiagnostico = el('btn-aj-diagnostico');
  if (btnDiagnostico) btnDiagnostico.addEventListener('click', exportDiagnostics);

  // Settings · PDF template gallery (Plan 6). Gallery card clicks are
  // bound per-render in renderPdfTemplateGallery; these are the stable
  // controls.
  const brandColor = el('aj-brand-color');
  if (brandColor) brandColor.addEventListener('change', onBrandColorChange);
  const btnTplAdd = el('btn-aj-tpl-add');
  if (btnTplAdd) btnTplAdd.addEventListener('click', openPdfTemplateAddForm);
  const btnTplAddCancel = el('btn-aj-tpl-add-cancel');
  if (btnTplAddCancel) btnTplAddCancel.addEventListener('click', closePdfTemplateAddForm);
  const btnTplAddSave = el('btn-aj-tpl-add-save');
  if (btnTplAddSave) btnTplAddSave.addEventListener('click', savePdfTemplate);

  // Result actions: copies a summary to the clipboard.
  const btnCopy = el('btn-copiar-resumen');
  if (btnCopy) btnCopy.addEventListener('click', copySummary);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAdmin();
      closeSettings();
      return;
    }

    if (e.key === 'Enter') {
      const step2 = el('seccion-paso2');
      if (step2.classList.contains('hidden')) return;
      if (!el('admin-overlay').classList.contains('hidden')) return;
      if (!el('ajustes-overlay').classList.contains('hidden')) return;
      if (!(e.target instanceof HTMLElement) || !step2.contains(e.target)) return;

      e.preventDefault();
      runCalculation();
    }
  });

  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'number') {
      e.target.select();
    }
  });

  document.addEventListener('wheel', (e) => {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement && a.type === 'number' && a === e.target) {
      a.blur();
    }
  }, { passive: true });

  bindSecretCostShortcut();
}

/**
 * Secret shortcut: 3 presses of "." (numpad or not) within 800 ms
 * toggle the display of costs and margins in the result. Useful to
 * hide internal data when the customer is looking at the screen.
 *
 * Ignored when the focus is in an input/textarea/select so it does
 * not break entering decimals (numpad "." or decimal comma).
 */
function bindSecretCostShortcut() {
  const WINDOW_MS = 800;
  let presses = 0;
  let timer = null;

  const reset = () => {
    presses = 0;
    if (timer) { clearTimeout(timer); timer = null; }
  };

  document.addEventListener('keydown', (e) => {
    // The numpad decimal key emits "," (not ".") under the Spanish keyboard
    // layout these machines use, so match the physical key via e.code and
    // accept both characters from the main row.
    const isDot = e.code === 'NumpadDecimal' || e.key === '.' || e.key === ',';
    if (!isDot) {
      // Any other key breaks the chain.
      if (presses > 0) reset();
      return;
    }

    const t = e.target;
    const inField = t instanceof HTMLElement
      && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    if (inField) return;

    presses++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reset, WINDOW_MS);

    if (presses >= 3) {
      reset();
      state.showCosts = !state.showCosts;
      // Re-render only if the result screen is visible.
      const resultVisible = !el('seccion-resultado').classList.contains('hidden');
      if (resultVisible && lastResult) {
        renderResult(lastResult);
      }
    }
  });
}

// ============================================================
// UI: pack selection
// ============================================================

function renderPackList() {
  const container = el('lista-packs');
  container.innerHTML = '';

  for (const [id, pack] of Object.entries(CFG.packs)) {
    const meta = packMeta(pack);
    const fromPrice = computeFromPrice(pack);
    const minText = `Mín. ${pack.min_total} unidades en total`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pack-card';
    btn.dataset.packId = id;
    btn.innerHTML = `
      <div class="pack-card__top">
        <span class="pack-card__icon"><svg class="icon icon--lg"><use href="#${meta.icon}"/></svg></span>
        <span class="pack-card__arrow"><svg class="icon"><use href="#i-arrow-right"/></svg></span>
      </div>
      <span class="pack-card__title">${escapeHTML(pack.name)}</span>
      <span class="pack-card__desc">${escapeHTML(meta.desc || minText)}</span>
      <div class="pack-card__foot">
        ${fromPrice !== null ? `<span class="badge badge--accent">Desde ${formatEur(fromPrice)}</span>` : ''}
        <span class="badge badge--neutral">${minText}</span>
      </div>
    `;
    btn.addEventListener('click', () => selectPack(id));
    container.appendChild(btn);
  }
}

/**
 * "From X €" for the pack card, generic over v4 packs.
 *
 *   - bundle      → the cheapest `bundle_prices[combo]` at the first tier.
 *   - components  → the cheapest unit price among the products the pack
 *                   can use (its components / free catalog), at the first
 *                   tier with the default sides key.
 *
 * Returns null when nothing can be resolved (the card just hides the
 * badge). It never references v3 fields.
 */
function computeFromPrice(pack) {
  const firstTier = CFG.tiers[0]?.id;
  if (!firstTier) return null;

  if (pack.pricing_mode === 'bundle') {
    let min = null;
    for (const row of Object.values(pack.bundle_prices || {})) {
      const v = row ? row[firstTier] : undefined;
      if (typeof v === 'number' && (min === null || v < min)) min = v;
    }
    return min;
  }

  // components (fixed or free): cheapest candidate product's price.
  const productIds = pack.free_components
    ? Object.keys(CFG.products || {})
    : (pack.components || []).map(c => resolveDefaultProduct(pack, c));

  const sidesKey = defaultSidesKey(pack);
  let min = null;
  for (const pid of productIds) {
    const product = CFG.products[pid];
    if (!product) continue;
    const table = (product.prices || {})[sidesKey] || {};
    const v = table[firstTier];
    if (typeof v === 'number' && (min === null || v < min)) min = v;
  }
  return min;
}

/**
 * Resolves a component's product honoring the default value of any
 * option that maps it (so the "from" price uses a coherent product).
 */
function resolveDefaultProduct(pack, component) {
  let productId = component.product;
  for (const option of (pack.options || [])) {
    const map = option.maps_product;
    if (map && map.component === component.id) {
      const defValue = (option.values && option.values[0]) ? option.values[0].id : undefined;
      if (defValue !== undefined && map[defValue] !== undefined) {
        productId = map[defValue];
      }
    }
  }
  return productId;
}

/**
 * Default price-table key for a pack: the id of the option value that
 * declares `sides`, preferring `two_sides` to match the prior UX, then
 * falling back to 'one_side'.
 */
function defaultSidesKey(pack) {
  for (const option of (pack.options || [])) {
    const values = option.values || [];
    if (values.some(v => Number.isFinite(v.sides))) {
      const two = values.find(v => v.sides === 2);
      if (two) return two.id;
      const any = values.find(v => Number.isFinite(v.sides));
      if (any) return any.id;
    }
  }
  return 'one_side';
}

function selectPack(packId) {
  state.packId = packId;
  hide('error-msg');

  const pack = CFG.packs[packId];
  const meta = packMeta(pack);

  // Mark the selected card visually (visible when returning to step 1)
  document.querySelectorAll('.pack-card').forEach(card => {
    card.classList.toggle('is-selected', card.dataset.packId === packId);
  });

  el('pack-titulo').textContent = pack.name;
  el('pack-subtitulo').textContent = meta.desc || `Mín. ${pack.min_total} unidades en total`;

  // Icon in the step 2 header
  const iconWrap = document.querySelector('#seccion-paso2 .section-card__icon');
  if (iconWrap) {
    iconWrap.innerHTML = `<svg class="icon icon--lg"><use href="#${meta.icon}"/></svg>`;
  }

  renderPackInputs(packId);
  goToScreen('paso2');
  hookPreviewListeners();
  recomputePreview();
}

/**
 * "One screen at a time" navigation: shows the given section and
 * hides the rest. Scrolls to the top so each step starts from the
 * top, not from where you were on the previous screen.
 */
function goToScreen(screen) {
  const mapping = {
    paso1:     'seccion-paso1',
    paso2:     'seccion-paso2',
    resultado: 'seccion-resultado'
  };
  for (const [key, id] of Object.entries(mapping)) {
    if (key === screen) {
      show(id);
    } else {
      hide(id);
    }
  }
  // The statistics screen is a sibling overlay of the calc steps; any
  // calc navigation closes it so it never lingers behind a step.
  const stats = el('seccion-estadisticas');
  if (stats) stats.classList.add('hidden');
  // Reset scroll when switching screens.
  const scroller = document.querySelector('.app-body') || window;
  if (scroller && typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/**
 * Renders the input form for a pack, fully generic over the v4 config:
 *   - one control group per `pack.options` (radio cards),
 *   - quantity inputs depending on `pricing_mode` / `free_components`,
 *   - the addons checkboxes filtered by the pack's product categories.
 */
function renderPackInputs(packId) {
  const pack = CFG.packs[packId];
  const container = el('inputs-pack');

  const optionsHtml = (pack.options || []).map(renderOptionGroup).join('');

  let quantitiesHtml = '';
  if (pack.free_components) {
    quantitiesHtml = `
      <div id="lineas-personalizado" class="lineas-personalizado"></div>
      <div class="lineas-personalizado__add">
        <button id="btn-anadir-linea" type="button" class="btn btn-secondary">
          <svg class="icon"><use href="#i-plus"/></svg> Añadir línea
        </button>
        <span class="field__hint">
          Mín. ${pack.min_total} prendas en total. Cada línea factura al PVP del producto elegido, según el tramo del total.
        </span>
      </div>
    `;
  } else if (pack.pricing_mode === 'bundle') {
    // Default packs count so the order meets min_total garments.
    const perPack = (pack.components || []).reduce((s, c) => s + (c.qty_per_pack || 1), 0) || 1;
    const minPacks = Math.max(1, Math.ceil((pack.min_total || 1) / perPack));
    quantitiesHtml = `
      <div class="form-grid-2">
        <div class="field">
          <label class="field__label" for="in_packs">Número de packs (personas)</label>
          ${numStep('in_packs', 1, minPacks)}
          <span class="field__hint">Mínimo ${pack.min_total} unidades en total. ${componentsSummary(pack)}</span>
        </div>
      </div>
    `;
  } else {
    // components pack with fixed components: one quantity per component.
    const fields = (pack.components || []).map((c, idx) => `
      <div class="field">
        <label class="field__label" for="in_comp_${idx}">${escapeHTML(c.label || c.id)}</label>
        ${numStep(`in_comp_${idx}`, 0, 0)}
      </div>
    `).join('');
    quantitiesHtml = `
      <div class="form-grid-2">${fields}</div>
      <span class="field__hint">Total mínimo: ${pack.min_total} unidades. Cada producto factura a su PVP según el tramo del total.</span>
    `;
  }

  container.innerHTML = quantitiesHtml + optionsHtml;

  // Free-components: seed an initial line and wire add/remove.
  if (pack.free_components) {
    const productIds = Object.keys(CFG.products || {});
    const cont = el('lineas-personalizado');
    cont.appendChild(createCustomLine(productIds, productIds[0], 1));

    el('btn-anadir-linea').addEventListener('click', () => {
      const idx = cont.children.length;
      cont.appendChild(createCustomLine(productIds, productIds[0], 1, idx));
      recomputePreview();
    });

    cont.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-accion-linea="eliminar"]');
      if (!btn) return;
      const line = btn.closest('.linea-personalizado');
      if (!line) return;
      if (cont.children.length === 1) {
        // Keep at least one line: clear the quantity instead of deleting.
        const input = line.querySelector('[data-linea-cantidad]');
        if (input) input.value = '0';
        recomputePreview();
        return;
      }
      line.remove();
      reindexCustomLines(cont);
      recomputePreview();
    });
  }

  renderAddons(pack);

  // Wire NumberSteps
  container.querySelectorAll('.numstep').forEach(wireNumStep);
}

/**
 * Renders a single option group as radio cards. The radio `name` is
 * the option id and each radio `value` is the option-value id, which
 * is exactly what `calculatePack` expects in `opt.options`. The first
 * value is checked by default, except a "sides" option which defaults
 * to its 2-sides value to match the prior UX.
 */
function renderOptionGroup(option) {
  const values = option.values || [];
  const hasSides = values.some(v => Number.isFinite(v.sides));
  let defaultId = values[0] ? values[0].id : '';
  if (hasSides) {
    const two = values.find(v => v.sides === 2);
    if (two) defaultId = two.id;
  }

  const cards = values.map(v => `
    <label class="radio-card">
      <input type="radio" name="opt_${escAttr(option.id)}" value="${escAttr(v.id)}" ${v.id === defaultId ? 'checked' : ''}>
      <span>${escapeHTML(v.label || v.id)}</span>
    </label>
  `).join('');

  return `
    <div class="field" data-option-id="${escAttr(option.id)}">
      <span class="field__label">${escapeHTML(option.label || option.id)}</span>
      <div class="radio-cards radio-cards--inline">${cards}</div>
    </div>
  `;
}

/** Short "1 camiseta + 1 sudadera" style summary for bundle packs. */
function componentsSummary(pack) {
  const parts = (pack.components || []).map(c => `${c.qty_per_pack || 1} ${(c.label || c.id).toLowerCase()}`);
  return parts.length ? `Cada pack incluye ${parts.join(' + ')}.` : '';
}

/**
 * Renders the addons checkboxes into #addons-container, showing only
 * addons whose `applies_to` includes '*' or the category of at least
 * one product the pack can use. Hides the whole card if none apply.
 */
function renderAddons(pack) {
  const cont = el('addons-container');
  if (!cont) return;
  const card = el('addons-card');

  const categories = packCategories(pack);
  const applicable = Object.entries(CFG.addons || {}).filter(([, addon]) => {
    const applies = addon.applies_to || [];
    return applies.includes('*') || applies.some(cat => categories.has(cat));
  });

  if (applicable.length === 0) {
    cont.innerHTML = '';
    if (card) card.classList.add('hidden');
    return;
  }
  if (card) card.classList.remove('hidden');

  const vat = CFG.parameters.vat || 0;
  cont.innerHTML = applicable.map(([id, addon]) => {
    const unitInc = addon.vat_included ? addon.price : addon.price * (1 + vat);
    const vatNote = addon.vat_included ? 'IVA incl.' : 'sin IVA';
    return `
      <div class="field" data-addon-id="${escAttr(id)}">
        <label class="field__label" for="addon_${escAttr(id)}">
          ${escapeHTML(addon.label || id)}
          <span class="field__hint">(+${formatEur(addon.price)}/ud ${vatNote} · ${formatEur(unitInc)} IVA inc.)</span>
        </label>
        <input type="number" id="addon_${escAttr(id)}" data-addon-qty="${escAttr(id)}" min="0" value="0">
      </div>
    `;
  }).join('');
}

/** Set of product categories present in (or available to) a pack. */
function packCategories(pack) {
  const cats = new Set();
  const addCat = (pid) => {
    const product = CFG.products[pid];
    if (product && product.category) cats.add(product.category);
  };
  if (pack.free_components) {
    Object.keys(CFG.products || {}).forEach(addCat);
  } else {
    for (const c of (pack.components || [])) {
      addCat(c.product);
      // Honor option product swaps so e.g. URBAN's category counts too.
      for (const option of (pack.options || [])) {
        const map = option.maps_product;
        if (map && map.component === c.id) {
          for (const [k, v] of Object.entries(map)) {
            if (k !== 'component') addCat(v);
          }
        }
      }
    }
  }
  return cats;
}

/**
 * Creates a <div.linea-personalizado> with a product select and a
 * quantity. Sides are a pack-level option in v4, so lines no longer
 * carry their own sides selector.
 */
function createCustomLine(productIds, selectedProduct, quantity, idx = 0) {
  const wrap = document.createElement('div');
  wrap.className = 'linea-personalizado';
  wrap.dataset.idx = String(idx);

  const options = productIds.map(id => {
    const product = CFG.products[id];
    const name = product ? product.name : id;
    return `<option value="${escAttr(id)}" ${id === selectedProduct ? 'selected' : ''}>${escapeHTML(name)}</option>`;
  }).join('');

  wrap.innerHTML = `
    <div class="linea-personalizado__grid">
      <div class="field">
        <label class="field__label">Producto</label>
        <select class="input" data-linea-modelo>${options}</select>
      </div>
      <div class="field">
        <label class="field__label">Cantidad</label>
        <input type="number" class="input" min="0" step="1" value="${quantity}" data-linea-cantidad>
      </div>
      <button type="button" class="linea-personalizado__remove" data-accion-linea="eliminar"
              aria-label="Eliminar línea" title="Eliminar línea">
        <svg class="icon"><use href="#i-x"/></svg>
      </button>
    </div>
  `;
  enhanceDropdowns(wrap);
  return wrap;
}

function reindexCustomLines(cont) {
  Array.from(cont.children).forEach((line, idx) => {
    line.dataset.idx = String(idx);
  });
}

function numStep(id, min, value) {
  return `
    <div class="numstep" data-min="${min}">
      <button type="button" class="numstep__btn" data-action="dec" aria-label="Disminuir">−</button>
      <input class="numstep__input" type="number" id="${id}" min="${min}" value="${value}">
      <button type="button" class="numstep__btn" data-action="inc" aria-label="Aumentar">+</button>
    </div>
  `;
}

function wireNumStep(stepEl) {
  const input = stepEl.querySelector('input');
  const min = parseInt(stepEl.dataset.min || '0', 10);
  stepEl.querySelector('[data-action="dec"]').addEventListener('click', () => {
    const v = Math.max(min, (parseInt(input.value, 10) || 0) - 1);
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  stepEl.querySelector('[data-action="inc"]').addEventListener('click', () => {
    const v = (parseInt(input.value, 10) || 0) + 1;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Reads the form into the generic `opt` shape consumed by
 * `calculatePack` (see calculo.js header). No pack-type branching:
 * the shape is driven by `pricing_mode` / `free_components`.
 */
function collectInputs() {
  const pack = CFG.packs[state.packId];

  // Selected option values: { <optionId>: <valueId> }.
  const options = {};
  for (const option of (pack.options || [])) {
    const checked = document.querySelector(`input[name="opt_${cssEscape(option.id)}"]:checked`);
    if (checked) options[option.id] = checked.value;
  }

  // Selected addons: { <addonId>: <qty> } (only positive quantities).
  const addons = {};
  document.querySelectorAll('[data-addon-qty]').forEach(input => {
    const id = input.dataset.addonQty;
    const qty = parseInt(input.value, 10) || 0;
    if (qty > 0) addons[id] = qty;
  });

  const opt = {
    options,
    addons,
    qty_3xl: intFromInput('cant_3xl'),
    qty_4xl: intFromInput('cant_4xl'),
    qty_5xl: intFromInput('cant_5xl')
  };

  if (pack.free_components) {
    opt.lines = [];
    document.querySelectorAll('.linea-personalizado').forEach(row => {
      const product = row.querySelector('[data-linea-modelo]')?.value || '';
      const quantity = parseInt(row.querySelector('[data-linea-cantidad]')?.value, 10) || 0;
      opt.lines.push({ product, quantity });
    });
  } else if (pack.pricing_mode === 'bundle') {
    opt.packs = intFromInput('in_packs');
  } else {
    opt.quantities = {};
    (pack.components || []).forEach((c, idx) => {
      opt.quantities[c.id] = intFromInput(`in_comp_${idx}`);
    });
  }

  return opt;
}

/**
 * CSS.escape fallback for building attribute selectors from config ids.
 * Config ids are simple slugs in practice, but stay defensive.
 */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// ============================================================
// Live preview (side column of step 2)
// ============================================================

let previewListenersAttached = false;
function hookPreviewListeners() {
  if (previewListenersAttached) return;
  const step2 = el('seccion-paso2');
  if (!step2) return;
  // Delegation: any change in the form recomputes the preview.
  // Hooked once (the inner inputs change when switching packs, but
  // the container section persists).
  step2.addEventListener('input', recomputePreview);
  step2.addEventListener('change', recomputePreview);
  previewListenersAttached = true;
}

function recomputePreview() {
  if (!state.packId) return;

  const pack = CFG.packs[state.packId];
  const opt = collectInputsSafe();
  const r = opt ? calculate(opt) : null;

  const elTotal = el('preview-total');
  const elTier = el('preview-tramo');
  const elMeta = el('preview-meta');
  const elRows = el('preview-rows');

  if (!r || r.error) {
    elTotal.textContent = '—';
    elTier.textContent = '—';
    elMeta.textContent = r && r.error ? r.error : 'Rellena los campos para ver el precio';
    elRows.innerHTML = '';
    renderTierBar(opt ? totalQuantityOf(pack, opt) : 0);
    return;
  }

  lastResult = r;
  elTotal.textContent = formatEur(r.total_vat_inc);
  elTier.textContent = `Tramo ${tierIdFromLabel(r.tier)}`;

  const quantity = r.total_quantity;
  // For a bundle pack the headline is "N packs × bundle price"; for a
  // multi-line components pack we just show the garment count.
  // Per-unit headline includes the chosen addons (unit_price_with_extras).
  // Multi-line components packs (unit_price === 0) keep the bare count.
  const priceText = (r.pricing_mode === 'bundle')
    ? `${r.breakdown[0] ? r.breakdown[0].quantity : 0} packs × ${formatEur(r.unit_price_with_extras)}`
    : (r.unit_price > 0 ? `${quantity} × ${formatEur(r.unit_price_with_extras)}` : `${quantity} prendas`);
  elMeta.textContent = priceText;

  // Short breakdown rows: per line for components, the bundle row for bundle.
  let rowsHtml = '';
  if (r.pricing_mode === 'bundle') {
    rowsHtml += `<div class="preview__row"><span>Subtotal pack</span><strong>${formatEur(r.subtotal)}</strong></div>`;
  } else {
    for (const d of r.breakdown) {
      if (d.quantity === 0) continue;
      rowsHtml += `<div class="preview__row"><span>${escapeHTML(d.name)} × ${d.quantity}</span><strong>${formatEur(d.subtotal)}</strong></div>`;
    }
  }
  if (r.surcharges > 0) {
    rowsHtml += `<div class="preview__row"><span>Recargo tallas grandes</span><strong>${formatEur(r.surcharges)}</strong></div>`;
  }
  if (r.extras_no_vat > 0) {
    const parts = addonParts(r.extras_detail);
    rowsHtml += `<div class="preview__row"><span>Extras (${escapeHTML(parts.join(' · '))}) <em style="font-style: normal; opacity: 0.7;">sin IVA</em></span><strong>${formatEur(r.extras_no_vat)}</strong></div>`;
  }
  rowsHtml += `<div class="preview__row"><span>IVA (${formatPct(CFG.parameters.vat)})</span><strong>${formatEur(r.vat)}</strong></div>`;
  rowsHtml += `<div class="preview__row preview__row--total"><span>Total</span><strong>${formatEur(r.total_vat_inc)}</strong></div>`;
  elRows.innerHTML = rowsHtml;

  renderTierBar(quantity);
}

/** Human "2 nombres · 1 manga larga" parts from an addons detail map. */
function addonParts(detail) {
  const d = detail || {};
  const addons = CFG.addons || {};
  const parts = [];
  for (const [id, qty] of Object.entries(d)) {
    if (!qty) continue;
    const label = addons[id] ? (addons[id].label || id) : id;
    parts.push(`${qty} ${label.toLowerCase()}`);
  }
  return parts;
}

function collectInputsSafe() {
  try {
    const opt = collectInputs();
    if (!opt) return null;
    const total = totalQuantityOf(CFG.packs[state.packId], opt);
    if (total <= 0) return null;
    return opt;
  } catch (_) {
    return null;
  }
}

/** Single generic entry point to the v4 engine. */
function calculate(opt) {
  try {
    return calculatePack(CFG, state.packId, opt);
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

/** Total garments implied by the current inputs (for the tier bar). */
function totalQuantityOf(pack, opt) {
  if (!pack) return 0;
  if (pack.free_components) {
    return (opt.lines || []).reduce((s, l) => s + (l.quantity || 0), 0);
  }
  if (pack.pricing_mode === 'bundle') {
    const perPack = (pack.components || []).reduce((s, c) => s + (c.qty_per_pack || 1), 0);
    return (opt.packs || 0) * perPack;
  }
  const q = opt.quantities || {};
  return Object.values(q).reduce((s, n) => s + (n || 0), 0);
}

function tierIdFromLabel(label) {
  const t = CFG.tiers.find(x => x.label === label);
  return t ? t.id : '—';
}

function renderTierBar(quantity) {
  const bar = el('tramo-bar');
  const tip = el('tramo-tip');
  if (!bar) return;

  const total = CFG.tiers.length;
  const currentTier = getTier(CFG, quantity);
  const currentIdx = currentTier ? CFG.tiers.indexOf(currentTier) : -1;

  let html = '';
  for (let i = 0; i < total; i++) {
    const cls = (i < currentIdx)
      ? 'is-active'
      : (i === currentIdx ? 'is-current' : '');
    html += `<span class="tramo-bar__seg ${cls}"></span>`;
  }
  bar.innerHTML = html;

  // Tip to the next tier if it exists and improves the price
  if (tip) {
    const next = CFG.tiers[currentIdx + 1];
    if (next && currentTier && state.packId) {
      const diff = next.from - quantity;
      tip.textContent = `Si llegas a ${next.from} unidades pasas al ${next.id} (${next.label.toLowerCase()}). Te faltan ${diff}.`;
      tip.style.display = 'flex';
    } else {
      tip.style.display = 'none';
    }
  }
}

// ============================================================
// Final calculation
// ============================================================

function runCalculation() {
  hide('error-msg');
  // Use the safe collector (same as the live preview): a malformed or
  // partial pack config yields null instead of an uncaught throw.
  const opt = collectInputsSafe();
  const result = opt ? calculate(opt) : null;

  if (!result || result.error) {
    el('error-msg').textContent = (result && result.error) || 'No se pudo calcular el precio.';
    show('error-msg');
    hide('seccion-resultado');
    return;
  }

  lastResult = result;
  renderResult(result);
  goToScreen('resultado');
}

/**
 * Returns to the step 2 screen from the result, keeping the inputs
 * as they were.
 */
function backToEdit() {
  if (!state.packId) {
    goToScreen('paso1');
    return;
  }
  goToScreen('paso2');
  recomputePreview();
}

function renderResult(r) {
  // Refresh the client card: prefill from a reopened saved quote, clear
  // inline errors, and show the validity-date hint (date + validity_days).
  syncClientCard(r);

  const c = el('resultado-content');
  const isBundle = r.pricing_mode === 'bundle';
  const quantity = r.total_quantity;
  const tierId = tierIdFromLabel(r.tier);
  const baseNoVat = r.sale_base;

  // Hero stats
  const totalTime = estimateTotalTime(r);
  const timeFmt = formatTime(totalTime);
  const showCosts = state.isAdmin || state.showCosts;
  // For a bundle pack the headline metric is the per-pack price and the
  // number of packs; otherwise the garment count and the average PVP.
  const packsCount = isBundle && r.breakdown[0] ? r.breakdown[0].quantity : quantity;
  // All-in per unit (base + complementos/ud, IVA inc). Engine field; size
  // surcharges stay a separate line.
  const pricePerPack = formatEur(r.unit_price_with_extras);
  const quantityLabel = isBundle ? 'Packs' : 'Prendas';
  const hasExtras = r.extras_vat_inc > 0;
  const priceLabel = (isBundle ? 'PVP por pack' : 'PVP medio') + (hasExtras ? ' (con extras)' : '');
  const stats = [
    { label: quantityLabel,     value: isBundle ? packsCount : quantity, mono: true },
    { label: priceLabel,        value: pricePerPack, mono: true },
    { label: 'Tiempo estimado', value: timeFmt,     mono: true }
  ];
  if (showCosts) {
    stats.push({
      label: 'Margen bruto',
      value: formatPct(r.margin_pct),
      mono: true,
      accent: r.margin_pct >= 0.30
    });
  }

  // Composition by size: the engine's total_quantity already counts
  // every garment (e.g. 2 per crew pack), so no special-casing here.
  const totalGarments = quantity;
  const bigSizes = r.qty_4xl + r.qty_5xl;
  const normalSizes = Math.max(0, totalGarments - bigSizes);
  const pctNormal = totalGarments > 0 ? (normalSizes / totalGarments * 100) : 100;
  const pct4xl = totalGarments > 0 ? (r.qty_4xl / totalGarments * 100) : 0;
  const pct5xl = totalGarments > 0 ? (r.qty_5xl / totalGarments * 100) : 0;

  const breakdownRows = buildBreakdownRows(r);
  const compositionMeta = buildCompositionMeta(r);

  c.innerHTML = `
    <div class="resultado-grid">
      <article class="dark-card result-hero">
        <div class="preview__head">
          <span class="badge badge--inverse"><svg class="icon"><use href="#i-check"/></svg> Cálculo guardado · Tramo ${tierId}</span>
          <span class="text-mono" style="color: var(--fg-inverse-muted); font-size: 11px;">PASO 3 DE 3</span>
        </div>
        <div>
          <p style="color: var(--fg-inverse-muted); font-size: 13px;">Total a facturar</p>
          <h2 class="result-hero__total">${formatEur(r.total_vat_inc)}</h2>
          <p class="result-hero__sub">con ${formatPct(CFG.parameters.vat)} IVA · ${formatEur(baseNoVat)} sin IVA</p>
        </div>
        <div class="result-hero__stats">
          ${stats.map(s => `
            <div class="stat">
              <span style="color: var(--fg-inverse-muted); font-size: 11px;">${s.label}</span>
              <strong class="${s.mono ? 'text-mono' : ''}" style="color: ${s.accent ? 'var(--success)' : 'var(--fg-inverse)'}; font-size: 20px;">${s.value}</strong>
            </div>
          `).join('')}
        </div>
      </article>

      <article class="section-card">
        <div>
          <h3 class="h-card">Próximos pasos</h3>
          <p class="text-secondary" style="font-size: 12px; margin-top: 2px;">Acciones que probablemente harás ahora.</p>
        </div>
        <div class="next-steps">
          <button class="next-steps__item" type="button" disabled title="Próximamente">
            <span class="next-steps__icon"><svg class="icon"><use href="#i-clock"/></svg></span>
            <span class="next-steps__body"><strong>Programar producción</strong><span>Estimación: ${timeFmt}</span></span>
            <svg class="icon"><use href="#i-arrow-right"/></svg>
          </button>
          <button class="next-steps__item" type="button" disabled title="Próximamente">
            <span class="next-steps__icon"><svg class="icon"><use href="#i-send"/></svg></span>
            <span class="next-steps__body"><strong>Enviar al cliente</strong><span>Por email o WhatsApp</span></span>
            <svg class="icon"><use href="#i-arrow-right"/></svg>
          </button>
          <button class="next-steps__item" type="button" onclick="document.getElementById('btn-cambiar-pack').click()">
            <span class="next-steps__icon"><svg class="icon"><use href="#i-plus"/></svg></span>
            <span class="next-steps__body"><strong>Nuevo cálculo</strong><span>Sin perder este resultado</span></span>
            <svg class="icon"><use href="#i-arrow-right"/></svg>
          </button>
        </div>
      </article>
    </div>

    <div class="resultado-grid" style="margin-top: 16px;">
      <article class="section-card">
        <div class="section-card__head">
          <h3 class="h-card">Desglose por concepto</h3>
          <span class="text-muted" style="font-size: 12px;">${breakdownRows.length} concepto${breakdownRows.length === 1 ? '' : 's'}</span>
        </div>
        <table class="breakdown">
          <thead>
            <tr>
              <th>Concepto</th>
              <th class="num">Ud. (€)</th>
              <th class="num">Cant.</th>
              <th class="num">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${breakdownRows.map(row => `
              <tr class="${row.cls || ''}">
                <td class="concept">
                  <strong>${escapeHTML(row.concept)}</strong>
                  ${row.detail ? `<span>${escapeHTML(row.detail)}</span>` : ''}
                </td>
                <td class="num">${row.unit !== undefined ? formatEur(row.unit) : '—'}</td>
                <td class="num">${row.qty !== undefined ? row.qty : '—'}</td>
                <td class="num">${formatEur(row.subtotal)}</td>
              </tr>
            `).join('')}
            <tr class="subtotal">
              <td colspan="3">Subtotal sin IVA</td>
              <td class="num">${formatEur(baseNoVat)}</td>
            </tr>
            <tr>
              <td colspan="3">IVA (${formatPct(CFG.parameters.vat)})</td>
              <td class="num">${formatEur(r.vat)}</td>
            </tr>
            <tr class="total">
              <td colspan="3">TOTAL A FACTURAR</td>
              <td class="num">${formatEur(r.total_vat_inc)}</td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="section-card">
        <div>
          <h3 class="h-card">Composición del pedido</h3>
          <p class="text-secondary" style="font-size: 12px; margin-top: 2px;">Distribución por talla · ${totalGarments} prendas</p>
        </div>
        <div>
          <div class="composition__bar">
            <span class="composition__seg" style="width: ${pctNormal.toFixed(1)}%; background: var(--accent-primary);"></span>
            <span class="composition__seg" style="width: ${pct4xl.toFixed(1)}%; background: var(--warning);"></span>
            <span class="composition__seg" style="width: ${pct5xl.toFixed(1)}%; background: var(--danger);"></span>
          </div>
          <div class="composition__legend">
            <span><i style="background: var(--accent-primary);"></i>S–3XL · ${normalSizes}${r.qty_3xl ? ` (incl. ${r.qty_3xl} × 3XL)` : ''}</span>
            <span><i style="background: var(--warning);"></i>4XL · ${r.qty_4xl}</span>
            <span><i style="background: var(--danger);"></i>5XL+ · ${r.qty_5xl}</span>
          </div>
        </div>
        <hr class="divider">
        <div class="kv-list">
          ${compositionMeta.map(m => `<div class="kv-list__row"><span>${escapeHTML(m.label)}</span><span>${escapeHTML(m.value)}</span></div>`).join('')}
        </div>
        ${showCosts ? `
          <hr class="divider">
          <div>
            <h4 class="h-card" style="font-size: 13px; margin-bottom: 8px;">Datos internos${state.isAdmin ? ' (admin)' : ''}</h4>
            <div class="kv-list">
              <div class="kv-list__row"><span>Coste total</span><span class="text-mono">${formatEur(r.total_cost)}</span></div>
              <div class="kv-list__row"><span>Margen €</span><span class="text-mono">${formatEur(r.margin)}</span></div>
              <div class="kv-list__row"><span>Margen %</span><span class="text-mono" style="color: ${r.margin_pct >= 0.30 ? 'var(--success)' : 'var(--warning)'};">${formatPct(r.margin_pct)}</span></div>
            </div>
          </div>
        ` : ''}
      </article>
    </div>
  `;
}

function buildBreakdownRows(r) {
  const rows = [];
  const isBundle = r.pricing_mode === 'bundle';

  if (isBundle) {
    // Single bundle row; show the component composition in the detail.
    const top = r.breakdown[0];
    if (top) {
      const sides = top.sides;
      const comp = (top.components || []).map(c => `${c.quantity} × ${c.name}`).join(' + ');
      rows.push({
        concept: r.pack,
        detail: `${comp ? comp + ' · ' : ''}${sides} cara${sides > 1 ? 's' : ''} de impresión`,
        unit: top.unit_price,
        qty: top.quantity,
        subtotal: top.subtotal
      });
    }
  } else {
    for (const d of r.breakdown) {
      if (d.quantity === 0) continue;
      const sides = d.sides;
      rows.push({
        concept: `${d.name}`,
        detail: `${d.model} · ${sides} cara${sides > 1 ? 's' : ''}`,
        unit: d.unit_price,
        qty: d.quantity,
        subtotal: d.subtotal
      });
    }
  }

  if (r.surcharges > 0) {
    const parts = [];
    if (r.qty_4xl > 0) parts.push(`${r.qty_4xl} × 4XL`);
    if (r.qty_5xl > 0) parts.push(`${r.qty_5xl} × 5XL+`);
    rows.push({
      cls: 'surcharge',
      concept: 'Recargo tallas grandes',
      detail: parts.join(' · ') + ' · facturado al cliente',
      subtotal: r.surcharges
    });
  }

  if (r.extras_no_vat > 0) {
    const detail = r.extras_detail || {};
    const addons = CFG.addons || {};
    const vat = CFG.parameters.vat || 0;
    for (const [id, qty] of Object.entries(detail)) {
      if (!qty) continue;
      const addon = addons[id];
      const price = addon ? addon.price : 0;
      const label = addon ? (addon.label || id) : id;
      const unitInc = addon && addon.vat_included ? price : price * (1 + vat);
      const vatNote = addon && addon.vat_included ? 'IVA incl.' : 'sin IVA';
      rows.push({
        concept: label,
        detail: `${formatEur(price)}/ud ${vatNote} · extra opcional`,
        unit: unitInc,
        qty,
        subtotal: qty * unitInc
      });
    }
  }
  return rows;
}

function buildCompositionMeta(r) {
  const pack = CFG.packs[r.pack_id];
  const meta = [
    { label: 'Pack', value: r.pack }
  ];

  // Selected options (capucha, caras, …) resolved to their labels.
  if (pack) {
    for (const option of (pack.options || [])) {
      const selectedId = (r.options || {})[option.id];
      const value = (option.values || []).find(v => v.id === selectedId);
      if (value) {
        meta.push({ label: option.label || option.id, value: value.label || value.id });
      }
    }
  }

  // Line composition for multi-line components packs.
  if (r.pricing_mode !== 'bundle' && r.breakdown.length > 1) {
    const lineSummary = r.breakdown
      .filter(d => d.quantity > 0)
      .map(d => `${d.quantity} × ${d.name}`)
      .join(' · ');
    meta.push({ label: 'Líneas', value: lineSummary || '—' });
  }
  meta.push({ label: 'Total prendas', value: String(r.total_quantity) });

  meta.push({ label: 'Tallas con recargo', value: `${r.qty_4xl + r.qty_5xl} (${r.qty_4xl} × 4XL · ${r.qty_5xl} × 5XL+)` });
  if (r.qty_3xl) {
    meta.push({ label: 'Colchón 3XL (no facturado)', value: `${r.qty_3xl}` });
  }
  meta.push({ label: 'Tramo aplicado', value: r.tier });
  return meta;
}

function estimateTotalTime(r) {
  // We reconstruct the time from base minutes × quantity × tier from
  // the breakdown rows (each row carries its sides). Not exact to the
  // internal calculation but a useful estimate.
  const p = CFG.parameters;
  const tier = CFG.tiers.find(t => t.label === r.tier);
  const reduction = tier ? tier.time_reduction : 0;

  let total = 0;
  for (const d of (r.breakdown || [])) {
    const base = d.sides === 2 ? p.minutes_two_sides_base : p.minutes_one_side_base;
    // For a bundle row, quantity is the number of packs; multiply by the
    // garments per pack so the time reflects every printed garment.
    const garments = (r.pricing_mode === 'bundle')
      ? (d.components || []).reduce((s, c) => s + c.quantity, 0)
      : d.quantity;
    total += garments * base * (1 - reduction);
  }
  return total;
}

function formatTime(minutes) {
  if (!minutes || isNaN(minutes)) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function copySummary() {
  const r = lastResult;
  if (!r) return;
  const lines = [
    `${r.pack} · ${r.tier}`,
    `Cantidad: ${r.total_quantity}`,
    `Total IVA inc.: ${formatEur(r.total_vat_inc)}`,
    `Base sin IVA: ${formatEur(r.sale_base)}`,
    `IVA (${formatPct(CFG.parameters.vat)}): ${formatEur(r.vat)}`
  ];
  if (r.surcharges > 0) {
    lines.push(`Recargo tallas grandes: ${formatEur(r.surcharges)} (${r.qty_4xl} × 4XL · ${r.qty_5xl} × 5XL+)`);
  }
  if (r.extras_no_vat > 0) {
    const parts = addonParts(r.extras_detail);
    lines.push(`Extras opcionales (sin IVA): ${formatEur(r.extras_no_vat)} (${parts.join(' · ')})`);
  }
  navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
}

function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function resetForm() {
  if (state.packId) renderPackInputs(state.packId);
  el('cant_3xl').value = '0';
  el('cant_4xl').value = '0';
  el('cant_5xl').value = '0';
  hide('error-msg');
  recomputePreview();
}

function backToSelection() {
  state.packId = null;
  hide('error-msg');
  document.querySelectorAll('.pack-card').forEach(card => card.classList.remove('is-selected'));
  goToScreen('paso1');
}

// ============================================================
// Reload config from the NAS
// ============================================================

async function reloadConfig() {
  if (state.isAdmin) {
    const ok = confirm('Tienes el modo admin abierto con cambios sin guardar. ¿Recargar de todos modos? Se perderán tus cambios.');
    if (!ok) return;
    closeAdmin();
  }
  await loadConfigAndShowApp();
}

// ============================================================
// Admin mode
// ============================================================

async function openAdmin() {
  show('admin-overlay');

  // No password gate (file or cloud): the editor opens directly and the
  // recorded author replaces the login (UI-UX §2.5). Protection against
  // mistakes is the save-confirmation dialog + per-write audit author +
  // snapshot rollback. (Offline cloud already disables the entry button
  // in refreshOfflineBanner, so editing only happens online.)
  if (!state.isAdmin) {
    state.isAdmin = true;
    el('btn-admin-toggle').innerHTML = '<svg class="icon"><use href="#i-lock"/></svg> Admin activo';
    el('btn-admin-toggle').classList.remove('btn-secondary');
    el('btn-admin-toggle').classList.add('btn-primary');
  }
  await showAdminEditor();
}

function closeAdmin() {
  hide('admin-overlay');
  // Drop the catalog list/editor session state so the next open starts
  // on the list with no remembered collapsed sections.
  state.adminView = 'list';
  state.adminEditingId = null;
  state.adminClosedSections.clear();
}

async function showAdminEditor() {
  show('admin-editor');

  CFG_BACKUP = deepClone(CFG);

  // v5 cloud: no on-disk config info to snapshot (concurrency is
  // per-entity via DATA_STATE.versions). Show the recorded author and
  // skip the file-only getConfigInfo. File mode keeps its mtime+hash
  // conflict baseline.
  const authorBox = el('admin-editor-author');
  if (isCloudMode()) {
    adminConfigInfoAtOpen = null;
    if (authorBox) {
      authorBox.classList.remove('hidden');
      const nameEl = el('admin-editor-author-name');
      if (nameEl) nameEl.textContent = cloudAuthorName();
    }
  } else {
    if (authorBox) authorBox.classList.add('hidden');
    adminConfigInfoAtOpen = await window.packprice.getConfigInfo(SETTINGS.config_path);
  }
  updateAdminFooter();

  // Open on the list view with no remembered editor/collapsed sections,
  // so each admin session starts fresh.
  state.adminView = 'list';
  state.adminEditingId = null;
  state.adminClosedSections.clear();
  showAdminTab(state.adminTab);
}

function updateAdminFooter() {
  const info = el('admin-foot-info');
  if (!info) return;
  const date = CFG.updated_at || '—';
  const by = CFG.modified_by || '—';
  info.textContent = `Última escritura: ${date} · por ${by}`;
}

function showAdminTab(tab, opts = {}) {
  state.adminTab = tab;

  // Arriving at a tab (not an in-editor re-render) starts on the list.
  if (!opts.keepView) {
    state.adminView = 'list';
    state.adminEditingId = null;
  }

  document.querySelectorAll('.admin-nav__item').forEach(t => {
    t.classList.toggle('is-active', t.dataset.tab === tab);
  });
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  const meta = ADMIN_TAB_META[tab];
  if (meta) {
    const title = el('admin-form-title');
    const desc = el('admin-form-desc');
    if (title) title.textContent = meta.title;
    if (desc) desc.textContent = meta.desc;
  }

  // Preserve scroll when re-rendering after an action (add/remove
  // row): otherwise the modal container jumps to the top each time.
  const scroller = document.querySelector('.modal__body');
  const scrollPrev = (opts.preserveScroll && scroller) ? scroller.scrollTop : null;

  const cont = el('admin-tab-content');

  // Historial tab (async content, loaded via IPC). Cloud mode shows two
  // sub-views (auditoría + versiones, with restore); file mode shows the
  // existing local audit only — no regression.
  if (tab === 'audit') {
    if (isCloudMode()) {
      renderCloudHistoryTab(cont);
    } else {
      cont.innerHTML = '<p class="hint">Cargando auditoría…</p>';
      window.packprice.listAuditEntries({ ruta: SETTINGS.config_path, limit: 200 })
        .then((r) => {
          cont.innerHTML = (r && r.ok)
            ? renderAuditTab(r.entries || [])
            : `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>No se pudo leer audit.log: ${escAttr(r && r.error)}</span></div>`;
        })
        .catch((err) => {
          cont.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
        });
    }
    if (scrollPrev !== null && scroller) scroller.scrollTop = scrollPrev;
    return;
  }

  // Catalog tabs (master/detail): the live search query is owned by
  // state, so a re-render keeps the user's filter. The router renders the
  // editor for the entity in state, else the list with the live query.
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

  // Restyle the native <select>s of this freshly rendered tab. The
  // native elements stay as source of truth, so the change wiring below
  // (data-cfg-path / data-action-change) attaches to them as usual.
  enhanceDropdowns(cont);

  // Plain field edits: inputs, selects and checkboxes carrying a
  // data-cfg-path. These do not re-render (preserve cursor/scroll);
  // the value is written straight into CFG.
  cont.querySelectorAll('[data-cfg-path]').forEach(input => {
    input.addEventListener('change', () => updateConfigFromInput(CFG, input));
  });

  // Builder actions: buttons (data-action) and live controls
  // (data-action-change on radios/checkboxes/selects) that mutate the
  // config structurally and need a re-render afterwards.
  const runAction = async (dataset) => {
    const result = executeAdminAction(CFG, dataset);
    if (result && result.error) {
      await window.packprice.showError({
        titulo: 'Acción no permitida',
        mensaje: result.error
      });
      // Re-render so a rejected toggle (e.g. a radio) snaps back — but
      // stay where we are: a rejected action inside the editor must not
      // kick the user back to the list.
      showAdminTab(tab, { keepView: true, preserveScroll: true });
      return;
    }
    if (result && result.dirty) {
      // A top-level add (add-product/pack/supplier/addon) returns the new
      // id; jump straight into its editor. Structural actions inside the
      // editor re-render in place.
      if (CATALOG_TABS.has(tab) && result.id && String(dataset.action || '').startsWith('add-')) {
        state.adminView = 'editor';
        state.adminEditingId = result.id;
        showAdminTab(tab, { keepView: true });
      } else {
        showAdminTab(tab, { keepView: true, preserveScroll: true });
      }
      return;
    }
  };

  cont.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => runAction(btn.dataset));
  });

  cont.querySelectorAll('[data-action-change]').forEach(ctrl => {
    ctrl.addEventListener('change', () => {
      // Normalize into the dataset shape executeAdminAction expects.
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

  // Catalog tabs: master/detail navigation, live search and collapsible
  // section persistence. All UI state lives in `state` (not the DOM)
  // because the whole tab re-renders on every structural action.
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

  if (scrollPrev !== null && scroller) {
    scroller.scrollTop = scrollPrev;
  }
}

// Small escape just to inject error messages into the async HTML.
// Does not depend on format.js to avoid circular imports in a
// defensive function.
function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// v5 cloud: Historial tab (auditoría + versiones + restaurar)
// ============================================================
// Two sub-views in cloud mode (UI-UX §2.5): «Auditoría» (who/when/what,
// paginated) and «Versiones» (the snapshot list with «Restaurar esta
// versión»). File mode never reaches here — showAdminTab routes it to
// the existing local audit render instead. All data comes through
// window.packprice.* (CSP intact).

/**
 * Renders the cloud Historial shell (the two-tab switcher + a body
 * container) and loads the active sub-view. Resets the paging scratch
 * state so re-entering the tab starts fresh.
 */
function renderCloudHistoryTab(cont) {
  historyState = { view: historyState.view || 'audit', auditEntries: [], auditOffset: 0, auditDone: false };

  cont.innerHTML = `
    <div class="history-subnav" role="tablist">
      <button type="button" class="history-subnav__item" data-history-view="audit">Auditoría</button>
      <button type="button" class="history-subnav__item" data-history-view="versions">Versiones</button>
    </div>
    <div id="history-view-body"></div>
  `;

  cont.querySelectorAll('[data-history-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchHistoryView(btn.dataset.historyView));
  });

  switchHistoryView(historyState.view);
}

/** Switches the active cloud-history sub-view and (re)loads its body. */
function switchHistoryView(view) {
  historyState.view = view;
  document.querySelectorAll('[data-history-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.historyView === view);
  });
  if (view === 'versions') {
    loadSnapshotsView();
  } else {
    // Re-entering the audit view reloads from the top (offset 0).
    historyState.auditEntries = [];
    historyState.auditOffset = 0;
    historyState.auditDone = false;
    loadAuditPage({ reset: true });
  }
}

/**
 * Loads one page of cloud audit entries and appends them. The cloud
 * `audit:list` returns newest-first already, so we keep the order and
 * grow the list downward. «Cargar más» bumps the offset until a short
 * page tells us we reached the end.
 */
async function loadAuditPage({ reset } = {}) {
  const body = el('history-view-body');
  if (!body) return;
  if (reset) body.innerHTML = '<p class="hint">Cargando auditoría…</p>';

  let r;
  try {
    r = await window.packprice.listAudit({ limit: AUDIT_PAGE_SIZE, offset: historyState.auditOffset });
  } catch (err) {
    body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
    return;
  }
  if (!r || !r.ok) {
    body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>No se pudo leer el historial: ${escAttr(r && r.error)}</span></div>`;
    return;
  }

  const page = r.entries || [];
  historyState.auditEntries = historyState.auditEntries.concat(page);
  historyState.auditOffset += page.length;
  if (page.length < AUDIT_PAGE_SIZE) historyState.auditDone = true;

  renderAuditView(body);
}

/** Paints the accumulated audit entries plus the «Cargar más» control. */
function renderAuditView(body) {
  const more = historyState.auditDone
    ? ''
    : `<div class="history-more">
         <button type="button" class="btn btn-secondary" id="btn-history-more">Cargar más</button>
       </div>`;
  body.innerHTML = renderCloudAuditList(historyState.auditEntries) + more;

  const btnMore = el('btn-history-more');
  if (btnMore) {
    btnMore.addEventListener('click', async () => {
      btnMore.disabled = true;
      btnMore.textContent = 'Cargando…';
      await loadAuditPage();
    });
  }
}

/** Loads and renders the snapshot list, wiring each restore button. */
async function loadSnapshotsView() {
  const body = el('history-view-body');
  if (!body) return;
  body.innerHTML = '<p class="hint">Cargando versiones…</p>';

  let r;
  try {
    r = await window.packprice.listSnapshots();
  } catch (err) {
    body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
    return;
  }
  if (!r || !r.ok) {
    body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>No se pudo leer la lista de versiones: ${escAttr(r && r.error)}</span></div>`;
    return;
  }

  body.innerHTML = renderSnapshotsList(r.versions || []);
  body.querySelectorAll('[data-action="restore-snapshot"]').forEach((btn) => {
    btn.addEventListener('click', () => restoreSnapshotFlow(btn.dataset.version, btn.dataset.label));
  });
}

/**
 * Restore flow (UI-UX §2.5): confirm → restoreSnapshot → reload the
 * catalog (so the editor + app reflect the restored state) → toast +
 * refresh the audit list (the restore is itself a new audit entry). A
 * failure shows a plain Spanish error and changes nothing.
 */
async function restoreSnapshotFlow(versionRaw, label) {
  const version = Number(versionRaw);
  if (!Number.isFinite(version)) return;

  const option = await window.packprice.confirm({
    titulo: 'Restaurar versión',
    mensaje: `Vas a restaurar la versión ${version} del ${label || ''}. Se creará una versión nueva con ese contenido.`,
    detalle: '¿Continuar?',
    botones: ['Restaurar', 'Cancelar'],
    defaultId: 1
  });
  if (option !== 0) return;

  let r;
  try {
    r = await window.packprice.restoreSnapshot({ version });
  } catch (err) {
    await window.packprice.showError({
      titulo: 'No se pudo restaurar',
      mensaje: err.message || 'Error desconocido al restaurar la versión.'
    });
    return;
  }

  if (!r || !r.ok) {
    await window.packprice.showError({
      titulo: 'No se pudo restaurar',
      mensaje: (r && r.error) || 'No se pudo restaurar la versión seleccionada.'
    });
    return;
  }

  // Reload the catalog so the editor (and the rest of the app) reflect
  // the restored state. Land back on the audit view: reloadCloud…Quietly
  // re-renders the active admin tab (here 'audit' → renderCloudHistoryTab,
  // which reloads the audit page from offset 0), so the restore shows as
  // the newest entry without a second manual render.
  historyState.view = 'audit';
  await reloadCloudCatalogQuietly();
  showToast(`Restaurado a la versión ${version}`);
}

async function saveConfigToNas() {
  // v5 cloud (UI-UX §2.5): confirmation modal with a grouped change
  // summary + author, then a guarded per-entity write. Saving without
  // confirming is impossible (the write only happens on confirm).
  if (isCloudMode()) {
    await saveCatalogCloud();
    return;
  }

  CFG.updated_at = new Date().toLocaleString('es-ES');
  CFG.modified_by = SETTINGS.user_name;

  const payload = {
    ruta: SETTINGS.config_path,
    configNuevo: CFG,
    infoEsperada: adminConfigInfoAtOpen
  };

  // Diff preview: shows the admin exactly what will change before
  // writing. If there are no real changes, warn and abort.
  const confirmed = await showDiffPreview(payload);
  if (!confirmed) return;

  const r = await window.packprice.writeConfig(payload);

  if (r.ok) {
    adminConfigInfoAtOpen = r.info;
    CFG_BACKUP = deepClone(CFG);
    await showSavedModal({ backupPath: r.backupPath });
    initApp();
    updateAdminFooter();
    return;
  }

  if (r.conflicto) {
    await resolveAdminConflict(r);
    return;
  }

  await window.packprice.showError({
    titulo: 'Error al guardar',
    mensaje: 'No se pudo guardar el archivo',
    detalle: r.error || 'Error desconocido'
  });
}

/**
 * In-app «Guardado» confirmation (replaces the native success dialog).
 * Shows «Cambios guardados correctamente» plus, if present, the backup
 * path. Resolves when the user dismisses it (Aceptar / X / Esc / overlay).
 */
function showSavedModal({ message, backupPath } = {}) {
  el('saved-subtitle').textContent = message || 'Cambios guardados correctamente';
  el('saved-body').innerHTML = backupPath
    ? `<p class="saved-path__label">Backup creado en:</p>
       <p class="saved-path__value text-mono">${escAttr(backupPath)}</p>`
    : '';

  show('saved-overlay');

  return new Promise((resolve) => {
    const cleanup = () => {
      hide('saved-overlay');
      btnOk.removeEventListener('click', onClose);
      btnClose.removeEventListener('click', onClose);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    };
    const onClose = () => { cleanup(); resolve(); };
    const onOverlayClick = (e) => { if (e.target.id === 'saved-overlay') onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };

    const btnOk = el('btn-saved-aceptar');
    const btnClose = el('btn-cerrar-saved');
    const overlay = el('saved-overlay');

    btnOk.addEventListener('click', onClose);
    btnClose.addEventListener('click', onClose);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

async function resolveAdminConflict(conflictResponse) {
  const response = await window.packprice.confirmConflict({
    modificadoPor: conflictResponse.modificadoPor,
    fechaActualizacion: conflictResponse.fechaActualizacion
  });

  if (response === 0) {
    const r2 = await window.packprice.forceWriteConfig({
      ruta: SETTINGS.config_path,
      configNuevo: CFG
    });
    if (r2.ok) {
      adminConfigInfoAtOpen = r2.info;
      CFG_BACKUP = deepClone(CFG);
      await window.packprice.showInfo({
        titulo: 'Guardado (forzado)',
        mensaje: 'Cambios guardados sobrescribiendo la versión del compañero.'
      });
      initApp();
    } else {
      await window.packprice.showError({
        titulo: 'Error',
        mensaje: 'No se pudo guardar',
        detalle: r2.error
      });
    }
  } else if (response === 1) {
    closeAdmin();
    state.isAdmin = false;
    el('btn-admin-toggle').innerHTML = '<svg class="icon"><use href="#i-lock"/></svg> Admin';
    el('btn-admin-toggle').classList.remove('btn-primary');
    el('btn-admin-toggle').classList.add('btn-secondary');
    await loadConfigAndShowApp();
  }
}

function cancelAdminChanges() {
  if (CFG_BACKUP) {
    CFG = deepClone(CFG_BACKUP);
    showAdminTab(state.adminTab);
    initApp();
  }
}

// ============================================================
// v5 cloud: catalog save (confirmation) + per-entity conflict (§2.3/§2.5)
// ============================================================

// Spanish entity labels for the confirmation/conflict modals. Keeps
// the technical entityType (English code) out of the user-facing copy.
const ENTITY_LABEL = {
  pack: 'Pack',
  product: 'Producto',
  supplier: 'Proveedor',
  addon: 'Complemento',
  parameters: 'Parámetros de cálculo',
  tiers: 'Tramos por volumen',
  company: 'Empresa'
};

function entityLabel(entityType, id) {
  const base = ENTITY_LABEL[entityType] || entityType;
  return id ? `${base} «${id}»` : base;
}

/**
 * Cloud catalog save (UI-UX §2.5): derive the grouped change summary
 * from CFG_BACKUP → CFG, confirm it (with the author), and only then
 * call saveCatalog with the edited cfg + the versions we loaded as the
 * optimistic-concurrency baseline. On a per-entity conflict, hand off
 * to resolveCloudConflicts. The write CANNOT happen without confirming.
 */
async function saveCatalogCloud() {
  const summary = buildSaveSummary(CFG_BACKUP || {}, CFG);
  if (summary.length === 0) {
    await window.packprice.showInfo({
      titulo: 'Sin cambios',
      mensaje: 'No hay nada que guardar: el catálogo ya coincide con el guardado.'
    });
    return;
  }

  const confirmed = await showSaveConfirm(summary);
  if (!confirmed) return;

  const r = await window.packprice.saveCatalog({
    newCfg: CFG,
    expectedVersions: DATA_STATE.versions
  });

  if (r && r.ok) {
    await afterCloudSaveClean(r);
    return;
  }

  if (r && Array.isArray(r.conflicts) && r.conflicts.length > 0) {
    await resolveCloudConflicts(r);
    return;
  }

  await window.packprice.showError({
    titulo: 'Error al guardar',
    mensaje: 'No se pudieron guardar los cambios en la nube.',
    detalle: (r && r.error) || 'Error desconocido'
  });
}

/** Refresh local state after a clean (no-conflict) cloud save. */
async function afterCloudSaveClean(result) {
  CFG_BACKUP = deepClone(CFG);
  if (result && typeof result.catalogVersion === 'number') {
    DATA_STATE.catalogVersion = result.catalogVersion;
  }
  // Pull the authoritative catalog (and fresh per-entity versions) so a
  // subsequent save in the same session guards against the right baseline.
  await reloadCloudCatalogQuietly();
  await window.packprice.showInfo({
    titulo: 'Guardado',
    mensaje: 'Cambios guardados en la nube.'
  });
  updateAdminFooter();
}

/**
 * Reloads the cloud catalog in place (no screen change), keeping the
 * editor open. Used after a save to refresh DATA_STATE.versions and CFG.
 */
async function reloadCloudCatalogQuietly() {
  const r = await window.packprice.refreshCatalog();
  if (r && r.ok) {
    CFG = r.config;
    ensureDefaultPacks(CFG);
    DATA_STATE = {
      source: r.source,
      catalogVersion: r.catalogVersion,
      fetchedAt: r.fetchedAt,
      offline: r.offline,
      reason: r.reason,
      versions: r.versions
    };
    CFG_BACKUP = deepClone(CFG);
    refreshDataStatusUi();
    if (!el('admin-editor').classList.contains('hidden')) {
      showAdminTab(state.adminTab, { preserveScroll: true });
    }
  }
}

/**
 * Save-confirmation modal (UI-UX §2.5). Reuses the admin diff overlay,
 * listing the grouped changes + the author. Resolves true on confirm,
 * false otherwise. The confirm button reads «Guardar N cambios».
 */
function showSaveConfirm(summary) {
  const n = totalChanges(summary);
  el('diff-body').innerHTML = renderSaveSummary(summary);

  const confirmBtn = el('btn-diff-confirmar');
  confirmBtn.innerHTML = `<svg class="icon"><use href="#i-save"/></svg> Guardar ${n} cambio${n === 1 ? '' : 's'}`;

  show('diff-overlay');

  return new Promise((resolve) => {
    const cleanup = () => {
      hide('diff-overlay');
      // Restore the file-mode default label so the shared overlay is reusable.
      confirmBtn.innerHTML = '<svg class="icon"><use href="#i-save"/></svg> Confirmar y guardar';
      confirmBtn.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      btnClose.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    };
    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onOverlayClick = (e) => { if (e.target.id === 'diff-overlay') onCancel(); };
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

    const btnCancel = el('btn-diff-cancelar');
    const btnClose = el('btn-cerrar-diff');
    const overlay = el('diff-overlay');

    confirmBtn.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    btnClose.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

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

/**
 * Per-entity conflict resolution (UI-UX §2.3). The non-conflicting
 * entities were already written by main; here we walk the conflicted
 * ones sequentially. For each: show server-vs-mine, then
 *   - «Cargar versión del servidor» → reload the whole catalog (the
 *     editor then shows the server state) and stop.
 *   - «Sobrescribir con la mía» → re-save just this entity using the
 *     server's current version as the new baseline (so it now wins).
 *   - «Cancelar» → stop, leaving the already-written entities saved.
 * Finally report «N cambios guardados, M conflictos».
 */
async function resolveCloudConflicts(result) {
  const conflicts = result.conflicts.slice();
  const written = (result.results || []).filter(r => r.status === 'written' || r.status === 'deleted').length;

  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i];
    const choice = await showConflictModal(conflict, { index: i, total: conflicts.length });

    if (choice === 'load-server') {
      await reloadCloudCatalogQuietly();
      await window.packprice.showInfo({
        titulo: 'Versión del servidor cargada',
        mensaje: 'El editor muestra ahora la versión del servidor. Revisa y vuelve a guardar si quieres.'
      });
      return;
    }

    if (choice === 'overwrite') {
      const ok = await overwriteEntity(conflict);
      if (!ok) return; // overwriteEntity already reported the error
      continue;
    }

    // cancel: stop the loop, keep what was already written.
    break;
  }

  await window.packprice.showInfo({
    titulo: 'Resultado del guardado',
    mensaje: `${written} cambio${written === 1 ? '' : 's'} guardado${written === 1 ? '' : 's'}, ${conflicts.length} conflicto${conflicts.length === 1 ? '' : 's'}.`
  });
  await reloadCloudCatalogQuietly();
  updateAdminFooter();
}

/**
 * Re-saves a single conflicted entity using the server's current
 * version as the expected baseline, so this write wins. Pragmatic and
 * sequential: we send the full edited CFG but a versions map that only
 * advances the conflicted entity to the server version (the others were
 * already written, so they no longer differ from the now-current cfg).
 */
async function overwriteEntity(conflict) {
  const baseline = buildOverwriteVersions(conflict);
  // Safety invariant: once an entity is written it equals CFG, so it no
  // longer re-diffs as changed and is skipped on the next saveCatalog —
  // which is why re-sending the ORIGINAL expectedVersions for the
  // non-conflicted entities here is safe (only the conflicted entity is
  // re-attempted, with its version advanced by buildOverwriteVersions).
  const r = await window.packprice.saveCatalog({
    newCfg: CFG,
    expectedVersions: baseline
  });
  if (r && r.ok) return true;
  if (r && Array.isArray(r.conflicts) && r.conflicts.length > 0) {
    // Someone moved again between read and write — surface it plainly.
    await window.packprice.showError({
      titulo: 'Sigue habiendo conflicto',
      mensaje: `«${entityLabel(conflict.entityType, conflict.id)}» volvió a cambiar en el servidor. Carga la versión del servidor y revisa.`
    });
    return false;
  }
  await window.packprice.showError({
    titulo: 'Error al sobrescribir',
    mensaje: (r && r.error) || 'No se pudo guardar la entidad.'
  });
  return false;
}

/**
 * Builds an expectedVersions map that advances ONLY the conflicted
 * entity to the server's current version (so the overwrite guard
 * matches and our write wins). For a global singleton the baseline is
 * the server catalog_version.
 */
function buildOverwriteVersions(conflict) {
  const base = deepClone(DATA_STATE.versions || {});
  const { entityType, id, serverRow, serverCatalogVersion } = conflict;

  if (id && serverRow && typeof serverRow.version === 'number') {
    if (!base[entityType]) base[entityType] = {};
    base[entityType][id] = serverRow.version;
  } else if (!id && typeof serverCatalogVersion === 'number') {
    base.catalogVersion = serverCatalogVersion;
  }
  return base;
}

/**
 * Shows the per-entity conflict modal (server vs mine) and resolves to
 * one of 'load-server' | 'overwrite' | 'cancel'.
 */
function showConflictModal(conflict, progress) {
  const { entityType, id } = conflict;
  el('conflict-subtitle').textContent =
    `Otro equipo modificó «${entityLabel(entityType, id)}» mientras editabas.`;
  el('conflict-body').innerHTML = renderConflictBody(conflict);

  const progressEl = el('conflict-progress');
  if (progressEl && progress && progress.total > 1) {
    progressEl.textContent = `Conflicto ${progress.index + 1} de ${progress.total}`;
  } else if (progressEl) {
    progressEl.textContent = '';
  }

  show('conflict-overlay');

  return new Promise((resolve) => {
    const cleanup = () => {
      hide('conflict-overlay');
      btnLoad.removeEventListener('click', onLoad);
      btnOver.removeEventListener('click', onOver);
      btnCancel.removeEventListener('click', onCancel);
      btnClose.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    };
    const onLoad = () => { cleanup(); resolve('load-server'); };
    const onOver = () => { cleanup(); resolve('overwrite'); };
    const onCancel = () => { cleanup(); resolve('cancel'); };
    const onOverlayClick = (e) => { if (e.target.id === 'conflict-overlay') onCancel(); };
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

    const btnLoad = el('btn-conflict-load-server');
    const btnOver = el('btn-conflict-overwrite');
    const btnCancel = el('btn-conflict-cancelar');
    const btnClose = el('btn-cerrar-conflict');
    const overlay = el('conflict-overlay');

    btnLoad.addEventListener('click', onLoad);
    btnOver.addEventListener('click', onOver);
    btnCancel.addEventListener('click', onCancel);
    btnClose.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Renders the conflict comparison: the server's row (raw main-entity
 * fields, the authoritative bits main returned) vs your edited slice.
 * Pragmatic — the server row carries the entity's top-level columns
 * which is enough to show the user "what differs".
 */
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

/** The user's edited sub-object for an entity (per-id or global). */
function mineEntitySlice(entityType, id) {
  const sections = { pack: 'packs', product: 'products', supplier: 'suppliers', addon: 'addons' };
  if (id && sections[entityType]) {
    return (CFG[sections[entityType]] || {})[id];
  }
  return CFG[entityType];
}

// ============================================================
// Diff preview modal (call before writing the config)
// ============================================================
//
// Resolves to `true` when the user confirms, `false` when they
// cancel or there are no changes. Always reuses the same overlay
// element; the actual buttons are wired here for each call so the
// promise resolves cleanly.
async function showDiffPreview(payload) {
  let preview;
  try {
    preview = await window.packprice.previewConfigDiff({
      ruta: payload.ruta,
      configNuevo: payload.configNuevo
    });
  } catch (err) {
    await window.packprice.showError({
      titulo: 'No se pudo generar la previsualización',
      mensaje: err.message || 'Error desconocido'
    });
    return false;
  }

  if (!preview || !preview.ok) {
    await window.packprice.showError({
      titulo: 'No se pudo generar la previsualización',
      mensaje: (preview && preview.error) || 'Error desconocido'
    });
    return false;
  }

  const changes = preview.changes || [];
  if (changes.length === 0) {
    await window.packprice.showInfo({
      titulo: 'Sin cambios',
      mensaje: 'No hay nada que guardar: el config actual ya coincide con el del NAS.'
    });
    return false;
  }

  el('diff-body').innerHTML = renderDiffPreview(changes);
  show('diff-overlay');

  return new Promise((resolve) => {
    const cleanup = () => {
      hide('diff-overlay');
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      btnClose.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    };
    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel  = () => { cleanup(); resolve(false); };
    const onOverlayClick = (e) => { if (e.target.id === 'diff-overlay') onCancel(); };
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

    const btnConfirm = el('btn-diff-confirmar');
    const btnCancel  = el('btn-diff-cancelar');
    const btnClose   = el('btn-cerrar-diff');
    const overlay    = el('diff-overlay');

    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    btnClose.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

// ============================================================
// Logs viewer modal
// ============================================================
async function openLogs() {
  el('logs-body').innerHTML = '<p class="hint">Cargando…</p>';
  show('logs-overlay');
  try {
    const r = await window.packprice.readLogs(200);
    if (r && r.ok) {
      el('logs-body').innerHTML = renderLogsModal({ path: r.path, lines: r.lines });
    } else {
      el('logs-body').innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>No se pudo leer el log: ${escAttr(r && r.error)}</span></div>`;
    }
  } catch (err) {
    el('logs-body').innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
  }
}

function closeLogs() {
  hide('logs-overlay');
}

// ============================================================
// Quote history modal
// ============================================================
async function openHistory() {
  show('history-overlay');
  const search = el('history-search');
  if (search) search.value = '';
  await refreshHistory();
}

function closeHistory() {
  hide('history-overlay');
}

async function refreshHistory() {
  const body = el('history-body');
  const search = el('history-search');
  const query = search ? search.value : '';
  body.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const r = query
      ? await window.packprice.searchQuotes(query)
      : await window.packprice.listQuotes();
    if (!r || !r.ok) {
      body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(r && r.error)}</span></div>`;
      return;
    }
    body.innerHTML = renderHistoryList(r.quotes || []);
    el('history-foot-info').textContent = `${(r.quotes || []).length} presupuesto${(r.quotes || []).length === 1 ? '' : 's'}`;

    body.querySelectorAll('[data-action]').forEach(btn => {
      if (btn.dataset.action === 'status') {
        // Status chips carry the target status; route to the chip handler
        // (cloud set-status + local patch + undo toast). The current chip
        // is a no-op so a stray click doesn't re-send the same status.
        btn.addEventListener('click', () => {
          if (btn.classList.contains('is-active')) return;
          changeQuoteStatus(btn.dataset.id, btn.dataset.status);
        });
        return;
      }
      btn.addEventListener('click', () => onHistoryAction(btn.dataset.action, btn.dataset.id));
    });
  } catch (err) {
    body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
  }
}

async function onHistoryAction(action, id) {
  if (action === 'status') {
    // Handled by the dedicated chip handler (needs the target status).
    return;
  }
  if (action === 'delete') {
    const ok = await window.packprice.confirm({
      titulo: 'Eliminar presupuesto',
      mensaje: `¿Eliminar el presupuesto ${id}?`,
      detalle: 'Esta acción no se puede deshacer.',
      botones: ['Eliminar', 'Cancelar'],
      defaultId: 1
    });
    if (ok !== 0) return;
    await window.packprice.deleteQuote(id);
    await refreshHistory();
    return;
  }
  if (action === 'open') {
    const r = await window.packprice.getQuote(id);
    if (!r || !r.ok || !r.quote) return;
    const result = r.quote.result || r.quote;
    lastResult = result;

    // Restore the pack context the result was computed under. The
    // result carries `pack_id`; fall back to the stored draft field.
    const packId = result.pack_id || r.quote.pack_id || null;
    state.packId = packId;

    // Guard: if the pack was renamed/removed from the config, the
    // result still renders (it is self-contained) but option/composition
    // lookups would fail. Warn instead of crashing.
    if (packId && !CFG.packs[packId]) {
      await window.packprice.showInfo({
        titulo: 'Pack no encontrado',
        mensaje: `El pack original ("${packId}") ya no existe en la configuración actual. Se muestra el presupuesto guardado, pero no podrás editarlo como pedido nuevo.`
      });
    }

    closeHistory();
    try {
      renderResult(result);
      goToScreen('resultado');
    } catch (err) {
      await window.packprice.showError({
        titulo: 'No se pudo reabrir',
        mensaje: 'El presupuesto guardado no es compatible con la versión actual.',
        detalle: err.message || String(err)
      });
      return;
    }
    return;
  }
  if (action === 'pdf') {
    const r = await window.packprice.getQuote(id);
    if (!r || !r.ok || !r.quote) return;
    const out = await window.packprice.exportPdf({
      quote: r.quote,
      company: CFG && CFG.company,
      quote_settings: CFG && CFG.quote_settings,
      defaultName: `${r.quote.id}.pdf`
    });
    if (out && out.cancelado) return;
    if (!out || !out.ok) {
      await window.packprice.showError({
        titulo: 'Error al exportar',
        mensaje: (out && out.error) || 'Error desconocido'
      });
      return;
    }
    await window.packprice.showInfo({
      titulo: 'PDF exportado',
      mensaje: `Guardado en:\n${out.ruta}`
    });
  }
}

// ============================================================
// Client fields (paso 3) — obligatory, inline validation (§2.7)
// ============================================================

/** Shows the inline error under a field and marks the input invalid. */
function showFieldError(fieldId) {
  const errEl = el(`${fieldId}-error`);
  const input = el(fieldId);
  if (errEl) errEl.classList.remove('hidden');
  if (input) input.classList.add('input--error');
}

/** Clears a field's inline error. */
function clearFieldError(fieldId) {
  const errEl = el(`${fieldId}-error`);
  const input = el(fieldId);
  if (errEl) errEl.classList.add('hidden');
  if (input) input.classList.remove('input--error');
}

/**
 * Reads + validates the client fields. Both are obligatory (§2.7) with
 * inline errors (never a final alert). Returns the trimmed values, or
 * null when invalid (and focuses the first offending field).
 */
function collectClientOrInvalid() {
  const nombre = (el('cliente-nombre').value || '').trim();
  const telefono = (el('cliente-telefono').value || '').trim();
  clearFieldError('cliente-nombre');
  clearFieldError('cliente-telefono');

  let firstBad = null;
  if (!nombre) { showFieldError('cliente-nombre'); firstBad = firstBad || 'cliente-nombre'; }
  if (!telefono) { showFieldError('cliente-telefono'); firstBad = firstBad || 'cliente-telefono'; }
  if (firstBad) {
    const input = el(firstBad);
    if (input) input.focus();
    return null;
  }
  return { name: nombre, phone: telefono };
}

/**
 * Validity date for a quote = its date + quote_settings.validity_days
 * (default 15). Read from CFG (no domain number in code). Returns an ISO
 * string, or null when the base date is unusable.
 */
function computeValidUntil(dateIso) {
  const base = dateIso ? new Date(dateIso) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  const days = (CFG && CFG.quote_settings && Number.isFinite(CFG.quote_settings.validity_days))
    ? CFG.quote_settings.validity_days
    : 15;
  const out = new Date(base.getTime());
  out.setDate(out.getDate() + days);
  return out.toISOString();
}

/** dd/mm/aaaa for the "válido hasta" hint (local). */
function formatValidDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Builds the normalized cloud quote row from the calc result + client
 * data (Task 5C item 2). Mirrors db/migrations/0001_init.sql columns;
 * lib/cloud-quotes.buildQuoteRows tolerates missing optional fields. The
 * id is a fresh client UUID so re-uploads from the outbox are idempotent.
 *
 * pvp_deviation_pct = (applied − recommended)/recommended, computed only
 * for a single-unit-price pack where a recommended PVP exists; else null.
 */
function buildCloudQuote(result, client, ts) {
  const tierId = tierIdFromLabel(result.tier);
  const items = collectQuoteItems(result);
  const addons = Object.entries(result.extras_detail || {})
    .filter(([, qty]) => qty > 0)
    .map(([addon_id, qty]) => ({ addon_id, qty }));

  return {
    id: crypto.randomUUID(),
    ts,
    user: (SETTINGS && SETTINGS.user_name) || 'Equipo',
    client_name: client.name,
    client_phone: client.phone,
    valid_until: computeValidUntil(ts),
    pack_id: result.pack_id || state.packId || null,
    tier: tierId,
    total_units: result.total_quantity || 0,
    qty_3xl: result.qty_3xl || 0,
    qty_4xl: result.qty_4xl || 0,
    qty_5xl: result.qty_5xl || 0,
    total_vat_inc: result.total_vat_inc ?? null,
    sale_base: result.sale_base ?? null,
    margin_pct: result.margin_pct ?? null,
    target_margin: targetMarginFor(result),
    pvp_deviation_pct: computePvpDeviation(result),
    catalog_version: (DATA_STATE && DATA_STATE.catalogVersion) || (CFG && CFG.version) || null,
    items,
    addons
  };
}

/** Per-quote target margin: the pack's own, else the global default. */
function targetMarginFor(result) {
  const pack = CFG && CFG.packs && CFG.packs[result.pack_id || state.packId];
  if (pack && Number.isFinite(pack.target_margin)) return pack.target_margin;
  const def = CFG && CFG.parameters && CFG.parameters.default_target_margin;
  return Number.isFinite(def) ? def : null;
}

/**
 * Line items [{product_id, sides, qty}] from the result breakdown. For a
 * bundle pack the breakdown row carries the component composition; for a
 * components pack each row IS a product line. `sides` reads from the row.
 */
function collectQuoteItems(result) {
  const items = [];
  const breakdown = Array.isArray(result.breakdown) ? result.breakdown : [];
  if (result.pricing_mode === 'bundle') {
    const top = breakdown[0];
    const sides = top ? top.sides : 1;
    for (const c of (top && Array.isArray(top.components) ? top.components : [])) {
      items.push({ product_id: c.model, sides, qty: c.quantity });
    }
  } else {
    for (const d of breakdown) {
      if (!d.quantity) continue;
      items.push({ product_id: d.model, sides: d.sides, qty: d.quantity });
    }
  }
  return items;
}

/**
 * pvp_deviation_pct: how far the applied unit PVP sits from the engine's
 * recommended PVP. Only computable for a pack with a single top-level
 * unit_price (bundle, or a single-component pack); multi-line packs have
 * no single comparable price → null.
 */
function computePvpDeviation(result) {
  const applied = result.unit_price;
  if (!Number.isFinite(applied) || applied <= 0) return null;
  // Recommended PVP is computed on the ex-VAT cost basis; the engine's
  // applied unit_price is VAT-included for bundle/components, so compare
  // on the same (ex-VAT) basis using the order's average unit cost.
  const total = result.total_quantity || 0;
  if (total <= 0 || !Number.isFinite(result.total_cost)) return null;
  const vat = (CFG && CFG.parameters && CFG.parameters.vat) || 0;
  const appliedExVat = applied / (1 + vat);
  const costPerUnit = result.total_cost / total;
  const rec = recommendedPrice(CFG, costPerUnit, targetMarginFor(result));
  if (!rec || !Number.isFinite(rec.price) || rec.price <= 0) return null;
  return (appliedExVat - rec.price) / rec.price;
}

/**
 * Persists the current quote: local history is the source of truth
 * (always), and in cloud mode the normalized row is also uploaded to D1
 * (enqueued offline). The cloud UUID is stored on the local entry so a
 * later status change targets the same cloud row. Returns the saved
 * local quote, or null on failure (errors already surfaced).
 */
async function persistCurrentQuote(client) {
  const ts = new Date().toISOString();
  const cloud = isCloudMode() ? buildCloudQuote(lastResult, client, ts) : null;

  const draft = buildQuoteDraft(lastResult, {
    user: SETTINGS.user_name,
    configVersion: CFG && CFG.version,
    packId: state.packId,
    customer: { name: client.name, phone: client.phone }
  });
  draft.valid_until = computeValidUntil(ts);
  draft.status = 'pending';
  if (cloud) draft.cloud_id = cloud.id;

  const r = await window.packprice.saveQuote(draft);
  if (!r || !r.ok) {
    await window.packprice.showError({
      titulo: 'No se pudo guardar',
      mensaje: (r && r.error) || 'Error desconocido'
    });
    return null;
  }

  // Cloud upload is best-effort: it no-ops in file mode and enqueues
  // when offline. A hard failure is surfaced as a toast (the local save
  // already succeeded — we never lose the quote).
  if (cloud) {
    try {
      const up = await window.packprice.uploadQuote({ quote: cloud });
      if (up && up.queued) showToast('Guardado · se subirá al reconectar');
      else if (!up || (!up.ok && !up.skipped)) showToast('Guardado local · la nube falló');
    } catch (_) {
      showToast('Guardado local · la nube falló');
    }
  }
  return r.quote;
}

async function saveCurrentQuote() {
  if (!lastResult) {
    await window.packprice.showError({
      titulo: 'Nada que guardar',
      mensaje: 'Calcula un presupuesto antes de guardarlo.'
    });
    return;
  }
  const client = collectClientOrInvalid();
  if (!client) return; // inline errors already shown

  const saved = await persistCurrentQuote(client);
  if (!saved) return;
  lastResult = saved;
  await window.packprice.showInfo({
    titulo: 'Presupuesto guardado',
    mensaje: `Asignado el ID ${saved.id}.`,
    detalle: 'Disponible en el botón “Historial” del menú superior.'
  });
}

async function exportQuotePdf() {
  if (!lastResult) {
    await window.packprice.showError({
      titulo: 'Nada que exportar',
      mensaje: 'Calcula un presupuesto antes de exportarlo.'
    });
    return;
  }

  // The PDF needs a quote object with id + date. If the user hasn't
  // saved it yet, persist it now (validating the client fields first) so
  // the PDF and the history are consistent (same id printed + stored).
  let quote;
  if (lastResult.id && lastResult.date) {
    quote = lastResult;
  } else {
    const client = collectClientOrInvalid();
    if (!client) return; // inline errors already shown
    const saved = await persistCurrentQuote(client);
    if (!saved) return;
    quote = saved;
    // Replace lastResult so subsequent clicks reuse the saved id.
    lastResult = quote;
  }

  const r = await window.packprice.exportPdf({
    quote,
    company: CFG && CFG.company,
    quote_settings: CFG && CFG.quote_settings,
    defaultName: `${quote.id}.pdf`
  });
  if (r && r.cancelado) return;
  if (!r || !r.ok) {
    await window.packprice.showError({
      titulo: 'Error al exportar',
      mensaje: (r && r.error) || 'Error desconocido'
    });
    return;
  }
  await window.packprice.showInfo({
    titulo: 'PDF exportado',
    mensaje: `Guardado en:\n${r.ruta}`
  });
}

// ============================================================
// History status chips (UI-UX §2.7)
// ============================================================

/**
 * Changes a quote's status from a history chip: updates the local entry
 * (source of truth) and, in cloud mode, mirrors it to D1 via the entry's
 * cloud UUID (enqueued offline). Offers undo via toast. File mode skips
 * the cloud call but still stores the status locally.
 */
async function changeQuoteStatus(localId, status) {
  const r = await window.packprice.getQuote(localId);
  const quote = r && r.ok ? r.quote : null;
  if (!quote) return;
  const prev = quote.status || 'pending';
  if (prev === status) return;

  await applyQuoteStatus(quote, status);
  await refreshHistory();

  // Undo: a single toast action restores the previous status (local +
  // cloud), so a misclick at the counter is one tap to fix.
  showStatusToast(statusToastText(status), async () => {
    const cur = await window.packprice.getQuote(localId);
    if (cur && cur.ok && cur.quote) {
      await applyQuoteStatus(cur.quote, prev);
      await refreshHistory();
    }
  });
}

/** Writes a status to the local entry and (cloud mode) to D1. */
async function applyQuoteStatus(quote, status) {
  await window.packprice.updateQuote({
    id: quote.id,
    patch: { status, status_ts: new Date().toISOString() }
  });
  // Cloud mirror: target the stored cloud UUID. In file mode the IPC
  // no-ops ({ ok:true, skipped:true }); offline it enqueues.
  if (isCloudMode() && quote.cloud_id) {
    try {
      await window.packprice.setQuoteStatus({ id: quote.cloud_id, status });
    } catch (_) { /* surfaced via the offline queue; local already saved */ }
  }
}

function statusToastText(status) {
  if (status === 'accepted') return 'Marcado como aceptado';
  if (status === 'rejected') return 'Marcado como rechazado';
  return 'Marcado como pendiente';
}

/**
 * Syncs the client card to the result being shown: prefills name/phone
 * from a reopened saved quote (else leaves the user's entry), clears any
 * inline error, and shows the "válido hasta dd/mm/aaaa" hint computed
 * from the quote's date (or now) + quote_settings.validity_days.
 */
function syncClientCard(r) {
  const nombre = el('cliente-nombre');
  const telefono = el('cliente-telefono');
  if (!nombre || !telefono) return;
  clearFieldError('cliente-nombre');
  clearFieldError('cliente-telefono');

  // Prefill only when reopening a stored quote (it carries customer{}).
  const customer = r && r.customer;
  if (customer && (customer.name || customer.phone)) {
    nombre.value = customer.name || '';
    telefono.value = customer.phone || '';
  }

  const hint = el('cliente-validez');
  if (hint) {
    const baseDate = (r && r.date) || new Date().toISOString();
    const validUntil = (r && r.valid_until) || computeValidUntil(baseDate);
    const formatted = formatValidDate(validUntil);
    hint.textContent = formatted ? `Presupuesto válido hasta ${formatted}.` : '';
  }
}

// ============================================================
// Startup quote reminder (UI-UX §2.7)
// ============================================================

/** localStorage key for "reminder dismissed on this date" (per day). */
const REMINDER_DISMISS_KEY = 'pp:reminder-dismissed';

/** Today's date as YYYY-MM-DD (local) — the dismiss granularity. */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Hides the banner and remembers the dismissal for the rest of the day. */
function dismissReminder() {
  hide('quote-reminder');
  try { localStorage.setItem(REMINDER_DISMISS_KEY, todayKey()); } catch (_) {}
}

/**
 * On startup, count quotes that need attention and, if any, show the
 * discreet banner — unless already dismissed today. Never blocks: it is
 * a reminder, not a task (§2.7). Reads the local history (the per-PC
 * source of truth for status + validity).
 */
async function maybeShowReminder() {
  try {
    if (localStorage.getItem(REMINDER_DISMISS_KEY) === todayKey()) return;
  } catch (_) { /* localStorage unavailable: just proceed */ }

  let quotes = [];
  try {
    const r = await window.packprice.listQuotes();
    quotes = (r && r.ok && Array.isArray(r.quotes)) ? r.quotes : [];
  } catch (_) {
    return; // a reminder must never break boot
  }

  const { pendingOld, expiringSoon } = computeReminder(quotes, new Date().toISOString());
  if (pendingOld <= 0 && expiringSoon <= 0) return;

  const parts = [];
  if (pendingOld > 0) {
    parts.push(`${pendingOld} presupuesto${pendingOld === 1 ? '' : 's'} esperan respuesta`);
  }
  if (expiringSoon > 0) {
    parts.push(`${expiringSoon} caduca${expiringSoon === 1 ? '' : 'n'} esta semana`);
  }
  const textEl = el('quote-reminder-text');
  if (textEl) textEl.textContent = parts.join(' · ');
  show('quote-reminder');
}

// ============================================================
// Statistics screen (UI-UX §2.7)
// ============================================================

/** Toggles the stats screen on (hiding the calc steps) or off. */
function showStatsScreen(on) {
  const stats = el('seccion-estadisticas');
  const body = document.querySelector('.app-body');
  if (!stats) return;
  // Hide the three calc steps while stats is up; restore paso1 on close.
  ['seccion-paso1', 'seccion-paso2', 'seccion-resultado'].forEach(id => {
    const node = el(id);
    if (node) node.classList.toggle('hidden', on);
  });
  stats.classList.toggle('hidden', !on);
  if (body && typeof body.scrollTo === 'function') body.scrollTo({ top: 0 });
}

async function openStats() {
  showStatsScreen(true);
  // Default period highlights "Temporada".
  setActivePeriodButton(statsState.period);
  await loadStats();
}

function closeStats() {
  showStatsScreen(false);
  // Return to a sensible calc screen: the current pack's step, else step 1.
  if (state.packId && CFG.packs[state.packId]) {
    goToScreen('paso2');
  } else {
    goToScreen('paso1');
  }
}

function setActivePeriodButton(period) {
  document.querySelectorAll('#stats-period [data-period]').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.period === period);
  });
}

function onStatsPeriod(period) {
  statsState.period = period;
  setActivePeriodButton(period);
  // The custom range needs explicit dates: reveal the picker and wait for
  // "Aplicar"; the other periods load immediately.
  const rangeBox = el('stats-range');
  if (period === 'range') {
    if (rangeBox) rangeBox.classList.remove('hidden');
    return;
  }
  if (rangeBox) rangeBox.classList.add('hidden');
  loadStats();
}

/**
 * Loads + renders the statistics for the active period. File mode shows
 * the cloud-required note; offline shows the standard offline note; an
 * empty period shows the explanatory empty state (never zero charts).
 */
async function loadStats() {
  const body = el('stats-body');
  if (!body) return;

  if (!isCloudMode()) {
    body.innerHTML = statsCloudRequiredNote();
    return;
  }

  // Resolve the ISO range from the active period (+ the date inputs for
  // a custom range).
  const custom = { from: el('stats-from') && el('stats-from').value, to: el('stats-to') && el('stats-to').value };
  const range = rangeForPeriod(statsState.period, new Date(), custom);
  statsState.range = range;

  body.innerHTML = statsSkeleton();

  let r;
  try {
    r = await window.packprice.getStats({ from: range.from, to: range.to });
  } catch (_) {
    r = { ok: false, offline: true };
  }

  if (!r || !r.ok) {
    if (r && r.code === 'NOT_CLOUD') { body.innerHTML = statsCloudRequiredNote(); return; }
    body.innerHTML = statsOfflineNote();
    return;
  }

  const stats = r.stats || {};
  if (isEmptyStats(stats)) {
    body.innerHTML = statsEmptyNote();
    return;
  }
  renderStats(stats);
}

function statsCloudRequiredNote() {
  return `
    <div class="stats-note">
      <span class="stats-note__icon"><svg class="icon icon--lg"><use href="#i-layers"/></svg></span>
      <h3>Las estadísticas requieren modo nube</h3>
      <p class="text-secondary">
        En modo local cada equipo guarda su propio historial. Las estadísticas
        combinan los presupuestos de todos los equipos, que solo viven en la
        nube. Cambia a modo nube desde el primer arranque para verlas.
      </p>
    </div>
  `;
}

function statsOfflineNote() {
  return `
    <div class="stats-note">
      <span class="stats-note__icon"><svg class="icon icon--lg"><use href="#i-warn"/></svg></span>
      <h3>Sin conexión</h3>
      <p class="text-secondary">
        Las estadísticas se calculan en la nube y necesitan conexión.
        Comprueba tu red y vuelve a intentarlo.
      </p>
      <button class="btn btn-secondary" type="button" onclick="document.getElementById('btn-stats-apply')?.click()">
        <svg class="icon"><use href="#i-refresh"/></svg> Reintentar
      </button>
    </div>
  `;
}

function statsEmptyNote() {
  const label = STATS_PERIOD_LABELS[statsState.period] || 'el periodo elegido';
  return `
    <div class="stats-note">
      <span class="stats-note__icon"><svg class="icon icon--lg"><use href="#i-clipboard"/></svg></span>
      <h3>Sin presupuestos en ${escapeHTML(label)}</h3>
      <p class="text-secondary">
        No hay presupuestos guardados en este periodo, así que no hay nada que
        representar todavía. Prueba con un periodo más amplio.
      </p>
    </div>
  `;
}

function statsSkeleton() {
  const card = '<div class="stats-card stats-card--skeleton"><div class="skeleton-block"></div></div>';
  return `
    <div class="stats-kpis">
      ${Array.from({ length: 6 }).map(() => '<div class="kpi-tile kpi-tile--skeleton"></div>').join('')}
    </div>
    <div class="stats-grid">${card.repeat(8)}</div>
  `;
}

/** Reads the chart palette from the CSS pack-color tokens on :root. */
function chartColors() {
  const root = getComputedStyle(document.documentElement);
  const tokens = ['--pack-color-1', '--pack-color-2', '--pack-color-3',
                  '--pack-color-4', '--pack-color-5', '--pack-color-6'];
  const colors = tokens
    .map(t => root.getPropertyValue(t).trim())
    .filter(Boolean);
  // Fall back to the charts.js palette if tokens are unavailable.
  return colors.length ? colors : undefined;
}

/**
 * Renders the KPI tiles + the 8 charts (UI-UX §2.7). Each chart is a
 * card with a title and a «Ver como tabla» toggle (accessible table
 * alternative). Charts come from charts.js as SVG strings injected via
 * innerHTML (no scripts — CSP intact).
 */
function renderStats(stats) {
  const body = el('stats-body');
  const colors = chartColors();
  const W = 420, H = 240;

  const tiles = kpiTiles(stats).map(t => `
    <div class="kpi-tile ${t.good === true ? 'kpi-tile--good' : (t.good === false ? 'kpi-tile--warn' : '')}">
      <span class="kpi-tile__label">${escapeHTML(t.label)}</span>
      <strong class="kpi-tile__value text-mono">${escapeHTML(t.value)}</strong>
      ${t.sub ? `<span class="kpi-tile__sub">${escapeHTML(t.sub)}</span>` : ''}
    </div>
  `).join('');

  // Each chart card: { title, svg, table } — the table is the accessible
  // alternative, hidden until «Ver como tabla».
  const cards = [
    statChartCard('Presupuestos por pack',
      barChartH(packUsageBars(stats), { width: W, height: H, colors, desc: 'Total presupuestado por pack' }),
      barTable(packUsageBars(stats), 'Pack', 'Total')),
    statChartCard('Conversión por pack',
      groupedBars(conversionGroups(stats), { width: W, height: H, colors, desc: 'Conversión por pack' }),
      groupTable(conversionGroups(stats), 'Pack')),
    statChartCard('Evolución semanal',
      lineChart(weeklySeries(stats), { width: W, height: H, colors, desc: 'Presupuestado vs aceptado por semana' }),
      seriesTable(weeklySeries(stats), stats.weekly, 'Semana')),
    statChartCard('Distribución por tramo',
      barChartV(tierBars(stats), { width: W, height: H, colors, desc: 'Presupuestos por tramo' }),
      barTable(tierBars(stats), 'Tramo', 'Presupuestos')),
    statChartCard('Margen real vs objetivo',
      groupedBars(marginGroups(stats), { width: W, height: H, colors, desc: 'Margen real vs objetivo por pack' }),
      groupTable(marginGroups(stats), 'Pack')),
    statChartCard('Desviación sobre PVP recomendado',
      histogram(deviationBuckets(stats), { width: W, height: H, desc: 'Desviación sobre el PVP recomendado' }),
      bucketTable(deviationBuckets(stats))),
    statChartCard('Top productos',
      barChartH(topProductBars(stats), { width: W, height: H, colors, desc: 'Productos más pedidos' }),
      barTable(topProductBars(stats), 'Producto', 'Unidades')),
    statChartCard('Top complementos',
      barChartH(topAddonBars(stats), { width: W, height: H, colors, desc: 'Complementos más pedidos' }),
      barTable(topAddonBars(stats), 'Complemento', 'Unidades')),
    statChartCard('Tallas especiales',
      barChartV(specialSizeBars(stats), { width: W, height: H, colors, desc: 'Tallas especiales por pack' }),
      barTable(specialSizeBars(stats), 'Talla', 'Unidades'))
  ].join('');

  body.innerHTML = `
    <div class="stats-kpis">${tiles}</div>
    <div class="stats-grid">${cards}</div>
  `;

  // Wire each «Ver como tabla» toggle (event delegation).
  body.querySelectorAll('[data-action="toggle-table"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.stats-card');
      if (!card) return;
      const table = card.querySelector('.stats-card__table');
      const chart = card.querySelector('.stats-card__chart');
      const showing = table.classList.toggle('hidden');
      chart.classList.toggle('hidden', !showing);
      btn.textContent = showing ? 'Ver como tabla' : 'Ver como gráfico';
    });
  });
}

/** One chart card: title, the SVG, a hidden accessible table + toggle. */
function statChartCard(title, svg, tableHtml) {
  return `
    <div class="stats-card">
      <div class="stats-card__head">
        <h3 class="h-card">${escapeHTML(title)}</h3>
        <button type="button" class="btn btn-ghost btn-sm" data-action="toggle-table">Ver como tabla</button>
      </div>
      <div class="stats-card__chart">${svg}</div>
      <div class="stats-card__table hidden">${tableHtml}</div>
    </div>
  `;
}

// --- accessible table builders (mirror the chart inputs) ---

function barTable(items, labelCol, valueCol) {
  if (!items || items.length === 0) return '<p class="hint">Sin datos.</p>';
  const rows = items.map(it => `
    <tr><td>${escapeHTML(it.label)}</td><td class="num text-mono">${escapeHTML(it.value)}</td></tr>
  `).join('');
  return `<table class="stats-table"><thead><tr><th>${escapeHTML(labelCol)}</th><th class="num">${escapeHTML(valueCol)}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function groupTable(groups, labelCol) {
  if (!groups || groups.length === 0) return '<p class="hint">Sin datos.</p>';
  const names = (groups[0] && groups[0].bars ? groups[0].bars : []).map(b => b.name);
  const head = `<th>${escapeHTML(labelCol)}</th>` + names.map(n => `<th class="num">${escapeHTML(n)}</th>`).join('');
  const rows = groups.map(g => {
    const cells = (g.bars || []).map(b => `<td class="num text-mono">${escapeHTML(b.value)}</td>`).join('');
    return `<tr><td>${escapeHTML(g.label)}</td>${cells}</tr>`;
  }).join('');
  return `<table class="stats-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function seriesTable(series, weekly, labelCol) {
  const rows = (weekly || []).map(w => `
    <tr><td>${escapeHTML(w.weekIso)}</td><td class="num text-mono">${escapeHTML(w.quoted)}</td><td class="num text-mono">${escapeHTML(w.accepted)}</td></tr>
  `).join('');
  if (!rows) return '<p class="hint">Sin datos.</p>';
  return `<table class="stats-table"><thead><tr><th>${escapeHTML(labelCol)}</th><th class="num">Presupuestado</th><th class="num">Aceptado</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function bucketTable(buckets) {
  if (!buckets || buckets.length === 0) return '<p class="hint">Sin datos.</p>';
  const rows = buckets.map(b => `
    <tr><td>${escapeHTML(b.label)}</td><td class="num text-mono">${escapeHTML(b.count)}</td></tr>
  `).join('');
  return `<table class="stats-table"><thead><tr><th>Desviación</th><th class="num">Presupuestos</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ============================================================
// Local settings modal
// ============================================================

// Strips a trailing config.js (any separator) so a stored config path
// displays as its folder. No path module in the renderer; the regex
// handles both "\" and "/" and leaves a non-.js value untouched.
function configFolderDisplay(p) {
  if (!p) return '';
  return p.replace(/[\\/][^\\/]*\.js$/i, '');
}

function openSettings() {
  el('aj-nombre').value = SETTINGS.user_name || '';
  // Show the folder (strip the trailing config.js) — the field is now a
  // folder, consistent with the wizard and the folder picker.
  el('aj-ruta').value = configFolderDisplay(SETTINGS.config_path);
  // Toggles: local persistence in localStorage as a placeholder
  // until there is an official field in settings.json (see PLAN_UI §9).
  const remember = localStorage.getItem('pp:recordar-pack') === '1';
  const showVat = localStorage.getItem('pp:mostrar-iva') !== '0'; // default yes
  const tRemember = el('aj-recordar-pack');
  const tVat = el('aj-mostrar-iva');
  if (tRemember) tRemember.checked = remember;
  if (tVat) tVat.checked = showVat;
  show('ajustes-overlay');

  // Plan 7B: load the Privacy + Updates toggles from settings (both
  // opt-out, default ON). The update result line starts empty.
  loadPrivacyAndUpdatesSection();

  // Plan 6: load the PDF template gallery + preview every time the modal
  // opens so it reflects the latest CFG.company + cloud custom templates.
  loadPdfTemplateSection();
}

// ============================================================
// Settings · Updates + Privacy (Plan 7B · UI-UX §2.6 · PRD R15/R17/R19)
// ============================================================

/**
 * Loads the two opt-out toggles (error reports + check-on-start) into the
 * settings modal. The error-report toggle is read via its dedicated IPC
 * (main applies the default); the update toggle reads from SETTINGS. A
 * read failure leaves the default-checked boxes alone (both default ON).
 */
async function loadPrivacyAndUpdatesSection() {
  // Reset the inline update result each time the modal opens.
  const result = el('aj-update-result');
  if (result) { result.textContent = ''; result.innerHTML = ''; }

  // Check-updates-on-start: default ON unless explicitly false in settings.
  const checkUpdates = el('aj-check-updates');
  if (checkUpdates) {
    checkUpdates.checked = !(SETTINGS && SETTINGS.check_updates_on_start === false);
  }

  // Error reports: read the resolved value from main (it applies the
  // default when the field is absent). On failure keep the box ON.
  const errorReports = el('aj-error-reports');
  if (errorReports) {
    try {
      const r = await window.packprice.getErrorReportsEnabled();
      errorReports.checked = !(r && r.ok && r.enabled === false);
    } catch (_) {
      errorReports.checked = true;
    }
  }
}

/**
 * Manual «Buscar ahora»: asks main to check GitHub for a newer release
 * and renders the result inline. Unlike the boot check, errors here ARE
 * shown (the user asked). A newer version offers a Descargar link that
 * opens the release page via openExternal (no auto-install).
 */
async function checkForUpdateNow() {
  const btn = el('btn-aj-buscar-update');
  const result = el('aj-update-result');
  if (!btn || !result) return;

  btn.dataset.label = btn.dataset.label || btn.innerHTML;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Buscando…';
  result.textContent = '';
  try {
    // Just triggers the check; applyUpdateState paints the result and
    // re-enables the button when a terminal phase event arrives.
    await window.packprice.checkAppUpdate();
  } catch (_) {
    result.textContent = 'No se pudo comprobar. Revisa tu conexión e inténtalo de nuevo.';
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label;
    btn.dataset.busy = '';
  }
}

/**
 * Single source of truth for painting update progress, driven by the
 * `update:state` events from main. Updates both the settings inline area
 * (when the modal is open) and the top banner.
 */
function applyUpdateState(state) {
  const phase = state && state.phase;

  // 1) Settings inline result (only present while the modal is open).
  const result = el('aj-update-result');
  if (result) {
    if (phase === 'checking') {
      result.textContent = 'Buscando…';
    } else if (phase === 'downloading') {
      result.textContent = typeof state.percent === 'number'
        ? `Descargando actualización… ${state.percent}%`
        : 'Descargando actualización…';
    } else if (phase === 'ready') {
      result.textContent = `Versión ${state.version || ''} lista. Se instalará al cerrar la app.`;
    } else if (phase === 'idle') {
      result.textContent = 'Estás en la última versión.';
    } else if (phase === 'error') {
      result.textContent = 'No se pudo comprobar. Revisa tu conexión e inténtalo de nuevo.';
    } else if (phase === 'dev') {
      result.textContent = 'Las actualizaciones automáticas solo están disponibles en la app instalada.';
    }
  }

  // Re-enable the manual «Buscar ahora» button on any terminal phase.
  if (phase === 'idle' || phase === 'ready' || phase === 'error' || phase === 'dev') {
    const btn = el('btn-aj-buscar-update');
    if (btn && btn.dataset.busy === '1') {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.label || 'Buscar ahora';
      btn.dataset.busy = '';
    }
  }

  // 2) Top banner: show during download and when ready; the restart button
  // appears only when an update is downloaded and ready to install.
  const textEl = el('update-banner-text');
  const restartBtn = el('btn-update-restart');
  if (phase === 'downloading') {
    if (textEl) {
      textEl.textContent = typeof state.percent === 'number'
        ? `Descargando versión ${state.version || ''}… ${state.percent}%`
        : 'Descargando actualización…';
    }
    if (restartBtn) restartBtn.classList.add('hidden');
    show('update-banner');
  } else if (phase === 'ready') {
    if (textEl) textEl.textContent = `Versión ${state.version || ''} lista`;
    if (restartBtn) restartBtn.classList.remove('hidden');
    show('update-banner');
  }
  // checking / idle / error / dev: leave the banner as-is (boot stays silent).
}

/**
 * Persists the «Buscar actualizaciones al iniciar» toggle to settings.
 * Per-PC; immediate so «Cancelar» can't revert it. Keeps the in-memory
 * SETTINGS in sync so the boot check reflects the latest choice next run.
 */
async function onCheckUpdatesToggle() {
  const checked = el('aj-check-updates').checked;
  try {
    await window.packprice.writeSettings({ check_updates_on_start: checked });
    SETTINGS = { ...(SETTINGS || {}), check_updates_on_start: checked };
  } catch (_) {
    // A persistence failure is non-fatal; the box already reflects intent.
    showToast('No se pudo guardar la preferencia');
  }
}

/**
 * Persists the «Enviar informes de error» opt-out toggle via its
 * dedicated IPC (the secret never crosses; main validates + defaults).
 * Immediate, like the update toggle.
 */
async function onErrorReportsToggle() {
  const checked = el('aj-error-reports').checked;
  try {
    const r = await window.packprice.setErrorReportsEnabled(checked);
    if (!r || !r.ok) showToast('No se pudo guardar la preferencia');
  } catch (_) {
    showToast('No se pudo guardar la preferencia');
  }
}

/**
 * «Exportar diagnóstico»: main builds the support bundle (no token, no
 * business data), asks where to save it and opens it. We report where it
 * landed (toast) or the error; a user cancel is silent.
 */
async function exportDiagnostics() {
  const btn = el('btn-aj-diagnostico');
  const original = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generando…';
  }
  try {
    const r = await window.packprice.exportDiagnostics();
    if (r && r.ok) {
      showToast('Diagnóstico guardado');
    } else if (r && r.cancelado) {
      // The user cancelled the save dialog — say nothing.
    } else {
      await window.packprice.showError({
        titulo: 'No se pudo exportar el diagnóstico',
        mensaje: (r && r.error) || 'Error desconocido al generar el diagnóstico.'
      });
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}

/**
 * Boot-time update check (PRD R15). Runs only when «Buscar actualizaciones
 * al iniciar» is on; non-blocking; network errors are swallowed silently
 * (only the manual «Buscar ahora» surfaces them). Shows a dismissible
 * notice only when a strictly newer release exists.
 */
async function maybeCheckForUpdate() {
  if (SETTINGS && SETTINGS.check_updates_on_start === false) return;
  // Just trigger it; results arrive via update:state → applyUpdateState,
  // which only surfaces the banner for downloading/ready. A failed check
  // is swallowed silently on boot.
  try { await window.packprice.checkAppUpdate(); } catch (_) {}
}

// ============================================================
// Settings · PDF template gallery + preview + brand color (Plan 6)
// ============================================================

/** The default brand color (mirrors lib/pdf-templates.APP_ACCENT). */
const PDF_BRAND_DEFAULT = '#3D7BD9';

/**
 * Loads the template list (built-ins + cloud custom) over IPC and paints
 * the gallery, the brand-color input and the first preview. The renderer
 * can't require the templates module (CommonJS, no build), so everything
 * comes from main.
 */
async function loadPdfTemplateSection() {
  const company = (CFG && CFG.company) || {};
  // Brand color input reflects the stored value (or the app default).
  const brandInput = el('aj-brand-color');
  if (brandInput) brandInput.value = normalizeBrandColor(company.brand_color);

  // Custom-template controls depend on the storage mode.
  const addBtn = el('btn-aj-tpl-add');
  const note = el('aj-tpl-custom-note');
  const cloud = isCloudMode();
  if (addBtn) addBtn.classList.toggle('hidden', !cloud);
  if (note) note.classList.toggle('hidden', cloud);
  // Always start with the add form collapsed.
  const addForm = el('aj-tpl-add-form');
  if (addForm) addForm.classList.add('hidden');

  let res;
  try {
    res = await window.packprice.listPdfTemplatesAll();
  } catch (_) {
    res = null;
  }
  const templates = (res && res.templates) || [{ id: 'clasica', name: 'Clásica' }];
  pdfTpl = {
    templates,
    builtinIds: new Set((res && res.builtinIds) || templates.map((t) => t.id)),
    cloud: !!(res && res.cloud),
    selectedId: null
  };

  renderPdfTemplateGallery();
  await refreshPdfPreview();
}

/** Normalizes a stored brand color to a #RRGGBB for the color input. */
function normalizeBrandColor(hex) {
  if (typeof hex !== 'string') return PDF_BRAND_DEFAULT;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return PDF_BRAND_DEFAULT;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h.toLowerCase();
}

/** Renders the gallery cards from the loaded list + current selection. */
function renderPdfTemplateGallery() {
  const gallery = el('aj-tpl-gallery');
  if (!gallery) return;

  const company = (CFG && CFG.company) || {};
  const model = buildGalleryModel(pdfTpl.templates, company.pdf_template, {
    defaultId: 'clasica',
    builtinIds: pdfTpl.builtinIds
  });
  pdfTpl.selectedId = model.selectedId;

  gallery.innerHTML = model.cards.map((c) => `
    <button type="button" class="pdf-tpl-card${c.isSelected ? ' is-selected' : ''}"
            role="radio" aria-checked="${c.isSelected ? 'true' : 'false'}"
            data-tpl-id="${escAttr(c.id)}">
      <span class="pdf-tpl-card__check"><svg class="icon"><use href="#i-check"/></svg></span>
      <span class="pdf-tpl-card__name">${escapeHTML(c.name)}</span>
      <span class="pdf-tpl-card__tag">${c.isBuiltin ? 'Integrada' : 'Personalizada'}</span>
    </button>
  `).join('');

  gallery.querySelectorAll('.pdf-tpl-card').forEach((card) => {
    card.addEventListener('click', () => selectPdfTemplate(card.dataset.tplId));
  });
}

/**
 * Selects a template: update CFG.company, repaint the gallery + preview,
 * then persist the choice to shared data (cloud: saveCatalog; file:
 * config write). Persistence failures surface but never block the live
 * preview, which already reflects the choice.
 */
async function selectPdfTemplate(id) {
  if (!id || id === pdfTpl.selectedId) return;
  if (!CFG.company) CFG.company = {};
  CFG.company.pdf_template = id;
  pdfTpl.selectedId = id;
  renderPdfTemplateGallery();
  await refreshPdfPreview();
  await persistCompanyField();
}

/** Brand-color change: update CFG.company, refresh preview, persist. */
async function onBrandColorChange() {
  const value = normalizeBrandColor(el('aj-brand-color').value);
  if (!CFG.company) CFG.company = {};
  CFG.company.brand_color = value;
  await refreshPdfPreview();
  await persistCompanyField();
}

// Monotonic token for the preview: rapid card clicks issue overlapping
// pdf:preview IPC, and a slower EARLIER response could otherwise overwrite a
// newer srcdoc. Each call captures its seq before the await and only writes
// the frame if it is still the latest in flight (latest-wins).
let pdfPreviewSeq = 0;

/**
 * Renders the demo-quote preview for the current selection + brand color
 * into the sandboxed iframe (srcdoc, no scripts). The HTML is built in
 * main (pdf:preview) — never injected into the renderer DOM.
 */
async function refreshPdfPreview() {
  const frame = el('aj-tpl-preview');
  if (!frame) return;
  const seq = ++pdfPreviewSeq; // this request's ticket
  const brandColor = normalizeBrandColor((CFG && CFG.company && CFG.company.brand_color) || el('aj-brand-color').value);
  let r;
  try {
    r = await window.packprice.previewPdfTemplate({
      templateId: pdfTpl.selectedId || 'clasica',
      brandColor
    });
  } catch (_) {
    r = null;
  }
  // Drop a stale response: a newer request started after us, so its (or a
  // later) result owns the frame — never let an earlier one clobber it.
  if (seq !== pdfPreviewSeq) return;
  // srcdoc + sandbox (no allow-scripts): the template HTML renders
  // isolated and inert, same-origin about:srcdoc under default-src 'self'.
  frame.srcdoc = (r && r.ok && r.html)
    ? r.html
    : '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;color:#888;padding:16px;">No se pudo generar la vista previa.</body>';
}

// Serializes persistCompanyField calls onto one in-flight chain. A
// template-then-color sequence fired before the first saveCatalog + reload
// completes would otherwise both read the SAME stale DATA_STATE.versions and
// the second would trip a false "otro equipo cambió" conflict on the user's
// OWN edit. By queueing, each persist awaits the previous (which reloads and
// updates DATA_STATE.versions) and only then reads the version baseline.
let companyPersistChain = Promise.resolve();

/**
 * Persists CFG.company (which carries pdf_template + brand_color) to shared
 * data, serialized so back-to-back edits never self-conflict. Returns when
 * THIS call has run (after any earlier queued persist). See companyPersistWorker.
 */
function persistCompanyField() {
  // Chain off the previous persist; swallow a prior rejection so one failure
  // doesn't break the chain for the next edit (errors are surfaced in-worker).
  const next = companyPersistChain.catch(() => {}).then(() => companyPersistWorker());
  companyPersistChain = next;
  return next;
}

/**
 * The actual persist. Cloud mode goes through the guarded saveCatalog with
 * the loaded version baseline read FRESH here (after any prior queued reload
 * updated DATA_STATE.versions); file mode writes the whole config. Both keep
 * CFG_BACKUP and DATA_STATE.versions coherent for any later catalog edit.
 * A discreet toast confirms; errors are shown plainly but don't revert
 * the in-memory choice (the preview already reflects it).
 */
async function companyPersistWorker() {
  if (isCloudMode()) {
    if (isOffline()) {
      // Editing shared data needs a live connection (UI-UX §2.2).
      showToast('Sin conexión: no se pudo guardar');
      return;
    }
    const r = await window.packprice.saveCatalog({
      newCfg: CFG,
      // Read FRESH at execution time: a prior queued persist's reload has
      // already updated DATA_STATE.versions by the time we run.
      expectedVersions: DATA_STATE.versions
    });
    if (r && r.ok) {
      if (typeof r.catalogVersion === 'number') DATA_STATE.catalogVersion = r.catalogVersion;
      // Pull fresh per-entity versions so a later save guards correctly.
      await reloadCloudCatalogQuietly();
      showToast('Plantilla guardada');
      return;
    }
    if (r && Array.isArray(r.conflicts) && r.conflicts.length > 0) {
      await window.packprice.showError({
        titulo: 'No se pudo guardar',
        mensaje: 'Otro equipo cambió los datos de la empresa. Vuelve a abrir Ajustes para ver lo último.'
      });
      return;
    }
    await window.packprice.showError({
      titulo: 'No se pudo guardar',
      mensaje: (r && r.error) || 'Error desconocido al guardar la plantilla.'
    });
    return;
  }

  // File mode: write the whole config (company carries the fields).
  CFG.updated_at = new Date().toLocaleString('es-ES');
  CFG.modified_by = SETTINGS.user_name;
  const r = await window.packprice.writeConfig({
    ruta: SETTINGS.config_path,
    configNuevo: CFG,
    infoEsperada: adminConfigInfoAtOpen
  });
  if (r && r.ok) {
    adminConfigInfoAtOpen = r.info;
    CFG_BACKUP = deepClone(CFG);
    showToast('Plantilla guardada');
    return;
  }
  await window.packprice.showError({
    titulo: 'No se pudo guardar',
    mensaje: (r && r.error) || 'No se pudo guardar la plantilla en el archivo de configuración.'
  });
}

/** Shows the custom-template import form (cloud mode). */
function openPdfTemplateAddForm() {
  el('aj-tpl-name').value = '';
  el('aj-tpl-html').value = '';
  hide('aj-tpl-add-error');
  el('aj-tpl-add-error').textContent = '';
  show('aj-tpl-add-form');
  el('aj-tpl-name').focus();
}

function closePdfTemplateAddForm() {
  hide('aj-tpl-add-form');
}

/**
 * Sends a custom HTML+CSS template to main, which sanitizes it and saves
 * it to the shared store. A sanitize rejection returns { ok:false, error
 * } with a plain Spanish message shown verbatim. On success the gallery
 * reloads (the new template appears) and it becomes the selection.
 */
async function savePdfTemplate() {
  const name = el('aj-tpl-name').value.trim();
  const html = el('aj-tpl-html').value;
  const errEl = el('aj-tpl-add-error');
  hide('aj-tpl-add-error');

  const saveBtn = el('btn-aj-tpl-add-save');
  const original = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span> Guardando…';
  try {
    const r = await window.packprice.savePdfTemplate({ name, html });
    if (!r || !r.ok) {
      // The sanitizer's Spanish message is user-facing; show it verbatim.
      errEl.textContent = (r && r.error) || 'No se pudo guardar la plantilla.';
      show('aj-tpl-add-error');
      return;
    }
    closePdfTemplateAddForm();
    // Reload the list so the new template shows, then select it.
    await loadPdfTemplateSection();
    await selectPdfTemplate(r.id);
    showToast('Plantilla añadida');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = original;
  }
}

function closeSettings() {
  hide('ajustes-overlay');
}

async function saveSettings() {
  const name = el('aj-nombre').value.trim();
  const folder = el('aj-ruta').value.trim();

  if (!name || !folder) {
    await window.packprice.showError({
      titulo: 'Datos incompletos',
      mensaje: 'Indica tu nombre y la carpeta de datos'
    });
    return;
  }

  // The field holds a folder; resolve it to <folder>/config.js in main
  // (idempotent — an already-resolved config.js path is left untouched).
  const resolved = await window.packprice.folderConfigPath(folder);
  if (!resolved || !resolved.ruta) {
    await window.packprice.showError({
      titulo: 'Carpeta no válida',
      mensaje: 'No se pudo resolver la carpeta seleccionada.'
    });
    return;
  }
  const filePath = resolved.ruta;

  if (filePath !== SETTINGS.config_path) {
    // Same contract as the wizard: reuse an existing config.js, or build a
    // fresh catalog through the first-run wizard if the folder has none.
    const res = await ensureConfigFileReady(name, filePath, (msg) => {
      window.packprice.showError({ titulo: 'No se pudo usar la carpeta', mensaje: msg });
    });
    if (!res.ready && !res.needsWizard) return;

    if (res.needsWizard) {
      // Empty folder: persist the new name/path, then build the catalog.
      await window.packprice.writeSettings({ user_name: name, config_path: filePath });
      SETTINGS = await window.packprice.readSettings();
      closeSettings();
      await startCatalogWizard({
        mode: 'file',
        userName: name,
        done: async (builtCfg) => {
          const created = await window.packprice.createConfig({
            ruta: filePath, config: builtCfg, modificadoPor: name
          });
          if (!created.ok) throw new Error(created.error || 'No se pudo crear el archivo.');
          hide('catalog-wizard');
          await loadConfigAndShowApp();
        }
      });
      return;
    }
  }

  // Toggles -> localStorage
  localStorage.setItem('pp:recordar-pack', el('aj-recordar-pack').checked ? '1' : '0');
  localStorage.setItem('pp:mostrar-iva',  el('aj-mostrar-iva').checked ? '1' : '0');

  await window.packprice.writeSettings({ user_name: name, config_path: filePath });
  // Re-read so SETTINGS keeps what only main merges (data_source, the
  // opt-out toggles, the redacted cloud section) instead of clobbering it
  // with just name + path.
  SETTINGS = await window.packprice.readSettings();
  closeSettings();
  await loadConfigAndShowApp();
}

// ============================================================
// Bootstrap
// ============================================================

document.addEventListener('DOMContentLoaded', bootstrap);
