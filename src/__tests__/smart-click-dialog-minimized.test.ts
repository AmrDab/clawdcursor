/**
 * Review of the visible-target rule (smart-click-visible-target.test.ts) against 1.5.27, which pressed the first match:
 *  - a toolbar and a dialog inside the same window both have "OK" / "Close" (WinUI, Electron, a web page's modal): the
 *    rule answered AMBIGUOUS where the one in the dialog the user is in is plainly meant;
 *  - a MINIMIZED window has every element at -32000, on no monitor: the rule answered `hidden`, yet a pattern invoke by
 *    processId on a minimized window worked (it needs no place on screen). `hidden` stays for an element on no monitor
 *    inside a window that is shown, and a place on no monitor is never handed out as a point to click;
 *  - a compile_ui element_id that hit AMBIGUOUS answered a bare "missed", without the list the name path gives.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { buildUnifiedTools } from '../core/agent-loop/tools';
import { structuredMissFields } from '../core/miss-text';
import { classifyResult } from '../core/result-codes';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { UIMap, UIElement } from '../core/sense/ui-map-types';
import type { AgentToolContext } from '../core/agent-loop/types';

const root = join(__dirname, '../..');
const bridge = readFileSync(join(root, 'scripts/ps-bridge.ps1'), 'utf8');
const fnBody = (name: string) => {
  const start = bridge.indexOf(`function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = bridge.indexOf('\nfunction ', start + 10);
  return next === -1 ? bridge.slice(start) : bridge.slice(start, next);
};
function runPs(functions: string[], body: string): string[] {
  const script = `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase\n${functions.map(fnBody).join('\n')}\n${body}`;
  // From a file: Cmd-InvokeElement alone is longer than a Windows command line may be. With a BOM, so PowerShell 5.1 reads UTF-8.
  const dir = mkdtempSync(join(tmpdir(), 'cc-bridge-test-'));
  const file = join(dir, 'run.ps1');
  writeFileSync(file, String.fromCharCode(0xfeff) + script, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' }).trim().split(/\r?\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const SELECT_SETUP = `
$monitors = @(@{ x = 0; y = 0; width = 3840; height = 2400 }, @{ x = 2796; y = -1080; width = 1920; height = 1080 })
function Rc($x, $y, $w, $h) { return @{ x = [int]$x; y = [int]$y; width = [int]$w; height = [int]$h } }
function Hit($i, $rect) { return @{ index = $i; pass = 1; rect = $rect; offscreen = $false } }
function Show($p) { if ($null -eq $p) { 'none' } elseif ($p.hidden) { 'hidden' } elseif ($null -ne $p.ambiguous) { "ambiguous $($p.ambiguous -join ',')" } else { "index $($p.index)" } }
$all = { param($h) $true }
$toolbar = Hit 0 (Rc 2900 -1040 60 24)
$dialog = Hit 1 (Rc 3500 -500 80 30)
$other = Hit 2 (Rc 3600 -500 80 30)
`;

// A fake window as in smart-click-visible-target.test.ts, plus: is the window minimized, which elements are in the
// dialog that has the focus, and an element with no pattern at all.
const FAKE_WINDOW = `
function Get-ProcessScopeWindows { param($wpid) return $script:window }
function Get-ScopeOtherWindows { param($a, $b) return 0 }
function Get-MonitorRects { return ,@(@{ x = 0; y = 0; width = 3840; height = 2400 }, @{ x = 2796; y = -1080; width = 1920; height = 1080 }) }
$script:minimized = $false
function Test-WindowMinimized { param($w) return $script:minimized }
$script:dialogIds = $null
function Get-FocusedDialog { if ($null -eq $script:dialogIds) { return $null }; return 'dialog' }
function Test-ElementUnder { param($el, $anc) return $script:dialogIds -contains $el.Id }
$script:pressed = @()
function El($id, $name, $x, $y, $w, $h, $hasPattern = $true) {
  $e = [pscustomobject]@{ Id = $id; HasPattern = $hasPattern; Current = [pscustomobject]@{ Name = $name; IsOffscreen = $false; IsEnabled = $true
    BoundingRectangle = (New-Object System.Windows.Rect ([double]$x), ([double]$y), ([double]$w), ([double]$h)); ControlType = [pscustomobject]@{ ProgrammaticName = 'ControlType.Button' } } }
  $e | Add-Member -MemberType ScriptMethod -Name GetCurrentPropertyValue -Value { param($p) return $this.HasPattern }
  $e | Add-Member -MemberType ScriptMethod -Name GetCurrentPattern -Value { param($p)
    if (-not $this.HasPattern) { throw 'no pattern' }
    $pat = [pscustomobject]@{ Owner = $this.Id }
    $pat | Add-Member -MemberType ScriptMethod -Name Invoke -Value { $script:pressed += $this.Owner }
    return $pat }
  return $e }
function Window($els) {
  $w = [pscustomobject]@{ Els = $els }
  $w | Add-Member -MemberType ScriptMethod -Name FindAll -Value { param($scope, $cond) return $this.Els }
  return $w }
`;
const FNS = ['Test-NameMatch', 'Test-RectOnMonitor', 'Select-InvokeTarget', 'Get-UiParent', 'Get-ContainerOf', 'Test-Activatable', 'Cmd-InvokeElement'];
const click = (name: string) => `$r = Cmd-InvokeElement ([pscustomobject]@{ processId = 3648; name = '${name}'; action = 'click' })`;

describe.runIf(process.platform === 'win32')('ps-bridge (run for real): the dialog in focus decides between visible matches', () => {
  it('Select-InvokeTarget: of several visible matches, the only one in the focused dialog is the one', () => {
    const out = runPs(['Test-RectOnMonitor', 'Select-InvokeTarget'], `${SELECT_SETUP}
"1 $(Show (Select-InvokeTarget @($toolbar, $dialog) $monitors $all { param($h) $h.index -eq 1 }))"          # a toolbar "Close" and the dialog's
"2 $(Show (Select-InvokeTarget @($toolbar, $dialog, $other) $monitors $all { param($h) $h.index -ge 1 }))"  # two in the dialog: still two
"3 $(Show (Select-InvokeTarget @($toolbar, $dialog) $monitors $all { param($h) $true }))"                   # the "dialog" is the whole window
"4 $(Show (Select-InvokeTarget @($toolbar, $dialog) $monitors $all { param($h) $false }))"                  # the focus is elsewhere
"5 $(Show (Select-InvokeTarget @($toolbar, $dialog) $monitors $all))"                                         # no rule given`);
    expect(out).toEqual(['1 index 1', '2 ambiguous 1,2', '3 ambiguous 0,1', '4 ambiguous 0,1', '5 ambiguous 0,1']);
  });

  it('invoke "Close": a toolbar button and the focused dialog\'s button -> the dialog\'s is pressed', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:window = Window @((El 'toolbar' 'Close' 2900 -1040 60 24), (El 'dialog-close' 'Close' 3500 -500 80 30))
$script:dialogIds = @('dialog-close')
${click('Close')}
"success=$($r.success) pressed=$($script:pressed -join ',')"`);
    expect(out).toEqual(['success=True pressed=dialog-close']);
  });

  it('invoke "Close" with no dialog in focus: ambiguous as before, nothing pressed', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:window = Window @((El 'toolbar' 'Close' 2900 -1040 60 24), (El 'dialog-close' 'Close' 3500 -500 80 30))
${click('Close')}
"success=$($r.success) reason=$($r.reason) pressed=$($script:pressed.Count)"`);
    expect(out).toEqual(['success=False reason=ambiguous pressed=0']);
  });

  it('the real helpers do not throw on something that is no UIA element', () => {
    const out = runPs(['Test-WindowMinimized', 'Get-FocusedDialog', 'Test-ElementUnder'], `
"minimized=$(Test-WindowMinimized ([pscustomobject]@{ A = 1 }))"
"under=$(Test-ElementUnder ([pscustomobject]@{ A = 1 }) ([pscustomobject]@{ A = 2 }))"`);
    expect(out).toEqual(['minimized=False', 'under=False']);
  });
});

describe.runIf(process.platform === 'win32')('ps-bridge (run for real): a minimized window', () => {
  // Minimized, every element is at -32000 and UIA calls all of them offscreen: where each one would be, and whether the
  // window would show it, cannot be told. So placement is UNKNOWN - it rules nothing in and nothing out - and the rest
  // of the choice stands: best name match, a control over a caption, the focused dialog, and never "the first in the tree".
  it('Select-InvokeTarget -placementUnknown: one match is the one; a control beats a caption; two controls are ambiguous, same rect or not', () => {
    const out = runPs(['Test-RectOnMonitor', 'Select-InvokeTarget'], `${SELECT_SETUP}
function Min($i, $pass = 1) { return @{ index = $i; pass = $pass; rect = (Rc -32000 -32000 160 28); offscreen = $true } }
$only1 = { param($h) $h.index -eq 1 }
"1 $(Show (Select-InvokeTarget @((Min 0)) $monitors $all $null -placementUnknown))"
"2 $(Show (Select-InvokeTarget @((Min 0), (Min 1)) $monitors $only1 $null -placementUnknown))"          # Text "New", then Button "New"
"3 $(Show (Select-InvokeTarget @((Min 0), (Min 1)) $monitors $all $null -placementUnknown))"            # the hidden link and the ribbon button
"4 $(Show (Select-InvokeTarget @((Min 0 2), (Min 1 1)) $monitors $all $null -placementUnknown))"        # the exact name still beats a looser match
"5 $(Show (Select-InvokeTarget @((Min 0), (Min 1)) $monitors $all { param($h) $h.index -eq 1 } -placementUnknown))" # the focused dialog still decides
"6 $(Show (Select-InvokeTarget @((Min 0), (Min 1)) $monitors $all))"                                     # a SHOWN window: both on no monitor
"7 $(Show (Select-InvokeTarget @() $monitors $all $null -placementUnknown))"`);
    expect(out).toEqual(['1 index 0', '2 index 1', '3 ambiguous 0,1', '4 index 1', '5 index 1', '6 hidden', '7 none']);
  });

  it('minimized, a single match: pressed by pattern', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:minimized = $true
$script:window = Window @((El 'play' 'Play' -32000 -32000 80 30))
${click('Play')}
"success=$($r.success) method=$($r.method) pressed=$($script:pressed -join ',')"`);
    expect(out).toEqual(['success=True method=InvokePattern pressed=play']);
  });

  it('minimized, the hidden web view\'s link and the ribbon button (both take a press): AMBIGUOUS with the list, nothing pressed', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:minimized = $true
$script:window = Window @((El 'web-link' 'New' -32000 -32000 160 28), (El 'ribbon' 'New' -32000 -32000 160 28))
${click('New')}
"success=$($r.success) reason=$($r.reason) n=$(@($r.candidates).Count) pressed=$($script:pressed.Count)"`);
    expect(out).toEqual(['success=False reason=ambiguous n=2 pressed=0']);
  });

  it('minimized and ambiguous: the list says so and gives no -32000 position to click (#364)', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:minimized = $true
$script:window = Window @((El 'web-link' 'New' -32000 -32000 160 28), (El 'ribbon' 'New' -32000 -32000 160 28))
${click('New')}
"minimized=$($r.minimized) bounds=$(@($r.candidates | Where-Object { $_.bounds }).Count)"`);
    expect(out).toEqual(['minimized=True bounds=0']);
  });
  it('minimized, a Text label and a Button of one name: the button, though the label is first in the tree', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:minimized = $true
$script:window = Window @((El 'label' 'New' -32000 -32000 160 28 $false), (El 'button' 'New' -32000 -32000 160 28))
${click('New')}
"success=$($r.success) pressed=$($script:pressed -join ',')"`);
    expect(out).toEqual(['success=True pressed=button']);
  });

  it('the minimized branch goes through the one choice: no "first match" shortcut is left in the bridge', () => {
    const inv = fnBody('Cmd-InvokeElement');
    expect(inv).toMatch(/\$minimized = Test-WindowMinimized \$window/);
    expect(inv).toMatch(/-placementUnknown:\$minimized/);
    expect(inv.match(/Select-InvokeTarget /g)).toHaveLength(1);
    expect(inv).not.toMatch(/Sort-Object \{ \$_\.pass \}/);
  });

  it('the same elements in a window that is SHOWN are hidden: nothing pressed', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:window = Window @((El 'play' 'Play' -32000 -32000 80 30))
${click('Play')}
"success=$($r.success) reason=$($r.reason) pressed=$($script:pressed.Count)"`);
    expect(out).toEqual(['success=False reason=hidden pressed=0']);
  });

  it('minimized and no pattern takes: a miss with NO point to click (it would be at -32000)', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:minimized = $true
$script:window = Window @((El 'play' 'Play' -32000 -32000 80 30 $false))
${click('Play')}
"success=$($r.success) reason=$($r.reason) clickPoint=$($null -ne $r.clickPoint) bounds=$($null -ne $r.bounds)"`);
    expect(out).toEqual(['success=False reason=unsupported clickPoint=False bounds=False']);
  });

  it('on a monitor and no pattern takes: the point to click is still given', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:window = Window @((El 'play' 'Play' 3000 -900 80 30 $false))
${click('Play')}
"success=$($r.success) reason=$($r.reason) clickPoint=$($r.clickPoint.x),$($r.clickPoint.y) bounds=$($r.bounds.width)x$($r.bounds.height)"`);
    expect(out).toEqual(['success=False reason=unsupported clickPoint=3040,-885 bounds=80x30']);
  });
});

// One rule for which element a name means (#386): exact beats prefix beats substring, and a match that only CONTAINS the
// name is never pressed in silence (#376); an ambiguous list names each one's window or dialog, and `within` picks (#382).
describe.runIf(process.platform === 'win32')('ps-bridge (run for real): exact > prefix > substring, and within', () => {
  const PARENTS = `
function Get-UiParent($el) { return $el.Parent }
function Box($name, $type) { return [pscustomobject]@{ Parent = $null; Current = [pscustomobject]@{ Name = $name; LocalizedControlType = ''; ControlType = [pscustomobject]@{ ProgrammaticName = $type } } } }
function In($el, $box) { $el | Add-Member -MemberType NoteProperty -Name Parent -Value $box -Force; return $el }
`;
  it('Select-InvokeTarget: a prefix match alone is pressed; a substring match alone, or only substrings, is listed as inexact', () => {
    const out = runPs(['Test-RectOnMonitor', 'Select-InvokeTarget'], `${SELECT_SETUP}
function P($i, $pass, $off = $false) { return @{ index = $i; pass = $pass; rect = (Rc (2900 + 100 * $i) -1040 60 24); offscreen = $off } }
function Say($p) { "$(Show $p) inexact=$([bool]$p.inexact)" }
"1 $(Say (Select-InvokeTarget @((P 0 2)) $monitors $all))"                 # "New document" for "New"
"2 $(Say (Select-InvokeTarget @((P 0 3)) $monitors $all))"                 # "What's New" for "New"
"3 $(Say (Select-InvokeTarget @((P 0 3), (P 1 2)) $monitors $all))"        # the prefix beats the substring
"4 $(Say (Select-InvokeTarget @((P 0 3 $true)) $monitors $all))"           # none visible, only a substring: still not pressed
"5 $(Say (Select-InvokeTarget @((P 0 1), (P 1 3)) $monitors $all))"`);
    expect(out).toEqual(['1 index 0 inexact=False', '2 ambiguous 0 inexact=True', '3 index 1 inexact=False', '4 ambiguous 0 inexact=True', '5 index 0 inexact=False']);
  });

  it('invoke "Request" with only "Request tasks": pressed, and the reply names the element pressed and the match', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:window = Window @((El 'req' 'Request tasks' 3500 -500 80 30))
${click('Request')}
"success=$($r.success) pressed=$($script:pressed -join ',') target=$($script:invokeTarget.name)|$($script:invokeTarget.controlType)|$($script:invokeTarget.match)"`);
    expect(out).toEqual(['success=True pressed=req target=Request tasks|ControlType.Button|prefix']);
  });

  it('invoke "New" with only "What\'s New" on screen: nothing pressed, listed as inexact so the caller names it in full', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:window = Window @((El 'whats-new' "What's New" 3500 -500 80 30))
${click('New')}
"success=$($r.success) reason=$($r.reason) inexact=$($r.inexact) pressed=$($script:pressed.Count) first=$($r.candidates[0].name)"`);
    expect(out).toEqual(["success=False reason=ambiguous inexact=True pressed=0 first=What's New"]);
  });

  it('two "Close": the list names the window or dialog of each; within picks the dialog\'s', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}${PARENTS}
$main = Box 'Designcenter' 'ControlType.Window'
$opts = Box 'Options' 'ControlType.Window'; $opts.Parent = $main
$script:window = Window @((In (El 'main-close' 'Close' 2900 -1040 60 24) $main), (In (El 'dialog-close' 'Close' 3500 -500 80 30) $opts))
${click('Close')}
"reason=$($r.reason) $(($r.candidates | ForEach-Object { "$($_.container.controlType):$($_.container.name)" }) -join ' ')"
$r = Cmd-InvokeElement ([pscustomobject]@{ processId = 3648; name = 'Close'; within = 'Options'; action = 'click' })
"success=$($r.success) pressed=$($script:pressed -join ',')"`);
    expect(out).toEqual(['reason=ambiguous ControlType.Window:Designcenter ControlType.Window:Options', 'success=True pressed=dialog-close']);
  });

  it('within names the outer window: its own Close is pressed, not the one of the dialog inside it, even with the dialog in focus', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}${PARENTS}
$main = Box 'Designcenter' 'ControlType.Window'
$opts = Box 'Options' 'ControlType.Window'; $opts.Parent = $main
$script:window = Window @((In (El 'main-close' 'Close' 2900 -1040 60 24) $main), (In (El 'dialog-close' 'Close' 3500 -500 80 30) $opts))
$script:dialogIds = @('dialog-close')
$r = Cmd-InvokeElement ([pscustomobject]@{ processId = 3648; name = 'Close'; within = 'Designcenter'; action = 'click' })
"success=$($r.success) pressed=$($script:pressed -join ',')"`);
    expect(out).toEqual(['success=True pressed=main-close']);
  });

  it('invoke "New" with only "Newsletter": a prefix that does not end at a word is listed as inexact, not pressed', () => {
    const out = runPs(FNS, `${FAKE_WINDOW}
$script:window = Window @((El 'letter' 'Newsletter' 3500 -500 80 30))
${click('New')}
"success=$($r.success) inexact=$($r.inexact) pressed=$($script:pressed.Count)"`);
    expect(out).toEqual(['success=False inexact=True pressed=0']);
  });
});

describe('invoke by element_id: an ambiguous name answers with the list, as the name path does', () => {
  const AMBIGUOUS = { success: false, reason: 'ambiguous', candidates: [
    { name: 'Send', controlType: 'ControlType.MenuItem', bounds: { x: 2800, y: -1070, width: 40, height: 20 } },
    { name: 'Send', controlType: 'ControlType.Button', bounds: { x: 2816, y: -1030, width: 64, height: 72 } },
  ] };
  const element: UIElement = { id: 'el_0', role: 'button', text: 'Send', normalized_text: 'send', bounds: [10, 20, 40, 12],
    confidence: 0.9, sources: ['a11y'], clickable: true, actionable: true };
  const map: UIMap = { snapshot_id: 'obs_1', platform: 'windows', active_app: 'notepad', process_id: '9',
    window_title: 'Untitled - Notepad', window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
    compiled_at: '0', sources_used: ['window', 'a11y'], elements: [element], anchors: {} };
  const run = async (reply: Record<string, unknown>) => {
    const holder = new UIMapHolder();
    while (holder.nextId() !== map.snapshot_id) { /* advance the counter to the map's id */ }
    holder.put(map, Date.now());
    const invokeElement = vi.fn(async () => ({ success: false, data: structuredMissFields(reply) }));
    const mouseClick = vi.fn(async () => {});
    const platform = { invokeElement, mouseClick, listDisplays: async () => [],
      getActiveWindow: async () => ({ processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } }) };
    const ctx = { platform, task: 't', screen: { logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }, screenshotsCaptured: { n: 0 }, uiMaps: holder } as unknown as AgentToolContext;
    const r = await buildUnifiedTools().find(t => t.name === 'invoke_element')!.execute({ element_id: 'el_0', snapshot_id: 'obs_1' }, ctx);
    return { r, invokeElement, mouseClick };
  };

  it('lists the candidates and is AMBIGUOUS, after one bridge call and no click', async () => {
    const { r, invokeElement, mouseClick } = await run(AMBIGUOUS);
    expect(r.success).toBe(false);
    expect(invokeElement).toHaveBeenCalledTimes(1);
    expect(mouseClick).not.toHaveBeenCalled();
    expect(r.text).toContain('el_0');
    expect(r.text).toContain('[MenuItem] "Send" @2800,-1070 40x20');
    expect(r.text).toContain('[Button] "Send" @2816,-1030 64x72');
    expect(classifyResult(r.text, true, true, 'mcp').code).toBe('AMBIGUOUS');
  });

  it('a hidden element says so (ELEMENT_HIDDEN), not a bare "missed"', async () => {
    const { r } = await run({ success: false, reason: 'hidden' });
    expect(classifyResult(r.text, true, true, 'mcp').code).toBe('ELEMENT_HIDDEN');
  });
});

describe('stale text about the OCR reply', () => {
  it('the tool description ties `confidence` to the whole-screen JSON, which is where it is', async () => {
    const { getOcrTools } = await import('../tools/ocr');
    const d = getOcrTools()[0].description;
    expect(d).not.toMatch(/\. An element's `confidence`/);
    expect(d).toMatch(/scope:"screen"[^.]*JSON[^.]*`confidence`/);
  });
  it('registry.ts no longer says the OCR tool always answers structured JSON', () => {
    const reg = readFileSync(join(root, 'src/tools/registry.ts'), 'utf8');
    expect(reg).not.toMatch(/No format change\./);
    expect(reg).not.toMatch(/whose structured JSON \(elements\[\] \+ bounds \+\n\s*\/\/ coordinateSystem\) is what external agents need/);
    expect(reg).toMatch(/`@x,y "text"` rows[^\n]*scope:"window"/);
  });
});
