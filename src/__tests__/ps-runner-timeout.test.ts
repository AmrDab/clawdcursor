/**
 * PSRunner has no request ids: replies are matched to calls purely by order.
 * Before this fix, a command TIMEOUT cleared `current` and sent the next
 * queued command to the SAME bridge process while it was still busy — the
 * bridge's late reply to the timed-out call was then delivered to the WRONG
 * (next) call. Fix: a timeout tears the bridge down and the next call starts
 * a fresh process, so a late reply from the old process can never be routed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { write: vi.fn((_line: string) => true) };
  killed = false;
  kill = vi.fn(() => { this.killed = true; this.emit('exit', null); return true; });
  reply(obj: unknown) { this.stdout.write(JSON.stringify(obj) + '\n'); }
}

const procs: FakeProc[] = [];
vi.mock('child_process', () => ({
  spawn: vi.fn(() => { const p = new FakeProc(); procs.push(p); return p; }),
  execFile: vi.fn(),
}));

// The real PSRunner class (its child process is mocked above), not the global test stub.
vi.unmock('../platform/ps-runner');
import { PSRunner } from '../platform/ps-runner';

const flush = () => new Promise<void>(r => setImmediate(r));

describe('PSRunner — a timed-out command never has its late reply routed to the next call', () => {
  beforeEach(() => {
    procs.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('restarts the bridge after a timeout and ignores the old process\'s late reply', async () => {
    const runner = new PSRunner();

    const p1 = runner.run({ cmd: 'slow' });
    await flush();
    expect(procs).toHaveLength(1);
    procs[0].reply({ ready: true });
    await flush();
    expect(procs[0].stdin.write).toHaveBeenCalledTimes(1);

    // Command 1 times out while the bridge is still working on it.
    vi.advanceTimersByTime(20_000);
    await expect(p1).rejects.toThrow(/timeout/);
    await flush();

    // Command 2 must go to a FRESH bridge, not the still-busy one.
    const p2 = runner.run({ cmd: 'next' });
    await flush();
    expect(procs).toHaveLength(2);
    procs[1].reply({ ready: true });
    await flush();
    expect(procs[1].stdin.write).toHaveBeenCalledTimes(1);

    // The old bridge finally answers command 1 — this must NOT resolve p2.
    procs[0].reply({ late: true, for: 'slow' });
    await flush();
    procs[1].reply({ ok: true, for: 'next' });
    await expect(p2).resolves.toEqual({ ok: true, for: 'next' });
  });
});

// Audit 2026-11-05: every reply with an `error` key was rejected, so a command that ran and failed — an invoke miss
// that carries the element's bounds for a click fallback, a focus refusal with its reason — reached the caller as a
// bare throw, and the agent saw "not found or not actionable".
describe('PSRunner — a command failure is an answer, not a crash', () => {
  beforeEach(() => {
    procs.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('resolves {success:false, error, ...} with its data, and rejects a bridge-level {error}', async () => {
    const runner = new PSRunner();
    const miss = runner.run({ cmd: 'invoke-element' });
    await flush();
    procs[0].reply({ ready: true });
    await flush();
    procs[0].reply({ success: false, error: 'No invoke/toggle/select pattern', bounds: { x: 1, y: 2, width: 3, height: 4 } });
    await expect(miss).resolves.toMatchObject({ success: false, error: 'No invoke/toggle/select pattern', bounds: { x: 1 } });

    const broken = runner.run({ cmd: 'nope' });
    await flush();
    procs[0].reply({ error: 'Unknown command: nope' });
    await expect(broken).rejects.toThrow('Unknown command: nope');
  });
});

// Audit 2026-11-19 (23): the timer started when a command was queued, and a timed-out call stayed in the queue, so a
// command reported as TIMEOUT could still run later and the agent's retry acted twice.
describe('PSRunner — a queued command is timed from its send, and a timed-out one never runs', () => {
  beforeEach(() => {
    procs.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('does not time a command out while it waits behind another, and sends it when its turn comes', async () => {
    const runner = new PSRunner();
    const a = runner.run({ cmd: 'a' });
    await flush();
    procs[0].reply({ ready: true });
    await flush();
    const b = runner.run({ cmd: 'b' });
    await flush();
    expect(procs[0].stdin.write).toHaveBeenCalledTimes(1);   // b is queued behind a

    vi.advanceTimersByTime(15_000);
    procs[0].reply({ ok: 'a' });
    await expect(a).resolves.toEqual({ ok: 'a' });
    await flush();
    expect(procs[0].stdin.write).toHaveBeenCalledTimes(2);   // b sent at t=15s

    vi.advanceTimersByTime(10_000);                          // t=25s: past 20 s from queueing, 10 s from sending
    procs[0].reply({ ok: 'b' });
    await expect(b).resolves.toEqual({ ok: 'b' });
  });

  it('a command that timed out is never written to a bridge afterwards', async () => {
    const runner = new PSRunner();
    const a = runner.run({ cmd: 'a' });
    await flush();
    procs[0].reply({ ready: true });
    await flush();
    const b = runner.run({ cmd: 'invoke' });
    const bResult = b.then(() => 'ran', (e: Error) => e.message);
    await flush();

    vi.advanceTimersByTime(20_000);
    await expect(a).rejects.toThrow(/timeout/);
    expect(await bResult).toMatch(/restarted|timeout/);
    await flush();
    expect(procs[0].stdin.write).toHaveBeenCalledTimes(1);
    expect(procs[0].stdin.write.mock.calls.some(c => String(c[0]).includes('invoke'))).toBe(false);
  });
});
