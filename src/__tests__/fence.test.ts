/**
 * The test and automation fence (core/fence.ts): with CLAWD_FENCE_PIDS set, nothing is done or read outside the fenced
 * processes. It is an allow list: a tool that is not classified is refused. With the variable unset, nothing changes.
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
  FENCE_ENV, FENCE_POLICY, FENCED, fenceActive, fenceCapturing, fenceCdpOnly, fenceCheck, fenceGate, fenceImage, fenceInput, fenceKind, fenceMask,
  fenceOcrCapture, fenceOcrText, fencePlatform, fencePointer, fenceRoots, fenceTools, fenceWindowList, inFence, isFenceRefusal, normaliseTargets, pointerPoints,
  primaryRect, wholly, __setFenceDesktopForTests, __setFencePlatformForTests, __setFenceProcessTableForTests, type FenceWindow, type Rect,
} from '../core/fence';
import { __setFrameHostReaderForTests } from '../platform/frame-host';
import { classifyResult } from '../core/result-codes';
import { outcomeOf } from '../surface/session-log';
import { isGuardRefusal, __setForegroundReaderForTests } from '../core/control';
import { guardInputMethods, guardedInput } from '../platform/pointer-guard';
import { getTools } from '../tools/registry';
import { COMPOUND_ROUTE_INDEX } from '../tools/compact';
import type { ToolDefinition, ToolContext } from '../tools/types';

// Processes: 100 is the fixture, 101 its child, 102 a grandchild. 200 is the owner's app. 300 is ApplicationFrameHost,
// which hosts the fixture's Store app (400) and the owner's (201).
const TABLE = new Map([[100, 1], [101, 100], [102, 101], [200, 1], [201, 200], [300, 1], [400, 1]]);
const fenced = { [FENCE_ENV]: '100, 400' } as NodeJS.ProcessEnv;
const open = {} as NodeJS.ProcessEnv;

const fixture: FenceWindow = { processId: 101, processName: 'BenchFixture.exe', title: 'Bench Dialog', handle: 7001, bounds: { x: 100, y: 100, width: 400, height: 300 } };
const owners: FenceWindow = { processId: 200, processName: 'OUTLOOK.EXE', title: 'Inbox - Bench Dialog notes', handle: 7002, bounds: { x: 600, y: 100, width: 400, height: 300 } };
const calc: FenceWindow = { processId: 300, hostedProcessId: 400, processName: 'ApplicationFrameHost.exe', title: 'Calculator', handle: 7003, bounds: { x: 100, y: 500, width: 300, height: 400 } };
const settings: FenceWindow = { processId: 300, hostedProcessId: 201, processName: 'ApplicationFrameHost.exe', title: 'Settings', handle: 7004, bounds: { x: 500, y: 500, width: 300, height: 400 } };
let front: FenceWindow | null = fixture;
let windows: FenceWindow[] = [fixture, owners];
let cursor: { x: number; y: number } | null = { x: 300, y: 250 };
let primary: Rect | null = { x: 0, y: 0, width: 3840, height: 2400 };

const tool = (name: string, parameters: Record<string, unknown> = {}, result: object = {}): ToolDefinition & { calls: Array<Record<string, unknown>> } => {
  const calls: Array<Record<string, unknown>> = [];
  return { name, description: name, parameters, category: 'test', calls,
    handler: async (params: Record<string, unknown>) => { calls.push(params); return { text: `${name} ran`, ...result }; } } as never;
};
const ctx = {} as ToolContext;
const targeted = { processId: { type: 'number' }, title: { type: 'string' }, processName: { type: 'string' } };
const run = (t: ToolDefinition, params: Record<string, unknown> = {}) => fenceTools([t], fenced)[0].handler(params, ctx);
/** A capture as a tool call makes it: the window in front is read first (the gate does this), then the capture is masked. */
const image = (buf: Buffer, mime: string, frame: Parameters<typeof fenceImage>[2]) => fenceCapturing(() => fenceImage(buf, mime, frame, fenced), fenced);
const ocrCapture = (png: Buffer, at: { x: number; y: number }) => fenceCapturing(() => fenceOcrCapture(png, at, fenced), fenced);
const refused = async (t: ToolDefinition, params: Record<string, unknown> = {}) => {
  const r = await run(t, params);
  return !!r.isError && r.text.startsWith(FENCED);
};

beforeEach(() => {
  front = fixture; windows = [fixture, owners]; cursor = { x: 300, y: 250 }; primary = { x: 0, y: 0, width: 3840, height: 2400 };
  __setFenceProcessTableForTests(async () => TABLE);
  __setFenceDesktopForTests({ foreground: async () => front, windows: async () => windows, cursor: async () => cursor, primary: async () => primary });
  __setFencePlatformForTests('win32');   // where the window tools take an exact handle
  // What the bridge says each frame hosts, by window handle: the fence asks it for every decision.
  __setFrameHostReaderForTests(async () => new Map([['7003', { processId: 400, processName: 'CalculatorApp' }], ['7004', { processId: 201, processName: 'SystemSettings' }]]));
});
afterEach(() => {
  __setFenceProcessTableForTests(null);
  __setFenceDesktopForTests(null);
  __setFencePlatformForTests(null);
  __setFrameHostReaderForTests(null);
  __setForegroundReaderForTests(async () => null);
  delete process.env[FENCE_ENV];
});

