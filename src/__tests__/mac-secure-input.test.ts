/**
 * #267: `window focus` fails on macOS while a password field holds secure input. The focus read-back stays the assertion;
 * when it fails, secure input is checked and, if on, named with its holder. Unknown keeps today's message.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  Button: { LEFT: 0 },
  Point: class { constructor(public x: number, public y: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { MacOSAdapter } from '../platform/macos';
import { MacAxError, type MacAx, type FrontmostInfo } from '../platform/mac-ax';
import {
  checkSecureInput, parseSecureInputPid, appNameFromCommand, secureInputMessage, SECURE_INPUT_JXA,
  type SecureInputDeps, type SecureInputState,
} from '../platform/mac-secure-input';
import { classifyResult } from '../core/result-codes';
import type { WindowInfo } from '../platform/types';

const IOREG = '  | |   "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=412,"kCGSSessionUserNameKey"="amr"})\n';
const PS = '/Applications/1Password.app/Contents/MacOS/1Password\n';

/** A fake exec keyed by command; a value of Error is thrown. */
function fakeExec(replies: Record<string, string | Error>): SecureInputDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(file) {
      calls.push(file);
      const r = replies[file];
      if (r === undefined) throw new Error(`unexpected ${file}`);
      if (r instanceof Error) throw r;
      return { stdout: r };
    },
  };
}

describe('checkSecureInput', () => {
  it('on, with a holder: the pid from ioreg, the name from its executable', async () => {
    const d = fakeExec({ osascript: 'true\n', ioreg: IOREG, ps: PS });
    await expect(checkSecureInput(d)).resolves.toEqual({ on: true, holder: { pid: 412, name: '1Password' } });
  });

  it('off: no ioreg spawn at all (the pid is only looked up when building the error)', async () => {
    const d = fakeExec({ osascript: 'false\n' });
    await expect(checkSecureInput(d)).resolves.toEqual({ on: false });
    expect(d.calls).toEqual(['osascript']);
  });

  it('ioreg failing: secure input is still named, without a holder', async () => {
    const d = fakeExec({ osascript: 'true', ioreg: new Error('timed out') });
    await expect(checkSecureInput(d)).resolves.toEqual({ on: true });
  });

  it('ioreg with no pid in it: on, no holder', async () => {
    const d = fakeExec({ osascript: 'true', ioreg: '"kCGSSessionUserIDKey" = 501' });
    await expect(checkSecureInput(d)).resolves.toEqual({ on: true });
  });

  it('ps failing: the pid is kept, the name is not', async () => {
    const d = fakeExec({ osascript: 'true', ioreg: IOREG, ps: new Error('no such process') });
    await expect(checkSecureInput(d)).resolves.toEqual({ on: true, holder: { pid: 412, name: undefined } });
  });

  it('a JXA bind error ("is not a function") is unknown, not "off"', async () => {
    const d = fakeExec({ osascript: new Error('execution error: Error: $.IsSecureEventInputEnabled is not a function. (-2700)') });
    await expect(checkSecureInput(d)).resolves.toBeNull();
    expect(d.calls).toEqual(['osascript']);
  });

  it('output that is neither true nor false is unknown', async () => {
    await expect(checkSecureInput(fakeExec({ osascript: '' }))).resolves.toBeNull();
    await expect(checkSecureInput(fakeExec({ osascript: 'undefined' }))).resolves.toBeNull();
  });

  it('binds the function by hand, as PREFLIGHT_JXA does for CGPreflightScreenCaptureAccess', () => {
    expect(SECURE_INPUT_JXA).toContain("ObjC.bindFunction('IsSecureEventInputEnabled', ['bool', []])");
    expect(SECURE_INPUT_JXA).toContain('String(Boolean(');
  });
});

describe('parsing', () => {
  it('finds the pid, and nothing in output without the key', () => {
    expect(parseSecureInputPid(IOREG)).toBe(412);
    expect(parseSecureInputPid('    | |   "kCGSSessionSecureInputPID" = 412\n')).toBe(412);   // spaced form
    expect(parseSecureInputPid('"kCGSSessionSecureInputPID" = 0')).toBeNull();
    expect(parseSecureInputPid('')).toBeNull();
  });

  it('fast user switching: several sessions, the first says 0 — the first pid above 0 is the holder', () => {
    const two = '"IOConsoleUsers" = ({"kCGSSessionSecureInputPID"=0,"kCGSSessionUserNameKey"="guest"},' +
      '{"kCGSSessionSecureInputPID"=412,"kCGSSessionUserNameKey"="amr"})';
    expect(parseSecureInputPid(two)).toBe(412);
  });

  it('names an app by its bundle, else by the executable', () => {
    expect(appNameFromCommand('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n')).toBe('Google Chrome');
    expect(appNameFromCommand('/usr/bin/sudo')).toBe('sudo');
    expect(appNameFromCommand('')).toBeUndefined();
  });
});

