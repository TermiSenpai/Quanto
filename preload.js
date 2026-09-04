// ============================================================
// Preload - secure bridge between the main process and renderer
// ============================================================
// Exposes a limited API on window.packprice via contextBridge.
// The renderer has NO direct access to Node, fs, ipcRenderer, or
// anything similar. It can only call the functions exposed here,
// which internally use IPC to talk to main.
// ============================================================

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('packprice', {

  // --- Local settings (%APPDATA%) ---
  readSettings:    ()        => ipcRenderer.invoke('settings:read'),
  writeSettings:   (s)       => ipcRenderer.invoke('settings:write', s),

  // --- File selection via native dialog ---
  selectConfigFile: ()       => ipcRenderer.invoke('dialog:select-config'),
  selectConfigFolder: ()     => ipcRenderer.invoke('dialog:select-config-folder'),
  folderConfigPath: (folder) => ipcRenderer.invoke('config:folder-config-path', folder),

  // --- Default candidate path (NAS) ---
  getDefaultConfigPath: ()   => ipcRenderer.invoke('config:default-path'),

  // --- Config existence / creation ---
  configExists:        (path)  => ipcRenderer.invoke('config:exists', path),
  // Empty schema-shaped scaffold for the first-run wizard (renderer-shaped:
  // has_password, no raw password). The renderer fills it step by step.
  getEmptyConfig:      ()      => ipcRenderer.invoke('config:empty'),
  // Persist a wizard-built config to a NEW file (validated + atomic + dir-made).
  createConfig:        (data)  => ipcRenderer.invoke('config:create', data),

  // --- Read/write the config on the NAS ---
  readConfig:        (path)  => ipcRenderer.invoke('config:read', path),
  getConfigInfo:     (path)  => ipcRenderer.invoke('config:info', path),
  writeConfig:       (data)  => ipcRenderer.invoke('config:write', data),
  forceWriteConfig:  (data)  => ipcRenderer.invoke('config:force-write', data),

  // --- Admin password verification (the comparison happens in main) ---
  verifyAdminPassword: (data) => ipcRenderer.invoke('auth:verify-admin', data),

  // --- Native dialogs ---
  confirmConflict:    (d) => ipcRenderer.invoke('dialog:confirm-conflict', d),
  confirm:            (d) => ipcRenderer.invoke('dialog:confirm', d),
  showInfo:           (d) => ipcRenderer.invoke('dialog:info', d),
  showError:          (d) => ipcRenderer.invoke('dialog:error', d),

  // --- Open an external https URL in the system browser ---
  // Used by the cloud wizard's "Abrir Cloudflare" buttons; the
  // navigation/network happens in main (shell.openExternal), never
  // in the renderer, so the CSP stays `default-src 'self'`.
  openExternal:       (url) => ipcRenderer.invoke('dialog:open-external', url),

  // --- Logs (electron-log) ---
  readLogs:           (lineLimit) => ipcRenderer.invoke('logs:read-last', lineLimit),

  // --- Diagnostics + error-report toggle (Plan 7A: PRD R17/R19) ---
  // `exportDiagnostics` builds a support bundle (logs + versions +
  // storage presence + REDACTED settings — never the token or business
  // data), asks where to save it and opens it; main owns the assembly.
  // The error-report toggle (opt-out) is read/written here; the secret
  // never crosses the bridge.
  exportDiagnostics:       ()    => ipcRenderer.invoke('diagnostics:export'),
  getErrorReportsEnabled:  ()    => ipcRenderer.invoke('error-reports:get'),
  setErrorReportsEnabled:  (on)  => ipcRenderer.invoke('error-reports:set', on),

  // --- App auto-update (PRD R15, electron-updater) ---
  // `checkAppUpdate` TRIGGERS a check in main; results arrive via the
  // `onUpdateState` subscription (main pushes { phase, version, percent,
  // error } over `update:state`). `installUpdateNow` quits + installs a
  // downloaded update. All network/Electron lives in main (CSP intact).
  checkAppUpdate:    ()   => ipcRenderer.invoke('update:check'),
  installUpdateNow:  ()   => ipcRenderer.invoke('update:install'),
  onUpdateState:     (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },

  // --- App version (welcome-screen label) ---
  // No network: the running version, so the UI never hardcodes it.
  getAppVersion:           ()    => ipcRenderer.invoke('app:version'),

  // --- Audit log (admin config changes) ---
  listAuditEntries:   (data) => ipcRenderer.invoke('audit:list', data),
  previewConfigDiff:  (data) => ipcRenderer.invoke('audit:diff-preview', data),

  // --- Cloud history (v5): audit + snapshots + forward-only restore ---
  // Cloud-only. `listAudit` reads the D1 audit_log paginated by
  // { limit, offset }; `listSnapshots` lists the versions;
  // `restoreSnapshot({ version })` rolls back forward-only (creates a new
  // version with that content, itself audited). No token/admin crosses
  // the bridge — the author and the API token are added in main.
  listAudit:          (data) => ipcRenderer.invoke('audit:list', data),
  listSnapshots:      ()     => ipcRenderer.invoke('snapshots:list'),
  restoreSnapshot:    (data) => ipcRenderer.invoke('snapshots:restore', data),

  // --- Quote history (local, per-PC) ---
  saveQuote:          (draft) => ipcRenderer.invoke('quotes:save', draft),
  listQuotes:         ()      => ipcRenderer.invoke('quotes:list'),
  searchQuotes:       (q)     => ipcRenderer.invoke('quotes:search', q),
  getQuote:           (id)    => ipcRenderer.invoke('quotes:get', id),
  deleteQuote:        (id)    => ipcRenderer.invoke('quotes:delete', id),
  // Patch a local entry ({ id, patch }) — used by the status chips and to
  // record the cloud UUID on the entry after an upload.
  updateQuote:        (data)  => ipcRenderer.invoke('quotes:update', data),

  // Record/clear a quote's paid deposit ({ id, paid: { amount } | null }).
  // Main stamps the timestamp + author; the backend flips the status and
  // the reply carries a fresh conflict token ({ ok, quote, token }).
  setQuoteDeposit:    (data)  => ipcRenderer.invoke('quotes:set-deposit', data),

  // --- Cloud quotes + statistics (v5) ---
  // Cloud-only. `uploadQuote({ quote })` mirrors a quote to D1
  // idempotently (enqueues offline); `setQuoteStatus({ id, status })`
  // marks it accepted/rejected/pending (enqueues offline); `getStats(
  // { from, to })` returns the COMPUTED stats object (main aggregates —
  // the renderer only paints). File mode: upload/status no-op
  // { ok:true, skipped:true }; stats { ok:false, code:'NOT_CLOUD' }. The
  // API token is added in main and never crosses the bridge.
  uploadQuote:        (data) => ipcRenderer.invoke('quotes:upload', data),
  setQuoteStatus:     (data) => ipcRenderer.invoke('quotes:set-status', data),
  getStats:           (data) => ipcRenderer.invoke('stats:get', data),

  // --- PDF export ---
  exportPdf:          (payload) => ipcRenderer.invoke('pdf:export', payload),

  // --- PDF templates: settings gallery + preview + custom save (Task 6B) ---
  // The renderer can't require the CommonJS templates module, so the
  // gallery list and the preview HTML come over IPC. `previewPdfTemplate`
  // returns { ok, html } — the renderer shows it in a SANDBOXED iframe
  // (srcdoc, no scripts), never in the main DOM. `savePdfTemplate` is
  // cloud-only: main sanitizes the HTML before storing it; on rejection it
  // answers { ok:false, error } with a plain Spanish message.
  listPdfTemplatesAll: ()        => ipcRenderer.invoke('pdf:list-templates'),
  previewPdfTemplate:  (payload) => ipcRenderer.invoke('pdf:preview', payload),
  savePdfTemplate:     (payload) => ipcRenderer.invoke('pdf:save-template', payload),

  // --- Cloud mode (v5): first-run wizard + catalog read path ---
  // The API token travels INTO main here and never comes back: the
  // configs returned carry no token and no admin section.
  testCloudToken:      (data) => ipcRenderer.invoke('cloud:test-token', data),
  provisionCloud:      (data) => ipcRenderer.invoke('cloud:provision', data),
  // Seed the freshly-provisioned (empty) D1 with the wizard-built catalog.
  // The config is renderer-shaped; main validates it before seeding.
  seedInitialCatalog:  (data) => ipcRenderer.invoke('catalog:seed-initial', data),
  loadCatalog:         ()     => ipcRenderer.invoke('catalog:load'),
  checkCatalogVersion: ()     => ipcRenderer.invoke('catalog:check-version'),
  refreshCatalog:      ()     => ipcRenderer.invoke('catalog:refresh'),

  // Guarded per-entity save (cloud mode). The renderer sends the edited
  // full cfg + the version map it loaded; main re-loads the baseline,
  // writes entity-by-entity and answers { ok } or { ok:false, conflicts,
  // results }. The author and the API token are added in main — never
  // here. `data` shape: { newCfg, expectedVersions }.
  saveCatalog:         (data) => ipcRenderer.invoke('catalog:save', data)

});
