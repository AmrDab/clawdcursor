/**
 * The Screen Recording check (#276). A nut-js grab without the grant does not fail — it returns the wallpaper — so every
 * capture is checked first, also on a Mac with no helper built (#244): there CGPreflightScreenCaptureAccess is asked
 * through osascript's JavaScript bridge (no capture, no prompt, no flash). doctor and status ask the same check, never
 * the host app's own grant (a different TCC identity).
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

// A Mac's checks exist and answer. `granted` decides Screen Recording: the helper's --preflight exits 0 or 2, the
// osascript bridge prints true or false. `helper` / `jxa` override those answers; `captureExit` is a helper capture's
// exit. Everything else exits "not granted". `spawnFails`: nothing can be launched ('error', no exit). `hang`: no answer.
const probes = vi.hoisted(() => ({
  spawnFails: false, hang: false, granted: false, calls: [] as string[], argv: [] as string[][], captureExit: 1,
  helper: null as null | { code: number; stderr?: string },
  jxa: null as null | { code: number; out: string },
}));
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const spawn = (cmd: string, args: string[] = []) => {
    probes.calls.push(path.basename(cmd));
    probes.argv.push(args);
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    if (probes.hang) return proc;
    const answer = (code: number, out = '', err = '') => {
      if (out) proc.stdout.emit('data', out);
      if (err) proc.stderr.emit('data', err);
      proc.emit('close', code);
    };
    setImmediate(() => {
      if (probes.spawnFails) return proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      if (args[0] === '--preflight') {
        const h = probes.helper ?? { code: probes.granted ? 0 : 2 };
        return answer(h.code, '', h.stderr);
      }
      if (cmd === 'osascript' && args.join(' ').includes('CGPreflightScreenCaptureAccess')) {
        const j = probes.jxa ?? { code: 0, out: `${probes.granted}\n` };
        return answer(j.code, j.out);
      }
      if (args[0] === '--fullscreen') {
        return answer(probes.captureExit, probes.captureExit === 0 ? '{"success":true,"path":"/x.png","width":2,"height":2}' : '');
      }
      answer(1);
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
const OLD_USAGE = 'usage: screenshot-helper <windowId|--fullscreen> <outputPath>\n';   // main.swift's usage line
beforeEach(() => {
  root.dir = empty; probes.calls.length = 0; probes.argv.length = 0; probes.granted = false; probes.spawnFails = false; probes.hang = false;
  probes.helper = null; probes.jxa = null; probes.captureExit = 1;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL, configurable: true });
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.resetModules();
});

describe('screenRecordingGranted / assertScreenRecordingGranted', () => {
  it('macOS with no helper built: the osascript bridge decides — a denial is CAPTURE_DENIED, never a capture', async () => {
    const { assertScreenRecordingGranted, ScreenRecordingDeniedError } = await mac();
    const err = await assertScreenRecordingGranted().catch(e => e);
    expect(err).toBeInstanceOf(ScreenRecordingDeniedError);
    expect(probes.calls).toEqual(['osascript']);   // a preflight, not screencapture: no prompt, no flash
    expect(classifyResult(err.message, true, true)).toMatchObject({ code: 'CAPTURE_DENIED', outcome: 'refused' });
    // the text names both identities TCC can mean: the launching app, or (no app above it) the binaries themselves
    expect(err.message).toMatch(/app running clawdcursor \(terminal or MCP host\).*launchd, ssh.*node and screenshot-helper/);
  });

  it('osascript: "true" is granted, "false" denied; garbage or an error is no answer, and none of those are cached but a grant', async () => {
    const cases: Array<[{ code: number; out: string }, boolean | null]> = [
      [{ code: 0, out: 'true\n' }, true],
      [{ code: 0, out: 'false\n' }, false],
      [{ code: 0, out: 'undefined\n' }, null],
      [{ code: 1, out: '' }, null],   // e.g. "execution error: … CGPreflightScreenCaptureAccess is not a function"
    ];
    for (const [jxa, expected] of cases) {
      probes.jxa = jxa;
      probes.calls.length = 0;
      const { screenRecordingGranted } = await mac();
      expect(await screenRecordingGranted()).toBe(expected);
      await screenRecordingGranted();
      expect(probes.calls).toHaveLength(expected === true ? 1 : 2);   // only a grant is cached
    }
  });

  it('the osascript call coerces the bridge\'s answer to "true"/"false" (a 1/0 still parses)', async () => {
    const { screenRecordingGranted, PREFLIGHT_JXA } = await mac();
    await screenRecordingGranted();
    // Bound by hand: the CoreGraphics bridge does not declare it (real macOS 26.5: "is not a function").
    expect(PREFLIGHT_JXA).toBe(
      "ObjC.import('CoreGraphics'); ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); " +
      'String(Boolean($.CGPreflightScreenCaptureAccess()))');
    expect(probes.argv).toEqual([['-l', 'JavaScript', '-e', PREFLIGHT_JXA]]);
  });

  it('a capture that went ahead unchecked is remembered for the screenshot reply; a checked one clears it', async () => {
    root.dir = built;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { assertScreenRecordingGranted, captureScreenViaHelper, lastCaptureUnchecked } = await mac();
      expect(lastCaptureUnchecked()).toBe(false);
      probes.helper = { code: 127 };              // no answer: the grab goes ahead
      await assertScreenRecordingGranted();
      expect(lastCaptureUnchecked()).toBe(true);
      probes.captureExit = 0;                     // a helper capture checks the grant itself
      await captureScreenViaHelper();
      expect(lastCaptureUnchecked()).toBe(false);
      await assertScreenRecordingGranted();
      expect(lastCaptureUnchecked()).toBe(true);
      probes.helper = null; probes.granted = true;   // answered: granted
      await assertScreenRecordingGranted();
      expect(lastCaptureUnchecked()).toBe(false);
    } finally { warn.mockRestore(); }
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

  it('macOS with the helper built: its --preflight decides, not osascript', async () => {
    root.dir = built;
    const { assertScreenRecordingGranted, ScreenRecordingDeniedError } = await mac();
    await expect(assertScreenRecordingGranted()).rejects.toBeInstanceOf(ScreenRecordingDeniedError);
    probes.granted = true;
    await expect(assertScreenRecordingGranted()).resolves.toBeUndefined();
    expect(probes.calls).toEqual(['screenshot-helper', 'screenshot-helper']);
  });

  it('helper exit 1 is a grant only with the older helper\'s usage line; 1 without it, 126, 127 are no answer, not cached', async () => {
    root.dir = built;
    const cases: Array<[{ code: number; stderr?: string }, boolean | null]> = [
      [{ code: 1, stderr: OLD_USAGE }, true],
      [{ code: 1, stderr: 'dyld: Library not loaded: @rpath/libswiftCore.dylib\n' }, null],
      [{ code: 126 }, null],
      [{ code: 127 }, null],
    ];
    for (const [helper, expected] of cases) {
      probes.helper = helper;
      probes.calls.length = 0;
      const { screenRecordingGranted } = await mac();
      expect(await screenRecordingGranted()).toBe(expected);
      await screenRecordingGranted();
      expect(probes.calls).toHaveLength(expected === true ? 1 : 2);
    }
  });

  for (const [where, dir] of [['the helper', () => built], ['osascript', () => empty]] as const) {
    it(`${where} not answering within 5s is no answer (null), not cached`, async () => {
      root.dir = dir();
      probes.hang = true;
      const { screenRecordingGranted } = await mac();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = screenRecordingGranted();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
      const again = screenRecordingGranted();
      await vi.advanceTimersByTimeAsync(5000);
      await again;
      expect(probes.calls).toHaveLength(2);
    });
  }

  it('a helper capture that fails (not a denial) drops the cached grant: the next capture is checked again', async () => {
    root.dir = built;
    probes.granted = true;
    const { assertScreenRecordingGranted, captureScreenViaHelper, ScreenRecordingDeniedError } = await mac();
    await assertScreenRecordingGranted();
    await assertScreenRecordingGranted();
    expect(probes.calls).toEqual(['screenshot-helper']);   // cached
    const err = await captureScreenViaHelper().catch(e => e);
    expect(err).not.toBeInstanceOf(ScreenRecordingDeniedError);
    expect(err.message).toContain('screenshot-helper failed (exit 1)');
    await assertScreenRecordingGranted();
    expect(probes.calls).toEqual(['screenshot-helper', 'screenshot-helper', 'screenshot-helper']);   // capture, then asked again
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
      const status = await checkPermissionsQuick();   // first, so it runs the check itself (no cached grant yet)
      expect(probes.calls).toContain('osascript');
      const gate = await assertScreenRecordingGranted().then(() => true, () => false);
      expect(status.screenRecording).toBe(granted);
      expect(gate).toBe(granted);
    });
  }

  it('a check with no answer is "could not check" (null), not DENIED', async () => {
    probes.jxa = { code: 0, out: 'garbage\n' };
    const { checkPermissionsQuick } = await mac();
    expect((await checkPermissionsQuick()).screenRecording).toBeNull();
  });

  it('macOS with no helpers built: the permission status still answers (falls through to the probes)', async () => {
    const { checkPermissionsQuick, requestPermissions } = await mac();
    const status = await checkPermissionsQuick();   // what doctor and status run
    expect(status).toMatchObject({ accessibility: false, screenRecording: false });   // every probe here says "not granted"
    // asking for the grants needs the binary: say how to get it — an npm install has no ./native to cd into
    const err = await requestPermissions().catch(e => e);
    expect(err.message).toContain('permission-check binary not found');
    expect(err.message).toContain('xcode-select --install');
    expect(err.message).toContain(`node "${path.join(empty, 'scripts', 'postinstall-native.js')}"`);
  }, 30_000);

  it('a probe that cannot be launched never crashes doctor and status: Accessibility "not granted", Screen Recording unknown', async () => {
    probes.spawnFails = true;
    const { checkPermissionsQuick } = await mac();
    await expect(checkPermissionsQuick()).resolves.toMatchObject({ accessibility: false, screenRecording: null });
  }, 30_000);
});
