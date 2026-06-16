// ============================================================
// PackPrice · Admin extras (audit log, logs viewer, diff preview)
// ============================================================
// New functionality bolted onto the existing Spanish admin module.
// Written in English per CLAUDE.md §2; user-facing strings stay in
// Spanish per CLAUDE.md §4.5.
//
// Exports pure render functions plus small helpers that wire them
// to IPC. The orchestration layer (renderer/app.js) decides when
// to call them.
// ============================================================

import { humanizeChange, groupChanges, renderChangeGroup } from './change-format.js';

// ------------------------------------------------------------
// HTML escaping (kept local to avoid coupling to format.js)
// ------------------------------------------------------------
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${date} · ${time}`;
  } catch (_) {
    return iso;
  }
}

// ============================================================
// Audit tab
// ============================================================

/**
 * Renders the "Auditoría" tab content from a list of entries
 * (newest last, as returned by `audit:list`). Reverses for display
 * so the most recent entry appears at the top.
 *
 * @param {Array<object>} entries
 * @returns {string} HTML string
 */
export function renderAuditTab(entries) {
  if (!entries || entries.length === 0) {
    return `
      <p class="hint">No hay entradas de auditoría todavía. Cada vez que un admin guarde cambios en el config aparecerán aquí, con el detalle exacto de qué se modificó.</p>
    `;
  }

  const ordered = entries.slice().reverse();
  let html = `
    <p class="hint" style="margin-bottom: 12px;">Cambios guardados en el config del NAS, del más reciente al más antiguo. Las entradas son inmutables y se persisten en <code>audit.log</code> junto al config.</p>
    <div class="audit-list">
  `;
  for (const entry of ordered) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    const changesHtml = changes.length === 0
      ? '<p class="hint">Sin cambios registrados.</p>'
      // File audit carries FULL paths; pass no entityType so humanizeChange
      // parses it. Wrap to avoid .map passing the index as the 2nd arg.
      : '<ul class="audit-changes">' +
        changes.map(c => renderChangeRow(c)).join('') +
        '</ul>';
    html += `
      <article class="audit-entry">
        <header class="audit-entry__head">
          <span class="audit-entry__user">${esc(entry.user || 'desconocido')}</span>
          <span class="audit-entry__ts">${esc(formatTimestamp(entry.ts))}</span>
          ${entry.app_version ? `<span class="audit-entry__ver">v${esc(entry.app_version)}</span>` : ''}
          <span class="audit-entry__count">${changes.length} cambio${changes.length === 1 ? '' : 's'}</span>
        </header>
        <div class="audit-entry__body">${changesHtml}</div>
      </article>
    `;
  }
  html += '</div>';
  return html;
}

// One friendly change row. `humanizeChange` derives the entity type
// from the full path when `entityType` is omitted (file audit), and
// uses the passed type for cloud rows (which carry relative paths).
function renderChangeRow(change, entityType) {
  const kindClass = `audit-change--${esc(change.kind || 'change')}`;
  return `<li class="audit-change ${kindClass}">${esc(humanizeChange(change, entityType))}</li>`;
}

// ============================================================
// Cloud history (v5): audit log + snapshot list
// ============================================================
// The cloud audit entry shape differs from the file-mode one: each
// row is ONE entity change carrying `diff` (the array of
// {path, before, after, kind} the catalog writer persisted) plus
// entityType/entityId/action, instead of a single multi-change
// `changes` array. We reuse the same `renderChangeRow` styling so the
// two modes look identical.

// Spanish entity labels for the cloud audit header (entityType is
// English code; the user should never see it raw). Kept local — app.js
// has its own copy for the save/conflict modals, but admin-extras must
// stay self-contained (no cross-import between renderer modules here).
const AUDIT_ENTITY_LABEL = {
  pack: 'Pack',
  product: 'Producto',
  supplier: 'Proveedor',
  addon: 'Complemento',
  parameters: 'Parámetros',
  tiers: 'Tramos',
  company: 'Empresa'
};

// Spanish verb per audit action, so the header reads naturally.
const AUDIT_ACTION_LABEL = {
  create: 'creó',
  update: 'editó',
  delete: 'eliminó'
};

function auditEntityLabel(entityType, entityId) {
  const base = AUDIT_ENTITY_LABEL[entityType] || entityType || 'entidad';
  return entityId ? `${base} «${entityId}»` : base;
}

/**
 * Renders one cloud audit entry's change rows. GUARDS the diff shape:
 * `readAuditLog` parses `diff_json` into an array, but a malformed cell
 * falls back to the raw string — never crash, show it verbatim as a
 * single muted line so the corruption is visible.
 *
 * @param {(Array|string|null)} diff
 * @returns {string} HTML for the entry body
 */
function renderCloudDiff(diff, entityType) {
  if (Array.isArray(diff)) {
    if (diff.length === 0) return '<p class="hint">Sin cambios registrados.</p>';
    return '<ul class="audit-changes">' + diff.map(c => renderChangeRow(c, entityType)).join('') + '</ul>';
  }
  // Malformed (raw string) or missing: show it verbatim, do not throw.
  if (typeof diff === 'string' && diff.length > 0) {
    return `<ul class="audit-changes"><li class="audit-change"><code class="audit-change__path">${esc(diff)}</code></li></ul>`;
  }
  return '<p class="hint">Sin cambios registrados.</p>';
}

/**
 * Renders the cloud "Auditoría" sub-view from a list of entries
 * (already newest-first, as `audit:list` returns in cloud mode). Each
 * entry is one entity change: user · ts · "editó Pack «crew»".
 *
 * @param {Array<object>} entries
 * @returns {string} HTML string
 */
export function renderCloudAuditList(entries) {
  if (!entries || entries.length === 0) {
    return '<p class="hint">No hay cambios registrados todavía. Cada vez que alguien guarde el catálogo, su cambio aparecerá aquí con autor, fecha y detalle.</p>';
  }

  let html = '<div class="audit-list">';
  for (const entry of entries) {
    const action = AUDIT_ACTION_LABEL[entry.action] || 'cambió';
    const what = auditEntityLabel(entry.entityType, entry.entityId);
    html += `
      <article class="audit-entry">
        <header class="audit-entry__head">
          <span class="audit-entry__user">${esc(entry.user || 'desconocido')}</span>
          <span class="audit-entry__action">${esc(action)} ${esc(what)}</span>
          <span class="audit-entry__ts">${esc(formatTimestamp(entry.ts))}</span>
          ${Number.isFinite(entry.catalogVersion) ? `<span class="audit-entry__ver">v${esc(entry.catalogVersion)}</span>` : ''}
        </header>
        <div class="audit-entry__body">${renderCloudDiff(entry.diff, entry.entityType)}</div>
      </article>
    `;
  }
  html += '</div>';
  return html;
}

/**
 * Pure label for a snapshot row: `v{N} · {dd/mm/aaaa hh:mm}`. Kept
 * separate (and exported) so it can be unit-tested without the DOM.
 *
 * @param {{catalogVersion:number, ts:string}} snapshot
 * @returns {string}
 */
export function formatSnapshotLabel(snapshot) {
  const s = snapshot || {};
  return `v${s.catalogVersion} · ${formatTimestamp(s.ts)}`;
}

/**
 * Renders the "Versiones" sub-view: each snapshot as a row with a
 * «Restaurar esta versión» button. The button carries the version (and
 * a human label, for the confirmation copy) in data-* so the glue in
 * app.js can wire the restore without re-deriving anything.
 *
 * @param {Array<{catalogVersion:number, ts:string}>} snapshots
 * @returns {string} HTML string
 */
export function renderSnapshotsList(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    return '<p class="hint">No hay versiones guardadas todavía. Cada vez que se guarda el catálogo se crea una versión que podrás restaurar desde aquí.</p>';
  }

  let html = '<div class="snapshot-list">';
  for (const snap of snapshots) {
    const label = formatSnapshotLabel(snap);
    html += `
      <div class="snapshot-row">
        <span class="snapshot-row__label">${esc(label)}</span>
        <button type="button" class="btn btn-secondary snapshot-row__restore"
                data-action="restore-snapshot"
                data-version="${esc(snap.catalogVersion)}"
                data-label="${esc(label)}">
          <svg class="icon"><use href="#i-clock"/></svg> Restaurar esta versión
        </button>
      </div>
    `;
  }
  html += '</div>';
  return html;
}

// ============================================================
// Diff preview (rendered into the modal-diff body)
// ============================================================

/**
 * Renders the body of the "Confirmar cambios" modal. `changes` is
 * the array returned by `audit:diff-preview`.
 *
 * @param {Array<object>} changes
 * @returns {string} HTML string
 */
export function renderDiffPreview(changes) {
  if (!changes || changes.length === 0) {
    return '<p class="hint">No hay cambios pendientes que guardar.</p>';
  }
  const groups = groupChanges(changes);
  const n = changes.length;
  return `
    <p>Vas a guardar <strong>${n}</strong> cambio${n === 1 ? '' : 's'}:</p>
    ${groups.map(renderChangeGroup).join('')}
  `;
}

// ============================================================
// Logs viewer
// ============================================================

/**
 * Renders the body of the "Ver logs" modal.
 *
 * @param {{ path: string|null, lines: string[] }} payload
 * @returns {string} HTML string
 */
export function renderLogsModal(payload) {
  const lines = (payload && payload.lines) || [];
  const path = payload && payload.path ? payload.path : '—';
  if (lines.length === 0) {
    return `
      <p class="hint">No hay entradas de log todavía. Las acciones futuras se registrarán en:</p>
      <code class="logs-path">${esc(path)}</code>
    `;
  }
  return `
    <p class="hint">Últimas ${lines.length} líneas de <code>${esc(path)}</code>:</p>
    <pre class="logs-pre">${esc(lines.join('\n'))}</pre>
  `;
}
