/**
 * #365: the session log names the app an act went to — also when that is not the window in front: a by-name act on a
 * background window (processId given), and a page act over CDP (the browser's own process).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { actedIn, actRecord, __setForegroundReaderForTests, __setWindowsReaderForTests } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';

const NOTEPAD = { processId: 42, processName: 'notepad', appName: 'Notepad', handle: 55 };
const WINDOWS = [
  NOTEPAD,
  { processId: 77, processName: 'chrome', appName: 'Google Chrome' },
  { processId: 38636, processName: 'ApplicationFrameHost', appName: 'Application Frame Host', hostedProcessId: 6768, hostedProcessName: 'CalculatorApp', hostedAppName: 'Calculator' },
];

afterEach(() => { __setForegroundReaderForTests(async () => null); __setWindowsReaderForTests(async () => []); });

describe('acts that do not go to the window in front name their own app', () => {
  it('a by-name act on a background process names that process, not the app in front', async () => {
    __setForegroundReaderForTests(async () => NOTEPAD);
    __setWindowsReaderForTests(async () => WINDOWS);
    const a11y = guardInputMethods({ invokeElement: async (_q: object) => ({ success: true }) });
    const before = actedIn();
    await a11y.invokeElement({ name: 'Search', action: 'click', processId: 77 });
    expect(actRecord(before)).toEqual({ app: 'Google Chrome', appPid: 77 });
    // a Store app by its own process: named as the app the frame hosts
    const again = actedIn();
    await a11y.invokeElement({ name: '7', action: 'click', processId: 6768 });
    expect(actRecord(again)).toEqual({ app: 'Calculator', appPid: 6768 });
  });

  it('a page act over CDP names the browser process the driver is connected to', async () => {
    __setForegroundReaderForTests(async () => NOTEPAD);
    __setWindowsReaderForTests(async () => WINDOWS);
    const cdp = guardInputMethods({ typeInField: async (_s: string, _t: string) => ({ success: true }) }, async () => 77);
    const before = actedIn();
    await cdp.typeInField('#q', 'hello');
    expect(actRecord(before)).toEqual({ app: 'Google Chrome', appPid: 77 });
  });

  it('no browser pid: nothing is recorded', async () => {
    const cdp = guardInputMethods({ click: async (_s: string) => ({ success: true }) }, async () => null);
    const before = actedIn();
    await cdp.click('#go');
    expect(actRecord(before)).toEqual({});
  });
});
