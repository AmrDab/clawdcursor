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
import { AI_HOST_PROCESSES, isAiHostProcess, __setHostAncestryForTests } from '../core/ai-hosts';
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

/** An input layer with by-name acts and a launch that can surface nothing, as all three adapters answer when no window was confirmed. */
function fakeLayer(opts: { launch?: { pid?: number; title?: string } } = {}) {
  const sent: string[] = [];
  const d = {
    sent,
    async typeText(text: string) { sent.push(`type ${text}`); },
    async invokeElement(q: { name: string; action?: string; processId?: number }) { sent.push(`${q.action ?? 'click'} ${q.name}`); return { success: true }; },
    async focusWindow(q: Win) { fg = q; return true; },
    async openApp(_name: string) { return opts.launch ?? {}; },
  };
  return guardInputMethods(d);
}

describe('a launch that surfaced no window excuses nothing it did not start', () => {
  it('open_app "Foo" that surfaces nothing, then type, with Claude in front: refused', async () => {
    const d = fakeLayer();
    await d.openApp('Foo');
    await expect(d.typeText('hello')).rejects.toThrow(REFUSAL);
    expect(d.sent).toEqual([]);
  });

  it('and not later either: the excuse is for the next input only', async () => {
    const d = fakeLayer();
    fg = NOTEPAD;
    await d.openApp('Foo');
    await d.typeText('a');
    fg = CLAUDE;
    await expect(d.typeText('b')).rejects.toThrow(/foreground changed|an AI assistant/);
    expect(d.sent).toEqual(['type a']);
  });

  it('launching the assistant itself, surfacing nothing yet, is asking for it', async () => {
    const d = fakeLayer();
    await d.openApp('Claude');
    await d.typeText('hi');
    expect(d.sent).toEqual(['type hi']);
  });
});

describe('by-name acts (accessibility invoke / set_value / toggle / select)', () => {
  it('with no process given and Claude in front they are refused, and nothing is sent', async () => {
    const d = fakeLayer();
    for (const action of ['click', 'set-value', 'toggle', 'select']) {
      await expect(d.invokeElement({ name: 'Message', action })).rejects.toThrow(REFUSAL);
    }
    await expect(d.invokeElement({ name: 'Message', processId: CLAUDE.processId })).rejects.toThrow(REFUSAL);
    expect(d.sent).toEqual([]);
  });

  it('a target in another process, a read, an explicit focus, and a non-assistant in front are all fine', async () => {
    const d = fakeLayer();
    await d.invokeElement({ name: 'OK', processId: NOTEPAD.processId });
    await d.invokeElement({ name: 'Message', action: 'get-value' });
    await d.focusWindow(CLAUDE);
    await d.invokeElement({ name: 'Message', action: 'set-value' });
    fg = NOTEPAD;
    await d.focusWindow(NOTEPAD);
    await d.invokeElement({ name: 'Save' });
    expect(d.sent).toEqual(['click OK', 'get-value Message', 'set-value Message', 'click Save']);
  });
});

describe('the host of this session, found by process ancestry (stdio)', () => {
  const TERMINAL: Win = { processId: 500, processName: 'WindowsTerminal' };
  afterEach(() => __setHostAncestryForTests(null));

  it('a window of a process this server was started from counts as an AI host, though no list names it', async () => {
    __setHostAncestryForTests([500, 400]);
    fg = TERMINAL;
    const d = fakeLayer();
    await expect(d.typeText('x')).rejects.toThrow(/the window in front is WindowsTerminal, an AI assistant — nothing was sent/);
    await d.focusWindow(TERMINAL);
    await d.typeText('x');
    expect(d.sent).toEqual(['type x']);
  });

  it('without ancestry (the HTTP daemon) only the list applies', async () => {
    fg = TERMINAL;
    const d = fakeLayer();
    await d.typeText('x');
    expect(d.sent).toEqual(['type x']);
  });
});

describe('a foreground the adapter only guessed at never blocks (Linux without xdotool)', () => {
  it('Claude as the first listed window, marked guessed: input goes through', async () => {
    __setForegroundReaderForTests(async () => ({ ...CLAUDE, guessed: true } as Win));
    const d = fakeLayer();
    await d.typeText('x');
    expect(d.sent).toEqual(['type x']);
  });
});

describe('the refusal and the list', () => {
  it('tells an agent whose target IS the assistant how to get in', async () => {
    const d = fakeLayer();
    await expect(d.typeText('x')).rejects.toThrow(/If this assistant's window IS your target, focus it with window focus and retry\./);
  });

  it('VS Code Insiders is "Code - Insiders" on Windows and macOS', () => {
    expect(isAiHostProcess('Code - Insiders.exe')).toBe(true);
    expect(isAiHostProcess('Code - Insiders')).toBe(true);
  });
});
