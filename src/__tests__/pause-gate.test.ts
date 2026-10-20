/**
 * Pause gate + the banner's paused form (pause-for-user feature).
 * Contract under test:
 *   - a pause swaps both overlays to the paused form (spawners get the pause),
 *     an answer line from the pill settles it, and the running form comes back
 *   - resume → resumed, end → ended
 *   - same key re-attaches to the pending pause; the outcome is handed over
 *     once ONLY to a caller that was told "waiting"; forget() drops it
 *   - a pill answers only the pause it was drawn for (even after it exited)
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

  it('"Something else": the pill sends the typed text and the pause settles as replied, with it', async () => {
    const p = pauseGate.requestWithReply({ message: 'Sign in to Stripe' });
    const text = 'Use the test account instead — café ✓\nthen continue';
    say(`BANNER_REPLY ${Buffer.from(text, 'utf8').toString('base64')}`);
    await expect(p).resolves.toEqual({ outcome: 'replied', reply: text });
    expect(pauseGate.current()).toBeNull();
  });

  it('request() (outcome only) reports "replied" too', async () => {
    const p = pauseGate.request({ message: 'Sign in' });
    say(`BANNER_REPLY ${Buffer.from('no, skip it', 'utf8').toString('base64')}`);
    await expect(p).resolves.toBe('replied');
  });

  it('an empty or garbled reply line does not settle the pause; a typed "BANNER_END" is just text', async () => {
    const p = pauseGate.requestWithReply({ message: 'Sign in' });
    say('BANNER_REPLY ');                                   // empty
    say('BANNER_REPLY !!!not-base64');                      // not base64 → ignored
    await flush();
    expect(pauseGate.current()?.message).toBe('Sign in');
    expect(pauseGate.answer('reply', 'user', '   ')).toEqual({ ok: false, error: 'the reply is empty' });
    say(`BANNER_REPLY ${Buffer.from('BANNER_END', 'utf8').toString('base64')}`);
    await expect(p).resolves.toEqual({ outcome: 'replied', reply: 'BANNER_END' });
  });

  it('a reply is capped and stripped of control characters (newlines and tabs kept)', async () => {
    const p = pauseGate.requestWithReply({ message: 'x' });
    pauseGate.answer('reply', 'user', `a\u0000b\tc\nd${'z'.repeat(5000)}`);
    const r = await p;
    expect(r.reply?.startsWith('a b\tc\nd')).toBe(true);
    expect(r.reply?.length).toBe(2000);
  });

  describe('Esc in the reply box gives the keyboard back to the user\'s window (the Linux pill asks; the Windows pill refocuses natively)', () => {
    const focused: Array<{ processId: number; title?: string }> = [];
    beforeEach(() => {
      focused.length = 0;
      pauseGate.__setFocusTrackerForTests({
        capture: async () => ({ processId: 42, title: 'Report.txt' }),
        focus: async t => { focused.push(t); },
      });
    });
    afterEach(() => { pauseGate.__setFocusTrackerForTests(null); });

    it('the pill names the app (macOS): that app, with its window title when it is the one the pause began in', async () => {
      const p = pauseGate.request({ message: 'Sign in' });
      await flush();
      say('BANNER_REFOCUS 42');
      await flush();
      expect(focused).toEqual([{ processId: 42, title: 'Report.txt' }]);
      expect(pauseGate.current()?.message).toBe('Sign in');      // Esc is not an answer
      pauseGate.answer('resume');
      await p;
    });

    it('another app than the one the pause began in: that app, without a title', async () => {
      const p = pauseGate.request({ message: 'Sign in' });
      await flush();
      say('BANNER_REFOCUS 77');
      await flush();
      expect(focused).toEqual([{ processId: 77, title: undefined }]);
      pauseGate.answer('end');
      await p;
    });

    it('no app named (Linux): the window active when the pause began', async () => {
      const p = pauseGate.request({ message: 'Sign in' });
      await flush();
      say('BANNER_REFOCUS');
      await flush();
      expect(focused).toEqual([{ processId: 42, title: 'Report.txt' }]);
      pauseGate.answer('resume');
      await p;
    });

    it('a pill from an earlier pause cannot move the focus', async () => {
      const p1 = pauseGate.request({ message: 'one' });
      const oldPill = livePill()[0].child;
      pauseGate.answer('resume');
      await p1;
      const p2 = pauseGate.request({ message: 'two' });
      await flush();
      oldPill.stdout.write('BANNER_REFOCUS 42\n');
      await flush();
      expect(focused).toEqual([]);
      pauseGate.answer('resume');
      await p2;
    });
  });

  it('a pill from an EARLIER pause cannot answer a newer one', async () => {
    const p1 = pauseGate.request({ message: 'one' });
    const oldPill = livePill()[0].child;
    pauseGate.answer('resume');
    await expect(p1).resolves.toBe('resumed');
    const p2 = pauseGate.request({ message: 'two' });
    oldPill.stdout.write('BANNER_RESUME\n');       // late line from the first pause's pill
    await flush();
    expect(pauseGate.current()?.message).toBe('two');
    say('BANNER_RESUME');
    await expect(p2).resolves.toBe('resumed');
  });

  it('an answer still counts when the pill already exited (stdout drains after exit)', async () => {
    const p = pauseGate.request({ message: 'Sign in' });
    const pill = livePill()[0].child;
    pill.emit('exit', 0);                              // exit observed first…
    pill.stdout.write('BANNER_RESUME\n');             // …then the buffered line
    await expect(p).resolves.toBe('resumed');
  });

  it('control characters in the message are stripped (a NUL would break the spawn)', async () => {
    const p = pauseGate.request({ message: 'Sign\u0000 in\u0007 now' });
    expect(pauseGate.current()?.message).toBe('Sign in now');
    pauseGate.answer('end');
    await p;
  });

  it('same key re-attaches; an outcome the caller missed is handed over once; forget() drops it', async () => {
    const a = pauseGate.request({ message: 'Enter the 2FA code', key: 'k1' });
    const b = pauseGate.request({ message: 'Enter the 2FA code', key: 'k1' });
    expect(livePill().length).toBe(1);
    pauseGate.markWaiting('k1');                       // the caller was told "waiting"
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

  it('an outcome is never reused for a NEW pause unless its caller was told "waiting"', async () => {
    const first = pauseGate.request({ message: 'Sign in, then click Resume', key: 'k2' });
    pauseGate.answer('resume');
    await first;                                      // delivered directly — no hand-over
    const second = pauseGate.request({ message: 'Sign in, then click Resume', key: 'k2' });
    expect(pauseGate.current()?.message).toBe('Sign in, then click Resume');   // asks again
    pauseGate.answer('end');
    await expect(second).resolves.toBe('ended');
  });

  it('a same-key call queued behind another pause re-attaches instead of prompting twice', async () => {
    const other = pauseGate.request({ message: 'agent pause' });
    const a = pauseGate.request({ message: 'Enter the code', key: 'k3' });
    const b = pauseGate.request({ message: 'Enter the code', key: 'k3' });
    await flush();
    pauseGate.answer('resume');                       // ends the agent's pause
    await other;
    await flush();
    expect(pauseGate.current()?.message).toBe('Enter the code');
    pauseGate.answer('resume');
    await expect(a).resolves.toBe('resumed');
    await expect(b).resolves.toBe('resumed');
    expect(pauseGate.current()).toBeNull();           // not shown a second time
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
