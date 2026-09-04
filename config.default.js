// ============================================================
// Quanto - Config bootstrap (empty scaffold + schema version)
// ============================================================
// There is NO default catalog. A fresh install builds its whole
// catalog from blank through the first-run wizard (renderer/
// catalog-wizard.js). This module only provides:
//   - SCHEMA_VERSION : the v4 schema tag stamped into new configs and
//                      the cloud migration ledger.
//   - PARAMETER_KEYS : the cost parameters the wizard's "Costes" step
//                      must fill (buildEmptyConfig nulls them all).
//   - buildEmptyConfig(meta): a schema-SHAPED but EMPTY config — the
//     in-memory scaffold the wizard fills. It is NOT valid until the
//     wizard adds the required minimums (>=1 tier/supplier/product/pack).
//   - DEFAULT_DEPOSIT_PCT : the default quote deposit ("señal") fraction,
//                           stamped into buildEmptyConfig and used to
//                           back-fill configs that predate the key.
//   - applyQuoteSettingsDefaults(cfg): back-fills a missing
//     quote_settings.deposit_pct on an existing config (pure, idempotent).
//
// Used in the main process (main.js, lib/cloud-bootstrap.js). The
// renderer receives the empty scaffold over IPC (`config:empty`),
// already renderer-shaped (has_password instead of the raw password).
// ============================================================

'use strict';

const SCHEMA_VERSION = '4.0.0';

// The canonical default profit margin (0.35 = 35%) stamped onto new
// entities and into `parameters.default_target_margin`. There is no
// default catalog any more, but this schema-level constant is still the
// single source of truth the v2/v3→v4 migration (lib/migrations.js)
// reads when it back-fills the margin fields a legacy config lacks.
const DEFAULT_TARGET_MARGIN = 0.35;

// The default minimum deposit ("señal") a quote asks for, as a fraction
// of the total with VAT (0.4 = 40 %). This file is the single home for
// schema-level default numbers: it reaches configs through
// buildEmptyConfig (new catalogs) and applyQuoteSettingsDefaults
// (catalogs that predate the key). Never hardcoded anywhere else
// (CLAUDE.md hard rule §2.2).
const DEFAULT_DEPOSIT_PCT = 0.4;

// Dead-code compatibility: the admin password gate is removed (CLAUDE.md
// §9 / v5), but validateConfigSchema still requires a non-empty
// admin.password (or has_password=true). We keep a placeholder purely to
// satisfy the schema until the admin-password field is migrated out. It
// grants no access — the editor opens directly.
const ADMIN_PASSWORD_PLACEHOLDER = 'quanto';

// Every cost parameter the user fills in the wizard's "Costes" step.
const PARAMETER_KEYS = [
  'labor_eur_hour', 'vat', 'waste_pct', 'overhead_eur_garment',
  'surcharge_4xl_eur', 'surcharge_5xl_eur', 'roly_shipping_eur_bundle',
  'garments_per_bundle', 'dtf_eur_meter', 'dtf_meters_two_sides',
  'dtf_meters_one_side', 'pressing_eur_side', 'minutes_two_sides_base',
  'minutes_one_side_base', 'default_target_margin', 'price_rounding_ending'
];

function blankParameters() {
  const p = {};
  for (const k of PARAMETER_KEYS) p[k] = null;
  return p;
}

/**
 * Returns a fresh, schema-SHAPED but EMPTY v4 configuration: blank cost
 * parameters and empty suppliers/products/tiers/packs/addons. It is the
 * scaffold the first-run wizard fills; it carries no business numbers and
 * does NOT pass validateConfigSchema until the wizard adds the minimums.
 *
 * @param {object} [meta] - optional { modified_by, updated_at }
 * @returns {object} config object ready to be filled
 */
function buildEmptyConfig(meta = {}) {
  return {
    version:     SCHEMA_VERSION,
    updated_at:  meta.updated_at || new Date().toLocaleString('es-ES'),
    modified_by: meta.modified_by || 'sistema (alta)',
    admin:       { password: ADMIN_PASSWORD_PLACEHOLDER },
    parameters:  blankParameters(),
    suppliers:   {},
    products:    {},
    tiers:       [],
    addons:      {},
    packs:       {},
    company: {
      name: '', tax_id: '', address: '', phone: '', email: '', web: '',
      pdf_template: 'clasica', brand_color: '#3D7BD9'
    },
    quote_settings: {
      validity_days: 30,
      terms: 'Precios IVA incluido. Validez 30 días desde la fecha de emisión.',
      deposit_pct: DEFAULT_DEPOSIT_PCT
    }
  };
}

/**
 * Fills `quote_settings.deposit_pct` with DEFAULT_DEPOSIT_PCT when a config
 * predates the key. Pure and idempotent: returns the SAME reference when
 * nothing is missing (callers can detect "untouched" by identity, like
 * migrateConfig), else a shallow copy with a copied quote_settings. Fills
 * ONLY deposit_pct on purpose: filling validity_days/terms would change
 * the PDFs of catalogs that left them undefined.
 *
 * @param {object} cfg
 * @returns {object} cfg itself, or a filled shallow copy
 */
function applyQuoteSettingsDefaults(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const qs = cfg.quote_settings;
  const hasQs = qs && typeof qs === 'object' && !Array.isArray(qs);
  if (hasQs && Number.isFinite(qs.deposit_pct)) return cfg;
  return {
    ...cfg,
    quote_settings: { ...(hasQs ? qs : {}), deposit_pct: DEFAULT_DEPOSIT_PCT }
  };
}

module.exports = {
  SCHEMA_VERSION,
  ADMIN_PASSWORD_PLACEHOLDER,
  DEFAULT_TARGET_MARGIN,
  DEFAULT_DEPOSIT_PCT,
  PARAMETER_KEYS,
  buildEmptyConfig,
  applyQuoteSettingsDefaults
};
