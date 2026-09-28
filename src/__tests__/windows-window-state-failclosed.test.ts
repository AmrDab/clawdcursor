/**
 * Windows setWindowState must FAIL CLOSED on an unresolvable selector.
 *
 * Found by driving clawdcursor for real. A caller that named a window whose
 * name matched NOTHING used to fall through to `GetForegroundWindow()`, so
 * `window({action:'close', title:'Calculator'})` with no Calculator open
 * posted WM_CLOSE to whatever happened to be in front — the user's unsaved
 * document, or the agent's own host window. Asking for a specific window and
 * silently getting a different one is never the right answer.
 *
 * Linux already did this correctly (`if (!target) return false`) and macOS
 * fails closed via AppleScript throwing into its catch; Windows was the only
 * adapter with the fall-through. These tests pin that parity.
 *
 * Verifies TARGET RESOLUTION, not OS behavior: the assertion is that no
 * PowerShell runs at all when the selector cannot be resolved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

// setWindowState shells out via promisify(execFile)('powershell.exe', ...).
// promisify resolves to the callback's 2nd arg, so hand back {stdout,stderr}.
const psCalls: Array<{ cmd: string; args: string[] }> = [];
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _o: unknown, cb: (e: unknown, r: unknown) => void) => {
    psCalls.push({ cmd, args });
    cb(null, { stdout: 'True', stderr: '' });
  },
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

import { WindowsAdapter } from '../platform/windows';

describe('WindowsAdapter.setWindowState — fail closed on an unresolvable selector', () => {
  let adapter: WindowsAdapter;

  beforeEach(() => {
    psCalls.length = 0;
    adapter = new WindowsAdapter();
    // No window ever matches.
    vi.spyOn(adapter as never as { resolveWindow: () => unknown }, 'resolveWindow')
      .mockResolvedValue(undefined as never);
  });

  it.each(['close', 'minimize', 'maximize', 'normal'] as const)(
    'returns false for %s and runs NO PowerShell when a title matches nothing',
    async (state) => {
      const ok = await adapter.setWindowState(state, { title: 'NoSuchWindow' });
      expect(ok).toBe(false);
      expect(psCalls).toHaveLength(0);
    },
  );

  it('does not fall through to the foreground window for an unmatched processName', async () => {
    const ok = await adapter.setWindowState('close', { processName: 'nosuchapp' });
    expect(ok).toBe(false);
    expect(psCalls).toHaveLength(0);
  });

  it('still targets the foreground window when NO selector was supplied', async () => {
    // Omitting the query is an explicit "act on whatever is in front" request,
    // which stays valid — only a selector that RESOLVED TO NOTHING fails.
    await adapter.setWindowState('minimize');
    expect(psCalls.length).toBeGreaterThan(0);
  });

  it('an empty selector object is treated as no selector, not as a failed match', async () => {
    await adapter.setWindowState('minimize', {});
    expect(psCalls.length).toBeGreaterThan(0);
  });
});
