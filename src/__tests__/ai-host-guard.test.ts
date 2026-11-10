/**
 * Eval 2026-11-08: a small model sent `computer type` and a click before it had focused any window, and both landed in the
 * Claude app it was running in. Synthetic input is now refused when the window in front is an AI-assistant app the agent did
 * not focus or open on purpose (core/control.ts), on every OS: by process name, from one list (core/ai-hosts.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../core/banner', () => ({
  controlBanner: { overlayPids: () => [], showPaused: vi.fn(), showRunning: vi.fn(), canShow: () => true, touch: vi.fn() },
}));

import { __setControlDirForTests, __setForegroundReaderForTests } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';
import { AI_HOST_PROCESSES, isAiHostProcess } from '../core/ai-hosts';
import { classifyResult } from '../core/result-codes';

type Win = { processId: number; processName: string; title?: string };
const CLAUDE: Win = { processId: 200, processName: 'Claude' };
const CHATGPT: Win = { processId: 210, processName: 'ChatGPT.exe' };
const CODE: Win = { processId: 220, processName: 'Code' };
const NOTEPAD: Win = { processId: 300, processName: 'notepad', title: 'Untitled - Notepad' };

let fg: Win;
let dir: string;

function fakeDesktop() {
  const sent: string[] = [];
  const d = {
    sent,
    async keyPress(combo: string) { sent.push(`key ${combo}`); },
    async typeText(text: string) { sent.push(`type ${text}`); },
    async mouseClick(x: number, y: number) { sent.push(`click ${x},${y}`); },
    async mouseDrag(x: number, y: number) { sent.push(`drag ${x},${y}`); },
    async mouseScroll(x: number, y: number) { sent.push(`scroll ${x},${y}`); },
    async focusWindow(q: Win) { fg = q; return true; },
    async openApp(_name: string) { return { pid: CHATGPT.processId, title: 'ChatGPT' }; },
  };
  return guardInputMethods(d);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-aihost-'));
  __setControlDirForTests(dir);
  fg = CLAUDE;
  __setForegroundReaderForTests(async () => fg);
});
afterEach(() => {
  __setControlDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const REFUSAL = /the window in front is Claude, an AI assistant — nothing was sent\. Focus your target window first: window \{"action":"focus","title":"…"\}/;

describe('input into an AI assistant the agent did not choose', () => {
  it('the eval: type, a click and a key before any focus are refused, and nothing is sent', async () => {
    const d = fakeDesktop();
    await expect(d.typeText('hello')).rejects.toThrow(REFUSAL);
    await expect(d.mouseClick(5, 5)).rejects.toThrow(REFUSAL);
    await expect(d.keyPress('Return')).rejects.toThrow(REFUSAL);
    await expect(d.mouseDrag(1, 2)).rejects.toThrow(REFUSAL);
    await expect(d.mouseScroll(1, 2)).rejects.toThrow(REFUSAL);
    expect(d.sent).toEqual([]);
  });

  it('the agent focusing that app on purpose allows input, and keeps allowing it while it stays the window', async () => {
    const d = fakeDesktop();
    await d.focusWindow(CLAUDE);
    await d.typeText('hello');
    await d.keyPress('Return');
    expect(d.sent).toEqual(['type hello', 'key Return']);
  });

  it('opening the app on purpose allows input as well', async () => {
    fg = CHATGPT;
    const d = fakeDesktop();
    await d.openApp('ChatGPT');
    await d.typeText('hi');
    expect(d.sent).toEqual(['type hi']);
  });

  it('focusing another window first moves the work there; input goes to it', async () => {
    const d = fakeDesktop();
    await d.focusWindow(NOTEPAD);
    await d.typeText('note');
    expect(d.sent).toEqual(['type note']);
  });

  it('an app that is not an AI assistant is not touched by the guard', async () => {
    fg = NOTEPAD;
    const d = fakeDesktop();
    await d.typeText('plain');
    expect(d.sent).toEqual(['type plain']);
  });

  it('an editor host is covered too (VS Code reports "Code")', async () => {
    fg = CODE;
    const d = fakeDesktop();
    await expect(d.keyPress('ctrl+s')).rejects.toThrow(/the window in front is Code, an AI assistant/);
  });

  it('the refusal is classified, with a next call that exists', () => {
    const c = classifyResult('computer {"action":"type"}: the window in front is Claude, an AI assistant — nothing was sent. Focus your target window first: window {"action":"focus","title":"…"}', true, true);
    expect(c?.code).toBe('FOREGROUND_CHANGED');
    expect(c?.outcome).toBe('refused');
    expect(c?.next).toBe('window {"action":"list"}');
  });
});

describe('the AI-assistant list', () => {
  it('knows the hosts by process name on each OS, with or without a path or extension', () => {
    for (const n of ['Claude', 'claude.exe', 'ChatGPT', 'Codex', 'Cursor', 'Code', 'code-insiders', 'Windsurf', 'Zed', 'zeditor',
      'C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\Cursor.exe', '/Applications/Claude.app', '/usr/share/code/code']) {
      expect(isAiHostProcess(n), n).toBe(true);
    }
    for (const n of ['notepad', 'msedge', 'chrome', 'WindowsTerminal', 'Finder', 'gnome-terminal', undefined, null, '']) {
      expect(isAiHostProcess(n), String(n)).toBe(false);
    }
  });

  it('CLAWD_FOREGROUND_DENYLIST adds names', () => {
    process.env.CLAWD_FOREGROUND_DENYLIST = 'MyIDE, Other';
    try {
      expect(isAiHostProcess('myide.exe')).toBe(true);
      expect(isAiHostProcess('notepad')).toBe(false);
    } finally {
      delete process.env.CLAWD_FOREGROUND_DENYLIST;
    }
  });

  it('the Windows bridge raises none of the same apps: its list is this list', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'ps-bridge.ps1'), 'utf8');
    const m = /\$script:ForegroundDenylistProcs = @\(([^)]*)\)/.exec(ps);
    expect(m, 'ForegroundDenylistProcs not found in ps-bridge.ps1').not.toBeNull();
    const names = [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1].toLowerCase());
    expect(names.sort()).toEqual([...AI_HOST_PROCESSES].sort());
  });
});
