/**
 * find_element {automationId} used to ask the adapter for EVERYTHING in the window and filter the
 * result afterwards. On macOS the adapter caps a search, so in a big window the one element with
 * that AXIdentifier could be past the cap and the answer was "(no elements found)". The identifier
 * is now passed down so the adapter can look for exactly it (the post-filter stays, for adapters
 * that ignore it — Windows).
 */
import { describe, it, expect, vi } from 'vitest';
import { getA11yTools } from '../tools/a11y';
import type { ToolContext } from '../tools/types';

const tool = getA11yTools().find(t => t.name === 'find_element')!;
const el = (name: string, automationId: string) => ({ name, automationId, controlType: 'Button', bounds: { x: 1, y: 2, width: 3, height: 4 } });

function ctxWith(hits: ReturnType<typeof el>[]) {
  const findElements = vi.fn().mockResolvedValue(hits);
  const ctx = {
    ensureInitialized: vi.fn(),
    cdp: { isConnected: vi.fn().mockResolvedValue(false) },
    platform: { findElements },
  } as unknown as ToolContext;
  return { ctx, findElements };
}

describe('find_element — automationId', () => {
  it('is handed to the adapter, not only applied afterwards', async () => {
    const { ctx, findElements } = ctxWith([el('One', 'One')]);
    await tool.handler({ automationId: 'One', processId: 5 }, ctx);
    expect(findElements).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'One', processId: 5 }));
  });

  it('still filters an adapter that returned more than that identifier', async () => {
    const { ctx } = ctxWith([el('One', 'One'), el('Two', 'Two')]);
    const r = await tool.handler({ automationId: 'One' }, ctx);
    expect(r.text).toContain('One');
    expect(r.text).not.toContain('Two');
  });
});
