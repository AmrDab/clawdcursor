/**
 * A thin accessibility tree is often a sleeping one (Electron / Chromium build
 * their page tree on first request). getUiTreeWithWake re-reads once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const exec = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r?: unknown) => void) => { exec.calls.push([cmd, ...args]); cb(null, ''); },
}));

import { getUiTreeWithWake, resetWakeState, wakeAccessibility, SPARSE_TREE_MAX } from '../platform/a11y-wake';

const els = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `e${i}`, controlType: 'Button', bounds: { x: 0, y: 0, width: 1, height: 1 } })) as any[];
function platformWith(...reads: any[][]) {
  const getUiTree = vi.fn(async () => reads[Math.min(getUiTree.mock.calls.length - 1, reads.length - 1)]);
  return { getUiTree, getActiveWindow: vi.fn(async () => ({ processId: 4242 })) } as any;
}

beforeEach(() => { resetWakeState(); exec.calls.length = 0; });

describe('getUiTreeWithWake', () => {
  it('a dense tree is returned as read — no wake, no second read', async () => {
    const p = platformWith(els(SPARSE_TREE_MAX));
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 1 });
    expect(r.woke).toBe(false);
    expect(r.tree).toHaveLength(SPARSE_TREE_MAX);
    expect(p.getUiTree).toHaveBeenCalledTimes(1);
  });

  it('a thin tree is re-read until the page appears (the sleeping-Electron case: 6, 6, 6, then 14)', async () => {
    const p = platformWith(els(6), els(6), els(6), els(14));
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 3, now: () => 0 });   // frozen clock: this counts polls, not time
    expect(r.woke).toBe(true);
    expect(r.tree).toHaveLength(14);
    expect(p.getUiTree).toHaveBeenCalledTimes(4);     // stops as soon as it is dense: no wasted reads
  });

  it('keeps the richest read when the tree grows but never gets dense', async () => {
    const p = platformWith(els(4), els(7), els(5));
    const r = await getUiTreeWithWake(p, 7, { pollMs: 1, budgetMs: 3 });
    expect(r.tree).toHaveLength(7);
    expect(r.woke).toBe(true);
  });

  it('still thin after the whole budget: keeps the first, reports not woken, and stops', async () => {
    const p = platformWith(els(3));
    const r = await getUiTreeWithWake(p, 7, { pollMs: 1, budgetMs: 4, now: () => 0 });   // frozen clock: this counts polls, not time
    expect(r.woke).toBe(false);
    expect(p.getUiTree).toHaveBeenCalledTimes(1 + 4);  // first read + budget/poll polls, no more
  });

  it('slow reads count against the budget (wall-clock): 2 s per read cannot turn a 3 s budget into a 40 s wait', async () => {
    let t = 0;
    const getUiTree = vi.fn(async () => { t += 2000; return els(3); });   // each read costs 2 s of wall-clock (a System Events walk of a Chromium app takes ~10 s)
    const p = { getUiTree, getActiveWindow: vi.fn(async () => ({ processId: 1 })) } as any;
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 3000, now: () => t });
    expect(r.woke).toBe(false);
    // first read, then re-reads starting at +0 s and +2 s of budget; the next would start at +4 s > 3 s → stop (not 3000 polls)
    expect(getUiTree).toHaveBeenCalledTimes(3);
  });

  it('the default wait is about 3 s, not 3 s plus a poll (4 polls of 700 ms)', async () => {
    const polls: number[] = [];
    const p = platformWith(els(3));
    const saved = process.env.CLAWDCURSOR_WAKE_BUDGET_MS;   // the test setup turns the wait off
    delete process.env.CLAWDCURSOR_WAKE_BUDGET_MS;
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => { polls.push(ms ?? 0); return realSetTimeout(fn, 0); }) as never);
    try {
      await getUiTreeWithWake(p, 7);
    } finally {
      vi.restoreAllMocks();
      if (saved !== undefined) process.env.CLAWDCURSOR_WAKE_BUDGET_MS = saved;
    }
    expect(polls.filter(ms => ms === 700)).toHaveLength(4);
  });

  it('CLAWDCURSOR_WAKE_BUDGET_MS=0 turns the wait off', async () => {
    process.env.CLAWDCURSOR_WAKE_BUDGET_MS = '0';
    try {
      const p = platformWith(els(3), els(14));
      const r = await getUiTreeWithWake(p, 7);
      expect(r.woke).toBe(false);
      expect(p.getUiTree).toHaveBeenCalledTimes(1);
    } finally { delete process.env.CLAWDCURSOR_WAKE_BUDGET_MS; }
  });

  it('an app whose process id is unknown is rate-limited too — not made to wait on every read', async () => {
    const p = platformWith(els(2));
    p.getActiveWindow.mockResolvedValue(null);   // no pid anywhere (e.g. Linux without wmctrl / bridge down)
    let t = 5_000_000;
    await getUiTreeWithWake(p, undefined, { pollMs: 1, budgetMs: 2, now: () => t });
    const afterFirst = p.getUiTree.mock.calls.length;
    await getUiTreeWithWake(p, undefined, { pollMs: 1, budgetMs: 2, now: () => (t += 1_000) });
    expect(p.getUiTree.mock.calls.length).toBe(afterFirst + 1);   // one read, no waiting
  });

  it('a genuinely sparse app does not make every later read wait again', async () => {
    const p = platformWith(els(2));
    let t = 1_000_000;
    await getUiTreeWithWake(p, 7, { pollMs: 1, budgetMs: 2, now: () => t });
    const afterFirst = p.getUiTree.mock.calls.length;
    await getUiTreeWithWake(p, 7, { pollMs: 1, budgetMs: 2, now: () => (t += 60_000) });      // 1 min later: still cooling down
    expect(p.getUiTree.mock.calls.length).toBe(afterFirst + 1);                                 // a single read, no waiting
    await getUiTreeWithWake(p, 7, { pollMs: 1, budgetMs: 2, now: () => (t += 10 * 60_000) });  // much later: waits again
    expect(p.getUiTree.mock.calls.length).toBeGreaterThan(afterFirst + 2);
  });

  it('without a pid, the focused window is the target', async () => {
    const p = platformWith(els(2), els(12));
    const r = await getUiTreeWithWake(p, undefined, { pollMs: 0, budgetMs: 1 });
    expect(p.getActiveWindow).toHaveBeenCalled();
    expect(r.woke).toBe(true);
  });

  it('a failing second read keeps the first tree', async () => {
    const p = platformWith(els(4));
    p.getUiTree.mockResolvedValueOnce(els(4)).mockRejectedValueOnce(new Error('bridge restarted'));
    const r = await getUiTreeWithWake(p, 9, { pollMs: 0, budgetMs: 1 });
    expect(r.tree).toHaveLength(4);
    expect(r.woke).toBe(false);
  });
});

// #234: a Chrome window's own UI (tab strip, toolbar, address bar) is ~59
// elements, so a browser whose PAGE is asleep was never "thin" and never woke.
describe('getUiTreeWithWake — a browser whose page is missing (#234)', () => {
  const chromeUi = () => els(59).map((e, i) => ({ ...e, bounds: { x: i * 10, y: 5, width: 8, height: 20 } }));
  const webArea = (children: number) => [
    { name: 'Dashboard', controlType: 'Document', bounds: { x: 0, y: 100, width: 1200, height: 800 } },
    ...Array.from({ length: children }, (_, i) => ({ name: `page${i}`, controlType: 'Button', bounds: { x: 20 + i, y: 200, width: 80, height: 30 } })),
  ] as any[];

  it('wakes and re-reads when the tree is only browser chrome — no web area', async () => {
    const p = platformWith(chromeUi(), chromeUi(), [...chromeUi(), ...webArea(12)]);
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 3, now: () => 0, isBrowser: () => true });
    expect(r.woke).toBe(true);
    expect(r.tree.some(e => e.name === 'page0')).toBe(true);
    expect(p.getUiTree).toHaveBeenCalledTimes(3);
  });

  it('an empty web area counts as missing too', async () => {
    const p = platformWith([...chromeUi(), ...webArea(0)], [...chromeUi(), ...webArea(3)]);
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 2, now: () => 0, isBrowser: () => true });
    expect(r.woke).toBe(true);
    expect(r.tree.some(e => e.name === 'page2')).toBe(true);
  });

  it('a browser whose page is there is returned as read — one read, no wake', async () => {
    const isBrowser = vi.fn(() => true);
    const p = platformWith([...chromeUi(), ...webArea(5)]);
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 3, isBrowser });
    expect(r.woke).toBe(false);
    expect(p.getUiTree).toHaveBeenCalledTimes(1);
  });

  it('a dense tree of an app that is not a browser never waits, web area or not', async () => {
    const p = platformWith(chromeUi(), [...chromeUi(), ...webArea(4)]);
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 3, isBrowser: () => false });
    expect(r.woke).toBe(false);
    expect(p.getUiTree).toHaveBeenCalledTimes(1);
  });

  it('a page that stays missing: keeps the first read after the budget', async () => {
    const p = platformWith(chromeUi());
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 2, now: () => 0, isBrowser: () => true });
    expect(r.woke).toBe(false);
    expect(r.tree).toHaveLength(59);
    expect(p.getUiTree).toHaveBeenCalledTimes(1 + 2);
  });
});

describe('wakeAccessibility', () => {
  it('macOS: sets AXManualAccessibility for that process through the JXA script', async () => {
    await wakeAccessibility(321, 'darwin');
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].slice(0, 3)).toEqual(['osascript', '-l', 'JavaScript']);
    expect(exec.calls[0][3]).toMatch(/enable-accessibility\.jxa$/);
    expect(exec.calls[0][4]).toBe('321');
  });

  it('Windows / Linux: no process is started (the read itself is the wake-up)', async () => {
    await wakeAccessibility(321, 'win32');
    await wakeAccessibility(321, 'linux');
    expect(exec.calls).toEqual([]);
  });

  it('no pid → nothing to wake', async () => {
    await wakeAccessibility(undefined, 'darwin');
    expect(exec.calls).toEqual([]);
  });
});

describe.runIf(process.platform === 'darwin')('enable-accessibility.jxa (macOS only)', () => {
  it('runs under osascript and reports the AX result as JSON', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const path = await import('path');
    const script = path.resolve(__dirname, '../../scripts/mac/enable-accessibility.jxa');
    // pid 1 (launchd) is not an app: the call must still answer with the JSON shape
    // (ok:false and an AXError code on a CI runner without accessibility permission).
    const out = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', script, '1'], { encoding: 'utf8', timeout: 30_000 }).trim());
    expect(typeof out.ok).toBe('boolean');
    expect(typeof out.axError).toBe('number');
    const bad = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', script, 'nope'], { encoding: 'utf8', timeout: 30_000 }).trim());
    expect(bad.ok).toBe(false);
  }, 60_000);
});
