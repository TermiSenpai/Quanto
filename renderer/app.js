// ============================================================
// PackPrice · Renderer (orchestration)
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
  executeAdminAction
} from './admin.js';
import {
  renderAuditTab,
  renderDiffPreview,
  renderLogsModal
} from './admin-extras.js';
import {
  renderHistoryList,
  buildQuoteDraft
} from './history.js';

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
let wizardCloud = { token: '', accounts: [], userName: '' };

const state = {
  packId: null,
  isAdmin: false,
  adminTab: 'parameters',
  showCosts: false      // secret shortcut: 3 × "." toggles the view
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
  audit:      { title: 'Auditoría',              desc: 'Quién cambió qué y cuándo, leído desde audit.log junto al config.' }
};

// ============================================================
// Bootstrap: decide which screen to show
// ============================================================

async function bootstrap() {
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
}

function showWelcome() {
  hide('pantalla-app');
  hide('pantalla-error');
  show('pantalla-bienvenida');

  el('btn-bv-explorar').addEventListener('click', async () => {
    const r = await window.packprice.selectConfigFile();
    if (!r.cancelado) {
      el('bv-ruta').value = r.ruta;
      validateWelcomeForm();
    }
  });

  el('bv-nombre').addEventListener('input', validateWelcomeForm);
  el('bv-ruta').addEventListener('input', validateWelcomeForm);
  el('btn-bv-empezar').addEventListener('click', startFirstTime);

  validateWelcomeForm();
  setTimeout(() => el('bv-nombre').focus(), 50);

  window.packprice.getDefaultConfigPath()
    .then((suggestion) => {
      const input = el('bv-ruta');
      if (!input.value && suggestion && suggestion.sugerida) {
        input.value = suggestion.sugerida;
        validateWelcomeForm();
      }
    })
    .catch(() => { /* do not block the UI for a suggestion */ });
}

function validateWelcomeForm() {
  const name = el('bv-nombre').value.trim();
  const filePath = el('bv-ruta').value.trim();
  el('btn-bv-empezar').disabled = !(name && filePath);
}

async function startFirstTime() {
  const name = el('bv-nombre').value.trim();
  const filePath = el('bv-ruta').value.trim();
  hide('bv-error');

  const btn = el('btn-bv-empezar');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Comprobando ruta…';
  try {
    await startFirstTimeImpl(name, filePath);
  } finally {
    btn.innerHTML = originalText;
    validateWelcomeForm();
  }
}

async function startFirstTimeImpl(name, filePath) {
  const exist = await window.packprice.configExists(filePath);
  if (!exist.existe) {
    if (!exist.escribible) {
      showWelcomeError(
        'No se puede crear el archivo en esa ruta. Comprueba que el NAS está accesible y tienes permisos de escritura.'
      );
      return;
    }
    const option = await window.packprice.confirm({
      titulo: 'Archivo no encontrado',
      mensaje: '¿Crear config.js con los valores por defecto?',
      detalle: `No se encontró un archivo de configuración en:\n${filePath}\n\nSe creará uno nuevo con los valores por defecto del plan.`,
      botones: ['Crear con valores por defecto', 'Cancelar'],
      defaultId: 0
    });
    if (option !== 0) return;

    const created = await window.packprice.createDefaultConfig({ ruta: filePath, modificadoPor: name });
    if (!created.ok) {
      showWelcomeError(`No se pudo crear el archivo: ${created.error}`);
      return;
    }
  } else {
    const r = await window.packprice.readConfig(filePath);
    if (!r.ok) {
      showWelcomeError(`No se pudo leer el archivo: ${r.error}`);
      return;
    }
  }

  SETTINGS = { config_path: filePath, user_name: name };
  const saved = await window.packprice.writeSettings(SETTINGS);
  if (!saved.ok) {
    showWelcomeError(`No se pudo guardar la configuración local: ${saved.error}`);
    return;
  }

  hide('pantalla-bienvenida');
  await loadConfigAndShowApp();
}

