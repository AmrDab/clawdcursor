/**
 * Live 2026-11 (Edge, 1.5.27 candidate): toggling a checked "Accept terms" returned `Toggled "Accept terms" → On.` while the
 * box was now unchecked: the bridge read the state right after Toggle(), before Chromium updated UIA. The bridges now read it
 * back until it changes (or ~0.5 s) and report `toggleChanged`; the tool must never present an unchanged read as the result.
 */
import { describe, it, expect, vi } from 'vitest';
import { getA11yDepthTools } from '../tools/a11y_depth';
import type { ToolContext } from '../tools/types';

async function toggle(data: Record<string, unknown>) {
  const platform = { invokeElement: vi.fn(async () => ({ success: true, data })), getActiveWindow: vi.fn(async () => null) };
  const tool = getA11yDepthTools().find(t => t.name === 'a11y_toggle')!;
  return tool.handler({ name: 'Accept terms', processId: 1 }, { ensureInitialized: async () => {}, platform } as unknown as ToolContext);
}

describe('a11y_toggle reports the state it observed', () => {
  it('a changed state is reported as the result', async () => {
    expect(await toggle({ toggleState: 'Off', toggleChanged: true })).toEqual({ text: 'Toggled (read back ✓) "Accept terms" → Off.' });
  });

  it('a state that never changed is "not confirmed", never "→ On"', async () => {
    const r = await toggle({ toggleState: 'On', toggleChanged: false });
    expect(r.text).toMatch(/not confirmed/);
    expect(r.text).not.toMatch(/→/);
  });
});
