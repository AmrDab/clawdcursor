/**
 * macOS keyPress builds an AppleScript program from the caller's key combo.
 * An unknown key or modifier used to be spliced in raw, so a crafted name could
 * close the string literal and run arbitrary AppleScript (`do shell script`),
 * bypassing the key blocklist and safety gate. Unknown tokens are now refused
 * before osascript runs (parity with the Windows adapter), and the numbers that
 * reach window scripts are coerced. Valid combos must be unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    execFileCalls.push({ cmd, args });
    cb(null, { stdout: '10,20,800,600', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { MacOSAdapter } from '../platform/macos';

const mac = new MacOSAdapter();
const scripts = () => execFileCalls.filter(c => c.cmd === 'osascript').map(c => c.args[c.args.indexOf('-e') + 1]);

beforeEach(() => { execFileCalls.length = 0; });

describe('macOS keyPress refuses tokens it cannot represent safely', () => {
  it.each([
    ['unknown multi-char key carrying AppleScript', 'x" & (do shell script "touch /tmp/pwned") & "'],
    ['unknown modifier carrying AppleScript', 'cmd" & (do shell script "id") & "+a'],
    ['plain unknown key name', 'notarealkey'],
  ])('%s → throws, and nothing is sent to osascript', async (_label, combo) => {
    await expect(mac.keyPress(combo)).rejects.toThrow(/Unknown (key|modifier)/);
    expect(scripts()).toEqual([]);
  });
});

describe('macOS keyPress — valid combos emit the same AppleScript as before', () => {
  it.each([
    ['cmd+shift+t', 'tell application "System Events" to keystroke "t" using {command down, shift down}'],
    ['mod+a', 'tell application "System Events" to keystroke "a" using {command down}'],
    ['Return', 'tell application "System Events" to key code 36'],
    ['ctrl+alt+"', 'tell application "System Events" to keystroke "\\"" using {control down, option down}'],
  ])('%s', async (combo, script) => {
    await mac.keyPress(combo);
    expect(scripts()).toEqual([script]);
  });
});

describe('macOS window scripts coerce interpolated numbers', () => {
  it('a non-numeric processId cannot inject into the target clause', async () => {
    await mac.setWindowState('minimize', { processId: '1) & (do shell script "id") & (1' as unknown as number });
    const s = scripts().join('\n');
    expect(s).not.toContain('do shell script');
    expect(s).toContain('unix id is NaN');
  });
  it('setWindowBounds emits plain integers', async () => {
    await mac.setWindowBounds({ x: 10.6, y: 20, width: 800, height: 600 }, { processName: 'Notes' });
    expect(scripts().pop()).toContain('set position to {11, 20}');
  });
});
