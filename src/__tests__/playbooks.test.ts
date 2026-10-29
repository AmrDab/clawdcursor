/**
 * Playbook tests \u2014 registry, capability-based match routing, keyboard
 * choreography assertions, keys-blocklist.
 *
 * The v0.9 redesign: playbooks are capability-keyed, NOT app-keyed.
 * matchPlaybook returns 'compose-send' for any mail-shaped intent regardless
 * of which app is active. The old outlook-send / mac-mail-send pair was
 * merged into one app-agnostic compose-send playbook.
 */

import { describe, it, expect, vi } from 'vitest';
import { PLAYBOOKS, matchPlaybook } from '../tools/playbooks/index';
import { findReplace } from '../tools/playbooks/find-replace';
import { isBlockedKey, normalizeCombo, BLOCKED_KEYS, keyBlockTier } from '../tools/playbooks/keys-blocklist';
import type { PlatformAdapter } from '../platform/types';

function makeAdapter(platform: 'win32' | 'darwin' | 'linux' = 'win32'): { adapter: PlatformAdapter; calls: any[] } {
  const calls: any[] = [];
  const adapter = {
    platform,
    init: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    checkPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    requestPermissions: () => Promise.resolve({ input: true, accessibility: true, screenRecording: true }),
    getScreenSize: () => Promise.resolve({ physicalWidth: 1920, physicalHeight: 1080, logicalWidth: 1920, logicalHeight: 1080, dpiRatio: 1 }),
    screenshot: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    screenshotRegion: () => Promise.resolve({ buffer: Buffer.alloc(0), width: 0, height: 0, scaleFactor: 1 }),
    listWindows: () => Promise.resolve([]),
    getActiveWindow: () => Promise.resolve(null),
    focusWindow: () => Promise.resolve(true),
    maximizeWindow: () => Promise.resolve(),
    getUiTree: () => Promise.resolve([]),
    findElements: () => Promise.resolve([]),
    getFocusedElement: () => Promise.resolve(null),
    invokeElement: () => Promise.resolve({ success: true }),
    mouseClick: () => Promise.resolve(),
    mouseMove: () => Promise.resolve(),
    mouseDrag: () => Promise.resolve(),
    mouseScroll: () => Promise.resolve(),
    typeText: vi.fn((text: string) => { calls.push({ kind: 'type', text }); return Promise.resolve(); }),
    keyPress: vi.fn((combo: string) => { calls.push({ kind: 'key', combo }); return Promise.resolve(); }),
    readClipboard: () => Promise.resolve(''),
    writeClipboard: () => Promise.resolve(),
    openApp: () => Promise.resolve({}),
    launchApp: () => Promise.resolve({}),
  } as unknown as PlatformAdapter;
  return { adapter, calls };
}

describe('PLAYBOOKS registry', () => {
  it('exposes capability-keyed playbooks (NOT app-keyed)', () => {
    // Keys are capabilities. App names like 'outlook-send' or 'mac-mail-send'
    // are explicit antipatterns and must never appear here. 'compose-send' is
    // intentionally NOT registered — it's the pipeline's OS-mailto path, not an
    // in-app keyboard choreography (which would have to assume an app layout).
    const keys = Object.keys(PLAYBOOKS).sort();
    expect(keys).toEqual(['find-replace']);
    for (const k of keys) {
      expect(k).not.toMatch(/outlook|mail\.app|gmail|thunderbird|spark|mac-/i);
    }
  });
});

describe('matchPlaybook (capability-based, app-agnostic)', () => {
  it('routes mail-shaped intents to compose-send regardless of active app', () => {
    expect(matchPlaybook('send email to bob', 'outlook')).toBe('compose-send');
    expect(matchPlaybook('send email to bob', 'mail')).toBe('compose-send');
    expect(matchPlaybook('send email to bob', 'thunderbird')).toBe('compose-send');
    expect(matchPlaybook('send email to bob', 'spark')).toBe('compose-send');
    expect(matchPlaybook('compose an email',   'anything')).toBe('compose-send');
    // No app name in the task either \u2014 still routes by intent.
    expect(matchPlaybook('send a message to alice@example.com', '')).toBe('compose-send');
  });
  it('routes find-and-replace to find-replace regardless of active app', () => {
    expect(matchPlaybook('find and replace X with Y', 'vscode')).toBe('find-replace');
    expect(matchPlaybook('find and replace X with Y', 'word')).toBe('find-replace');
    expect(matchPlaybook('replace all "foo" with "bar"', 'anything')).toBe('find-replace');
  });
  it('returns null when no capability matches', () => {
    expect(matchPlaybook('summarize this article', 'chrome')).toBeNull();
    expect(matchPlaybook('open paint',             'desktop')).toBeNull();
  });
});

describe('find-replace', () => {
  it('refuses without find text', async () => {
    const { adapter } = makeAdapter();
    const r = await findReplace({ adapter, input: {} });
    expect(r.success).toBe(false);
  });
  it('fires mod+h, types find, Tab, types replace, alt+a, Escape', async () => {
    const { adapter, calls } = makeAdapter();
    const r = await findReplace({ adapter, input: { find: 'old', replace: 'new' } });
    expect(r.success).toBe(true);
    const keys = calls.filter(c => c.kind === 'key').map(c => c.combo);
    expect(keys[0]).toBe('mod+h');
    expect(keys).toContain('alt+a');
    expect(keys[keys.length - 1]).toBe('Escape');
    const types = calls.filter(c => c.kind === 'type').map(c => c.text);
    expect(types).toEqual(['old', 'new']);
  });
});

