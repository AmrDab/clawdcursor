/**
 * Keys are OS-aware from the first message. clawdcursor reads the OS once, when the server starts, and:
 *   - tells the agent which OS this is and which modifier its shortcuts use (the MCP instructions);
 *   - offers and runs only the shortcuts that exist on this OS, with this OS's keys;
 *   - presses its own built-in combos (paste, select-all, copy) through the `mod` alias, never a hardcoded ctrl.
 * An agent's explicit `ctrl+x` is NOT translated on macOS: Ctrl is a real key there (terminals).
 */
import { describe, it, expect, vi } from 'vitest';

let capturedInstructions = '';
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    constructor(_info: unknown, opts: { instructions: string }) { capturedInstructions = opts.instructions; }
    tool() {}
    async connect() {}
    server = { getClientCapabilities: () => undefined };
  },
}));
vi.mock('../core/banner', () => ({
  controlBanner: { touch: vi.fn(), hold: vi.fn(() => () => {}), pin: vi.fn(), unpin: vi.fn(), isVisible: vi.fn(), overlayPids: vi.fn(() => []) },
  appLabel: (s: string) => s,
}));

import { createMcpServer } from '../surface/mcp-server';
import { osKeysGuide } from '../platform/keys';
import { SHORTCUTS, shortcutsFor, resolveShortcutKey, findShortcut } from '../shortcuts';
import { getShortcutTools } from '../tools/shortcuts';
import { getExtraTools } from '../tools/extras';
import { getAllTools, getCompactSurface } from '../tools/registry';
import type { ToolContext } from '../tools/types';

const OSES = ['win32', 'darwin', 'linux'] as const;

async function onPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...desc, value: platform });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', desc); }
}

