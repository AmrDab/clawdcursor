/**
 * OS-agnostic a11y activation cascade.
 *
 * THE BLIND-ROUTE PROBLEM
 * -----------------------
 * `invoke_element` (and the MCP `accessibility.invoke`) maps to ONE UIA
 * pattern attempt. Live test 2026-06-07: `invoke "Cool blue"` (a ListItem in
 * a color grid) FAILED — ListItems expose SelectionItemPattern, not
 * InvokePattern/TogglePattern — while `select "Cool blue"` worked. A blind
 * agent that can't see which pattern an element supports then either retries
 * verbs (wastes turns) or falls back to `computer.click(x,y)`, which needs a
 * SCREENSHOT for the coordinates — the exact expensive path clawdcursor exists
 * to avoid (OpenClaw token cost).
 *
 * THE FIX (this test locks it)
 * ----------------------------
 * `invoke_element` with the default/activate intent (`action:"click"` or
 * unspecified) cascades across activation verbs when the adapter reports the
 * element wasn't actionable: click → select → toggle. Pure adapter-string
 * retries, so it works on EVERY platform with zero per-OS code. EXPLICIT verbs
 * (expand/collapse/get-value/set-value/focus) stay strict — the agent that
 * asked to expand does not silently get a select.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PlatformAdapter, InvokeAction } from '../platform/types';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext, UnifiedTool } from '../core/agent-loop/types';

function findTool(name: string): UnifiedTool {
  const t = buildUnifiedTools().find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

/** Adapter whose invokeElement succeeds ONLY for the actions in `succeedsFor`.
 *  Records the ordered list of actions attempted. */
function makeAdapter(succeedsFor: InvokeAction[]) {
  const attempts: InvokeAction[] = [];
  const invokeElement = vi.fn(async (q: { action?: InvokeAction; value?: string }) => {
    const action = q.action ?? 'click';
    attempts.push(action);
    if (succeedsFor.includes(action)) {
      return action === 'get-value'
        ? { success: true, data: { value: 'readback' } }
        : { success: true };
    }
    return { success: false, error: `${action} pattern not supported` };
  });
  const adapter = { invokeElement, getActiveWindow: vi.fn(async () => null) } as unknown as PlatformAdapter;
  return { adapter, attempts, invokeElement };
}

/** Adapter whose invokeElement always MISSES the pattern but reports the found
 *  element's bounds (what the Windows/macOS bridges return when an element is
 *  found but exposes no invoke/toggle/select pattern). */
function makeBoundsAdapter(bounds: { x: number; y: number; width: number; height: number } | undefined) {
  const mouseClick = vi.fn(async () => {});
  const invokeElement = vi.fn(async () => ({ success: false, bounds }));
  const adapter = {
    invokeElement, mouseClick,
    getActiveWindow: vi.fn(async () => null),
    listDisplays: vi.fn(async () => [
      { index: 0, label: 'Display 1', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, physicalSize: { width: 1920, height: 1080 }, dpiRatio: 1 },
    ]),
  } as unknown as PlatformAdapter;
  return { adapter, mouseClick, invokeElement };
}

function makeCtx(adapter: PlatformAdapter): AgentToolContext {
  return {
    platform: adapter,
    task: 'test',
    screen: { logicalWidth: 1920, logicalHeight: 1080, physicalWidth: 1920, physicalHeight: 1080, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 },
  } as unknown as AgentToolContext;
}

