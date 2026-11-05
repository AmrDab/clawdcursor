/**
 * read_tree must never pass a cut value off as the whole value.
 *
 * Perception eval 2026-11-05 (Linux, Codex): Mousepad held a 4-line note. read_tree showed the editor's value cut at 40
 * characters with no mark — exactly the first 3 lines — and the agent set_value'd the "whole" text with one line
 * changed, deleting the 4th line. Every run failed the same way.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PlatformAdapter, UiElement } from '../platform/types';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

const NOTE = 'Meeting notes\nOwner: Dana\nStatus: draft\nNext review: Friday\n';

function readTree(tree: UiElement[]) {
  const t = buildUnifiedTools().find(x => x.name === 'read_screen')!;
  const platform = {
    platform: 'linux',
    getUiTree: vi.fn(async () => tree),
    getActiveWindow: vi.fn(async () => ({ processId: 7, processName: 'mousepad', title: 'notes.txt', bounds: { x: 0, y: 0, width: 500, height: 300 } })),
    getFocusedElement: vi.fn(async () => null),
    getScreenSize: vi.fn(async () => ({ width: 1920, height: 1080, dpiRatio: 1 })),
    lastTreeTruncated: false,
  } as unknown as PlatformAdapter;
  const ctx = { platform, task: 't', mcpSurface: true, screenshotsCaptured: { n: 0 } } as unknown as AgentToolContext;
  return t.execute({}, ctx);
}

describe('read_tree — long values', () => {
  it('marks a cut value and says how to read all of it', async () => {
    const r = await readTree([
      { name: 'Window', controlType: 'Window', bounds: { x: 0, y: 0, width: 500, height: 300 } },
      { name: '', controlType: 'Edit', value: NOTE, bounds: { x: 2, y: 48, width: 498, height: 269 } },
      { name: 'Edit', controlType: 'Edit', value: NOTE, bounds: { x: 0, y: 0, width: 0, height: 0 } },
    ] as UiElement[]);
    const lines = r.text!.split('\n').filter(l => l.includes('value="'));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain(`+${NOTE.length - 40} chars not shown`);
      expect(l).toMatch(/get_value/);
    }
  });

  it('shows a short value whole, with no mark', async () => {
    const r = await readTree([{ name: 'Email', controlType: 'Edit', value: 'ada@example.com', bounds: { x: 2, y: 48, width: 200, height: 20 } }] as UiElement[]);
    expect(r.text).toContain('value="ada@example.com"');
    expect(r.text).not.toContain('not shown');
  });
});