function showWelcomeError(message) {
  el('bv-error').textContent = message;
  show('bv-error');
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
    const r = await window.packprice.selectConfigFile();
    if (!r.cancelado) {
      el('wiz-ruta').value = r.ruta;
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
}

// --- Local branch -------------------------------------------------

function openWizardLocal() {
  showWizardView('wizard-local');
  hide('wiz-local-error');
  validateWizardLocalForm();
  // Suggest the NAS default path, same as the legacy welcome did.
  window.packprice.getDefaultConfigPath()
    .then((suggestion) => {
      const input = el('wiz-ruta');
      if (!input.value && suggestion && suggestion.sugerida) {
        input.value = suggestion.sugerida;
        validateWizardLocalForm();
      }
    })
    .catch(() => { /* a suggestion must never block the UI */ });
  setTimeout(() => el('wiz-nombre').focus(), 50);
}

function validateWizardLocalForm() {
  const name = el('wiz-nombre').value.trim();
  const filePath = el('wiz-ruta').value.trim();
  el('btn-wiz-local-empezar').disabled = !(name && filePath);
}

async function startWizardLocal() {
  const name = el('wiz-nombre').value.trim();
  const filePath = el('wiz-ruta').value.trim();
  hide('wiz-local-error');

  const btn = el('btn-wiz-local-empezar');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Comprobando ruta…';
  try {
    const ok = await ensureConfigFileReady(name, filePath, (msg) => {
      el('wiz-local-error').textContent = msg;
      show('wiz-local-error');
    });
    if (!ok) return;

    // Persist file mode explicitly (data_source: 'file') so a later
    // boot never re-shows the wizard.
    SETTINGS = { config_path: filePath, user_name: name, data_source: 'file' };
    const saved = await window.packprice.writeSettings(SETTINGS);
    if (!saved.ok) {
      el('wiz-local-error').textContent = `No se pudo guardar la configuración local: ${saved.error}`;
      show('wiz-local-error');
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
 * Shared file-mode setup helper: ensures the config exists (offering to
 * create it with defaults) or is readable, reporting plain errors via
 * `onError`. Returns true when the path is ready to use.
 */
async function ensureConfigFileReady(name, filePath, onError) {
  const exist = await window.packprice.configExists(filePath);
  if (!exist.existe) {
    if (!exist.escribible) {
      onError('No se puede crear el archivo en esa ruta. Comprueba que el NAS está accesible y tienes permisos de escritura.');
      return false;
    }
    const option = await window.packprice.confirm({
      titulo: 'Archivo no encontrado',
      mensaje: '¿Crear config.js con los valores por defecto?',
      detalle: `No se encontró un archivo de configuración en:\n${filePath}\n\nSe creará uno nuevo con los valores por defecto del plan.`,
      botones: ['Crear con valores por defecto', 'Cancelar'],
      defaultId: 0
    });
    if (option !== 0) return false;
    const created = await window.packprice.createDefaultConfig({ ruta: filePath, modificadoPor: name });
    if (!created.ok) {
      onError(`No se pudo crear el archivo: ${created.error}`);
      return false;
    }
    return true;
  }
  const r = await window.packprice.readConfig(filePath);
  if (!r.ok) {
    onError(`No se pudo leer el archivo: ${r.error}`);
    return false;
  }
  return true;
}

// --- Cloud branch -------------------------------------------------

function openWizardCloud() {
  wizardCloud = { token: '', accounts: [], userName: '' };
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
  const accounts = wizardCloud.accounts;
  const pick = el('cloud-account-pick');
  const progress = el('cloud-progress');

  if (accounts.length > 1) {
    const select = el('cloud-account');
    select.innerHTML = accounts
      .map(a => `<option value="${escAttr(a.id)}">${escapeHTML(a.name)}</option>`)
      .join('');
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

async function cloudProvision(accountIdArg) {
  hide('cloud-step3-error');
  el('cloud-account-pick').classList.add('hidden');
  const progress = el('cloud-progress');
  const msg = el('cloud-progress-msg');
  progress.classList.remove('hidden');
  msg.textContent = 'Buscando tu base de datos…';

  // The accountId comes from the picker (if shown) or the single
  // account resolved earlier. Guard against the click-event arg.
  const accountId = (typeof accountIdArg === 'string')
    ? accountIdArg
    : el('cloud-account').value || (wizardCloud.accounts[0] && wizardCloud.accounts[0].id);

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
  } finally {
    clearTimeout(creatingTimer);
  }

  if (!r || !r.ok) {
    progress.classList.add('hidden');
    el('cloud-step3-error').textContent = cloudProvisionError(r);
    show('cloud-step3-error');
    // Let the user retry: show the account picker again if there was a
    // choice, else a back-to-token path via the step-2 back button.
    if (wizardCloud.accounts.length > 1) {
      el('cloud-account-pick').classList.remove('hidden');
    }
    return;
  }

  msg.textContent = r.seeded ? 'Base creada — conectando…' : 'Encontrada — conectando…';

  // main has already persisted data_source: 'cloud' + the connection.
  // Re-read settings so SETTINGS reflects cloud mode, then boot.
  SETTINGS = await window.packprice.readSettings();
  hide('setup-wizard');
  await loadCloudAndShowApp();
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
  // Keep the relevant envelope fields for the indicator + banner.
  DATA_STATE = {
    source: r.source,
    catalogVersion: r.catalogVersion,
    fetchedAt: r.fetchedAt,
    offline: r.offline,
    reason: r.reason
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
    btnCreate.onclick = async () => {
      const option = await window.packprice.confirm({
        titulo: 'Crear config por defecto',
        mensaje: '¿Crear config.js con los valores por defecto?',
        detalle: `Ruta: ${SETTINGS.config_path}`,
        botones: ['Crear', 'Cancelar'],
        defaultId: 0
      });
      if (option !== 0) return;

      const created = await window.packprice.createDefaultConfig({
        ruta: SETTINGS.config_path,
        modificadoPor: SETTINGS.user_name
      });
      if (!created.ok) {
        await window.packprice.showError({
          titulo: 'Error',
          mensaje: 'No se pudo crear el archivo',
          detalle: created.error
        });
        return;
      }
      await loadConfigAndShowApp();
    };
  }

  el('btn-error-reintentar').onclick = async () => {
    await loadConfigAndShowApp();
  };
  el('btn-error-cambiar-ruta').onclick = async () => {
    const r = await window.packprice.selectConfigFile();
    if (!r.cancelado) {
      SETTINGS.config_path = r.ruta;
      await window.packprice.writeSettings(SETTINGS);
      await loadConfigAndShowApp();
    }
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

  renderPackList();

  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }
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

  el('btn-admin-toggle').addEventListener('click', openAdmin);
  el('btn-cerrar-admin').addEventListener('click', closeAdmin);
  el('btn-admin-login').addEventListener('click', adminLogin);
  el('admin-clave').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') adminLogin();
  });
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
    const r = await window.packprice.selectConfigFile();
    if (!r.cancelado) {
      el('aj-ruta').value = r.ruta;
    }
  });
  el('ajustes-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'ajustes-overlay') closeSettings();
  });

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
  const priceText = (r.pricing_mode === 'bundle')
    ? `${r.breakdown[0] ? r.breakdown[0].quantity : 0} packs × ${formatEur(r.unit_price)}`
    : (r.unit_price > 0 ? `${quantity} × ${formatEur(r.unit_price)}` : `${quantity} prendas`);
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
  const pricePerPack = isBundle
    ? formatEur(r.unit_price)
    : formatEur(r.subtotal / Math.max(1, quantity));
  const quantityLabel = isBundle ? 'Packs' : 'Prendas';
  const priceLabel = isBundle ? 'PVP por pack' : 'PVP medio';
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
  if (state.isAdmin) {
    await showAdminEditor();
  } else {
    show('admin-login');
    hide('admin-editor');
    setTimeout(() => el('admin-clave').focus(), 100);
  }
}