describe('invoke_element — OS-agnostic activation cascade', () => {
  it('succeeds directly when the element supports the primary (click) pattern', async () => {
    const { adapter, attempts } = makeAdapter(['click']);
    const r = await findTool('invoke_element').execute({ name: 'Send' }, makeCtx(adapter));
    expect(r.success).toBe(true);
    expect(attempts).toEqual(['click']); // no needless extra round-trips
  });

  it('cascades click → select for a ListItem (the "Cool blue" live regression)', async () => {
    const { adapter, attempts } = makeAdapter(['select']); // ListItem: SelectionItemPattern only
    const r = await findTool('invoke_element').execute({ name: 'Cool blue' }, makeCtx(adapter));
    expect(r.success).toBe(true);
    expect(attempts).toEqual(['click', 'select']);
    expect(r.text.toLowerCase()).toContain('select'); // reports which verb worked
  });

  it('cascades click → select → toggle when only toggle works', async () => {
    const { adapter, attempts } = makeAdapter(['toggle']);
    const r = await findTool('invoke_element').execute({ name: 'Wi-Fi' }, makeCtx(adapter));
    expect(r.success).toBe(true);
    expect(attempts).toEqual(['click', 'select', 'toggle']);
  });

  it('reports a single clean failure (not a verb dump) when nothing activates', async () => {
    const { adapter, attempts } = makeAdapter([]); // element actionable by nothing
    const r = await findTool('invoke_element').execute({ name: 'Ghost' }, makeCtx(adapter));
    expect(r.success).toBe(false);
    expect(attempts).toEqual(['click', 'select', 'toggle']); // tried the ladder
    expect(r.text).toContain('Ghost');
  });

  it('does NOT cascade for an EXPLICIT non-activate verb (expand stays strict)', async () => {
    const { adapter, attempts } = makeAdapter(['select']); // select would work…
    const r = await findTool('invoke_element').execute({ name: 'Tree node', action: 'expand' }, makeCtx(adapter));
    expect(r.success).toBe(false); // …but the agent asked to EXPAND, so no silent select
    expect(attempts).toEqual(['expand']);
  });

  it('does NOT cascade get-value (a read, not an activation)', async () => {
    const { adapter, attempts } = makeAdapter([]);
    await findTool('invoke_element').execute({ name: 'Field', action: 'get-value' }, makeCtx(adapter));
    expect(attempts).toEqual(['get-value']);
  });
});

/**
 * Live regression (Windows 11 / Edge, 2026-10): `invoke name:"Switch client
 * type, Organizations"` reported "missed — element not found or not
 * actionable" while `find` returned that very Button and smart_click
 * succeeded "via a11y bounds (coordinate fallback)". The bridge FOUND the
 * element (no invoke/toggle/select pattern) and handed back its centre; the
 * by-name path threw that away. It must fall back to clicking the bounds
 * centre — but only when the bounds are sane and on-screen.
 */
describe('invoke_element — by-name bounds fallback when no pattern activates', () => {
  it('clicks the bounds centre and reports the coordinate fallback', async () => {
    const { adapter, mouseClick } = makeBoundsAdapter({ x: 100, y: 200, width: 50, height: 20 });
    const r = await findTool('invoke_element').execute({ name: 'Switch client type, Organizations' }, makeCtx(adapter));
    expect(r.success).toBe(true);
    expect(mouseClick).toHaveBeenCalledWith(125, 210);
    expect(r.text).toMatch(/via a11y bounds \(coordinate fallback/);
  });

  it('never clicks INT_MIN / degenerate bounds (UIA "no rectangle" sentinel)', async () => {
    const { adapter, mouseClick } = makeBoundsAdapter({ x: -2147483648, y: -2147483648, width: 0, height: 0 });
    const r = await findTool('invoke_element').execute({ name: 'Ghost' }, makeCtx(adapter));
    expect(r.success).toBe(false);
    expect(mouseClick).not.toHaveBeenCalled();
  });

  it('never clicks bounds whose centre is outside the virtual screen', async () => {
    const { adapter, mouseClick } = makeBoundsAdapter({ x: 5000, y: 200, width: 50, height: 20 });
    const r = await findTool('invoke_element').execute({ name: 'Offscreen' }, makeCtx(adapter));
    expect(r.success).toBe(false);
    expect(mouseClick).not.toHaveBeenCalled();
  });

  it('does not coordinate-click for an explicit non-activate verb (expand stays strict)', async () => {
    const { adapter, mouseClick } = makeBoundsAdapter({ x: 100, y: 200, width: 50, height: 20 });
    const r = await findTool('invoke_element').execute({ name: 'Node', action: 'expand' }, makeCtx(adapter));
    expect(r.success).toBe(false);
    expect(mouseClick).not.toHaveBeenCalled();
  });
});
