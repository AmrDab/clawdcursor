/**
 * `accessibility find "Model"` in Designcenter NX (live Win11 2026-11-10) returned the text of a web view the window
 * does not show (its Discovery Center panel), laid out down to y = 31,000: on no monitor, yet listed with a position
 * like any element. read_tree already flagged such rects offscreen (#340); find and the focused element did not, because
 * the rule lived inside getUiTree and they read through other bridge commands (find-element, get-focused-element).
 *
 * One rule for every element the Windows adapter hands out: a rect that overlaps no monitor is not a position. The
 * element is marked offscreen, loses its bounds, and is listed after the ones on screen.
 */
import { describe, it, expect, vi } from 'vitest';

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

let replies: Record<string, unknown> = {};
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: (c: { cmd: string }) => Promise.resolve(replies[c.cmd]), start: vi.fn(), stop: vi.fn() },
}));

import { runPs } from './helpers/ps-bridge-harness';

// The bridge cut find at 20 matches in TREE order, before anything put the visible ones first: a hidden web view with
// more than 20 matches came first in the tree and the one element on screen was never returned.
describe.runIf(process.platform === 'win32')('ps-bridge find-element (run for real, fake window): the cut comes after "on screen first"', () => {
  const run = (body: string) => runPs(['Test-NameMatch', 'Test-RectOnMonitor', 'Get-ShownValue', 'Cmd-FindElement'], body);
  const FAKES = `
function Get-ProcessScopeWindows { param($wpid) return $script:window }
function Get-MonitorRects { return ,@(@{ x = 0; y = 0; width = 3840; height = 2400 }, @{ x = 2796; y = -1080; width = 1920; height = 1080 }) }
function Add-StateFields { }
$script:read = 0
function El($name, $x, $y) {
  $cur = [pscustomobject]@{ AutomationId = ''; ClassName = ''; ProcessId = 3648; IsEnabled = $true
    BoundingRectangle = (New-Object System.Windows.Rect ([double]$x), ([double]$y), 200.0, 20.0); ControlType = [pscustomobject]@{ ProgrammaticName = 'ControlType.Text' } }
  $cur | Add-Member -MemberType ScriptProperty -Name Name -Value { $script:read++; return $this.N }.GetNewClosure()
  $cur | Add-Member -MemberType NoteProperty -Name N -Value $name
  return [pscustomobject]@{ Current = $cur } }
function Window($els) {
  $w = [pscustomobject]@{ Els = $els }
  $w | Add-Member -MemberType ScriptMethod -Name FindAll -Value { param($scope, $cond) return $this.Els }
  return $w }
$hidden = @(0..24 | ForEach-Object { El "Model help $_" 2850 (4000 + $_ * 1000) })
`;

  it('25 hidden matches before the visible one: the visible one is returned, first, and the list is still 20', () => {
    const out = run(`${FAKES}
$script:window = Window ($hidden + @((El 'model1.prt' 3100 -960)))
$r = Cmd-FindElement ([pscustomobject]@{ processId = 3648; name = 'Model' })
"count=$($r.Count) first=$($r[0].name) at $($r[0].bounds.x),$($r[0].bounds.y) second=$($r[1].name) last=$($r[19].name)"`);
    expect(out).toEqual(['count=20 first=model1.prt at 3100,-960 second=Model help 0 last=Model help 18']);
  });

  it('20 matches on screen end the search: the rest of the window is not read', () => {
    const out = run(`${FAKES}
$visible = @(0..29 | ForEach-Object { El "Model row $_" 3100 (-1000 + $_ * 20) })
$script:window = Window ($visible + $hidden)
$r = Cmd-FindElement ([pscustomobject]@{ processId = 3648; name = 'Model' })
"count=$($r.Count) first=$($r[0].name) last=$($r[19].name) stoppedEarly=$($script:read -lt 60)"`);
    expect(out).toEqual(['count=20 first=Model row 0 last=Model row 19 stoppedEarly=True']);
  });
});
