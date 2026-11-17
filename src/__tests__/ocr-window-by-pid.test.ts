/**
 * `system ocr` with processId: that process's largest window, drawn by itself (owner, 2026-11-17: "build the background
 * window read by pid"). Its own pixels, even where other windows cover it, so no other app's text is read, and nothing
 * is raised or focused. A platform that cannot draw a window by itself reads nothing.
 *
 * The bridge's capture itself runs for real in capture-window-covered.system.test.ts (Windows).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: { config: {}, grab: vi.fn() },
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }), Point: class {}, Region: class {},
}));
const engine = vi.hoisted(() => ({
  recognizeImage: vi.fn(), recognizeScreen: vi.fn(), recognizeRegion: vi.fn(),
}));
vi.mock('../platform/ocr-engine', async (orig) => ({
  ...(await orig<typeof import('../platform/ocr-engine')>()),
  ocrEngine: () => ({ isAvailable: () => true, invalidateCache() {}, ...engine }),
}));
vi.mock('../platform/mac-ax', async (orig) => ({ ...(await orig<typeof import('../platform/mac-ax')>()), screenLockedMessage: async () => null }));
const ps = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../platform/ps-runner', () => ({ psRunner: ps }));
const helper = vi.hoisted(() => ({ captureWindowViaHelper: vi.fn() }));
vi.mock('../platform/native-helper', async (orig) => ({ ...(await orig<typeof import('../platform/native-helper')>()), ...helper }));

import { getOcrTools } from '../tools/ocr';
import { getCompactTools } from '../tools/compact';
import { ScreenRecordingDeniedError } from '../platform/native-helper';
import { WindowsAdapter } from '../platform/windows';
import { MacOSAdapter } from '../platform/macos';
import { createMacAx } from '../platform/mac-ax';
import type { WindowCapture } from '../platform/types';
import { classifyResult } from '../core/result-codes';

const ocr = () => getOcrTools()[0];
const QUOKKA = { text: 'QUOKKA', x: 230, y: 80, width: 200, height: 40, line: 0 };
// A DPI-unaware window at 225%: drawn at 640x240, shown at 1440x540 physical pixels.
const CAPTURE: WindowCapture = { png: Buffer.from('png'), bounds: { x: 100, y: 200, width: 1440, height: 540 }, pixelsPerUnit: 640 / 1440, title: 'Notes' };
const ctx = (platform: object | undefined) => ({
  ensureInitialized: async () => {}, platform, a11y: { invalidateCache() {} },
  desktop: { getDpiRatio: () => 1 }, cdp: {}, getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
}) as any;

beforeEach(() => {
  for (const f of Object.values(engine)) f.mockReset();
  engine.recognizeImage.mockResolvedValue({ elements: [QUOKKA], fullText: 'QUOKKA', durationMs: 12 });
});

describe('ocr with processId', () => {
  it('reads that window by itself: rows where the text is on screen, nothing focused, the screen never read', async () => {
    const captureWindowOf = vi.fn(async () => CAPTURE);
    const focusWindow = vi.fn();
    const r = await ocr().handler({ processId: 4242 }, ctx({ captureWindowOf, focusWindow }));
    expect(captureWindowOf).toHaveBeenCalledWith(4242);
    expect(engine.recognizeImage).toHaveBeenCalledWith(CAPTURE.png);
    expect(engine.recognizeScreen).not.toHaveBeenCalled();
    expect(engine.recognizeRegion).not.toHaveBeenCalled();
    expect(focusWindow).not.toHaveBeenCalled();
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^OCR of the window of process 4242 at \(100,200\) 1440x540, drawn by itself \(windows on top of it are not in the read\): 1 rows \(1 words\)/);
    // The text's centre (330,100) in the image, at 640/1440 image pixels per screen pixel, from the window's corner.
    expect(r.text).toContain('@843,425 "QUOKKA"');
    expect(r.text).toContain('focus this window first (window {"action":"focus","processId":4242})');
    // The title is screen content: inside the untrusted block, never in the trusted header.
    expect(r.text).toMatch(/<untrusted-screen-content>[\s\S]*window: Notes/);
  });

  it('a Retina capture (2 image pixels per point) maps back to points', async () => {
    const captureWindowOf = vi.fn(async () => ({ ...CAPTURE, bounds: { x: 80, y: 60, width: 1000, height: 900 }, pixelsPerUnit: 2 }));
    const r = await ocr().handler({ processId: 7 }, ctx({ captureWindowOf }));
    expect(r.text).toContain('@245,110 "QUOKKA"');
  });

  it('scope is not used: processId reads the window, not the screen', async () => {
    await ocr().handler({ processId: 7, scope: 'screen' }, ctx({ captureWindowOf: async () => CAPTURE }));
    expect(engine.recognizeScreen).not.toHaveBeenCalled();
  });

  it('no window on screen (none, or minimized): an error, nothing read', async () => {
    const r = await ocr().handler({ processId: 7 }, ctx({ captureWindowOf: async () => null }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No window for that process on screen \(process 7: none open, or minimized\), so nothing was read/);
    // Mac, 2026-11-17: it read as UNKNOWN with "read the screen"; a missing window is NOT_FOUND, and the next call lists them.
    expect(classifyResult(r.text!, true, false)).toMatchObject({ outcome: 'failed', code: 'NOT_FOUND', next: 'window {"action":"list"}' });
    expect(engine.recognizeImage).not.toHaveBeenCalled();
  });

  it('a platform that cannot draw a window by itself reads nothing, and says how to read it', async () => {
    for (const platform of [{}, undefined]) {
      const r = await ocr().handler({ processId: 7 }, ctx(platform));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/cannot read one window by itself on this platform, so nothing was read/);
      expect(r.text).toContain('window {"action":"focus","processId":7}');
    }
    expect(engine.recognizeScreen).not.toHaveBeenCalled();
    expect(engine.recognizeRegion).not.toHaveBeenCalled();
  });

  it('a window that cannot be drawn: an error with the reason; a Screen Recording refusal is thrown as it is', async () => {
    const r = await ocr().handler({ processId: 7 }, ctx({ captureWindowOf: async () => { throw new Error('the window is not responding, so it could not be drawn'); } }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Could not read the window of process 7 by itself \(the window is not responding/);
    await expect(ocr().handler({ processId: 7 }, ctx({ captureWindowOf: async () => { throw new ScreenRecordingDeniedError(); } })))
      .rejects.toBeInstanceOf(ScreenRecordingDeniedError);
  });

  it('no text in the window: said, with how to read what is on screen there', async () => {
    engine.recognizeImage.mockResolvedValue({ elements: [], fullText: '', durationMs: 3 });
    const r = await ocr().handler({ processId: 7 }, ctx({ captureWindowOf: async () => CAPTURE }));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/No text read in the window of process 7 .* drawn by itself/);
    expect(r.text).toContain('then ocr with scope "window"');
  });

  it('through the compact system tool: processId is taken, not refused or warned about', async () => {
    const system = getCompactTools().find(t => t.name === 'system')!;
    const r = await system.handler({ action: 'ocr', processId: 4242 }, ctx({ captureWindowOf: async () => CAPTURE }));
    expect(r.text).toContain('@843,425 "QUOKKA"');
    expect(r.text).not.toMatch(/NOT EXECUTED|ignored an argument/);
  });
});

describe('WindowsAdapter.captureWindowOf (the bridge\'s capture-window)', () => {
  const capture = (pid: number) => WindowsAdapter.prototype.captureWindowOf.call({} as WindowsAdapter, pid);
  beforeEach(() => ps.run.mockReset());

  it('maps the reply: where the window is, and the image at the window\'s own DPI', async () => {
    ps.run.mockResolvedValue({ success: true, x: 100, y: 200, width: 1440, height: 540, imageWidth: 640, imageHeight: 240, title: 'Notes', png: Buffer.from('img').toString('base64') });
    const c = await capture(4242);
    expect(ps.run).toHaveBeenCalledWith({ cmd: 'capture-window', pid: 4242 });
    expect(c).toEqual({ png: Buffer.from('img'), bounds: { x: 100, y: 200, width: 1440, height: 540 }, pixelsPerUnit: 640 / 1440, title: 'Notes' });
  });

  it('no window: null; not responding or not drawn: thrown', async () => {
    ps.run.mockResolvedValue({ success: false, reason: 'no-window' });
    await expect(capture(1)).resolves.toBeNull();
    ps.run.mockResolvedValue({ success: false, reason: 'not-responding' });
    await expect(capture(1)).rejects.toThrow(/not responding/);
    ps.run.mockResolvedValue({ success: false, reason: 'not-drawn' });
    await expect(capture(1)).rejects.toThrow(/could not be drawn by itself/);
  });
});

describe('macOS: ax-helper window-of, then the screenshot helper\'s window mode', () => {
  const savedNoMacAx = process.env.CLAWD_NO_MAC_AX;
  let dir: string;
  beforeEach(() => { process.env.CLAWD_NO_MAC_AX = '0'; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-of-')); helper.captureWindowViaHelper.mockReset(); });
  afterEach(() => { process.env.CLAWD_NO_MAC_AX = savedNoMacAx; fs.rmSync(dir, { recursive: true, force: true }); });

  const axWith = (stdout: string, calls: string[][] = []) => createMacAx({
    helper: () => '/fake/ax-helper', ensureHelper: async () => '/fake/ax-helper', scriptsDir: '/fake/scripts/mac',
    exec: async (_file, args) => { calls.push(args); return { stdout }; },
  });

  it('window-of: the window number and bounds in points; none is null', async () => {
    const calls: string[][] = [];
    const ax = axWith(JSON.stringify({ ok: true, window: { id: 812, x: 80, y: 60, width: 1000, height: 900, processName: 'TextEdit' } }), calls);
    expect(await ax.windowOf!(4242)).toEqual({ id: 812, x: 80, y: 60, width: 1000, height: 900, processName: 'TextEdit' });
    expect(calls[0].slice(0, 3)).toEqual(['window-of', '--pid', '4242']);
    expect(await axWith(JSON.stringify({ ok: true, window: null })).windowOf!(4242)).toBeNull();
  });

  it('captureWindowOf: that window by itself, at the helper\'s pixels per point, and the temp file removed', async () => {
    const file = path.join(dir, 'w.png');
    fs.writeFileSync(file, 'img');
    helper.captureWindowViaHelper.mockResolvedValue({ path: file, width: 2000, height: 1800 });
    const self = { ax: { windowOf: async () => ({ id: 812, x: 80, y: 60, width: 1000, height: 900, processName: 'TextEdit' }) } };
    const c = await MacOSAdapter.prototype.captureWindowOf.call(self as unknown as MacOSAdapter, 4242);
    expect(helper.captureWindowViaHelper).toHaveBeenCalledWith(812);
    expect(c).toEqual({ png: Buffer.from('img'), bounds: { x: 80, y: 60, width: 1000, height: 900 }, pixelsPerUnit: 2, title: 'TextEdit' });
    expect(fs.existsSync(file)).toBe(false);
    const none = { ax: { windowOf: async () => null } };
    await expect(MacOSAdapter.prototype.captureWindowOf.call(none as unknown as MacOSAdapter, 4242)).resolves.toBeNull();
  });
});
