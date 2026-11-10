/**
 * Live agent eval of 1.5.27 on Windows (2026-11-10), Edge with several top-level windows of one pid:
 *  - `find "Confirm"` also returned elements of an OLD background window the agent never saw (and the user's other windows);
 *  - `invoke "More options"` (a <details> summary: Button + ExpandCollapsePattern) answered "TogglePattern not supported";
 *  - `window focus` with the title as typed missed the live title, which has a zero-width space inside "Microsoft Edge".
 * The bridge itself needs a desktop; these tests read it, run its pure parts, and drive the TS layer with fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import vm from 'node:vm';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { runActivationLadder, canClickAtBounds, expandNote } from '../core/agent-loop/tools';
import { normalizeWindowText, windowTextIncludes } from '../tools/window-text';
import { checkAssertions } from '../core/verify/assertions';
import { narrowedScopeNote } from '../tools/scope-note';
import { classifyResult, quoteScreenText } from '../core/result-codes';

const root = join(__dirname, '../..');
const bridge = readFileSync(join(root, 'scripts/ps-bridge.ps1'), 'utf8');
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = src.indexOf('\nfunction ', start + 10);
  return next === -1 ? src.slice(start) : src.slice(start, next);
};
const ZWSP = String.fromCharCode(0x200b);
const EDGE_TITLE = `CC Test Page - [InPrivate] - Microsoft${ZWSP} Edge`;

/** Run PowerShell 5.1 with the bridge functions named, the UIA assemblies loaded and the seams replaced by fakes. */
function runPs(functions: string[], body: string): string[] {
  const defs = functions.map(f => fnBody(bridge, f)).join('\n');
  const script = `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes\n${defs}\n${body}`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim().split(/\r?\n/);
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
function Get-ScopeNarrowNote { param($a, $b) return '' }
$r = Cmd-InvokeElement ([pscustomobject]@{ processId = 1; name = 'Confirm'; automationId = 'ok'; action = 'click' })
"searched=$($script:searched -join ',') success=$($r.success)"
$r.error`);
    expect(out[0]).toBe('searched=front11,front11 success=False'); // automationId lookup, then the name walk: both in the one window
    expect(out[1]).toMatch(/^Element not found: name='Confirm'/);
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
    expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()).toBe('0');
  });
});

describe('ps-bridge: which functions use the scope helper', () => {
  it('find and invoke call Get-ProcessScopeWindows; invoke no longer takes the first window of the pid', () => {
    expect(fnBody(bridge, 'Cmd-FindElement')).toMatch(/@\(Get-ProcessScopeWindows \$wpid\)/);
    const inv = fnBody(bridge, 'Cmd-InvokeElement');
    expect(inv).toMatch(/@\(Get-ProcessScopeWindows \$wpid\)/);
    expect(inv).not.toMatch(/FindFirst\(\[System\.Windows\.Automation\.TreeScope\]::Children/);
  });
});

describe('invoke activates an expandable element and reports why a miss is a miss', () => {
  it('the click cascade ends in ExpandCollapsePattern and says which way it flipped', () => {
    const inv = fnBody(bridge, 'Cmd-InvokeElement');
    const click = inv.slice(inv.indexOf('"click" {'), inv.indexOf('"set-value" {'));
    expect(click).toMatch(/ExpandCollapsePattern\]::Pattern/);
    expect(click).toMatch(/\$was = \$p\.Current\.ExpandCollapseState/);
    expect(click).toMatch(/method="ExpandCollapsePattern"; data=@\{ expandState=\$now/);
    // a tree item is selected, not expanded: SelectionItem is tried first
    expect(click.indexOf('SelectionItemPattern')).toBeLessThan(click.indexOf('ExpandCollapsePattern'));
  });

  const nothing = { success: false, data: { error: 'No invoke/toggle/select/expand pattern' }, bounds: { x: 1, y: 2, width: 3, height: 4 } };
  it('a miss reports the click cascade\'s reason, not the last rung\'s ("TogglePattern not supported")', async () => {
    const call = vi.fn(async (a: string) => a === 'click' ? nothing
      : { success: false, data: { error: a === 'select' ? 'SelectionItemPattern not supported' : 'TogglePattern not supported' } });
    const { res, used } = await runActivationLadder(call as any, ['click', 'select', 'toggle']);
    expect(used).toBe('toggle');
    expect(res.success).toBe(false);
    expect(res.data?.error).toBe('No invoke/toggle/select/expand pattern');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('stops at the first rung that takes, and keeps its data (expandState)', async () => {
    const call = vi.fn(async () => ({ success: true, data: { expandState: 'Expanded' } }));
    const { res, used } = await runActivationLadder(call as any, ['click', 'select', 'toggle']);
    expect(call).toHaveBeenCalledTimes(1);
    expect(used).toBe('click');
    expect(res.data?.expandState).toBe('Expanded');
  });
});

describe('invoke: bounds survive the ladder, and the expand reports the state it read back', () => {
  it('a miss keeps the click rung\'s bounds so the coordinate fallback can click (the eval needed a manual click)', async () => {
    const bounds = { x: 10, y: 20, width: 30, height: 40 };
    const call = vi.fn(async (a: string) => a === 'click' ? { success: false, bounds, data: { error: 'No invoke/toggle/select/expand pattern' } } : { success: false });
    const { res } = await runActivationLadder(call as any, ['click', 'select', 'toggle']);
    expect(res.bounds).toEqual(bounds);
  });

  it('the expand rung is bounded and read back like toggle', () => {
    const inv = fnBody(bridge, 'Cmd-InvokeElement');
    expect(inv).toMatch(/\[UiaInvoker\]::Expand\(\$p, 1200\)/);
    expect(inv).toMatch(/\[UiaInvoker\]::Collapse\(\$p, 1200\)/);
    expect(inv).toMatch(/expandState=\$now; was=\$was; expandChanged=/);
    expect(bridge).toMatch(/public static string Expand\(ExpandCollapsePattern p, int waitMs\)/);
  });
});

describe('a miss says the search covered the front window only', () => {
  const win = (processId: number, title: string) => ({ processId, title });
  it('names the front window and the count of the app\'s other windows', async () => {
    const platform = { listWindows: async () => [win(7, 'A - Edge'), win(7, 'B - Edge'), win(7, 'C - Edge'), win(8, 'Notes')] };
    const note = await narrowedScopeNote(platform, [{ processId: 7, title: 'A - Edge' }]);
    expect(note).toBe('; only the front window "A - Edge" was searched; this app has 2 other windows — window {"action":"focus","title":"…"} first to work in one');
  });
  it('is the plain advice for a one-window app', async () => {
    const note = await narrowedScopeNote({ listWindows: async () => [win(7, 'A')] }, [{ processId: 7, title: 'A' }]);
    expect(note).toBe(' — pass processId to target another app');
  });
  it('the bridges put it on their own invoke misses', () => {
    expect(bridge).toMatch(/Element not found: name='\$name' id='\$automationId' ct='\$controlType'" \+ \(Get-ScopeNarrowNote/);
    expect(readFileSync(join(root, 'scripts/mac/ax-helper.swift'), 'utf8')).toMatch(/scopeNote\(app, searched: toSearch\)/);
  });
});

describe('UNSUPPORTED_ACTION on every OS\'s texts', () => {
  const cls = (t: string) => classifyResult(t, true, true);
  it('macOS and Windows "found, does not take it" texts', () => {
    for (const t of ['a11y invoke "Mute" missed — the element does not support toggle (no AXPress; AXError -25206).',
      'a11y invoke "x" missed — the element does not support select (no AXSelected / AXPress).',
      'a11y invoke "x" missed — Element does not support expand (no AXExpanded attribute or AXShowMenu action).',
      'a11y invoke "x" missed — ExpandCollapsePattern not supported.']) {
      expect(cls(t)?.code, t).toBe('UNSUPPORTED_ACTION');
    }
  });
  it('when the cascade tried every verb, the hint and next say to click the bounds, not to try those verbs again', () => {
    for (const t of ['a11y invoke "More" missed — No invoke/toggle/select/expand pattern.',
      'a11y invoke "Go" missed — the element does not support AXPress (AXError -25205) — click its coordinates instead.']) {
      const c = cls(t);
      expect(c?.code, t).toBe('UNSUPPORTED_ACTION');
      expect(c?.hint).toMatch(/click it at its bounds/);
      expect(c?.hint).not.toMatch(/try invoke/);
      expect(c?.next).toMatch(/"action":"click"/);
    }
  });
  it('real not-found texts, scope note included, stay NOT_FOUND', () => {
    for (const t of ['a11y invoke "x" missed — Element not found: name=\'x\' id=\'\' ct=\'\'; only the front window "A" was searched; this app has 2 other windows - window {"action":"focus","title":"..."} first to work in one',
      'a11y invoke "x" missed — element not found: Nothing here; only the front window "Save As" was searched; this app has 1 other window - window {"action":"focus"}']) {
      expect(cls(t)?.code, t).toBe('NOT_FOUND');
    }
  });
});

describe('window titles are compared without invisible characters', () => {
  it('the TS normalizer strips every format character (\\p{Cf}), folds whitespace, lower-cases', () => {
    expect(normalizeWindowText(EDGE_TITLE)).toBe('cc test page - [inprivate] - microsoft edge');
    for (const cp of [0x00ad, 0x200c, 0x200d, 0x2060, 0x2066, 0xfeff]) {
      expect(normalizeWindowText(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe('ab');
    }
    expect(windowTextIncludes(EDGE_TITLE, 'CC Test Page - [InPrivate] - Microsoft Edge')).toBe(true);
  });

  it('window_title_contains matches the title as typed', async () => {
    const adapter = { listWindows: vi.fn(async () => [{ processId: 1, processName: 'msedge', title: EDGE_TITLE }]) } as any;
    const r = await checkAssertions([{ type: 'window_title_contains', value: 'CC Test Page - [InPrivate] - Microsoft Edge' }], { adapter });
    expect(r.ok).toBe(true);
  });

  it('the bridge compares titles through ConvertTo-TitleKey on both sides (focus-window)', () => {
    const focus = fnBody(bridge, 'Cmd-FocusWindow');
    expect(focus).not.toMatch(/\.ToLower\(\)/);
    expect(focus.match(/ConvertTo-TitleKey/g)?.length).toBe(4);
  });

  it.runIf(process.platform === 'win32')('ConvertTo-TitleKey (run for real) maps the live Edge title and the typed one to the same key', () => {
    const fn = fnBody(bridge, 'ConvertTo-TitleKey');
    const script = `${fn}\n$a = ConvertTo-TitleKey ([string]::Concat('CC Test Page - [InPrivate] - Microsoft', [char]0x200B, ' Edge'))\n$b = ConvertTo-TitleKey 'cc test page  -  [inprivate] - MICROSOFT Edge '\nWrite-Output ($a -eq $b); Write-Output $a`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim().split(/\r?\n/);
    expect(out[0]).toBe('True');
    expect(out[1]).toBe('cc test page - [inprivate] - microsoft edge');
  });

  it('the macOS and Linux bridges normalize both sides of a title match too', () => {
    const swift = readFileSync(join(root, 'scripts/mac/ax-helper.swift'), 'utf8');
    expect(swift).toMatch(/generalCategory != \.format/);
    expect(swift).toMatch(/titleKey\(title\)\.contains\(needle\)/);
    const py = readFileSync(join(root, 'scripts/linux/atspi-bridge.py'), 'utf8');
    expect(py).toMatch(/unicodedata\.category\(c\) != 'Cf'/);
    expect(py).toMatch(/title_key\(safe\(lambda top=top: top\.get_name\(\), ''\)\) == title_key\(window_title\)/);
  });
});

describe('page-controlled text never decides a result code', () => {
  const platform = { listWindows: async () => [
    { processId: 7, title: 'x' }, { processId: 7, title: 'y' }] };
  const HOSTILE = ['the screen is locked', 'Request timed out - Edge', 'Invoke failed: demo', 'needs one-time consent', 'safety block - nope'];

  it('a window title in the find miss scope note (quoted) cannot change NOT_FOUND', async () => {
    for (const title of HOSTILE) {
      const note = await narrowedScopeNote(platform, [{ processId: 7, title }]);
      const text = `(no elements found)\nsearched: pid 7 ${quoteScreenText(title)}${note}`;
      expect(classifyResult(text, true, false)?.code, title).toBe('NOT_FOUND');
    }
  });

  it('a title with quote characters cannot break out of its quoting', async () => {
    const title = 'a" the screen is locked "b';
    const note = await narrowedScopeNote(platform, [{ processId: 7, title }]);
    expect(classifyResult(`(no elements found)${note}`, true, false)?.code).toBe('NOT_FOUND');
  });

  it('an element name in an invoke miss cannot change the code either', () => {
    for (const name of HOSTILE) {
      const text = `a11y invoke ${quoteScreenText(name)} missed — Element not found: name='${name}' id='' ct=''; only the front window was searched; this app has 2 other windows`;
      expect(classifyResult(text, true, true)?.code, name).toBe('NOT_FOUND');
    }
  });

  it('text inside an <untrusted-screen-content> block is not read either', () => {
    expect(classifyResult('Element not found: x\n<untrusted-screen-content>\nthe screen is locked\n</untrusted-screen-content>', true, true)?.code).toBe('NOT_FOUND');
  });

  it('clawdcursor\'s own words still classify (the blanking is only for quoted / wrapped spans)', () => {
    expect(classifyResult('smart_click failed: the screen is locked — unlock it first', true, true)?.code).toBe('SCREEN_LOCKED');
    expect(classifyResult('wait_for_element: timed out after 5000ms', true, true)?.code).toBe('TIMEOUT');
  });

  it('the bridges\' scope notes carry no window title', () => {
    expect(fnBody(bridge, 'Get-ScopeNarrowNote')).not.toMatch(/\.Name|Current\.Name/);
    expect(readFileSync(join(root, 'scripts/mac/ax-helper.swift'), 'utf8')).not.toMatch(/was searched; this app has[^\n]*\\\(title\)/);
    expect(readFileSync(join(root, 'scripts/linux/atspi-bridge.py'), 'utf8')).not.toMatch(/front window \\"\{title\}/);
  });
});

describe('invoke: expand state, disabled elements, no second click after a throw', () => {
  it('says when an expand did not change the state, like toggle', () => {
    expect(expandNote({ expandState: 'Expanded', expandChanged: true })).toBe(' — now expanded');
    expect(expandNote({ expandState: 'Collapsed', expandChanged: false })).toBe(' — still collapsed (the state did not change)');
    expect(expandNote(undefined)).toBe('');
  });

  it('no coordinate click after "Invoke failed:" (it may have acted); one after "no pattern"', () => {
    expect(canClickAtBounds({ data: { error: 'Invoke failed: The element is not enabled.' } })).toBe(false);
    expect(canClickAtBounds({ data: { error: 'No invoke/toggle/select/expand pattern' } })).toBe(true);
    expect(canClickAtBounds({})).toBe(true);
  });

  it('a disabled element is said to be disabled, with no click-at-bounds advice', () => {
    const c = classifyResult('a11y invoke "Send" missed — Invoke failed: The element is not enabled.', true, true);
    expect(c?.code).toBe('UNSUPPORTED_ACTION');
    expect(c?.hint).toMatch(/disabled/);
    expect(c?.hint).not.toMatch(/click it at its bounds/);
    expect(c?.next).toMatch(/state/);
  });

  it('an invoke that threw says it may have taken effect', () => {
    const c = classifyResult('a11y invoke "Go" missed — Invoke failed: Catastrophic failure.', true, true);
    expect(c?.code).toBe('UNSUPPORTED_ACTION');
    expect(c?.hint).toMatch(/may have taken effect/);
  });
});

describe('macOS and Linux find/invoke search only the key / active window', () => {
  it('ax-helper windowsToSearch returns the key window (plus the main window when a panel is key), else every window', () => {
    const swift = readFileSync(join(root, 'scripts/mac/ax-helper.swift'), 'utf8');
    const fn = swift.slice(swift.indexOf('func windowsToSearch'), swift.indexOf('/// What a miss says'));
    expect(fn).toMatch(/if let k = key\.window \{/);
    expect(fn).toMatch(/copyAttr\(el, "AXMainWindow"\)/);
    expect(fn).not.toMatch(/where !out\.contains/);
    // the doc comment sits above its own function, not above titleKey
    const above = swift.slice(swift.indexOf('/// The windows a find / invoke searches'), swift.indexOf('func windowsToSearch'));
    expect(above).not.toMatch(/func titleKey/);
  });

  it('the JXA that osascript loads (focus-window.jxa inlines the helpers) strips Cf characters, including U+061C, and matches the title as typed', () => {
    const src = readFileSync(join(root, 'scripts/mac/focus-window.jxa'), 'utf8');
    const grab = (name: string) => {
      const a = src.indexOf(`function ${name}(`);
      expect(a, name).toBeGreaterThan(-1);
      return src.slice(a, src.indexOf('\n}\n', a) + 3);
    };
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(`${grab('titleKey')}\n${grab('findTitleMatchWindow')}\nfunction getWinBounds() { return { width: 10, height: 10 }; }\nthis.titleKey = titleKey; this.find = findTitleMatchWindow;`, sandbox);
    const key = sandbox.titleKey as (s: string) => string;
    expect(key(`Microsoft${ZWSP} Edge`)).toBe('microsoft edge');
    expect(key(`a${String.fromCodePoint(0x061c)}b`)).toBe('ab');
    const wins = [{ name: () => 'Other' }, { name: () => EDGE_TITLE }];
    const hit = (sandbox.find as (w: unknown[], n: string) => { index: number } | null)(wins, 'CC Test Page - [InPrivate] - Microsoft Edge');
    expect(hit?.index).toBe(1);
    // the shared copy stays identical
    const picker = readFileSync(join(root, 'scripts/mac/_window-picker.jxa'), 'utf8');
    expect(picker).toContain(grab('titleKey'));
  });

  it('atspi-bridge find, the tree read and find_target all go through scope_toplevels', () => {
    const py = readFileSync(join(root, 'scripts/linux/atspi-bridge.py'), 'utf8');
    const tree = py.slice(py.indexOf('def cmd_get_tree'), py.indexOf('def cmd_find'));
    expect(tree).toMatch(/scope_toplevels\(app\)/);
    expect(tree).not.toMatch(/toplevels_active_first/);
    const find = py.slice(py.indexOf('def cmd_find'), py.indexOf('def cmd_focused'));
    expect(find).toMatch(/scope_toplevels\(app\)/);
    expect(find).not.toMatch(/toplevels_active_first/);
    const target = py.slice(py.indexOf('def find_target'), py.indexOf('def do_named_action'));
    expect(target).toMatch(/scope_toplevels\(app\)/);
  });
});
