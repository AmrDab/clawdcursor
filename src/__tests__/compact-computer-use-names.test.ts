/**
 * #381: an agent host that defers MCP schemas makes its first calls with the argument names of Anthropic's built-in
 * computer-use tool. `computer {action:"key", text:"ctrl+l"}` and `computer {action:"mouse_move", …}` were rejected,
 * costing a retry each. They are aliases now; the real name still wins when both are given.
 */
import { describe, it, expect, vi } from 'vitest';

const seen: Array<{ tool: string; params: Record<string, unknown> }> = [];
vi.mock('../tools/registry', () => ({
  getTool: (name: string) => ({
    name, description: '', category: 'mouse', safetyTier: 0,
    parameters: name === 'key_press' ? { key: { type: 'string', required: true } } : { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
    handler: async (params: Record<string, unknown>) => { seen.push({ tool: name, params }); return { text: 'ok' }; },
  }),
}));

import { getCompactTools } from '../tools/compact';

const computer = () => getCompactTools().find(t => t.name === 'computer')!;
const ctx = {} as never;

describe('computer: computer-use argument names', () => {
  it('key {text} is key {combo}; an explicit key wins over text', async () => {
    seen.length = 0;
    await computer().handler({ action: 'key', text: 'ctrl+l' }, ctx);
    await computer().handler({ action: 'key', key: 'Return', text: 'ignored' }, ctx);
    expect(seen).toEqual([{ tool: 'key_press', params: { key: 'ctrl+l' } }, { tool: 'key_press', params: { key: 'Return' } }]);
  });

  it('mouse_move is move (the pointer goes there, nothing is pressed)', async () => {
    seen.length = 0;
    await computer().handler({ action: 'mouse_move', x: 5, y: 6 }, ctx);
    expect(seen).toEqual([{ tool: 'mouse_hover', params: { x: 5, y: 6 } }]);
  });
});
