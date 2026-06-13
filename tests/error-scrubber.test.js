// ============================================================
// Tests · lib/error-scrubber.js
// ============================================================
// The scrubber is the security boundary of the error-telemetry
// feature (PRD R19): it must produce a WHITELISTED payload and must
// strip anything that looks like a secret or business data, even when
// it is embedded inside the error message or stack trace.
import { describe, test, expect } from 'vitest';
import { scrubError, WHITELIST_FIELDS, MAX_MESSAGE_LEN, MAX_STACK_LEN } from '../lib/error-scrubber.js';

describe('scrubError · whitelist shape', () => {
  test('returns ONLY the whitelisted fields and nothing else', () => {
    const err = new TypeError('boom');
    const out = scrubError(err, {
      app_version: '5.0.0-beta',
      schema_version: 1,
      os: 'win32 10.0.26200',
      arch: 'x64',
      data_source: 'cloud',
      // hostile extras that must never survive
      secret: 'tok',
      cloud: { token: 'abc' },
      catalog: { price: 12.5 }
    });
    expect(Object.keys(out).sort()).toEqual([...WHITELIST_FIELDS].sort());
    expect(out).not.toHaveProperty('secret');
    expect(out).not.toHaveProperty('cloud');
    expect(out).not.toHaveProperty('catalog');
  });

  test('passes the whitelisted meta fields through', () => {
    const out = scrubError(new Error('x'), {
      app_version: '5.0.0-beta',
      schema_version: 3,
      os: 'win32 10.0.26200',
      arch: 'x64',
      data_source: 'file'
    });
    expect(out.app_version).toBe('5.0.0-beta');
    expect(out.schema_version).toBe(3);
    expect(out.os).toBe('win32 10.0.26200');
    expect(out.arch).toBe('x64');
    expect(out.data_source).toBe('file');
  });

  test('captures the error type and message', () => {
    const out = scrubError(new RangeError('out of range'));
    expect(out.type).toBe('RangeError');
    expect(out.message).toBe('out of range');
  });

  test('tolerates a non-Error reason (string / null / object)', () => {
    expect(scrubError('plain string reason').message).toContain('plain string reason');
    expect(() => scrubError(null)).not.toThrow();
    expect(() => scrubError(undefined)).not.toThrow();
    expect(() => scrubError({ weird: true })).not.toThrow();
    const out = scrubError(null);
    expect(typeof out.message).toBe('string');
    expect(typeof out.type).toBe('string');
  });

  test('missing meta yields whitelist keys with null values, never extra keys', () => {
    const out = scrubError(new Error('x'));
    expect(Object.keys(out).sort()).toEqual([...WHITELIST_FIELDS].sort());
    expect(out.app_version).toBeNull();
    expect(out.data_source).toBeNull();
  });
});

describe('scrubError · secret + business-data redaction', () => {
  test('redacts a Cloudflare-token-like long run in the message', () => {
    const token = 'vK9zT3xQ1aB7cD2eF4gH6jK8lM0nP1qR3sT5uV7w';
    const out = scrubError(new Error(`auth failed for token ${token}`));
    expect(out.message).not.toContain(token);
    expect(out.message).toMatch(/\[REDACTED\]|\[REDACTADO\]/);
  });

  test('redacts a long hex run (account/database id)', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const out = scrubError(new Error(`db ${hex} not found`));
    expect(out.message).not.toContain(hex);
  });

  test('redacts a base64-ish secret embedded in a stack', () => {
    const secret = 'QWxhZGRpbjpvcGVuU2VzYW1lMTIzNDU2Nzg5MA==';
    const err = new Error('boom');
    err.stack = `Error: boom\n    at decode (${secret})`;
    const out = scrubError(err);
    expect(out.stack).not.toContain(secret);
  });

  test('redacts an email address in message and stack', () => {
    const err = new Error('mail to cliente@empresa.es failed');
    err.stack = 'Error\n    at send (otro@correo.com)';
    const out = scrubError(err);
    expect(out.message).not.toContain('cliente@empresa.es');
    expect(out.message).not.toContain('@');
    expect(out.stack).not.toContain('otro@correo.com');
  });

  test('redacts a phone-like substring', () => {
    const out = scrubError(new Error('llamar a 612345678 urgente'));
    expect(out.message).not.toContain('612345678');
    const out2 = scrubError(new Error('tel +34 612 34 56 78'));
    expect(out2.message).not.toMatch(/612 34 56 78/);
  });

  test('redacts an absolute Windows user path to its basename', () => {
    const err = new Error('cannot read C:\\Users\\Alberto\\AppData\\Roaming\\packprice\\settings.json');
    const out = scrubError(err);
    expect(out.message).not.toContain('Alberto');
    expect(out.message).not.toContain('C:\\Users');
    expect(out.message).toContain('settings.json');
  });

  test('redacts absolute Windows paths inside a stack trace', () => {
    const err = new Error('boom');
    err.stack = [
      'Error: boom',
      '    at Object.<anonymous> (C:\\Users\\Alberto\\Desktop\\packs app\\main.js:10:5)',
      '    at Module._compile (D:\\secret\\Cliente Importante\\calculo.js:99:1)'
    ].join('\n');
    const out = scrubError(err);
    expect(out.stack).not.toContain('Alberto');
    expect(out.stack).not.toContain('Cliente Importante');
    expect(out.stack).not.toContain('C:\\Users');
    expect(out.stack).toContain('main.js');
    expect(out.stack).toContain('calculo.js');
  });

  test('redacts a POSIX absolute path to its basename', () => {
    const out = scrubError(new Error('open /home/alberto/.config/packprice/token.txt'));
    expect(out.message).not.toContain('/home/alberto');
    expect(out.message).not.toContain('alberto');
    expect(out.message).toContain('token.txt');
  });

  test('a catalog value (price) buried in a message survives only as text, never as a leaked field', () => {
    // The scrubber cannot know an arbitrary number is a price; what it
    // guarantees is the WHITELIST: no catalog object/field leaks through.
    const out = scrubError(new Error('validation failed: pvp 47.50 below cost'), {
      catalog: { secret_price: 47.5 },
      cloud: { token: 'tok-xyz-very-secret-value-1234567890' }
    });
    expect(out).not.toHaveProperty('catalog');
    expect(out).not.toHaveProperty('cloud');
    // The injected token (a long run) must be gone even from nowhere it
    // can reach — it was never in the message, so message is clean.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('tok-xyz-very-secret-value-1234567890');
    expect(serialized).not.toContain('secret_price');
  });

  test('redacts a token even when it appears inside the stack', () => {
    const token = 'vK9zT3xQ1aB7cD2eF4gH6jK8lM0nP1qR3sT5uV7w';
    const err = new Error('boom');
    err.stack = `Error: boom\n    at auth (token=${token})`;
    const out = scrubError(err);
    expect(out.stack).not.toContain(token);
    expect(JSON.stringify(out)).not.toContain(token);
  });
});

describe('scrubError · length caps', () => {
  test('caps the message length', () => {
    const long = 'a'.repeat(MAX_MESSAGE_LEN + 5000);
    const out = scrubError(new Error(long));
    expect(out.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  });

  test('caps the stack length', () => {
    const err = new Error('x');
    err.stack = 'y'.repeat(MAX_STACK_LEN + 5000);
    const out = scrubError(err);
    expect(out.stack.length).toBeLessThanOrEqual(MAX_STACK_LEN);
  });
});
