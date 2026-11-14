/**
 * Live agent eval of 1.5.27 on Windows (2026-11-10), Edge with several top-level windows of one pid:
 *  - `find "Confirm"` also returned elements of an OLD background window the agent never saw (and the user's other windows);
 *  - `invoke "More options"` (a <details> summary: Button + ExpandCollapsePattern) answered "TogglePattern not supported";
 *  - `window focus` with the title as typed missed the live title, which has a zero-width space inside "Microsoft Edge".
 * The bridge itself needs a desktop; these tests read it, run its pure parts, and drive the TS layer with fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { psOpts } from '../platform/ps-spawn';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const root = join(__dirname, '../..');
const bridge = readFileSync(join(root, 'scripts/ps-bridge.ps1'), 'utf8');
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = src.indexOf('\nfunction ', start + 10);
  return next === -1 ? src.slice(start) : src.slice(start, next);
};

/** Run PowerShell 5.1 with the bridge functions named, the UIA assemblies loaded and the seams replaced by fakes. */
function runPs(functions: string[], body: string): string[] {
  const defs = functions.map(f => fnBody(bridge, f)).join('\n');
  const script = `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes\n${defs}\n${body}`;
  // From a file: Cmd-InvokeElement and Cmd-FindElement together are longer than a Windows command line may be. With a BOM,
  // so PowerShell 5.1 reads UTF-8.
  const dir = mkdtempSync(join(tmpdir(), 'cc-bridge-test-'));
  const file = join(dir, 'run.ps1');
  writeFileSync(file, String.fromCharCode(0xfeff) + script, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], psOpts({ encoding: 'utf8' })).trim().split(/\r?\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const FAKE_SEAMS = `
function Get-ScopeWindowHandle { param($wpid) if ($wpid -eq 1) { return [IntPtr]11 }; if ($wpid -eq 5) { throw 'no foreground' }; return [IntPtr]::Zero }
function ConvertFrom-ScopeHandle { param($h) return [pscustomobject]@{ Name = "front$h" } }
function Get-FirstPidWindow { param($wpid)
  if ($wpid -eq 2) { return [pscustomobject]@{ Name = 'first' } }
  if ($wpid -eq 3) { return @([pscustomobject]@{ Name = 'a' }, [pscustomobject]@{ Name = 'b' }) } }
`;

describe.runIf(process.platform === 'win32')('ps-bridge (run for real, fake windows): find and invoke stay in the window the agent works in', () => {
  it('Get-ProcessScopeWindows gives a FLAT array: 0 windows -> 0, the front window -> that one object, the fallback -> one, never an array in an array', () => {
    const out = runPs(['Get-ProcessScopeWindows'], `${FAKE_SEAMS}
foreach ($p in 0, 1, 2, 3, 5) { $r = @(Get-ProcessScopeWindows $p); "$p count=$($r.Count) first=$(if ($r.Count) { $r[0].Name } else { '-' }) isArray=$($r.Count -gt 0 -and $r[0] -is [array])" }`);
    expect(out).toEqual([
      '0 count=0 first=- isArray=False',      // no window at all: Count -eq 0 fires (it never did when the helper wrapped it)
      '1 count=1 first=front11 isArray=False', // the front window of the pid, and only it
      '2 count=1 first=first isArray=False',   // not in front: UIA's first window of the pid
      '3 count=2 first=a isArray=False',       // two items stay two flat items
      '5 count=0 first=- isArray=False',       // the foreground lookup throwing is not a crash
    ]);
  });

  it('invoke on a pid with no window answers "No window for pid", find answers an empty list (neither throws on .FindAll)', () => {
    const out = runPs(['Get-ProcessScopeWindows', 'Cmd-InvokeElement', 'Cmd-FindElement'], `${FAKE_SEAMS}
$inv = Cmd-InvokeElement ([pscustomobject]@{ processId = 99; name = 'x'; action = 'click' })
"invoke: $($inv.success) $($inv.error)"
$fnd = (Cmd-FindElement ([pscustomobject]@{ processId = 99; name = 'x' }))
"find: $($fnd.Count)"`);
    expect(out).toEqual(['invoke: False No window for pid 99', 'find: 0']);
  });

  it('invoke given the front window searches that window only, once (a match is not acted on in two windows)', () => {
    const out = runPs(['Get-ProcessScopeWindows', 'Cmd-InvokeElement'], `${FAKE_SEAMS}
$script:searched = @()
function ConvertFrom-ScopeHandle { param($h)
  $w = [pscustomobject]@{ Name = "front$h" }
  $w | Add-Member -MemberType ScriptMethod -Name FindFirst -Value { param($scope, $cond) $script:searched += $this.Name; return $null }
  $w | Add-Member -MemberType ScriptMethod -Name FindAll -Value { param($scope, $cond) $script:searched += $this.Name; return @() }
  return $w }
function Get-ScopeOtherWindows { param($a, $b) return 3 }
$r = Cmd-InvokeElement ([pscustomobject]@{ processId = 1; name = 'Confirm'; automationId = 'ok'; action = 'click' })
"searched=$($script:searched -join ',') success=$($r.success)"
$r.error
"reason=$($r.reason) other=$($r.otherWindows)"`);
    expect(out[2]).toBe('reason=not_found other=3'); // a machine-readable reason and a count, no sentence with page text
    expect(out[0]).toBe('searched=front11,front11 success=False'); // automationId lookup, then the name walk: both in the one window
    expect(out[1]).toBe('Element not found');
  });

  it('the z-order choice skips topmost / tool windows (Explorer\'s taskbar) unless nothing else matches', () => {
    const out = runPs(['Select-ScopeWindowHandle'], `
$fake = { param($h, $aux, $owned) [pscustomobject]@{ Handle = [IntPtr]$h; Aux = $aux; Owned = $owned } }
$taskbar = & $fake 10 $true $false
$files = & $fake 20 $false $false
$dialog = & $fake 30 $false $true
"1: $(Select-ScopeWindowHandle @($taskbar, $files))"          # the taskbar is first in z-order, the File Explorer window is chosen
"2: $(Select-ScopeWindowHandle @($taskbar))"                   # nothing else: the taskbar rather than no window
"3: $(Select-ScopeWindowHandle @($dialog, $files, $taskbar))"  # a dialog on top is the working window
"4: $(Select-ScopeWindowHandle @())"                           # none: Zero
"5: $(Select-ScopeWindowHandle $null)"`);
    expect(out).toEqual(['1: 20', '2: 10', '3: 30', '4: 0', '5: 0']);
  });

  it('the other-window count is normal app windows only: no tool / topmost windows, no dialogs, never the searched window', () => {
    const out = runPs(['Get-OtherWindowCount'], `
$fake = { param($h, $aux, $owned) [pscustomobject]@{ Handle = [IntPtr]$h; Aux = $aux; Owned = $owned } }
$c = @((& $fake 10 $true $false), (& $fake 20 $false $false), (& $fake 21 $false $false), (& $fake 30 $false $true))
"front window: $(Get-OtherWindowCount $c ([IntPtr]20))"   # the other normal window only
"owned dialog searched: $(Get-OtherWindowCount $c ([IntPtr]30))"  # both main windows are other windows (was undercounted by one)
"none: $(Get-OtherWindowCount @() ([IntPtr]1))"`);
    expect(out).toEqual(['front window: 1', 'owned dialog searched: 2', 'none: 0']);
  });

  it('ps-bridge.ps1 parses', () => {
    const file = join(root, 'scripts/ps-bridge.ps1').replace(/'/g, "''");
    const script = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); Write-Output $e.Count`;
    expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], psOpts({ encoding: 'utf8' })).trim()).toBe('0');
  });
});

describe('window titles are compared without invisible characters', () => {
  it.runIf(process.platform === 'win32')('ConvertTo-TitleKey (run for real) maps the live Edge title and the typed one to the same key', () => {
    const fn = fnBody(bridge, 'ConvertTo-TitleKey');
    const script = `${fn}\n$a = ConvertTo-TitleKey ([string]::Concat('CC Test Page - [InPrivate] - Microsoft', [char]0x200B, ' Edge'))\n$b = ConvertTo-TitleKey 'cc test page  -  [inprivate] - MICROSOFT Edge '\nWrite-Output ($a -eq $b); Write-Output $a`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], psOpts({ encoding: 'utf8' })).trim().split(/\r?\n/);
    expect(out[0]).toBe('True');
    expect(out[1]).toBe('cc test page - [inprivate] - microsoft edge');
  });
});
