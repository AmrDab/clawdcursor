/**
 * macOS accessibility client (src/platform/mac-ax.ts) — the layer between the
 * adapters and the compiled AX helper (scripts/mac/ax-helper.swift), with the
 * old osascript/JXA scripts as the fallback when the helper is not built.
 *
 * Everything here runs on any OS: the process runner and the helper lookup are
 * injected, so no test touches a real Mac. The live contract of the helper itself
 * is covered by mac-ax-live.test.ts (macOS only).
 *
 * Live finding that drives most of these (2026-10-15, blind test on a real Mac):
 * the window list took 9.4 s against an 8 s timeout whose error was swallowed into
 * `[]`, so `window list` said "Windows (0)" with 15 windows open — a timeout
 * reported as "nothing there".
 */
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMacAx, MacAxError, classifyKeyboardOwner, describeKeyboardOwner,
  type MacAxDeps, type FrontmostInfo,
} from '../platform/mac-ax';

type Reply = string | Error | ((file: string, args: string[]) => string | Error);

/** A runner that records every call and answers from `reply`. */
function harness(opts: { helper?: string | null; reply?: Reply } = {}) {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const ensureHelper = vi.fn();
  const deps: MacAxDeps = {
    helper: () => (opts.helper === undefined ? '/fake/ax-helper' : opts.helper),
    ensureHelper,
    scriptsDir: '/fake/scripts/mac',
    exec: async (file, args, o) => {
      calls.push({ file, args, timeoutMs: o.timeoutMs });
      const r = typeof opts.reply === 'function' ? opts.reply(file, args) : opts.reply;
      if (r instanceof Error) throw r;
      return { stdout: r ?? '{}' };
    },
  };
  return { ax: createMacAx(deps), calls, ensureHelper };
}

/** What node's execFile rejects with when its `timeout` fires. */
function execTimeout(): Error {
  return Object.assign(new Error('Command failed: killed'), { killed: true, signal: 'SIGTERM', code: null });
}

const WIN = (over: Record<string, unknown> = {}) => ({
  title: 'Untitled 7', processName: 'TextEdit', processId: 4242,
  bounds: { x: 10, y: 20, width: 603, height: 505 }, isMinimized: false, ...over,
});

// The suite-wide setup turns the compiled helper off (unit tests must not run real binaries); these tests inject their own runner.
const savedNoMacAx = process.env.CLAWD_NO_MAC_AX;
beforeEach(() => { process.env.CLAWD_NO_MAC_AX = '0'; });
afterEach(() => {
  if (savedNoMacAx === undefined) delete process.env.CLAWD_NO_MAC_AX;
  else process.env.CLAWD_NO_MAC_AX = savedNoMacAx;
});

describe('listWindows — the compiled helper', () => {
  it('runs the helper and maps its windows (handle = pid, like the JXA list)', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify({ ok: true, windows: [WIN(), WIN({ title: 'Docs', processName: 'Safari', processId: 7 })] }) });
    const wins = await ax.listWindows();
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/fake/ax-helper');
    expect(calls[0].args[0]).toBe('windows');
    expect(wins).toEqual([
      { title: 'Untitled 7', processName: 'TextEdit', processId: 4242, bounds: { x: 10, y: 20, width: 603, height: 505 }, isMinimized: false, handle: 4242 },
      { title: 'Docs', processName: 'Safari', processId: 7, bounds: { x: 10, y: 20, width: 603, height: 505 }, isMinimized: false, handle: 7 },
    ]);
  });

  it('an empty answer from a healthy helper is a real empty list, not an error', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, windows: [] }) });
    await expect(ax.listWindows()).resolves.toEqual([]);
  });

  it('a helper-side timeout is an ERROR, never "0 windows"', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'timeout', error: 'ran out of time' }) });
    const err = await ax.listWindows().then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/window list/i);
    expect(err.message).toMatch(/not .*no windows|not "no windows"/i);
  });

  it('the helper process being killed by our timeout is also a timeout error', async () => {
    const { ax } = harness({ reply: execTimeout() });
    const err = await ax.listWindows().then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
  });

  it('shows an app that did not answer as a "(not responding)" window instead of dropping it', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, windows: [WIN()], unresponsive: [{ processId: 99, processName: 'Hung App' }] }) });
    const wins = await ax.listWindows();
    expect(wins).toHaveLength(2);
    expect(wins[1]).toMatchObject({ processName: 'Hung App', processId: 99, title: '(not responding)' });
  });

  it('a locked screen is reported as such (the AX tree behind it is empty shells)', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'locked', error: 'screen is locked' }) });
    const err = await ax.listWindows().then(() => null, e => e);
    expect(err.kind).toBe('locked');
    expect(err.message).toMatch(/locked/i);
    expect(err.message).toMatch(/unlock/i);
  });

  it('missing Accessibility permission says where to grant it', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'permission', error: 'not trusted' }) });
    const err = await ax.listWindows().then(() => null, e => e);
    expect(err.kind).toBe('permission');
    expect(err.message).toMatch(/Accessibility/);
  });
});

