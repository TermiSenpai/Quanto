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
//
// Used in the main process (main.js). The renderer receives the empty
// scaffold over IPC (`config:empty`), already renderer-shaped
// (has_password instead of the raw password).
// ============================================================

'use strict';

const SCHEMA_VERSION = '4.0.0';

// The canonical default profit margin (0.35 = 35%) stamped onto new
// entities and into `parameters.default_target_margin`. There is no
// default catalog any more, but this schema-level constant is still the
// single source of truth the v2/v3→v4 migration (lib/migrations.js)
// reads when it back-fills the margin fields a legacy config lacks.
const DEFAULT_TARGET_MARGIN = 0.35;

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
      terms: 'Precios IVA incluido. Validez 30 días desde la fecha de emisión.'
    }
  };
}

module.exports = {
  SCHEMA_VERSION,
  ADMIN_PASSWORD_PLACEHOLDER,
  DEFAULT_TARGET_MARGIN,
  PARAMETER_KEYS,
  buildEmptyConfig
};
