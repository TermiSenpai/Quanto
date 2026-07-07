# Plan 5 — Presupuestos en la nube + estados + estadísticas

> Ejecutar con superpowers:subagent-driven-development. TDD, revisiones spec +
> calidad. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Goal:** sincronizar presupuestos a D1 (con cola offline e idempotencia),
capturar nombre/teléfono de cliente + validez 15 días, marcar estado
(pendiente/aceptado/rechazado) con recordatorio al arrancar, y una pantalla de
Estadísticas con gráficos SVG propios sobre datos de todos los PCs. El
historial local por PC sigue siendo la fuente de verdad de cada equipo.

**Spec:** `planes/v5-cloud-sync.md` §3 (tablas quotes/quote_items/quote_addons),
§5b(no — esto es quotes, no errores), §7 (outbox) · `docs/UI-UX.md` §2.7 ·
PRD R12, R13, R13b, R14.

**Reglas:** cero deps; red solo en main; UUIDs via crypto.randomUUID (disponible
en main y renderer); English code / Spanish UI; TDD; fail-fast.

**Decisión de diseño (importante):** sin Worker, las estadísticas NO se calculan
con 8 GROUP BY. `fetchStatsData` trae las filas (con filtro de fechas) y un
agregador **puro** `lib/stats.js` calcula todos los indicadores — mucho más
testeable y mantiene main fino. El volumen (presupuestos de un taller) cabe de
sobra en memoria.

---

## Task 5A — lib: cloud-quotes + outbox + stats aggregator + bootstrap + IPC

**Files:** create `lib/cloud-quotes.js`, `lib/quote-outbox.js`, `lib/stats.js`
(+ tests each); modify `lib/cloud-bootstrap.js` (+tests), `main.js`, `preload.js`.

1. **`lib/cloud-quotes.js`** (pure, client injected):
   - `buildQuoteRows(quote)` → `{ quote, items, addons }` row objects matching
     the D1 columns (0001_init.sql: quotes incl. id, ts, user, client_name,
     client_phone, valid_until, pack_id, tier, total_units, qty_3xl/4xl/5xl,
     total_vat_inc, sale_base, margin_pct, target_margin, pvp_deviation_pct,
     status default 'pending', catalog_version; quote_items
     [quote_id,product_id,sides,qty]; quote_addons [quote_id,addon_id,qty]).
     `quote.id` is a client UUID. Tolerate missing optional fields.
   - `uploadQuote(client, quote)` → INSERT OR IGNORE the quote row + its items
     + addons (idempotent by UUID PK — re-upload from the outbox never
     duplicates). Returns `{ ok, id }`.
   - `updateQuoteStatus(client, { id, status, now })` → `UPDATE quotes SET
     status=?, status_ts=? WHERE id=?` (status ∈ pending|accepted|rejected;
     validate, Spanish error otherwise).
   - `fetchStatsData(client, { from, to })` → `{ quotes, items, addons }` raw
     rows within the ISO date range (`WHERE ts >= ? AND ts <= ?`), all three
     tables. Tests: row shapes, date filter, INSERT OR IGNORE idempotency,
     status validation.