describe('listWindows — no compiled helper yet (osascript fallback)', () => {
  const jxaList = JSON.stringify([WIN()]);

  it('falls back to get-windows.jxa and starts the background compile', async () => {
    const { ax, calls, ensureHelper } = harness({ helper: null, reply: jxaList });
    const wins = await ax.listWindows();
    expect(ensureHelper).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('osascript');
    expect(calls[0].args).toEqual(['-l', 'JavaScript', path.join('/fake/scripts/mac', 'get-windows.jxa')]);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ title: 'Untitled 7', processId: 4242, handle: 4242 });
  });

  it('REGRESSION: an osascript timeout is an error, not "[]" (the 9.4 s vs 8 s live failure)', async () => {
    const { ax } = harness({ helper: null, reply: execTimeout() });
    const err = await ax.listWindows().then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
  });

  it('gives the slow fallback more than the old 8 s, so a 9.4 s list still completes', async () => {
    const { ax, calls } = harness({ helper: null, reply: jxaList });
    await ax.listWindows();
    expect(calls[0].timeoutMs).toBeGreaterThan(9_400);
  });

  it('a JXA script that reports {error} is an error, not an empty list', async () => {
    const { ax } = harness({ helper: null, reply: JSON.stringify({ error: 'Error: Application isn’t running' }) });
    const err = await ax.listWindows().then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('failed');
  });

  it('CLAWD_NO_MAC_AX=1 never touches the helper, even if one is built', async () => {
    process.env.CLAWD_NO_MAC_AX = '1';
    const { ax, calls, ensureHelper } = harness({ helper: '/fake/ax-helper', reply: jxaList });
    await ax.listWindows();
    expect(calls[0].file).toBe('osascript');
    expect(ensureHelper).not.toHaveBeenCalled();
  });
});

describe('listWindows — a broken helper must not cost the user the feature', () => {
  it('helper binary cannot be executed → falls back to osascript for this call', async () => {
    const enoent = Object.assign(new Error('spawn /fake/ax-helper ENOENT'), { code: 'ENOENT' });
    const { ax, calls } = harness({ reply: (file) => (file === '/fake/ax-helper' ? enoent : JSON.stringify([WIN()])) });
    const wins = await ax.listWindows();
    expect(calls.map(c => c.file)).toEqual(['/fake/ax-helper', 'osascript']);
    expect(wins).toHaveLength(1);
  });

  it('helper prints garbage → falls back to osascript', async () => {
    const { ax, calls } = harness({ reply: (file) => (file === '/fake/ax-helper' ? 'Segmentation fault' : JSON.stringify([WIN()])) });
    const wins = await ax.listWindows();
    expect(calls.map(c => c.file)).toEqual(['/fake/ax-helper', 'osascript']);
    expect(wins).toHaveLength(1);
  });

  it('after the helper broke once it is not retried on every call', async () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const { ax, calls } = harness({ reply: (file) => (file === '/fake/ax-helper' ? enoent : JSON.stringify([WIN()])) });
    await ax.listWindows();
    await ax.listWindows();
    expect(calls.filter(c => c.file === '/fake/ax-helper')).toHaveLength(1);
  });
});

describe('activeWindow', () => {
  const ACTIVE = (over: Record<string, unknown> = {}) => ({
    ok: true,
    active: { ...WIN(), source: 'AXFocusedWindow', bundleId: 'com.apple.TextEdit', activationPolicy: 'regular', ...over },
  });

  it('asks the helper and returns the window IT chose (the focused one, not "window 1")', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify(ACTIVE({ title: 'Untitled 7' })) });
    const w = await ax.activeWindow();
    expect(calls[0].args[0]).toBe('active');
    expect(w).toEqual({
      title: 'Untitled 7', processName: 'TextEdit', processId: 4242,
      bounds: { x: 10, y: 20, width: 603, height: 505 }, isMinimized: false, handle: 4242,
    });
  });

  it('nothing frontmost → null', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, active: null }) });
    await expect(ax.activeWindow()).resolves.toBeNull();
  });

  it('a frontmost app with no window still reports the app, with empty bounds', async () => {
    const { ax } = harness({ reply: JSON.stringify(ACTIVE({ title: '', bounds: { x: 0, y: 0, width: 0, height: 0 }, source: 'none' })) });
    const w = await ax.activeWindow();
    expect(w).toMatchObject({ processName: 'TextEdit', processId: 4242, title: '', bounds: { x: 0, y: 0, width: 0, height: 0 } });
  });

  it('a timeout is an error, not "no active window"', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'timeout' }) });
    const err = await ax.activeWindow().then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/active window/i);
  });

  it('a locked screen is an error that says so', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'locked' }) });
    const err = await ax.activeWindow().then(() => null, e => e);
    expect(err.kind).toBe('locked');
  });

  describe('osascript fallback', () => {
    it('reads get-foreground-window.jxa', async () => {
      const { ax, calls } = harness({
        helper: null,
        reply: JSON.stringify({ success: true, handle: 4242, processId: 4242, processName: 'TextEdit', title: 'Untitled 7', bounds: { x: 1, y: 2, width: 3, height: 4 } }),
      });
      const w = await ax.activeWindow();
      expect(calls[0].file).toBe('osascript');
      expect(calls[0].args[2]).toBe(path.join('/fake/scripts/mac', 'get-foreground-window.jxa'));
      expect(w).toMatchObject({ title: 'Untitled 7', processId: 4242, processName: 'TextEdit', bounds: { x: 1, y: 2, width: 3, height: 4 } });
    });

    it('"No foreground window found" is a genuine null', async () => {
      const { ax } = harness({ helper: null, reply: JSON.stringify({ success: false, error: 'No foreground window found' }) });
      await expect(ax.activeWindow()).resolves.toBeNull();
    });

    it('any other script failure is an error, not null', async () => {
      const { ax } = harness({ helper: null, reply: JSON.stringify({ success: false, error: 'Error: Application can’t be found' }) });
      const err = await ax.activeWindow().then(() => null, e => e);
      expect(err).toBeInstanceOf(MacAxError);
      expect(err.kind).toBe('failed');
    });

    it('a timeout is an error, not null', async () => {
      const { ax } = harness({ helper: null, reply: execTimeout() });
      const err = await ax.activeWindow().then(() => null, e => e);
      expect(err.kind).toBe('timeout');
    });
  });
});

