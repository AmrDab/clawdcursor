/**
 * Plan (h) step 2: the lease grows from one window into a small set of agent windows (control.ts agentWindows): the ones the
 * agent opened, focused or acted in by name. Input into any of them is allowed whichever is in front; any other window in
 * front, the user's, is still refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { agentWindows, isAgentWindow, workingWindow, __setForegroundReaderForTests, __setControlDirForTests } from '../core/control';
import { guardInputMethods, setOwnUiPids } from '../platform/pointer-guard';

vi.mock('../core/banner', () => ({
  controlBanner: { overlayPids: () => [], showPaused: vi.fn(), showRunning: vi.fn(), canShow: () => true, whenCanShow: async () => true, touch: vi.fn() },
}));

type Win = { processId: number; processName: string; handle?: number; title?: string };
const EDGE: Win = { processId: 100, processName: 'msedge', handle: 0x5a0 };
const NOTEPAD: Win = { processId: 300, processName: 'notepad', handle: 0x7b2 };
const USER: Win = { processId: 200, processName: 'spotify', handle: 0x111 };

let fg: Win;
function desktop() {
  const sent: string[] = [];
  return guardInputMethods({
    sent,
    async keyPress(k: string) { sent.push(`key ${k}`); },
    async focusWindow(q: Win) { fg = q; return true; },
    async invokeElement(q: { name: string; processId?: number }) { sent.push(`invoke ${q.name}`); return { success: true }; },
  });
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); fg = EDGE; __setControlDirForTests(null); __setForegroundReaderForTests(async () => fg); });
afterEach(() => vi.useRealTimers());

describe('the agent windows', () => {
  it('none before the agent has acted: the user\'s window in front is nobody\'s target', () => {
    expect(agentWindows()).toEqual([]);
    expect(isAgentWindow({ processId: 100 })).toBe(false);
  });

  it('a window the agent worked in stays in the set after it moved on to another', async () => {
    const d = desktop();
    await d.keyPress('a');
    await d.focusWindow(NOTEPAD);
    await d.keyPress('b');
    expect(agentWindows().map(w => w.processId).sort()).toEqual([100, 300]);
    expect(isAgentWindow({ handle: 0x5a0 })).toBe(true);
    expect(isAgentWindow({ processId: 300 })).toBe(true);
    expect(isAgentWindow({ processId: 200 })).toBe(false);
  });

  it('input is accepted in any agent window that is in front, refused in a window that is not in the set', async () => {
    const d = desktop();
    await d.keyPress('a');
    await d.focusWindow(NOTEPAD);
    await d.keyPress('b');
    vi.advanceTimersByTime(10_000);
    fg = EDGE;                                   // the other agent window comes to the front (the user clicked it)
    await d.keyPress('c');
    expect(d.sent).toEqual(['key a', 'key b', 'key c']);
    vi.advanceTimersByTime(10_000);
    fg = USER;
    await expect(d.keyPress('d')).rejects.toThrow(/foreground changed/);
    expect(isAgentWindow({ processId: 200 })).toBe(false);
  });

  it('an act by name on a process in the background makes that process an agent window', async () => {
    const d = desktop();
    await d.invokeElement({ name: 'OK', processId: 300 });
    expect(isAgentWindow({ processId: 300 })).toBe(true);
    expect(isAgentWindow({ processId: 100 })).toBe(false);
  });
});

describe('clawdcursor\'s own windows are never the agent\'s', () => {
  const PILL: Win = { processId: 777, processName: 'powershell', handle: 0x9f0 };
  beforeEach(() => setOwnUiPids(() => [777]));
  afterEach(() => setOwnUiPids(() => []));

  it('an act by name while the pill is in front (the user clicked or dragged it) does not make it the working or an agent window', async () => {
    const d = desktop();
    await d.invokeElement({ name: 'Save', processId: 100 });
    fg = PILL;
    await d.invokeElement({ name: 'Save' });
    expect(workingWindow()).toEqual({ processId: 100, handle: 0x5a0 });
    expect(agentWindows().map(w => w.processId)).toEqual([100]);
    expect(isAgentWindow({ handle: 0x9f0 })).toBe(false);
  });

  it('an act by name on the overlay\'s own process, or a focus of it, is not remembered either', async () => {
    const d = desktop();
    await d.invokeElement({ name: 'Stop', processId: 777 });
    await d.focusWindow(PILL);
    await d.invokeElement({ name: 'x', processId: 100 });
    expect(agentWindows().map(w => w.processId)).toEqual([100]);
    expect(isAgentWindow({ processId: 777 })).toBe(false);
  });
});
