/**
 * Control banner (2026-06-12 feature): the on-screen "desktop control in
 * progress" indicator. Contract under test:
 *   - pin/unpin (autonomous task lifecycle) shows/hides exactly one child
 *   - touch (external MCP activity) shows + auto-hides after the idle window
 *   - touch while pinned never schedules a hide
 *   - BANNER_STOP on the child's stdout fires onStopRequested
 *   - disabled state spawns nothing
 *   - the edge glow (2026-06-14) rides the same lifecycle as the pill, can be
 *     disabled independently (CLAWD_NO_GLOW), and dies with the pill
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { controlBanner } from '../core/banner';
import { stopControl, __setControlDirForTests } from '../core/control';
import type { ChildProcess } from 'child_process';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0);
    return true;
  }
}

let spawned: FakeChild[];      // pill processes
let glowSpawned: FakeChild[];  // edge-glow processes

beforeEach(() => {
  vi.useFakeTimers();
  spawned = [];
  glowSpawned = [];
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => {
    const c = new FakeChild();
    spawned.push(c);
    return c as unknown as ChildProcess;
  });
  controlBanner.__setGlowSpawnerForTests(() => {
    const c = new FakeChild();
    glowSpawned.push(c);
    return c as unknown as ChildProcess;
  });
});

afterEach(() => {
  controlBanner.__resetForTests();
  vi.useRealTimers();
});

describe('controlBanner', () => {
  it('pin shows exactly one pill + one glow; repeated pins are idempotent; unpin kills both', () => {
    controlBanner.pin();
    controlBanner.pin();
    expect(spawned.length).toBe(1);
    expect(glowSpawned.length).toBe(1);
    expect(controlBanner.isVisible()).toBe(true);
    controlBanner.unpin();
    expect(spawned[0].killed).toBe(true);
    expect(glowSpawned[0].killed).toBe(true);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('touch shows and auto-hides after the idle window', () => {
    controlBanner.touch(30_000);
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(controlBanner.isVisible()).toBe(false);
    expect(spawned[0].killed).toBe(true);
  });

  it('repeated touches keep resetting the idle window', () => {
    controlBanner.touch(30_000);
    vi.advanceTimersByTime(25_000);
    controlBanner.touch(30_000);          // activity continues
    vi.advanceTimersByTime(25_000);       // 50s total, but only 25s since last touch
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(5_001);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('a call in flight keeps the pill up past the idle window; the countdown starts when it returns (#294)', () => {
    controlBanner.touch(30_000);
    const release = controlBanner.hold();   // a batch inside a 30 s wait
    vi.advanceTimersByTime(45_000);
    expect(controlBanner.isVisible()).toBe(true);
    release();
    vi.advanceTimersByTime(29_000);
    expect(controlBanner.isVisible()).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('hold shows nothing by itself: a read-only call does not bring the pill up', () => {
    const release = controlBanner.hold();
    expect(controlBanner.isVisible()).toBe(false);
    release();
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('after a stop, a touch or pin does not bring the pill back (#294)', () => {
    stopControl('pill');
    try {
      controlBanner.touch();
      controlBanner.pin();
      expect(controlBanner.isVisible()).toBe(false);
    } finally {
      __setControlDirForTests(null);
    }
  });

  it('touch while pinned never hides — the task lifecycle owns visibility', () => {
    controlBanner.pin();
    controlBanner.touch(1_000);
    vi.advanceTimersByTime(60_000);
    expect(controlBanner.isVisible()).toBe(true);
    controlBanner.unpin();
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('BANNER_STOP from the child fires onStopRequested (the kill switch)', () => {
    const onStop = vi.fn();
    controlBanner.configure({ onStopRequested: onStop });
    controlBanner.pin();
    spawned[0].stdout.write('BANNER_STOP\n');
    // readline delivers on the next tick of the stream — flush microtasks.
    return new Promise<void>(resolve => {
      setImmediate(() => {
        expect(onStop).toHaveBeenCalledTimes(1);
        resolve();
      });
      vi.advanceTimersByTime(0);
    });
  });

  it('spawns nothing when disabled', () => {
    controlBanner.setEnabled(false);
    controlBanner.pin();
    controlBanner.touch();
    expect(spawned.length).toBe(0);
    expect(glowSpawned.length).toBe(0);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('child exiting on its own clears visibility (no zombie handle)', () => {
    controlBanner.pin();
    spawned[0].emit('exit', 0);
    expect(controlBanner.isVisible()).toBe(false);
  });

  it('CLAWD_NO_GLOW disables the glow but keeps the pill (and its stop affordance)', () => {
    controlBanner.__setGlowEnabledForTests(false);
    controlBanner.pin();
    expect(spawned.length).toBe(1);      // pill still shows
    expect(glowSpawned.length).toBe(0);  // glow suppressed
    expect(controlBanner.isVisible()).toBe(true);
  });

  it('when the pill exits, the glow is torn down too (never desync)', () => {
    controlBanner.pin();
    expect(glowSpawned.length).toBe(1);
    spawned[0].emit('exit', 0);          // pill dies on its own
    expect(glowSpawned[0].killed).toBe(true);
  });

  it('on a non-Windows platform nothing spawns — pill OR glow (OS-safe no-op)', () => {
    controlBanner.__setPlatformEnabledForTests(false); // simulate macOS/Linux runtime
    controlBanner.pin();
    controlBanner.touch();
    expect(spawned.length).toBe(0);
    expect(glowSpawned.length).toBe(0);
    expect(controlBanner.isVisible()).toBe(false);
  });
});
