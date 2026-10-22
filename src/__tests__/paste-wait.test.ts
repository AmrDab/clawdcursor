/**
 * The clipboard is put back only after the paste has landed. Ctrl/Cmd+V is only posted; a busy app reads the clipboard
 * later, and if it read the RESTORED one it typed the user's own clipboard where the text should go.
 */
import { describe, it, expect, vi } from 'vitest';
import { waitForPaste } from '../tools/paste-guard';
import { getSmartTools } from '../tools/smart';
import type { ToolContext } from '../tools/types';

describe('waitForPaste', () => {
  it('returns as soon as the focused field shows the text', async () => {
    let calls = 0;
    const read = vi.fn(async () => (++calls >= 3 ? 'before hello after' : 'before '));
    const t0 = Date.now();
    await waitForPaste(read, 'hello', { minMs: 10, stepMs: 10, maxMs: 2000 });
    expect(read).toHaveBeenCalledTimes(3);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a field that changes but never shows the text is waited on up to the limit, not forever', async () => {
    let n = 0;
    const t0 = Date.now();
    await waitForPaste(async () => `typing ${n++}`, 'hello', { minMs: 10, stepMs: 10, blindMs: 50, maxMs: 200 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1000);
  });

  it('a field whose value never changes (a code editor that does not report its text) gets only the blind wait', async () => {
    const t0 = Date.now();
    await waitForPaste(async () => '', 'hello', { minMs: 10, stepMs: 10, blindMs: 100, maxMs: 2000 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(95);
    expect(took).toBeLessThan(600);
  });

  it('a read that hangs (a slow AT-SPI call) cannot push the wait past the limit', async () => {
    const t0 = Date.now();
    await waitForPaste(() => new Promise<string>(() => {}), 'hello', { minMs: 10, maxMs: 150 });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('a field that exposes no value (a password box) gets the fixed blind wait', async () => {
    const t0 = Date.now();
    await waitForPaste(async () => undefined, 'hunter2', { minMs: 10, stepMs: 10, blindMs: 150, maxMs: 2000 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1000);
  });

  it('a read that throws counts as no value, and never escapes', async () => {
    await expect(waitForPaste(async () => { throw new Error('bridge down'); }, 'x', { minMs: 1, stepMs: 5, blindMs: 30 })).resolves.toBeUndefined();
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
