/**
 * A locked Mac on the OCR path.
 *
 * Found by the live blind run of 2026-10-19: the Mac had locked itself (about 20 minutes after the last keyboard or mouse input) and
 * `accessibility smart_click` answered {"error":"no_clickable_target", "tried":[… "ocr: read no text on screen" …]} — as if the
 * target were missing. The AX helper and the keyboard guard already say "the screen is locked"; the tools that read the screen
 * (smart_click, smart_read, ocr_read_screen) now say the same, before they try anything, and never "no_clickable_target".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const state = vi.hoisted(() => ({ lockedMessage: null as string | null, ocrReads: 0 }));
vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return true; }
    async recognizeScreen() { state.ocrReads++; return { elements: [], fullText: '', durationMs: 1 }; }
    async recognizeRegion() { state.ocrReads++; return { elements: [], fullText: '', durationMs: 1 }; }
  },
}));
vi.mock('../platform/mac-ax', async orig => ({
  ...(await orig<typeof import('../platform/mac-ax')>()),
  screenLockedMessage: vi.fn(async () => state.lockedMessage),
}));

import { getSmartTools } from '../tools/smart';
import { getOcrTools } from '../tools/ocr';

const LOCKED = 'reading the screen failed: the screen is locked — the lock screen (loginwindow) owns the display and keyboard. Unlock the Mac; clawdcursor cannot read or control apps behind it.';

function ctx() {
  const a11y = {
    getActiveWindow: vi.fn(async () => null),
    getWindows: vi.fn(async () => []),
    invokeElement: vi.fn(async () => ({ success: false })),
    findElement: vi.fn(async () => []),
    invalidateCache: vi.fn(),
  };
  return {
    a11y,
    ctx: { ensureInitialized: async () => {}, a11y, desktop: { getDpiRatio: () => 2, mouseClick: vi.fn() }, cdp: { isConnected: vi.fn(async () => false) }, platform: { getActiveWindow: async () => null }, uiMaps: undefined } as never,
  };
}
const smartClick = getSmartTools().find(t => t.name === 'smart_click')!;
const smartRead = getSmartTools().find(t => t.name === 'smart_read')!;
const ocrRead = getOcrTools().find(t => t.name === 'ocr_read_screen')!;

beforeEach(() => { state.lockedMessage = null; state.ocrReads = 0; });

describe('with the screen locked', () => {
  beforeEach(() => { state.lockedMessage = LOCKED; });

  it('smart_click says the screen is locked — not no_clickable_target — and tries nothing', async () => {
    const { ctx: c, a11y } = ctx();
    const r = await smartClick.handler({ target: 'Charlie' }, c);
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.text);
    expect(payload.error).toBe('screen_locked');
    expect(payload.reason).toContain('the screen is locked');
    expect(r.text).not.toContain('no_clickable_target');
    expect(state.ocrReads).toBe(0);
    expect(a11y.invokeElement).not.toHaveBeenCalled();
  });

  it('smart_read says so too', async () => {
    const { ctx: c } = ctx();
    const r = await smartRead.handler({}, c);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('the screen is locked');
    expect(state.ocrReads).toBe(0);
  });

  it('ocr_read_screen says so instead of reporting an empty screen', async () => {
    const { ctx: c } = ctx();
    const r = await ocrRead.handler({}, c);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('the screen is locked');
    expect(r.text).not.toContain('No text detected');
    expect(state.ocrReads).toBe(0);
  });
});

describe('with the screen unlocked nothing changes', () => {
  it('smart_click still reads the screen and, finding nothing, fails the old way', async () => {
    const { ctx: c } = ctx();
    const r = await smartClick.handler({ target: 'Charlie', timeout: 1500 }, c);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).error).toBe('no_clickable_target');
    expect(state.ocrReads).toBeGreaterThan(0);
  });

  it('ocr_read_screen still reports an empty screen as such', async () => {
    const { ctx: c } = ctx();
    const r = await ocrRead.handler({}, c);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text).elements).toEqual([]);
  });
});

describe('screenLockedMessage', () => {
  beforeEach(() => { process.env.CLAWD_NO_MAC_AX = '0'; });          // (the test setup switches the helper off globally)
  afterEach(() => { process.env.CLAWD_NO_MAC_AX = '1'; });
  const lock = async () => (await vi.importActual<typeof import('../platform/mac-ax')>('../platform/mac-ax')).screenLockedMessage;
  const front = (locked: boolean) => ({ frontmost: vi.fn(async () => ({ locked, app: null })) });

  it('a locked screen: the helper\'s wording, plus how to keep the display awake for a hands-off run (no setting changes)', async () => {
    const msg = await (await lock())(front(true), 'darwin');
    expect(msg).toContain('the screen is locked');
    expect(msg).toContain('Unlock the Mac');
    expect(msg).toMatch(/caffeinate/);
  });

  it('with the kill switch (CLAWD_NO_MAC_AX=1) it never asks, so a unit test run on a locked Mac is not affected', async () => {
    process.env.CLAWD_NO_MAC_AX = '1';
    const ax = front(true);
    expect(await (await lock())(ax, 'darwin')).toBeNull();
    expect(ax.frontmost).not.toHaveBeenCalled();
  });

  it('unlocked, a failed probe, or another OS: null — never a reason to refuse', async () => {
    const f = await lock();
    expect(await f(front(false), 'darwin')).toBeNull();
    expect(await f({ frontmost: vi.fn(async () => { throw new Error('timed out'); }) }, 'darwin')).toBeNull();
    expect(await f(front(true), 'linux')).toBeNull();
    expect(await f(front(true), 'win32')).toBeNull();
  });
});
