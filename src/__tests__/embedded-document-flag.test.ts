/**
 * #383: what an embedded document or web view holds is its content, not the app's controls. Each adapter marks it
 * (`inDocument`) from its own tree, and read_screen lists the app's controls first (blind-offscreen.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {} }, keyboard: { config: {} }, screen: {},
  Button: { LEFT: 0 }, Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class {}, Region: class {},
}));
vi.mock('../platform/ps-runner', () => ({ psRunner: { run: vi.fn(), start: vi.fn(async () => {}), stop: vi.fn() } }));

import { psRunner } from '../platform/ps-runner';
import { WindowsAdapter } from '../platform/windows';
import { flattenAxTree } from '../platform/mac-ax';

const flags = (els: Array<{ name: string; inDocument?: boolean }>) => els.map(e => `${e.name}${e.inDocument ? '*' : ''}`);

describe('inDocument', () => {
  it('Windows: below a UIA Document, through the unnamed containers the bridge flattened out', async () => {
    vi.mocked(psRunner.run).mockImplementation(async (cmd: { cmd?: string }) => cmd.cmd === 'get-screen-context' ? { uiTree: {
      name: 'App', controlType: 'ControlType.Window', bounds: { x: 0, y: 0, width: 9, height: 9 }, children: [
        { name: 'New', controlType: 'ControlType.Button', bounds: { x: 0, y: 0, width: 9, height: 9 } },
        { name: 'Start page', controlType: 'ControlType.Document', bounds: { x: 0, y: 0, width: 9, height: 9 }, children: [
          [{ name: "What's New", controlType: 'ControlType.Hyperlink', bounds: { x: 0, y: 0, width: 9, height: 9 } }]] },
      ] } } : {});
    expect(flags(await new WindowsAdapter().getUiTree(1))).toEqual(['App', 'New', 'Start page', "What's New*"]);
  });

  it('macOS: below an AXWebArea', () => {
    const tree = { name: 'Mail', controlType: 'AXWindow', children: [
      { name: 'Reply', controlType: 'AXButton' },
      { name: 'Message', controlType: 'AXWebArea', children: [{ name: 'Unsubscribe', controlType: 'AXLink' }] }] };
    expect(flags(flattenAxTree(tree))).toEqual(['Mail', 'Reply', 'Message', 'Unsubscribe*']);
  });
});