describe('uiTree', () => {
  const R = (x: number, y: number, w = 40, h = 30) => ({ x, y, width: w, height: h });
  /** Shape of a macOS 26 SwiftUI Calculator: buttons carry ONLY an AXIdentifier. */
  const CALC = {
    ok: true, processId: 321, processName: 'Calculator', truncated: false, reason: null, nodeCount: 5, elapsedMs: 80,
    tree: {
      name: '', automationId: '', controlType: 'AXWindow', subrole: 'AXStandardWindow', bounds: R(100, 100, 230, 400),
      children: [{
        name: '', automationId: 'main', controlType: 'AXGroup', bounds: R(100, 130, 230, 370),
        children: [
          { name: '', automationId: 'One', controlType: 'AXButton', bounds: R(110, 400), enabled: true },
          { name: '', automationId: 'Multiply', controlType: 'AXButton', bounds: R(160, 400), enabled: true },
          { name: '', automationId: 'Equals', controlType: 'AXButton', bounds: R(210, 400), enabled: false },
        ],
      }],
    },
  };

  it('runs the helper for the pid and flattens the tree depth-first with depths', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify(CALC) });
    const { elements, truncated } = await ax.uiTree(321);
    expect(calls[0].args.slice(0, 3)).toEqual(['tree', '--pid', '321']);
    expect(truncated).toBe(false);
    expect(elements.map(e => [e.controlType, e.depth])).toEqual([['Window', 0], ['Group', 1], ['Button', 2], ['Button', 2], ['Button', 2]]);
    expect(elements[2].bounds).toEqual(R(110, 400));
    expect(elements.every(e => e.processId === 321)).toBe(true);
  });

  it('B9: AXIdentifier becomes automationId AND the name when the control has no label', async () => {
    const { ax } = harness({ reply: JSON.stringify(CALC) });
    const { elements } = await ax.uiTree(321);
    const one = elements.find(e => e.automationId === 'One')!;
    expect(one).toBeDefined();
    expect(one.name).toBe('One');
    expect(one.controlType).toBe('Button');
    expect(elements.find(e => e.automationId === 'Multiply')!.name).toBe('Multiply');
  });

  it('a real label wins over the identifier, and the identifier is still kept', async () => {
    const tree = { ...CALC, tree: { name: 'Save', automationId: 'saveButton', controlType: 'AXButton', bounds: R(0, 0) } };
    const { ax } = harness({ reply: JSON.stringify(tree) });
    const [el] = (await ax.uiTree(321)).elements;
    expect(el.name).toBe('Save');
    expect(el.automationId).toBe('saveButton');
  });

  it('AppKit\'s generated "_NS:123" identifiers are not turned into names', async () => {
    const tree = { ...CALC, tree: { name: '', automationId: '_NS:833', controlType: 'AXMenuBar', bounds: R(0, 0) } };
    const { ax } = harness({ reply: JSON.stringify(tree) });
    const [el] = (await ax.uiTree(321)).elements;
    expect(el.name).toBe('');
    expect(el.automationId).toBe('_NS:833');
  });

  it('disabled controls are marked disabled', async () => {
    const { ax } = harness({ reply: JSON.stringify(CALC) });
    const { elements } = await ax.uiTree(321);
    expect(elements.find(e => e.automationId === 'Equals')).toMatchObject({ enabled: false, disabled: true });
    expect(elements.find(e => e.automationId === 'One')!.disabled).toBeUndefined();
  });

  it('never surfaces a secure field\'s value, even if the helper sent one', async () => {
    const tree = { ...CALC, tree: { name: 'Password', automationId: '', controlType: 'AXTextField', subrole: 'AXSecureTextField', secure: true, value: 'hunter2', bounds: R(0, 0) } };
    const { ax } = harness({ reply: JSON.stringify(tree) });
    const [el] = (await ax.uiTree(321)).elements;
    expect(el.secure).toBe(true);
    expect(el.value).toBeUndefined();
  });

  it('values are always strings (checkbox 1, slider 0.5)', async () => {
    const tree = { ...CALC, tree: { name: 'Volume', automationId: '', controlType: 'AXSlider', value: 0.5, bounds: R(0, 0) } };
    const { ax } = harness({ reply: JSON.stringify(tree) });
    const [el] = (await ax.uiTree(321)).elements;
    expect(el.value).toBe('0.5');
  });

  it('a walk that hit its budget is flagged truncated, with what it did read', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ...CALC, truncated: true, reason: 'time' }) });
    const { elements, truncated } = await ax.uiTree(321);
    expect(truncated).toBe(true);
    expect(elements.length).toBe(5);
  });

  it('an app with no window yields a genuinely empty tree', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ...CALC, tree: null, nodeCount: 0 }) });
    await expect(ax.uiTree(321)).resolves.toEqual({ elements: [], truncated: false });
  });

  it('without a pid the helper reads the frontmost app', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify(CALC) });
    await ax.uiTree();
    expect(calls[0].args).not.toContain('--pid');
  });

  it('B4: a timeout is an error that says it is NOT an empty / custom-canvas app', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'timeout' }) });
    const err = await ax.uiTree(321).then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/accessibility tree/i);
    expect(err.message).toMatch(/321/);
    expect(err.message).toMatch(/not .*custom-canvas|custom-canvas/i);
  });

  describe('osascript fallback', () => {
    const JXA_TREE = { windows: [], uiTree: { name: 'Doc', automationId: '', controlType: 'AXWindow', bounds: R(0, 0, 500, 400), children: [{ name: 'Body', automationId: '', controlType: 'AXTextArea', value: 'hi', bounds: R(0, 30, 500, 370) }] } };

    it('passes the pid and depth the script parses, then flattens uiTree', async () => {
      const { ax, calls } = harness({ helper: null, reply: JSON.stringify(JXA_TREE) });
      const { elements } = await ax.uiTree(321);
      expect(calls[0].file).toBe('osascript');
      expect(calls[0].args).toEqual(expect.arrayContaining(['-FocusedProcessId', '321', '-MaxDepth', '8']));
      expect(elements.map(e => e.controlType)).toEqual(['Window', 'TextArea']);
      expect(elements[1].value).toBe('hi');
    });

    it('with no pid it first asks for the active window\'s pid (the script needs one)', async () => {
      const { ax, calls } = harness({
        helper: null,
        reply: (_f, args) => (args.some(a => a.includes('get-foreground-window'))
          ? JSON.stringify({ success: true, processId: 555, processName: 'TextEdit', title: 'x', bounds: R(0, 0) })
          : JSON.stringify(JXA_TREE)),
      });
      await ax.uiTree();
      expect(calls).toHaveLength(2);
      expect(calls[1].args).toEqual(expect.arrayContaining(['-FocusedProcessId', '555']));
    });

    it('B4: a timeout is an error, and the slow fallback gets more than the old 12 s', async () => {
      const slow = harness({ helper: null, reply: JSON.stringify(JXA_TREE) });
      await slow.ax.uiTree(321);
      expect(slow.calls[0].timeoutMs).toBeGreaterThan(24_800);   // Calculator took 24.8 s live

      const { ax } = harness({ helper: null, reply: execTimeout() });
      const err = await ax.uiTree(321).then(() => null, e => e);
      expect(err).toBeInstanceOf(MacAxError);
      expect(err.kind).toBe('timeout');
    });
  });
});

