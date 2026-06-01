// ============================================================
// Parser and validator tests (lib/config-parser.js)
// ============================================================
// The SECURITY tests are especially important: the parser replaced
// the old `vm.runInNewContext` precisely because `vm` is not a
// security boundary. Here we verify that malicious payloads do NOT
// execute code.
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  extractJsonFromConfig,
  validateConfigShape,
  stripAdminPassword,
  injectAdminPassword,
  serializeConfig
} from '../lib/config-parser.js';
import { buildDefaultConfig } from '../config.default.js';

describe('extractJsonFromConfig — happy path', () => {
  test('round-trip: serialize → extract returns the same object', () => {
    const original = buildDefaultConfig({ modified_by: 'tester' });
    const text = serializeConfig(original);
    const recovered = extractJsonFromConfig(text);
    expect(recovered).toEqual(original);
  });

  test('accepts leading comments and whitespace', () => {
    const text = `// comment
// another
window.PACKPRICE_CONFIG = ${JSON.stringify({ a: 1, b: { c: 'hola' } })};
`;
    expect(extractJsonFromConfig(text)).toEqual({ a: 1, b: { c: 'hola' } });
  });

  test('tolerates a missing trailing semicolon', () => {
    const text = `window.PACKPRICE_CONFIG = ${JSON.stringify({ a: 1 })}`;
    expect(extractJsonFromConfig(text)).toEqual({ a: 1 });
  });

  test('respects braces inside strings', () => {
    const obj = { mensaje: 'hola { mundo } { adios' };
    const text = `window.PACKPRICE_CONFIG = ${JSON.stringify(obj)};`;
    expect(extractJsonFromConfig(text)).toEqual(obj);
  });

  test('respects strings with escaped quotes', () => {
    const obj = { mensaje: 'dijo "hola"' };
    const text = `window.PACKPRICE_CONFIG = ${JSON.stringify(obj)};`;
    expect(extractJsonFromConfig(text)).toEqual(obj);
  });
});

describe('extractJsonFromConfig — clear errors', () => {
  test('missing window.PACKPRICE_CONFIG marker', () => {
    expect(() => extractJsonFromConfig('var x = 1;')).toThrow(/PACKPRICE_CONFIG/);
  });

  test('no JSON object after the marker', () => {
    expect(() => extractJsonFromConfig('window.PACKPRICE_CONFIG = 42;')).toThrow();
  });

  test('malformed JSON fails with a useful message', () => {
    expect(() => extractJsonFromConfig('window.PACKPRICE_CONFIG = { roto: }')).toThrow();
  });

  test('unbalanced braces', () => {
    expect(() => extractJsonFromConfig('window.PACKPRICE_CONFIG = { "a": 1'))
      .toThrow(/desbalanceadas|JSON/);
  });

  test('non-string content', () => {
    expect(() => extractJsonFromConfig(null)).toThrow();
    expect(() => extractJsonFromConfig(123)).toThrow();
  });
});

describe('extractJsonFromConfig — SECURITY: does not run code', () => {
  test('IIFE payload does not execute (RCE regression)', () => {
    let effect = false;
    // Simulates the intended attack: if the content were executed
    // as JS (as vm.runInNewContext did), `effect` would flip. With
    // JSON.parse this must fail as invalid JSON.
    globalThis.__packprice_pwned__ = () => { effect = true; };
    const text = `window.PACKPRICE_CONFIG = (globalThis.__packprice_pwned__(), { admin: { password: 'x' } });`;
    expect(() => extractJsonFromConfig(text)).toThrow();
    expect(effect).toBe(false);
    delete globalThis.__packprice_pwned__;
  });

  test('this.constructor.constructor payload does not execute', () => {
    const text = `window.PACKPRICE_CONFIG = this.constructor.constructor('return process')();`;
    expect(() => extractJsonFromConfig(text)).toThrow();
  });

  test('explicit require call does not execute', () => {
    const text = `window.PACKPRICE_CONFIG = require('child_process').execSync('whoami');`;
    expect(() => extractJsonFromConfig(text)).toThrow();
  });

  test('a brace inside a string does not break the parser', () => {
    // The string contains `}` that must NOT close the outer object.
    const obj = { evil: '"} ; require("child_process").execSync("rm -rf /") ; ({"x":1' };
    const text = `window.PACKPRICE_CONFIG = ${JSON.stringify(obj)};`;
    expect(extractJsonFromConfig(text)).toEqual(obj);
  });
});

describe('validateConfigShape', () => {
  test('default config passes', () => {
    expect(() => validateConfigShape(buildDefaultConfig())).not.toThrow();
  });

  test.each([
    ['parameters'],
    ['roly_models'],
    ['tiers'],
    ['packs'],
    ['admin']
  ])('fails if section %s is missing', (section) => {
    const cfg = buildDefaultConfig();
    delete cfg[section];
    expect(() => validateConfigShape(cfg)).toThrow(new RegExp(section));
  });

  test('rejects empty tiers', () => {
    const cfg = buildDefaultConfig();
    cfg.tiers = [];
    expect(() => validateConfigShape(cfg)).toThrow(/tiers/);
  });

  test('rejects tiers without id', () => {
    const cfg = buildDefaultConfig();
    cfg.tiers = [{ from: 10 }];
    expect(() => validateConfigShape(cfg)).toThrow(/tramo/);
  });

  test('rejects non-objects', () => {
    expect(() => validateConfigShape(null)).toThrow();
    expect(() => validateConfigShape([])).toThrow();
    expect(() => validateConfigShape('string')).toThrow();
  });
});

describe('stripAdminPassword', () => {
  test('removes the password and leaves a has_password flag', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.admin.password).toBeTruthy();
    const stripped = stripAdminPassword(cfg);
    expect(stripped.admin.password).toBeUndefined();
    expect(stripped.admin.has_password).toBe(true);
    // Does not mutate the original
    expect(cfg.admin.password).toBeTruthy();
  });

  test('has_password=false when there was no password', () => {
    const cfg = buildDefaultConfig();
    cfg.admin.password = '';
    expect(stripAdminPassword(cfg).admin.has_password).toBe(false);
  });

  test('odd inputs do not break', () => {
    expect(stripAdminPassword(null)).toBe(null);
    expect(stripAdminPassword({}).admin.has_password).toBe(false);
  });
});

describe('injectAdminPassword', () => {
  test('reinjects the current password when the renderer sends none', () => {
    const cfg = buildDefaultConfig();
    const stripped = stripAdminPassword(cfg);
    const restored = injectAdminPassword(stripped, 'disk-password');
    expect(restored.admin.password).toBe('disk-password');
    expect(restored.admin.has_password).toBeUndefined();
  });

  test('if the renderer sends a new password, it wins', () => {
    const stripped = stripAdminPassword(buildDefaultConfig());
    stripped.admin.password = 'new';
    const r = injectAdminPassword(stripped, 'old');
    expect(r.admin.password).toBe('new');
  });

  test('rejects non-object inputs', () => {
    expect(() => injectAdminPassword(null, 'x')).toThrow();
  });
});

describe('serializeConfig', () => {
  test('produces a file that parses back', () => {
    const cfg = buildDefaultConfig({ modified_by: 'X' });
    const txt = serializeConfig(cfg);
    expect(txt).toContain('window.PACKPRICE_CONFIG');
    expect(extractJsonFromConfig(txt)).toEqual(cfg);
  });
});