function closeAdmin() {
  hide('admin-overlay');
  hide('admin-login-error');
  el('admin-clave').value = '';
}

async function adminLogin() {
  const password = el('admin-clave').value;
  // The admin password never travels to the renderer: verification
  // happens in main (timing-safe). So DevTools cannot read the
  // password from the loaded CFG.
  const r = await window.packprice.verifyAdminPassword({
    ruta: SETTINGS.config_path,
    clave: password
  });
  if (r && r.ok && r.valida) {
    state.isAdmin = true;
    el('btn-admin-toggle').innerHTML = '<svg class="icon"><use href="#i-lock"/></svg> Admin activo';
    el('btn-admin-toggle').classList.remove('btn-secondary');
    el('btn-admin-toggle').classList.add('btn-primary');
    hide('admin-login-error');
    el('admin-clave').value = '';
    await showAdminEditor();
  } else {
    show('admin-login-error');
  }
}

async function showAdminEditor() {
  hide('admin-login');
  show('admin-editor');

  CFG_BACKUP = deepClone(CFG);
  adminConfigInfoAtOpen = await window.packprice.getConfigInfo(SETTINGS.config_path);
  updateAdminFooter();

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

  // Audit: async content, loaded via IPC.
  if (tab === 'audit') {
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
    if (scrollPrev !== null && scroller) scroller.scrollTop = scrollPrev;
    return;
  }

  cont.innerHTML = renderAdminTabContent(CFG, tab);

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
      // Re-render so a rejected toggle (e.g. a radio) snaps back.
      showAdminTab(tab, { preserveScroll: true });
      return;
    }
    if (result && result.dirty) {
      showAdminTab(tab, { preserveScroll: true });
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

async function saveConfigToNas() {
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
    await window.packprice.showInfo({
      titulo: 'Guardado',
      mensaje: 'Cambios guardados correctamente en el NAS',
      detalle: r.backupPath ? `Backup creado en:\n${r.backupPath}` : ''
    });
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
      btn.addEventListener('click', () => onHistoryAction(btn.dataset.action, btn.dataset.id));
    });
  } catch (err) {
    body.innerHTML = `<div class="alert alert-error"><svg class="icon"><use href="#i-warn"/></svg><span>${escAttr(err.message)}</span></div>`;
  }
}

