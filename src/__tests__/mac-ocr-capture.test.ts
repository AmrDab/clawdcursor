/**
 * Mac, 2026-11-17: OCR failed with "Failed to capture screen" while `computer screenshot` worked. OCR grabbed with nut-js
 * inside node, which had no Screen Recording grant there; screenshots go through the screenshot helper, which has its own.
 * On macOS OCR now captures through the helper first, and grabs with nut-js only when there is no helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

const helper = vi.hoisted(() => ({ result: null as null | (() => Promise<{ path: string; width: number; height: number }>) }));
const nutGrab = vi.hoisted(() => vi.fn(async () => ({ data: Buffer.alloc(4 * 4), width: 2, height: 2 })));

vi.mock('../platform/native-helper', async (orig) => ({
  ...(await orig<typeof import('../platform/native-helper')>()),
  assertScreenRecordingGranted: async () => {},
  captureScreenViaHelper: vi.fn(async () => { if (!helper.result) throw new Error('screenshot-helper not found'); return helper.result(); }),
}));
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: { config: {}, grab: nutGrab },
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }), Point: class {}, Region: class {},
}));

import { helperScreenGrab } from '../platform/screen-grab';
import { ScreenRecordingDeniedError } from '../platform/native-helper';
import { OcrEngine } from '../platform/ocr-engine';

const REAL_PLATFORM = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, writable: true, configurable: true });

let dir: string;
async function helperPng(width = 3, height = 2): Promise<string> {
  const file = path.join(dir, 'cap.png');
  await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 10, b: 30 } } }).png().toFile(file);
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-ocr-capture-'));
  helper.result = null;
  nutGrab.mockClear();
  setPlatform('darwin');
});
afterEach(() => {
  setPlatform(REAL_PLATFORM);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('helperScreenGrab (macOS)', () => {
  it('returns the helper\'s capture as opaque RGBA pixels and removes its file', async () => {
    const file = await helperPng(3, 2);
    helper.result = async () => ({ path: file, width: 3, height: 2 });
    const img = await helperScreenGrab();
    expect(img).toMatchObject({ width: 3, height: 2, channels: 4, colorMode: 1 });
    expect([...img!.data.subarray(0, 4)]).toEqual([200, 10, 30, 255]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('no helper (or another failure): null, so the caller grabs with nut-js', async () => {
    await expect(helperScreenGrab()).resolves.toBeNull();
  });

  it('Screen Recording refused: thrown, never a wallpaper-only fallback', async () => {
    helper.result = async () => { throw new ScreenRecordingDeniedError(); };
    await expect(helperScreenGrab()).rejects.toBeInstanceOf(ScreenRecordingDeniedError);
  });

  it('not macOS: null, without asking the helper', async () => {
    setPlatform('win32');
    await expect(helperScreenGrab()).resolves.toBeNull();
  });
});

describe('the OCR engine\'s capture on macOS', () => {
  const grab = (e: OcrEngine) => (e as unknown as { grab(): Promise<{ width: number; height: number }> }).grab();

  it('uses the screenshot helper, not nut-js', async () => {
    const file = await helperPng(4, 4);
    helper.result = async () => ({ path: file, width: 4, height: 4 });
    await expect(grab(new OcrEngine())).resolves.toMatchObject({ width: 4, height: 4 });
    expect(nutGrab).not.toHaveBeenCalled();
  });

  it('falls back to nut-js when there is no helper', async () => {
    await expect(grab(new OcrEngine())).resolves.toMatchObject({ width: 2, height: 2 });
    expect(nutGrab).toHaveBeenCalledTimes(1);
  });
});