describe('the agent is told its OS and modifier in the server instructions', () => {
  it('macOS: cmd, not ctrl; ctrl only where an app binds it; no Windows shortcuts', () => {
    const g = osKeysGuide('darwin');
    expect(g).toMatch(/^This computer runs macOS: the shortcut modifier is cmd \(cmd\+c, cmd\+v, cmd\+s/);
    expect(g).toContain('not ctrl');
    expect(g).toContain('mod+s is cmd+s here');
    expect(g).toMatch(/ctrl is a different key on a Mac: use it only where an app really binds Ctrl/);
    expect(g).toMatch(/Do not send Windows shortcuts/);
  });

  it.each([['win32', 'Windows'], ['linux', 'Linux']] as const)('%s: ctrl; no macOS shortcuts', (platform, name) => {
    const g = osKeysGuide(platform);
    expect(g).toMatch(new RegExp(`^This computer runs ${name}: the shortcut modifier is ctrl \\(ctrl\\+c, ctrl\\+v, ctrl\\+s`));
    expect(g).toContain('mod+s is ctrl+s here');
    expect(g).toMatch(/Do not send macOS shortcuts/);
    expect(g).not.toMatch(/modifier is cmd/);
  });

  it.each(OSES)('the instructions a server started on %s sends carry that OS\'s line, and only that one', async (platform) => {
    await onPlatform(platform, () => createMcpServer({ ctx: {} as ToolContext, compact: true }));
    expect(capturedInstructions).toContain(osKeysGuide(platform));
    for (const other of OSES.filter(o => o !== platform)) expect(capturedInstructions).not.toContain(osKeysGuide(other).slice(0, 40));
  });

  it('tool descriptions show no single OS\'s modifier in a key example: they use `mod`', () => {
    for (const t of [...getAllTools(), ...getCompactSurface()].filter(t => /^(key_press|key_down|key_up|computer|type_text)$/.test(t.name))) {
      const text = `${t.description} ${Object.values(t.parameters).map(p => (p as { description?: string }).description ?? '').join(' ')}`;
      expect(text, t.name).not.toMatch(/\b(ctrl|cmd|control|command)\+[a-z]\b/i);
    }
    expect(getAllTools().find(t => t.name === 'key_press')!.description).toMatch(/"mod" is this OS's shortcut modifier \(cmd on macOS, ctrl on Windows and Linux\)/);
  });
});

describe('shortcuts resolve for the current OS only', () => {
  const basics = ['copy', 'paste', 'cut', 'undo', 'select-all', 'find', 'save', 'new-tab', 'close-tab', 'address-bar', 'open-file', 'new-file', 'print'];

  it('macOS: the everyday shortcuts use Cmd, never Ctrl', () => {
    for (const id of basics) {
      const key = resolveShortcutKey(SHORTCUTS.find(s => s.id === id)!, 'darwin');
      expect(key, id).toMatch(/^Cmd\+/);
      expect(key, id).not.toMatch(/Control/);
    }
  });

  it.each(['win32', 'linux'] as const)('%s: the everyday shortcuts use Ctrl, never Cmd', (platform) => {
    for (const id of basics) {
      const key = resolveShortcutKey(SHORTCUTS.find(s => s.id === id)!, platform);
      expect(key, id).toMatch(/^Control\+/);
      expect(key, id).not.toMatch(/Cmd|Super/);
    }
  });

  it('no Windows / Linux chord carries the Command key, and no chord anywhere names a key that cannot be sent (Fn)', () => {
    for (const s of SHORTCUTS) {
      for (const platform of ['win32', 'linux'] as const) expect(resolveShortcutKey(s, platform), `${s.id} on ${platform}`).not.toMatch(/Cmd|Option/);
      for (const platform of OSES) expect(resolveShortcutKey(s, platform), `${s.id} on ${platform}`).not.toMatch(/\bFn\b/);
    }
  });

  it('a shortcut with no binding on this OS is not offered there — no falling back to another OS\'s keys', () => {
    const macOnly = ['hide-app', 'hide-others', 'app-expose', 'force-quit', 'close-all-windows', 'preferences', 'safari-new-tab', 'safari-reader', 'notes-new', 'messages-send', 'terminal-clear'];
    for (const id of macOnly) {
      const s = SHORTCUTS.find(x => x.id === id)!;
      expect(resolveShortcutKey(s, 'darwin'), id).not.toBe('');
      for (const platform of ['win32', 'linux'] as const) {
        expect(resolveShortcutKey(s, platform), `${id} on ${platform}`).toBe('');
        expect(shortcutsFor(platform).map(x => x.id), `${id} on ${platform}`).not.toContain(id);
      }
    }
    // Windows-only chords are not handed to Linux either.
    for (const id of ['screenshot-full', 'screenshot-selection', 'emoji-picker']) {
      expect(resolveShortcutKey(SHORTCUTS.find(x => x.id === id)!, 'win32'), id).toMatch(/^Super\+/);
      expect(resolveShortcutKey(SHORTCUTS.find(x => x.id === id)!, 'linux'), id).toBe('');
    }
  });

  it.each(OSES)('every shortcut offered on %s has a chord', (platform) => {
    const offered = shortcutsFor(platform);
    expect(offered.length).toBeGreaterThan(40);
    for (const s of offered) expect(resolveShortcutKey(s, platform).trim(), s.id).not.toBe('');
  });

  it('findShortcut never matches an intent that has no chord on that OS', () => {
    expect(findShortcut('hide others', 'darwin')?.combo).toBe('Option+Cmd+h');
    expect(findShortcut('hide others', 'win32')).toBeNull();
    expect(findShortcut('hide others', 'linux')).toBeNull();
    expect(findShortcut('force quit', 'win32')).toBeNull();
    expect(findShortcut('reader mode', 'win32', { contextHint: 'safari' })).toBeNull();
    for (const platform of OSES) {
      for (const s of SHORTCUTS) for (const intent of s.intents) {
        const m = findShortcut(intent, platform, { contextHint: (s.contextHints ?? []).join(' ') });
        if (m) expect(m.combo.trim(), `${intent} on ${platform}`).not.toBe('');
      }
    }
  });

  it('the same intent presses this OS\'s chord: copy, close window, refresh', () => {
    expect(findShortcut('copy', 'darwin')?.combo).toBe('Cmd+c');
    expect(findShortcut('copy', 'win32')?.combo).toBe('Control+c');
    expect(findShortcut('copy', 'linux')?.combo).toBe('Control+c');
    expect(findShortcut('close window', 'darwin')?.combo).toBe('Cmd+w');
    expect(findShortcut('close window', 'win32')?.combo).toBe('Alt+F4');
    expect(findShortcut('refresh', 'darwin')?.combo).toBe('Cmd+r');
    expect(findShortcut('refresh', 'win32')?.combo).toBe('F5');
  });

  it.each(OSES)('shortcuts_list and shortcuts_execute on %s use that OS\'s chords', async (platform) => {
    const [list, run] = ['shortcuts_list', 'shortcuts_execute'].map(n => getShortcutTools().find(t => t.name === n)!);
    const keyPress = vi.fn(async (_c: string) => {});
    const ctx = { ensureInitialized: async () => {}, desktop: { keyPress }, a11y: { getActiveWindow: async () => ({ processName: 'app', title: 'doc' }), invalidateCache: () => {} } } as unknown as ToolContext;
    await onPlatform(platform, async () => {
      const listed = JSON.parse((await list.handler({}, ctx)).text) as { shortcuts: Array<{ id: string; key: string }> };
      const mod = platform === 'darwin' ? /^Cmd\+/ : /^Control\+/;
      expect(listed.shortcuts.find(s => s.id === 'copy')!.key).toMatch(mod);
      expect(listed.shortcuts.every(s => s.key.trim() !== '')).toBe(true);
      expect(listed.shortcuts.some(s => s.id === 'hide-others')).toBe(platform === 'darwin');
      await run.handler({ intent: 'paste' }, ctx);
      expect(keyPress).toHaveBeenLastCalledWith(platform === 'darwin' ? 'Cmd+v' : 'Control+v');
      const miss = await run.handler({ intent: 'hide others' }, ctx);
      expect(!!miss.isError).toBe(platform !== 'darwin');
    });
  });
});

describe('clawdcursor\'s own combos use the platform modifier', () => {
  // The repo-wide "no literal ctrl+ outside the per-OS adapters" scans are in repo-invariants.test.ts.
  it.each(OSES)('type_text pastes with mod+v on %s', async (platform) => {
    let clip = '';
    const keyPress = vi.fn(async (_c: string) => {});
    const ctx = {
      ensureInitialized: async () => {},
      desktop: {},
      platform: {
        keyPress, typeText: vi.fn(async () => {}), takeInputWarning: () => null, typingIsPrivate: () => true,
        writeClipboard: async (t: string) => { clip = t; }, readClipboard: async () => clip,
        getActiveWindow: async () => ({ processName: 'TextEdit', title: 'Doc' }), getFocusedElement: async () => ({ value: clip }),
      },
      getMouseScaleFactor: () => 1, getScreenshotScaleFactor: () => 1,
    } as unknown as ToolContext;
    // Not plain ASCII, so it is pasted (short plain text is typed as keys).
    await onPlatform(platform, () => getAllTools().find(t => t.name === 'type_text')!.handler({ text: 'héllo wörld' }, ctx));
    const combos = keyPress.mock.calls.map(c => c[0]);
    expect(combos).toContain('mod+v');
    expect(combos.join(' ')).not.toMatch(/ctrl|control/i);
  });

  it.each(['darwin', 'win32'] as const)('triple-click selects all with mod+a on %s', async (os) => {
    const keyPress = vi.fn(async (_c: string) => {});
    const platform = {
      platform: os, keyPress, mouseClick: vi.fn(async () => {}), mouseDoubleClick: vi.fn(async () => {}), mouseTripleClick: vi.fn(async () => {}),
      getFocusedElement: async () => ({ controlType: 'Edit', bounds: { x: 0, y: 0, width: 500, height: 500 } }),
    };
    const ctx = { ensureInitialized: async () => {}, platform, getMouseScaleFactor: () => 1, a11y: { invalidateCache: () => {} } } as unknown as ToolContext;
    const r = await getExtraTools().find(t => t.name === 'mouse_triple_click')!.handler({ x: 10, y: 10, space: 'screen' }, ctx);
    if (!r.isError && keyPress.mock.calls.length) expect(keyPress).toHaveBeenCalledWith('mod+a');
    expect(keyPress.mock.calls.map(c => c[0]).join(' ')).not.toMatch(/ctrl|cmd/i);
  });
});