2. **`lib/quote-outbox.js`** (fs store, mirrors catalog-cache atomicity):
   - File `<userData>/cache/outbox.json` → `{ quotes:[…], statuses:[…] }`.
   - `enqueueQuote(dir, quote)`, `enqueueStatus(dir, {id,status,ts})`,
     `readOutbox(dir)`, `clearOutbox(dir)` and `flushOutbox(dir, client, deps)`
     → uploads queued quotes (uploadQuote) and applies queued statuses
     (updateQuoteStatus), removing each on success; UUID idempotency makes
     retries safe; a failing item stays queued (don't lose it), flush returns
     `{ uploaded, statusesApplied, remaining }`. Atomic `.tmp`+rename writes.
     Tests: enqueue/read/clear, flush success drains, flush partial keeps
     failures, corrupt outbox tolerated (Spanish error, never crash boot).
3. **`lib/stats.js`** (PURE aggregator, no I/O) — `computeStats({ quotes,
   items, addons }, cfg)` → an object with everything UI-UX §2.7 needs:
   - KPIs: `totalQuoted` (sum total_vat_inc), `totalAccepted` (status accepted),
     `conversionPct` (accepted/total count), `totalUnits`, `avgTicket`,
     `avgMarginPct`, `targetMarginPct` (from cfg.parameters.default_target_margin).
   - `byPack` [{packId, name, count, units, total}], `conversionByPack`
     [{packId, name, pending, accepted, rejected}], `weekly`
     [{weekIso, quoted, accepted}], `byTier` [{tier, count, units}],
     `marginByPack` [{packId, name, realMarginPct, targetPct}],
     `pvpDeviationHistogram` [{bucketLabel, count}], `topProducts`
     [{productId, name, qty}], `topAddons` [{addonId, label, qty}],
     `specialSizes` [{packId, name, q3xl, q4xl, q5xl}].
   - Pure + deterministic (no Date.now — derive weeks from each quote's ts).
     Heavily tested: empty input → zeroed KPIs + empty arrays (no NaN/division
     by zero); a small fixture of quotes pins each aggregate; pack/product/
     addon names resolved from cfg, archived/unknown ids fall back to the id.
4. **Bootstrap:** add `saveQuote(settings, {quote})` (try uploadQuote; on
   network failure enqueueQuote, return `{ ok:true, queued:true }`),
   `setQuoteStatus(settings, {id,status})` (upload or enqueue),
   `getStats(settings, {from,to})` (fetchStatsData → return raw, OR accept cfg
   and call computeStats — decide: return raw + let renderer pass cfg to a
   renderer copy? NO — compute in main with the loaded cfg and return the
   computed stats object, so the renderer only renders). Also `flushOutbox`
   called inside `loadCatalog`/`refreshCatalog` success paths (best-effort,
   logged). Tests in cloud-bootstrap.test.js.
5. **IPC + preload (thin):** `quotes:upload` {quote}, `quotes:set-status`
   {id,status}, `stats:get` {from,to}. Preload: `uploadQuote`,
   `setQuoteStatus`, `getStats`. Cloud-only (file mode: upload/status are
   no-ops returning {ok:true, skipped:true}; stats returns {ok:false,
   code:'NOT_CLOUD'} so the screen shows the local-only note from §2.7).
   No token to renderer.

**Commits:** `feat(cloud): quote upload, status and stats data access` ·
`feat(cloud): offline quote outbox` · `feat(stats): pure statistics aggregator` ·
`feat(main): quotes/stats IPC + outbox flush on sync`.

## Task 5B — `renderer/charts.js` (SVG puro, sin librerías) + tests

**Files:** create `renderer/charts.js` (+`tests/charts.test.js`).

Pure functions returning **SVG strings** (the renderer injects them; the test
asserts structure). No DOM, no window. Each takes data + options (width,
height, colors from tokens passed in), returns a self-contained `<svg>…</svg>`.

- `barChartH(items, opts)` — horizontal bars (pack usage, top products).
- `barChartV(items, opts)` — vertical bars (tiers, special sizes).
- `groupedBars(groups, opts)` — paired bars (margin real vs target,
  conversion pending/accepted/rejected stacked or grouped).
- `lineChart(series, opts)` — weekly evolution (quoted vs accepted); SVG
  `<polyline>` + axis (the renderer CAN position points in raw SVG, unlike
  Pencil — this is fine).
- `histogram(buckets, opts)` — pvp deviation.
- All: deterministic, escape any label text (XSS — labels come from cfg/D1),
  handle empty data (render an empty-state `<text>` not a broken axis), and
  expose values via `<title>` for hover tooltips + an accessible `<desc>`.

Tests (`tests/charts.test.js`): each chart with sample data produces an `<svg>`
containing the expected number of bars/points and escaped labels; empty data
produces the empty-state; a label with `<script>` is escaped.

**Commit:** `feat(stats): hand-rolled SVG chart helpers`.

## Task 5C — renderer: form cliente + subida + chips estado + recordatorio + Estadísticas

**Files:** modify `renderer/app.js`, `renderer/history.js`,
`renderer/index.html`, `renderer/styles.css`; pure helper
`renderer/quote-reminder.js` (+test) for the reminder derivation.

1. **Quote form (paso 2/resultado):** add **nombre y teléfono de cliente,
   obligatorios** (inline validation, not at the end) and compute
   `valid_until = ts + quote_settings.validity_days (15)`. These already flow
   into the local history `customer` field; now they also feed the cloud quote.
2. **On save quote:** keep the existing local-history save (source of truth),
   AND in cloud mode build the cloud quote row (UUID id via
   crypto.randomUUID(), pack_id/tier/units/sizes/totals/margin/
   pvp_deviation_pct from the calc result, client_name/phone, valid_until,
   catalog_version from DATA_STATE) → `uploadQuote` (which enqueues if
   offline). pvp_deviation_pct = (applied PVP − recommended PVP)/recommended
   when available, else null. Store the cloud UUID on the local entry so
   status changes target the same row.
3. **History status chips (UI-UX §2.7):** each quote row gains chips
   `Pendiente` (neutral) / `Aceptado` (success-soft) / `Rechazado`
   (danger-soft), clickable to change status → `setQuoteStatus` (enqueues if
   offline) + update local entry; undo via toast. File mode: chips still shown
   and stored locally (status is useful locally too) but no cloud upload.
4. **Startup reminder (UI-UX §2.7):** pure `renderer/quote-reminder.js`
   `computeReminder(quotes, nowIso)` → `{ pendingOld, expiringSoon }` counts
   (pending with no status >7 days; valid_until within this week). On startup,
   if either >0, show a dismissible banner «{N} presupuestos esperan respuesta ·
   {M} caducan esta semana — [Revisar]» → opens history filtered. Dismiss for
   the day. Tested pure helper (thresholds, empty, boundaries).
5. **Pantalla «Estadísticas» (UI-UX §2.7):** new screen reachable from the
   topbar (cloud mode). Period selector (Temporada/30 días/Año/Rango) → calls
   `getStats({from,to})` → renders KPI tiles + the 8 charts via charts.js.
   Loading skeleton; offline → standard offline note (stats need the network);
   empty period → explanatory empty state (never misleading zero charts). Each
   chart offers «Ver como tabla» (accessible alternative + quick copy). File
   mode: the screen shows a note that stats need cloud mode (local-only data).

**Commits:** `feat(renderer): client fields + cloud quote upload on save` ·
`feat(renderer): quote status chips and startup reminder` ·
`feat(renderer): statistics screen with SVG charts`.

## Cierre del Plan 5

- Suite verde (≥529 + nuevos; stats.js and charts.js heavily covered).
- Un presupuesto guardado en PC-A aparece en las estadísticas vistas desde
  PC-B (verificable contra D1 real — si no hay credenciales, anotar pendiente).
- Marcar aceptado/rechazado mueve la conversión.
- Sin conexión: el presupuesto se guarda local y se encola; al reconectar se
  sube (idempotente, sin duplicar).
- El recordatorio aparece con presupuestos antiguos sin estado / que caducan.
- Modo archivo: presupuestar + historial siguen igual; la pantalla de
  estadísticas indica que requiere modo nube.
