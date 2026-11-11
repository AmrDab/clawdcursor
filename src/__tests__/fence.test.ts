/**
 * The test and automation fence (core/fence.ts): with CLAWD_FENCE_PIDS set, nothing is done or read outside the fenced
 * processes. With it unset, nothing changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public left: number, public top: number, public width: number, public height: number) {} },
}));

import {
  FENCE_ENV, FENCED, fenceActive, fenceCdpOnly, fenceCheck, fenceGate, fenceInput, fenceMask, fenceRoots, fenceTools, inFence,
  isFenceRefusal, __setFenceDesktopForTests, __setFenceProcessTableForTests, type FenceWindow,
} from '../core/fence';
import { classifyResult } from '../core/result-codes';
import { outcomeOf } from '../surface/session-log';
import { isGuardRefusal, __setForegroundReaderForTests } from '../core/control';
import { guardedInput, pointerPress } from '../platform/pointer-guard';
import type { ToolDefinition, ToolContext } from '../tools/types';

// Processes: 100 is the fixture, 101 its child, 102 a grandchild. 200 is the owner's app, 300 a Store app frame host.
const TABLE = new Map([[100, 1], [101, 100], [102, 101], [200, 1], [201, 200], [300, 1], [400, 1]]);
const fenced = { [FENCE_ENV]: '100, 400' } as NodeJS.ProcessEnv;
const open = {} as NodeJS.ProcessEnv;

const fixture: FenceWindow = { processId: 101, processName: 'BenchFixture.exe', title: 'Bench Dialog', bounds: { x: 100, y: 100, width: 400, height: 300 } };
const owners: FenceWindow = { processId: 200, processName: 'OUTLOOK.EXE', title: 'Inbox - Bench Dialog notes', bounds: { x: 600, y: 100, width: 400, height: 300 } };
let front: FenceWindow | null = fixture;
let windows: FenceWindow[] = [fixture, owners];

const tool = (name: string, parameters: Record<string, unknown> = {}): ToolDefinition & { calls: Array<Record<string, unknown>> } => {
  const calls: Array<Record<string, unknown>> = [];
  return { name, description: name, parameters, category: 'test', calls,
    handler: async (params: Record<string, unknown>) => { calls.push(params); return { text: `${name} ran` }; } } as never;
};
const ctx = {} as ToolContext;
const targeted = { processId: { type: 'number' }, title: { type: 'string' }, processName: { type: 'string' } };

beforeEach(() => {
  front = fixture;
  windows = [fixture, owners];
  __setFenceProcessTableForTests(async () => TABLE);
  __setFenceDesktopForTests({ foreground: async () => front, windows: async () => windows });
});
afterEach(() => {
  __setFenceProcessTableForTests(null);
  __setFenceDesktopForTests(null);
  delete process.env[FENCE_ENV];
});

describe('with CLAWD_FENCE_PIDS unset, nothing changes', () => {
  it('there is no fence', () => {
    expect(fenceRoots(open)).toBeNull();
    expect(fenceActive(open)).toBe(false);
    expect(fenceActive({ [FENCE_ENV]: '  ' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('the tool list is returned as it is: the same array, the same handlers', () => {
    const tools = [tool('get_windows'), tool('read_clipboard'), tool('open_url')];
    expect(fenceTools(tools, open)).toBe(tools);
  });

  it('every check passes without asking the desktop anything', async () => {
    __setFenceDesktopForTests({ foreground: async () => { throw new Error('asked'); }, windows: async () => { throw new Error('asked'); } });
    __setFenceProcessTableForTests(async () => { throw new Error('asked'); });
    const params = { title: 'Inbox' };
    expect(await fenceGate(tool('close_window', targeted), params, open)).toBe(params);
    await expect(fenceCheck('x', { pid: 200 }, open)).resolves.toBeUndefined();
    await expect(fenceCheck('x', { foreground: true }, open)).resolves.toBeUndefined();
    await expect(fenceInput(owners, { points: [{ x: 5000, y: 5000 }], boundsPerMouse: 1 }, open)).resolves.toBeUndefined();
    const image = Buffer.from('not even an image');
    expect(await fenceMask(image, { originX: 0, originY: 0, scale: 1 }, open)).toBe(image);
    expect(fenceCdpOnly(9333, open)).toBeUndefined();
  });

  it('the input guard sends input as before', async () => {
    __setForegroundReaderForTests(async () => ({ processId: 200, processName: 'OUTLOOK.EXE' }));
    const send = vi.fn(async () => 'sent');
    expect(await guardedInput('typeText', ['hi'], send)).toBe('sent');
    __setForegroundReaderForTests(async () => null);
  });
});

describe('which processes are inside', () => {
  it('reads the fenced roots', () => {
    expect(fenceRoots(fenced)).toEqual([100, 400]);
    expect(fenceRoots({ [FENCE_ENV]: 'abc' } as NodeJS.ProcessEnv)).toEqual([]);   // set but empty: everything is outside
  });

  it('a root, its children and their children are inside; its parent and strangers are not', async () => {
    for (const pid of [100, 101, 102, 400]) expect(await inFence(pid, fenced), String(pid)).toBe(true);
    for (const pid of [1, 200, 201, 300, 9999, 0, undefined]) expect(await inFence(pid, fenced), String(pid)).toBe(false);
  });

  it('fails closed when the process table cannot be read, and when the fence names no process', async () => {
    __setFenceProcessTableForTests(async () => { throw new Error('no ps'); });
    expect(await inFence(101, fenced)).toBe(false);
    expect(await inFence(100, fenced)).toBe(true);    // a root needs no table
    expect(await inFence(100, { [FENCE_ENV]: 'abc' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('reads the table again for a process started since', async () => {
    let table = new Map([[100, 1]]);
    __setFenceProcessTableForTests(async () => table);
    expect(await inFence(100, fenced)).toBe(true);
    expect(await inFence(555, fenced)).toBe(false);
    table = new Map([[100, 1], [555, 100]]);
    await new Promise(r => setTimeout(r, 250));
    expect(await inFence(555, fenced)).toBe(true);
  });
});

describe('the gate on every tool', () => {
  const refused = async (t: ToolDefinition, params: Record<string, unknown> = {}) => {
    const r = await fenceTools([t], fenced)[0].handler(params, ctx);
    return !!r.isError && r.text.startsWith(FENCED);
  };

  it.each(['get_windows', 'read_clipboard', 'write_clipboard', 'open_app', 'open_file', 'open_url', 'open_uri', 'navigate_browser',
    'switch_tab_os', 'shortcuts_execute', 'relaunch_with_cdp', 'detect_webview_apps', 'session_report', 'pause_for_user',
    'desktop_screenshot_region', 'ocr_read_screen', 'ocr_find_text'])('%s is refused, and its handler never runs', async name => {
    const t = tool(name);
    expect(await refused(t, { url: 'https://example.com', title: 'Bench Dialog' })).toBe(true);
    expect(t.calls).toEqual([]);
  });

  it.each(['wait', 'get_system_time', 'get_screen_size', 'cdp_click', 'cdp_read_text'])('%s runs: it touches no window (or only the fenced browser)', async name => {
    front = owners;
    const t = tool(name);
    expect(await refused(t)).toBe(false);
    expect(t.calls).toHaveLength(1);
  });

  it('a call with no target acts on the window in front: it runs only when that window is fenced', async () => {
    for (const name of ['read_screen', 'find_element', 'invoke_element', 'type_text', 'key_press', 'mouse_click', 'desktop_screenshot',
      'get_active_window', 'copy_all_text', 'a_tool_added_next_year']) {
      front = fixture;
      const ok = tool(name);
      expect(await refused(ok), name).toBe(false);
      front = owners;
      const no = tool(name);
      expect(await refused(no), name).toBe(true);
      expect(no.calls, name).toEqual([]);
    }
  });

  it('is refused when the window in front cannot be read', async () => {
    front = null;
    expect(await refused(tool('read_screen'))).toBe(true);
    __setFenceDesktopForTests({ foreground: async () => { throw new Error('bridge down'); }, windows: async () => [] });
    expect(await refused(tool('type_text'))).toBe(true);
  });

  it('a processId names the target: reads and acts on another process are refused, whatever is in front', async () => {
    expect(await refused(tool('read_screen', targeted), { processId: 200 })).toBe(true);
    expect(await refused(tool('invoke_element', targeted), { processId: 201, name: 'Send' })).toBe(true);
    front = owners;
    expect(await refused(tool('read_screen', targeted), { processId: 102 })).toBe(false);
  });

  it.each(['focus_window', 'close_window', 'minimize_window_to_taskbar', 'maximize_window', 'restore_window', 'resize_window'])(
    '%s on a window of the owner is refused by title, by process name and by pid', async name => {
      for (const params of [{ title: 'Inbox' }, { processName: 'outlook' }, { processId: 200 }]) {
        const t = tool(name, targeted);
        expect(await refused(t, params), JSON.stringify(params)).toBe(true);
        expect(t.calls).toEqual([]);
      }
    });

  it('a title that matches a fenced window AND one of the owner is refused', async () => {
    expect(await refused(tool('close_window', targeted), { title: 'bench dialog' })).toBe(true);
  });

  it('a title that matches nothing is refused: the tool could resolve it differently', async () => {
    expect(await refused(tool('focus_window', targeted), { title: 'Calculator' })).toBe(true);
  });

  it('a name that matches only the fixture is pinned to its process before the tool runs', async () => {
    const t = tool('focus_window', targeted);
    expect(await refused(t, { processName: 'benchfixture', title: undefined })).toBe(false);
    expect(t.calls).toEqual([{ processId: 101 }]);
  });

  it('a Store app counts by the process its frame hosts', async () => {
    front = { processId: 300, hostedProcessId: 400, processName: 'ApplicationFrameHost.exe', title: 'Calculator' };
    expect(await refused(tool('type_text'))).toBe(false);
    front = { processId: 300, hostedProcessId: 201, processName: 'ApplicationFrameHost.exe', title: 'Mail' };
    expect(await refused(tool('type_text'))).toBe(true);
  });

  it('the refusal says what was refused and that nothing happened', async () => {
    const r = await fenceTools([tool('get_windows')], fenced)[0].handler({}, ctx);
    expect(r.text).toMatch(/^FENCED: get_windows is outside the test fence \(CLAWD_FENCE_PIDS\) — nothing was done and nothing was read\.$/);
    expect(isFenceRefusal(new Error(r.text))).toBe(true);
    expect(isGuardRefusal(new Error(r.text))).toBe(true);
  });
});

describe('through the real tool list', () => {
  it('a compound action and every step of a batch reach the gate', async () => {
    process.env[FENCE_ENV] = '100';
    vi.resetModules();
    const fence = await import('../core/fence');
    fence.__setFenceProcessTableForTests(async () => TABLE);
    fence.__setFenceDesktopForTests({ foreground: async () => owners, windows: async () => windows });
    const { getTools } = await import('../tools/registry');
    const compact = getTools({ palette: 'compact' });
    const run = (name: string, params: Record<string, unknown>) => compact.find(t => t.name === name)!.handler(params, { ensureInitialized: async () => {} } as ToolContext);

    for (const [name, params] of [
      ['window', { action: 'list' }], ['window', { action: 'close', title: 'Inbox' }], ['window', { action: 'open_url', url: 'https://example.com' }],
      ['system', { action: 'clipboard_read' }], ['system', { action: 'clipboard_write', text: 'x' }], ['system', { action: 'ocr' }],
      ['computer', { action: 'screenshot' }], ['computer', { action: 'type', text: 'hello' }], ['accessibility', { action: 'read_tree', processId: 200 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await run(name, params);
      expect(r.isError, `${name} ${params.action}`).toBe(true);
      expect(r.text, `${name} ${params.action}`).toContain(FENCED);
    }

    // A batch: the first step is harmless and runs, the second is refused, and the third never runs.
    const batch = await run('batch', { steps: [
      { name: 'computer', arguments: { action: 'wait', seconds: 0.01 } },
      { name: 'computer', arguments: { action: 'type', text: 'to the owner' } },
      { name: 'window', arguments: { action: 'close', title: 'Inbox' } },
    ] });
    expect(batch.isError).toBe(true);
    expect(batch.text).toContain(FENCED);
    expect(batch.steps?.map(s => s.status)).toEqual(['ok', 'error']);   // halted at the refused step: the third never ran
  });

  it('without the variable the same list has the plain handlers', async () => {
    delete process.env[FENCE_ENV];
    vi.resetModules();
    const fence = await import('../core/fence');
    const spy = vi.spyOn(fence, 'fenceGate');
    const { getTools } = await import('../tools/registry');
    const r = await getTools().find(t => t.name === 'wait')!.handler({ seconds: 0.01 }, { ensureInitialized: async () => {} } as ToolContext);
    expect(r.isError).toBeFalsy();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('input', () => {
  it('goes only to a fenced window in front', async () => {
    await expect(fenceInput(fixture, undefined, fenced)).resolves.toBeUndefined();
    await expect(fenceInput(owners, undefined, fenced)).rejects.toThrow(/^FENCED: input/);
    await expect(fenceInput(null, undefined, fenced)).rejects.toThrow(FENCED);
  });

  it('a pointer press must land inside the fenced window', async () => {
    const press = (x: number, y: number, boundsPerMouse = 1) => fenceInput(fixture, { points: [{ x, y }], boundsPerMouse }, fenced);
    await expect(press(300, 250)).resolves.toBeUndefined();
    await expect(press(100, 100)).resolves.toBeUndefined();          // the corner
    await expect(press(700, 250)).rejects.toThrow(/not inside the fenced window/);   // the owner's window beside it
    await expect(press(300, 20)).rejects.toThrow(FENCED);
    // Windows: bounds are physical pixels, the mouse moves in logical ones (150% scaling here).
    await expect(press(200, 150, 1.5)).resolves.toBeUndefined();     // (300, 225) physical
    await expect(press(400, 150, 1.5)).rejects.toThrow(FENCED);      // (600, 225) physical: outside
  });

  it('every point of a drag is checked, and a window with no bounds takes no pointer', async () => {
    await expect(fenceInput(fixture, { points: [{ x: 150, y: 150 }, { x: 700, y: 150 }], boundsPerMouse: 1 }, fenced)).rejects.toThrow(FENCED);
    await expect(fenceInput({ processId: 101 }, { points: [{ x: 150, y: 150 }], boundsPerMouse: 1 }, fenced)).rejects.toThrow(/no known bounds/);
  });

  it('the pointer methods say where they press', () => {
    const desktop = { dpiRatio: 1.5 };
    const k = process.platform === 'win32' ? 1.5 : 1;
    expect(pointerPress('mouseClick', [10, 20, 1], desktop)).toEqual({ points: [{ x: 10, y: 20 }], boundsPerMouse: k });
    expect(pointerPress('mouseDrag', [10, 20, 30, 40], desktop)).toEqual({ points: [{ x: 10, y: 20 }, { x: 30, y: 40 }], boundsPerMouse: k });
    expect(pointerPress('mouseScroll', [10, 20, -3], desktop)?.points).toEqual([{ x: 10, y: 20 }]);
    expect(pointerPress('executeMouseAction', [{ kind: 'drag', x: 1, y: 2, endX: 3, endY: 4 }], {})).toEqual({ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], boundsPerMouse: 1 });
    expect(pointerPress('typeText', ['hello'], desktop)).toBeUndefined();
    expect(pointerPress('keyPress', ['ctrl+a'], desktop)).toBeUndefined();
  });

  it('the input guard refuses before anything is sent: wrong window, a click beside the window, no foreground', async () => {
    process.env[FENCE_ENV] = '100';
    const send = vi.fn(async () => 'sent');
    __setForegroundReaderForTests(async () => ({ processId: 200, processName: 'OUTLOOK.EXE' }));
    await expect(guardedInput('typeText', ['hi'], send)).rejects.toThrow(FENCED);
    __setForegroundReaderForTests(async () => null);
    await expect(guardedInput('typeText', ['hi'], send)).rejects.toThrow(FENCED);
    expect(send).not.toHaveBeenCalled();
    __setForegroundReaderForTests(async () => ({ processId: 101, processName: 'BenchFixture' }));
    expect(await guardedInput('typeText', ['hi'], send)).toBe('sent');
    __setForegroundReaderForTests(async () => null);
  });
});

describe('a screenshot under the fence', () => {
  const white = () => sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const pixel = async (buf: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels];
  };

  it('shows the fenced window and blacks out the rest, at the same size', async () => {
    // The screen is 800x400, the image half that; the fixture window is at (100,100) 400x300 on screen.
    const out = await fenceMask(await white(), { originX: 0, originY: 0, scale: 4 }, fenced);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([200, 100, 'png']);
    expect(await pixel(out, 60, 50)).toBe(255);      // inside the window: (240, 200) on screen
    expect(await pixel(out, 10, 10)).toBe(0);        // left of it
    expect(await pixel(out, 160, 50)).toBe(0);       // the owner's window beside it
  });

  it('is refused when the window in front is not fenced, or has no bounds, or is on another display', async () => {
    front = owners;
    await expect(fenceMask(await white(), { originX: 0, originY: 0, scale: 4 }, fenced)).rejects.toThrow(FENCED);
    front = { processId: 101 };
    await expect(fenceMask(await white(), { originX: 0, originY: 0, scale: 4 }, fenced)).rejects.toThrow(/no known bounds/);
    front = fixture;
    await expect(fenceMask(await white(), { originX: 5000, originY: 0, scale: 4 }, fenced)).rejects.toThrow(/not on this display/);
  });
});

describe('the browser driver, results and the log', () => {
  it('may attach only to the agent\'s own port', () => {
    expect(fenceCdpOnly(9333, fenced)).toBe(9333);
  });

  it('a refusal is the code FENCED, a refusal and not a failure', () => {
    const text = `${FENCED}get_windows is outside the test fence (CLAWD_FENCE_PIDS) — nothing was done and nothing was read.`;
    expect(classifyResult(text, true, true)).toMatchObject({ outcome: 'refused', code: 'FENCED' });
    expect(classifyResult(`window: ${text}`, true, false)).toMatchObject({ code: 'FENCED' });
    expect(outcomeOf(true, text)).toBe('refused');
    expect(outcomeOf(false, 'Typed "FENCED: " into the field')).toBe('ok');
  });
});
