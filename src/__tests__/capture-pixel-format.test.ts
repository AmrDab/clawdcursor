/**
 * Adapter-level regression for the red/blue swap and the X11 black screenshot.
 *
 * nut-js `screen.grab()` returns BGRA (colorMode 0); on 24-bit X11 the alpha
 * byte is 0. A GDI pixel R=20,G=23,B=27 arrives as [27,23,20,255] and used to
 * leave WindowsAdapter.screenshotRegion as PNG pixel (27,23,20) — swapped.
 * On Linux [204,102,51,0] (#3366CC) came out fully transparent → black.
 * Every capture path must now emit the true, opaque colour.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';

// 2×1 grab: pixel 0 = true (20,23,27) with alpha 255 (Windows), pixel 1 =
// true #3366CC with alpha 0 (X11). Fresh buffer per grab — normalisation is in place.
const grabImage = () => ({
  data: Buffer.from([27, 23, 20, 255, 204, 102, 51, 0]),
  width: 2, height: 1, channels: 4, colorMode: 0, hasAlphaChannel: true,
});

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, setPosition: vi.fn(), getPosition: vi.fn(async () => ({ x: 0, y: 0 })) },
  keyboard: { config: {} },
  screen: {
    config: {},
    grab: vi.fn(async () => grabImage()),
    grabRegion: vi.fn(async () => grabImage()),
    width: vi.fn(async () => 2),
    height: vi.fn(async () => 1),
  },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

vi.mock('../platform/ps-runner', () => ({ psRunner: { start: vi.fn(), run: vi.fn() } }));

// No real subprocesses: adapters probe xrandr / powershell for DPI, all non-fatal.
vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const fail = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const execFile: any = (...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') (cb as (e: Error) => void)(new Error('ENOENT'));
  };
  execFile[promisify.custom] = async () => fail();
  return { execFile, execFileSync: fail, exec: execFile, spawn: vi.fn() };
});

async function pixels(png: Buffer): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return Array.from(data);
}

const TRUE_WIN = [20, 23, 27, 255];
const TRUE_X11 = [51, 102, 204, 255];

const originalPlatform = process.platform;
const originalSession = process.env.XDG_SESSION_TYPE;

beforeAll(() => {
  process.env.XDG_SESSION_TYPE = 'x11';
  delete process.env.WAYLAND_DISPLAY;
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  if (originalSession === undefined) delete process.env.XDG_SESSION_TYPE;
  else process.env.XDG_SESSION_TYPE = originalSession;
});

describe('capture pixel format', () => {
  it('WindowsAdapter.screenshotRegion emits the true RGB colour (not BGR)', async () => {
    const { WindowsAdapter } = await import('../platform/windows');
    const shot = await new WindowsAdapter().screenshotRegion(0, 0, 1, 1);
    expect(await pixels(shot.buffer)).toEqual(TRUE_WIN);
  });

  it('WindowsAdapter.screenshot keeps the colour through resize', async () => {
    const { WindowsAdapter } = await import('../platform/windows');
    const shot = await new WindowsAdapter().screenshot({ maxWidth: 1 });
    expect(shot.width).toBe(1);
    // Both source pixels are averaged by the resize; red must stay the lowest channel.
    const [r, g, b, a] = await pixels(shot.buffer);
    expect(a).toBe(255);
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r);
  });

  it('LinuxAdapter.screenshot is opaque and correctly ordered when the X11 alpha byte is 0', async () => {
    const { LinuxAdapter } = await import('../platform/linux');
    const shot = await new LinuxAdapter().screenshot();
    expect(await pixels(shot.buffer)).toEqual([...TRUE_WIN, ...TRUE_X11]);
  });

  it('LinuxAdapter.screenshotRegion is opaque and correctly ordered', async () => {
    const { LinuxAdapter } = await import('../platform/linux');
    const shot = await new LinuxAdapter().screenshotRegion(1, 0, 1, 1);
    expect(await pixels(shot.buffer)).toEqual(TRUE_X11);
  });

  it('NativeDesktop capture paths emit the true colour', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { NativeDesktop } = await import('../platform/native-desktop');
    const { DEFAULT_CONFIG } = await import('../types');
    const desktop = new NativeDesktop({ ...DEFAULT_CONFIG, capture: { format: 'png', quality: 90 } });
    await desktop.connect();

    const full = await desktop.captureScreen();
    expect(await pixels(full.buffer)).toEqual([...TRUE_WIN, ...TRUE_X11]);

    const llm = await desktop.captureForLLM();
    expect(await pixels(llm.buffer)).toEqual([...TRUE_WIN, ...TRUE_X11]);

    const region = await desktop.captureRegionForLLM(1, 0, 1, 1);
    expect(await pixels(region.buffer)).toEqual(TRUE_X11);

    const mon = await desktop.captureMonitor(0);
    expect(await pixels(mon.buffer)).toEqual([...TRUE_WIN, ...TRUE_X11]);
  });
});
