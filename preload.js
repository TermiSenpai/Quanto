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

  // --- Default candidate path (NAS) ---
  getDefaultConfigPath: ()   => ipcRenderer.invoke('config:default-path'),

  // --- Config existence / creation ---
  configExists:        (path)  => ipcRenderer.invoke('config:exists', path),
  createDefaultConfig: (data)  => ipcRenderer.invoke('config:create-default', data),

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

  // --- Logs (electron-log) ---
  readLogs:           (lineLimit) => ipcRenderer.invoke('logs:read-last', lineLimit),

  // --- Audit log (admin config changes) ---
  listAuditEntries:   (data) => ipcRenderer.invoke('audit:list', data),
  previewConfigDiff:  (data) => ipcRenderer.invoke('audit:diff-preview', data),

  // --- Quote history (local, per-PC) ---
  saveQuote:          (draft) => ipcRenderer.invoke('quotes:save', draft),
  listQuotes:         ()      => ipcRenderer.invoke('quotes:list'),
  searchQuotes:       (q)     => ipcRenderer.invoke('quotes:search', q),
  getQuote:           (id)    => ipcRenderer.invoke('quotes:get', id),
  deleteQuote:        (id)    => ipcRenderer.invoke('quotes:delete', id),

  // --- PDF export ---
  exportPdf:          (payload) => ipcRenderer.invoke('pdf:export', payload)

});
