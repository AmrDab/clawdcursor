/**
 * The pill is the user's to every clawdcursor process, and the agent's own prompt never answers its own pause
 * (review of the own-UI guard, 2026-10-24).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publishOverlayState, foreignOverlayState, __setOverlayStateDirForTests } from '../core/overlay-state';
import { ownUiRefusal, guardedCall, refusalBefore } from '../tools/call-guards';
import type { ToolContext } from '../tools/types';
import { promptSatisfies } from '../tools/agent';
import { checkAssertions } from '../core/verify/assertions';
import { setOwnUiPids } from '../platform/pointer-guard';
import type { PlatformAdapter } from '../platform/types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-overlay-')); __setOverlayStateDirForTests(dir); });
afterEach(() => { __setOverlayStateDirForTests(null); fs.rmSync(dir, { recursive: true, force: true }); setOwnUiPids(() => []); });

// Another live clawdcursor process: the test runner's parent is alive for the whole run.
const writeForeign = (writer: number, s: object, at = Date.now()) => fs.writeFileSync(path.join(dir, `${writer}.json`), JSON.stringify({ at, ...s }));

describe('overlay state across processes', () => {
  it('another live process\'s pill and pause are seen; this process\'s own file and a dead writer\'s are not', () => {
    writeForeign(process.ppid, { pids: [5555], paused: true });
    writeForeign(process.pid, { pids: [6666], paused: false });
    writeForeign(2 ** 30, { pids: [7777], paused: true }); // no such process
    expect(foreignOverlayState()).toEqual({ pids: [5555], paused: true, pausedBy: process.ppid });
  });

  it('a file whose writer stopped beating (force-killed, pid reused) is ignored — no lockout', () => {
    writeForeign(process.ppid, { pids: [5555], paused: true }, Date.now() - 60_000);
    expect(foreignOverlayState()).toEqual({ pids: [], paused: false });
    expect(ownUiRefusal({}, false)).toBeNull();
  });

  it('a pause another process shows right after a read is seen on the next call — no stale cache', () => {
    expect(foreignOverlayState().paused).toBe(false);
    writeForeign(process.ppid, { pids: [5555], paused: true });
    expect(foreignOverlayState()).toMatchObject({ pids: [5555], paused: true });
  });

  it('publishing writes this process\'s file, and an empty state removes it', () => {
    publishOverlayState({ pids: [4242], paused: true });
    const file = path.join(dir, `${process.pid}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pids: [4242], paused: true, at: expect.any(Number) });
    publishOverlayState({ pids: [], paused: false });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a pause shown by another process stops this one too; its pill pid is refused', () => {
    writeForeign(process.ppid, { pids: [5555], paused: true });
    expect(ownUiRefusal({ name: 'Resume' }, false)).toMatch(/a pause is waiting for the user on screen \(shown by clawdcursor process \d+\)/);
    // an expect turns even a pause-safe call into a screen read
    expect(ownUiRefusal({ action: 'pause_for_user', expect: [{ type: 'ocr_contains', value: 'x' }] }, true)).toMatch(/a pause is waiting/);
    expect(ownUiRefusal({ assertions: [{ type: 'element_exists', name: 'Saved' }] }, true)).toMatch(/a pause is waiting/);
    expect(ownUiRefusal({ processId: 5555 }, true)).toMatch(/is clawdcursor's own on-screen control/);
    expect(ownUiRefusal({}, true)).toBeNull();
  });

  it('a pause card from another process holds real input only: reads still run, its pill is still never a target', async () => {
    writeForeign(process.ppid, { pids: [5555], paused: true });
    const ctx = {} as ToolContext;
    const why = (tool: string, action: string, args: Record<string, unknown> = {}) => refusalBefore(guardedCall(tool, action, args), ctx);
    for (const [tool, action] of [['accessibility', 'read_tree'], ['system', 'ocr'], ['system', 'copy_all_text'], ['window', 'list']] as const) {
      expect(await why(tool, action), tool + ' ' + action).toBeNull();
    }
    for (const [tool, action] of [['computer', 'click'], ['computer', 'type'], ['accessibility', 'invoke'], ['window', 'focus'],
      ['computer', 'hover'], ['computer', 'mouse_move'], ['computer', 'move_relative'], ['browser', 'evaluate'], ['browser', 'connect']] as const) {
      expect(await why(tool, action), tool + ' ' + action).toMatchObject({ guard: 'own_ui', why: expect.stringMatching(/a pause is waiting for the user on screen [(]shown by clawdcursor process/) });
    }
    expect(await why('accessibility', 'read_tree', { processId: 5555 })).toMatchObject({ guard: 'own_ui', why: expect.stringMatching(/own on-screen control/) });
  });
});

describe('the prompt never answers its own pause', () => {
  it('a done_when the prompt itself satisfies is named — OCR of its text, or one of its buttons by name', () => {
    expect(promptSatisfies('Sign in to GitHub', { type: 'ocr_contains', value: 'Sign in' })).toBe('Sign in');
    for (const name of ['Resume', 'End task', 'Something else', 'Send']) {
      expect(promptSatisfies('Sign in', { type: 'element_exists', name })).toBe(name);
    }
    expect(promptSatisfies('Sign in', { type: 'element_value_contains', name: 'resume', value: 'x' })).toBe('resume');
    expect(promptSatisfies('Sign in', { type: 'element_exists', name: 'Dashboard' })).toBeNull();
    expect(promptSatisfies('Sign in', { type: 'window_title_contains', value: 'Resume' } as never)).toBeNull();
  });

  it('an element of the pill is never evidence for element_exists', async () => {
    setOwnUiPids(() => [4242]);
    const adapter = { findElements: async () => [{ name: 'Resume', controlType: 'Button', processId: 4242, bounds: { x: 0, y: 0, width: 1, height: 1 } }] } as unknown as PlatformAdapter;
    const report = await checkAssertions([{ type: 'element_exists', name: 'Resume' }], { adapter });
    expect(report.ok).toBe(false);
  });
});
