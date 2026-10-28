/**
 * The Screen Recording check (#276). A nut-js grab without the grant does not fail — it returns the wallpaper — so every
 * capture is checked first, also on a Mac with no helper built (#244): there `screencapture -x`, which macOS does fail,
 * answers instead. doctor and status ask the same check, never the host app's own grant (a different TCC identity).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyResult } from '../core/result-codes';

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-no-helper-'));
const built = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-helper-'));
const helperBin = path.join(built, 'native', 'ClawdCursor.app', 'Contents', 'MacOS', 'screenshot-helper');
fs.mkdirSync(path.dirname(helperBin), { recursive: true });
fs.writeFileSync(helperBin, '');

const root = vi.hoisted(() => ({ dir: '' }));
vi.mock('../paths', async (orig) => ({ ...(await orig<typeof import('../paths')>()), getPackageRoot: () => root.dir }));
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, default: { ...real, homedir: () => empty }, homedir: () => empty };
});

// A Mac's probes (screencapture, osascript, the helper) exist and answer. `granted` decides Screen Recording: a granted
// screencapture writes its image and exits 0, a denied one exits 1; the helper's --preflight exits 0 or 2. Everything
// else exits "not granted". With `spawnFails`, nothing can be launched (not on PATH): an 'error' event and no exit.
const probes = vi.hoisted(() => ({ spawnFails: false, granted: false, calls: [] as string[] }));
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const realFs = await import('fs');
  const spawn = (cmd: string, args: string[] = []) => {
    probes.calls.push(path.basename(cmd));
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    setImmediate(() => {
      if (probes.spawnFails) return proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      if (cmd === 'screencapture') {
        if (probes.granted) realFs.writeFileSync(args[args.length - 1], Buffer.alloc(4096));
        return proc.emit('close', probes.granted ? 0 : 1);
      }
      if (args[0] === '--preflight') return proc.emit('close', probes.granted ? 0 : 2);
      proc.emit('close', 1);
    });
    return proc;
  };
  return { ...real, default: { ...real, spawn }, spawn };
});

const REAL = process.platform;
const realFetch = globalThis.fetch;
const mac = async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.resetModules();
  return import('../platform/native-helper');
};
beforeEach(() => { root.dir = empty; probes.calls.length = 0; probes.granted = false; probes.spawnFails = false; });
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL, configurable: true });
  globalThis.fetch = realFetch;
  vi.resetModules();
});

describe('assertScreenRecordingGranted', () => {
  it('macOS with no helper built: screencapture decides — a denial is CAPTURE_DENIED, never a capture', async () => {
    const { assertScreenRecordingGranted, ScreenRecordingDeniedError } = await mac();
    const err = await assertScreenRecordingGranted().catch(e => e);
    expect(err).toBeInstanceOf(ScreenRecordingDeniedError);
    expect(probes.calls).toEqual(['screencapture']);
    expect(classifyResult(err.message, true, true)).toMatchObject({ code: 'CAPTURE_DENIED', outcome: 'refused' });
    // the text names both identities TCC can mean: the launching app, or (no app above it) the binaries themselves
    expect(err.message).toMatch(/app running clawdcursor \(terminal or MCP host\).*launchd, ssh.*node and screenshot-helper/);
  });

  it('macOS with no helper built: a granted screencapture lets the capture go ahead, and leaves no file behind', async () => {
    probes.granted = true;
    const before = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('.clawdcursor-probe-')).length;
    const { assertScreenRecordingGranted } = await mac();
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
    expect(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('.clawdcursor-probe-')).length).toBe(before);
  });

  it('a grant is cached for the process; a denial is not', async () => {
    const { assertScreenRecordingGranted } = await mac();
    await expect(assertScreenRecordingGranted()).rejects.toThrow('Screen Recording permission denied');
    await expect(assertScreenRecordingGranted()).rejects.toThrow('Screen Recording permission denied');
    expect(probes.calls).toHaveLength(2);   // each denied capture asks again
    probes.granted = true;                  // granted in System Settings
    await assertScreenRecordingGranted();
    await assertScreenRecordingGranted();
    await assertScreenRecordingGranted();
    expect(probes.calls).toHaveLength(3);   // asked once more, then never again
  });

  it('macOS with the helper built: its --preflight decides, not screencapture', async () => {
    root.dir = built;
    const { assertScreenRecordingGranted, ScreenRecordingDeniedError } = await mac();
    await expect(assertScreenRecordingGranted()).rejects.toBeInstanceOf(ScreenRecordingDeniedError);
    probes.granted = true;
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
    expect(probes.calls).toEqual(['screenshot-helper', 'screenshot-helper']);
  });

  it('a check that cannot run is no answer, not a denial: the capture goes ahead with a warning', async () => {
    probes.spawnFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { assertScreenRecordingGranted } = await mac();
      await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not answer'));
    } finally { warn.mockRestore(); }
  });

  it('not macOS: a no-op', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.resetModules();
    const { assertScreenRecordingGranted } = await import('../platform/native-helper');
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
    expect(probes.calls).toEqual([]);
  });
});

describe('doctor / status (checkPermissionsQuick) ask the capture gate\'s question', () => {
  // The host app answers for ClawdCursor.app's own TCC entry, which captures never use: on a real Mac it said
  // "denied" while captures worked. Screen Recording must follow the gate's check whatever the host says.
  const hostSays = (screenRecording: boolean) => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).endsWith('/status') ? { accessibility: true, screenRecording, bundleId: 'com.clawdcursor.app' } : {},
    ))) as typeof fetch;
  };

  for (const granted of [true, false]) {
    it(`gate ${granted ? 'granted' : 'denied'}, host says the opposite: doctor agrees with the gate`, async () => {
      hostSays(!granted);
      probes.granted = granted;
      const { checkPermissionsQuick, assertScreenRecordingGranted } = await mac();
      const gate = await assertScreenRecordingGranted().then(() => true, () => false);
      const status = await checkPermissionsQuick();
      expect(gate).toBe(granted);
      expect(status.screenRecording).toBe(granted);
    });
  }

  it('macOS with no helpers built: the permission status still answers (falls through to the probes)', async () => {
    const { checkPermissionsQuick, requestPermissions } = await mac();
    const status = await checkPermissionsQuick();   // what doctor and status run
    expect(status).toMatchObject({ accessibility: false, screenRecording: false });   // every probe here exits "not granted"
    // asking for the grants needs the binary: say how to get it — an npm install has no ./native to cd into
    const err = await requestPermissions().catch(e => e);
    expect(err.message).toContain('permission-check binary not found');
    expect(err.message).toContain('xcode-select --install');
    expect(err.message).toContain(`node "${path.join(empty, 'scripts', 'postinstall-native.js')}"`);
  }, 30_000);

  it('a probe that cannot be launched answers "not granted" — doctor and status never crash on it', async () => {
    probes.spawnFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { checkPermissionsQuick } = await mac();
      await expect(checkPermissionsQuick()).resolves.toMatchObject({ accessibility: false, screenRecording: false });
    } finally { warn.mockRestore(); }
  }, 30_000);
});
