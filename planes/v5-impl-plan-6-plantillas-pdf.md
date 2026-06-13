# Plan 6 — Plantillas de presupuesto PDF (motor propio + 6 plantillas)

> Ejecutar con superpowers:subagent-driven-development. TDD, revisiones spec +
> calidad. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Goal:** motor de plantillas propio estilo QWeb (sin librerías) + 6 plantillas
integradas (Clásica, Moderna, Compacta, Detallada, Corporativa, Formulario),
color de marca configurable por empresa, galería con vista previa en ajustes, y
plantillas personalizadas como dato compartido (saneadas al cargar). Sin firmas
(presupuestos digitales). Todos los textos del presupuesto son **datos**
editables, no plantilla.

**Spec:** `planes/v5-cloud-sync.md` §8 + tabla `pdf_templates` (§3) ·
`docs/UI-UX.md` §2.5 (galería) · PRD R20. Los diseños aprobados se describieron
en la conversación de diseño; **las plantillas HTML+CSS reales son el
entregable** (superan a los mockups de `MainUI.pen`).

**Reglas:** cero deps; el PDF se genera en main vía printToPDF (HTML
autocontenido, sin recursos externos); CSP intacta; English code / Spanish UI;
TDD; fail-fast.

---

## Task 6A — motor + saneador + contexto + 6 plantillas + esquema + integración main

**Files:** create `lib/template-engine.js`, `lib/template-sanitizer.js`,
`lib/pdf-templates.js` (the 6 built-ins + buildQuoteContext + brand helper)
(+ tests each); modify `lib/config-schema.js` (+tests), `main.js`,
`lib/pdf-template.js` (route through the engine or keep as the "Clásica"
fallback). Reuse the existing `renderQuoteHtml` logic as the basis of one
built-in.

1. **`lib/template-engine.js`** (pure, ~150 lines): `render(templateStr, ctx)`:
   - `{{ path.to.value }}` — dotted lookup, **HTML-escaped by default**;
     missing → empty string (never `undefined`/`{{…}}` leftover).
   - `{{#each items}} … {{/each}}` — iterate arrays; inside, `{{this.x}}` or
     bare `{{x}}` resolves against the item; support `{{@index}}`.
   - `{{#if cond}} … {{else}} … {{/if}}` — truthy test on a path.
   - A raw/unescaped form is **NOT** supported (everything escaped) — values
     are data, the templates provide the only markup. Document this as the XSS
     guarantee.
   - Deterministic, no I/O. Tests: var/dotted/missing, each (incl. nested +
     @index + empty array), if/else, escaping of values, malformed template
     (unclosed block) → clear error, no leftover mustaches on success.
2. **`lib/template-sanitizer.js`** (pure): `sanitizeTemplate(html)` for
   **custom** templates loaded from shared data — strip/reject `<script>`,
   `on*` event attributes, `javascript:` URLs, `<iframe>/<object>/<embed>/
   <link>/<meta http-equiv>`, and external resource refs (`src`/`href`/
   `url(...)` pointing to http(s)/`//`). Allow inline `<style>` and inline
   `style=` (the templates need CSS). Return the cleaned HTML or throw a clear
   Spanish error naming the violation (the UI shows it). Tests: removes/rejects
   each vector; keeps legitimate inline CSS + `{{…}}` placeholders intact.
