// ============================================================
// PackPrice · Custom-template sanitizer (dependency-free)
// ============================================================
// Custom PDF templates are SHARED DATA: a user imports HTML+CSS,
// it is stored in the cloud `pdf_templates` table, and every PC
// renders it. So before a custom template is ever rendered (in
// main, into the printToPDF window) we sanitize it.
//
// Policy — REJECT the whole template (throw a clear Spanish error
// naming the violation) when it contains any of:
//   - <script> elements
//   - on* event attributes (onclick, onerror, …)
//   - javascript: (and vbscript:) URLs — including entity-encoded
//     colons (javascript&#58;) and intra-scheme whitespace (java\tscript:)
//   - <iframe> / <object> / <embed> / <link> / <meta http-equiv>
//   - external resource refs in src/href/url(): http(s):// or the
//     protocol-relative //host form, AND CSS @import "http(s)://…" /
//     @import "//…" bare strings (which bypass the url(…) check).
//
// ALLOW (the templates need these):
//   - inline <style> blocks and style= attributes (safe CSS)
//   - {{…}} engine placeholders
//   - data: URIs (self-contained, no network) and in-document
//     fragment refs (#id).
//
// We reject rather than silently strip: a template that ships a
// script is a mistake the author must see and fix, and the UI shows
// the message verbatim ("La plantilla contiene scripts, que no están
// permitidos"). Built-in templates never pass through here — only
// untrusted custom ones do.
//
// Pure: no fs, no DOM, no globals. User-facing strings are Spanish
// (CLAUDE.md §2).
// ============================================================

'use strict';

// Strip {{…}} placeholders before scanning so an engine expression can
// never look like a forbidden attribute/url to the regexes below. The
// scan runs on this masked copy; the ORIGINAL string is what we return.
function maskPlaceholders(html) {
  return html.replace(/\{\{[\s\S]*?\}\}/g, '');
}

// Build a copy of the markup in which scheme obfuscation tricks are
// neutralized, so the javascript:/vbscript: scan can't be evaded by:
//   - entity-encoded colons:   javascript&#58;  /  javascript&#x3a;
//   - intra-scheme whitespace: java\tscript:  /  java\nscript:
// We decode numeric character references to their literal char and then
// drop all whitespace. The scan runs on this normalized copy; the
// ORIGINAL string is still what sanitizeTemplate returns when it passes.
function normalizeSchemes(scan) {
  const decoded = scan.replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : '';
  }).replace(/&#(\d+);?/g, (_, dec) => {
    const code = parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCharCode(code) : '';
  });
  return decoded.replace(/\s+/g, '');
}

function reject(message) {
  throw new Error(message);
}

/**
 * Sanitizes a custom template's HTML. Returns the original string
 * unchanged when it is safe, or throws a Spanish Error naming the
 * first violation found.
 *
 * @param {string} html
 * @returns {string} the same html when safe
 * @throws {Error} (Spanish) when a forbidden construct is present
 */
function sanitizeTemplate(html) {
  if (typeof html !== 'string') {
    reject('La plantilla debe ser una cadena de texto HTML.');
  }

  const scan = maskPlaceholders(html);

  // --- <script> elements ---
  if (/<\s*script\b/i.test(scan)) {
    reject('La plantilla contiene scripts, que no están permitidos.');
  }

  // --- dangerous elements ---
  if (/<\s*iframe\b/i.test(scan)) {
    reject('La plantilla contiene un <iframe>, que no está permitido.');
  }
  if (/<\s*object\b/i.test(scan)) {
    reject('La plantilla contiene un <object>, que no está permitido.');
  }
  if (/<\s*embed\b/i.test(scan)) {
    reject('La plantilla contiene un <embed>, que no está permitido.');
  }
  if (/<\s*link\b/i.test(scan)) {
    reject('La plantilla contiene un <link> a recursos externos, que no está permitido.');
  }
  if (/<\s*meta\b[^>]*http-equiv/i.test(scan)) {
    reject('La plantilla contiene un <meta http-equiv>, que no está permitido.');
  }

  // --- on* event handler attributes (e.g. onclick=, onerror=) ---
  // Match an attribute that starts with `on` followed by letters and an
  // `=`, preceded by whitespace so we never match e.g. a "person" word.
  if (/\son[a-z]+\s*=/i.test(scan)) {
    reject('La plantilla contiene atributos de evento (on…), que no están permitidos.');
  }

  // --- javascript:/vbscript: URLs (anywhere) ---
  // Run on a copy with entity-encoded colons decoded and all whitespace
  // removed, so `javascript&#58;…` and `java\tscript:…` can't slip past.
  if (/(?:javascript|vbscript):/i.test(normalizeSchemes(scan))) {
    reject('La plantilla contiene una URL javascript:, que no está permitida.');
  }

  // --- external resource references in src/href ---
  // http(s):// or protocol-relative //host. data: and #fragment are fine.
  const externalAttr = /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i;
  if (externalAttr.test(scan)) {
    reject('La plantilla referencia recursos externos (src/href), que no están permitidos: el PDF debe ser autocontenido.');
  }

  // --- external url() in CSS (style= or <style>) ---
  // url( http(s):// … ) or url( //host … ). data: is allowed.
  const externalUrl = /url\(\s*["']?\s*(?:https?:)?\/\//i;
  if (externalUrl.test(scan)) {
    reject('La plantilla referencia recursos externos en CSS (url(…)), que no están permitidos: el PDF debe ser autocontenido.');
  }

  // --- external @import via a bare quoted string (bypasses url()) ---
  // `@import "http://…"`, `@import 'https://…'` or `@import "//host…"`
  // pull a stylesheet from a third party. data: and relative imports are
  // fine. (The url() form of @import is already caught by externalUrl.)
  const externalImport = /@import\s+["']\s*(?:https?:)?\/\//i;
  if (externalImport.test(scan)) {
    reject('La plantilla contiene un @import a una hoja de estilos externa, que no está permitido: el PDF debe ser autocontenido.');
  }

  return html;
}

module.exports = { sanitizeTemplate };