describe('keys-blocklist (two-tier: HARD block vs CONFIRM, v1.6.0)', () => {
  it('HARD-blocks lock/force-quit/shutdown sequences regardless of casing', () => {
    expect(keyBlockTier('Ctrl+Alt+Delete')).toBe('block');
    expect(keyBlockTier('win+l')).toBe('block');
    expect(keyBlockTier('CMD-SHIFT-Q')).toBe('block');
    expect(isBlockedKey('ctrl+alt+del')).toBe(true); // back-compat = HARD only
  });
  it('CONFIRMS (does not hard-block) consequential-but-legit combos', () => {
    for (const c of ['Alt+F4', 'alt +f4', 'win+r', 'cmd+q', 'ctrl+w', 'cmd+w', 'win+d', 'f11']) {
      expect(keyBlockTier(c)).toBe('confirm');
      expect(isBlockedKey(c)).toBe(false); // no longer a HARD block → has a confirm path
    }
  });
  it('does not gate safe combos', () => {
    for (const c of ['mod+s', 'Tab', 'Return']) {
      expect(keyBlockTier(c)).toBeNull();
      expect(isBlockedKey(c)).toBe(false);
    }
  });
  it('normalizes underscores and dashes', () => {
    expect(normalizeCombo('ctrl-alt-delete')).toBe('ctrl+alt+delete');
  });
  it('the HARD-block set is the lock/force-quit core (no dead-ended legit combos)', () => {
    expect(BLOCKED_KEYS.size).toBeGreaterThanOrEqual(7);
    expect(BLOCKED_KEYS.has('win+d')).toBe(false);   // moved to confirm
    expect(BLOCKED_KEYS.has('ctrl+w')).toBe(false);  // moved to confirm
  });
});

// The executors accept modifier aliases (src/platform/keys.ts and each adapter):
// control, option/opt, escape, and a super family (super/meta/win/windows/
// cmd/command) whose key depends on the OS. The blocklist matched spellings, so
// `super+l` or `option+f4` classified null and was then pressed as Win+L / Alt+F4.
describe('keys-blocklist matches what the executor presses, however it is spelled', () => {
  /** The blocklist as loaded on `platform` (it resolves `mod` and the super family at load). */
  async function blocklistOn(platform: NodeJS.Platform) {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...desc, value: platform });
    vi.resetModules();
    try { return await import('../tools/playbooks/keys-blocklist'); } finally { Object.defineProperty(process, 'platform', desc); }
  }

  it.each(['win32', 'darwin', 'linux'] as const)('resolves control/option/escape and modifier order on %s', async (platform) => {
    const { keyBlockTier } = await blocklistOn(platform);
    expect(keyBlockTier('control+shift+escape')).toBe('block');
    expect(keyBlockTier('shift+ctrl+esc')).toBe('block');
    expect(keyBlockTier('control+alt+delete')).toBe('block');
    expect(keyBlockTier('cmd+option+escape')).toBe('block');
    expect(keyBlockTier('option+f4')).toBe('confirm');
    expect(keyBlockTier('control+w')).toBe('confirm');
  });

  it.each(['win32', 'linux'] as const)('super-family spellings are the Windows/Super key on %s', async (platform) => {
    const { keyBlockTier, isBlockedKey } = await blocklistOn(platform);
    for (const c of ['super+l', 'windows+l', 'meta+l', 'cmd+l', 'command+l']) {
      expect(keyBlockTier(c)).toBe('block');
      expect(isBlockedKey(c)).toBe(true);
    }
    expect(keyBlockTier('super+r')).toBe('confirm');
    expect(keyBlockTier('super+d')).toBe('confirm');
  });

  it('reads a token whole, as the executors do: `super_l` / `command_l` are the Windows key on Windows', async () => {
    // keys.ts resolves both to Super; NativeDesktop and the Windows adapter press LeftSuper+L.
    const { keyBlockTier, isBlockedKey } = await blocklistOn('win32');
    for (const c of ['super_l+l', 'command_l+l', 'SUPER_L + L']) {
      expect(keyBlockTier(c)).toBe('block');
      expect(isBlockedKey(c)).toBe(true);
    }
    expect(keyBlockTier('super_l+d')).toBe('confirm');
  });

  it('the Windows adapter sends cmd/command/meta as Ctrl, so those spellings are classified as Ctrl too', async () => {
    const { keyBlockTier } = await blocklistOn('win32');
    expect(keyBlockTier('meta+w')).toBe('confirm');
    expect(keyBlockTier('command+shift+esc')).toBe('block');
  });

  it('super-family spellings are Command on macOS (and Cmd+L stays free)', async () => {
    const { keyBlockTier } = await blocklistOn('darwin');
    expect(keyBlockTier('super+shift+q')).toBe('block');
    expect(keyBlockTier('meta+control+q')).toBe('block');
    expect(keyBlockTier('super+q')).toBe('confirm');
    expect(keyBlockTier('command+w')).toBe('confirm');
    expect(keyBlockTier('super+l')).toBeNull();
    expect(keyBlockTier('cmd+l')).toBeNull();
  });

  it.each(['win32', 'darwin', 'linux'] as const)('does not gate safe combos on %s', async (platform) => {
    const { keyBlockTier } = await blocklistOn(platform);
    for (const c of ['mod+s', 'control+c', 'option+left', 'shift+tab', 'escape', 'Return']) {
      expect(keyBlockTier(c)).toBeNull();
    }
  });
});
