/**
 * macOS invokeElement/findElements argument + payload contract (review 2026-06-11).
 *
 * Two real bugs guarded here:
 *  1. The adapter passed '-FocusedProcessId' to invoke-element.jxa /
 *     find-element.jxa, but those scripts parse '-ProcessId' — every pid-scoped
 *     invoke / get-value failed ("Missing required parameter: -processId") and
 *     find lost its pid scoping. ('-FocusedProcessId' belongs ONLY to
 *     get-screen-context.jxa.)
 *  2. The JXA returns get-value's payload at the TOP level ({success, action,
 *     value, method}), but every consumer reads res.data?.value — the adapter
 *     must surface the top-level value into data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let nextStdout = '{}';
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    execFileCalls.push({ cmd, args });
    cb(null, { stdout: nextStdout, stderr: '' });
  },
  spawn: vi.fn(),
}));

import { MacOSAdapter } from '../platform/macos';

const mac = new MacOSAdapter();

beforeEach(() => { execFileCalls.length = 0; nextStdout = '{}'; });

describe('macOS invokeElement — JXA argument contract', () => {
  it('passes -ProcessId (the flag invoke-element.jxa parses), never -FocusedProcessId', async () => {
    nextStdout = JSON.stringify({ success: true, action: 'click' });
    await mac.invokeElement({ name: 'Send', processId: 123, action: 'click' });
    const call = execFileCalls.find(c => c.args.some(a => String(a).includes('invoke-element.jxa')))!;
    expect(call).toBeDefined();
    expect(call.args).toContain('-ProcessId');
    expect(call.args).toContain('123');
    expect(call.args).not.toContain('-FocusedProcessId');
  });

  it('surfaces the JXA top-level get-value `value` into res.data.value', async () => {
    nextStdout = JSON.stringify({ success: true, action: 'get-value', value: 'hello world', method: 'AXValue' });
    const res = await mac.invokeElement({ name: 'Text editor', processId: 9, action: 'get-value' });
    expect(res.success).toBe(true);
    expect(res.data?.value).toBe('hello world');
  });

  it('keeps a nested data payload when the JXA provides one (toggle)', async () => {
    nextStdout = JSON.stringify({ success: true, action: 'toggle', data: { toggleState: 'on' } });
    const res = await mac.invokeElement({ name: 'Mute', processId: 9, action: 'toggle' });
    expect(res.data?.toggleState).toBe('on');
  });
});

describe('macOS findElements — JXA argument contract', () => {
  it('passes -ProcessId to find-element.jxa (pid scoping is not silently dropped)', async () => {
    nextStdout = '[]';
    await mac.findElements({ name: 'OK', processId: 77 });
    const call = execFileCalls.find(c => c.args.some(a => String(a).includes('find-element.jxa')))!;
    expect(call).toBeDefined();
    expect(call.args).toContain('-ProcessId');
    expect(call.args).toContain('77');
    expect(call.args).not.toContain('-FocusedProcessId');
  });
});

describe('macOS getUiTree — keeps -FocusedProcessId (the flag get-screen-context.jxa parses)', () => {
  it('passes -FocusedProcessId and -MaxDepth 8', async () => {
    nextStdout = JSON.stringify({ uiTree: null });
    await mac.getUiTree(42);
    const call = execFileCalls.find(c => c.args.some(a => String(a).includes('get-screen-context.jxa')))!;
    expect(call).toBeDefined();
    expect(call.args).toContain('-FocusedProcessId');
    expect(call.args).toContain('-MaxDepth');
    expect(call.args).toContain('8');
  });
});

describe('macOS invokeElement — surfaces the found element on a pattern miss', () => {
  it('maps the JXA failure clickPoint/bounds into res.bounds so callers can coordinate-fallback', async () => {
    nextStdout = JSON.stringify({
      success: false, action: 'click', error: 'Element does not support click(). Use coordinate click.',
      clickPoint: { x: 125, y: 210 }, bounds: { x: 100, y: 200, width: 50, height: 20 },
    });
    const res = await mac.invokeElement({ name: 'Switch', processId: 9, action: 'click' });
    expect(res.success).toBe(false);
    expect(res.bounds).toEqual({ x: 100, y: 200, width: 50, height: 20 });
  });

  it('falls back to a point-sized rect when only clickPoint is reported', async () => {
    nextStdout = JSON.stringify({ success: false, action: 'click', clickPoint: { x: 125, y: 210 } });
    const res = await mac.invokeElement({ name: 'Switch', processId: 9, action: 'click' });
    expect(res.bounds).toEqual({ x: 125, y: 210, width: 1, height: 1 });
  });
});
