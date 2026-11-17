/**
 * Mac, 2026-11-17: system ocr with processId read the whole screen, the user's Terminal included. `ocr` has no processId,
 * and the compound only warned that it had ignored it, after the read. A read of screen content limited to one window by
 * an argument it cannot honour is now refused before it reads anything; any other call still runs, with the warning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
const reads = vi.hoisted(() => ({ ocr: vi.fn(), copy: vi.fn() }));
vi.mock('../platform/ocr-engine', async (orig) => ({
  ...(await orig<typeof import('../platform/ocr-engine')>()),
  ocrEngine: () => ({
    isAvailable: () => true,
    recognizeScreen: async () => { reads.ocr(); return { elements: [], fullText: '', durationMs: 1 }; },
    recognizeRegion: async () => { reads.ocr(); return { elements: [], fullText: '', durationMs: 1 }; },
    invalidateCache() {},
  }),
}));
vi.mock('../platform/mac-ax', async (orig) => ({ ...(await orig<typeof import('../platform/mac-ax')>()), screenLockedMessage: async () => null }));
vi.mock('../platform/copy-all-text', async (orig) => ({
  ...(await orig<typeof import('../platform/copy-all-text')>()),
  copyAllText: vi.fn(async () => { reads.copy(); return { ok: true, text: 'page text', window: 'Edge' }; }),
}));

import { getCompactTools } from '../tools/compact';
import { classifyResult } from '../core/result-codes';

const ctx = () => ({
  ensureInitialized: async () => {}, platform: {} as any, a11y: { invalidateCache() {} } as any,
  desktop: { getDpiRatio: () => 1 } as any, cdp: {} as any, getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
});
const system = () => getCompactTools().find(t => t.name === 'system')!;

beforeEach(() => { reads.ocr.mockClear(); reads.copy.mockClear(); });

describe('a screen read limited to one window by an argument it does not take', () => {
  // ocr takes processId itself now (it reads that window by itself: ocr-window-by-pid.test.ts); processName it does not.
  it('system ocr with processName: refused, nothing read, and told how to read that one window', async () => {
    const r = await system().handler({ action: 'ocr', processName: 'Terminal' } as any, ctx() as any);
    expect(reads.ocr).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/system ocr NOT EXECUTED: it cannot be limited to one window by processName/);
    expect(r.text).toContain('Nothing was read');
    expect(r.text).toContain('window {"action":"focus","processName":"Terminal"}');
    expect(r.text).toContain('system {"action":"ocr","scope":"window"}');
    expect(classifyResult(r.text!, true, false)).toMatchObject({ outcome: 'failed', code: 'INVALID_ARGS' });
  });

  it('the same for title or windowId, and for copy_all_text with processId', async () => {
    for (const extra of [{ title: 'notes' }, { windowId: 7 }]) {
      const r = await system().handler({ action: 'ocr', scope: 'screen', ...extra } as any, ctx() as any);
      expect(r.text).toMatch(/NOT EXECUTED/);
    }
    const c = await system().handler({ action: 'copy_all_text', processId: 3872 } as any, ctx() as any);
    expect(c.text).toMatch(/system copy_all_text NOT EXECUTED/);
    expect(reads.ocr).not.toHaveBeenCalled();
    expect(reads.copy).not.toHaveBeenCalled();
  });

  it('without the argument, ocr reads as before', async () => {
    const r = await system().handler({ action: 'ocr' } as any, ctx() as any);
    expect(reads.ocr).toHaveBeenCalledTimes(1);
    expect(r.isError).toBeFalsy();
  });

  it('a call that does not read screen content still runs, with the warning', async () => {
    const r = await system().handler({ action: 'system_time', processId: 1 } as any, ctx() as any);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/ignored an argument it does not accept: processId/);
  });
});