async function onHistoryAction(action, id) {
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

async function saveCurrentQuote() {
  if (!lastResult) {
    await window.packprice.showError({
      titulo: 'Nada que guardar',
      mensaje: 'Calcula un presupuesto antes de guardarlo.'
    });
    return;
  }
  const draft = buildQuoteDraft(lastResult, {
    user: SETTINGS.user_name,
    configVersion: CFG && CFG.version,
    packId: state.packId
  });
  const r = await window.packprice.saveQuote(draft);
  if (!r || !r.ok) {
    await window.packprice.showError({
      titulo: 'No se pudo guardar',
      mensaje: (r && r.error) || 'Error desconocido'
    });
    return;
  }
  await window.packprice.showInfo({
    titulo: 'Presupuesto guardado',
    mensaje: `Asignado el ID ${r.quote.id}.`,
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
  // saved it yet, persist it now so the PDF and the history are
  // consistent (same id printed on the document and stored locally).
  let quote;
  if (lastResult.id && lastResult.date) {
    quote = lastResult;
  } else {
    const draft = buildQuoteDraft(lastResult, {
      user: SETTINGS.user_name,
      configVersion: CFG && CFG.version,
      packId: state.packId
    });
    const r = await window.packprice.saveQuote(draft);
    if (!r || !r.ok) {
      await window.packprice.showError({
        titulo: 'No se pudo preparar el PDF',
        mensaje: (r && r.error) || 'Error al guardar el presupuesto previo a exportar.'
      });
      return;
    }
    quote = r.quote;
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
// Local settings modal
// ============================================================

function openSettings() {
  el('aj-nombre').value = SETTINGS.user_name || '';
  el('aj-ruta').value = SETTINGS.config_path || '';
  // Toggles: local persistence in localStorage as a placeholder
  // until there is an official field in settings.json (see PLAN_UI §9).
  const remember = localStorage.getItem('pp:recordar-pack') === '1';
  const showVat = localStorage.getItem('pp:mostrar-iva') !== '0'; // default yes
  const tRemember = el('aj-recordar-pack');
  const tVat = el('aj-mostrar-iva');
  if (tRemember) tRemember.checked = remember;
  if (tVat) tVat.checked = showVat;
  show('ajustes-overlay');
}

function closeSettings() {
  hide('ajustes-overlay');
}

async function saveSettings() {
  const name = el('aj-nombre').value.trim();
  const filePath = el('aj-ruta').value.trim();

  if (!name || !filePath) {
    await window.packprice.showError({
      titulo: 'Datos incompletos',
      mensaje: 'Indica nombre y ruta del config'
    });
    return;
  }

  if (filePath !== SETTINGS.config_path) {
    const r = await window.packprice.readConfig(filePath);
    if (!r.ok) {
      await window.packprice.showError({
        titulo: 'No se puede leer el archivo',
        mensaje: r.error
      });
      return;
    }
  }

  // Toggles -> localStorage
  localStorage.setItem('pp:recordar-pack', el('aj-recordar-pack').checked ? '1' : '0');
  localStorage.setItem('pp:mostrar-iva',  el('aj-mostrar-iva').checked ? '1' : '0');

  SETTINGS = { user_name: name, config_path: filePath };
  await window.packprice.writeSettings(SETTINGS);
  closeSettings();
  await loadConfigAndShowApp();
}

// ============================================================
// Bootstrap
// ============================================================

document.addEventListener('DOMContentLoaded', bootstrap);