describe('find', () => {
  const EL = (over: Record<string, unknown> = {}) => ({
    name: 'Save', automationId: 'saveButton', controlType: 'AXButton', bounds: { x: 5, y: 6, width: 70, height: 24 },
    enabled: true, processId: 7, ...over,
  });

  it('passes name, AX role and identifier to the helper and maps the matches in its order', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify({ ok: true, elements: [EL(), EL({ name: 'Save As…', automationId: '' })] }) });
    const hits = await ax.find({ processId: 7, name: 'Save', controlType: 'Button', automationId: 'saveButton' });
    const args = calls[0].args;
    expect(args[0]).toBe('find');
    expect(args[args.indexOf('--pid') + 1]).toBe('7');
    expect(args[args.indexOf('--name') + 1]).toBe('Save');
    expect(args[args.indexOf('--role') + 1]).toBe('AXButton');
    expect(args[args.indexOf('--id') + 1]).toBe('saveButton');
    expect(hits.map(h => h.name)).toEqual(['Save', 'Save As…']);
    expect(hits[0]).toMatchObject({ controlType: 'Button', automationId: 'saveButton', processId: 7 });
  });

  it.each([
    ['Button', 'AXButton'], ['Edit', 'AXTextField'], ['CheckBox', 'AXCheckBox'], ['Hyperlink', 'AXLink'],
    ['MenuItem', 'AXMenuItem'], ['TabItem', 'AXTab'], ['ListItem', 'AXCell'], ['Window', 'AXWindow'],
    ['AXSlider', 'AXSlider'], ['Foo', 'AXFoo'],
  ])('controlType %s → role %s (same table the JXA find used)', async (controlType, role) => {
    const { ax, calls } = harness({ reply: JSON.stringify({ ok: true, elements: [] }) });
    await ax.find({ processId: 7, controlType });
    expect(calls[0].args[calls[0].args.indexOf('--role') + 1]).toBe(role);
  });

  it('B9: a control found only by its identifier is named by it', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, elements: [EL({ name: '', automationId: 'One' })] }) });
    const [hit] = await ax.find({ processId: 7, automationId: 'One' });
    expect(hit).toMatchObject({ name: 'One', automationId: 'One' });
  });

  it('no match is a genuine empty list', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, elements: [] }) });
    await expect(ax.find({ processId: 7, name: 'Nope' })).resolves.toEqual([]);
  });

  it('a timeout is an error, not "no elements found"', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'timeout' }) });
    const err = await ax.find({ processId: 7, name: 'Save' }).then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/element search/i);
  });

  describe('osascript fallback', () => {
    it('keeps the argument contract find-element.jxa parses (-ProcessId / -Name / -ControlType)', async () => {
      const { ax, calls } = harness({ helper: null, reply: JSON.stringify([{ name: 'OK', role: 'AXButton', value: '', bounds: { x: 1, y: 2, width: 3, height: 4 }, processId: 77 }]) });
      const hits = await ax.find({ processId: 77, name: 'OK', controlType: 'Button' });
      const a = calls[0].args;
      expect(a.slice(0, 3)).toEqual(['-l', 'JavaScript', path.join('/fake/scripts/mac', 'find-element.jxa')]);
      expect(a).toEqual(expect.arrayContaining(['-ProcessId', '77', '-Name', 'OK', '-ControlType', 'Button']));
      expect(a).not.toContain('-FocusedProcessId');
      // the script reports the AX role as `role`, not `controlType`
      expect(hits[0]).toMatchObject({ name: 'OK', controlType: 'Button', processId: 77 });
    });

    it('a timeout is an error', async () => {
      const { ax } = harness({ helper: null, reply: execTimeout() });
      const err = await ax.find({ processId: 77, name: 'OK' }).then(() => null, e => e);
      expect(err.kind).toBe('timeout');
    });

    it('a script error object is an error, not an empty list', async () => {
      const { ax } = harness({ helper: null, reply: JSON.stringify({ error: 'No process found with ID 77' }) });
      const err = await ax.find({ processId: 77, name: 'OK' }).then(() => null, e => e);
      expect(err.kind).toBe('failed');
      expect(err.message).toMatch(/No process found/);
    });
  });
});