3. **`lib/pdf-templates.js`**:
   - `BUILTIN_TEMPLATES` = `{ id, name, html }` × 6 (Clásica, Moderna,
     Compacta, Detallada, Corporativa, Formulario). Each is an HTML+CSS string
     using the engine syntax, A4, self-contained, NO external resources. The
     color ones (Moderna, Corporativa) consume `{{brand.color}}` /
     `{{brand.dark}}` / `{{brand.soft}}`. No signature blocks — close with the
     digital-confirmation note built from data.
   - `buildQuoteContext(quote, { company, quoteSettings, brand, logoDataUri })`
     → the flat context the templates render against: company fields, quote id/
     date/valid_until, client name/phone, line items (concept/qty/unit/subtotal),
     totals (base/vat/total), per-person price when derivable, special sizes,
     conditions text (from quoteSettings.terms — DATA), confirmation note. Pure.
   - `brandColors(baseHex)` → `{ color, dark, soft }` (derive dark = darken,
     soft = light tint; validate hex, fallback to the app accent if invalid).
   - `renderQuote(quote, options)` → pick the template by
     `options.templateId` (built-in or a provided custom `{html}`), build the
     context, `engine.render`. Falls back to 'clasica' when unset/unknown.
   Tests: every built-in renders for a sample quote with NO leftover `{{`,
   well-formed (balanced tags), escapes a malicious client name, brand colors
   appear in the color templates; per-person/special-size sections appear when
   data present and are omitted when absent.
4. **Config schema (additive, optional):** allow `company.pdf_template`
   (string id, optional) and `company.brand_color` (hex string, optional) —
   shared data so all PCs print alike. Update `lib/config-schema.js` validation
   to accept them (optional; validate hex format if present) and
   `config.default.js` seed (pdf_template: 'clasica', a neutral brand_color).
   Tests: schema accepts with/without, rejects a malformed brand_color.
5. **main integration:** the existing `pdf:export` path now resolves the
   chosen template: `templateId` from `cfg.company.pdf_template`; brand from
   `cfg.company.brand_color`; if a custom template id, load it from
   `pdf_templates` (cloud mode, via a new bootstrap `getPdfTemplate(id)`/
   `listPdfTemplates()`) and `sanitizeTemplate` it before rendering. Render via
   `lib/pdf-templates.renderQuote`. Keep the current behavior as the 'clasica'
   built-in so existing exports look the same or better. File mode: built-ins
   only (custom templates are a cloud feature — documented).

**Commits:** `feat(pdf): QWeb-style template engine` ·
`feat(pdf): custom template sanitizer` ·
`feat(pdf): six built-in quote templates + brand color + context` ·
`feat(main): route PDF export through the template engine`.

## Task 6B — renderer: galería + vista previa + color de marca + personalizadas

**Files:** modify `renderer/app.js`, `renderer/index.html`,
`renderer/styles.css`; cloud bootstrap/IPC for custom templates if not in 6A.

1. **Sección «Plantilla de presupuesto»** en ajustes (UI-UX §2.5): galería con
   miniaturas de las 6 integradas + las personalizadas de la empresa.
   Selección persiste en `company.pdf_template` (escritura compartida — en
   cloud via saveCatalog company; en file via config write).
2. **Vista previa** del presupuesto demo al seleccionar: render seguro en un
   **`<iframe sandbox>` con `srcdoc`** (sin scripts, aislado) del HTML
   producido por `renderQuote` con un quote de demo — nunca inyectar el HTML de
   plantilla directamente en el DOM del renderer.
3. **Color de marca:** selector de color (input type=color) que actualiza
   `company.brand_color` y refresca la vista previa de las plantillas con color.
4. **«Añadir plantilla personalizada…»** (cloud mode): importar HTML+CSS,
   `sanitizeTemplate` (en main), guardar en `pdf_templates`; si no pasa el
   saneado, error en lenguaje llano («La plantilla contiene scripts, que no
   están permitidos»). File mode: solo las 6 integradas (nota).
5. CSP intacta; la vista previa usa iframe sandbox (no afecta a script-src del
   documento principal).

**Commit:** `feat(renderer): PDF template gallery, preview and brand color`.

## Cierre del Plan 6

- Suite verde (≥678 + nuevos; engine/sanitizer/templates/context bien cubiertos).
- Las 6 plantillas renderizan el mismo presupuesto correctamente; sin `{{…}}`
  residual; bien formadas; valores escapados (XSS).
- El color de marca se aplica a las plantillas con color.
- Una plantilla personalizada con `<script>` se rechaza con mensaje claro; una
  válida subida en un PC se ve en otro (cloud).
- Presupuestos digitales, sin firmas; textos = datos editables.
- Modo archivo: 6 integradas seleccionables; personalizadas = cloud (nota).
