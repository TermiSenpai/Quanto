// ============================================================
// PackPrice · Data-status indicator (pure state machine)
// ============================================================
// The v5 cloud read path can return data from three places: live
// cloud, a local cache (offline) or a local config file. The topbar
// indicator (UI-UX §2.1) must say which, in plain Spanish, with an
// icon and a tone — never colour alone (§2.8 accessibility).
//
// This module is the pure seam: it maps a load-result envelope to a
// `{ kind, label, tone, icon }` display object and owns the single
// "dd/mm hh:mm" freshness formatter. No DOM, no IPC here — the glue
// that paints the badge and wires the refresh button lives in app.js,
// which keeps this unit testable in plain Node (vitest).
// ============================================================

'use strict';

/**
 * Local "dd/mm hh:mm" stamp for a data-freshness timestamp (§2.8).
 * Reads LOCAL fields (the workshop reads its own clock), zero-padded.
 * Returns 'sin fecha' for a missing/invalid value so the UI never
 * shows "Invalid Date".
 *
 * @param {string|number|Date|null|undefined} when - ISO string / ms / Date
 * @returns {string}
 */
export function formatFreshness(when) {
  if (when === null || when === undefined || when === '') return 'sin fecha';
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return 'sin fecha';
  const p = (n) => String(n).padStart(2, '0');
  const day = p(d.getDate());
  const month = p(d.getMonth() + 1);
  const hour = p(d.getHours());
  const minute = p(d.getMinutes());
  return `${day}/${month} ${hour}:${minute}`;
}

/**
 * Maps a catalog load-result to the topbar indicator state.
 *
 * Input is the relevant subset of the envelope returned by
 * `loadCatalog` / `refreshCatalog` (lib/cloud-bootstrap.js):
 *   { source, catalogVersion, fetchedAt, offline, reason }
 *   - source 'cloud' → live, fresh data (connected).
 *   - source 'cache' → served from the local cache; the cloud was
 *     unreachable (`offline`) OR reachable-but-invalid
 *     (`reason: 'cloud-invalid'`). Either way the user is looking at
 *     stale data, so the UI treats both as "offline" for the badge.
 *   - source 'file' (or anything else / absent) → local file mode.
 *
 * @param {{ source?: string, catalogVersion?: number, fetchedAt?: string,
 *           offline?: boolean, reason?: string }} [result]
 * @returns {{ kind: 'connected'|'offline'|'local', label: string,
 *             tone: 'success'|'warning'|'neutral', icon: string }}
 */
export function deriveDataStatus(result = {}) {
  const { source, catalogVersion, fetchedAt } = result;

  if (source === 'cloud') {
    return {
      kind: 'connected',
      tone: 'success',
      icon: 'i-check',
      label: `Datos al día · v${catalogVersion}`
    };
  }

  if (source === 'cache') {
    const stamp = fetchedAt ? formatFreshness(fetchedAt) : 'sin fecha';
    const tail = stamp === 'sin fecha' ? 'datos sin fecha' : `datos del ${stamp}`;
    return {
      kind: 'offline',
      tone: 'warning',
      icon: 'i-warn',
      label: `Sin conexión · ${tail}`
    };
  }

  // file mode (or no source resolved yet): the safe default.
  return {
    kind: 'local',
    tone: 'neutral',
    icon: 'i-folder',
    label: 'Modo local'
  };
}

/**
 * Refresh/retry reentrancy reducer (UI-UX §2.1/§2.2). The catalog
 * refresh can be triggered from two buttons — the topbar "Actualizar"
 * (#refresh-catalog) and the offline banner "Reintentar"
 * (#btn-offline-retry) — but they share one in-flight flow. This pure
 * decision says whether a new trigger should proceed and which button
 * owns the busy feedback, so a second click while a refresh runs is
 * ignored (no double download, no flapping UI).
 *
 * @param {{ inFlight?: boolean, offline?: boolean }} [s]
 *   - inFlight: a refresh is already running.
 *   - offline: the app is serving cached data (banner is visible), so
 *     the banner button is the one the user actually sees/clicks.
 * @returns {{ proceed: boolean, target: 'banner'|'topbar' }}
 *   - proceed: false when already in flight (ignore the re-entry).
 *   - target: which trigger gets the spinner/disabled state.
 */
export function planRefreshTrigger(s = {}) {
  if (s.inFlight) return { proceed: false, target: s.offline ? 'banner' : 'topbar' };
  return { proceed: true, target: s.offline ? 'banner' : 'topbar' };
}
