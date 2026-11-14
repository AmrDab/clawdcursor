/**
 * `accessibility smart_click "New"` in Designcenter NX (live Win11 2026-11-10) answered `Clicked "New" via UI Automation`
 * and nothing opened; a coordinate click on the ribbon's New button worked. The bridge's invoke took the FIRST element in
 * tree order whose name matched, whatever it was: a link of a web view the window does not show (laid out down to
 * y = 31,000, on no monitor) comes before the ribbon. It was invoked, and the invoke "succeeded".
 *
 * An action by name now acts on an element the user can see: on a monitor and not offscreen. An element on no monitor is
 * never pressed, and several visible elements with the name are listed instead of one being picked in silence.
 * The bridge needs a desktop, so its choice (Select-InvokeTarget) runs here for real with fake elements; the TS layer
 * runs with a fake bridge reply.
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
vi.mock('../platform/ocr-engine', () => {
  class OcrEngine {
    isAvailable() { return true; }
    // The ribbon's "New" as OCR sees it, on the monitor above the primary.
    async recognizeScreen() { return { elements: [{ text: 'New', x: 2830, y: -1010, width: 36, height: 14, line: 0 }], fullText: 'New', durationMs: 1 }; }
    async recognizeRegion() { return { elements: [], fullText: '', durationMs: 1 }; }
  }
  return { OcrEngine, ocrEngine: () => new OcrEngine() };
});

import { getSmartTools } from '../tools/smart';
import { buildUnifiedTools, runActivationLadder } from '../tools/projected/tools';
import { missText, structuredMissFields, targetOf, targetText } from '../core/miss-text';
import { classifyResult } from '../core/result-codes';
import type { AgentToolContext } from '../tools/projected/types';
import type { PlatformAdapter } from '../platform/types';

const CANDIDATES = [
  { name: 'New', controlType: 'ControlType.MenuItem', bounds: { x: 2800, y: -1070, width: 40, height: 20 } },
  { name: 'New', controlType: 'ControlType.Button', bounds: { x: 2816, y: -1030, width: 64, height: 72 } },
];
const AMBIGUOUS = { success: false, action: 'click', reason: 'ambiguous', candidates: CANDIDATES, error: 'Several elements match' };

describe('an ambiguous name is reported with the elements it could mean', () => {
  it('missText lists them inside the untrusted block, with the role and the screen position of each', () => {
    const text = missText(structuredMissFields(AMBIGUOUS));
    expect(text).toMatch(/^2 elements on screen match that name, nothing was done/);
    expect(text).toContain('<untrusted-screen-content>\n[MenuItem] "New" @2800,-1070 40x20\n[Button] "New" @2816,-1030 64x72\n</untrusted-screen-content>');
    expect(text.split('<untrusted-screen-content>')[0]).toMatch(/controlType/);
  });

  it('candidates are bounded and typed: a name cannot be long, a rect is numbers', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: 'N'.repeat(500) + i, controlType: 'ControlType.Button', bounds: { x: 'a', y: 2, width: 3, height: 4 } }));
    const f = structuredMissFields({ ...AMBIGUOUS, candidates: many }) as { candidates: Array<{ name: string; bounds?: unknown }> };
    expect(f.candidates).toHaveLength(8);
    expect(f.candidates[0].name.length).toBeLessThanOrEqual(80);
    expect(f.candidates[0].bounds).toBeUndefined();
  });

  it('is its own result code, with the next step', () => {
    const c = classifyResult(`a11y invoke "New" missed — ${missText(structuredMissFields(AMBIGUOUS))}.`, true, true, 'mcp');
    expect(c).toMatchObject({ outcome: 'failed', code: 'AMBIGUOUS' });
    expect(c!.hint).toMatch(/controlType|position/);
  });
});

function ctxFor(invokeElement: () => Promise<unknown>) {
  const mouseClick = vi.fn(async () => {});
  const a11y = {
    getActiveWindow: vi.fn(async () => ({ processId: 3648, processName: 'ugraf', title: 'Designcenter Modeling', bounds: { x: 2790, y: -1086, width: 1932, height: 1092 } })),
    getWindows: vi.fn(async () => []),
    invokeElement: vi.fn(invokeElement),
    findElement: vi.fn(async () => []),
    invalidateCache: vi.fn(),
  };
  const ctx = { ensureInitialized: async () => {}, a11y, desktop: { getDpiRatio: () => 2.25, mouseClick },
    cdp: { isConnected: vi.fn(async () => false) }, platform: { getActiveWindow: async () => null }, uiMaps: undefined } as never;
  return { ctx, mouseClick, a11y };
}
const smartClick = getSmartTools().find(t => t.name === 'smart_click')!;

describe('smart_click', () => {
  // The Windows case, on every CI runner: on macOS an OCR position is divided by the Retina ratio before the click
  // (ocrPointToClickPoint), so the same word is clicked at other numbers there. That rule has its own tests.
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }));
  afterEach(() => Object.defineProperty(process, 'platform', realPlatform));

  it('ambiguous: says so and lists them; the OCR match is NOT clicked in its place', async () => {
    const { ctx, mouseClick } = ctxFor(async () => AMBIGUOUS);
    const r = await smartClick.handler({ target: 'New', timeout: 1500 }, ctx);
    expect(r.isError).toBe(true);
    expect(mouseClick).not.toHaveBeenCalled();
    expect(r.text).toMatch(/2 elements on screen match that name, nothing was done/);
    expect(r.text).toContain('[Button] "New" @2816,-1030 64x72');
    expect(classifyResult(r.text, true, true, 'mcp')?.code).toBe('AMBIGUOUS');
  });

  it('hidden (the only element with the name is on no monitor): not "Clicked via UI Automation"; the text OCR sees is clicked', async () => {
    const { ctx, mouseClick } = ctxFor(async () => ({ success: false, action: 'click', reason: 'hidden', error: 'on no monitor' }));
    const r = await smartClick.handler({ target: 'New', timeout: 1500 }, ctx);
    expect(r.text).not.toMatch(/via UI Automation/);
    expect(mouseClick).toHaveBeenCalledWith(2848, -1003);   // the centre of the word OCR read on the ribbon
  });
});

describe('accessibility invoke (invoke_element)', () => {
  const invokeTool = buildUnifiedTools().find(t => t.name === 'invoke_element')!;
  const run = async (reply: Record<string, unknown>) => {
    const invokeElement = vi.fn(async () => ({ success: false, data: structuredMissFields(reply) }));
    const mouseClick = vi.fn(async () => {});
    const platform = { invokeElement, mouseClick, getActiveWindow: vi.fn(async () => null), listDisplays: vi.fn(async () => []) } as unknown as PlatformAdapter;
    const r = await invokeTool.execute({ name: 'New' }, { platform, task: 't', screen: { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 }, screenshotsCaptured: { n: 0 } } as unknown as AgentToolContext);
    return { r, invokeElement, mouseClick };
  };

  it('ambiguous: one bridge call (no select / toggle retries), no click, the list in the answer', async () => {
    const { r, invokeElement, mouseClick } = await run(AMBIGUOUS);
    expect(r.success).toBe(false);
    expect(invokeElement).toHaveBeenCalledTimes(1);
    expect(mouseClick).not.toHaveBeenCalled();
    expect(r.text).toContain('[MenuItem] "New" @2800,-1070 40x20');
    expect(r.text).toContain('[Button] "New" @2816,-1030 64x72');
  });

  it('hidden: one bridge call, no click, ELEMENT_HIDDEN', async () => {
    const { r, invokeElement, mouseClick } = await run({ success: false, reason: 'hidden' });
    expect(invokeElement).toHaveBeenCalledTimes(1);
    expect(mouseClick).not.toHaveBeenCalled();
    expect(classifyResult(r.text, true, true, 'mcp')?.code).toBe('ELEMENT_HIDDEN');
  });

  it('the ladder keeps the candidates of the rung that read the element', async () => {
    const { res } = await runActivationLadder(async () => ({ success: false, data: structuredMissFields(AMBIGUOUS) }), ['click', 'select', 'toggle']);
    expect((res.data as { candidates: unknown[] }).candidates).toHaveLength(2);
  });
});

// #386: one rule for which element a name means. The bridges pick; the replies say what was picked.
describe('the reply names the element acted on, and a partial match is listed, never pressed', () => {
  const INEXACT = { success: false, action: 'click', reason: 'ambiguous', inexact: true, error: 'no element is named exactly that',
    candidates: [{ name: "What's New", controlType: 'ControlType.Hyperlink', bounds: { x: 10, y: 20, width: 30, height: 40 }, container: { name: 'Start page', controlType: 'ControlType.Document' } }] };

  it('missText: an inexact list asks for the full name, names each one\'s container, and is AMBIGUOUS', () => {
    const text = missText(structuredMissFields(INEXACT));
    expect(text).toMatch(/^no element is named exactly that: 1 element on screen only contains it, nothing was done; to press one, call again with its full name/);
    expect(text).toContain('[Hyperlink] "What\'s New" in [Document] "Start page" @10,20 30x40');
    expect(classifyResult(`a11y invoke "New" missed — ${text}.`, true, true, 'mcp')?.code).toBe('AMBIGUOUS');
  });

  it('missText: several equal matches offer within when they are in different windows; a minimized window offers a restore, not a position', () => {
    const inBoxes = (...boxes: string[]) => missText(structuredMissFields({ ...AMBIGUOUS,
      candidates: CANDIDATES.map((c, i) => ({ ...c, container: { name: boxes[i], controlType: 'ControlType.Window' } })) }));
    expect(inBoxes('Designcenter', 'Options')).toMatch(/pick one with within \(the window or dialog it is in, as listed\)/);
    // Both in one window: within cannot tell them apart, so it is not offered.
    expect(inBoxes('Designcenter', 'Designcenter')).not.toMatch(/within/);
    const min = missText(structuredMissFields({ ...AMBIGUOUS, minimized: true, candidates: CANDIDATES.map(({ name, controlType }) => ({ name, controlType })) }));
    expect(min).toMatch(/its window is minimized, so none has a place to click: restore the window first/);
    expect(min).not.toMatch(/click its position/);
  });

  it('smart_click: "Clicked [Button] "Request tasks" (its name starts with "Request")", from the bridge\'s target', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    try {
      const { ctx, mouseClick } = ctxFor(async () => ({ success: true, action: 'click', method: 'InvokePattern',
        target: { name: 'Request tasks', controlType: 'ControlType.Button', match: 'prefix' } }));
      const r = await smartClick.handler({ target: 'Request', timeout: 1500 }, ctx);
      expect(r.text).toMatch(/^Clicked \[Button\] "Request tasks" \(its name starts with "Request"\) via UI Automation/);
      expect(mouseClick).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', realPlatform); }
  });

  it('smart_click: an inexact a11y answer is the answer; the OCR text is not clicked in its place', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    try {
      const { ctx, mouseClick } = ctxFor(async () => INEXACT);
      const r = await smartClick.handler({ target: 'New', timeout: 1500 }, ctx);
      expect(r.isError).toBe(true);
      expect(mouseClick).not.toHaveBeenCalled();
      expect(r.text).toMatch(/no element is named exactly that/);
    } finally { Object.defineProperty(process, 'platform', realPlatform); }
  });

  it('smart_click within: passed to the bridge; on a miss neither OCR nor the browser is tried', async () => {
    const { ctx, mouseClick, a11y } = ctxFor(async () => ({ success: false, reason: 'not_found' }));
    const r = await smartClick.handler({ target: 'New', within: 'Options', timeout: 1500 }, ctx);
    expect(a11y.invokeElement).toHaveBeenCalledWith(expect.objectContaining({ name: 'New', within: 'Options' }));
    expect(mouseClick).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/element not found by accessibility in that window or dialog/);
  });

  it('accessibility invoke: within reaches the platform; the success line names the element acted on', async () => {
    const invokeTool = buildUnifiedTools().find(t => t.name === 'invoke_element')!;
    const invokeElement = vi.fn(async () => ({ success: true, data: { target: { name: 'Close', controlType: 'Button', match: 'exact' } } }));
    const platform = { invokeElement, mouseClick: vi.fn(), getActiveWindow: vi.fn(async () => null), listDisplays: vi.fn(async () => []) } as unknown as PlatformAdapter;
    const r = await invokeTool.execute({ name: 'close', within: 'Options' }, { platform, task: 't', screen: { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 }, screenshotsCaptured: { n: 0 } } as unknown as AgentToolContext);
    expect(invokeElement).toHaveBeenCalledWith(expect.objectContaining({ name: 'close', within: 'Options' }));
    expect(r.text).toBe('Invoked [Button] "Close" via a11y.');
  });

  it('accessibility invoke: an expand read back that names the role is still [confirmed]', async () => {
    const invokeTool = buildUnifiedTools().find(t => t.name === 'invoke_element')!;
    const invokeElement = vi.fn(async () => ({ success: true, data: { expandState: 'Expanded', target: { name: 'Details', controlType: 'ControlType.Button', match: 'exact' } } }));
    const platform = { invokeElement, mouseClick: vi.fn(), getActiveWindow: vi.fn(async () => null), listDisplays: vi.fn(async () => []) } as unknown as PlatformAdapter;
    const r = await invokeTool.execute({ name: 'Details' }, { platform, task: 't', screen: { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 }, screenshotsCaptured: { n: 0 } } as unknown as AgentToolContext);
    expect(r.text).toMatch(/^Invoked \(read back ✓\) \[Button\] "Details" via a11y/);
    expect(classifyResult(r.text, false, true, 'mcp')?.outcome).toBe('confirmed');
  });

  it('the screen text in a target is quoted and bounded, never free text', () => {
    const t = targetOf({ name: 'a"b\n' + 'x'.repeat(200), controlType: 'ControlType.Button', match: 'exact' })!;
    expect(t.name.length).toBeLessThanOrEqual(80);
    expect(targetText(t, 'a')).toMatch(/^\[Button\] "a'b x+"$/);
    expect(targetOf({ name: 'x', match: 'fuzzy' })).toBeUndefined();
  });
});
