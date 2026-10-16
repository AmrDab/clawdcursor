/**
 * The two things every macOS keystroke path shares (src/platform/mac-keyboard.ts):
 *
 *  - who owns the keyboard right now (B11). The guard lived inside MacOSAdapter, but the MCP tools `type_text` / `key_press`
 *    go through NativeDesktop — a second, separate macOS keyboard — so the one route Claude Code uses never asked.
 *  - how a keystroke program reaches osascript. `osascript -e '… keystroke "<the typed text>"'` put the text on argv,
 *    readable by every process on the Mac for as long as osascript ran; it now goes on stdin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FrontmostInfo } from '../platform/mac-ax';

const spawned: Array<{ cmd: string; args: string[]; opts: any; stdin: string[]; stdinListeners: string[] }> = [];
let osascriptFails: Error | null = null;
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: (e: unknown, r?: unknown) => void) => {
    const rec = { cmd, args, opts, stdin: [] as string[], stdinListeners: [] as string[] };
    spawned.push(rec);
    // the process "runs" once its stdin has been closed — like osascript reading its program to EOF
    const child = {
      stdin: {
        on: (ev: string) => { rec.stdinListeners.push(ev); },
        end: (data?: string) => { if (data !== undefined) rec.stdin.push(data); queueMicrotask(() => (osascriptFails ? cb(osascriptFails) : cb(null, { stdout: '', stderr: '' }))); },
      },
    };
    return child;
  },
  spawn: vi.fn(),
}));

import { MacKeyboardGuard, runAppleScript, isBareEscape } from '../platform/mac-keyboard';
import { logger } from '../core/observability/logger';

const front = (over: Record<string, unknown> = {}): FrontmostInfo => ({
  locked: false,
  app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', processId: 1, activationPolicy: 'regular', windows: [], ...over } as FrontmostInfo['app'],
});
const ALERT = front({ name: 'UserNotificationCenter', bundleId: 'com.apple.UserNotificationCenter', processId: 311, activationPolicy: 'accessory', windows: [{ title: 'Foo wants access', subrole: 'AXSystemDialog' }] });
const MODAL = front({ name: 'SomeAgent', bundleId: 'com.example.agent', processId: 9, activationPolicy: 'accessory', windows: [{ title: 'Allow access?', subrole: 'AXDialog', modal: true }] });

beforeEach(() => {
  spawned.length = 0;
  osascriptFails = null;
  process.env.CLAWD_NO_MAC_AX = '0';
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  process.env.CLAWD_NO_MAC_AX = '1';
  vi.restoreAllMocks();
});

describe('runAppleScript — the program travels on stdin', () => {
  it('osascript gets NO arguments: the typed text is not on argv', async () => {
    await runAppleScript('tell application "System Events" to keystroke "hunter2 s3cret"', 5_000);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe('osascript');
    expect(spawned[0].args).toEqual([]);
    expect(JSON.stringify(spawned[0].args)).not.toContain('hunter2');
  });

  it('the program is written to stdin, whole, and stdin is closed (osascript reads to EOF)', async () => {
    const script = 'tell application "System Events" to keystroke "héllo 日本語 \\"quoted\\""';
    await runAppleScript(script, 5_000);
    expect(spawned[0].stdin).toEqual([script]);
  });

  it('passes the timeout to the process', async () => {
    await runAppleScript('return 1', 4_321);
    expect(spawned[0].opts.timeout).toBe(4_321);
  });

  it('rejects when osascript fails (callers decide what that means)', async () => {
    osascriptFails = Object.assign(new Error('Command failed: osascript'), { code: 1 });
    await expect(runAppleScript('return 1', 5_000)).rejects.toThrow(/osascript/);
  });

  it('a process that exits before reading its stdin is not an error of ours (EPIPE is swallowed)', async () => {
    await runAppleScript('return 1', 5_000);
    expect(spawned[0].stdinListeners).toContain('error');
  });
});

describe('isBareEscape', () => {
  it.each(['Escape', 'esc', 'ESCAPE', ' Esc '])('%s is the bare key', k => expect(isBareEscape(k)).toBe(true));
  it.each(['cmd+Escape', 'Return', 'esc esc', '', undefined])('%s is not', k => expect(isBareEscape(k as string | undefined)).toBe(false));
});

describe('MacKeyboardGuard — who owns the keyboard', () => {
  const guard = (frontmost: () => Promise<FrontmostInfo>) => new MacKeyboardGuard({ frontmost });

  it('a normal app: keys go through, with no warning', async () => {
    await expect(guard(async () => front()).assert()).resolves.toEqual({});
  });

  it('a system dialog refuses, with the explanation naming it', async () => {
    await expect(guard(async () => ALERT).assert('Return')).rejects.toThrow(/UserNotificationCenter/);
  });

  it('a locked screen refuses with an unlock hint', async () => {
    await expect(guard(async () => ({ locked: true, app: null })).assert()).rejects.toThrow(/unlock/i);
  });

  it('a bare Escape is never checked — not even asked: it cancels, an agent needs it to dismiss the very dialog in the way', async () => {
    const frontmost = vi.fn(async () => ALERT);
    const g = guard(frontmost);
    await expect(g.assert('Escape')).resolves.toEqual({});
    await expect(g.assert('esc')).resolves.toEqual({});
    expect(frontmost).not.toHaveBeenCalled();
    await expect(g.assert('cmd+Escape')).rejects.toThrow();     // a combo that merely contains it is not the bare key
  });

  it('probes once for a burst of keystrokes, but again on every call while blocked', async () => {
    const ok = vi.fn(async () => front());
    const g1 = guard(ok);
    await g1.assert('a'); await g1.assert('b'); await g1.assert('c');
    expect(ok).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await g1.assert('d');
    expect(ok).toHaveBeenCalledTimes(2);

    const blocked = vi.fn(async () => ALERT);
    const g2 = guard(blocked);
    await g2.assert('a').catch(() => {}); await g2.assert('b').catch(() => {});
    expect(blocked).toHaveBeenCalledTimes(2);
  });

  it('a failed probe never blocks input (fail open)', async () => {
    await expect(guard(async () => { throw new Error('timed out'); }).assert()).resolves.toEqual({});
  });

  it('CLAWD_NO_MAC_AX=1 turns the guard off along with the helper', async () => {
    process.env.CLAWD_NO_MAC_AX = '1';
    const frontmost = vi.fn(async () => ALERT);
    await expect(guard(frontmost).assert('Return')).resolves.toEqual({});
    expect(frontmost).not.toHaveBeenCalled();
  });

  describe('a modal dialog of an app that is not a system prompt', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(logger, 'warn').mockImplementation(() => {}); });

    it('is typed into, and the caller is told whose dialog it is', async () => {
      const r = await guard(async () => MODAL).assert();
      expect(r.warning).toMatch(/SomeAgent/);
      expect(r.warning).toMatch(/Allow access\?/);
    });

    it('the warning keeps coming back while the cached probe is trusted — a second keystroke 100 ms later is just as much in that dialog', async () => {
      const g = guard(async () => MODAL);
      const first = await g.assert();
      await vi.advanceTimersByTimeAsync(100);
      expect((await g.assert()).warning).toBe(first.warning);
    });

    it('is logged once per dialog, not once per probe', async () => {
      const g = guard(async () => MODAL);
      await g.assert();
      await vi.advanceTimersByTimeAsync(300);               // past the probe cache: a new probe, same dialog
      await g.assert();
      expect(warn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(11_000);            // long enough to say it again
      await g.assert();
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('strict (the launch plumbing) refuses it, and never trusts a cached "fine" that was only a warning', async () => {
      const g = guard(async () => MODAL);
      await g.assert();                                      // caches a warned probe
      await expect(g.assert(undefined, { strict: true })).rejects.toThrow(/SomeAgent/);
    });

    it('strict still lets a clean desktop through', async () => {
      await expect(guard(async () => front()).assert(undefined, { strict: true })).resolves.toEqual({});
    });

    it('owner() reports the problem without throwing, for callers that word it themselves', async () => {
      expect((await guard(async () => ALERT).owner()).error?.message).toMatch(/UserNotificationCenter/);
      expect((await guard(async () => MODAL).owner({ strict: true })).error?.message).toMatch(/SomeAgent/);
      expect((await guard(async () => front()).owner()).error).toBeNull();
    });
  });
});
