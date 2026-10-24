/** drag_path's path is published as an array (like drag's); live macOS: an array path failed "must be a JSON array". */
import { describe, it, expect, vi } from 'vitest';
import { getExtraTools } from '../tools/extras';

describe('mouse_drag_stepped path', () => {
  function ctx() {
    const platform = { mouseMove: vi.fn(async () => {}), mouseDown: vi.fn(async () => {}), mouseUp: vi.fn(async () => {}) };
    return { platform, ctx: { ensureInitialized: async () => {}, platform, getMouseScaleFactor: () => 1 } as any };
  }
  const tool = () => getExtraTools().find(t => t.name === 'mouse_drag_stepped')!;

  it('an array of points draws', async () => {
    const { platform, ctx: c } = ctx();
    const r = await tool().handler({ path: [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 2 }], space: 'screen' }, c);
    expect(r.isError).toBeFalsy();
    expect(platform.mouseDown).toHaveBeenCalled();
    expect(platform.mouseUp).toHaveBeenCalled();
  });

  it('the old JSON-string form still works', async () => {
    const { ctx: c } = ctx();
    const r = await tool().handler({ path: '[{"x":1,"y":1},{"x":5,"y":5}]', space: 'screen' }, c);
    expect(r.isError).toBeFalsy();
  });

  it('points without numeric x/y are refused before anything moves', async () => {
    const { platform, ctx: c } = ctx();
    const r = await tool().handler({ path: [{ x: 1 }, { x: 'a', y: 2 }], space: 'screen' }, c);
    expect(r.isError).toBe(true);
    expect(platform.mouseDown).not.toHaveBeenCalled();
  });
});
