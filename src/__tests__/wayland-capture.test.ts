/**
 * Wayland survival: nut-js screen APIs must never run on a Wayland session.
 *
 * libnut opens the X11 display for every screen call — with no DISPLAY it
 * segfaults ("Could not open main display"), and under rootless XWayland its
 * root-window XGetImage is a fatal BadMatch that exits the process. Neither
 * can be caught in JS, so the only fix is routing: grim for pixels, swaymsg /
 * wlr-randr / xrandr for geometry, and an honest error when grim is missing.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import sharp from 'sharp';

const nutScreen = vi.hoisted(() => {
  const boom = (name: string) => vi.fn(async () => { throw new Error(`nut-js screen.${name} touched X11`); });
  return { grab: boom('grab'), grabRegion: boom('grabRegion'), width: boom('width'), height: boom('height') };
});
const calls = vi.hoisted(() => [] as Array<[string, string[]]>);
const state = vi.hoisted(() => ({ grim: true, png: Buffer.alloc(0) }));

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, setPosition: vi.fn(), getPosition: vi.fn(async () => ({ x: 0, y: 0 })) },
  keyboard: { config: {} },
  screen: { config: {}, ...nutScreen },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: vi.fn(), unlinkSync: vi.fn() };
});

const SWAY_OUTPUTS = JSON.stringify([
  { name: 'eDP-1', active: true, focused: true, scale: 2, rect: { x: 0, y: 0, width: 1280, height: 800 }, current_mode: { width: 2560, height: 1600 } },
]);

vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    // hasBinary(): `command -v <name>` / `which <name>`
    if (cmd === 'command' || cmd === 'which') {
      const name = args[args.length - 1];
      if (name === 'grim' && state.grim) return { stdout: '/usr/bin/grim', stderr: '' };
      if (name === 'tesseract' || name === 'python3') return { stdout: `/usr/bin/${name}`, stderr: '' };
      throw enoent();
    }
    if (cmd === 'swaymsg') return { stdout: SWAY_OUTPUTS, stderr: '' };
    if (cmd === 'grim') {
      if (!state.grim) throw enoent();
      return { stdout: state.png, stderr: '' };
    }
    throw enoent();
  };
  const execFile: any = (...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, out?: string, err?: string) => void;
    try {
      const r = run(args[0] as string, (args[1] as string[]) ?? []);
      cb(null, r.stdout as string, r.stderr);
    } catch (e) {
      cb(e as Error);
    }
  };
  execFile[promisify.custom] = async (cmd: string, args: string[]) => run(cmd, args);
  const execFileSync = (cmd: string, args: string[]) => run(cmd, args).stdout;
  return { execFile, execFileSync, exec: execFile, spawn: vi.fn() };
});

async function pixels(png: Buffer): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return Array.from(data);
}

const originalPlatform = process.platform;
const originalSession = process.env.XDG_SESSION_TYPE;
const originalDisplay = process.env.DISPLAY;

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env.XDG_SESSION_TYPE = 'wayland';
  delete process.env.DISPLAY;
  calls.length = 0;
  state.grim = true;
  // 4×2 solid #3366CC — what grim would write to stdout.
  state.png = await sharp({ create: { width: 4, height: 2, channels: 3, background: { r: 51, g: 102, b: 204 } } }).png().toBuffer();
  vi.resetModules();
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  if (originalSession === undefined) delete process.env.XDG_SESSION_TYPE;
  else process.env.XDG_SESSION_TYPE = originalSession;
  if (originalDisplay !== undefined) process.env.DISPLAY = originalDisplay;
});

const nutScreenCalls = () =>
  nutScreen.grab.mock.calls.length + nutScreen.grabRegion.mock.calls.length +
  nutScreen.width.mock.calls.length + nutScreen.height.mock.calls.length;

describe('LinuxAdapter on Wayland', () => {
  it('init() + getScreenSize() never call nut-js screen APIs and use swaymsg geometry', async () => {
    const { LinuxAdapter } = await import('../platform/linux');
    const adapter = new LinuxAdapter();
    expect(adapter.environment).toBe('wayland');
    await adapter.init();
    const size = await adapter.getScreenSize();
    expect(nutScreenCalls()).toBe(0);
    expect(size.logicalWidth).toBe(1280);
    expect(size.physicalWidth).toBe(2560);
    expect(calls.some(([cmd]) => cmd === 'swaymsg')).toBe(true);
  });

  it('screenshot() captures through grim and decodes the true colour', async () => {
    const { LinuxAdapter } = await import('../platform/linux');
    const shot = await new LinuxAdapter().screenshot({ maxWidth: 2 });
    expect(nutScreenCalls()).toBe(0);
    expect(calls.some(([cmd, args]) => cmd === 'grim' && args.includes('-'))).toBe(true);
    expect(shot.width).toBe(2);
    expect(shot.height).toBe(1);
    expect(await pixels(shot.buffer)).toEqual([51, 102, 204, 255, 51, 102, 204, 255]);
  });

  it('screenshotRegion() crops the grim capture', async () => {
    const { LinuxAdapter } = await import('../platform/linux');
    const shot = await new LinuxAdapter().screenshotRegion(1, 1, 1, 1);
    expect(nutScreenCalls()).toBe(0);
    expect(await pixels(shot.buffer)).toEqual([51, 102, 204, 255]);
  });

  it('reports an honest error instead of touching nut-js when grim is missing', async () => {
    state.grim = false;
    const { LinuxAdapter } = await import('../platform/linux');
    await expect(new LinuxAdapter().screenshot()).rejects.toThrow(/grim/);
    expect(nutScreenCalls()).toBe(0);
  });
});

describe('NativeDesktop on Wayland', () => {
  it('connect() does not grab the screen through nut-js and captures via grim', async () => {
    const { NativeDesktop } = await import('../platform/native-desktop');
    const { DEFAULT_CONFIG } = await import('../types');
    const desktop = new NativeDesktop({ ...DEFAULT_CONFIG, capture: { format: 'png', quality: 90 } });
    await desktop.connect();
    expect(nutScreenCalls()).toBe(0);

    const frame = await desktop.captureForLLM();
    expect(nutScreenCalls()).toBe(0);
    expect(calls.filter(([cmd]) => cmd === 'grim').length).toBe(1);
    expect(frame.width).toBe(4);
    expect(await pixels(frame.buffer)).toEqual(Array(8).fill([51, 102, 204, 255]).flat());

    const region = await desktop.captureRegionForLLM(0, 0, 1, 1);
    expect(await pixels(region.buffer)).toEqual([51, 102, 204, 255]);
    expect(nutScreenCalls()).toBe(0);
  });

  it('surfaces the grim error instead of crashing when grim is missing', async () => {
    state.grim = false;
    const { NativeDesktop } = await import('../platform/native-desktop');
    const { DEFAULT_CONFIG } = await import('../types');
    const desktop = new NativeDesktop({ ...DEFAULT_CONFIG });
    await desktop.connect();
    await expect(desktop.captureForLLM()).rejects.toThrow(/grim/);
    expect(nutScreenCalls()).toBe(0);
  });
});

describe('OcrEngine on Wayland', () => {
  it('feeds tesseract a grim capture, never a nut-js grab', async () => {
    const { OcrEngine } = await import('../platform/ocr-engine');
    const ocr = new OcrEngine();
    // The availability probe uses a CJS require() that vi.mock does not
    // intercept — pretend tesseract is installed; only the capture matters here.
    (ocr as any).available = true;
    // Region first: a failed full-screen OCR (no tesseract here) marks the
    // engine unavailable, which would skip the second capture.
    await ocr.recognizeRegion(0, 0, 2, 2);
    await ocr.recognizeScreen();
    expect(nutScreenCalls()).toBe(0);
    expect(calls.filter(([cmd]) => cmd === 'grim').length).toBe(2);
  });
});
