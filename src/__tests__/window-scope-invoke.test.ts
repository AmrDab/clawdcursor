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

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { runActivationLadder } from '../core/agent-loop/tools';
import { normalizeWindowText, windowTextIncludes } from '../tools/window-text';
import { checkAssertions } from '../core/verify/assertions';

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

describe('ps-bridge: find and invoke stay in the window the agent works in', () => {
  const scope = fnBody(bridge, 'Get-ProcessScopeWindows');

  it('the shared helper returns only the foreground window (at GA_ROOT) when it belongs to the pid, else all windows of the pid', () => {
    expect(scope).toMatch(/GetForegroundWindow\(\)/);
    expect(scope).toMatch(/GetAncestor\(\$fgH, 2\)/);
    expect(scope).toMatch(/if \(\$fgPid -eq \$wpid\)[\s\S]*FromHandle\(\$rootH\)/);
    expect(scope).toMatch(/ProcessIdProperty, \$wpid[\s\S]*TreeScope\]::Children, \$pc/);
  });

  it('find-element searches the scope windows, not every window of the pid', () => {
    const find = fnBody(bridge, 'Cmd-FindElement');
    expect(find).toMatch(/Get-ProcessScopeWindows \$wpid/);
    expect(find).not.toMatch(/ProcessIdProperty/);
  });

  it('invoke-element no longer takes the FIRST window of the pid; it searches the scope windows in order', () => {
    const inv = fnBody(bridge, 'Cmd-InvokeElement');
    expect(inv).toMatch(/Get-ProcessScopeWindows \$wpid/);
    expect(inv).toMatch(/foreach \(\$window in \$scopeWindows\)/);
    expect(inv).not.toMatch(/FindFirst\(\[System\.Windows\.Automation\.TreeScope\]::Children/);
  });

  it('the only pid conditions left are the helper and the tree read (which reads the foreground window first)', () => {
    expect([...bridge.matchAll(/ProcessIdProperty/g)].length).toBe(2);
  });
});

describe('invoke activates an expandable element and reports why a miss is a miss', () => {
  it('the click cascade ends in ExpandCollapsePattern and says which way it flipped', () => {
    const inv = fnBody(bridge, 'Cmd-InvokeElement');
    const click = inv.slice(inv.indexOf('"click" {'), inv.indexOf('"set-value" {'));
    expect(click).toMatch(/ExpandCollapsePattern\]::Pattern/);
    expect(click).toMatch(/if \(\$was -eq 'Expanded'\) \{ \$p\.Collapse\(\); \$now = 'Collapsed' \}/);
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

  it.runIf(process.platform === 'win32')('ps-bridge.ps1 parses', () => {
    const file = join(root, 'scripts/ps-bridge.ps1').replace(/'/g, "''");
    const script = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); Write-Output $e.Count`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
    expect(out).toBe('0');
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

describe('macOS and Linux find/invoke search only the key / active window', () => {
  it('ax-helper windowsToSearch returns just the key window when there is one', () => {
    const swift = readFileSync(join(root, 'scripts/mac/ax-helper.swift'), 'utf8');
    expect(swift).toMatch(/if let k = key\.window \{ return \(\[k\], key\.hung\) \}/);
  });

  it('atspi-bridge find and find_target use scope_toplevels (active window only), not every toplevel', () => {
    const py = readFileSync(join(root, 'scripts/linux/atspi-bridge.py'), 'utf8');
    expect(py).toMatch(/def scope_toplevels[\s\S]*return active or tops/);
    const find = py.slice(py.indexOf('def cmd_find'), py.indexOf('def cmd_focused'));
    expect(find).toMatch(/scope_toplevels\(app\)/);
    expect(find).not.toMatch(/toplevels_active_first/);
    const target = py.slice(py.indexOf('def find_target'), py.indexOf('def do_named_action'));
    expect(target).toMatch(/scope_toplevels\(app\)/);
  });
});
