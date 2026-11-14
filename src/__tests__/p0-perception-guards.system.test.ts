/**
 * P0-2: the bridge's command loop piped its result into ConvertTo-Json. An EMPTY array pipes zero objects, so the bridge
 * wrote nothing and PSRunner stalled for its full 20 s timeout on every element miss; a one-element array was unwrapped
 * to a bare object. The real loop, run on stdin with the real find-element against a fake window, answers "[]" and
 * "[{...}]". The TS side is in p0-perception-guards.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FAKE_UIA, commandLoop, runPs, topLevel } from './helpers/ps-bridge-harness';

describe.runIf(process.platform === 'win32')('ps-bridge command loop (run for real on stdin): every reply is one JSON line', () => {
  let lines: string[];
  beforeAll(() => {
    const setup = `${FAKE_UIA}\n${topLevel('$stateTypes')}
function Get-ProcessScopeWindows { param($wpid) if ($wpid -eq 7) { return $script:window } }
$script:window = New-FakeEl -Name 'Form' -Type Window -Children @((New-FakeEl -Name 'OK' -Type Button), (New-FakeEl -Name 'Cancel' -Type Button))
${commandLoop()}`;
    const input = [
      { cmd: 'find-element', processId: 7, name: 'nothing like it' },   // no match: an empty array
      { cmd: 'find-element', processId: 7, name: 'OK' },                // one match: an array of one
      { cmd: 'find-element', processId: 99, name: 'OK' },               // no window for the pid: nothing
      { cmd: 'ping' },
    ].map(c => JSON.stringify(c)).join('\n') + '\nEXIT\n';
    lines = runPs(['Cmd-FindElement', 'Add-StateFields', 'Get-ShownValue', 'Test-NameMatch', 'Test-RectOnMonitor', 'Get-MonitorRects'], setup, { input });
  }, 120_000);

  it('an empty result is "[]" and a single one stays an array: one reply per command, none missing', () => {
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('[]');
    const one = JSON.parse(lines[1]);
    expect(Array.isArray(one)).toBe(true);
    expect(one.map((e: { name: string }) => e.name)).toEqual(['OK']);
    // No window for the pid: Cmd-FindElement's `,(New-Object Object[] 0)` reaches Windows PowerShell 5.1's ConvertTo-Json
    // wrapped, as {"value":[],"Count":0}. Still one line (no stall), and the adapter reads a non-array as no elements.
    const none = JSON.parse(lines[2]);
    expect(Array.isArray(none) ? none : none.value).toEqual([]);
    expect(JSON.parse(lines[3])).toEqual({ pong: true });
  });
});
