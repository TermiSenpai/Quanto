// ============================================================
// Tests · lib/version-compare.js
// ============================================================
// The app-version update check (PRD R15) compares the running version
// (package.json) to the latest GitHub release tag. The comparison must
// be tolerant of the real shapes a tag takes: a leading "v", a
// prerelease suffix, missing patch, and unequal segment lengths.
import { describe, test, expect } from 'vitest';
import { compareVersions, isNewerVersion, parseVersion } from '../lib/version-compare.js';

describe('parseVersion', () => {
  test('strips a leading v and splits numeric core', () => {
    expect(parseVersion('v1.2.3')).toEqual({ parts: [1, 2, 3], prerelease: '' });
  });

  test('captures a prerelease suffix', () => {
    expect(parseVersion('5.0.0-beta')).toEqual({ parts: [5, 0, 0], prerelease: 'beta' });
  });

  test('tolerates a missing patch (1.2 → 1.2.0 semantics)', () => {
    expect(parseVersion('1.2')).toEqual({ parts: [1, 2], prerelease: '' });
  });

  test('returns null for garbage', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('compareVersions', () => {
  test('numeric segments compare numerically, not lexically (1.2.0 < 1.10.0)', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.2.0')).toBe(1);
  });

  test('equal versions compare equal (with and without leading v)', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  test('missing trailing segments are treated as zero (1.2 == 1.2.0)', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
  });

  test('a release outranks its own prerelease (5.0.0 > 5.0.0-beta)', () => {
    expect(compareVersions('5.0.0', '5.0.0-beta')).toBe(1);
    expect(compareVersions('5.0.0-beta', '5.0.0')).toBe(-1);
  });

  test('prerelease suffixes compare lexically when the core is equal', () => {
    expect(compareVersions('5.0.0-beta', '5.0.0-rc')).toBe(-1);
    expect(compareVersions('5.0.0-rc', '5.0.0-beta')).toBe(1);
    expect(compareVersions('5.0.0-beta', '5.0.0-beta')).toBe(0);
  });

  test('the numeric core wins over the prerelease (5.1.0-beta > 5.0.0)', () => {
    expect(compareVersions('5.1.0-beta', '5.0.0')).toBe(1);
  });

  test('an unparseable side compares as 0 (never throws)', () => {
    expect(compareVersions('garbage', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '')).toBe(0);
  });
});

describe('isNewerVersion', () => {
  test('true only when latest is strictly greater than current', () => {
    expect(isNewerVersion('1.2.0', '1.10.0')).toBe(true);
    expect(isNewerVersion('1.10.0', '1.2.0')).toBe(false);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  test('a stable release is newer than the running prerelease of the same core', () => {
    expect(isNewerVersion('5.0.0-beta', '5.0.0')).toBe(true);
  });

  test('a leading v on the latest tag does not matter', () => {
    expect(isNewerVersion('4.0.0-beta', 'v4.1.0')).toBe(true);
  });

  test('never throws on garbage; an unparseable latest is not newer', () => {
    expect(isNewerVersion('1.0.0', 'garbage')).toBe(false);
    expect(isNewerVersion('1.0.0', '')).toBe(false);
  });
});
