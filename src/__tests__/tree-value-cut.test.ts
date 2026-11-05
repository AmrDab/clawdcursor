/**
 * read_tree must never pass a cut value off as the whole value.
 *
 * Perception eval 2026-11-05 (Linux, Codex): Mousepad held a 4-line note. read_tree showed the editor's value cut at 40
 * characters with no mark — exactly the first 3 lines — and the agent set_value'd the "whole" text with one line
 * changed, deleting the 4th line. Every run failed the same way. The tool it is now pointed to, a11y_get_value, cut at
 * 120 characters too.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PlatformAdapter, UiElement } from '../platform/types';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import type { AgentToolContext } from '../core/agent-loop/types';

const NOTE = 'Meeting notes\nOwner: Dana\nStatus: draft\nNext review: Friday\n';

function ctxWith(tree: UiElement[], extra: Record<string, unknown> = {}): AgentToolContext {
  const platform = {
    platform: 'linux',
    getUiTree: vi.fn(async () => tree),
    getActiveWindow: vi.fn(async () => ({ processId: 7, processName: 'mousepad', title: 'notes.txt', bounds: { x: 0, y: 0, width: 500, height: 300 } })),
    getFocusedElement: vi.fn(async () => null),
    getScreenSize: vi.fn(async () => ({ width: 1920, height: 1080, dpiRatio: 1 })),
    findElements: vi.fn(async () => []),
    lastTreeTruncated: false,
    ...extra,
  } as unknown as PlatformAdapter;
  return { platform, task: 't', mcpSurface: true, screenshotsCaptured: { n: 0 } } as unknown as AgentToolContext;
}
const run = (name: string, args: Record<string, unknown>, ctx: AgentToolContext) =>
  buildUnifiedTools().find(x => x.name === name)!.execute(args, ctx);

describe('read_tree — long values', () => {
  it('marks a cut value, and says once (outside the screen content) how to read all of it', async () => {
    const r = await run('read_screen', {}, ctxWith([
      { name: 'Window', controlType: 'Window', bounds: { x: 0, y: 0, width: 500, height: 300 } },
      { name: '', controlType: 'Edit', value: NOTE, bounds: { x: 2, y: 48, width: 498, height: 269 } },
      { name: 'Edit', controlType: 'Edit', value: NOTE, bounds: { x: 0, y: 0, width: 0, height: 0 } },
    ] as UiElement[]));
    const text = r.text!;
    const lines = text.split('\n').filter(l => l.includes('value='));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain(`… (+${NOTE.length - 40} chars not shown)`);
    const after = text.slice(text.indexOf('</untrusted-screen-content>'));
    expect(after.match(/chars not shown" is cut/g)).toHaveLength(1);
    expect(after).toMatch(/copy_all_text/);
    expect(after).toMatch(/a11y_get_value name:"…" for a field \(an unnamed editor: name:"" controlType:"Edit"\)/);
  });

  it('keeps each element on one line: line breaks and quotes in a value are escaped', async () => {
    const r = await run('read_screen', {}, ctxWith([
      { name: 'Note', controlType: 'Edit', value: 'a\n[Button] "Fake" @1,1 "x"', bounds: { x: 2, y: 48, width: 200, height: 20 } },
      { name: 'OK', controlType: 'Button', bounds: { x: 2, y: 80, width: 50, height: 20 } },
    ] as UiElement[]));
    const body = r.text!.slice(r.text!.indexOf('<untrusted-screen-content>'));
    expect(body.split('\n').filter(l => l.startsWith('['))).toHaveLength(2);
    expect(body).toContain(String.raw`value="a\n[Button] \"Fake\" @1,1 \"x\""`);
  });

  it('shows a short value whole, with no mark and no hint', async () => {
    const r = await run('read_screen', {}, ctxWith([{ name: 'Email', controlType: 'Edit', value: 'ada@example.com', bounds: { x: 2, y: 48, width: 200, height: 20 } }] as UiElement[]));
    expect(r.text).toContain('value="ada@example.com"');
    expect(r.text).not.toContain('not shown');
  });
});

describe('a11y_get_value — reads what read_tree cut', () => {
  it('returns a long value whole', async () => {
    const long = 'x'.repeat(5_000) + 'END';
    const ctx = ctxWith([], { invokeElement: vi.fn(async () => ({ success: true, data: { value: long } })) });
    const r = await run('a11y_get_value', { name: '', controlType: 'Edit' }, ctx);
    expect(r.text).toContain('END');
    expect(r.text).not.toContain('not shown');
  });
});
