// ============================================================
// Tests · lib/logger.js (electron-log wrapper)
// ============================================================
// We don't bring up an Electron runtime; we point the logger at a
// temp directory and assert that lines reach the file and that
// `readLastLines` returns them.
//
// Note: configureLogger() is intentionally idempotent (the real
// app calls it once at startup), so each test resets internal
// module state by clearing the require cache before running.
// ============================================================

import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-log-'));
}

function loadLoggerFresh() {
  // Drop both the wrapper and electron-log from the cache so each
  // test starts with a fresh, unconfigured instance.
  const wrapperPath = require.resolve('../lib/logger.js');
  const electronLogPath = require.resolve('electron-log/main');
  delete require.cache[wrapperPath];
  delete require.cache[electronLogPath];
  return require('../lib/logger.js');
}

const cleanup = [];
afterAll(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

describe('configureLogger + logger', () => {
  let dir;
  let mod;

  beforeEach(() => {
    dir = tmpDir();
    cleanup.push(dir);
    mod = loadLoggerFresh();
  });

  test('creates the log file at the resolved path', async () => {
    const logPath = mod.configureLogger({ logDir: dir, fileName: 'main.log' });
    expect(logPath).toBe(path.join(dir, 'main.log'));
    mod.logger.info('boot', { ok: true });
    await waitForFile(logPath);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  test('readLastLines returns the latest lines in order', async () => {
    const logPath = mod.configureLogger({ logDir: dir, fileName: 'main.log' });
    mod.logger.info('one');
    mod.logger.warn('two');
    mod.logger.error('three');
    await waitForFile(logPath, /three/);
    const tail = mod.readLastLines(10);
    expect(tail.length).toBe(3);
    expect(tail[0]).toMatch(/one/);
    expect(tail[2]).toMatch(/three/);
  });

  test('appends JSON context when provided', async () => {
    const logPath = mod.configureLogger({ logDir: dir, fileName: 'main.log' });
    mod.logger.warn('config:write conflict detected', { ruta: 'X', usuario: 'Alberto' });
    await waitForFile(logPath, /conflict/);
    const tail = mod.readLastLines(5).join('\n');
    expect(tail).toMatch(/"usuario":"Alberto"/);
    expect(tail).toMatch(/\[warn\]/);
  });

  test('readLastLines returns [] when the file does not exist yet', () => {
    // logger not configured / no file written
    expect(mod.readLastLines(10)).toEqual([]);
  });

  test('configureLogger is idempotent (second call returns same path)', () => {
    const a = mod.configureLogger({ logDir: dir, fileName: 'main.log' });
    const b = mod.configureLogger({ logDir: tmpDir(), fileName: 'other.log' });
    expect(a).toBe(b);
  });
});

// electron-log writes asynchronously. Poll for the file to exist
// (and optionally contain a substring) for up to 1.5s before failing.
async function waitForFile(filePath, contentMatcher = null, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      if (!contentMatcher) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      if (contentMatcher.test(content)) return;
    }
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}
