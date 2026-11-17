/**
 * Live Win11 re-test 2026-10-15: `accessibility state "Subscribe"` on a ticked WinForms checkbox answered no
 * checked/unchecked at all: find-element never read TogglePattern. find fills the state through Add-StateFields, the
 * one helper the tree and the focus read use too (#323). Run for real with fake elements; the adapter side is in
 * windows-element-state.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FAKE_UIA, runPsJson, topLevel } from './helpers/ps-bridge-harness';

describe.runIf(process.platform === 'win32')('ps-bridge find-element (run for real, fake elements): checkbox state', () => {
  let found: Array<{ name: string; toggleState?: string; expanded?: boolean }>;
  beforeAll(() => {
    const setup = `${FAKE_UIA}\n${topLevel('$stateTypes')}
function Get-ProcessScopeWindows { param($wpid) return $script:window }`;
    found = runPsJson(['Cmd-FindElement', 'Add-StateFields', 'Get-ShownValue', 'Test-NameMatch', 'Test-RectOnMonitor', 'Get-MonitorRects'], setup, [`
$script:window = New-FakeEl -Name 'Form' -Type Window -Children @(
  (New-FakeEl -Name 'Subscribe' -Type CheckBox -Patterns @{ Toggle = (New-TogglePattern On) }),
  (New-FakeEl -Name 'Subscribe later' -Type CheckBox -Patterns @{ Toggle = (New-TogglePattern Off) }),
  (New-FakeEl -Name 'Subscribe panel' -Type Pane -Patterns @{ Toggle = (New-TogglePattern On) }),
  (New-FakeEl -Name 'Subscribe options' -Type TreeItem -Patterns @{ ExpandCollapse = (New-ExpandPattern Expanded) }))
ConvertTo-Json -InputObject (Cmd-FindElement ([pscustomobject]@{ processId = 7; name = 'Subscribe' })) -Compress -Depth 5`])[0] as typeof found;
  }, 120_000);

  it('a checkbox carries its TogglePattern state; a pane (no state type) is not asked; an expander says it is expanded', () => {
    expect(found.map(e => [e.name, e.toggleState ?? null, e.expanded ?? null])).toEqual([
      ['Subscribe', 'On', null], ['Subscribe later', 'Off', null], ['Subscribe panel', null, null], ['Subscribe options', null, true],
    ]);
  });
});
