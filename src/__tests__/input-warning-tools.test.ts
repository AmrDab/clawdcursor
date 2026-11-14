/**
 * Where did my keystrokes go? On macOS a modal dialog of another app (1Password Quick Access, a launcher panel, an app's own
 * "Delete everything?" box) can have the keyboard. Keys are sent — launchers and password managers are exactly that — but the
 * warning only reached the log, so the agent that typed there was told nothing. The tools now append it to what they report.
 *
 * Also: type (MCP type_text) and smart_type write the text to the clipboard and paste. When the paste is REFUSED (a system
 * dialog owns the keyboard — now a real outcome on the MCP route) the typed text used to stay on the user's clipboard.
 */
import { describe, it, expect, vi } from 'vitest';
import { getSmartTools } from '../tools/smart';
import { getCompactTools } from '../tools/compact';
import { buildUnifiedTools } from '../tools/projected/tools';
import type { ToolContext } from '../tools/types';

const WARNING = 'A modal dialog of "SomeAgent" — "Allow access?" (pid 9) is frontmost, so keystrokes go to it. If that is not the app you mean to drive, answer or close it first.';
const REFUSAL = 'A system dialog owns the keyboard: "UserNotificationCenter" (pid 311) is frontmost per NSWorkspace.';

/** A keyboard whose next keystroke leaves `warning` behind, like NativeDesktop / MacOSAdapter do. */
function keyboard(o: { warning?: string; stale?: string; refuse?: boolean } = {}) {
  let pending: string | null = o.stale ?? null;
  return {
    keyPress: vi.fn(async (_combo: string) => { if (o.refuse) throw new Error(REFUSAL); if (o.warning) pending = o.warning; }),
    typeText: vi.fn(async (_text: string) => { if (o.refuse) throw new Error(REFUSAL); if (o.warning) pending = o.warning; }),
    takeInputWarning: vi.fn(() => { const w = pending; pending = null; return w; }),
  };
}

function clipboardOf(initial: string) {
  const state = { value: initial, writes: [] as string[] };
  return {
    state,
    readClipboard: vi.fn(async () => state.value),
    writeClipboard: vi.fn(async (t: string) => { state.value = t; state.writes.push(t); }),
  };
}

function desktopCtx(kb: ReturnType<typeof keyboard>, clip = clipboardOf('PRIOR')) {
  const ctx = {
    ensureInitialized: async () => {},
    desktop: kb,
    a11y: { ...clip, getActiveWindow: async () => ({ processName: 'TextEdit', title: 'Doc' }), invalidateCache: vi.fn() },
    uiMaps: undefined,
  } as unknown as ToolContext;
  return { ctx, clip };
}

/** Run `fn` as if on `platform` (smart_type reads process.platform). */
async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

describe('a clipboard that did not take the text is never pasted (live 2026-10-19: the user\'s clipboard was submitted as a web search)', () => {
  function deafClipboard(initial: string) {
    const clip = clipboardOf(initial);
    clip.writeClipboard.mockImplementation(async (t: string) => { clip.state.writes.push(t); }); // Set-Clipboard timed out: nothing written
    return clip;
  }

  it('smart_type types it instead of pasting', async () => {
    const kb = keyboard();
    const { ctx } = desktopCtx(kb, deafClipboard("the user's own clipboard"));
    await getSmartTools().find(t => t.name === 'smart_type')!.handler({ text: 'hello' }, ctx);
    expect(kb.keyPress.mock.calls.map(c => c[0])).not.toContain('mod+v');
    expect(kb.typeText).toHaveBeenCalledWith('hello');
  });
});

describe('MCP smart_type', () => {
  const smartType = getSmartTools().find(t => t.name === 'smart_type')!;

  it('says so when a modal dialog of another app got the text', async () => {
    const { ctx } = desktopCtx(keyboard({ warning: WARNING }));
    const r = await smartType.handler({ text: 'hello' }, ctx);
    expect(r.text).toContain('Typed 5 chars');
    expect(r.text).toContain(WARNING);
  });

  it('a REFUSED paste puts the user\'s clipboard back — nothing was typed, so the text must not be left there', async () => {
    await onPlatform('darwin', async () => {
      const { ctx, clip } = desktopCtx(keyboard({ refuse: true }));
      await expect(smartType.handler({ text: 'hunter2 correct horse' }, ctx)).rejects.toThrow(/system dialog/i);
      expect(clip.state.value).toBe('PRIOR');
    });
  });

  it('every OS: long text is pasted, then the user\'s clipboard is put back (#243)', async () => {
    await onPlatform('linux', async () => {
      const { ctx, clip } = desktopCtx(keyboard());
      const long = 'abc'.repeat(50);
      await smartType.handler({ text: long }, ctx);
      expect(clip.state.writes).toEqual([long, 'PRIOR']);
    });
  });

  it('short text is typed as keystrokes: the user\'s clipboard is never written', async () => {
    const { ctx, clip } = desktopCtx(keyboard());
    await smartType.handler({ text: 'abc' }, ctx);
    expect(clip.state.writes).toEqual([]);
  });

  it('a successful paste no longer leaves the typed text (a password, say) on the clipboard (#243)', async () => {
    const { ctx, clip } = desktopCtx(keyboard());
    await smartType.handler({ text: 'hunter2' }, ctx);
    expect(clip.state.value).toBe('PRIOR');
  });
});

