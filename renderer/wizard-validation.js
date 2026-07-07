// ============================================================
// Quanto - First-run wizard: per-step minimum validation (pure)
// ============================================================
// Renderer ESM module: imported by renderer/catalog-wizard.js and unit-
// tested in isolation (no DOM, no config.default import — it derives the
// parameter keys from the config object the wizard already holds).
//
// These helpers gate "Next" on each step and the final "Finish". They are
// a COUNT-level gate (>=1 tier/supplier/product/pack + every cost filled);
// deep validity is validateConfigSchema's job at persist time. Messages
// are Spanish (shown to the user).
// ============================================================

export const WIZARD_STEPS = [
  { id: 'parameters', label: 'Costes' },
  { id: 'tiers',      label: 'Tramos' },
  { id: 'suppliers',  label: 'Proveedores' },
  { id: 'products',   label: 'Productos' },
  { id: 'packs',      label: 'Packs' },
  { id: 'addons',     label: 'Complementos' },
  { id: 'company',    label: 'Empresa' }
];

/** True when EVERY parameter present on the config is a finite number >= 0.
 *  (config:empty fills all parameter keys with null, so "all present and
 *  finite" means the user has filled them all.) */
export function parametersComplete(cfg) {
  const p = (cfg && cfg.parameters) || {};
  const keys = Object.keys(p);
  return keys.length > 0 && keys.every((k) => Number.isFinite(p[k]) && p[k] >= 0);
}

function count(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).length : 0;
}

/** Spanish messages blocking advance from `stepId`. Empty array = OK. */
export function stepErrors(cfg, stepId) {
  const c = cfg || {};
  switch (stepId) {
    case 'parameters':
      return parametersComplete(c)
        ? []
        : ['Rellena todos los costes con números válidos (mayores o iguales que cero).'];
    case 'tiers':
      return Array.isArray(c.tiers) && c.tiers.length > 0 ? [] : ['Añade al menos un tramo.'];
    case 'suppliers':
      return count(c.suppliers) > 0 ? [] : ['Añade al menos un proveedor.'];
    case 'products':
      return count(c.products) > 0 ? [] : ['Añade al menos un producto.'];
    case 'packs':
      return count(c.packs) > 0 ? [] : ['Añade al menos un pack.'];
    case 'addons':
    case 'company':
      return []; // optional steps
    default:
      return [];
  }
}

/** True when every step's minimum is met (final "Finish" gate). */
export function wizardReady(cfg) {
  return WIZARD_STEPS.every((s) => stepErrors(cfg, s.id).length === 0);
}
