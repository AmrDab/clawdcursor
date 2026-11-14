/**
 * Runs functions of scripts/ps-bridge.ps1 for real in Windows PowerShell 5.1, against fakes, so a test asserts on what
 * the code DOES rather than on its source text. Windows only, and a real process: use it from a `*.system.test.ts` file.
 *
 * Nothing reaches the desktop: only the functions a test names are defined (never the bridge's own Add-Type of its
 * Win32 helpers, never its command loop), and every way out to the real UI is a fake:
 *  - `Win32UIA` and `ScreenPM` are recording stand-ins with the bridge's type names (no DllImport);
 *  - SendKeys is rewritten to `[FakeSendKeys]`, which only records the keys;
 *  - AutomationElement.RootElement / FocusedElement are rewritten to `$script:FakeRoot` / `$script:FakeFocused`, and the
 *    UIA tree walkers to `$script:FakeWalker` (an element's parent is its `.Parent`).
 * FAKE_UIA builds fake UIA elements and patterns (New-FakeEl, New-ValuePattern, ...).
 *
 * One process per call: `runPsCases` runs a whole block of cases in it and gives back each case's output lines.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { psOpts, powershellExe } from '../../platform/ps-spawn';

export const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'scripts');
export const bridgeSource = readFileSync(join(SCRIPTS_DIR, 'ps-bridge.ps1'), 'utf8');

/** `function <name>` and its body: up to the next top-level function, or the end of `src`. Throws when it is not there. */
export function fnBody(name: string, src: string = bridgeSource): string {
  const m = new RegExp(`^function ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm').exec(src);
  if (!m) throw new Error(`no function ${name}`);
  const next = src.indexOf('\nfunction ', m.index + 10);
  return next === -1 ? src.slice(m.index) : src.slice(m.index, next);
}

/** A top-level assignment of the bridge (`$name = ...`, which may span lines): up to the next function or comment line. */
export function topLevel(variable: string, src: string = bridgeSource): string {
  const start = src.indexOf(`\n${variable} = `);
  if (start === -1) throw new Error(`no ${variable}`);
  const end = src.slice(start + 1).search(/\n(function |#)/);
  return src.slice(start + 1, start + 1 + end);
}

/** The bridge's command loop, from `while ($true) {` to the end: it reads JSON lines on stdin and writes one reply each. */
export function commandLoop(src: string = bridgeSource): string {
  const start = src.indexOf('\nwhile ($true) {');
  if (start === -1) throw new Error('no command loop');
  return src.slice(start + 1);
}

const SEAMS: Array<[string, string]> = [
  ['[System.Windows.Forms.SendKeys]::', '[FakeSendKeys]::'],
  ['[System.Windows.Automation.AutomationElement]::RootElement', '$script:FakeRoot'],
  ['[System.Windows.Automation.AutomationElement]::FocusedElement', '$script:FakeFocused'],
  ['[System.Windows.Automation.TreeWalker]::ControlViewWalker', '$script:FakeWalker'],
  ['[System.Windows.Automation.TreeWalker]::RawViewWalker', '$script:FakeWalker'],
  ['[System.Windows.Automation.AutomationElement]$', '$'],   // a typed parameter takes a fake element too
];
const seamed = (code: string) => SEAMS.reduce((s, [from, to]) => s.split(from).join(to), code);

const PRELUDE = `$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic;
public static class FakeSendKeys { public static List<string> Sent = new List<string>(); public static void SendWait(string k) { Sent.Add(k); } }
public static class Win32UIA {
  public static List<string> Calls = new List<string>();
  public static long Foreground;
  public static Dictionary<long, long> Roots = new Dictionary<long, long>();     // GA_ROOT (2); a window not in it is its own
  public static Dictionary<long, long> Parents = new Dictionary<long, long>();   // GA_PARENT (1)
  public static Dictionary<long, uint> Pids = new Dictionary<long, uint>();
  public static Dictionary<long, int> Styles = new Dictionary<long, int>();      // GWL_STYLE
  public static HashSet<long> Zoomed = new HashSet<long>();
  static bool Log(string s) { Calls.Add(s); return true; }
  public static IntPtr GetForegroundWindow() { return new IntPtr(Foreground); }
  public static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { uint p; pid = Pids.TryGetValue(h.ToInt64(), out p) ? p : 0; return 0; }
  public static bool SetForegroundWindow(IntPtr h) { return Log("SetForegroundWindow " + h); }
  public static bool BringWindowToTop(IntPtr h) { return Log("BringWindowToTop " + h); }
  public static bool ShowWindow(IntPtr h, int c) { return Log("ShowWindow " + h + " " + c); }
  public static bool AttachThreadInput(uint a, uint b, bool f) { return Log("AttachThreadInput " + f); }
  public static bool AllowSetForegroundWindow(int p) { return Log("AllowSetForegroundWindow"); }
  public static uint GetCurrentThreadId() { return 1; }
  public static bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f) { return Log("SetWindowPos " + h + " " + after); }
  public static IntPtr GetAncestor(IntPtr h, uint f) {
    long r; var map = f == 1 ? Parents : Roots;
    return map.TryGetValue(h.ToInt64(), out r) ? new IntPtr(r) : (f == 1 ? IntPtr.Zero : h); }
  public static bool IsZoomed(IntPtr h) { return Zoomed.Contains(h.ToInt64()); }
  public static int GetWindowLong(IntPtr h, int i) { int v; return i == -16 && Styles.TryGetValue(h.ToInt64(), out v) ? v : 0; }
  public static int GetDlgCtrlID(IntPtr h) { return 5; }
  public static IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint f, uint ms, out IntPtr res) {
    res = IntPtr.Zero; Log("SendMessageTimeout " + h + " " + msg + " " + w + " " + l); return new IntPtr(1); }
}
public static class ScreenPM {
  public static Dictionary<long, long> Owners = new Dictionary<long, long>();
  public static IntPtr GetWindow(IntPtr h, uint c) { long o; return c == 4 && Owners.TryGetValue(h.ToInt64(), out o) ? new IntPtr(o) : IntPtr.Zero; }
  public static bool IsWindowVisible(IntPtr h) { return true; }
  public static List<object[]> Monitors() { return new List<object[]>(); }
  public static long At;                                                       // WindowAt answers this for every point
  public static Dictionary<long, int> ExStyles = new Dictionary<long, int>();  // GWL_EXSTYLE
  public static IntPtr WindowAt(int x, int y) { return new IntPtr(At); }
  public static int GetWindowLong(IntPtr h, int i) { int v; return i == -20 && ExStyles.TryGetValue(h.ToInt64(), out v) ? v : 0; }
}
'@
function Reset-Fakes {
  [FakeSendKeys]::Sent.Clear(); [Win32UIA]::Calls.Clear(); [Win32UIA]::Foreground = 0; [ScreenPM]::At = 0
  foreach ($m in [Win32UIA]::Roots, [Win32UIA]::Parents, [Win32UIA]::Pids, [Win32UIA]::Styles, [Win32UIA]::Zoomed, [ScreenPM]::Owners, [ScreenPM]::ExStyles) { $m.Clear() }
  $script:FakeRoot = $null; $script:FakeFocused = $null
}
Reset-Fakes
# The tree walker: an element's parent is its .Parent ($null for anything without one).
$script:FakeWalker = [pscustomobject]@{}
$script:FakeWalker | Add-Member -MemberType ScriptMethod -Name GetParent -Value { param($e) if ($null -eq $e) { return $null }; return $e.Parent }
`;

/**
 * Fake UIA elements. New-FakeEl: -Name, -Type (a ControlType name), -Patterns (@{ Value = (New-ValuePattern ...); ... },
 * keyed by the pattern's name without "Pattern"), -Password, -Hwnd, -Rect @(x, y, w, h), -Children, -Parent. GetCurrentPattern
 * answers the patterns it was given and throws for any other, as UIA does; GetCurrentPropertyValue answers the
 * Is<X>PatternAvailable properties. $script:pressed records each Invoke().
 */
export const FAKE_UIA = `
$script:pressed = @()
function New-FakeEl {
  param([string]$Name, [string]$Type = 'Edit', [hashtable]$Patterns = @{}, [switch]$Password, [long]$Hwnd = 0, $Rect = @(10, 10, 100, 20), [object[]]$Children = @(), $Parent = $null,
    $LabeledBy = $null, [string]$ClassName = '', [int]$ProcessId = 7)
  $e = [pscustomobject]@{ P = $Patterns; Kids = $Children; Parent = $Parent; LabeledBy = $LabeledBy
    Current = [pscustomobject]@{ Name = $Name; ControlType = [System.Windows.Automation.ControlType]::$Type; IsPassword = [bool]$Password
      IsOffscreen = $false; IsEnabled = $true; IsKeyboardFocusable = $true; NativeWindowHandle = $Hwnd; ProcessId = $ProcessId
      AutomationId = ''; ClassName = $ClassName; FrameworkId = 'Fake'; HelpText = ''; LocalizedControlType = $Type.ToLower()
      BoundingRectangle = (New-Object System.Windows.Rect ([double]$Rect[0]), ([double]$Rect[1]), ([double]$Rect[2]), ([double]$Rect[3])) } }
  $e | Add-Member -MemberType ScriptMethod -Name GetCurrentPattern -Value { param($p)
    $k = $p.ProgrammaticName -replace 'PatternIdentifiers\\.Pattern$', ''
    if ($this.P.ContainsKey($k)) { return $this.P[$k] }
    throw "unsupported pattern $k" }
  $e | Add-Member -MemberType ScriptMethod -Name GetCurrentPropertyValue -Value { param($p)
    if ($p.ProgrammaticName -match 'Is(\\w+)PatternAvailableProperty$') { return $this.P.ContainsKey($Matches[1]) }
    if ($p.ProgrammaticName -match 'LabeledByProperty$') { return $this.LabeledBy }
    return $null }
  $e | Add-Member -MemberType ScriptMethod -Name FindAll -Value { param($scope, $cond) return ,@($this.Kids) }
  $e | Add-Member -MemberType ScriptMethod -Name FindFirst -Value { param($scope, $cond) return $null }
  $e | Add-Member -MemberType ScriptMethod -Name SetFocus -Value { }
  return $e
}
function New-ValuePattern([string]$Value = '', [switch]$ReadOnly, [switch]$Ignores) {
  $p = [pscustomobject]@{ Ignores = [bool]$Ignores; Current = [pscustomobject]@{ Value = $Value; IsReadOnly = [bool]$ReadOnly } }
  $p | Add-Member -MemberType ScriptMethod -Name SetValue -Value { param($v) if (-not $this.Ignores) { $this.Current.Value = $v } }
  return $p
}
function New-RangePattern([double]$Value = 0, [switch]$ReadOnly) {
  $p = [pscustomobject]@{ Current = [pscustomobject]@{ Value = $Value; IsReadOnly = [bool]$ReadOnly } }
  $p | Add-Member -MemberType ScriptMethod -Name SetValue -Value { param($v) $this.Current.Value = [double]$v }
  return $p
}
function New-TextPattern([string]$Text = '') {
  $r = [pscustomobject]@{ Text = $Text }
  $r | Add-Member -MemberType ScriptMethod -Name GetText -Value { param($n) return $this.Text }
  return [pscustomobject]@{ DocumentRange = $r }
}
function New-InvokePattern([string]$Owner) {
  $p = [pscustomobject]@{ Owner = $Owner }
  $p | Add-Member -MemberType ScriptMethod -Name Invoke -Value { $script:pressed += $this.Owner }
  return $p
}
function New-ExpandPattern([string]$State = 'Collapsed') {
  $p = [pscustomobject]@{ Current = [pscustomobject]@{ ExpandCollapseState = [System.Windows.Automation.ExpandCollapseState]::$State } }
  $p | Add-Member -MemberType ScriptMethod -Name Expand -Value { $this.Current.ExpandCollapseState = [System.Windows.Automation.ExpandCollapseState]::Expanded }
  $p | Add-Member -MemberType ScriptMethod -Name Collapse -Value { $this.Current.ExpandCollapseState = [System.Windows.Automation.ExpandCollapseState]::Collapsed }
  return $p
}
function New-SelectionItemPattern([switch]$Selected, [switch]$Ignores) {
  $p = [pscustomobject]@{ Ignores = [bool]$Ignores; Current = [pscustomobject]@{ IsSelected = [bool]$Selected } }
  $p | Add-Member -MemberType ScriptMethod -Name Select -Value { if (-not $this.Ignores) { $this.Current.IsSelected = $true } }
  return $p
}
function New-TogglePattern([string]$State = 'On') {
  return [pscustomobject]@{ Current = [pscustomobject]@{ ToggleState = [System.Windows.Automation.ToggleState]::$State } }
}
`;

/** The bridge functions a by-name invoke-element runs through; INVOKE_SETUP fakes the rest (one window, no dialog). */
export const INVOKE_FUNCTIONS = ['Cmd-InvokeElement', 'Test-NameMatch', 'Select-InvokeTarget', 'Test-RectOnMonitor', 'Get-MonitorRects',
  'Resolve-EditableTarget', 'Test-Activatable', 'Select-Item'];
/** Invoke-Fake <elements> <cmd hashtable>: Cmd-InvokeElement on a window holding those elements -> its reply as one JSON line. */
export const INVOKE_SETUP = `${FAKE_UIA}
$script:window = $null
function Get-ProcessScopeWindows { param($wpid) return $script:window }
function Get-ScopeOtherWindows { param($a, $b) return 0 }
function Test-WindowMinimized { param($w) return $false }
function Get-FocusedDialog { return $null }
function Test-ElementUnder { param($el, $anc) return $false }
function Get-ContainerOf { param($el) return $null }
function Invoke-Fake([object[]]$els, [hashtable]$cmd) {
  $script:window = New-FakeEl -Name 'Window' -Type Window -Children $els
  if (-not $cmd.processId) { $cmd.processId = 7 }
  ConvertTo-Json -InputObject (Cmd-InvokeElement ([pscustomobject]$cmd)) -Compress -Depth 6
}
# The same, with the keys the bridge "typed" (FakeSendKeys): -> {"reply": ..., "sent": [...]}.
function Invoke-FakeKeys([object[]]$els, [hashtable]$cmd) {
  [FakeSendKeys]::Sent.Clear()
  $reply = Invoke-Fake $els $cmd
  '{"reply":' + $reply + ',"sent":' + (ConvertTo-Json -InputObject @([FakeSendKeys]::Sent) -Compress) + '}'
}
`;

/** Run PowerShell 5.1: the prelude (fakes), the named bridge functions, then `body`. -> its output lines. */
export function runPs(functions: string[], body: string, opts: { input?: string; src?: string; timeout?: number } = {}): string[] {
  const defs = functions.map(f => fnBody(f, opts.src)).join('\n');
  const script = `${PRELUDE}\n${seamed(defs)}\n${body}`;
  // From a file: Cmd-InvokeElement alone is longer than a Windows command line may be. With a BOM, so PowerShell 5.1 reads UTF-8.
  const dir = mkdtempSync(join(tmpdir(), 'cc-bridge-test-'));
  const file = join(dir, 'run.ps1');
  writeFileSync(file, String.fromCharCode(0xfeff) + script, 'utf8');
  try {
    return execFileSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      psOpts({ encoding: 'utf8', input: opts.input ?? '', timeout: opts.timeout ?? 120_000 })).trim().split(/\r?\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const MARK = '@@case@@';
/**
 * Every case of a block in ONE process: `setup` once, then each case (PowerShell) in its own scope, the fakes reset. -> each case's
 * output lines, in order; a case that throws gives ['ERROR: <message>'].
 */
export function runPsCases(functions: string[], setup: string, cases: string[], opts: { src?: string; timeout?: number } = {}): string[][] {
  const body = `${setup}\n${cases.map(c => `Write-Output '${MARK}'\nReset-Fakes\ntry { & {\n${c}\n} } catch { "ERROR: $($_.Exception.Message)" }`).join('\n')}`;
  const out = runPs(functions, body, opts);
  const first = out.indexOf(MARK);
  if (first === -1) throw new Error(`no case ran:\n${out.join('\n')}`);
  const res: string[][] = [];
  for (const line of out.slice(first)) {
    if (line === MARK) res.push([]);
    else if (line.trim() !== '') res[res.length - 1].push(line);
  }
  return res;
}

/** runPsCases where each case writes one JSON line last: -> that value per case. */
export function runPsJson(functions: string[], setup: string, cases: string[], opts: { src?: string; timeout?: number } = {}): unknown[] {
  return runPsCases(functions, setup, cases, opts).map(lines => {
    const last = lines[lines.length - 1] ?? '';
    try { return JSON.parse(last); } catch { return lines.join('\n'); }
  });
}
