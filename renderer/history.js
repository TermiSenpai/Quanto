// ============================================================
// Quanto · History UI (renderer)
// ============================================================
// Pure rendering helpers for the quote-history modal. All IO
// goes through window.packprice; this module never touches the
// DOM directly. The orchestration in app.js wires the events.
// ============================================================

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatEur(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return value.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// v5 status chips (UI-UX §2.7): three clickable states per quote. A
// missing/empty status reads as 'pending' so legacy entries fit in. The
// tone classes mirror the design tokens (neutral / success-soft /
// danger-soft) — distinguished by text + tone, not colour alone (§2.8).
const STATUS_CHIPS = [
  { status: 'pending',  label: 'Pendiente', cls: 'quote-chip--pending' },
  { status: 'accepted', label: 'Aceptado',  cls: 'quote-chip--accepted' },
  { status: 'rejected', label: 'Rechazado', cls: 'quote-chip--rejected' }
];

/** Normalizes any stored status to one of the three known states. */
function normStatus(status) {
  return (status === 'accepted' || status === 'rejected') ? status : 'pending';
}

/** Renders the three status chips for one quote, the active one marked. */
function renderStatusChips(quote) {
  const current = normStatus(quote.status);
  const chips = STATUS_CHIPS.map(c => `
    <button type="button"
            class="quote-chip ${c.cls} ${c.status === current ? 'is-active' : ''}"
            data-action="status" data-id="${esc(quote.id)}" data-status="${c.status}"
            aria-pressed="${c.status === current}">
      ${c.label}
    </button>
  `).join('');
  return `<div class="quote-chips">${chips}</div>`;
}

/**
 * Renders a list of quotes as a table with action buttons. The
 * caller wires the dataset-driven actions via event delegation.
 *
 * @param {Array<object>} quotes
 * @returns {string}
 */
export function renderHistoryList(quotes) {
  if (!quotes || quotes.length === 0) {
    return `
      <p class="hint">No hay presupuestos guardados todavía. Calcula un pack y pulsa “Guardar presupuesto” para empezar.</p>
    `;
  }

  const rows = quotes.map(q => {
    const total = q.totals?.total_vat_inc ?? q.total_vat_inc;
    const customer = q.customer?.name || '—';
    // File rows carry the pack name (`pack`); cloud mapped rows only carry
    // `pack_id` (no name lookup server-side) — fall back so neither crashes.
    const pack = q.pack || q.type || q.pack_id || '—';
    return `
      <tr>
        <td class="text-mono">${esc(q.id)}</td>
        <td>${esc(formatDate(q.date))}</td>
        <td>${esc(q.user || '—')}</td>
        <td>${esc(customer)}</td>
        <td>${esc(pack)}</td>
        <td class="num">${esc(formatEur(total))}</td>
        <td>${renderStatusChips(q)}</td>
        <td class="actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="open" data-id="${esc(q.id)}" title="Reabrir">
            <svg class="icon"><use href="#i-edit"/></svg>
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="pdf" data-id="${esc(q.id)}" title="Exportar PDF">
            <svg class="icon"><use href="#i-share"/></svg>
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-id="${esc(q.id)}" title="Eliminar">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <table class="history-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Fecha</th>
          <th>Usuario</th>
          <th>Cliente</th>
          <th>Pack</th>
          <th class="num">Total</th>
          <th>Estado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/**
 * Builds the storage payload for a quote from the calculator's
 * raw result (`ultimoResultado` in app.js) plus session metadata.
 *
 * The payload is intentionally a shallow clone; we strip nothing
 * because the renderer layer should not be the place to drop
 * unrelated fields. Snapshot the user, date, and config version
 * so the entry survives future config changes.
 *
 * @param {object} result  the calculator output
 * @param {object} ctx      { user, configVersion, customer?, packId?, opt? }
 * @returns {object} draft passed to packprice.saveQuote
 */
export function buildQuoteDraft(result, ctx) {
  return {
    user: ctx.user || null,
    config_version: ctx.configVersion || null,
    pack_id: ctx.packId || null,
    pack: result.pack || null,
    customer: ctx.customer || null,
    result,
    totals: {
      total_vat_inc: result.total_vat_inc ?? null,
      sale_base:     result.sale_base ?? null,
      vat:           result.vat ?? null,
      total_cost:    result.total_cost ?? null,
      margin:        result.margin ?? null
    },
    opt: ctx.opt || null
  };
}
