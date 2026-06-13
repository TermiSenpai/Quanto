// ============================================================
// PackPrice · version comparison (PRD R15, update check)
// ============================================================
// One tested implementation of the version compare used by the
// app-version update check. main's `update:check` computes `isNewer`
// here so the renderer only displays the result — there is no second
// (drift-prone) copy in the renderer.
//
// The shapes we must tolerate are the ones GitHub release tags and
// package.json actually take:
//   - an optional leading "v"            (v4.0.0)
//   - a prerelease suffix                (5.0.0-beta, 5.0.0-rc.1)
//   - unequal/missing trailing segments  (1.2 vs 1.2.0)
// Numeric segments compare NUMERICALLY (so 1.10.0 > 1.2.0, not the
// lexical opposite). A release outranks its own prerelease (SemVer:
// 5.0.0 > 5.0.0-beta). Anything unparseable degrades to "equal" so a
// malformed remote tag can never crash the check.
//
// Pure and dependency-free (CommonJS, main-side); unit-tested.
// ============================================================

'use strict';

/**
 * Parses a version string into its numeric parts and prerelease suffix.
 * Returns null when there is no numeric core at all.
 *
 * @param {unknown} version
 * @returns {{ parts: number[], prerelease: string } | null}
 */
function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim().replace(/^[vV]/, '');
  if (trimmed === '') return null;

  // Split the prerelease (after the first '-') from the numeric core.
  const dash = trimmed.indexOf('-');
  const core = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const prerelease = dash === -1 ? '' : trimmed.slice(dash + 1);

  const segments = core.split('.');
  const parts = [];
  for (const seg of segments) {
    if (!/^\d+$/.test(seg)) return null;
    parts.push(parseInt(seg, 10));
  }
  if (parts.length === 0) return null;
  return { parts, prerelease };
}

/**
 * Compares two version strings. Returns -1 if a < b, 0 if equal, 1 if
 * a > b. Never throws: an unparseable side is treated as equal (so the
 * caller's "is newer" stays false on garbage).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;

  // Numeric core, segment by segment, missing segments as 0.
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i++) {
    const x = pa.parts[i] || 0;
    const y = pb.parts[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }

  // Equal numeric core: a release (no prerelease) outranks a prerelease.
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === '') return 1;   // a is the stable release
  if (pb.prerelease === '') return -1;  // b is the stable release
  // Both have a prerelease: compare lexically (good enough for our tags).
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/**
 * True only when `latest` is strictly greater than `current`. Used by
 * main's update:check to decide whether to surface a "new version"
 * notice. Garbage on either side → false (never a false positive).
 *
 * @param {string} current
 * @param {string} latest
 * @returns {boolean}
 */
function isNewerVersion(current, latest) {
  return compareVersions(latest, current) === 1;
}

module.exports = {
  parseVersion,
  compareVersions,
  isNewerVersion
};
