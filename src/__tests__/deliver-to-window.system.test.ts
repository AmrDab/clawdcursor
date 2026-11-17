/**
 * ps-bridge `deliver-to-window` (rung R1 on Windows): text, a whole value or a click delivered to a control of a BACKGROUND
 * window by window messages, never taking the foreground. Run for real against fake windows and a fake ClawdMsg: no
 * message reaches the desktop. What it must refuse: the user's foreground window, a password edit, a Chromium / Electron
 * window (CDP is their route), an ambiguous target; and an elevated target is reported as such, not retried.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runPsJson } from './helpers/ps-bridge-harness';

type Reply = { success: boolean; method?: string; verified?: boolean; reason?: string; error?: string; control?: { class: string; handle: number } };
type Run = { reply: Reply; calls: string[] };

const SETUP = `
function Get-PidWindowCandidates { param([int]$wpid) return ,@($script:Roots | ForEach-Object { [pscustomobject]@{ Handle = [IntPtr]$_; Aux = $false; Owned = $false } }) }
function Deliver([hashtable]$cmd) {
  $r = Cmd-DeliverToWindow ([pscustomobject]$cmd)
  '{"reply":' + (ConvertTo-Json -InputObject $r -Compress -Depth 4) + ',"calls":' + (ConvertTo-Json -InputObject @([Win32UIA]::Calls) -Compress) + '}'
}
$EDIT = 'WindowsForms10.EDIT.app.0.1'
function World([long[]]$kids, [string]$rootClass = 'WindowsForms10.Window.8.app.0.1') {
  $script:Roots = @(100); [Win32UIA]::Foreground = 999
  [ClawdMsg]::Classes[100] = $rootClass; [ClawdMsg]::Kids[100] = $kids
}
`;

describe.runIf(process.platform === 'win32')('ps-bridge deliver-to-window (run for real, fake windows)', () => {
  const CASES = {
    type: `World @(101); [ClawdMsg]::Classes[101] = $EDIT; [ClawdMsg]::Texts[101] = 'hi'\nDeliver @{ processId = 7; text = '!' }`,
    typeNewline: `World @(101); [ClawdMsg]::Classes[101] = $EDIT\nDeliver @{ processId = 7; text = "a\`nb" }`,
    typeNotRead: `World @(101); [ClawdMsg]::Classes[101] = $EDIT; [ClawdMsg]::PostsType = $false\nDeliver @{ processId = 7; text = 'x' }`,
    setText: `World @(101); [ClawdMsg]::Classes[101] = $EDIT; [ClawdMsg]::Texts[101] = 'old'\nDeliver @{ handle = 100; setText = 'new' }`,
    clickByName: `World @(101, 102); [ClawdMsg]::Classes[101] = $EDIT; [ClawdMsg]::Classes[102] = 'WindowsForms10.BUTTON.app.0.1'; [ClawdMsg]::Texts[102] = '&Save'\nDeliver @{ processId = 7; name = 'save'; click = $true }`,
    password: `World @(101); [ClawdMsg]::Classes[101] = $EDIT; [ClawdMsg]::Styles[101] = 0x10000020\nDeliver @{ processId = 7; text = 'secret' }`,
    userForeground: `World @(101); [ClawdMsg]::Classes[101] = $EDIT; [Win32UIA]::Foreground = 100\nDeliver @{ processId = 7; text = 'x' }`,
    chromium: `World @(101) 'Chrome_WidgetWin_1'; [ClawdMsg]::Classes[101] = $EDIT\nDeliver @{ processId = 7; text = 'x' }`,
    elevated: `World @(101); [ClawdMsg]::Classes[101] = $EDIT; [ClawdMsg]::PostError = 5\nDeliver @{ processId = 7; text = 'abc' }`,
    ambiguous: `World @(101, 102); [ClawdMsg]::Classes[101] = $EDIT; [ClawdMsg]::Classes[102] = $EDIT\nDeliver @{ processId = 7; text = 'x' }`,
    noControl: `World @(101); [ClawdMsg]::Classes[101] = 'Static'\nDeliver @{ processId = 7; text = 'x' }`,
    badInput: `World @(101); [ClawdMsg]::Classes[101] = $EDIT\nDeliver @{ processId = 7; text = 'x'; click = $true }`,
  };
  const keys = Object.keys(CASES) as Array<keyof typeof CASES>;
  let r: Record<keyof typeof CASES, Run>;
  beforeAll(() => {
    const out = runPsJson(['Cmd-DeliverToWindow', 'Find-DeliverControl'], SETUP, keys.map(k => CASES[k])) as Run[];
    r = Object.fromEntries(keys.map((k, i) => [k, out[i]])) as typeof r;
  }, 120_000);
  const posts = (c: string[]) => c.filter(x => x.startsWith('Post ') || x.startsWith('SetText '));

  it('text goes as one WM_CHAR per character and is read back', () => {
    expect(r.type.reply).toMatchObject({ success: true, method: 'WM_CHAR', verified: true, control: { handle: 101 } });
    expect(posts(r.type.calls)).toEqual(['Post 101 258 33']);
  });

  it('a newline is Enter (13), and no read-back match is success without verified', () => {
    expect(posts(r.typeNewline.calls)).toEqual(['Post 101 258 97', 'Post 101 258 13', 'Post 101 258 98']);
    expect(r.typeNotRead.reply).toMatchObject({ success: true, verified: false });
  });

  it('a whole value is WM_SETTEXT, verified by reading it back', () => {
    expect(r.setText.reply).toMatchObject({ success: true, method: 'WM_SETTEXT', verified: true });
    expect(posts(r.setText.calls)).toEqual(['SetText 101 new']);
  });

  it('a click is BM_CLICK on the button whose text matches (accelerator ignored), not verified', () => {
    expect(r.clickByName.reply).toMatchObject({ success: true, method: 'BM_CLICK', verified: false, control: { handle: 102 } });
    expect(posts(r.clickByName.calls)).toEqual(['Post 102 245 0']);
  });

  it('never delivers into a password edit', () => {
    expect(r.password.reply).toMatchObject({ success: false, reason: 'secure-field' });
    expect(posts(r.password.calls)).toEqual([]);
  });

  it('never delivers to the user\'s foreground window', () => {
    expect(r.userForeground.reply).toMatchObject({ success: false, reason: 'user-foreground' });
    expect(posts(r.userForeground.calls)).toEqual([]);
  });

  it('leaves Chromium / Electron windows to CDP', () => {
    expect(r.chromium.reply).toMatchObject({ success: false, reason: 'use-cdp' });
    expect(posts(r.chromium.calls)).toEqual([]);
  });

  it('reports an elevated target (access denied) as its own failure, sent once, not retried', () => {
    expect(r.elevated.reply).toMatchObject({ success: false, reason: 'uipi' });
    expect(posts(r.elevated.calls)).toEqual(['Post 101 258 97']);
  });

  it('does not guess between several edits, and says when there is none', () => {
    expect(r.ambiguous.reply).toMatchObject({ success: false, reason: 'ambiguous' });
    expect(r.noControl.reply).toMatchObject({ success: false, reason: 'no-control' });
    expect(r.badInput.reply).toMatchObject({ success: false, reason: 'bad-input' });
  });
});
