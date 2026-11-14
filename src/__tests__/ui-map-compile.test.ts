import { describe, it, expect, vi } from 'vitest';
import { compileUIMap, type CompileDeps } from '../core/sense/ui-map';
import { defaultCompileDeps } from '../core/sense/ui-map';
import type { Snapshot } from '../core/sense/types';
import type { OcrResult } from '../platform/ocr-engine';
import type { PlatformAdapter } from '../platform/types';

function snap(elements: Snapshot['elements']): Snapshot {
  return { platform: 'windows',
    activeWindow: { processId: 9, processName: 'notepad', title: 'Untitled - Notepad',
      bounds: { x: 0, y: 0, width: 800, height: 600 } },
    elements, capturedAt: 0, sources: elements.length ? ['a11y'] : [] };
}
const okOcr = (): OcrResult => ({ elements: [
  { text: 'Send', x: 10, y: 20, width: 40, height: 12, confidence: 0.95, line: 0 }],
  fullText: 'Send', durationMs: 1 });

function deps(over: Partial<CompileDeps> = {}): CompileDeps {
  return {
    captureSnapshot: vi.fn(async () => snap([
      { name: 'Send', role: 'Button', x: 10, y: 20, width: 40, height: 12,
        source: 'a11y', interactive: true }])),
    ocr: vi.fn(async () => okOcr()),
    vision: vi.fn(async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 })),
    getScreenSize: vi.fn(async () => ({ logicalWidth: 800, logicalHeight: 600,
      physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 })),
    getFocusedElement: vi.fn(async () => null),
    now: 1234, snapshotId: 'obs_1', ...over,
  };
}

describe('compileUIMap — lazy escalation', () => {
  it('a11y-sufficient screen pulls NEITHER ocr NOR vision', async () => {
    const d = deps();
    const map = await compileUIMap(d, {});
    expect(d.ocr).not.toHaveBeenCalled();
    expect(d.vision).not.toHaveBeenCalled();
    expect(map.sources_used).toEqual(['window', 'a11y']);
    expect(map.elements.some(e => e.normalized_text === 'send')).toBe(true);
  });

  it('sparse a11y pulls OCR (spine fallback)', async () => {
    const d = deps({ captureSnapshot: vi.fn(async () => snap([])) });
    const map = await compileUIMap(d, {});
    expect(d.ocr).toHaveBeenCalledTimes(1);
    expect(map.sources_used).toContain('ocr');
    expect(map.elements.some(e => e.normalized_text === 'send')).toBe(true);
  });

  it('target_text absent from a11y pulls OCR even when a11y is non-empty', async () => {
    const d = deps(); // a11y has "Send" only
    await compileUIMap(d, { target_text: 'attach' });
    expect(d.ocr).toHaveBeenCalledTimes(1);
  });

  it('max_cost:"cheap" never pulls OCR or vision, even when a11y is empty', async () => {
    const d = deps({ captureSnapshot: vi.fn(async () => snap([])) });
    const map = await compileUIMap(d, { max_cost: 'cheap' });
    expect(d.ocr).not.toHaveBeenCalled();
    expect(d.vision).not.toHaveBeenCalled();
    expect(map.sources_used).toEqual(['window']);
  });

  it('max_cost:"ocr_ok" (default) never pulls vision even when a11y+ocr both empty', async () => {
    const d = deps({ captureSnapshot: vi.fn(async () => snap([])),
      ocr: vi.fn(async () => ({ elements: [], fullText: '', durationMs: 1 })) });
    await compileUIMap(d, {});
    expect(d.vision).not.toHaveBeenCalled();
  });

  it('populates coordinate metadata + snapshot_id + compiled_at from deps', async () => {
    const map = await compileUIMap(deps({ getScreenSize: vi.fn(async () => ({
      logicalWidth: 1280, logicalHeight: 720, physicalWidth: 2560, physicalHeight: 1440,
      dpiRatio: 2 })) }), {});
    expect(map.coordinate_space).toBe('screen');
    expect(map.scale_factor).toBe(2);
    expect(map.snapshot_id).toBe('obs_1');
    expect(map.compiled_at).toBe('1234');
    expect(map.active_app).toBe('notepad');
    expect(map.window_bounds).toEqual([0, 0, 800, 600]);
    expect(map.truncation).toEqual({ total_elements: 1, returned_elements: 1 });
  });

  it('marks the focused element and sets the focused anchor from getFocusedElement', async () => {
    const d = deps({
      getFocusedElement: vi.fn(async () => ({ name: 'Send', controlType: 'Button',
        bounds: { x: 10, y: 20, width: 40, height: 12 } } as any)),
    });
    const map = await compileUIMap(d, {});
    expect(map.anchors.focused?.normalized_text).toBe('send');
    const focusedEl = map.elements.find(e => e.id === map.anchors.focused?.id);
    expect(focusedEl?.state?.focused).toBe(true);
  });

  it('sets primary_action_candidate when a primary-verb clickable element exists', async () => {
    const map = await compileUIMap(deps(), {}); // a11y "Send" button is clickable
    expect(map.anchors.primary_action_candidate?.normalized_text).toBe('send');
  });

  it('fuses overlapping a11y + OCR elements end-to-end (sources merged, confidence raised)', async () => {
    const d = deps({
      ocr: vi.fn(async () => ({
        elements: [{ text: 'Send', x: 11, y: 21, width: 38, height: 11, confidence: 0.95, line: 0 }],
        fullText: 'Send', durationMs: 1,
      })),
    });
    const map = await compileUIMap(d, { target_text: 'nonexistent' }); // miss → OCR fires
    const send = map.elements.find(e => e.normalized_text === 'send');
    expect(send).toBeDefined();
    expect(send!.sources.slice().sort()).toEqual(['a11y', 'ocr']);
    expect(send!.confidence).toBeGreaterThan(0.85); // a11y base 0.85 + agreement bonus
  });

  it('a throwing OCR source degrades to no OCR (does not crash compile)', async () => {
    const d = deps({
      captureSnapshot: vi.fn(async () => snap([])),           // empty a11y -> OCR would fire
      ocr: vi.fn(async () => { throw new Error('OCR engine unavailable'); }),
    });
    const map = await compileUIMap(d, {});
    expect(map.sources_used).toEqual(['window']);             // ocr failed -> not recorded
    expect(map.elements).toEqual([]);
  });

  it('a throwing vision source degrades to no vision', async () => {
    const d = deps({
      captureSnapshot: vi.fn(async () => snap([])),
      ocr: vi.fn(async () => ({ elements: [], fullText: '', durationMs: 1 })),
      vision: vi.fn(async () => { throw new Error('no display'); }),
    });
    const map = await compileUIMap(d, { max_cost: 'vision_ok' });
    expect(map.sources_used).not.toContain('vision');         // vision failed -> not recorded
  });
});

describe('defaultCompileDeps', () => {
  it('builds deps wired to the adapter without throwing', () => {
    const adapter = {
      getScreenSize: async () => ({ logicalWidth: 1, logicalHeight: 1,
        physicalWidth: 1, physicalHeight: 1, dpiRatio: 1 }),
      getFocusedElement: async () => null,
      screenshot: async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 }),
    } as unknown as PlatformAdapter;
    const d = defaultCompileDeps(adapter, 5, 'obs_9');
    expect(d.now).toBe(5);
    expect(d.snapshotId).toBe('obs_9');
    expect(typeof d.captureSnapshot).toBe('function');
    expect(typeof d.ocr).toBe('function');
  });
});
