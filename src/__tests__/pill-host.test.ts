/**
 * A host app draws the pill itself (docs/pill-host.md). Contract under test:
 *   - CLAWD_PILL_CMD (a JSON array argv) is spawned in place of the built-in pill, with the same args, env and stdio
 *   - a bad value, a spawn error or a pill that exits at once falls back to the built-in pill, with one warning
 *   - with nothing set, the built-in pill is spawned as before
 *   - CLAWD_OWN_UI_PIDS names processes that count as clawdcursor's own on-screen UI
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async () => ({ ...(await vi.importActual<typeof import('child_process')>('child_process')), spawn: spawnMock }));

import { controlBanner, parsePillCmd, hostUiPids, pillArgs } from '../core/banner';
import { ownUiRefusal } from '../core/own-ui-guard';
import { isOwnUiPid } from '../platform/pointer-guard';
import { logger } from '../core/observability/logger';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
}

const HOST = ['/opt/host/node', '/opt/host/pill-host.mjs', '--flag'];
type Call = { cmd: string; args: string[]; opts: { stdio: unknown; env: NodeJS.ProcessEnv }; child: FakeChild };
let calls: Call[];
let outlines: FakeChild[];
let warn: ReturnType<typeof vi.spyOn>;
const hostCalls = () => calls.filter(c => c.cmd === HOST[0]);
const builtInCalls = () => calls.filter(c => c.cmd !== HOST[0]);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  outlines = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation((cmd: string, args: string[], opts: Call['opts']) => {
    const child = new FakeChild();
    calls.push({ cmd, args, opts, child });
    return child;
  });
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  delete process.env.CLAWD_PILL_CMD;
  delete process.env.CLAWD_OWN_UI_PIDS;
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setOutlineSpawnerForTests(() => {
    const c = new FakeChild();
    outlines.push(c);
    return c as unknown as ChildProcess;
  });
});

afterEach(() => {
  controlBanner.__resetForTests();
  delete process.env.CLAWD_PILL_CMD;
  delete process.env.CLAWD_OWN_UI_PIDS;
  warn.mockRestore();
  vi.useRealTimers();
});

describe('CLAWD_PILL_CMD parsing', () => {
  it('a JSON array of strings is the argv', () => {
    expect(parsePillCmd('["C:\\\\node.exe","C:\\\\path\\\\pill-host.mjs"]')).toEqual(['C:\\node.exe', 'C:\\path\\pill-host.mjs']);
    expect(parsePillCmd('["pill"]')).toEqual(['pill']);
  });

  it('anything else is no command', () => {
    for (const bad of [undefined, '', 'node pill.mjs', '{"cmd":"node"}', '[]', '["node", 3]', '[""]', '"node"', '[null]']) {
      expect(parsePillCmd(bad)).toBeNull();
    }
  });
});

describe('the pill drawn by a host app', () => {
  it('spawns the host command with the pill\'s args, env and stdio; the outline stays built-in', () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    controlBanner.setActivity('Typing in Edge');
    controlBanner.pin();
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe(HOST[0]);
    expect(calls[0].args).toEqual([...HOST.slice(1), ...pillArgs({})]);
    expect(calls[0].opts.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(calls[0].opts.env.CLAWD_BANNER_ACTIVITY).toBe('running in background · Typing in Edge');
    expect(calls[0].opts.env.CLAWD_BANNER_MODE).toBeUndefined();
    expect(outlines.length).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the paused form gets --paused and the card in its env, and its answer settles the pause', () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    const answers: unknown[][] = [];
    controlBanner.showPaused(
      { id: 7, message: 'Sign in', since: 0, choices: ['Yes', 'No'], input: { placeholder: 'Why?' } } as never,
      (...a) => { answers.push(a); },
    );
    expect(calls[0].args).toEqual([...HOST.slice(1), '--paused']);
    expect(calls[0].opts.env).toMatchObject({
      CLAWD_BANNER_MODE: 'paused',
      CLAWD_BANNER_MESSAGE: 'The agent says: Sign in',
      CLAWD_BANNER_CHOICES: '["Yes","No"]',
      CLAWD_BANNER_INPUT: '{"placeholder":"Why?"}',
    });
    calls[0].child.stdout.write('BANNER_CHOICE 1\n');
    return vi.waitFor(() => expect(answers).toEqual([['choice', undefined, 1]]));
  });

  it('speaks the same lines: ACTIVITY and HIDE on stdin, BANNER_STOP on stdout', async () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    const stop = vi.fn();
    controlBanner.configure({ onStopRequested: stop });
    controlBanner.pin();
    const written: string[] = [];
    calls[0].child.stdin.on('data', d => written.push(...String(d).split('\n').filter(Boolean)));
    controlBanner.setActivity('Clicking in Edge');
    const dodged = controlBanner.dodge(1500);
    await vi.advanceTimersByTimeAsync(100);
    await dodged;
    expect(written).toEqual(['ACTIVITY running in background · Clicking in Edge', 'HIDE 1500']);
    calls[0].child.stdout.write('BANNER_STOP\n');
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('with nothing set, the built-in pill is spawned as before', () => {
    controlBanner.pin();
    expect(calls.length).toBe(1);
    expect(hostCalls().length).toBe(0);
    if (process.platform === 'win32') expect(calls[0].args.join(' ')).toMatch(/banner\.ps1$/);
    else if (process.platform === 'linux') expect(calls[0].args.slice(1)).toEqual(['pill']);   // python3 <script> pill
    else expect(calls[0].args).toEqual(['pill']);
    expect(calls[0].opts.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('falling back to the built-in pill', () => {
  it('a value that is not a JSON array of strings: the built-in pill, and one warning', () => {
    process.env.CLAWD_PILL_CMD = 'node pill-host.mjs';
    controlBanner.pin();
    controlBanner.unpin();
    controlBanner.pin();
    expect(hostCalls().length).toBe(0);
    expect(builtInCalls().length).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a spawn that throws', () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    spawnMock.mockImplementationOnce(() => { throw new Error('EINVAL'); });
    controlBanner.pin();
    expect(calls.length).toBe(1);
    expect(builtInCalls().length).toBe(1);
    expect(controlBanner.isVisible()).toBe(true);
    expect(outlines.length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a spawn error (no such file): the built-in pill takes its place, the outline stays', () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    controlBanner.pin();
    calls[0].child.emit('error', new Error('ENOENT'));
    expect(builtInCalls().length).toBe(1);
    expect(controlBanner.isVisible()).toBe(true);
    expect(outlines.length).toBe(1);
    expect(outlines[0].killed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a host pill that exits at once without a word; later pills are built-in too, with no second warning', () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    controlBanner.pin();
    vi.advanceTimersByTime(200);
    calls[0].child.emit('exit', 1);
    expect(builtInCalls().length).toBe(1);
    expect(controlBanner.isVisible()).toBe(true);
    controlBanner.unpin();
    controlBanner.pin();
    expect(hostCalls().length).toBe(1);
    expect(builtInCalls().length).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a host pill that ran and then exits is not a failure: the overlay hides, as with the built-in pill', () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    controlBanner.pin();
    vi.advanceTimersByTime(5_000);
    calls[0].child.emit('exit', 0);
    expect(calls.length).toBe(1);
    expect(controlBanner.isVisible()).toBe(false);
    expect(outlines[0].killed).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a paused host pill that answers and exits at once is not a failure', async () => {
    process.env.CLAWD_PILL_CMD = JSON.stringify(HOST);
    const answers: unknown[] = [];
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 } as never, a => { answers.push(a); });
    calls[0].child.stdout.write('BANNER_RESUME\n');
    await vi.waitFor(() => expect(answers).toEqual(['resume']));
    calls[0].child.emit('exit', 0);
    expect(calls.length).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('CLAWD_OWN_UI_PIDS', () => {
  it('reads comma-separated pids and ignores junk', () => {
    expect(hostUiPids('4242, 4243')).toEqual([4242, 4243]);
    expect(hostUiPids('abc,,-5,0,12.5,1e3, 77 ,0x10')).toEqual([77]);
    expect(hostUiPids('')).toEqual([]);
    expect(hostUiPids(undefined)).toEqual([]);
  });

  it('a named pid counts as clawdcursor\'s own UI: refused as a target, and never a window lookup result', () => {
    expect(controlBanner.overlayPids()).toEqual([]);
    expect(ownUiRefusal({ processId: 4242 }, false)).toBeNull();
    expect(isOwnUiPid(4242)).toBe(false);
    process.env.CLAWD_OWN_UI_PIDS = '4242,junk';
    expect(controlBanner.overlayPids()).toEqual([4242]);
    expect(ownUiRefusal({ processId: 4242 }, false)).toMatch(/is clawdcursor's own on-screen control/);
    expect(ownUiRefusal({ pid: '4242' }, false)).toMatch(/is clawdcursor's own on-screen control/);
    expect(ownUiRefusal({ processId: 4243 }, false)).toBeNull();
    expect(isOwnUiPid(4242)).toBe(true);
  });
});
