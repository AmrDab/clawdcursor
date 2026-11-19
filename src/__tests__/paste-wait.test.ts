/**
 * The clipboard is put back only after the paste has landed. Ctrl/Cmd+V is only posted; a busy app reads the clipboard
 * later, and if it read the RESTORED one it typed the user's own clipboard where the text should go.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForPaste } from '../tools/paste-guard';
import { getSmartTools } from '../tools/smart';
import type { ToolContext } from '../tools/types';

describe('waitForPaste', () => {
  // Fake timers: the waits are virtual, so a loaded test run cannot change the outcome.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  /** Advances the fake clock 5 ms at a time until the wait ends (leftover race timers must not count) and returns the fake ms it took. */
  const timed = async (p: Promise<void>): Promise<number> => {
    let done = false;
    void p.then(() => { done = true; }, () => { done = true; });
    const t0 = Date.now();
    for (let i = 0; i < 1000 && !done; i++) await vi.advanceTimersByTimeAsync(5);
    await p;
    return Date.now() - t0;
  };

  it('returns as soon as the focused field shows the text', async () => {
    let calls = 0;
    const read = vi.fn(async () => (++calls >= 3 ? 'before hello after' : 'before '));
    const took = await timed(waitForPaste(read, 'hello', { minMs: 10, stepMs: 10, maxMs: 2000 }));
    expect(read).toHaveBeenCalledTimes(3);
    expect(took).toBeGreaterThanOrEqual(30);
    expect(took).toBeLessThan(50);
  });

  it('a field that changes but never shows the text is waited on up to the limit, not forever', async () => {
    let n = 0;
    const took = await timed(waitForPaste(async () => `typing ${n++}`, 'hello', { minMs: 10, stepMs: 10, blindMs: 50, maxMs: 200 }));
    expect(took).toBeGreaterThanOrEqual(200);
    expect(took).toBeLessThan(220);
  });

  // The first sleep outlasts the blind wait: one read could not see the change.
  it('a first sleep that outlasts the blind wait still reads twice before giving up on a changing field', async () => {
    let n = 0;
    const reads: number[] = [];
    await timed(waitForPaste(async () => { reads.push(Date.now()); return `typing ${n++}`; }, 'hello', { minMs: 120, stepMs: 10, blindMs: 50, maxMs: 300 }));
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('a field whose value never changes (a code editor that does not report its text) gets only the blind wait', async () => {
    const took = await timed(waitForPaste(async () => '', 'hello', { minMs: 10, stepMs: 10, blindMs: 100, maxMs: 2000 }));
    expect(took).toBeGreaterThanOrEqual(100);
    expect(took).toBeLessThan(120);
  });

  it('a read that hangs (a slow AT-SPI call) cannot push the wait past the limit', async () => {
    const took = await timed(waitForPaste(() => new Promise<string>(() => {}), 'hello', { minMs: 10, maxMs: 150 }));
    expect(took).toBeLessThanOrEqual(210);   // the limit plus one step
  });

  it('a field that exposes no value (a password box) gets the fixed blind wait', async () => {
    const took = await timed(waitForPaste(async () => undefined, 'hunter2', { minMs: 10, stepMs: 10, blindMs: 150, maxMs: 2000 }));
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(170);
  });

  it('a read that throws counts as no value, and never escapes', async () => {
    await expect(timed(waitForPaste(async () => { throw new Error('bridge down'); }, 'x', { minMs: 1, stepMs: 5, blindMs: 30 }))).resolves.toBeGreaterThanOrEqual(30);
  });
});

// Short text is typed as keystrokes (no clipboard); the paste path is for long text.
const LONG_SECRET = 'secret text '.repeat(12).trim();

describe('smart_type puts the clipboard back only once the field has the text', () => {
  it('a slow app: no restore while the paste is still pending', async () => {
    const clip = { value: 'PRIOR' };
    let pasted = false;
    let pastedValue: string | null = null;
    const ctx = {
      ensureInitialized: async () => {},
      desktop: {
        keyPress: vi.fn(async (combo: string) => {
          // The app reads the clipboard 300 ms after the keystroke, like a busy Electron window.
          if (combo === 'mod+v') setTimeout(() => { pastedValue = clip.value; pasted = true; }, 300);
        }),
        typeText: vi.fn(async () => {}),
        takeInputWarning: () => null,
      },
      a11y: {
        readClipboard: async () => clip.value,
        writeClipboard: async (t: string) => { clip.value = t; },
        getFocusedElement: async () => ({ value: pasted ? `${pastedValue}` : '' }),
        getActiveWindow: async () => ({ processName: 'App', title: 'Doc' }),
        invalidateCache: () => {},
      },
    } as unknown as ToolContext;
    await getSmartTools().find(t => t.name === 'smart_type')!.handler({ text: LONG_SECRET }, ctx);
    expect(pastedValue).toBe(LONG_SECRET);
    expect(clip.value).toBe('PRIOR');
  });
});

describe('readBackTyped', () => {
  it('a password field is unknown at once — no polling', async () => {
    const { readBackTyped } = await import('../tools/paste-guard');
    let calls = 0;
    const r = await readBackTyped(async () => { calls++; return { secure: true, value: '••••' }; }, 'hunter2', { maxMs: 1000 });
    expect(r.result).toBe('unknown');
    expect(calls).toBe(1);
  });

  it('a value at the read cap (Windows TextPattern stops at 1000 chars) gives no verdict', async () => {
    const { readBackTyped } = await import('../tools/paste-guard');
    const r = await readBackTyped(async () => ({ value: 'x'.repeat(1000) }), 'not in there', { maxMs: 50 });
    expect(r.result).toBe('unknown');
  });

  it('suffix vs mismatch vs match, with and without submit', async () => {
    const { readBackTyped } = await import('../tools/paste-guard');
    const f = (value: string) => async () => ({ value });
    expect((await readBackTyped(f('github.com/login'), 'github.com', { submit: true, maxMs: 0 })).result).toBe('suffix');
    expect((await readBackTyped(f('glama.ai'), 'github.com', { submit: true, maxMs: 0 })).result).toBe('mismatch');
    expect((await readBackTyped(f('see github.com'), 'github.com', { submit: true, maxMs: 0 })).result).toBe('match');
    expect((await readBackTyped(f('github.com/login'), 'github.com', { maxMs: 0 })).result).toBe('match');
  });
});
