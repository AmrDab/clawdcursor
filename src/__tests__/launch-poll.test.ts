/**
 * Tests for the shared diff-and-poll launch helper.
 *
 * Goal: prove the helper behaves correctly across the situations every
 * platform adapter hits — fast warm activation, slow cold start, stuck
 * launches, and the macOS-style "activate existing app" pattern. All tests
 * use fake `listWindows` callbacks so no OS interaction occurs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  waitForLaunchedWindow,
  buildAppPredicate,
} from '../platform/launch-poll';
import type { WindowInfo } from '../platform/types';

function w(opts: Partial<WindowInfo> & { processId: number; title?: string; processName?: string }): WindowInfo {
  return {
    title: opts.title ?? '',
    processName: opts.processName ?? '',
    processId: opts.processId,
    bounds: opts.bounds ?? { x: 0, y: 0, width: 100, height: 100 },
    isMinimized: opts.isMinimized ?? false,
    handle: opts.handle ?? opts.processId,
  };
}

describe('buildAppPredicate', () => {
  it('matches by exact processName', () => {
    const p = buildAppPredicate('Notepad');
    expect(p(w({ processId: 1, processName: 'notepad' }))).toBe(true);
  });

  it('matches by processName substring', () => {
    const p = buildAppPredicate('Outlook');
    expect(p(w({ processId: 1, processName: 'olk', title: 'Mail - Outlook' }))).toBe(true);
  });

  it('matches by title substring when processName misses', () => {
    const p = buildAppPredicate('Calculator');
    expect(p(w({ processId: 1, processName: 'ApplicationFrameHost', title: 'Calculator' }))).toBe(true);
  });

  it('rejects unrelated windows', () => {
    const p = buildAppPredicate('Notepad');
    expect(p(w({ processId: 1, processName: 'chrome', title: 'GitHub' }))).toBe(false);
  });

  it('returns false predicate when name is empty / whitespace', () => {
    const p = buildAppPredicate('   ');
    expect(p(w({ processId: 1, processName: 'anything', title: 'anything' }))).toBe(false);
  });

  it('is case-insensitive', () => {
    const p = buildAppPredicate('NOTEPAD');
    expect(p(w({ processId: 1, processName: 'Notepad' }))).toBe(true);
  });

  it('strips .exe so launchName "msedge.exe" matches processName "msedge"', () => {
    const p = buildAppPredicate('msedge.exe');
    expect(p(w({ processId: 1, processName: 'msedge' }))).toBe(true);
    // Also accepts a title-bar match (Edge titles tabs as "… - Microsoft Edge")
    expect(p(w({ processId: 2, processName: 'ApplicationFrameHost', title: 'Bing - Microsoft Edge' }))).toBe(false);
    // (title "Bing - Microsoft Edge" doesn't contain literal "msedge"; that's
    //  fine — the alias predicate is for executable-name match. Title-only
    //  matches go through the alias's searchTerm, handled elsewhere.)
  });

  it('strips .app so launchName "Calculator.app" matches processName "Calculator"', () => {
    const p = buildAppPredicate('Calculator.app');
    expect(p(w({ processId: 1, processName: 'Calculator' }))).toBe(true);
  });

  it('uses 3-char minimum on processName for reverse-contains to avoid false positives', () => {
    // Tiny processName like "ai" or "ps" should NOT sweep up unrelated launches.
    const p = buildAppPredicate('msedge.exe');
    expect(p(w({ processId: 1, processName: 'ai', title: 'something' }))).toBe(false);
    expect(p(w({ processId: 2, processName: 'ps', title: 'something' }))).toBe(false);
  });
});

describe('waitForLaunchedWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Live (Ubuntu, xcalc): the new window had no _NET_WM_PID (pid 0) and a
  // title ("Calculator") that does not contain the launch name, so open_app
  // waited 8 s and said "no window yet" while the window was on screen.
  it('accepts a NEW window with no owning pid when nothing else matches', async () => {
    const before: WindowInfo[] = [w({ processId: 5, processName: 'gnome-calculator', title: 'Calculator', handle: 'h-5' })];
    const after: WindowInfo[] = [...before, w({ processId: 0, title: 'Calculator', handle: 'h-xcalc' })];
    const p = waitForLaunchedWindow(before, async () => after, buildAppPredicate('xcalc'), { intervalMs: 100, timeoutMs: 5_000, spawnPid: 77 });
    await vi.advanceTimersByTimeAsync(150);
    expect((await p)?.handle).toBe('h-xcalc');
  });

  it('does NOT adopt a pid-less window when two appeared, or when nothing was spawned', async () => {
    const two: WindowInfo[] = [w({ processId: 0, title: 'Calculator', handle: 'h-a' }), w({ processId: 0, title: 'Notification', handle: 'h-b' })];
    const p1 = waitForLaunchedWindow([], async () => two, buildAppPredicate('xcalc'), { intervalMs: 100, timeoutMs: 300, spawnPid: 77 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await p1).toBeNull();

    const one: WindowInfo[] = [w({ processId: 0, title: 'Some popup', handle: 'h-pop' })];
    const p2 = waitForLaunchedWindow([], async () => one, buildAppPredicate('xcalc'), { intervalMs: 100, timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(400);
    expect(await p2).toBeNull();
  });

  it('a predicate match still beats an unowned new window', async () => {
    const after: WindowInfo[] = [
      w({ processId: 0, title: 'Some popup', handle: 'h-pop' }),
      w({ processId: 9, processName: 'xcalc', title: 'Calculator', handle: 'h-9' }),
    ];
    const p = waitForLaunchedWindow([], async () => after, buildAppPredicate('xcalc'), { intervalMs: 100, timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(150);
    expect((await p)?.handle).toBe('h-9');
  });

  it('returns a NEW window appearing on the first tick', async () => {
    const before: WindowInfo[] = [w({ processId: 1, processName: 'chrome', handle: 'h-1' })];
    const after: WindowInfo[] = [
      ...before,
      w({ processId: 99, processName: 'notepad', title: 'Untitled - Notepad', handle: 'h-99' }),
    ];

    const list = vi.fn(async () => after);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('notepad'),
      { intervalMs: 100, timeoutMs: 5_000 },
    );

    await vi.advanceTimersByTimeAsync(150);
    const result = await p;

    expect(result?.processId).toBe(99);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while the window has not surfaced yet', async () => {
    const before: WindowInfo[] = [];
    const sequence: WindowInfo[][] = [
      [], // tick 1: nothing
      [], // tick 2: still nothing (cold UWP)
      [w({ processId: 42, processName: 'CalculatorApp', title: '' })], // tick 3: surfaced
    ];

    const list = vi.fn(async () => sequence.shift() ?? []);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('Calculator'),
      { intervalMs: 100, timeoutMs: 5_000 },
    );

    await vi.advanceTimersByTimeAsync(450);
    const result = await p;

    expect(result?.processId).toBe(42);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('prefers spawnPid match over predicate match', async () => {
    const before: WindowInfo[] = [];
    const after: WindowInfo[] = [
      // Predicate would match this title-bearing window first…
      w({ processId: 50, processName: 'firefox', title: 'My Firefox' }),
      // …but the spawn produced PID 77, which we should win on.
      w({ processId: 77, processName: '', title: '' }),
    ];

    const list = vi.fn(async () => after);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('firefox'),
      { intervalMs: 100, timeoutMs: 5_000, spawnPid: 77 },
    );

    await vi.advanceTimersByTimeAsync(150);
    const result = await p;

    expect(result?.processId).toBe(77);
  });

  it('returns null when the deadline elapses with no match', async () => {
    const before: WindowInfo[] = [w({ processId: 1, processName: 'bash', handle: 'h-1' })];
    const list = vi.fn(async () => before);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('does-not-exist'),
      { intervalMs: 100, timeoutMs: 500 },
    );

    await vi.advanceTimersByTimeAsync(800);
    const result = await p;

    expect(result).toBeNull();
    // 5 ticks @ 100ms — bounded
    expect(list.mock.calls.length).toBeGreaterThan(2);
  });

  it('falls back to "best-existing-match" at deadline (macOS open -a activate case)', async () => {
    // App was running but minimized when we snapshotted; "open -a Notes"
    // restored it to the same handle. We never see a NEW window — but the
    // helper should still surface the matching window via the deadline
    // fallback so the caller gets a useful pid/title.
    const minimized = w({ processId: 5, processName: 'Notes', handle: 'h-5', isMinimized: true });
    const restored = w({ processId: 5, processName: 'Notes', title: 'Notes', handle: 'h-5', isMinimized: false });

    const before: WindowInfo[] = [minimized];
    const list = vi.fn(async () => [restored]);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('Notes'),
      { intervalMs: 100, timeoutMs: 500 },
    );

    await vi.advanceTimersByTimeAsync(800);
    const result = await p;

    expect(result?.processId).toBe(5);
    expect(result?.title).toBe('Notes');
  });

  it('skips minimized new windows when picking a fresh match', async () => {
    // Some launchers create a hidden window first. Don't return it.
    const before: WindowInfo[] = [];
    const sequence: WindowInfo[][] = [
      [w({ processId: 70, processName: 'notepad', isMinimized: true })],
      [
        w({ processId: 70, processName: 'notepad', isMinimized: true }),
        w({ processId: 71, processName: 'notepad', title: 'Untitled - Notepad', isMinimized: false }),
      ],
    ];
    const list = vi.fn(async () => sequence.shift() ?? []);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('notepad'),
      { intervalMs: 100, timeoutMs: 5_000 },
    );

    await vi.advanceTimersByTimeAsync(300);
    const result = await p;

    expect(result?.processId).toBe(71);
  });

  it('survives a transient listWindows() exception', async () => {
    const before: WindowInfo[] = [];
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('uia bridge hiccup');
      return [w({ processId: 9, processName: 'paint', title: 'Paint' })];
    });

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('paint'),
      { intervalMs: 100, timeoutMs: 5_000 },
    );

    await vi.advanceTimersByTimeAsync(300);
    const result = await p;

    expect(result?.processId).toBe(9);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('uses default 8s budget and 300ms interval when opts omitted', async () => {
    const before: WindowInfo[] = [];
    const list = vi.fn(async () => []);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('never'),
      // No opts — should use defaults.
    );

    // After 1500ms we should have ~5 polls (300ms tick), nowhere near deadline.
    await vi.advanceTimersByTimeAsync(1500);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(list.mock.calls.length).toBeLessThanOrEqual(6);

    // Drain the rest of the budget.
    await vi.advanceTimersByTimeAsync(8_500);
    const result = await p;
    expect(result).toBeNull();
  });

  it('clamps interval to a 50ms minimum', async () => {
    const before: WindowInfo[] = [];
    const list = vi.fn(async () => []);

    const p = waitForLaunchedWindow(
      before,
      list,
      buildAppPredicate('never'),
      { intervalMs: 1, timeoutMs: 200 },
    );

    // Even with intervalMs=1 (effectively spam), we clamp to >=50ms so we
    // don't peg the bridge. Across 200ms total we should see 3-5 polls.
    await vi.advanceTimersByTimeAsync(250);
    const result = await p;
    expect(result).toBeNull();
    expect(list.mock.calls.length).toBeLessThanOrEqual(5);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