describe('with CLAWD_FENCE_PIDS unset, nothing changes', () => {
  it('there is no fence', () => {
    expect(fenceRoots(open)).toBeNull();
    expect(fenceActive(open)).toBe(false);
    expect(fenceActive({ [FENCE_ENV]: '  ' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('the tool list and the platform adapter are returned as they are', () => {
    const tools = [tool('get_windows'), tool('read_clipboard'), tool('a_tool_nobody_classified')];
    expect(fenceTools(tools, open)).toBe(tools);
    const adapter = { listWindows: async () => [owners] };
    const list = adapter.listWindows;
    expect(fencePlatform(adapter, open)).toBe(adapter);
    expect(adapter.listWindows).toBe(list);
  });

  it('every check passes without asking the desktop anything', async () => {
    const asked = async (): Promise<never> => { throw new Error('asked'); };
    __setFenceDesktopForTests({ foreground: asked, windows: asked, cursor: asked, primary: asked });
    __setFenceProcessTableForTests(asked);
    const params = { title: 'Inbox', processId: 'not a number' };
    expect(await fenceGate(tool('close_window', targeted), params, open)).toBe(params);
    await expect(fenceCheck('x', { pid: 200 }, open)).resolves.toBeUndefined();
    await expect(fenceInput(owners, open)).resolves.toBeUndefined();
    await expect(fencePointer('mouseClick', [5000, 5000], open)).resolves.toBeUndefined();
    await expect(fencePointer('mouseDown', [], open)).resolves.toBeUndefined();
    const ocr = { elements: [{ text: 'secret', x: 5000, y: 5000, width: 10, height: 10, line: 0 }], fullText: 'secret' };
    expect(await fenceOcrText(ocr, open)).toBe(ocr);
    const png = Buffer.from('png');
    expect(await fenceOcrCapture(png, { x: 0, y: 0 }, open)).toBe(png);
    const image = Buffer.from('not even an image');
    expect(await fenceMask(image, { originX: 0, originY: 0, scale: 1 }, open)).toBe(image);
    expect(await fenceImage(image, 'image/png', { originX: 0, originY: 0, scale: 1 }, open)).toEqual({ data: image.toString('base64'), mimeType: 'image/png' });
    expect(fenceCdpOnly(9333, open)).toBeUndefined();
  });

  it('the input guard sends input as before, and typing is not split', async () => {
    __setForegroundReaderForTests(async () => ({ processId: 200, processName: 'OUTLOOK.EXE' }));
    const send = vi.fn(async () => 'sent');
    expect(await guardedInput('typeText', ['hi'], send)).toBe('sent');
    const typed: string[] = [];
    const desk = guardInputMethods({ typeText: async (t: string) => { typed.push(t); }, mouseDown: async () => 'down' });
    await desk.typeText('one\ntwo\tthree');
    expect(typed).toEqual(['one\ntwo\tthree']);
    expect(await desk.mouseDown()).toBe('down');
  });

  it('the pointer methods of a driver are the originals, and so is a window list', () => {
    class Driver { async mouseMove() {} async mouseMoveRelative() {} async mouseUp() {} async mouseDragStepped() {} async getWindows() { return []; } }
    const d = guardInputMethods(new Driver());
    // Methods the input guard itself does not wrap: with no fence nothing else may wrap them either.
    for (const m of ['mouseMoveRelative', 'mouseUp', 'mouseDragStepped'] as const) {
      expect(Object.prototype.hasOwnProperty.call(d, m), m).toBe(false);
      expect(d[m]).toBe(Driver.prototype[m]);
    }
    expect(fenceWindowList(d, 'getWindows', open).getWindows).toBe(Driver.prototype.getWindows);
  });

  it('a capture needs no call scope, and none is made', async () => {
    let ran = false;
    expect(await fenceCapturing(async () => { ran = true; return 7; }, open)).toBe(7);
    expect(ran).toBe(true);
  });

  it('text that happens to say FENCED is not a fence refusal', () => {
    const text = `${FENCED}get_windows is outside the test fence`;
    expect(classifyResult(text, true, true)?.code).not.toBe('FENCED');
    expect(outcomeOf(true, text)).toBe('error');
  });
});

describe('an allow list: every tool is classified, and what is not is refused', () => {
  const granular = getTools().map(t => t.name);
  const compact = getTools({ palette: 'compact' }).map(t => t.name);
  const classified = (name: string) => Object.prototype.hasOwnProperty.call(FENCE_POLICY, name);

  it('every tool in tools/list, on both surfaces, is in the table', () => {
    expect(granular.length).toBeGreaterThan(80);
    expect(compact).toEqual(['accessibility', 'system', 'window', 'browser', 'computer', 'batch']);
    const missing = [...granular, ...compact].filter(n => !classified(n));
    expect(missing, `classify these in FENCE_POLICY (src/core/fence.ts): ${missing.join(', ')}`).toEqual([]);
  });

  it('every action of every compound tool runs a classified tool', () => {
    const unclassified: string[] = [];
    let actions = 0;
    for (const [compound, routes] of Object.entries(COMPOUND_ROUTE_INDEX)) {
      for (const r of routes) { actions++; if (!classified(r.delegate)) unclassified.push(`${compound} ${r.action} -> ${r.delegate}`); }
    }
    expect(actions).toBeGreaterThan(80);
    expect(unclassified).toEqual([]);
  });

  it('the table names no tool that does not exist', () => {
    const known = new Set([...granular, ...compact]);
    expect(Object.keys(FENCE_POLICY).filter(n => !known.has(n))).toEqual([]);
  });

  it('a tool that is not in the table is refused, and never runs', async () => {
    expect(fenceKind('a_tool_added_next_year')).toBe('refuse');
    expect(fenceKind('constructor')).toBe('refuse');
    const t = tool('a_tool_added_next_year');
    expect(await refused(t)).toBe(true);
    expect(t.calls).toEqual([]);
  });

  it.each(['get_windows', 'read_clipboard', 'write_clipboard',
    'open_app', 'open_file', 'open_url', 'open_uri', 'navigate_browser', 'switch_tab_os', 'relaunch_with_cdp', 'detect_webview_apps',
    'shortcuts_execute', 'session_report', 'submit_report', 'logs_recent', 'verify', 'pause_for_user', 'resume_task',
    'cdp_evaluate'])('%s is refused whatever is in front', async name => {
    expect(fenceKind(name)).toBe('refuse');
    const t = tool(name);
    expect(await refused(t, { scope: 'window', processId: 101, title: 'Bench Dialog' })).toBe(true);
    expect(t.calls).toEqual([]);
  });

  it('undo_last acts, so it is checked like an act', async () => {
    expect(fenceKind('undo_last')).toBe('act');
    expect(await refused(tool('undo_last'))).toBe(false);
    front = owners;
    expect(await refused(tool('undo_last'))).toBe(true);
  });

  it('OCR and the smart tools are scoped, not refused: a read or an act of one fenced window', () => {
    expect(['ocr_read_screen', 'smart_read', 'smart_click', 'smart_type', 'desktop_screenshot_region'].map(fenceKind)).toEqual(['read', 'read', 'act', 'act', 'capture']);
  });

  it.each(['read_screen', 'find_element', 'compile_ui', 'find_action_button', 'find_input_field', 'a11y_get_value', 'copy_all_text',
    'ocr_read_screen', 'smart_read', 'smart_click', 'smart_type',
    'get_active_window', 'invoke_element', 'set_field_value', 'type_text', 'key_press', 'mouse_click', 'mouse_hover', 'mouse_move_relative',
    'mouse_down', 'mouse_up'])('%s runs only with a fenced window in front', async name => {
    expect(await refused(tool(name))).toBe(false);
    front = owners;
    const t = tool(name);
    expect(await refused(t)).toBe(true);
    expect(t.calls).toEqual([]);
    front = null;
    expect(await refused(tool(name))).toBe(true);
  });

  it.each(['wait', 'get_system_time', 'get_screen_size', 'cursor_position', 'cdp_click', 'cdp_read_text'])('%s runs: it touches no window (or only the fenced browser)', async name => {
    front = owners;
    expect(await refused(tool(name))).toBe(false);
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
});

describe('the process table is read once, not once per check', () => {
  const slowReader = () => {
    let reads = 0;
    __setFenceProcessTableForTests(async () => { reads++; await new Promise(r => setTimeout(r, 120)); return TABLE; });
    return () => reads;
  };

  it('checks that arrive together share one read', async () => {
    const reads = slowReader();
    const answers = await Promise.all([101, 102, 200, 201, 300, 9999, 101, 200].map(pid => inFence(pid, fenced)));
    expect(answers).toEqual([true, true, false, false, false, false, true, false]);
    expect(reads()).toBe(1);
  });

  it('a table is fresh from when its read FINISHED: the checks that follow a slow read use it', async () => {
    const reads = slowReader();
    expect(await inFence(101, fenced)).toBe(true);
    // Twenty windows of other apps, one after the other (a window list being filtered): none of them costs a read.
    for (let i = 0; i < 20; i++) expect(await inFence(200 + (i % 2), fenced)).toBe(false);
    expect(reads()).toBe(1);
  });

  it('a pid that is not in an older table is looked for once more: a process may have started since', async () => {
    let table = new Map([[100, 1]]);
    let reads = 0;
    __setFenceProcessTableForTests(async () => { reads++; return table; });
    expect(await inFence(555, fenced)).toBe(false);
    table = new Map([[100, 1], [555, 100]]);
    expect(await inFence(555, fenced)).toBe(false);          // the table is a moment old: not read again yet
    expect(reads).toBe(1);
    await new Promise(r => setTimeout(r, 1100));
    expect(await inFence(555, fenced)).toBe(true);
    expect(reads).toBe(2);
  });

  it('a failed read fails closed and is not kept', async () => {
    let fail = true;
    __setFenceProcessTableForTests(async () => { if (fail) throw new Error('no ps'); return TABLE; });
    expect(await inFence(101, fenced)).toBe(false);
    fail = false;
    expect(await inFence(101, fenced)).toBe(true);
  });
});

describe('target fields', () => {
  it('a numeric string is normalised and passed on, so the handler and the fence see the same target', async () => {
    expect(normaliseTargets('read_screen', { processId: '101', name: 'x' })).toEqual({ processId: 101, name: 'x' });
    const t = tool('read_screen', targeted);
    front = owners;
    expect(await refused(t, { processId: ' 101 ' })).toBe(false);
    expect(t.calls).toEqual([{ processId: 101 }]);
  });

  it('a string pid of another process is checked as that process, not skipped', async () => {
    const t = tool('read_screen', targeted);
    expect(await refused(t, { processId: '200' })).toBe(true);   // the fixture is in front: the old gate fell through to it
    expect(t.calls).toEqual([]);
  });

  it.each([['processId', 'abc'], ['processId', 12.5], ['processId', -4], ['processId', 0], ['processId', '0x1f'], ['processId', true],
    ['processId', { valueOf: () => 101 }], ['processId', [101]], ['pid', '12; 13'], ['handle', 'main'], ['windowId', NaN], ['hwnd', '']])(
    '%s = %j is refused', async (field, value) => {
      for (const name of ['read_screen', 'invoke_element', 'focus_window', 'desktop_screenshot']) {
        const t = tool(name, targeted);
        expect(await refused(t, { [field]: value }), name).toBe(true);
        expect(t.calls).toEqual([]);
      }
    });

  it('null and undefined mean "not given"', () => {
    expect(normaliseTargets('read_screen', { processId: null, pid: undefined, name: 'x' })).toEqual({ name: 'x' });
  });

  it('a process id names the target: another process is refused, whatever is in front', async () => {
    expect(await refused(tool('read_screen', targeted), { processId: 200 })).toBe(true);
    expect(await refused(tool('invoke_element', targeted), { pid: 201, name: 'Send' })).toBe(true);
    front = owners;
    expect(await refused(tool('read_screen', targeted), { processId: 102 })).toBe(false);
  });

  it('a window handle must be that of a fenced window', async () => {
    expect(await refused(tool('invoke_element', targeted), { handle: 7001 })).toBe(false);
    expect(await refused(tool('invoke_element', targeted), { handle: 7002 })).toBe(true);
    expect(await refused(tool('invoke_element', targeted), { handle: 9999 })).toBe(true);
  });
});

describe('window actions', () => {
  const WINDOW_TOOLS = ['focus_window', 'close_window', 'minimize_window_to_taskbar', 'maximize_window', 'restore_window', 'resize_window'];

  it.each(WINDOW_TOOLS)('%s on a window of the owner is refused by title, by process name and by pid', async name => {
    for (const params of [{ title: 'Inbox' }, { processName: 'outlook' }, { processId: 200 }, { processId: '200' }]) {
      const t = tool(name, targeted);
      expect(await refused(t, params), JSON.stringify(params)).toBe(true);
      expect(t.calls).toEqual([]);
    }
  });

  it('the old minimize_window is refused: it picks its own window by pid OR name OR title, from its own list', async () => {
    expect(fenceKind('minimize_window')).toBe('refuse');
    for (const params of [{ processId: 101 }, { title: 'Bench Dialog', processId: 101 }, {}]) {
      const t = tool('minimize_window', targeted);
      expect(await refused(t, params)).toBe(true);
      expect(t.calls).toEqual([]);
    }
  });

  it.each(WINDOW_TOOLS)('%s: a fenced pid with a title that ALSO matches a window of the owner is refused (a tool that matches with OR could pick it)', async name => {
    // pid 101 AND "bench dialog" is the fixture alone, but the owner's "Inbox - Bench Dialog notes" matches the title too.
    const t = tool(name, targeted);
    expect(await refused(t, { processId: 101, title: 'bench dialog' })).toBe(true);
    expect(await refused(t, { processId: 101, processName: 'outlook' })).toBe(true);
    expect(t.calls).toEqual([]);
    // With a title only the fixture has, the same call runs.
    windows = [fixture, { ...owners, title: 'Inbox' }];
    expect(await refused(tool(name, targeted), { processId: 101, title: 'bench dialog' })).toBe(false);
  });

  it('the accessibility bridge lists fenced windows only, like the platform adapter', async () => {
    const bridge = fenceWindowList({ getWindows: async (_refresh?: boolean) => [fixture, owners, calc, settings] }, 'getWindows', fenced);
    expect((await bridge.getWindows(true)).map(w => w.title)).toEqual(['Bench Dialog', 'Calculator']);
  });

  it('a title that matches a fenced window AND one of the owner is refused', async () => {
    expect(await refused(tool('close_window', targeted), { title: 'bench dialog' })).toBe(true);
  });

  it('a title that matches nothing is refused: the tool could resolve it differently', async () => {
    expect(await refused(tool('focus_window', targeted), { title: 'Calculator' })).toBe(true);
  });

  it('a window call is pinned to the HANDLE of the window that matched: the tool gets no title and no process to search by', async () => {
    windows = [fixture, { ...owners, title: 'Inbox' }];
    for (const params of [{ title: 'Bench Dialog' }, { title: 'bench' }, { processName: 'benchfixture' }, { processId: 101 }, { processId: '101', title: 'Bench Dialog' }, { handle: 7001 }]) {
      const t = tool('focus_window', targeted);
      expect(await refused(t, params), JSON.stringify(params)).toBe(false);
      expect(t.calls, JSON.stringify(params)).toEqual([{ handle: 7001 }]);
    }
    // What is not a target stays: a resize keeps its size.
    const r = tool('resize_window', targeted);
    await run(r, { title: 'Bench Dialog', width: 800, height: 600 });
    expect(r.calls).toEqual([{ width: 800, height: 600, handle: 7001 }]);
  });

  it('a second window whose title CONTAINS the fixture\'s title is never the target', async () => {
    // "Bench Dialog" is the fixture; the owner has "Bench Dialog - notes.txt" open in another app. A platform that takes
    // "the first title that contains the text" would be free to pick either.
    const lookalike = { ...owners, title: 'Bench Dialog - notes.txt', handle: 7009 };
    windows = [lookalike, fixture];
    for (const name of ['focus_window', 'close_window', 'minimize_window_to_taskbar', 'resize_window']) {
      // By title: both match, one is outside the fence: refused, nothing runs.
      const byTitle = tool(name, targeted);
      expect(await refused(byTitle, { title: 'Bench Dialog' }), name).toBe(true);
      expect(byTitle.calls, name).toEqual([]);
      // By the fixture's process: allowed, and what reaches the platform is the fixture's handle alone: no title at all.
      const byPid = tool(name, targeted);
      expect(await refused(byPid, { processId: 101 }), name).toBe(false);
      expect(byPid.calls, name).toEqual([{ handle: 7001 }]);
      expect(JSON.stringify(byPid.calls)).not.toMatch(/title|7009/);
      // With the lookalike in front and no target named, the foreground check refuses.
      front = lookalike;
      expect(await refused(tool(name, targeted)), name).toBe(true);
      front = fixture;
    }
    // The lookalike's own handle is refused.
    expect(await refused(tool('focus_window', targeted), { handle: 7009 })).toBe(true);
  });

  it('no call under the fence ever hands the platform a title by itself', async () => {
    windows = [fixture, calc, settings, { ...owners, title: 'Inbox' }];
    for (const params of [{ title: 'Bench Dialog' }, { title: 'Calculator' }, { title: 'Calc' }, { title: 'bench', processName: 'BenchFixture' }]) {
      const t = tool('focus_window', targeted);
      await run(t, params);
      for (const call of t.calls) {
        expect(call.title, JSON.stringify(params)).toBeUndefined();
        expect(typeof call.handle, JSON.stringify(params)).toBe('number');
      }
    }
  });

  it('where the window tools take no handle (macOS, Linux): pinned to the process, the title kept beside it, never alone', async () => {
    __setFencePlatformForTests('linux');
    windows = [fixture, { ...owners, title: 'Inbox' }];
    const t = tool('focus_window', targeted);
    expect(await refused(t, { title: 'Bench Dialog' })).toBe(false);
    expect(t.calls).toEqual([{ title: 'Bench Dialog', processId: 101 }]);
    // A process that also owns a window outside the fence cannot be pinned: refused.
    windows = [fixture, { ...owners, processId: 101, title: 'Inbox', handle: 7010 }];
    expect(await refused(tool('focus_window', targeted), { title: 'Bench Dialog' })).toBe(false);   // 101 is fenced: both windows are
    windows = [fixture, calc, settings];
    expect(await refused(tool('focus_window', targeted), { title: 'Calculator' })).toBe(true);
  });

  it('with no target they act on the window in front', async () => {
    expect(await refused(tool('close_window', targeted))).toBe(false);
    front = owners;
    expect(await refused(tool('close_window', targeted))).toBe(true);
  });

  describe('a Store app (its window belongs to ApplicationFrameHost, which hosts every Store app)', () => {
    it('in front, it counts by the process its frame hosts', async () => {
      front = calc;
      expect(await refused(tool('type_text'))).toBe(false);
      front = settings;
      expect(await refused(tool('type_text'))).toBe(true);
    });

    it('by its title while the frame host also owns a window of the owner: allowed, pinned to its handle', async () => {
      windows = [fixture, calc, settings];
      for (const title of ['Calculator', 'Calc']) {
        const t = tool('focus_window', targeted);
        expect(await refused(t, { title }), title).toBe(false);
        // Neither the title nor the frame host's pid is passed on: the pid would match the owner's Settings window too.
        expect(t.calls, title).toEqual([{ handle: 7003 }]);
      }
      const c = tool('close_window', targeted);
      expect(await refused(c, { title: 'calculator', processName: 'ApplicationFrameHost' })).toBe(true);   // the name matches Settings too
    });

    it('a title another window also contains: refused', async () => {
      windows = [fixture, calc, settings, { ...owners, title: 'How to use Calculator - Edge' }];
      expect(await refused(tool('close_window', targeted), { title: 'Calculator' })).toBe(true);
      windows = [fixture, calc, { ...settings, title: 'Calculator' }];                                   // another Store app with the same title
      expect(await refused(tool('close_window', targeted), { title: 'Calculator' })).toBe(true);
    });

    it('the lists and the foreground read do not say what a frame hosts: it is looked up by the window\'s handle', async () => {
      // As the platform reports them on Windows: no hostedProcessId on either frame.
      const bareCalc = { ...calc, hostedProcessId: undefined };
      const bareSettings = { ...settings, hostedProcessId: undefined };
      __setFrameHostReaderForTests(async () => new Map([['7003', { processId: 400, processName: 'CalculatorApp' }], ['7004', { processId: 201, processName: 'SystemSettings' }]]));
      windows = [fixture, bareCalc, bareSettings];
      front = bareCalc;
      for (const name of ['read_screen', 'type_text', 'key_press', 'desktop_screenshot']) expect(await refused(tool(name)), name).toBe(false);
      expect(await refused(tool('focus_window', targeted), { title: 'Calculator' })).toBe(false);
      front = bareSettings;
      for (const name of ['read_screen', 'type_text']) expect(await refused(tool(name)), name).toBe(true);
      expect(await refused(tool('focus_window', targeted), { title: 'Settings' })).toBe(true);
      // The fenced window list shows the fixture's Store app, and not the owner's.
      const adapter = fencePlatform({ listWindows: async () => [fixture, owners, bareCalc, bareSettings] }, fenced);
      expect((await adapter.listWindows()).map(w => w.title)).toEqual(['Bench Dialog', 'Calculator']);
    });

    it('the cache says Calculator, a fresh read says another app: the fence refuses', async () => {
      // The display cache learns that frame 7003 hosts Calculator (pid 400, fenced).
      const { hostedAppOf, withHostedApp } = await import('../platform/frame-host');
      const bare = { ...calc, hostedProcessId: undefined };
      expect(await hostedAppOf(bare)).toMatchObject({ processId: 400 });
      front = bare;
      windows = [fixture, bare];
      expect(await refused(tool('type_text'))).toBe(false);
      // Then the handle is reused (or the frame comes to host another app): the bridge now says pid 201, the owner's.
      let reads = 0;
      __setFrameHostReaderForTests(async () => { reads++; return new Map([['7003', { processId: 201, processName: 'SystemSettings' }]]); }, { keepCache: true });
      // For DISPLAY the remembered answer may still be shown for a few seconds ...
      expect((await withHostedApp(bare)).hostedProcessId).toBe(400);
      expect(reads).toBe(0);
      // ... but every fence decision reads fresh, and refuses.
      for (const name of ['type_text', 'read_screen', 'key_press', 'mouse_click', 'desktop_screenshot', 'invoke_element']) {
        const t = tool(name);
        expect(await refused(t), name).toBe(true);
        expect(t.calls, name).toEqual([]);
      }
      expect(await refused(tool('focus_window', targeted), { title: 'Calculator' })).toBe(true);
      expect(await refused(tool('close_window', targeted), { handle: 7003 })).toBe(true);
      expect(reads).toBeGreaterThanOrEqual(8);   // one read per decision, none from the cache
      // The fenced window list drops it too.
      expect((await fencePlatform({ listWindows: async () => [fixture, bare] }, fenced).listWindows()).map(w => w.title)).toEqual(['Bench Dialog']);
    });

    it('a window object that CLAIMS to host a fenced app is not believed: the bridge is asked', async () => {
      // As it would look after the display cache filled it in: hostedProcessId 400, while the bridge says 201.
      __setFrameHostReaderForTests(async () => new Map([['7003', { processId: 201, processName: 'SystemSettings' }]]));
      front = { ...calc, hostedProcessId: 400 };
      expect(await refused(tool('type_text'))).toBe(true);
      await expect(fenceInput(front, fenced)).rejects.toThrow(FENCED);
    });

    it('a frame whose hosted process cannot be looked up is outside the fence', async () => {
      __setFrameHostReaderForTests(async () => { throw new Error('bridge down'); });
      front = { ...calc, hostedProcessId: undefined };
      expect(await refused(tool('read_screen'))).toBe(true);
    });

    it('only ApplicationFrameHost is looked up: another process cannot borrow a fenced window\'s handle', async () => {
      __setFrameHostReaderForTests(async () => new Map([['7002', { processId: 400, processName: 'CalculatorApp' }]]));
      front = owners;   // OUTLOOK.EXE, handle 7002
      expect(await refused(tool('read_screen'))).toBe(true);
    });

    it('by title when every window of the frame host is fenced: the same handle pin', async () => {
      windows = [fixture, calc];
      const t = tool('close_window', targeted);
      expect(await refused(t, { title: 'Calculator' })).toBe(false);
      expect(t.calls).toEqual([{ handle: 7003 }]);
    });

    it('by the frame host\'s pid alone: refused', async () => {
      windows = [fixture, calc, settings];
      expect(await refused(tool('close_window', targeted), { processId: 300 })).toBe(true);
      expect(await refused(tool('read_screen', targeted), { processId: 300 })).toBe(true);
    });

    it('by the exact window handle: allowed, the owner\'s handle refused', async () => {
      windows = [fixture, calc, settings];
      expect(await refused(tool('close_window', targeted), { handle: 7003 })).toBe(false);
      expect(await refused(tool('close_window', targeted), { handle: 7004 })).toBe(true);
    });
  });
});

describe('the pointer', () => {
  it('finds every point a call names: pairs, an action object, and each point of a path', () => {
    expect(pointerPoints('mouseClick', [10, 20, 1])).toEqual([{ x: 10, y: 20 }]);
    expect(pointerPoints('mouseDrag', [10, 20, 30, 40])).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
    expect(pointerPoints('mouseScroll', [10, 20, -3])).toEqual([{ x: 10, y: 20 }]);
    expect(pointerPoints('executeMouseAction', [{ kind: 'drag', x: 1, y: 2, endX: 3, endY: 4 }])).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(pointerPoints('mouseDragStepped', [[{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]])).toHaveLength(3);
    expect(pointerPoints('mouseDrag', [10, 20, 30, 40, { path: [[11, 21], [900, 900]] }])).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 11, y: 21 }, { x: 900, y: 900 }]);
    expect(pointerPoints('mouseDown', [])).toEqual([]);
    expect(pointerPoints('mouseDown', ['left'])).toEqual([]);
    expect(pointerPoints('mouseUp', [1])).toEqual([]);            // a lone number is a button
    expect(pointerPoints('mouseMoveRelative', [50, 60])).toEqual([]);   // offsets, not a point
  });

  const at = (method: string, args: unknown[]) => fencePointer(method, args, fenced);

  it('a click, a scroll and a move may only go inside the fenced window in front', async () => {
    for (const m of ['mouseClick', 'mouseDoubleClick', 'mouseRightClick', 'mouseScroll', 'mouseMove']) {
      await expect(at(m, [300, 250]), m).resolves.toBeUndefined();
      await expect(at(m, [700, 250]), m).rejects.toThrow(/not inside the fenced window/);   // the owner's window beside it
    }
  });

  it('move, then press, then release cannot click another window: the bare press is checked at the LIVE pointer', async () => {
    await expect(at('mouseMove', [700, 250])).rejects.toThrow(FENCED);        // the move itself is refused
    cursor = { x: 700, y: 250 };                                             // ... and had the pointer got there anyway
    await expect(at('mouseDown', [])).rejects.toThrow(/not inside the fenced window/);
    await expect(at('mouseDown', ['left'])).rejects.toThrow(FENCED);
    await expect(at('mouseUp', [])).rejects.toThrow(FENCED);
    cursor = { x: 300, y: 250 };
    await expect(at('mouseDown', [])).resolves.toBeUndefined();
    await expect(at('mouseUp', ['left'])).resolves.toBeUndefined();
  });

  it('a relative move is checked at where it ends', async () => {
    cursor = { x: 480, y: 250 };
    await expect(at('mouseMoveRelative', [10, 0])).resolves.toBeUndefined();
    await expect(at('mouseMoveRelative', [200, 0])).rejects.toThrow(FENCED);
  });

  it('a press with no readable pointer position is refused', async () => {
    cursor = null;
    await expect(at('mouseDown', [])).rejects.toThrow(/cannot be read/);
    await expect(at('mouseMoveRelative', [1, 1])).rejects.toThrow(FENCED);
  });

  it('every point of a drag is checked: its start, its end and each point of its path', async () => {
    await expect(at('mouseDrag', [150, 150, 450, 350])).resolves.toBeUndefined();
    await expect(at('mouseDrag', [150, 150, 700, 150])).rejects.toThrow(FENCED);
    await expect(at('mouseDrag', [150, 150, 450, 350, { path: [[200, 200], [700, 250], [300, 300]] }])).rejects.toThrow(FENCED);
    await expect(at('mouseDragStepped', [[{ x: 150, y: 150 }, { x: 200, y: 200 }, { x: 450, y: 350 }]])).resolves.toBeUndefined();
    await expect(at('mouseDragStepped', [[{ x: 150, y: 150 }, { x: 90, y: 20 }, { x: 450, y: 350 }]])).rejects.toThrow(FENCED);
  });

  it('needs a fenced window in front with known bounds', async () => {
    front = owners;
    await expect(at('mouseClick', [700, 250])).rejects.toThrow(FENCED);
    front = { processId: 101 };
    await expect(at('mouseClick', [300, 250])).rejects.toThrow(/no known bounds/);
  });

  it('every pointer method of a driver is checked where it is sent, before it runs', async () => {
    process.env[FENCE_ENV] = '100';
    __setForegroundReaderForTests(async () => ({ processId: 101, processName: 'BenchFixture', bounds: fixture.bounds }));
    const sent: string[] = [];
    class Driver {
      async mouseClick(x: number, y: number) { sent.push(`click ${x},${y}`); }
      async mouseMove(x: number, y: number) { sent.push(`move ${x},${y}`); }
      async mouseMoveRelative(dx: number, dy: number) { sent.push(`rel ${dx},${dy}`); }
      async mouseDown() { sent.push('down'); }
      async mouseUp() { sent.push('up'); }
      async mouseDragStepped(path: Array<{ x: number; y: number }>) { sent.push(`path ${path.length}`); }
    }
    const d = guardInputMethods(new Driver());
    await expect(d.mouseMove(700, 250)).rejects.toThrow(FENCED);
    await expect(d.mouseClick(700, 250)).rejects.toThrow(FENCED);
    await expect(d.mouseMoveRelative(400, 0)).rejects.toThrow(FENCED);
    await expect(d.mouseDragStepped([{ x: 150, y: 150 }, { x: 700, y: 250 }])).rejects.toThrow(FENCED);
    cursor = { x: 700, y: 250 };
    await expect(d.mouseDown()).rejects.toThrow(FENCED);
    await expect(d.mouseUp()).rejects.toThrow(FENCED);
    expect(sent).toEqual([]);
    cursor = { x: 300, y: 250 };
    await d.mouseMove(300, 250); await d.mouseDown(); await d.mouseUp(); await d.mouseClick(110, 110);
    expect(sent).toEqual(['move 300,250', 'down', 'up', 'click 110,110']);
  });
});

describe('screen geometry: fenced windows must be wholly on the primary display', () => {
  // The owner's desk: DISPLAY1 at 0,0, 3840x2400 at 225%; DISPLAY2 at 2796,-1080 (logical), 1920x1080 at 100%.
  const displays = [
    { index: 0, primary: true, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, physicalSize: { width: 3840, height: 2400 }, dpiRatio: 2.25 },
    { index: 1, primary: false, bounds: { x: 2796, y: -1080, width: 1920, height: 1080 }, physicalSize: { width: 1920, height: 1080 }, dpiRatio: 1 },
  ];
  const onPrimary: Rect = { x: 900, y: 600, width: 2250, height: 1575 };           // a 1000x700 logical window at 225%
  const onSecond: Rect = { x: 2796, y: -1080, width: 1000, height: 900 };
  const straddling: Rect = { x: 3400, y: 200, width: 1000, height: 900 };          // runs off the right edge onto nothing, or the next monitor

  it('the primary display is its physical rectangle on Windows and Linux, its logical one on macOS', () => {
    expect(primaryRect(displays, 'win32')).toEqual({ x: 0, y: 0, width: 3840, height: 2400 });
    expect(primaryRect(displays, 'linux')).toEqual({ x: 0, y: 0, width: 3840, height: 2400 });
    expect(primaryRect(displays, 'darwin')).toEqual({ x: 0, y: 0, width: 1707, height: 1067 });
    expect(primaryRect([displays[1]], 'win32')).toBeNull();
  });

  it('a window on the primary is wholly on it; one on the second monitor or across the edge is not', () => {
    const p = primaryRect(displays, 'win32')!;
    expect(wholly(onPrimary, p)).toBe(true);
    expect(wholly({ x: -8, y: -8, width: 3856, height: 2416 }, p)).toBe(true);    // maximized: its invisible border overhangs
    expect(wholly(onSecond, p)).toBe(false);
    expect(wholly(straddling, p)).toBe(false);
    expect(wholly({ x: 0, y: 0, width: 0, height: 0 }, p)).toBe(false);
  });

  it('pointer input and captures are refused for a fenced window on the second monitor or across the edge', async () => {
    primary = primaryRect(displays, 'win32');
    for (const bounds of [onSecond, straddling]) {
      front = { ...fixture, bounds };
      await expect(fencePointer('mouseClick', [bounds.x + 50, bounds.y + 50], fenced)).rejects.toThrow(/not wholly on the primary display/);
      expect(await refused(tool('desktop_screenshot'))).toBe(true);
    }
    primary = null;   // the displays cannot be read: refused
    front = { ...fixture, bounds: onPrimary };
    await expect(fencePointer('mouseClick', [1000, 700], fenced)).rejects.toThrow(FENCED);
  });

  it('on the 225% primary, points and bounds are both physical pixels: inside is inside, the second monitor is outside', async () => {
    primary = primaryRect(displays, 'win32');
    front = { ...fixture, bounds: onPrimary };
    await expect(fencePointer('mouseClick', [2000, 1500], fenced)).resolves.toBeUndefined();
    await expect(fencePointer('mouseClick', [3149, 2174], fenced)).resolves.toBeUndefined();     // the last pixel of the window
    await expect(fencePointer('mouseClick', [3200, 1500], fenced)).rejects.toThrow(FENCED);      // right of it, still on the primary
    await expect(fencePointer('mouseClick', [4000, -500], fenced)).rejects.toThrow(FENCED);      // on DISPLAY2
    await expect(fencePointer('mouseClick', [889, 667], fenced)).rejects.toThrow(FENCED);        // the same point in LOGICAL units is not inside
    cursor = { x: 4000, y: -500 };
    await expect(fencePointer('mouseDown', [], fenced)).rejects.toThrow(FENCED);
  });
});

describe('typing', () => {
  it('text with Enter or Tab goes a piece at a time, and stops when the focus has left the fence', async () => {
    process.env[FENCE_ENV] = '100';
    let inFront = { processId: 101, processName: 'BenchFixture' };
    __setForegroundReaderForTests(async () => inFront);
    const typed: string[] = [];
    const desk = guardInputMethods({ typeText: async (t: string) => {
      typed.push(t);
      if (t.endsWith('\n')) inFront = { processId: 200, processName: 'OUTLOOK.EXE' };   // Enter closed the dialog: the owner's window is in front
    } });
    await expect(desk.typeText('name\tvalue\nto the owner')).rejects.toThrow(FENCED);
    expect(typed).toEqual(['name\t', 'value\n']);
  });

  it('sends every piece when the focus stays', async () => {
    process.env[FENCE_ENV] = '100';
    __setForegroundReaderForTests(async () => ({ processId: 101, processName: 'BenchFixture' }));
    const typed: string[] = [];
    const desk = guardInputMethods({ typeText: async (t: string) => { typed.push(t); } });
    await desk.typeText('one\r\ntwo\n\nthree');
    expect(typed).toEqual(['one\r\n', 'two\n', '\n', 'three']);
    await desk.typeText('plain');
    expect(typed[typed.length - 1]).toBe('plain');
  });

  it('keys go only to a fenced window in front', async () => {
    await expect(fenceInput(fixture, fenced)).resolves.toBeUndefined();
    await expect(fenceInput(owners, fenced)).rejects.toThrow(/^FENCED: input/);
    await expect(fenceInput(null, fenced)).rejects.toThrow(FENCED);
    process.env[FENCE_ENV] = '100';
    const send = vi.fn(async () => 'sent');
    __setForegroundReaderForTests(async () => ({ processId: 200, processName: 'OUTLOOK.EXE' }));
    await expect(guardedInput('keyPress', ['enter'], send)).rejects.toThrow(FENCED);
    __setForegroundReaderForTests(async () => null);
    await expect(guardedInput('keyPress', ['enter'], send)).rejects.toThrow(FENCED);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('one capture path', () => {
  const white = (w = 200, h = 100) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const pixel = async (b64: string, x: number, y: number) => {
    const { data, info } = await sharp(Buffer.from(b64, 'base64')).raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels];
  };
  primary = { x: 0, y: 0, width: 3840, height: 2400 };

  it('a full capture shows the fenced window and blacks out the rest, at the same size', async () => {
    // The screen is 800x400 here, the image a quarter of that; the fixture window is at (100,100) 400x300.
    const shot = await image(await white(), 'image/png', { originX: 0, originY: 0, scale: 4 });
    const meta = await sharp(Buffer.from(shot.data, 'base64')).metadata();
    expect([meta.width, meta.height, shot.mimeType]).toEqual([200, 100, 'image/png']);
    expect(await pixel(shot.data, 60, 50)).toBe(255);      // inside the window
    expect(await pixel(shot.data, 10, 10)).toBe(0);        // left of it
    expect(await pixel(shot.data, 160, 50)).toBe(0);       // the owner's window beside it
  });

  it('a region capture (zoom) is masked the same way, from where the region is on screen', async () => {
    // The region is x 400..800, y 100..300 on screen: the fixture's right fifth (400..500) and the owner's window (600..800).
    const shot = await image(await white(200, 100), 'image/png', { originX: 400, originY: 100, screenWidth: 400 });
    expect(await pixel(shot.data, 20, 50)).toBe(255);      // screen x 440: the fixture
    expect(await pixel(shot.data, 80, 50)).toBe(0);        // screen x 560: the gap
    expect(await pixel(shot.data, 150, 50)).toBe(0);       // screen x 700: the owner's window
  });

  it('macOS: bounds in points, the capture in pixels', async () => {
    const shot = await image(await white(), 'image/png', { originX: 0, originY: 0, scale: 8, boundsScale: 2 });
    expect(await pixel(shot.data, 60, 50)).toBe(255);
    expect(await pixel(shot.data, 10, 10)).toBe(0);
  });

  it('is refused when no fenced window is in front, when it has no bounds, or when none of it is in the capture', async () => {
    const frame = { originX: 0, originY: 0, scale: 4 };
    front = owners;
    await expect(fenceImage(await white(), 'image/png', frame, fenced)).rejects.toThrow(FENCED);
    front = { processId: 101 };
    await expect(fenceImage(await white(), 'image/png', frame, fenced)).rejects.toThrow(/no known bounds/);
    front = fixture;
    await expect(image(await white(), 'image/png', { originX: 3000, originY: 0, scale: 4 })).rejects.toThrow(/not in this capture/);
    await expect(image(await white(), 'image/png', { originX: 0, originY: 0 })).rejects.toThrow(/cannot be mapped/);
  });

  describe('the window is read before AND after the capture', () => {
    const frame = { originX: 0, originY: 0, scale: 4 };
    /** A capture during which `change` happens: after the call began, before the mask is cut. */
    const during = async (change: () => void) => fenceCapturing(async () => {
      await new Promise(r => setTimeout(r, 5));   // the capture itself
      change();
      return fenceImage(await white(), 'image/png', frame, fenced);
    }, fenced);

    it('a window that moved during the capture: refused, not masked for the wrong rectangle', async () => {
      await expect(during(() => { front = { ...fixture, bounds: { x: 600, y: 100, width: 400, height: 300 } }; })).rejects.toThrow(/moved or changed while it was captured/);
    });
    it('a window that was resized, or another fenced window that came to the front: refused', async () => {
      await expect(during(() => { front = { ...fixture, bounds: { ...fixture.bounds!, width: 900 } }; })).rejects.toThrow(FENCED);
      await expect(during(() => { front = { ...fixture, handle: 7999 }; })).rejects.toThrow(FENCED);
      await expect(during(() => { front = { ...fixture, processId: 102 }; })).rejects.toThrow(FENCED);
    });
    it('the owner\'s window came to the front during the capture: refused', async () => {
      await expect(during(() => { front = owners; })).rejects.toThrow(FENCED);
    });
    it('nothing changed: masked', async () => {
      const shot = await during(() => {});
      expect(await pixel(shot.data, 60, 50)).toBe(255);
      expect(await pixel(shot.data, 160, 50)).toBe(0);
    });
    it('a capture with no "before" (made outside a tool call) is refused', async () => {
      await expect(fenceImage(await white(), 'image/png', frame, fenced)).rejects.toThrow(/before the capture is not known/);
      await expect(fenceOcrCapture(await white(), { x: 0, y: 0 }, fenced)).rejects.toThrow(FENCED);
    });
    it('the gate gives every tool call that scope: a capture tool behind it is masked, and refused when the window moves under it', async () => {
      const shooter = (move: boolean) => ({ ...tool('desktop_screenshot'), handler: async () => {
        if (move) front = { ...fixture, bounds: { x: 300, y: 100, width: 400, height: 300 } };
        return { text: 'shot', image: await fenceImage(await white(), 'image/png', frame, fenced) };
      } }) as ToolDefinition;
      const ok = await run(shooter(false));
      expect(ok.isError).toBeFalsy();
      expect(await pixel(ok.image!.data, 160, 50)).toBe(0);
      const moved = await fenceTools([shooter(true)], fenced)[0].handler({}, ctx).catch((e: Error) => ({ text: e.message, isError: true, image: undefined }));
      expect(moved.isError).toBe(true);
      expect(moved.text).toContain(FENCED);
      expect(moved.image).toBeUndefined();
    });
  });

  it.each(['desktop_screenshot', 'screenshot_full', 'desktop_screenshot_region'])('%s: an image that did not come through it never leaves the gate', async name => {
    const raw = { data: (await white()).toString('base64'), mimeType: 'image/png' };
    const r = await run(tool(name, {}, { image: raw }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain(FENCED);
    expect(r.image).toBeUndefined();
    const through = await image(await white(), 'image/png', { originX: 0, originY: 0, scale: 4 });
    const ok = await run(tool(name, {}, { image: through }));
    expect(ok.isError).toBeFalsy();
    expect(ok.image).toBe(through);
  });

  it('a tool that is not a capture tool cannot return an image at all, masked or not', async () => {
    const through = await image(await white(), 'image/png', { originX: 0, originY: 0, scale: 4 });
    const r = await run(tool('read_screen', {}, { image: through }));
    expect(r.isError).toBe(true);
    expect(r.image).toBeUndefined();
  });

  it('a capture needs a fenced window in front before anything is captured', async () => {
    front = owners;
    for (const name of ['desktop_screenshot', 'screenshot_full', 'desktop_screenshot_region']) {
      const t = tool(name);
      expect(await refused(t), name).toBe(true);
      expect(t.calls).toEqual([]);
    }
  });
});

describe('OCR is scoped to the fenced window', () => {
  // A 1000x400 "screen": the fixture window is at (100,100) 400x300, the owner's at (600,100) 400x300.
  const screenPng = () => sharp({ create: { width: 1000, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const lit = async (png: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels] > 128;
  };
  /** A stand-in for the OS OCR: it "reads" a word wherever its pixels are still there. */
  const fakeOcr = async (png: Buffer, at = { x: 0, y: 0 }) => {
    const words = [{ text: 'Apply', x: 300, y: 250 }, { text: 'Password: hunter2', x: 700, y: 250 }, { text: 'Inbox (3)', x: 620, y: 120 }];
    const meta = await sharp(png).metadata();
    const elements = [];
    for (const [line, w] of words.entries()) {
      const ix = w.x - at.x, iy = w.y - at.y;
      if (ix >= 0 && iy >= 0 && ix < meta.width! && iy < meta.height! && await lit(png, ix, iy)) elements.push({ text: w.text, x: w.x - 5, y: w.y - 5, width: 10, height: 10, line });
    }
    return { elements, fullText: elements.map(e => e.text).join('\n'), durationMs: 1 };
  };

  it('the pixels outside the fenced window are gone before the engine sees them', async () => {
    const masked = await ocrCapture(await screenPng(), { x: 0, y: 0 });
    expect(await lit(masked, 300, 250)).toBe(true);
    expect(await lit(masked, 700, 250)).toBe(false);
    expect(await lit(masked, 50, 50)).toBe(false);
    const read = await fakeOcr(masked);
    expect(read.fullText).toBe('Apply');
  });

  it('a region capture is masked from where the region is on screen', async () => {
    // The agent asks for the region x 400..1000: the fixture's right fifth and all of the owner's window.
    const region = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const masked = await ocrCapture(region, { x: 400, y: 0 });
    expect(await lit(masked, 50, 250)).toBe(true);      // screen x 450: the fixture
    expect(await lit(masked, 300, 250)).toBe(false);    // screen x 700: the owner's window
    expect((await fakeOcr(masked, { x: 400, y: 0 })).fullText).toBe('');
  });

  it('text the engine returns from outside the window is dropped, and the flat text rebuilt (should a capture ever skip the mask)', async () => {
    const leaked = await fakeOcr(await screenPng());
    expect(leaked.fullText).toContain('hunter2');
    const kept = await fenceOcrText(leaked, fenced);
    expect(kept.elements.map(e => e.text)).toEqual(['Apply']);
    expect(kept.fullText).toBe('Apply');
    expect(JSON.stringify(kept)).not.toMatch(/hunter2|Inbox/);
  });

  it('is refused with no fenced window in front: there is nothing it may read', async () => {
    front = owners;
    await expect(ocrCapture(await screenPng(), { x: 0, y: 0 })).rejects.toThrow(FENCED);
    await expect(fenceOcrText({ elements: [], fullText: '' }, fenced)).rejects.toThrow(FENCED);
  });

  it('macOS: bounds in points, the capture in pixels', async () => {
    __setFenceDesktopForTests({ foreground: async () => front, windows: async () => windows, cursor: async () => cursor, primary: async () => primary, captureScale: async () => 2 });
    const big = await sharp({ create: { width: 2000, height: 800, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const masked = await ocrCapture(big, { x: 0, y: 0 });
    expect(await lit(masked, 600, 500)).toBe(true);     // the point (300, 250) of the fixture window
    expect(await lit(masked, 1400, 500)).toBe(false);   // the point (700, 250) of the owner's
  });

  it('the real OCR engine: the whole screen and a region both come back with the fenced window\'s text only', async () => {
    process.env[FENCE_ENV] = '100';
    const { OcrEngine } = await import('../platform/ocr-engine');
    const engine = new OcrEngine() as unknown as {
      available: boolean; grab: () => Promise<unknown>; runOcr: (file: string) => Promise<unknown>;
      recognizeScreen(): Promise<{ fullText: string; elements: Array<{ text: string }> }>;
      recognizeRegion(x: number, y: number, w: number, h: number): Promise<{ fullText: string }>;
    };
    engine.available = true;
    const fs = await import('fs');
    let regionAt = { x: 0, y: 0 };
    engine.grab = async () => ({ data: Buffer.alloc(1000 * 400 * 4, 255), width: 1000, height: 400, channels: 4 });
    engine.runOcr = async file => fakeOcr(fs.readFileSync(file), regionAt);
    const whole = await fenceCapturing(() => engine.recognizeScreen());
    expect(whole.fullText).toBe('Apply');
    expect(JSON.stringify(whole)).not.toMatch(/hunter2|Inbox/);
    // fakeOcr reports screen positions; the engine adds the region's offset to what the OS OCR returns, so undo it here.
    regionAt = { x: 400, y: 0 };
    engine.runOcr = async file => {
      const r = await fakeOcr(fs.readFileSync(file), regionAt);
      for (const e of r.elements) { e.x -= regionAt.x; e.y -= regionAt.y; }
      return r;
    };
    expect((await fenceCapturing(() => engine.recognizeRegion(400, 0, 600, 400))).fullText).toBe('');
    // With the owner's window in front there is nothing to read.
    front = owners;
    (engine as unknown as { invalidateCache(): void }).invalidateCache();
    await expect(fenceCapturing(() => engine.recognizeScreen())).rejects.toThrow(FENCED);
  });
});

describe('smart_click and smart_type cannot click outside the fence', () => {
  /** The real tools, with an accessibility layer that points them at the owner's window. */
  async function smart(name: 'smart_click' | 'smart_type', params: Record<string, unknown>, clickPoint: { x: number; y: number }) {
    process.env[FENCE_ENV] = '100';
    __setForegroundReaderForTests(async () => ({ processId: 101, processName: 'BenchFixture', bounds: fixture.bounds }));
    const sent: string[] = [];
    class Driver {
      async mouseClick(x: number, y: number) { sent.push(`click ${x},${y}`); }
      async typeText(t: string) { sent.push(`type ${t}`); }
      async keyPress(k: string) { sent.push(`key ${k}`); }
      getDpiRatio() { return 1; }
    }
    const el = { name: 'Send', controlType: 'Button', bounds: { x: clickPoint.x - 10, y: clickPoint.y - 10, width: 20, height: 20 } };
    const fakeCtx = {
      ensureInitialized: async () => {},
      desktop: guardInputMethods(new Driver()),
      a11y: {
        getActiveWindow: async () => ({ processId: 101, processName: 'benchfixture', title: 'Bench Dialog', bounds: fixture.bounds }),
        invokeElement: async () => ({ success: false, clickPoint }),
        findElement: async () => [el],
        getScreenContext: async () => '',
        readClipboard: async () => '', writeClipboard: async () => {},
      },
      getScreenshotScaleFactor: () => 1, getMouseScaleFactor: () => 1,
    } as unknown as ToolContext;
    const t = getTools().find(x => x.name === name)!;
    const result = await fenceTools([t], process.env)[0].handler(params, fakeCtx).catch((e: Error) => ({ text: e.message, isError: true }));
    return { sent, result };
  }

  it('smart_click: the element it resolves to is in the owner\'s window: no click is sent', async () => {
    const { sent, result } = await smart('smart_click', { target: 'Send' }, { x: 700, y: 250 });
    expect(sent.filter(s => s.startsWith('click'))).toEqual([]);
    expect(result.isError).toBe(true);
  });

  it('smart_type: a click to focus a field outside the fence is not sent', async () => {
    const { sent } = await smart('smart_type', { target: 'To', text: 'for the owner' }, { x: 700, y: 250 });
    expect(sent.filter(s => s.startsWith('click'))).toEqual([]);
  });

  it('smart_click inside the fenced window clicks', async () => {
    const { sent } = await smart('smart_click', { target: 'Send' }, { x: 300, y: 250 });
    expect(sent).toContain('click 300,250');
  });

  it('with the owner\'s window in front neither tool runs at all', async () => {
    front = owners;
    for (const name of ['smart_click', 'smart_type', 'smart_read', 'ocr_read_screen']) {
      const t = tool(name);
      expect(await refused(t, { target: 'Send', text: 'x' }), name).toBe(true);
      expect(t.calls).toEqual([]);
    }
  });
});

describe('the platform window list and the browser driver', () => {
  it('the adapter lists fenced windows only; its own list stays for the gate', async () => {
    const adapter = fencePlatform({ listWindows: async () => [fixture, owners, calc, settings] }, fenced);
    expect((await adapter.listWindows()).map(w => w.title)).toEqual(['Bench Dialog', 'Calculator']);
  });

  it('the browser driver may attach only to the agent\'s own port', () => {
    expect(fenceCdpOnly(9333, fenced)).toBe(9333);
  });
});

describe('through the real tool list', () => {
  it('compound actions and every step of a batch are judged by the same table', async () => {
    process.env[FENCE_ENV] = '100';
    vi.resetModules();
    const fence = await import('../core/fence');
    fence.__setFenceProcessTableForTests(async () => TABLE);
    fence.__setFenceDesktopForTests({ foreground: async () => owners, windows: async () => windows, cursor: async () => cursor, primary: async () => primary });
    const registry = await import('../tools/registry');
    const compact = registry.getTools({ palette: 'compact' });
    const call = (name: string, params: Record<string, unknown>) => compact.find(t => t.name === name)!.handler(params, { ensureInitialized: async () => {} } as ToolContext);

    for (const [name, params] of [
      ['window', { action: 'list' }], ['window', { action: 'close', title: 'Inbox' }], ['window', { action: 'open_url', url: 'https://example.com' }],
      ['system', { action: 'clipboard_read' }], ['system', { action: 'clipboard_write', text: 'x' }], ['system', { action: 'ocr' }],
      ['system', { action: 'report' }], ['system', { action: 'undo' }],
      ['computer', { action: 'screenshot' }], ['computer', { action: 'zoom', x: 0, y: 0, width: 10, height: 10 }], ['computer', { action: 'type', text: 'hello' }],
      ['computer', { action: 'mouse_down' }], ['computer', { action: 'move_relative', dx: 5, dy: 5 }],
      ['accessibility', { action: 'read_tree', processId: 200 }], ['accessibility', { action: 'read_tree', processId: '200' }],
      ['accessibility', { action: 'smart_read', scope: 'screen' }], ['accessibility', { action: 'smart_click', target: 'Send' }],
      ['accessibility', { action: 'smart_type', target: 'To', text: 'x' }], ['system', { action: 'ocr', scope: 'window' }],
      ['browser', { action: 'evaluate', javascript: 'fetch("/api/state")' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await call(name, params);
      expect(r.isError, `${name} ${params.action}`).toBe(true);
      expect(r.text, `${name} ${params.action}`).toContain(FENCED);
      expect(r.image, `${name} ${params.action}`).toBeUndefined();
    }

    // A batch: the first step is harmless and runs, the second is refused, and the third never runs.
    const batch = await call('batch', { steps: [
      { name: 'computer', arguments: { action: 'wait', seconds: 0.01 } },
      { name: 'computer', arguments: { action: 'type', text: 'to the owner' } },
      { name: 'window', arguments: { action: 'close', title: 'Inbox' } },
    ] });
    expect(batch.isError).toBe(true);
    expect(batch.text).toContain(FENCED);
    expect(batch.steps?.map(s => s.status)).toEqual(['ok', 'error']);   // halted at the refused step: the third never ran
    // The same with granular tool names as steps.
    const granular = await call('batch', { steps: [{ name: 'get_windows', arguments: {} }] });
    expect(granular.text).toContain(FENCED);
  });

  it('without the variable the same list has the plain handlers', async () => {
    delete process.env[FENCE_ENV];
    vi.resetModules();
    const fence = await import('../core/fence');
    const spy = vi.spyOn(fence, 'fenceGate');
    const registry = await import('../tools/registry');
    const r = await registry.getTools().find(t => t.name === 'wait')!.handler({ seconds: 0.01 }, { ensureInitialized: async () => {} } as ToolContext);
    expect(r.isError).toBeFalsy();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the refusal', () => {
  it('says what was refused and that nothing happened', async () => {
    const r = await run(tool('get_windows'));
    expect(r.text).toMatch(/^FENCED: get_windows is outside the test fence \(CLAWD_FENCE_PIDS\) — nothing was done and nothing was read\.$/);
    expect(isFenceRefusal(new Error(r.text))).toBe(true);
    expect(isGuardRefusal(new Error(r.text))).toBe(true);
  });

  it('is the code FENCED and a refusal, only while the fence is on', () => {
    const text = `${FENCED}get_windows is outside the test fence (CLAWD_FENCE_PIDS) — nothing was done and nothing was read.`;
    process.env[FENCE_ENV] = '100';
    expect(classifyResult(text, true, true)).toMatchObject({ outcome: 'refused', code: 'FENCED' });
    expect(outcomeOf(true, text)).toBe('refused');
    expect(outcomeOf(false, `Typed "${FENCED}" into the field`)).toBe('ok');
    expect(outcomeOf(true, `no element named "${FENCED}x"`)).not.toBe('refused');   // not at the start: screen text
    delete process.env[FENCE_ENV];
    expect(classifyResult(text, true, true)?.code).not.toBe('FENCED');
    expect(outcomeOf(true, text)).toBe('error');
  });
});