describe('the message', () => {
  it('names the holder and what to do', () => {
    expect(secureInputMessage({ pid: 412, name: '1Password' })).toBe(
      'secure input is on (held by 1Password, pid 412): macOS sends keys and focus only to it. ' +
      'Close or leave the password field in 1Password, then try again.');
  });

  it('without a name, still the pid; without a holder, still the cause', () => {
    expect(secureInputMessage({ pid: 412 })).toMatch(/held by pid 412/);
    expect(secureInputMessage()).toMatch(/^secure input is on \(the app holding it could not be found\)/);
  });

  it('is classified SECURE_INPUT, with a pause as the next step', () => {
    const c = classifyResult(secureInputMessage({ pid: 412, name: '1Password' }), true, true);
    expect(c).toMatchObject({ code: 'SECURE_INPUT', outcome: 'refused' });
    expect(c?.next).toContain('pause_for_user');
    expect(c?.next).toContain('Leave the password field in');
  });
});

// ─── through the adapter ────────────────────────────────────────────────────

const WIN = (over: Partial<WindowInfo> = {}): WindowInfo =>
  ({ title: 'Untitled', processName: 'Notes', processId: 77, bounds: { x: 0, y: 0, width: 600, height: 400 }, isMinimized: false, handle: 77, ...over });
const FRONT = (name: string, processId: number): FrontmostInfo => ({ locked: false, app: { name, processId, activationPolicy: 'regular', windows: [] } });
const READBACK = 'focusing failed: focus went to Google Chrome (pid 935), not to Notes (pid 77)';

function adapter(secureInput: () => Promise<SecureInputState | null>, focus: () => Promise<unknown> = async () => { throw new MacAxError('failed', READBACK); }) {
  const ax = {
    listWindows: vi.fn(async () => [WIN()]),
    listWindowsDetailed: vi.fn(async () => ({ windows: [WIN()], skipped: [] })),
    focusWindow: vi.fn(focus),
    frontmost: vi.fn(async () => FRONT('Google Chrome', 935)),
    appState: vi.fn(async () => null),
    prepare: vi.fn(),
  } as unknown as MacAx;
  return new MacOSAdapter({ ax, secureInput });
}

describe('focusWindow when the read-back fails', () => {
  it('secure input on with a holder: the typed SECURE_INPUT message, the read-back kept after it', async () => {
    const mac = adapter(async () => ({ on: true, holder: { pid: 412, name: '1Password' } }));
    await expect(mac.focusWindow({ processId: 77 })).resolves.toBe(false);
    const failure = mac.takeFocusFailure()!;
    expect(failure).toMatch(/^secure input is on \(held by 1Password, pid 412\): macOS sends keys and focus only to it\. Close or leave the password field in 1Password, then try again\./);
    expect(failure).toContain('focus went to Google Chrome (pid 935)');
    expect(classifyResult(failure, true, true)?.code).toBe('SECURE_INPUT');
  });

  it('secure input off: today\'s message, unchanged', async () => {
    const mac = adapter(async () => ({ on: false }));
    await mac.focusWindow({ processId: 77 });
    expect(mac.takeFocusFailure()).toBe(READBACK);
  });

  it('ioreg failing: secure input is named without a holder', async () => {
    const d = fakeExec({ osascript: 'true', ioreg: new Error('boom') });
    const mac = adapter(() => checkSecureInput(d));
    await mac.focusWindow({ processId: 77 });
    expect(mac.takeFocusFailure()).toMatch(/^secure input is on \(the app holding it could not be found\)/);
  });

  it('a JXA bind error: unknown, so today\'s message', async () => {
    const d = fakeExec({ osascript: new Error('$.IsSecureEventInputEnabled is not a function') });
    const mac = adapter(() => checkSecureInput(d));
    await mac.focusWindow({ processId: 77 });
    expect(mac.takeFocusFailure()).toBe(READBACK);
  });

  it('a check that throws never reaches the focus path', async () => {
    const mac = adapter(async () => { throw new Error('boom'); });
    await expect(mac.focusWindow({ processId: 77 })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toBe(READBACK);
  });

  it('the fallback path\'s read-back (no helper) is explained the same way', async () => {
    const mac = adapter(async () => ({ on: true, holder: { pid: 412, name: '1Password' } }), async () => null);
    const exec = await import('child_process');
    (exec.execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) => cb(null, { stdout: '{"success":true}', stderr: '' }));
    await expect(mac.focusWindow({ processId: 77 })).resolves.toBe(false);
    expect(mac.takeFocusFailure()).toMatch(/^secure input is on \(held by 1Password, pid 412\)/);
  });

  it('is not asked when the focus worked or failed for another reason', async () => {
    const check = vi.fn(async () => ({ on: true as const }));
    const ok = adapter(check, async () => ({ title: 'w', processId: 77, processName: 'Notes' }));
    await expect(ok.focusWindow({ processId: 77 })).resolves.toBe(true);
    const other = adapter(check, async () => { throw new MacAxError('failed', 'focusing failed: Notes (pid 77) has no window with a title containing "x"'); });
    await other.focusWindow({ processId: 77, title: 'x' });
    expect(check).not.toHaveBeenCalled();
  });
});
