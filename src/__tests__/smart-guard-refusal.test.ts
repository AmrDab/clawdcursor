/**
 * smart_click / smart_type used to hide the input guard's refusal: the by-name step and the OCR click were refused, the tool
 * treated both as misses and answered {"error":"no_clickable_target","next":"ocr…"}, the real reason only truncated in `tried`.
 * A refusal (stopped, foreground changed, an AI assistant in front) is the call's own result, word for word.
 */
import { describe, it, expect, vi } from 'vitest';

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
vi.mock('../platform/ocr-engine', () => {
  class OcrEngine {
    isAvailable() { return true; }
    async recognizeScreen() {
      return { elements: [{ text: 'Send', x: 10, y: 10, width: 40, height: 12, confidence: 0.95 }], fullText: 'Send', durationMs: 1 };
    }
    async recognizeRegion() { return { elements: [], fullText: '', durationMs: 1 }; }
  }
  return { OcrEngine, ocrEngine: () => new OcrEngine() };
});

import { getSmartTools } from '../tools/smart';
import { isGuardRefusal } from '../core/control';

const REFUSAL = 'the window in front is Claude, an AI assistant — nothing was sent. Focus your target window first: window {"action":"focus","title":"…"}. If this assistant\'s window IS your target, focus it with window focus and retry.';
const tool = (n: string) => getSmartTools().find(t => t.name === n)!;

function ctx(over: { invoke?: () => Promise<unknown>; click?: () => Promise<unknown>; type?: () => Promise<unknown>; cdp?: unknown }) {
  const a11y = {
    getActiveWindow: vi.fn(async () => null),
    getWindows: vi.fn(async () => []),
    invokeElement: vi.fn(over.invoke ?? (async () => ({ success: false }))),
    findElement: vi.fn(async () => []),
    invalidateCache: vi.fn(),
    readClipboard: vi.fn(async () => null),
    writeClipboard: vi.fn(async () => {}),
  };
  return { ensureInitialized: async () => {}, a11y, desktop: { getDpiRatio: () => 1, mouseClick: vi.fn(over.click ?? (async () => {})), typeText: vi.fn(over.type ?? (async () => {})), keyPress: vi.fn(async () => {}) },
    cdp: over.cdp ?? { isConnected: vi.fn(async () => false) }, platform: { getActiveWindow: async () => null }, uiMaps: undefined } as never;
}

describe('smart_click', () => {
  it('a refused by-name step is the call\'s result, unchanged', async () => {
    const r = await tool('smart_click').handler({ target: 'Send', timeout: 1500 }, ctx({ invoke: async () => { throw new Error(REFUSAL); } }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(REFUSAL);
  });

  it('a refused OCR click is the call\'s result, unchanged', async () => {
    const r = await tool('smart_click').handler({ target: 'Send', timeout: 1500 }, ctx({ click: async () => { throw new Error(REFUSAL); } }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(REFUSAL);
  });

  it('a target only the browser has is clicked through CDP, iframes included, and the result names the iframe', async () => {
    const clickByText = vi.fn(async () => ({ success: true, method: 'js.clickByText', frame: 'https://editor.example/frame' }));
    const r = await tool('smart_click').handler({ target: 'Generate', timeout: 3000 }, ctx({ cdp: { isConnected: async () => true, clickByText } }));
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Clicked "Generate" via CDP (js.clickByText) in iframe');
    expect(r.text).toContain('https://editor.example/frame');
    expect(clickByText).toHaveBeenCalledWith('Generate', expect.any(Number));   // bounded by the call's own deadline
  });

  it('a refused CDP click is the call\'s result, unchanged', async () => {
    const cdp = { isConnected: async () => true, clickByText: async () => { throw new Error(REFUSAL); } };
    const r = await tool('smart_click').handler({ target: 'Generate', timeout: 3000 }, ctx({ cdp }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe(REFUSAL);
  });

  it('a click that failed for any other reason is still a miss with a next step', async () => {
    const r = await tool('smart_click').handler({ target: 'Send', timeout: 1500 }, ctx({ click: async () => { throw new Error('nut-js exploded'); } }));
    expect(JSON.parse(r.text).error).toBe('no_clickable_target');
  });
});

describe('smart_type', () => {
  it('a refused focus / type rejects with the refusal, not a silent fall-through', async () => {
    const c = ctx({ invoke: async () => { throw new Error(REFUSAL); } });
    await expect(tool('smart_type').handler({ target: 'Message', text: 'hi' }, c)).rejects.toThrow(REFUSAL);
  });
});

describe('isGuardRefusal', () => {
  it('knows the guard\'s three refusals and nothing else', () => {
    expect(isGuardRefusal(new Error(REFUSAL))).toBe(true);
    expect(isGuardRefusal(new Error('the window in front is the app this agent runs in (WindowsTerminal) — nothing was sent. Focus your target window first: window {"action":"focus"}'))).toBe(true);
    expect(isGuardRefusal(new Error('foreground changed: you were working in notepad'))).toBe(true);
    expect(isGuardRefusal(new Error('stopped by the user — they took control back'))).toBe(true);
    expect(isGuardRefusal(new Error('Element not found'))).toBe(false);
  });
});
