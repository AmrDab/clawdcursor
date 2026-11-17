/**
 * ps-bridge focus-window, run for real against fake windows (a fake desktop root, owned dialogs) and the recording
 * Win32UIA / FakeSendKeys of the harness: no window is moved or raised.
 *  - A maximized window stays maximized: SW_SHOWMAXIMIZED (3), never SW_RESTORE (9), which shrank full-screen windows
 *    on every focus (user report 2026-10-16).
 *  - A window handle (the test fence pins a window this way) matches that window and no other: no title search, no
 *    fallback to the process (a Store app's host process owns the windows of every Store app).
 *  - Owned dialogs (Save As) are matched too, after the desktop children, and the reply says the window is owned.
 *  - Titles are compared through ConvertTo-TitleKey on both sides: the live Edge title has a zero-width space inside
 *    "Microsoft Edge" and the title as typed must still match (live eval 2026-11-10).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FAKE_UIA, runPsJson } from './helpers/ps-bridge-harness';

type Run = { reply: { success: boolean; foreground?: boolean; handle?: number; owned?: boolean; error?: string }; calls: string[]; sent: string[] };

const SETUP = `${FAKE_UIA}
$script:owned = @()
function Get-OwnedWindowElements { param($skip) return ,@($script:owned) }
function Win($name, $hwnd, $wpid) { New-FakeEl -Name $name -Type Window -Hwnd $hwnd -ProcessId $wpid }
function Focus([object[]]$wins, [object[]]$owned, [hashtable]$cmd) {
  $script:FakeRoot = New-FakeEl -Name 'Desktop' -Type Pane -Children $wins
  $script:owned = @($owned)
  $r = Cmd-FocusWindow ([pscustomobject]$cmd)
  '{"reply":' + (ConvertTo-Json -InputObject $r -Compress -Depth 5) + ',"calls":' + (ConvertTo-Json -InputObject @([Win32UIA]::Calls) -Compress) +
    ',"sent":' + (ConvertTo-Json -InputObject @([FakeSendKeys]::Sent) -Compress) + '}'
}
$notepad = Win 'Untitled - Notepad' 100 7
$edgeTitle = "CC Test Page - [InPrivate] - Microsoft$([char]0x200b) Edge"
`;

describe.runIf(process.platform === 'win32')('ps-bridge focus-window (run for real, fake windows)', () => {
  const CASES = {
    maximized: `[Win32UIA]::Zoomed.Add(100); [Win32UIA]::Foreground = 100\nFocus @($notepad) @() @{ processId = 7 }`,
    normal: `[Win32UIA]::Foreground = 100\nFocus @($notepad) @() @{ processId = 7 }`,
    staysBehind: `[Win32UIA]::Foreground = 999\nFocus @($notepad) @() @{ processId = 7 }`,
    handle: `[Win32UIA]::Foreground = 7003\nFocus @((Win 'Calculator' 100 300), (Win 'Calculator' 7003 300)) @() @{ handle = 7003; title = 'Calculator'; processId = 300 }`,
    handleGone: `Focus @((Win 'Calculator' 100 300), (Win 'Calculator' 7003 300)) @() @{ handle = 999; title = 'Calculator'; processId = 300 }`,
    ownedByTitle: `[ScreenPM]::Owners[200] = 100; [Win32UIA]::Foreground = 200\nFocus @($notepad) @((Win 'Save As' 200 7)) @{ title = 'save as' }`,
    pidOnly: `[ScreenPM]::Owners[200] = 100; [Win32UIA]::Foreground = 100\nFocus @($notepad) @((Win 'Save As' 200 7)) @{ processId = 7 }`,
    typedTitle: `[Win32UIA]::Foreground = 200\nFocus @((Win 'Other' 100 1), (Win $edgeTitle 200 2)) @() @{ title = 'CC Test Page - [InPrivate] - Microsoft Edge' }`,
    typedTitleAndPid: `[Win32UIA]::Foreground = 300\nFocus @((Win 'Other' 100 2), (Win 'Notes' 200 2), (Win $edgeTitle 300 2)) @() @{ processId = 2; title = 'microsoft  EDGE' }`,
  };
  const keys = Object.keys(CASES) as Array<keyof typeof CASES>;
  let r: Record<keyof typeof CASES, Run>;
  beforeAll(() => {
    const out = runPsJson(['Cmd-FocusWindow', 'ConvertTo-TitleKey'], SETUP, keys.map(k => CASES[k])) as Run[];
    r = Object.fromEntries(keys.map((k, i) => [k, out[i]])) as typeof r;
  }, 120_000);

  it('a maximized window is shown with SW_SHOWMAXIMIZED (3), never SW_RESTORE; any other with SW_RESTORE (9)', () => {
    expect(r.maximized.calls.filter(c => c.startsWith('ShowWindow'))).toEqual(['ShowWindow 100 3']);
    expect(r.normal.calls.filter(c => c.startsWith('ShowWindow'))).toEqual(['ShowWindow 100 9']);
    expect(r.normal.reply).toMatchObject({ success: true, foreground: true, handle: 100 });
    expect(r.normal.sent).toEqual([]);
  });

  it('a window that stays behind gets the Alt tap, and the reply says it is not in front', () => {
    expect(r.staysBehind.sent).toEqual(['%']);
    expect(r.staysBehind.reply).toMatchObject({ success: false, foreground: false });
  });

  it('a handle matches the window with that handle, though another has the same title and process', () => {
    expect(r.handle.reply).toMatchObject({ success: true, handle: 7003 });
    expect(r.handle.calls).toContain('SetForegroundWindow 7003');
    expect(r.handle.calls.join()).not.toMatch(/ 100\b/);
  });

  it('a handle that is not there is "not found": no title or process fallback, nothing raised', () => {
    expect(r.handleGone.reply).toEqual({ success: false, error: 'Window not found: handle=999' });
    expect(r.handleGone.calls).toEqual([]);
  });

  it('an owned dialog is matched by its title and reported owned; a pid alone still takes the main window', () => {
    expect(r.ownedByTitle.reply).toMatchObject({ success: true, handle: 200, owned: true });
    expect(r.pidOnly.reply).toMatchObject({ success: true, handle: 100, owned: false });
  });

  it('the title as typed matches a title with a zero-width space, alone or with the pid', () => {
    expect(r.typedTitle.reply).toMatchObject({ success: true, handle: 200 });
    expect(r.typedTitleAndPid.reply).toMatchObject({ success: true, handle: 300 });
  });
});