describe('invoke', () => {
  it('passes the target and the action to the helper', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify({ ok: true, success: true, action: 'set-value', method: 'AXValue' }) });
    const res = await ax.invoke({ processId: 7, name: 'Name', controlType: 'Edit', automationId: 'nameField', action: 'set-value', value: 'a b' });
    const a = calls[0].args;
    expect(a[0]).toBe('invoke');
    expect(a[a.indexOf('--pid') + 1]).toBe('7');
    expect(a[a.indexOf('--action') + 1]).toBe('set-value');
    expect(a[a.indexOf('--name') + 1]).toBe('Name');
    expect(a[a.indexOf('--role') + 1]).toBe('AXTextField');
    expect(a[a.indexOf('--id') + 1]).toBe('nameField');
    expect(a[a.indexOf('--value') + 1]).toBe('a b');
    expect(res.success).toBe(true);
  });

  it('B9: invoking by identifier alone reaches the helper as --id', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify({ ok: true, success: true, action: 'click' }) });
    await ax.invoke({ processId: 7, automationId: 'One', action: 'click' });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--id', 'One']));
    expect(calls[0].args).not.toContain('--name');
  });

  it('surfaces a get-value payload (top-level `value`) as data.value', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, success: true, action: 'get-value', value: '6,223' }) });
    const res = await ax.invoke({ processId: 7, name: 'Display', action: 'get-value' });
    expect(res.data?.value).toBe('6,223');
  });

  it('keeps a nested data payload (toggle)', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, success: true, action: 'toggle', data: { toggleState: 'On' } }) });
    const res = await ax.invoke({ processId: 7, name: 'Mute', action: 'toggle' });
    expect(res.data?.toggleState).toBe('On');
  });

  it('a click the element refused returns its bounds so the caller can click by coordinates', async () => {
    const bounds = { x: 100, y: 200, width: 50, height: 20 };
    const { ax } = harness({ reply: JSON.stringify({ ok: true, success: false, action: 'click', error: 'does not support AXPress', clickPoint: { x: 125, y: 210 }, bounds }) });
    const res = await ax.invoke({ processId: 7, name: 'Switch', action: 'click' });
    expect(res).toMatchObject({ success: false, bounds, error: 'does not support AXPress' });
  });

  it('only a clickPoint becomes a 1×1 rect', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, success: false, action: 'click', clickPoint: { x: 125, y: 210 } }) });
    const res = await ax.invoke({ processId: 7, name: 'Switch', action: 'click' });
    expect(res.bounds).toEqual({ x: 125, y: 210, width: 1, height: 1 });
  });

  it('"element not found" is a plain miss, not an exception', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, success: false, action: 'click', error: 'Element not found: name="Zzz"' }) });
    await expect(ax.invoke({ processId: 7, name: 'Zzz', action: 'click' })).resolves.toMatchObject({ success: false, error: 'Element not found: name="Zzz"' });
  });

  it('a timeout is an exception (it is not "not found")', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: false, kind: 'timeout' }) });
    const err = await ax.invoke({ processId: 7, name: 'Save', action: 'click' }).then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/invoke/i);
  });

  describe('osascript fallback', () => {
    it('keeps the argument contract invoke-element.jxa parses', async () => {
      const { ax, calls } = harness({ helper: null, reply: JSON.stringify({ success: true, action: 'click' }) });
      await ax.invoke({ processId: 9, name: 'Send', controlType: 'Button', action: 'click', value: 'v' });
      const a = calls[0].args;
      expect(a[2]).toBe(path.join('/fake/scripts/mac', 'invoke-element.jxa'));
      expect(a).toEqual(expect.arrayContaining(['-ProcessId', '9', '-Name', 'Send', '-ControlType', 'Button', '-Action', 'click', '-Value', 'v']));
      expect(a).not.toContain('-FocusedProcessId');
    });

    it('a script failure is a miss with the script\'s reason', async () => {
      const { ax } = harness({ helper: null, reply: JSON.stringify({ success: false, error: 'Element not found: name="X"' }) });
      await expect(ax.invoke({ processId: 9, name: 'X', action: 'click' })).resolves.toMatchObject({ success: false, error: 'Element not found: name="X"' });
    });

    it('a timeout is an exception', async () => {
      const { ax } = harness({ helper: null, reply: execTimeout() });
      const err = await ax.invoke({ processId: 9, name: 'X', action: 'click' }).then(() => null, e => e);
      expect(err.kind).toBe('timeout');
    });
  });
});


