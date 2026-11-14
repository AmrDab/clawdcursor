/**
 * Windows blind-mode regressions from a live Win11 run (2026-10-14) driving
 * Notepad's Save as dialog with the compact tools:
 *
 *  1. Every Win32 control (File name Edit id 1001, Save Button id 1, ComboBox,
 *     ListView) came back as ControlType.Pane with no Value/Invoke pattern, so
 *     set_value / invoke on them failed. Root cause: UIAutomationClient loads its
 *     client-side proxies lazily, once, via a stack walk that throws under
 *     PowerShell's dynamic frames — after which every HWND gets only the bare
 *     HWND provider. The bridge now registers the proxies from compiled code.
 *  2. compile_ui / read_tree walked the process's MAIN window, not the modal
 *     dialog in the foreground (owned dialogs are UIA children of the owner).
 *  3. `window list` omitted owned dialogs for the same reason.
 *
 * (1) is checked against the real bridge on Windows: the desktop's icon view
 * (SysListView32) is a List through the proxy and a Pane without it, and the
 * failure needs a FromHandle call first — exactly the bridge's usual opener,
 * get-foreground-window. (2) and (3) need a live dialog, so they are
 * source-level guards (windows-blind-dialogs.test.ts). The name matching, label, modal-invoke and
 * activate-at-point rules run below against fake elements.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { INVOKE_FUNCTIONS, INVOKE_SETUP, runPsCases } from './helpers/ps-bridge-harness';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { psOpts } from '../platform/ps-spawn';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', '..', 'scripts', 'ps-bridge.ps1');
const bridge = readFileSync(bridgePath, 'utf8');

function invokerSource(): string {
  const at = bridge.indexOf('class UiaInvoker');
  if (at === -1) return '';
  const start = bridge.indexOf('\n', bridge.lastIndexOf('@"', at)) + 1;
  return bridge.slice(start, bridge.indexOf('\n"@', at)).replace(/\r$/, '');
}

describe('ps-bridge: Win32 controls keep their real control type (bug 1)', () => {
  it.runIf(process.platform === 'win32')('a ListView is reported as List, not Pane, after a FromHandle-first session', (ctx) => {
    const pidOut = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).Id'], psOpts({ encoding: 'utf8' })).trim();
    const pid = Number(pidOut);
    if (!pid) ctx.skip('no shell (headless runner): nothing to probe');
    const input = [
      JSON.stringify({ cmd: 'get-foreground-window' }),
      JSON.stringify({ cmd: 'find-element', automationId: '1', processId: pid, maxResults: 10 }),
      'EXIT', '',
    ].join('\n');
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath],
      psOpts({ input, encoding: 'utf8', timeout: 60_000 }));
    const lines = out.split(/\r?\n/).filter(Boolean);
    const found = JSON.parse(lines[lines.length - 1]) as Array<{ className: string; controlType: string }>;
    const listViews = found.filter(e => e.className === 'SysListView32');
    if (listViews.length === 0) ctx.skip('no desktop icon view on this machine');
    for (const lv of listViews) expect(lv.controlType).toBe('ControlType.List');
  }, 90_000);
});

describe('ps-bridge: a Win32 Invoke that opens a modal box does not block the bridge', () => {
  it.runIf(process.platform === 'win32')('UiaInvoker returns "pending" for a long call, "ok" / "error:" otherwise, and keeps a late error', () => {
    const src = invokerSource();
    expect(src).not.toBe('');
    const script = [
      `Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase @'\n${src}\n'@`,
      `Add-Type @'\npublic static class T { public static void Slow() { System.Threading.Thread.Sleep(1500); }`,
      ` public static void SlowThrow() { System.Threading.Thread.Sleep(600); throw new System.InvalidOperationException("late boom"); }`,
      ` public static void Fast() { } public static void Boom() { throw new System.InvalidOperationException("boom"); } }\n'@`,
      `function D($n) { [System.Delegate]::CreateDelegate([System.Action], [T].GetMethod($n)) }`,
      `$sw = [Diagnostics.Stopwatch]::StartNew(); $a = [UiaInvoker]::Run((D 'Slow'), 300); $ms = $sw.ElapsedMilliseconds`,
      `$b = [UiaInvoker]::Run((D 'Fast'), 300); $c = [UiaInvoker]::Run((D 'Boom'), 300)`,
      `$d = [UiaInvoker]::Run((D 'SlowThrow'), 100); Start-Sleep -Milliseconds 1000; $e = [UiaInvoker]::TakeLateError(); $f = [UiaInvoker]::TakeLateError()`,
      // The expand rung of a click is bounded the same way (window-scope-invoke.system.test.ts runs the call).
      `$x = @('Expand', 'Collapse' | Where-Object { [UiaInvoker].GetMethod($_, [type[]]@([System.Windows.Automation.ExpandCollapsePattern], [int])) })`,
      `@{ a=$a; ms=$ms; b=$b; c=$c; d=$d; e=$e; f=$f; x=$x } | ConvertTo-Json -Compress`,
    ].join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'clawd-invoker-'));
    const file = join(dir, 'invoker.ps1');
    writeFileSync(file, '﻿' + script, 'utf8');
    let out: string;
    try {
      out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        psOpts({ encoding: 'utf8', timeout: 60_000 }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const r = JSON.parse(out.trim().split(/\r?\n/).pop()!);
    expect(r.a).toBe('pending');
    expect(r.ms).toBeLessThan(1000);  // returned at the wait, not when the call ended
    expect(r.b).toBe('ok');           // the still-running call does not block the next one
    expect(r.c).toBe('error:boom');
    expect(r.d).toBe('pending');
    expect(r.e).toBe('late boom');    // a failure after the wait is kept…
    expect(r.f).toBeNull();           // …and reported once
    expect(r.x).toEqual(['Expand', 'Collapse']);
  }, 90_000);
});

// The by-name rules of invoke-element and activate-at-point, run for real against fake elements and windows (the harness
// fakes Win32UIA / ScreenPM: nothing is raised or pressed on the desktop).
describe.runIf(process.platform === 'win32')('ps-bridge (run for real, fake elements): names, labels, a modal invoke, a no-activate window', () => {
  const field = (name: string, value: string, type = 'Edit') => `(New-FakeEl -Name '${name}' -Type ${type} -Patterns @{ Value = (New-ValuePattern '${value}') })`;
  const get = (name: string, els: string) => `Invoke-Fake @(${els}) @{ name = '${name}'; action = 'get-value' }`;
  const CASES = {
    // The Save as dialog: a column header "Name" and the "File name:" box. The label's colon does not count.
    colon: get('File name', `(New-FakeEl -Name 'Name' -Type HeaderItem), ${field('File name:', 'a.txt')}`),
    // "contains the request" (pass 3) comes before "a real part of the request" (pass 4), whatever the tree order.
    containsFirst: get('file name', `${field('file nam', 'rev')}, ${field('my file name box', 'fwd')}`),
    realPart: get('file name', field('file nam', 'rev')),
    // A lone "C" is no part of "User code 0" (live 2026-10-20: a PDF's text run matched it).
    loneLetter: get('User code 0', field('C', 'x')),
    // A value action takes the editable match over the label of the same name, label first in the tree.
    labelFirst: get('File name', `(New-FakeEl -Name 'File name:' -Type Text), ${field('File name:', 'b.txt')}`),
    // A label alone: the field it LABELS (LabeledBy), not the first field near it; none labelled: the label's own name.
    labeledBy: `$lab = New-FakeEl -Name 'Email' -Type Text; $other = New-FakeEl -Name 'Phone' -Type Text
$e1 = New-FakeEl -Name '' -Patterns @{ Value = (New-ValuePattern '555') } -LabeledBy $other
$e2 = New-FakeEl -Name '' -Patterns @{ Value = (New-ValuePattern 'a@b.c') } -LabeledBy $lab
$lab.Parent = New-FakeEl -Name '' -Type Pane -Children @($e1, $e2)
${get('Email', '$lab, $e1, $e2')}`,
    notLabeled: `$lab = New-FakeEl -Name 'Fax' -Type Text; $other = New-FakeEl -Name 'Phone' -Type Text
$e1 = New-FakeEl -Name '' -Patterns @{ Value = (New-ValuePattern '555') } -LabeledBy $other
$lab.Parent = New-FakeEl -Name '' -Type Pane -Children @($e1)
${get('Fax', '$lab, $e1')}`,
    // A Win32 button whose Invoke opens a modal box: UiaInvoker gives up waiting at 1.2 s ("pending").
    pending: `Add-Type 'public static class UiaInvoker { public static System.Collections.Generic.List<int> Waits = new System.Collections.Generic.List<int>();
  public static string Invoke(object p, int ms) { Waits.Add(ms); return "pending"; } }'
$r = Invoke-Fake @(New-FakeEl -Name 'Save' -Type Button -Patterns @{ Invoke = (New-InvokePattern 'save') }) @{ name = 'Save'; action = 'click' }
"waits $([UiaInvoker]::Waits -join ',') pressed $($script:pressed.Count)"
$r`,
  };
  const keys = Object.keys(CASES) as Array<keyof typeof CASES>;
  let out: Record<keyof typeof CASES, string[]>;
  let activate: string[][];
  const json = (k: keyof typeof CASES) => JSON.parse(out[k][out[k].length - 1]);
  beforeAll(() => {
    const res = runPsCases(INVOKE_FUNCTIONS, INVOKE_SETUP, keys.map(k => CASES[k]));
    out = Object.fromEntries(keys.map((k, i) => [k, res[i]])) as typeof out;
    const at = `$r = Cmd-ActivateAtPoint ([pscustomobject]@{ x = 10; y = 10 }); ConvertTo-Json -InputObject $r -Compress; $([Win32UIA]::Calls -join ',')`;
    activate = runPsCases(['Cmd-ActivateAtPoint', 'Test-ForegroundDenylisted'], '', [
      `[ScreenPM]::At = 500; [ScreenPM]::ExStyles[500] = 0x08000000; [Win32UIA]::Foreground = 100\n${at}`,
      `[ScreenPM]::At = 100; [Win32UIA]::Foreground = 100\n${at}`,
    ]);
  }, 120_000);

  it('"File name" is the "File name:" box, not the "Name" column header', () => {
    expect(json('colon')).toMatchObject({ success: true, value: 'a.txt' });
  });

  it('an element containing the request is taken before one that is a part of it; a real part alone still counts', () => {
    expect(json('containsFirst')).toMatchObject({ value: 'fwd' });
    expect(json('realPart')).toMatchObject({ value: 'rev' });
  });

  it('a single letter is no part of the request: not found', () => {
    expect(json('loneLetter')).toMatchObject({ success: false, reason: 'not_found' });
  });

  it('a value action takes the editable match over its label', () => {
    expect(json('labelFirst')).toMatchObject({ value: 'b.txt' });
  });

  it('a value read of a label alone reads the field it labels, and never guesses a field it does not', () => {
    expect(json('labeledBy')).toMatchObject({ value: 'a@b.c', method: 'ValuePattern' });
    expect(json('notLabeled')).toMatchObject({ value: 'Fax', method: 'Name', readable: false });
  });

  it('click goes through the bounded UiaInvoker (1.2 s) and reports a pending invoke as a success to re-read', () => {
    expect(out.pending[0]).toBe('waits 1200 pressed 0');
    expect(json('pending')).toMatchObject({ success: true, method: 'InvokePattern', data: { pending: true } });
  });

  it('activate-at-point: a WS_EX_NOACTIVATE window (the pause pill) is a no-op, nothing raised; the foreground one too', () => {
    expect(JSON.parse(activate[0][0])).toMatchObject({ success: true, action: 'noop', reason: 'no-activate-window' });
    expect(JSON.parse(activate[1][0])).toMatchObject({ success: true, action: 'noop', reason: 'already-foreground' });
    expect(activate.flat().join()).not.toMatch(/SetForegroundWindow|BringWindowToTop/);
  });
});
