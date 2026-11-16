/**
 * A `window focus` the input guard cannot recognise refuses every input after it (control.ts matches()):
 *  - the test fence pins a focus to the one window it matched, by its handle alone (fence.ts, #394). The guard compared
 *    only pid, name and title, so the next input was refused with `you focused "pid undefined"`, and focusing again
 *    re-armed the same query: a loop (benchmark 2026-11-15).
 *  - a Store app focused by its own name ("Calculator", #408) is in front as its ApplicationFrameHost frame, and the
 *    guard compared that name with the frame's process only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __setForegroundReaderForTests, workingWindow } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';

type Win = { processId: number; processName: string; title: string; handle: number; appName?: string; hostedProcessId?: number; hostedProcessName?: string };
const EDGE: Win = { processId: 16416, processName: 'msedge', title: 'New tab - Microsoft Edge', handle: 0x5a0 };
const FORM: Win = { processId: 200, processName: 'BenchForm', title: 'Bench Form', handle: 7001 };
// A Store app's window belongs to ApplicationFrameHost; the app is the process the frame hosts (frame-host.ts).
const CALC: Win = { processId: 9000, processName: 'ApplicationFrameHost', appName: 'Calculator', hostedProcessId: 38636, hostedProcessName: 'CalculatorApp', title: 'Calculator', handle: 0x9c4 };

let fg: Win;
beforeEach(() => { fg = EDGE; __setForegroundReaderForTests(async () => fg); });

describe('window focus by handle, and a Store app by its own name', () => {
  it('a focus by window handle (the fence pins one) binds the next input to that window', async () => {
    const sent: string[] = [];
    const d = guardInputMethods({ async keyPress(k: string) { sent.push(`key ${k}`); }, async focusWindow(_q: { handle?: number }) { fg = FORM; return true; } });
    expect(await d.focusWindow({ handle: 7001 })).toBe(true);
    await d.keyPress('a');   // was: 'foreground changed: you focused "pid undefined", but "BenchForm" (pid 200) is in front'
    expect(sent).toEqual(['key a']);
    expect(workingWindow()).toEqual({ processId: 200, handle: 7001 });
  });

  it('window focus by a Store app name (focused through its frame by handle, windows.ts) then a key: the key goes to it', async () => {
    const sent: string[] = [];
    const d = guardInputMethods({
      async keyPress(k: string) { sent.push(`key ${k}`); },
      // As the Windows adapter does: the name finds the app's frame, which is then focused by its handle.
      async focusWindow(q: { processName?: string; handle?: number }): Promise<boolean> {
        if (q.processName) return this.focusWindow({ handle: CALC.handle });
        fg = CALC;
        return true;
      },
    });
    expect(await d.focusWindow({ processName: 'Calculator' })).toBe(true);
    await d.keyPress('1');   // was: 'you focused "Calculator", but "Calculator" (pid 38636) is in front'
    expect(sent).toEqual(['key 1']);
    expect(workingWindow()).toEqual({ processId: 9000, handle: 0x9c4 });
  });

  it('a focus by handle is that one window: another window of the same process in front is refused', async () => {
    const sent: string[] = [];
    const other: Win = { ...FORM, title: 'Bench Form - Options', handle: 7002 };
    const d = guardInputMethods({ async keyPress(k: string) { sent.push(`key ${k}`); }, async focusWindow(_q: { handle?: number }) { fg = other; return true; } });
    expect(await d.focusWindow({ handle: 7001 })).toBe(true);
    await expect(d.keyPress('a')).rejects.toThrow('foreground changed: you focused "window 7001", but "BenchForm" (pid 200) is in front — nothing was sent.');
    expect(sent).toEqual([]);
  });
});
