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
    const r = await getUiTreeWithWake(p, 7, { pollMs: 0, budgetMs: 3 });
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
    const r = await getUiTreeWithWake(p, 7, { pollMs: 1, budgetMs: 4 });
    expect(r.woke).toBe(false);
    expect(p.getUiTree).toHaveBeenCalledTimes(1 + 4);  // first read + one per poll, bounded by the budget
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
