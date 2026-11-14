/**
 * The set-value keyboard fallback compared the foreground window's PROCESS with the target's: two windows of one process
 * (Explorer, Notepad, Edge) share a pid, so with the target in the background one, Ctrl+A and the text went to the
 * front window. It compares the target's TOP-LEVEL window (GA_ROOT of its nearest ancestor with a handle) with the
 * foreground window, and fails (not refused: the caller then clicks the field and types) when they differ or the window
 * cannot be resolved. A keyboard set whose read-back is null is unverified, not a success.
 * Run for real with fake elements, a fake Win32UIA (foreground, GA_ROOT) and FakeSendKeys: no key reaches the desktop.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { INVOKE_FUNCTIONS, INVOKE_SETUP, runPsJson } from './helpers/ps-bridge-harness';

type Run = { reply: { success: boolean; unverified?: boolean; method?: string; reason?: string; error?: string; detail?: string }; sent: string[] };

describe.runIf(process.platform === 'win32')('ps-bridge set-value keyboard fallback (run for real, fake windows and keys)', () => {
  // A field with no writable value: the fallback is the only way. -Hwnd: its own window handle.
  const field = (opts: string) => `New-FakeEl -Name 'Name' ${opts}`;
  const set = (els: string, value = 'Ada') => `Invoke-FakeKeys @(${els}) @{ name = 'Name'; action = 'set-value'; value = '${value}' }`;
  const CASES = {
    // The target's window (100) is not the foreground window (200), though both could be one process.
    notInFront: `[Win32UIA]::Foreground = 200\n${set(field('-Hwnd 100 -Patterns @{ Value = (New-ValuePattern "old" -ReadOnly) }'))}`,
    // A child window (150) whose top-level window (100) is not in front either.
    childNotInFront: `[Win32UIA]::Roots[150] = 100; [Win32UIA]::Foreground = 300\n${set(field('-Hwnd 150'))}`,
    // No handle anywhere up the tree: the window cannot be resolved.
    noHandle: `[Win32UIA]::Foreground = 100\n${set(field('-Parent (New-FakeEl -Name pane -Type Pane)'))}`,
    // In front through its nearest handled ancestor (150 -> GA_ROOT 100): typed; no read-back -> unverified.
    viaAncestor: `[Win32UIA]::Roots[150] = 100; [Win32UIA]::Foreground = 100\n${set(field('-Parent (New-FakeEl -Name pane -Type Pane -Hwnd 150)'))}`,
    // In front, but the read-back (a read-only Spinner's number) is not what was typed: a failure that quotes it.
    didNotStick: `[Win32UIA]::Foreground = 100\n${set(`New-FakeEl -Name 'Name' -Type Spinner -Hwnd 100 -Patterns @{ RangeValue = (New-RangePattern 5 -ReadOnly) }`, '7')}`,
    // SendKeys' special characters are typed literally.
    escaped: `[Win32UIA]::Foreground = 100\n${set(field('-Hwnd 100'), 'a+b^(c)%~{d}')}`,
  };
  const keys = Object.keys(CASES) as Array<keyof typeof CASES>;
  let r: Record<keyof typeof CASES, Run>;
  beforeAll(() => {
    const out = runPsJson(INVOKE_FUNCTIONS, INVOKE_SETUP, keys.map(k => `[Win32UIA]::Roots.Clear()\n${CASES[k]}`)) as Run[];
    r = Object.fromEntries(keys.map((k, i) => [k, out[i]])) as typeof r;
  }, 120_000);

  it('another window in front (of any process): no key is sent, and it fails without a refusal', () => {
    for (const run of [r.notInFront, r.childNotInFront]) {
      expect(run.sent).toEqual([]);
      expect(run.reply).toMatchObject({ success: false, error: 'no settable value, and its window is not in front to type into' });
      expect(JSON.stringify(run.reply)).not.toMatch(/refused/);
    }
  });

  it('a window that cannot be resolved (no handle up the tree) is treated the same way', () => {
    expect(r.noHandle.sent).toEqual([]);
    expect(r.noHandle.reply).toMatchObject({ success: false, error: 'no settable value, and its window is not in front to type into' });
  });

  it('in front through its nearest handled ancestor: Ctrl+A, then the text; a null read-back is unverified, not a plain success', () => {
    expect(r.viaAncestor.sent).toEqual(['^a', 'Ada']);
    expect(r.viaAncestor.reply).toMatchObject({ success: true, unverified: true, method: 'keyboard' });
  });

  it('a read-back that differs is a failure that quotes it (a Spinner reads back its number)', () => {
    expect(r.didNotStick.sent).toEqual(['^a', '7']);
    expect(r.didNotStick.reply).toMatchObject({ success: false, reason: 'failed', detail: "set-value did not stick (got '5')" });
  });

  it('SendKeys\' special characters are escaped, so the text is typed as given', () => {
    expect(r.escaped.sent).toEqual(['^a', 'a{+}b{^}{(}c{)}{%}{~}{{}d{}}']);
  });
});