describe('agent loop type / key', () => {
  const type = buildUnifiedTools().find(t => t.name === 'type')!;
  const key = buildUnifiedTools().find(t => t.name === 'key')!;
  const platformCtx = (kb: ReturnType<typeof keyboard>, clip = clipboardOf('PRIOR')) => ({ ctx: { platform: { ...kb, ...clip } } as any, clip });

  it('type: the warning is appended', async () => {
    const { ctx } = platformCtx(keyboard({ warning: WARNING }));
    const r = await type.execute({ text: 'hello' }, ctx);
    expect(r.success).toBe(true);
    expect(r.text).toContain(WARNING);
  });

  it('type: nothing is appended otherwise', async () => {
    const { ctx } = platformCtx(keyboard({ stale: 'STALE' }));
    const r = await type.execute({ text: 'hello' }, ctx);
    expect(r.text).not.toContain('STALE');
    expect(r.text).not.toContain('modal dialog');
  });

  it('type: a refused paste (and the refused char-by-char fallback) leaves the user\'s clipboard as it was', async () => {
    const { ctx, clip } = platformCtx(keyboard({ refuse: true }));
    await expect(type.execute({ text: 'hunter2 correct horse' }, ctx)).rejects.toThrow(/system dialog/i);
    expect(clip.state.value).toBe('PRIOR');
  });

  // Live 2026-11-10: `computer key` with repeat pressed the key once; the argument was dropped without a word.
  it('presses the key, or the whole sequence, `repeat` times', async () => {
    const kb = keyboard();
    const { ctx } = platformCtx(kb);
    const r = await key.execute({ combo: 'Down', repeat: 3 }, ctx);
    expect(kb.keyPress.mock.calls.map(c => c[0])).toEqual(['Down', 'Down', 'Down']);
    expect(r.text).toContain('Pressed Down ×3');
    kb.keyPress.mockClear();
    await key.execute({ combo: 'Down End', repeat: 2 }, ctx);
    expect(kb.keyPress.mock.calls.map(c => c[0])).toEqual(['Down', 'End', 'Down', 'End']);
  });

  it('refuses a repeat that is not a whole number from 1 to 100, and presses nothing', async () => {
    const kb = keyboard();
    const { ctx } = platformCtx(kb);
    for (const repeat of [0, 101, 2.5, 'many']) {
      const r = await key.execute({ combo: 'Down', repeat }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/"repeat" must be a whole number from 1 to 100/);
    }
    expect(kb.keyPress).not.toHaveBeenCalled();
  });

  it('the `computer` compound publishes repeat, so the MCP validator does not strip it', () => {
    const computer = getCompactTools().find(t => t.name === 'computer')!;
    expect(computer.parameters.repeat).toMatchObject({ type: 'number', minimum: 1, maximum: 100 });
  });

  it('`computer {action:"key", repeat}` reaches the keyboard through the compound dispatcher', async () => {
    const kb = keyboard();
    const ctx = { ensureInitialized: async () => {}, platform: kb, desktop: { getScreenSize: () => ({ width: 1920, height: 1080 }) },
      a11y: {}, getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1 } as unknown as ToolContext;
    const computer = getCompactTools().find(t => t.name === 'computer')!;
    const r = await computer.handler({ action: 'key', combo: 'Down', repeat: 3 }, ctx);
    expect(r.isError).toBeFalsy();
    expect(kb.keyPress.mock.calls.map(c => c[0])).toEqual(['Down', 'Down', 'Down']);
  });

  it('key: the warning is appended', async () => {
    const { ctx } = platformCtx(keyboard({ warning: WARNING }));
    const r = await key.execute({ combo: 'Return' }, ctx);
    expect(r.success).toBe(true);
    expect(r.text).toContain('Pressed Return');
    expect(r.text).toContain(WARNING);
  });
});