describe('frontmost (NSWorkspace — what System Events cannot see)', () => {
  const FRONT = (over: Record<string, unknown> = {}) => ({
    ok: true, locked: false,
    frontmost: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 4242, activationPolicy: 'regular', windows: [], ...over },
  });

  it('asks the helper and maps the app', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify(FRONT()) });
    const info = await ax.frontmost();
    expect(calls[0].args[0]).toBe('frontmost');
    expect(info).toEqual({
      locked: false,
      app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 4242, activationPolicy: 'regular', windows: [] },
    });
  });

  it('reports a locked screen as data (the keyboard guard decides what to do)', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, locked: true, frontmost: { name: 'loginwindow', bundleId: 'com.apple.loginwindow', processId: 696, activationPolicy: 'accessory', windows: [] } }) });
    expect((await ax.frontmost()).locked).toBe(true);
  });

  it('nothing frontmost → app null', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, locked: false, frontmost: null }) });
    await expect(ax.frontmost()).resolves.toEqual({ locked: false, app: null });
  });

  it('a timeout throws (callers decide to fail open)', async () => {
    const { ax } = harness({ reply: execTimeout() });
    const err = await ax.frontmost().then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
  });

  describe('lsappinfo fallback (no compiled helper)', () => {
    const LOGINWINDOW = [
      '"loginwindow" ASN:0x0-0x3003: (in front) ',
      '    bundleID="com.apple.loginwindow"',
      '    bundle path="/System/Library/CoreServices/loginwindow.app"',
      '    pid = 696 type="UIElement" flavor=3 Version="3085.5.3" fileType="APPL" creator="lgnw" Arch=ARM64 ',
    ].join('\n');
    const TEXTEDIT = LOGINWINDOW.replace('loginwindow" ASN', 'TextEdit" ASN').replace(/com\.apple\.loginwindow/, 'com.apple.TextEdit').replace('pid = 696 type="UIElement"', 'pid = 4242 type="Foreground"');
    const lsapp = (info: string) => (file: string, args: string[]) => (args[0] === 'front' ? 'ASN:0x0-0x3003:\n' : info);

    it('front → info: name, bundle id, pid and activation type', async () => {
      const { ax, calls } = harness({ helper: null, reply: lsapp(TEXTEDIT) });
      const info = await ax.frontmost();
      expect(calls.map(c => [c.file, c.args[0]])).toEqual([['lsappinfo', 'front'], ['lsappinfo', 'info']]);
      expect(info.app).toMatchObject({ name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 4242, activationPolicy: 'regular', windows: [] });
      expect(info.locked).toBe(false);
    });

    it('loginwindow in front means the screen is locked', async () => {
      const { ax } = harness({ helper: null, reply: lsapp(LOGINWINDOW) });
      const info = await ax.frontmost();
      expect(info.locked).toBe(true);
      expect(info.app).toMatchObject({ name: 'loginwindow', activationPolicy: 'accessory' });
    });

    it('unreadable lsappinfo output → app null (the guard then lets input through)', async () => {
      const { ax } = harness({ helper: null, reply: () => 'garbage' });
      await expect(ax.frontmost()).resolves.toEqual({ locked: false, app: null });
    });
  });
});

