/**
 * #356: a drawn surface (a canvas, a whiteboard) is an unnamed element with no children, and the bridge dropped every
 * unnamed childless node, so read_tree could not say "this area is drawn, read it with OCR". ps-bridge's tree builder
 * keeps an unnamed leaf that covers a quarter of the walk root as a role-only node. Run for real against a fake window;
 * the TS side (opaqueArea) is in perception-without-tree.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FAKE_UIA, runPsJson, topLevel } from './helpers/ps-bridge-harness';

type Node = { name: string; controlType: string; bounds: { x: number; y: number; width: number; height: number }; children: Node[] };

describe.runIf(process.platform === 'win32')('ps-bridge tree builder (run for real): a large unnamed leaf is kept', () => {
  let tree: Node;
  beforeAll(() => {
    const setup = `${FAKE_UIA}\n${topLevel('$stateTypes')}\n${topLevel('$interactiveTypes')}`;
    tree = runPsJson(['ConvertTo-UINode', 'Add-StateFields', 'Get-ShownValue'], setup, [`
$w = New-FakeEl -Name 'Board - Browser' -Type Window -Rect @(0, 0, 1000, 800) -Children @(
  (New-FakeEl -Name '' -Type Custom -Rect @(0, 50, 1000, 750) -Children @(
    (New-FakeEl -Name '' -Type Pane -Rect @(0, 120, 1000, 680)),
    (New-FakeEl -Name '' -Type Pane -Rect @(0, 50, 40, 40)))),
  (New-FakeEl -Name 'Pen' -Type Button -Rect @(0, 60, 40, 40)))
ConvertTo-Json -InputObject (ConvertTo-UINode -Element $w) -Compress -Depth 8`])[0] as Node;
  }, 120_000);

  it('the drawn surface stays as a role-only node; a small unnamed leaf and the unnamed wrapper are dropped', () => {
    const flat = (n: Node | Node[]): Node[] => Array.isArray(n) ? n.flatMap(flat) : [n, ...(n.children ?? []).flatMap(flat)];
    expect(flat(tree).map(n => [n.name, n.controlType, n.bounds.y, n.bounds.height])).toEqual([
      ['Board - Browser', 'ControlType.Window', 0, 800], ['', 'ControlType.Pane', 120, 680], ['Pen', 'ControlType.Button', 60, 40],
    ]);
  });
});
