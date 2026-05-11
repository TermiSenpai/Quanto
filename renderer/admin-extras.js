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

// ------------------------------------------------------------
// HTML escaping (kept local to avoid coupling to format.js)
// ------------------------------------------------------------
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatScalar(value) {
  if (value === undefined || value === null) return '<em class="muted">∅</em>';
  if (typeof value === 'string') return esc(JSON.stringify(value));
  if (typeof value === 'number' || typeof value === 'boolean') return esc(value);
  return esc(JSON.stringify(value));
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
    const cambios = Array.isArray(entry.cambios) ? entry.cambios : [];
    const cambiosHtml = cambios.length === 0
      ? '<p class="hint">Sin cambios registrados.</p>'
      : '<ul class="audit-changes">' +
        cambios.map(renderChangeRow).join('') +
        '</ul>';
    html += `
      <article class="audit-entry">
        <header class="audit-entry__head">
          <span class="audit-entry__user">${esc(entry.usuario || 'desconocido')}</span>
          <span class="audit-entry__ts">${esc(formatTimestamp(entry.ts))}</span>
          ${entry.app_version ? `<span class="audit-entry__ver">v${esc(entry.app_version)}</span>` : ''}
          <span class="audit-entry__count">${cambios.length} cambio${cambios.length === 1 ? '' : 's'}</span>
        </header>
        <div class="audit-entry__body">${cambiosHtml}</div>
      </article>
    `;
  }
  html += '</div>';
  return html;
}

function renderChangeRow(change) {
  const kindClass = `audit-change--${esc(change.kind || 'change')}`;
  const sign = change.kind === 'add' ? '+' : change.kind === 'remove' ? '−' : '~';
  if (change.kind === 'add') {
    return `<li class="audit-change ${kindClass}">
      <span class="audit-change__sign">${sign}</span>
      <code class="audit-change__path">${esc(change.path)}</code>
      <span class="audit-change__after">${formatScalar(change.after)}</span>
    </li>`;
  }
  if (change.kind === 'remove') {
    return `<li class="audit-change ${kindClass}">
      <span class="audit-change__sign">${sign}</span>
      <code class="audit-change__path">${esc(change.path)}</code>
      <span class="audit-change__before">${formatScalar(change.before)}</span>
    </li>`;
  }
  return `<li class="audit-change ${kindClass}">
    <span class="audit-change__sign">${sign}</span>
    <code class="audit-change__path">${esc(change.path)}</code>
    <span class="audit-change__before">${formatScalar(change.before)}</span>
    <span class="audit-change__arrow">→</span>
    <span class="audit-change__after">${formatScalar(change.after)}</span>
  </li>`;
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
  const lines = changes.map(renderChangeRow).join('');
  return `
    <p>Vas a guardar <strong>${changes.length}</strong> cambio${changes.length === 1 ? '' : 's'} en el config:</p>
    <ul class="audit-changes audit-changes--preview">${lines}</ul>
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
