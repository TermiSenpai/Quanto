// ============================================================
// PackPrice · config.js parser and validation
// ============================================================
// Replaces the old `vm.runInNewContext`: we NEVER execute the
// config as JavaScript. We extract the JSON literal that follows
// `window.PACKPRICE_CONFIG = …;` and parse it with `JSON.parse`,
// which is strict and executes nothing.
//
// Security rationale:
//   Node's official docs make it clear that `vm` is NOT a security
//   boundary. A malicious `config.js` could escape with
//   `this.constructor.constructor('…')()` and gain RCE in the main
//   process. Since the `config.js` lives on the NAS (internal
//   network, easily reachable) and, worse, the user can *select*
//   an arbitrary .js from the dialog, this was a real surface.
//
// The parser tolerates comments at the start of the file (which is
// how `serializeConfig` serializes it) and uses a string-aware
// brace scanner. If the file does not parse as JSON it throws a
// clear error: the user sees it on screen and either recreates the
// config with defaults or restores a backup.
// ============================================================

'use strict';

const REQUIRED_SECTIONS = ['parameters', 'roly_models', 'tiers', 'packs', 'admin'];

/**
 * Extracts the JSON object assigned to `window.PACKPRICE_CONFIG`
 * and parses it with `JSON.parse`. Does NOT run the file as JS.
 *
 * @param {string} content  raw file text
 * @returns {object}        parsed configuration
 * @throws {Error}          if the marker is missing or the JSON is invalid
 */
function extractJsonFromConfig(content) {
  if (typeof content !== 'string') {
    throw new Error('El contenido del config debe ser texto');
  }
  const markerIdx = content.indexOf('window.PACKPRICE_CONFIG');
  if (markerIdx === -1) {
    throw new Error('El archivo no contiene window.PACKPRICE_CONFIG');
  }
  const braceIdx = content.indexOf('{', markerIdx);
  if (braceIdx === -1) {
    throw new Error('No se encuentra el objeto JSON tras window.PACKPRICE_CONFIG');
  }

  // String-aware brace scanner for double-quoted strings.
  // `JSON.stringify` only emits double-quoted strings, and our
  // serializer is JSON.stringify, so this is sufficient.
  let depth = 0;
  let i = braceIdx;
  let inString = false;
  let escaped = false;
  for (; i < content.length; i++) {
    const c = content[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === '\\') { escaped = true; continue; }
      if (c === '"')  { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) {
    throw new Error('Llaves desbalanceadas en el objeto del config');
  }
  const jsonBlock = content.slice(braceIdx, i);
  try {
    return JSON.parse(jsonBlock);
  } catch (err) {
    throw new Error(`Config no es JSON válido: ${err.message}`);
  }
}

/**
 * Validates that the config object has the minimal expected shape.
 * Not exhaustive (it does not check every field of every pack); it
 * is enough to detect gross corruption before writing.
 *
 * @param {object} cfg
 * @throws {Error} with a Spanish message if something is missing
 */
function validateConfigShape(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('El config debe ser un objeto');
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in cfg)) {
      throw new Error(`Falta la sección "${section}" en el config`);
    }
  }
  if (!cfg.parameters || typeof cfg.parameters !== 'object') {
    throw new Error('cfg.parameters debe ser un objeto');
  }
  if (!cfg.roly_models || typeof cfg.roly_models !== 'object') {
    throw new Error('cfg.roly_models debe ser un objeto');
  }
  if (!Array.isArray(cfg.tiers) || cfg.tiers.length === 0) {
    throw new Error('cfg.tiers debe ser un array no vacío');
  }
  for (const tier of cfg.tiers) {
    if (typeof tier.id !== 'string' || typeof tier.from !== 'number') {
      throw new Error('Cada tramo necesita id (string) y from (número)');
    }
  }
  if (!cfg.packs || typeof cfg.packs !== 'object') {
    throw new Error('cfg.packs debe ser un objeto');
  }
  if (!cfg.admin || typeof cfg.admin !== 'object') {
    throw new Error('cfg.admin debe ser un objeto');
  }
}

/**
 * Returns a copy of the config without the admin password. We use
 * it before sending the config to the renderer: the password check
 * must happen in main, not in the renderer (where DevTools could
 * read `CFG.admin.password` with a `console.log`).
 *
 * It replaces `password` with a `has_password` flag so the renderer
 * can show coherent UX (e.g. warn if one was never configured).
 */
function stripAdminPassword(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const originalAdmin = cfg.admin || {};
  const { password, ...rest } = originalAdmin;
  return {
    ...cfg,
    admin: {
      ...rest,
      has_password: typeof password === 'string' && password.length > 0
    }
  };
}

/**
 * Inverse of stripAdminPassword: given a config received from the
 * renderer (without password) and the known current password, it
 * reinjects the password to persist. If the renderer sends a
 * password (future case: changing the password from admin), the
 * new one wins.
 */
function injectAdminPassword(cfgFromRenderer, currentPassword) {
  if (!cfgFromRenderer || typeof cfgFromRenderer !== 'object') {
    throw new Error('Config inválido al reinyectar admin.password');
  }
  const incomingAdmin = cfgFromRenderer.admin || {};
  const { has_password: _ignored, password: passwordFromRenderer, ...rest } = incomingAdmin;
  const finalPassword = (typeof passwordFromRenderer === 'string' && passwordFromRenderer.length > 0)
    ? passwordFromRenderer
    : currentPassword;
  return {
    ...cfgFromRenderer,
    admin: { ...rest, password: finalPassword }
  };
}

/**
 * Builds the textual content of config.js from the object.
 * It used to live in main.js; we moved it here to test it in
 * isolation.
 */
function serializeConfig(config) {
  const json = JSON.stringify(config, null, 2);
  return `// ============================================================
// PackPrice - Configuración de la calculadora
// ============================================================
// Editado: ${new Date().toLocaleString('es-ES')}
// Modificado por: ${config.modified_by || 'desconocido'}
//
// Este archivo es generado por la app. Edítalo solo a mano si
// estás seguro de lo que haces. La app prefiere ediciones desde
// el modo administrador.
// ============================================================

window.PACKPRICE_CONFIG = ${json};
`;
}

module.exports = {
  extractJsonFromConfig,
  validateConfigShape,
  stripAdminPassword,
  injectAdminPassword,
  serializeConfig,
  REQUIRED_SECTIONS
};
