/**
 * MacOSAdapter.screenshot({region}) cuts the region out of the capture. It returned the whole screen (audit 2026-11-13):
 * only the Windows adapter honoured `region`, which PlatformAdapter declares for every OS.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import sharp from 'sharp';

const shot = vi.hoisted(() => ({ png: Buffer.alloc(0) }));

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const execFile: any = (...a: unknown[]) => (a[a.length - 1] as (e: null, out: string, err: string) => void)(null, '', '');
  // The screenshot helper writes its PNG to the path it is given; the test reads it back from `shot.png`.
  execFile[promisify.custom] = async () => ({ stdout: '', stderr: '' });
  return { execFile, spawn: vi.fn() };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: (p: unknown, ...rest: unknown[]) =>
      String(p).includes('.clawdcursor-shot-') ? shot.png : (actual.readFileSync as (...x: unknown[]) => unknown)(p, ...rest),
    unlinkSync: (p: unknown) => { if (!String(p).includes('.clawdcursor-shot-')) actual.unlinkSync(p as string); },
  };
});

import { MacOSAdapter } from '../platform/macos';

// 4x2: the left half red, the right half blue.
beforeAll(async () => {
  const raw = Buffer.alloc(4 * 2 * 3);
  for (let i = 0; i < 8; i++) raw.set(i % 4 < 2 ? [255, 0, 0] : [0, 0, 255], i * 3);
  shot.png = await sharp(raw, { raw: { width: 4, height: 2, channels: 3 } }).png().toBuffer();
});

const pixels = async (png: Buffer) => [...(await sharp(png).removeAlpha().raw().toBuffer())];
function adapter(): MacOSAdapter {
  const mac = new MacOSAdapter();
  (mac as unknown as { screenshotHelperPath: string }).screenshotHelperPath = '/fake/screenshot-helper';
  return mac;
}

describe('MacOSAdapter.screenshot({region})', () => {
  it('returns only the region, and where it starts', async () => {
    const r = await adapter().screenshot({ region: { x: 2, y: 0, width: 2, height: 2 } });
    expect([r.width, r.height, r.origin]).toEqual([2, 2, { x: 2, y: 0 }]);
    expect(await pixels(r.buffer)).toEqual([0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255]);
  });

  it('clamps a region that runs off the screen', async () => {
    const r = await adapter().screenshot({ region: { x: 1, y: 1, width: 100, height: 100 } });
    expect([r.width, r.height, r.origin]).toEqual([3, 1, { x: 1, y: 1 }]);
    expect(await pixels(r.buffer)).toEqual([255, 0, 0, 0, 0, 255, 0, 0, 255]);
  });

  it('without a region, the whole screen as before', async () => {
    const r = await adapter().screenshot();
    expect([r.width, r.height, r.origin]).toEqual([4, 2, undefined]);
  });
});
