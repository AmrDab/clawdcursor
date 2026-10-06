/**
 * macOS window-state behavior — companion to the Windows #153 fix.
 *
 * #153 (Windows minimize/resize silently failed) was a PowerShell-only defect: a
 * here-string header is illegal in a single-line `powershell.exe -Command` string,
 * so the script failed to PARSE and returned false. macOS uses a completely
 * different path — `osascript -e <AppleScript>` — where each `-e` is a full program
 * (newlines allowed) and there is no here-string concept, so that class of bug
 * cannot occur here. These tests assert the macOS path emits the correct
 * AppleScript and runs it as a single osascript program (the mac-equivalent
 * "can't be mis-parsed" guarantee), and guard the AppleScript string-escaping
 * (#136) at the same time.
 *
 * NB: this verifies command GENERATION, not OS behavior — AXMinimized/AXZoom etc.
 * still want a real-Mac smoke check, but a Mac isn't available in CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// macos.ts pulls in nut-js + sharp at module load — stub them like the other
// platform tests do so the module imports under Node/Windows test runners.
vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

// Capture every osascript invocation. promisify(execFile) resolves to the value
// passed as the callback's 2nd arg, so hand back { stdout, stderr }.
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
    execFileCalls.push({ cmd, args });
    // setWindowBounds reads current position/size first — feed it a parseable rect.
    cb(null, { stdout: '10,20,800,600', stderr: '' });
  },
  spawn: vi.fn(),
}));

import { MacOSAdapter } from '../platform/macos';

/** The AppleScript program is always the last `-e` argument. */
function lastScript(): string {
  const osa = execFileCalls.filter(c => c.cmd === 'osascript');
  const args = osa[osa.length - 1].args;
  return args[args.indexOf('-e') + 1];
}
/** Every osascript call must pass exactly one program via a single -e arg. */
function eachCallIsSingleProgram(): boolean {
  // Only inline AppleScript programs (-e); a JXA script file (e.g. the window
  // list a title lookup reads) carries no program text to mis-parse.
  return execFileCalls
    .filter(c => c.cmd === 'osascript' && c.args.includes('-e'))
    .every(c => c.args.filter(a => a === '-e').length === 1);
}

const mac = new MacOSAdapter();

beforeEach(() => { execFileCalls.length = 0; });

describe('macOS setWindowState — correct AppleScript per state', () => {
  it('minimize sets AXMinimized to true', async () => {
    const ok = await mac.setWindowState('minimize', { title: 'Calculator' });
    expect(ok).toBe(true);
    expect(lastScript()).toContain('set value of attribute "AXMinimized" to true');
  });

  it('restore (normal) sets AXMinimized to false', async () => {
    const ok = await mac.setWindowState('normal', { title: 'Calculator' });
    expect(ok).toBe(true);
    expect(lastScript()).toContain('set value of attribute "AXMinimized" to false');
  });

  it('a title-only target resolves its app from the window list and addresses that window', async () => {
    // Live macOS run (GitHub-hosted Mac, 2026-10): resize / minimize / restore
    // by title all failed — `first window whose title contains "X" of
    // (process)` binds `of (process)` to "X", and a nested `whose` over every
    // process is not valid AppleScript either. Resolve via the window list.
    const spy = vi.spyOn(mac, 'listWindows').mockResolvedValue([{ processId: 77, title: 'CC Target', processName: 'cctarget' }] as never);
    try {
      await mac.setWindowState('minimize', { title: 'CC Target' });
      expect(lastScript()).toContain('tell window "CC Target" of (first application process whose unix id is 77) to set value of attribute "AXMinimized" to true');
    } finally { spy.mockRestore(); }
  });

  it('with no window-list match, the fallback clause is valid AppleScript (container before `whose`)', async () => {
    const spy = vi.spyOn(mac, 'listWindows').mockResolvedValue([] as never);
    try {
      await mac.setWindowState('minimize', { title: 'CC Target' });
      expect(lastScript()).toContain('tell (first window of (first application process whose frontmost is true) whose title contains "CC Target")');
      expect(lastScript()).not.toMatch(/whose title contains "CC Target" of/);
    } finally { spy.mockRestore(); }
  });

  it('maximize clicks the AXZoomButton', async () => {
    await mac.setWindowState('maximize', { title: 'Calculator' });
    expect(lastScript()).toContain('AXZoomButton');
  });

  it('close clicks the AXCloseButton', async () => {
    await mac.setWindowState('close', { title: 'Calculator' });
    expect(lastScript()).toContain('AXCloseButton');
  });

  it('runs each state change as a single osascript program (no mis-parse risk)', async () => {
    await mac.setWindowState('minimize', { title: 'Notes' });
    expect(eachCallIsSingleProgram()).toBe(true);
  });
});

describe('macOS setWindowBounds — reads then assigns position + size', () => {
  it('emits AXPosition + AXSize, preserving unspecified dims from the current rect', async () => {
    const ok = await mac.setWindowBounds({ x: 100, y: 200 }, { title: 'Calculator' });
    expect(ok).toBe(true);
    const script = lastScript();
    // x/y supplied; w/h fall back to the read rect (800x600).
    expect(script).toContain('set position to {100, 200}');
    expect(script).toContain('set size to {800, 600}');
  });
});

describe('macOS AppleScript string-escaping (#136 regression guard)', () => {
  it('escapes embedded quotes and backslashes in the window title', async () => {
    await mac.setWindowState('minimize', { processName: 'Safari', title: 'a"b\\c' });
    const script = lastScript();
    // The title must be embedded with its quote and backslash escaped, never raw.
    expect(script).toContain('a\\"b\\\\c');
    expect(script).not.toMatch(/window "a"b/); // raw unescaped quote would break the script
  });
});
