/**
 * Windows adapter: checkbox state and tree depth from the UIA bridge.
 *
 * Live Win11 re-test 2026-10-15: `accessibility state "Subscribe"` on a ticked
 * WinForms checkbox answered {selected:false, …} with no checked/unchecked at
 * all — find-element never read TogglePattern. And the flat tree had no
 * structure, so list_children could not work on scrolled-out (0×0) parents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

let reply: unknown = null;
vi.mock('../platform/ps-runner', () => ({
  psRunner: { run: () => Promise.resolve(reply), start: vi.fn(), stop: vi.fn() },
}));

import { WindowsAdapter } from '../platform/windows';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const box = { x: 1, y: 1, width: 10, height: 10 };

describe('WindowsAdapter — checked state', () => {
  let adapter: WindowsAdapter;
  beforeEach(() => {
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 42 } as never);
  });

  it('maps the bridge toggleState to checked', async () => {
    reply = [
      { name: 'Subscribe', controlType: 'ControlType.CheckBox', bounds: box, toggleState: 'On' },
      { name: 'Newsletter', controlType: 'ControlType.CheckBox', bounds: box, toggleState: 'Off' },
      { name: 'Some', controlType: 'ControlType.CheckBox', bounds: box, toggleState: 'Indeterminate' },
      { name: 'Submit', controlType: 'ControlType.Button', bounds: box },
    ];
    const els = await adapter.findElements({ name: 'x' });
    expect(els.map(e => e.checked)).toEqual([true, false, 'mixed', undefined]);
  });

  it('state reports checked for a checkbox', async () => {
    reply = [{ name: 'Subscribe', controlType: 'ControlType.CheckBox', bounds: box, toggleState: 'On' }];
    const t = buildUnifiedTools().find(x => x.name === 'get_element_state')!;
    const res = await t.execute({ name: 'Subscribe' }, { platform: adapter, task: 't' } as unknown as AgentToolContext);
    expect(JSON.parse(res.text)).toMatchObject({ name: 'Subscribe', checked: true });
  });

  it('the bridge reads TogglePattern state for find-element results', () => {
    const bridge = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'ps-bridge.ps1'), 'utf8');
    const start = bridge.indexOf('function Cmd-FindElement {');
    const body = bridge.slice(start, bridge.indexOf('\nfunction ', start + 1));
    expect(body).toContain('IsTogglePatternAvailableProperty');
    expect(body).toContain('toggleState');
  });
});

describe('WindowsAdapter — tree depth', () => {
  it('records each element\'s depth; flattened pass-through containers do not add a level', async () => {
    const adapter = new WindowsAdapter();
    reply = {
      uiTree: {
        name: 'Settings', controlType: 'ControlType.Window', bounds: box, children: [
          [ // an unnamed pass-through the bridge flattened into an array
            { name: 'Windows specifications', controlType: 'ControlType.Group', bounds: box, children: [
              { name: 'Windows 11 Pro', controlType: 'ControlType.Text', bounds: box, children: [] },
            ] },
          ],
          { name: 'Rename this PC', controlType: 'ControlType.Button', bounds: box, children: [] },
        ],
      },
    };
    const tree = await adapter.getUiTree(42);
    expect(tree.map(e => [e.name, e.depth])).toEqual([
      ['Settings', 0], ['Windows specifications', 1], ['Windows 11 Pro', 2], ['Rename this PC', 1],
    ]);
  });
});
