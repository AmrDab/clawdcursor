/**
 * The Screen Recording check (#276) asks the screenshot helper. A Mac without a built helper (#244) has nothing to ask:
 * the check must let the capture through, not throw — a throw there broke every capture and latched OCR off.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-no-helper-'));
vi.mock('../paths', async (orig) => ({ ...(await orig<typeof import('../paths')>()), getPackageRoot: () => empty }));
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, default: { ...real, homedir: () => empty }, homedir: () => empty };
});

// A Mac's probes (screencapture, osascript) exist and answer; here each one exits "not granted" — or, with
// `spawnFails`, cannot be launched at all (not on PATH), as a real spawn reports it: an 'error' event and no exit.
const probes = vi.hoisted(() => ({ spawnFails: false }));
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const spawn = () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    setImmediate(() => (probes.spawnFails ? proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })) : proc.emit('close', 1)));
    return proc;
  };
  return { ...real, default: { ...real, spawn }, spawn };
});

const REAL = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: REAL, configurable: true }); vi.resetModules(); });

describe('assertScreenRecordingGranted', () => {
  it('macOS with no helper built: nothing to ask, the capture goes ahead', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.resetModules();
    const { assertScreenRecordingGranted } = await import('../platform/native-helper');
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
  });

  it('macOS with no helpers built: the permission status still answers (falls through to the probes)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.resetModules();
    const { checkPermissionsQuick, requestPermissions } = await import('../platform/native-helper');
    const status = await checkPermissionsQuick();   // what doctor and status run
    expect(status).toMatchObject({ accessibility: false, screenRecording: false });   // every probe here exits "not granted"
    // asking for the grants needs the binary: say how to get it, not "app binary not found"
    await expect(requestPermissions()).rejects.toThrow('permission-check binary not found. Run: cd native && ./build.sh');
  }, 30_000);

  it('a probe that cannot be launched answers "not granted" — doctor and status never crash on it', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.resetModules();
    probes.spawnFails = true;
    try {
      const { checkPermissionsQuick } = await import('../platform/native-helper');
      await expect(checkPermissionsQuick()).resolves.toMatchObject({ accessibility: false, screenRecording: false });
    } finally { probes.spawnFails = false; }
  }, 30_000);

  it('not macOS: a no-op', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.resetModules();
    const { assertScreenRecordingGranted } = await import('../platform/native-helper');
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
  });
});