describe('classifyKeyboardOwner (B11 — a system alert / lock screen that owns the keyboard)', () => {
  const app = (over: Record<string, unknown> = {}): FrontmostInfo => ({
    locked: false,
    app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 1, activationPolicy: 'regular', windows: [], ...over } as FrontmostInfo['app'],
  });

  it('a normal app owns it', () => {
    expect(classifyKeyboardOwner(app())).toEqual({ kind: 'app' });
  });

  it('nothing frontmost → do not block', () => {
    expect(classifyKeyboardOwner({ locked: false, app: null })).toEqual({ kind: 'app' });
  });

  it('a locked screen owns it', () => {
    expect(classifyKeyboardOwner({ locked: true, app: null })).toEqual({ kind: 'locked' });
  });

  it('a TCC / system alert process in front owns it, even before its window is readable', () => {
    const owner = classifyKeyboardOwner(app({ name: 'UserNotificationCenter', bundleId: 'com.apple.UserNotificationCenter', processId: 311, activationPolicy: 'accessory' }));
    expect(owner).toMatchObject({ kind: 'alert', name: 'UserNotificationCenter', processId: 311 });
  });

  it('an unknown accessory process showing a dialog window owns it, and its title is reported', () => {
    const owner = classifyKeyboardOwner(app({
      name: 'SomeAgent', bundleId: 'com.example.agent', processId: 9, activationPolicy: 'accessory',
      windows: [{ title: '“Foo” would like to access data from other apps', subrole: 'AXSystemDialog' }],
    }));
    expect(owner).toMatchObject({ kind: 'alert', name: 'SomeAgent', title: '“Foo” would like to access data from other apps' });
  });

  it.each([
    ['Spotlight (clawdcursor itself types into it to launch apps)', { name: 'Spotlight', bundleId: 'com.apple.Spotlight' }],
    ['the Dock (app switcher / Mission Control)', { name: 'Dock', bundleId: 'com.apple.dock' }],
    ['the menu-bar host', { name: 'SystemUIServer', bundleId: 'com.apple.systemuiserver' }],
    ['Control Center', { name: 'Control Center', bundleId: 'com.apple.controlcenter' }],
    ['clawdcursor\'s own overlay', { name: 'clawd-overlay', bundleId: undefined }],
  ])('%s is not an alert, even with a dialog-looking window', (_label, who) => {
    const owner = classifyKeyboardOwner(app({ ...who, activationPolicy: 'accessory', windows: [{ title: 'x', subrole: 'AXSystemDialog' }] }));
    expect(owner).toEqual({ kind: 'app' });
  });

  it('an unknown accessory process with only ordinary windows does not block', () => {
    expect(classifyKeyboardOwner(app({ name: 'Menu Bar Thing', bundleId: 'com.example.mb', activationPolicy: 'accessory', windows: [{ title: 'panel', subrole: 'AXFloatingWindow' }] })))
      .toEqual({ kind: 'app' });
  });

  it('a sheet on the app you are driving never blocks (you type your filename into it)', () => {
    expect(classifyKeyboardOwner(app({ windows: [{ title: 'Save', subrole: 'AXDialog', modal: true }] }))).toEqual({ kind: 'app' });
  });
});

describe('describeKeyboardOwner', () => {
  it('names the alert, its title, and how to answer it without the keyboard', () => {
    const text = describeKeyboardOwner({ kind: 'alert', name: 'UserNotificationCenter', processId: 311, title: 'Foo wants access' });
    expect(text).toMatch(/UserNotificationCenter/);
    expect(text).toMatch(/Foo wants access/);
    expect(text).toMatch(/311/);
    expect(text).toMatch(/NSWorkspace|System Events/);
    expect(text).toMatch(/processId/);
  });

  it('the lock screen message says to unlock', () => {
    expect(describeKeyboardOwner({ kind: 'locked' })).toMatch(/locked.*unlock|unlock/i);
  });
});

