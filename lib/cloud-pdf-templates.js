// ============================================================
// PackPrice · Custom PDF template reads (cloud)
// ============================================================
// Reads user-authored ("custom") PDF templates out of the customer's
// D1 `pdf_templates` table (db/migrations/0001_init.sql). Built-in
// templates live in code (lib/pdf-templates.js); only custom ones are
// shared data in the cloud.
//
// The HTML returned here is UNTRUSTED (another PC may have authored
// it): the caller MUST sanitize it (lib/template-sanitizer.js) before
// rendering. Archived rows (soft-deleted) are excluded.
//
// Pure module: the D1 client is injected, no fs, no Electron. Custom
// templates are a CLOUD feature — file mode has the built-ins only
// (UI-UX §2.5). User-facing strings stay Spanish (CLAUDE.md §2).
// ============================================================

'use strict';

/**
 * Loads one custom template by id (or null when missing/archived).
 * The id is bound, never interpolated, so a crafted id cannot inject
 * SQL.
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {string} id
 * @returns {Promise<{id:string, name:string, html:string, css:string}|null>}
 */
async function loadPdfTemplate(client, id) {
  const res = await client.query(
    'SELECT id, name, html, css FROM pdf_templates WHERE id = ? AND archived_at IS NULL',
    [id]
  );
  const row = (res.results || [])[0];
  if (!row) return null;
  return { id: row.id, name: row.name, html: row.html, css: row.css || '' };
}

/**
 * Lists the custom templates (id + name only) for the gallery in the
 * settings screen (Task 6B). No html/css payload — the preview fetches
 * the full template on demand via loadPdfTemplate.
 *
 * @param {object} client - D1 client
 * @returns {Promise<Array<{id:string, name:string}>>}
 */
async function listPdfTemplates(client) {
  const res = await client.query(
    'SELECT id, name FROM pdf_templates WHERE archived_at IS NULL ORDER BY name'
  );
  return (res.results || []).map((row) => ({ id: row.id, name: row.name }));
}

/**
 * Inserts a new custom template into the shared store (Task 6B «Añadir
 * plantilla personalizada…»). The HTML must already be SANITIZED by the
 * caller (lib/template-sanitizer.js) — this module never trusts/cleans
 * HTML, it only persists. The id is a slug derived in the caller; name +
 * html are bound parameters, never interpolated, so they cannot inject
 * SQL. CSS is folded into the html (the templates carry inline <style>),
 * so the css column is stored empty.
 *
 * @param {object} client - D1 client (lib/d1-client.js)
 * @param {object} tpl
 * @param {string} tpl.id
 * @param {string} tpl.name
 * @param {string} tpl.html - sanitized
 * @param {string} [tpl.now] - ISO timestamp
 * @returns {Promise<{id:string, name:string}>}
 */
async function insertPdfTemplate(client, { id, name, html, now }) {
  const ts = now || new Date().toISOString();
  await client.query(
    'INSERT INTO pdf_templates (id, name, html, css, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    [id, name, html, '', ts, ts]
  );
  return { id, name };
}

module.exports = { loadPdfTemplate, listPdfTemplates, insertPdfTemplate };
