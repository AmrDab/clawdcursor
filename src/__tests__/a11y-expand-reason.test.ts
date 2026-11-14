/**
 * A failed expand / collapse used to say only `Could not expand "More options".` The macOS helper knows why (nothing it can press
 * or set opens a web <summary>; the window must be in front for the keyboard route) and the adapter hands the reason back in
 * data.error — the tool text has to carry it (through failReason, the shared helper), or a caller has nothing to act on
 * (1.5.27 live test on a Mac).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { untrusted } from '../core/miss-text';

const platform = (res: { success: boolean; data?: Record<string, unknown> }) => ({
  invokeElement: vi.fn(async () => res),
  getActiveWindow: vi.fn(async () => null),
});

const WHY = 'it did not expand by its attribute, its press or the Return key — if its window is not in front, bring it forward and try again';

describe.each([
  { tool: 'a11y_expand', verb: 'expand', done: 'Expanded' },
  { tool: 'a11y_collapse', verb: 'collapse', done: 'Collapsed' },
])('$tool says why it failed', ({ tool, verb, done }) => {
  it('agent loop / compact route: the platform\'s reason is in the text', async () => {
    const t = buildUnifiedTools().find(x => x.name === tool)!;
    const r = await t.execute({ name: 'More options' }, { platform: platform({ success: false, data: { error: `${WHY}.` } }) } as any);
    expect(r.success).toBe(false);
    // The bridge's own sentence (no structured reason) is shown inside an untrusted block (#336), without its full stop.
    expect(r.text).toBe(`Could not ${verb} "More options": ${untrusted(WHY)}.`);
  });

  it('agent loop / compact route: no reason given, the text is what it always was', async () => {
    const t = buildUnifiedTools().find(x => x.name === tool)!;
    for (const data of [undefined, {}, { error: '' }, { error: '   ' }, { error: 42 }]) {
      const r = await t.execute({ name: 'More options' }, { platform: platform({ success: false, data: data as any }) } as any);
      expect(r.text).toBe(`Could not ${verb} "More options".`);
    }
  });

  it('agent loop / compact route: success has no reason in it', async () => {
    const t = buildUnifiedTools().find(x => x.name === tool)!;
    const r = await t.execute({ name: 'More options' }, { platform: platform({ success: true, data: { error: 'stale' } }) } as any);
    expect(r).toMatchObject({ success: true, text: `${done} "More options".` });
  });

});