describe('appState (B2 — is the launched app running, and does it have a window?)', () => {
  const APP = (over: Record<string, unknown> = {}) => ({
    name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 4242, finishedLaunching: true, active: true,
    activationPolicy: 'regular', launchDate: 1000, windows: [WIN()], ...over,
  });

  it('asks NSWorkspace (via the helper) by name and maps the app and its windows', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify({ ok: true, apps: [APP()] }) });
    const st = await ax.appState('TextEdit');
    expect(calls[0].args.slice(0, 3)).toEqual(['apps', '--name', 'TextEdit']);
    expect(st).toMatchObject({
      name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 4242, finishedLaunching: true, active: true,
      windows: [{ title: 'Untitled 7', processId: 4242, handle: 4242 }],
      windowsKnown: true,
    });
  });

  it('not running → null', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, apps: [] }) });
    await expect(ax.appState('Nope')).resolves.toBeNull();
  });

  it('an exact name beats a substring match ("Notes" is not "Notes Helper")', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, apps: [APP({ name: 'Notes Helper', processId: 1 }), APP({ name: 'Notes', processId: 2 })] }) });
    expect((await ax.appState('notes'))!.processId).toBe(2);
  });

  it('with several instances the newest launch wins (open -n)', async () => {
    const { ax } = harness({ reply: JSON.stringify({ ok: true, apps: [APP({ processId: 1, launchDate: 100 }), APP({ processId: 2, launchDate: 300 }), APP({ processId: 3, launchDate: 200 })] }) });
    expect((await ax.appState('TextEdit'))!.processId).toBe(2);
  });

  it('strips ".app" and a path prefix from the name it searches for', async () => {
    const { ax, calls } = harness({ reply: JSON.stringify({ ok: true, apps: [] }) });
    await ax.appState('/System/Applications/Calculator.app');
    expect(calls[0].args[calls[0].args.indexOf('--name') + 1]).toBe('Calculator');
  });

  it('a helper timeout throws — the caller treats the state as unknown, not as "not running"', async () => {
    const { ax } = harness({ reply: execTimeout() });
    const err = await ax.appState('TextEdit').then(() => null, e => e);
    expect(err).toBeInstanceOf(MacAxError);
    expect(err.kind).toBe('timeout');
  });

  describe('lsappinfo fallback (no compiled helper)', () => {
    const INFO = '"TextEdit" ASN:0x0-0x5de5de: \n    bundleID="com.apple.TextEdit"\n    pid = 4242 type="Foreground" flavor=3\n';

    it('finds the process by name; windows are unknown (empty)', async () => {
      const { ax, calls } = harness({ helper: null, reply: (_f, args) => (args[0] === 'find' ? 'ASN:0x0-0x5de5de-"TextEdit":\n' : INFO) });
      const st = await ax.appState('TextEdit');
      expect(calls.map(c => [c.file, c.args[0], c.args[1]])).toEqual([['lsappinfo', 'find', 'name=TextEdit'], ['lsappinfo', 'info', 'ASN:0x0-0x5de5de-"TextEdit":']]);
      // lsappinfo knows the process, not its windows — the caller must ask the window list
      expect(st).toMatchObject({ name: 'TextEdit', processId: 4242, bundleId: 'com.apple.TextEdit', windows: [], windowsKnown: false });
    });

    it('nothing found → null', async () => {
      const { ax } = harness({ helper: null, reply: () => '' });
      await expect(ax.appState('Nope')).resolves.toBeNull();
    });
  });
});

describe('defaultExec — the real process runner', () => {
  it('returns output far larger than node\'s 1 MB default buffer (a big window\'s tree is megabytes of JSON)', async () => {
    const { defaultExec } = await import('../platform/mac-ax');
    const { stdout } = await defaultExec(process.execPath, ['-e', 'process.stdout.write("x".repeat(3_000_000))'], { timeoutMs: 20_000 });
    expect(stdout.length).toBe(3_000_000);
  });

  it('kills a stuck process at the timeout and rejects the way execFile does (killed)', async () => {
    const { defaultExec } = await import('../platform/mac-ax');
    const err = await defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 }).then(() => null, e => e);
    expect(err).toBeTruthy();
    expect(err.killed).toBe(true);
  });
});


describe('prepare (build the helper before it is first needed)', () => {
  it('starts the one-time background compile when the helper is not built', () => {
    const { ax, ensureHelper } = harness({ helper: null });
    ax.prepare();
    expect(ensureHelper).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the helper already exists', () => {
    const { ax, ensureHelper } = harness({ helper: '/fake/ax-helper' });
    ax.prepare();
    expect(ensureHelper).not.toHaveBeenCalled();
  });

  it('does nothing when the helper is switched off', () => {
    process.env.CLAWD_NO_MAC_AX = '1';
    const { ax, ensureHelper } = harness({ helper: null });
    ax.prepare();
    expect(ensureHelper).not.toHaveBeenCalled();
  });
});
