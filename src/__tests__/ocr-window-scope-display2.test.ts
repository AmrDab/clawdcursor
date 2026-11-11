/**
 * `system ocr` scope:"window" on a second monitor (live Win11 2026-11-10, Designcenter NX): the primary is 3840x2400 at
 * 225%, the other monitor 1920x1080 at 100% ABOVE it at (2796,-1080), and the window is maximized there: (2790,-1086)
 * 1932x1092. The agent got 210 elements as 15,000 characters of JSON whose positions were not on that monitor at all
 * ("Unite" at (1027,1071)): the read was of another window, and the reply named the window only after the elements.
 *
 * The real OcrEngine and WindowsAdapter run here; only the bridge is faked. It captures the PHYSICAL rectangle it is
 * given and OCR answers in pixels of that image, so a word's screen position is image position + the capture's origin:
 * no scale on any monitor, and a negative origin is just an origin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn(async () => { throw new Error('the primary-only grab must not be used for a window on another monitor'); }) },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

type Word = { text: string; x: number; y: number; width: number; height: number; line: number };
const bridge = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  foreground: null as unknown,
  words: [] as unknown[],
}));
const monitors = [
  { index: 0, name: 'DISPLAY1', primary: true, x: 0, y: 0, width: 3840, height: 2400, dpi: 216, scale: 2.25 },
  { index: 1, name: 'DISPLAY2', primary: false, x: 2796, y: -1080, width: 1920, height: 1080, dpi: 96, scale: 1 },
];
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    start: vi.fn(), stop: vi.fn(),
    run: async (c: Record<string, unknown>) => {
      bridge.calls.push(c);
      switch (c.cmd) {
        case 'get-foreground-window': return bridge.foreground;
        case 'list-displays': return { success: true, displays: monitors };
        case 'capture-rect': return { success: true, width: c.width, height: c.height, png: Buffer.from('png').toString('base64') };
        case 'ocr': return c.warm ? { ready: true } : { elements: bridge.words, fullText: '' };
        default: return {};
      }
    },
  },
}));

import { getOcrTools } from '../tools/ocr';
import { WindowsAdapter } from '../platform/windows';
import { displayAt, resetWorkingPoint, setWorkingPoint } from '../platform/display-target';
import type { Display } from '../platform/types';

const WINDOW = { x: 2790, y: -1086, width: 1932, height: 1092 };
const NX = { success: true, handle: 658788, processId: 3648, processName: 'ugraf', title: 'Designcenter Modeling', bounds: WINDOW, isMinimized: false };
const displays: Display[] = monitors.map(m => ({
  index: m.index, label: m.name, primary: m.primary, bounds: { x: m.x, y: m.y, width: m.width, height: m.height },
  physicalSize: { width: m.width, height: m.height }, dpiRatio: m.scale,
}));
const word = (text: string, x: number, y: number, line: number, width = 40, height = 14): Word => ({ text, x, y, width, height, line });

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
  bridge.calls.length = 0;
  bridge.foreground = NX;
  bridge.words = [];
  resetWorkingPoint();
});
afterEach(() => Object.defineProperty(process, 'platform', realPlatform));

async function ocr(scope: 'window' | 'screen' = 'window') {
  const tool = getOcrTools().find(t => t.name === 'ocr_read_screen')!;
  // The primary's ratio: what getDpiRatio answers on this PC. It must play no part on Windows.
  const ctx = { ensureInitialized: async () => {}, desktop: { getDpiRatio: () => 2.25 }, platform: new WindowsAdapter() } as never;
  return tool.handler({ scope }, ctx);
}
/** `@x,y "text"` rows of the reply. */
const rows = (text: string) => [...text.matchAll(/^@(-?\d+),(-?\d+) "(.*)"$/gm)].map(m => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));

