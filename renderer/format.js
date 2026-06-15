// ============================================================
// DOM and formatting helpers
// ============================================================
// Stateless, no business logic. Reusable and testable.
// ============================================================

export function el(id) {
  return document.getElementById(id);
}

export function show(id) {
  el(id).classList.remove('hidden');
}

export function hide(id) {
  el(id).classList.add('hidden');
}

export function intFromInput(id) {
  return parseInt(el(id).value, 10) || 0;
}

export function formatEur(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return num.toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + ' €';
}

export function formatPct(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return (num * 100).toFixed(1) + ' %';
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
