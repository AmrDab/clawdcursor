/**
 * Playbook tests \u2014 registry, capability-based match routing, keyboard
 * choreography assertions.
 *
 * The v0.9 redesign: playbooks are capability-keyed, NOT app-keyed.
 * matchPlaybook returns 'compose-send' for any mail-shaped intent regardless
 * of which app is active. The old outlook-send / mac-mail-send pair was
 * merged into one app-agnostic compose-send playbook.
 */

import { describe, it, expect, vi } from 'vitest';
import { PLAYBOOKS, matchPlaybook } from '../tools/playbooks/index';
import { findReplace } from '../tools/playbooks/find-replace';
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
