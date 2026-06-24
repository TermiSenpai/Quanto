// ============================================================
// Tests · lib/app-updater.js
// ============================================================
import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireUpdater } from '../lib/app-updater.js';

function fakeUpdater() {
  const ee = new EventEmitter();
  ee.checkForUpdates = vi.fn();
  ee.quitAndInstall = vi.fn();
  return ee;
}

describe('wireUpdater event → state mapping', () => {
  test('maps each electron-updater event to a phase', () => {
    const updater = fakeUpdater();
    const states = [];
    wireUpdater({ updater, isPackaged: true, onState: (s) => states.push(s) });

    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '5.1.0' });
    updater.emit('download-progress', { percent: 42.7 });
    updater.emit('update-downloaded', { version: '5.1.0' });
    updater.emit('update-not-available', {});
    updater.emit('error', new Error('boom'));

    expect(states).toEqual([
      { phase: 'checking' },
      { phase: 'downloading', version: '5.1.0' },
      { phase: 'downloading', percent: 43 },
      { phase: 'ready', version: '5.1.0' },
      { phase: 'idle' },
      { phase: 'error', error: 'boom' }
    ]);
  });

  test('checkForUpdates delegates to the updater when packaged', () => {
    const updater = fakeUpdater();
    const api = wireUpdater({ updater, isPackaged: true, onState: () => {} });
    api.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('quitAndInstall delegates to the updater when packaged', () => {
    const updater = fakeUpdater();
    const api = wireUpdater({ updater, isPackaged: true, onState: () => {} });
    api.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('dev guard: checkForUpdates emits dev phase and does NOT call the updater', () => {
    const updater = fakeUpdater();
    const states = [];
    const api = wireUpdater({ updater, isPackaged: false, onState: (s) => states.push(s) });
    api.checkForUpdates();
    api.quitAndInstall();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(states).toEqual([{ phase: 'dev' }]);
  });

  test('a throwing onState never propagates out of an event', () => {
    const updater = fakeUpdater();
    wireUpdater({ updater, isPackaged: true, onState: () => { throw new Error('ui blew up'); } });
    expect(() => updater.emit('checking-for-update')).not.toThrow();
  });
});
