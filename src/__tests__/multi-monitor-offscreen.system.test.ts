/**
 * A monitor left of / above the primary has negative coordinates, and the bridge's tree builder blanked every bound
 * below zero, so the elements on it had no position. ConvertTo-UINode keeps them as they are (the adapter decides what
 * is on no monitor: multi-monitor-offscreen.test.ts). Run for real against a fake window.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FAKE_UIA, runPsJson, topLevel } from './helpers/ps-bridge-harness';

type Node = { name: string; bounds: { x: number; y: number; width: number; height: number }; children: Node[] };

describe.runIf(process.platform === 'win32')('ps-bridge tree builder (run for real, a fake window on a monitor above-left)', () => {
  let tree: Node;
  beforeAll(() => {
    const setup = `${FAKE_UIA}\n${topLevel('$stateTypes')}\n${topLevel('$interactiveTypes')}`;
    tree = runPsJson(['ConvertTo-UINode', 'Add-StateFields', 'Get-ShownValue'], setup, [`
$w = New-FakeEl -Name 'Win' -Type Window -Rect @(-1920, -1080, 1920, 1080) -Children @(
  (New-FakeEl -Name 'Left' -Type Button -Rect @(-1900, -500, 100, 30)), (New-FakeEl -Name 'Main' -Type Button -Rect @(100, 100, 50, 20)))
ConvertTo-Json -InputObject (ConvertTo-UINode -Element $w) -Compress -Depth 8`])[0] as Node;
  }, 120_000);

  it('keeps negative positions, on the window and on its elements', () => {
    expect(tree.bounds).toEqual({ x: -1920, y: -1080, width: 1920, height: 1080 });
    expect(tree.children.map(c => [c.name, c.bounds])).toEqual([
      ['Left', { x: -1900, y: -500, width: 100, height: 30 }], ['Main', { x: 100, y: 100, width: 50, height: 20 }],
    ]);
  });
});
