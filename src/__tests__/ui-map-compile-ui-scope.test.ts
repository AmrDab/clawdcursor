/**
 * compile_ui scoping + coordinate space (live macOS blind test 2026-10-15):
 * `accessibility compile_ui {processId}` ignored processId and OCR'd the whole
 * screen, and OCR elements came back in PHYSICAL pixels (x=3874 on a 2240-pt
 * screen) while the map claims coordinate_space "screen".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recognizeScreen = vi.fn();
const recognizeRegion = vi.fn();
vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return true; }
    recognizeScreen() { return recognizeScreen(); }
    recognizeRegion(x: number, y: number, w: number, h: number) { return recognizeRegion(x, y, w, h); }
    invalidateCache() {}
  },
}));

import { buildUnifiedTools } from '../core/agent-loop/tools';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { AgentToolContext } from '../core/agent-loop/types';
import type { PlatformAdapter } from '../platform/types';

const tool = () => buildUnifiedTools().find(t => t.name === 'compile_ui')!;

const notepad = { processId: 9, processName: 'notepad', title: 'Untitled', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false };
const calc = { processId: 42, processName: 'Calculator', title: 'Calculator', bounds: { x: 1000, y: 300, width: 230, height: 400 }, isMinimized: false };

const getUiTree = vi.fn(async (_pid?: number) => [] as unknown[]);

function ctx(holder: UIMapHolder): AgentToolContext {
  const adapter = {
    platform: 'darwin',
    getActiveWindow: async () => notepad,
    listWindows: async () => [notepad, calc],
    getUiTree,
    getScreenSize: async () => ({ logicalWidth: 2240, logicalHeight: 1260, physicalWidth: 4480, physicalHeight: 2520, dpiRatio: 2 }),
    getFocusedElement: async () => null,
    screenshot: async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 }),
  } as unknown as PlatformAdapter;
  return { platform: adapter, task: 't', screen: { logicalWidth: 2240, logicalHeight: 1260, physicalWidth: 4480, physicalHeight: 2520, dpiRatio: 2 }, screenshotsCaptured: { n: 0 }, uiMaps: holder } as unknown as AgentToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CLAWDCURSOR_WAKE_BUDGET_MS = '0';
  recognizeScreen.mockResolvedValue({ elements: [{ text: 'Clock', x: 3874, y: 20, width: 80, height: 24, confidence: 0.9, line: 0 }], fullText: 'Clock', durationMs: 1 });
  recognizeRegion.mockResolvedValue({ elements: [{ text: 'Seven', x: 2100, y: 1300, width: 20, height: 30, confidence: 0.9, line: 0 }], fullText: 'Seven', durationMs: 1 });
});

describe('compile_ui on a Retina Mac', () => {
  it('OCR elements are in screen points, not physical pixels', async () => {
    const holder = new UIMapHolder();
    const res = await tool().execute({}, ctx(holder));
    expect(res.success).toBe(true);
    const clock = holder.current()!.elements.find(e => e.text === 'Clock')!;
    expect(clock.bounds).toEqual([1937, 10, 40, 12]);
  });

  it('accepts processId: reads that app, OCRs only its window, in screen points', async () => {
    const holder = new UIMapHolder();
    const res = await tool().execute({ processId: 42 }, ctx(holder));
    expect(res.success).toBe(true);
    expect(getUiTree).toHaveBeenCalledWith(42);
    expect(recognizeRegion).toHaveBeenCalledWith(2000, 600, 460, 800);
    expect(recognizeScreen).not.toHaveBeenCalled();
    const map = holder.current()!;
    expect(map.window_title).toBe('Calculator');
    expect(map.process_id).toBe('42');
    expect(map.elements.find(e => e.text === 'Seven')!.bounds).toEqual([1050, 650, 10, 15]);
    expect(res.text).not.toContain('Clock');
  });

  it('declares processId in its schema (the compact surface stops dropping it)', () => {
    expect(Object.keys((tool().inputSchema as { properties: Record<string, unknown> }).properties)).toContain('processId');
  });
});
