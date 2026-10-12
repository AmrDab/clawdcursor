/**
 * Pause gate + the banner's paused form (pause-for-user feature).
 * Contract under test:
 *   - a pause swaps both overlays to the paused form (spawners get the pause),
 *     an answer line from the pill settles it, and the running form comes back
 *   - resume → resumed, end → ended
 *   - same key re-attaches to the pending pause; a keyed outcome the caller
 *     missed is handed over once; forget() drops it
 *   - abort signal → ended; no answer within CLAWD_PAUSE_TIMEOUT_MIN → timeout
 *   - one pause at a time: a second request waits for the first
 *   - unavailable when the overlay can't show or CLAWD_NO_PAUSE=1
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { controlBanner, type OverlayMode } from '../core/banner';
import { pauseGate } from '../core/pause-gate';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
}

let pills: Array<{ child: FakeChild; mode: OverlayMode }>;
let glows: Array<{ child: FakeChild; mode: OverlayMode }>;
const livePill = () => pills.filter(p => !p.child.killed);
const say = (line: string) => livePill().slice(-1)[0].child.stdout.write(line + '\n');
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  pills = [];
  glows = [];
  delete process.env.CLAWD_NO_PAUSE;
  delete process.env.CLAWD_PAUSE_TIMEOUT_MIN;
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(mode => { const c = new FakeChild(); pills.push({ child: c, mode }); return c as unknown as ChildProcess; });
  controlBanner.__setGlowSpawnerForTests(mode => { const c = new FakeChild(); glows.push({ child: c, mode }); return c as unknown as ChildProcess; });
});

afterEach(() => {
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  process.env.CLAWD_NO_PAUSE = '1';
  delete process.env.CLAWD_PAUSE_TIMEOUT_MIN;
  vi.useRealTimers();
});

describe('pauseGate', () => {
  it('is available only when the overlay can show and CLAWD_NO_PAUSE is not set', () => {
    expect(pauseGate.available()).toBe(true);
    process.env.CLAWD_NO_PAUSE = '1';
    expect(pauseGate.available()).toBe(false);
    delete process.env.CLAWD_NO_PAUSE;
    controlBanner.__setPlatformEnabledForTests(false);
    expect(pauseGate.available()).toBe(false);
  });

  it('switches the running overlay to the paused form, and back after Resume', async () => {
    controlBanner.pin();
    expect(pills[0].mode.paused).toBeUndefined();

    const p = pauseGate.request({ message: '  Sign in to GitHub,\n then click Resume ' });
    expect(pills[0].child.killed).toBe(true);                 // running pill replaced
    const paused = livePill()[0];
    expect(paused.mode.paused?.message).toBe('Sign in to GitHub, then click Resume');
    expect(glows.filter(g => !g.child.killed)[0].mode.paused?.message).toBe('Sign in to GitHub, then click Resume');
    expect(pauseGate.current()?.message).toBe('Sign in to GitHub, then click Resume');

    say('BANNER_RESUME');
    await expect(p).resolves.toBe('resumed');
    expect(pauseGate.current()).toBeNull();
    const back = livePill();
    expect(back.length).toBe(1);
    expect(back[0].mode.paused).toBeUndefined();               // amber running form again (still pinned)
  });

  it('End task ends it', async () => {
    const p = pauseGate.request({ message: 'Solve the CAPTCHA' });
    say('BANNER_END');
    await expect(p).resolves.toBe('ended');
  });

  it('a line from a replaced (stale) pill cannot answer', async () => {
    const p = pauseGate.request({ message: 'one' });
    const first = livePill()[0].child;
    controlBanner.showPaused(pauseGate.current()!, a => { pauseGate.answer(a); }); // respawn
    first.stdout.write('BANNER_RESUME\n');
    await flush();
    expect(pauseGate.current()).not.toBeNull();
    say('BANNER_RESUME');
    await expect(p).resolves.toBe('resumed');
  });

  it('same key re-attaches; an outcome the caller missed is handed over once; forget() drops it', async () => {
    const a = pauseGate.request({ message: 'Enter the 2FA code', key: 'k1' });
    const b = pauseGate.request({ message: 'Enter the 2FA code', key: 'k1' });
    expect(livePill().length).toBe(1);
    pauseGate.answer('resume');
    await expect(a).resolves.toBe('resumed');
    await expect(b).resolves.toBe('resumed');

    // the caller re-calls after the answer → handed over, once
    await expect(pauseGate.request({ message: 'x', key: 'k1' })).resolves.toBe('resumed');
    const again = pauseGate.request({ message: 'x', key: 'k1' });
    expect(pauseGate.current()).not.toBeNull();                 // asks again
    pauseGate.answer('end');
    await again;

    pauseGate.forget('k1');
    const fresh = pauseGate.request({ message: 'y', key: 'k1' });
    expect(pauseGate.current()?.message).toBe('y');             // forgotten → a real new pause
    pauseGate.answer('end');
    await expect(fresh).resolves.toBe('ended');
  });

  it('an abort signal ends the pause', async () => {
    const ctl = new AbortController();
    const p = pauseGate.request({ message: 'Sign in' }, { signal: ctl.signal });
    ctl.abort();
    await expect(p).resolves.toBe('ended');
    expect(pauseGate.current()).toBeNull();
  });

  it('times out after CLAWD_PAUSE_TIMEOUT_MIN', async () => {
    vi.useFakeTimers();
    process.env.CLAWD_PAUSE_TIMEOUT_MIN = '2';
    const p = pauseGate.request({ message: 'Sign in' });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(pauseGate.current()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe('timeout');
  });

  it('one pause at a time: a second request waits for the first', async () => {
    const first = pauseGate.request({ message: 'first' });
    const second = pauseGate.request({ message: 'second' });
    await flush();
    expect(pauseGate.current()?.message).toBe('first');
    pauseGate.answer('resume');
    await expect(first).resolves.toBe('resumed');
    await flush();
    expect(pauseGate.current()?.message).toBe('second');
    pauseGate.answer('end');
    await expect(second).resolves.toBe('ended');
  });

  it('answering with nothing paused is a clear error', () => {
    expect(pauseGate.answer('resume')).toEqual({ ok: false, error: 'nothing is paused' });
  });
});

describe('controlBanner paused form', () => {
  it('stays up through idle timers and unpin while paused', async () => {
    vi.useFakeTimers();
    controlBanner.touch(1_000);
    const p = pauseGate.request({ message: 'Sign in' });
    vi.advanceTimersByTime(5_000);
    controlBanner.unpin();
    expect(livePill().length).toBe(1);
    expect(livePill()[0].mode.paused).toBeDefined();
    pauseGate.answer('resume');
    await p;
    expect(livePill()[0].mode.paused).toBeUndefined();          // running form for the idle window
    vi.advanceTimersByTime(31_000);
    expect(livePill().length).toBe(0);                          // then the normal idle hide
  });

  it('BANNER_STOP in running mode still calls the stop flow', async () => {
    const stop = vi.fn();
    controlBanner.configure({ onStopRequested: stop });
    controlBanner.pin();
    say('BANNER_STOP');
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