describe('system ocr scope:"window" on the monitor above a 225% primary', () => {
  it('captures the window\'s own physical rectangle through the bridge, negative origin and all', async () => {
    bridge.words = [word('Unite', 1007, 1064, 0)];
    await ocr();
    const cap = bridge.calls.filter(c => c.cmd === 'capture-rect');
    expect(cap).toEqual([{ cmd: 'capture-rect', ...WINDOW }]);
  });

  it('a word\'s centre is its image position plus the window origin: on that monitor, where a click lands on it', async () => {
    // "Unite" was read at (1027,1071) in the window's image: 40x14 at (1007,1064).
    bridge.words = [word('Unite', 1007, 1064, 0), word('File', 20, 30, 1, 30, 14)];
    const r = await ocr();
    expect(r.isError).toBeFalsy();
    const unite = rows(r.text).find(w => w.text === 'Unite')!;
    expect(unite).toMatchObject({ x: 2790 + 1027, y: -1086 + 1071 });   // (3817,-15)
    expect(displayAt(displays, unite.x, unite.y)?.index).toBe(1);
    expect(rows(r.text).find(w => w.text === 'File')).toMatchObject({ x: 2790 + 35, y: -1086 + 37 });
    // No scale anywhere: not the primary's 225%, not the window monitor's 100%.
    expect(r.text).not.toMatch(/@1027,1071|@457,476|@1696,-7/);
  });

  it('says first which window it read and where, so a read of the wrong window cannot pass for the right one', async () => {
    bridge.words = [word('Unite', 1007, 1064, 0)];
    const r = await ocr();
    const head = r.text.split('\n')[0];
    expect(head).toContain('focused window');
    expect(head).toContain('(2790,-1086) 1932x1092');
    expect(head).toContain('space:"screen"');
    expect(r.text).toMatch(/<untrusted-screen-content>\nwindow: Designcenter Modeling\n/);   // a title is screen text
  });

  it('the window read is text lines with positions, not JSON: 210 words fit in a few thousand characters', async () => {
    // 70 rows of three labels: two that sit together and one far to the right (a ribbon: caption + its group).
    bridge.words = Array.from({ length: 70 }, (_, i) => [
      word('Extrude', 20, 10 + i * 15, i, 60), word('Boss', 86, 10 + i * 15, i, 40), word('Unite', 900, 10 + i * 15, i),
    ]).flat();
    const r = await ocr();
    expect(() => JSON.parse(r.text)).toThrow();
    expect(r.text.length).toBeLessThan(5000);
    const got = rows(r.text);
    expect(got).toHaveLength(140);   // words that sit together are one row; a wide gap starts another
    expect(got[0]).toEqual({ text: 'Extrude Boss', x: 2790 + 73, y: -1086 + 17 });
    expect(got[1]).toEqual({ text: 'Unite', x: 2790 + 920, y: -1086 + 17 });
    expect(r.text).toContain('210 words');
  });

  it('says so when the agent last worked outside the window that was read', async () => {
    bridge.foreground = { ...NX, processName: 'claude', title: 'Claude', bounds: { x: 200, y: 150, width: 2400, height: 1800 } };
    bridge.words = [word('Unite', 827, 921, 0)];
    setWorkingPoint(3756, -540);   // the last click: on the other monitor
    const r = await ocr();
    expect(rows(r.text)[0]).toMatchObject({ x: 1047, y: 1078 });
    expect(r.text.split('\n')[0]).toMatch(/You last worked at \(3756,-540\), outside this window/);
    setWorkingPoint(1000, 1000);
    expect((await ocr()).text).not.toMatch(/outside this window/);
  });

  it('no window to read: the whole-screen answer says scope:"window" was not honoured, before the elements', async () => {
    bridge.foreground = { ...NX, isMinimized: true };
    bridge.words = [word('Save', 800, 600, 0)];
    setWorkingPoint(3756, -540);   // screen scope reads the monitor being worked on
    const out = JSON.parse((await ocr()).text);
    expect(Object.keys(out).slice(0, 2)).toEqual(['scope', 'note']);
    expect(out.scope).toBe('screen');
    expect(out.note).toMatch(/no focused window could be read/);
    expect(out.elements[0]).toMatchObject({ x: 2796 + 800, y: -1080 + 600 });
  });

  it('scope:"screen" keeps its JSON, and has no note', async () => {
    bridge.words = [word('Save', 800, 600, 0)];
    setWorkingPoint(3756, -540);
    const out = JSON.parse((await ocr('screen')).text);
    expect(out.scope).toBe('screen');
    expect(out.note).toBeUndefined();
    expect(out.elements[0]).toMatchObject({ text: 'Save', x: 2796 + 800, y: -1080 + 600 });
  });
});
