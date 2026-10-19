/**
 * Where did my keystrokes go? On macOS a modal dialog of another app (1Password Quick Access, a launcher panel, an app's own
 * "Delete everything?" box) can have the keyboard. Keys are sent — launchers and password managers are exactly that — but the
 * warning only reached the log, so the agent that typed there was told nothing. The tools now append it to what they report.
 *
 * Also: type_text writes the text to the clipboard and pastes. When the paste is REFUSED (a system dialog owns the keyboard —
 * now a real outcome on the MCP route) the typed text used to stay on the user's clipboard.
 */
import { describe, it, expect, vi } from 'vitest';
import { getDesktopTools } from '../tools/desktop';
import { getSmartTools } from '../tools/smart';
import { buildUnifiedTools } from '../core/agent-loop/tools';
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

const typeText = getDesktopTools().find(t => t.name === 'type_text')!;
const keyPress = getDesktopTools().find(t => t.name === 'key_press')!;

describe('a clipboard that did not take the text is never pasted (live 2026-10-19: the user\'s clipboard was submitted as a web search)', () => {
  function deafClipboard(initial: string) {
    const clip = clipboardOf(initial);
    clip.writeClipboard.mockImplementation(async (t: string) => { clip.state.writes.push(t); }); // Set-Clipboard timed out: nothing written
    return clip;
  }

  it('MCP type_text types the text key by key instead, and says so', async () => {
    const kb = keyboard();
    const { ctx } = desktopCtx(kb, deafClipboard("the user's own clipboard"));
    const r = await typeText.handler({ text: 'https://glama.ai/x\n' }, ctx);
    const combos = kb.keyPress.mock.calls.map(c => c[0]);
    expect(combos.some(c => /\+v$/.test(c))).toBe(false);
    expect(kb.typeText).toHaveBeenCalledWith('https://glama.ai/x');
    expect(combos).toEqual(['Return']);
    expect(r.text).toMatch(/typed key by key/);
  });

  it('smart_type types it instead of pasting', async () => {
    const kb = keyboard();
    const { ctx } = desktopCtx(kb, deafClipboard("the user's own clipboard"));
    await getSmartTools().find(t => t.name === 'smart_type')!.handler({ text: 'hello' }, ctx);
    expect(kb.keyPress.mock.calls.map(c => c[0])).not.toContain('mod+v');
    expect(kb.typeText).toHaveBeenCalledWith('hello');
  });
});

describe('MCP type_text', () => {
  it('says so when a modal dialog of another app got the text', async () => {
    const { ctx } = desktopCtx(keyboard({ warning: WARNING }));
    const r = await typeText.handler({ text: 'hello' }, ctx);
    expect(r.text).toContain('Typed 5 chars');
    expect(r.text).toContain(WARNING);
  });

  it('adds nothing when the keys went where they were meant to', async () => {
    const { ctx } = desktopCtx(keyboard());
    const r = await typeText.handler({ text: 'hello' }, ctx);
    expect(r.text).toMatch(/^Typed 5 chars into /);
    expect(r.text).not.toContain('modal dialog');
  });

  it('a warning left over from an earlier call is not reported as this call\'s', async () => {
    const { ctx } = desktopCtx(keyboard({ stale: 'STALE WARNING FROM BEFORE' }));
    const r = await typeText.handler({ text: 'hello' }, ctx);
    expect(r.text).not.toContain('STALE');
  });

  it('a REFUSED paste puts the user\'s clipboard back — the typed text must not stay on it', async () => {
    const { ctx, clip } = desktopCtx(keyboard({ refuse: true }));
    await expect(typeText.handler({ text: 'hunter2 correct horse' }, ctx)).rejects.toThrow(/system dialog/i);
    expect(clip.state.value).toBe('PRIOR');
  });

  it('the clipboard is restored after a normal paste too (unchanged behaviour)', async () => {
    const { ctx, clip } = desktopCtx(keyboard());
    await typeText.handler({ text: 'abc' }, ctx);
    expect(clip.state.writes).toEqual(['abc', 'PRIOR']);
  });
});

describe('MCP key_press', () => {
  it('says so when a modal dialog of another app got the key', async () => {
    const { ctx } = desktopCtx(keyboard({ warning: WARNING }));
    const r = await keyPress.handler({ key: 'Return' }, ctx);
    expect(r.text).toContain('Key pressed: Return');
    expect(r.text).toContain(WARNING);
  });

  it('adds nothing otherwise, and drops a stale warning', async () => {
    const { ctx } = desktopCtx(keyboard({ stale: 'STALE' }));
    const r = await keyPress.handler({ key: 'Return' }, ctx);
    expect(r.text).toMatch(/^Key pressed: Return in /);
    expect(r.text).not.toContain('STALE');
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

  it('on other OSes smart_type does not save/restore the clipboard (the guard is a macOS thing): one write, the text', async () => {
    await onPlatform('linux', async () => {
      const { ctx, clip } = desktopCtx(keyboard());
      await smartType.handler({ text: 'abc' }, ctx);
      expect(clip.state.writes).toEqual(['abc']);
    });
  });

  it('a successful paste still leaves the text on the clipboard, as it always did (its design: paste-typing)', async () => {
    const { ctx, clip } = desktopCtx(keyboard());
    await smartType.handler({ text: 'abc' }, ctx);
    expect(clip.state.value).toBe('abc');
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

  it('key: the warning is appended', async () => {
    const { ctx } = platformCtx(keyboard({ warning: WARNING }));
    const r = await key.execute({ combo: 'Return' }, ctx);
    expect(r.success).toBe(true);
    expect(r.text).toContain('Pressed Return');
    expect(r.text).toContain(WARNING);
  });
});
