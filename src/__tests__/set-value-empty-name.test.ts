/**
 * set_value with no field name used to fall through to the keyboard fallback, which picks the window's LARGEST editable
 * and types into it — live 2026-10-20 that was the browser's address bar, reported as `Set "" = 31 chars`.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';

function platform() {
  return {
    invokeElement: vi.fn(async () => ({ success: false, data: { error: 'no settable value' } })),
    findElements: vi.fn(async () => [{ name: 'Address and search bar', controlType: 'Edit', bounds: { x: 0, y: 0, width: 3000, height: 50 } }]),
    getFocusedElement: vi.fn(async () => ({ name: 'Address and search bar', controlType: 'Edit', bounds: { x: 0, y: 0, width: 3000, height: 50 } })),
    mouseClick: vi.fn(async () => {}),
    keyPress: vi.fn(async () => {}),
    typeText: vi.fn(async () => {}),
    getActiveWindow: vi.fn(async () => null),
    listDisplays: vi.fn(async () => [{ bounds: { x: 0, y: 0, width: 3840, height: 2160 }, dpiRatio: 1 }]),
  };
}

describe('set_value with no field name types nothing', () => {
  for (const name of [undefined, '', '   ']) {
    it(`agent loop / compact route (name ${JSON.stringify(name)})`, async () => {
      const p = platform();
      const tool = buildUnifiedTools().find(t => t.name === 'set_field_value')!;
      const r = await tool.execute({ name, value: 'https://example.com' }, { platform: p } as any);
      expect(r.success).toBe(false);
      expect(p.typeText).not.toHaveBeenCalled();
      expect(p.mouseClick).not.toHaveBeenCalled();
    });
  }

  it('a named field still falls back to the keyboard when it has no settable value', async () => {
    const p = platform();
    const tool = buildUnifiedTools().find(t => t.name === 'set_field_value')!;
    const r = await tool.execute({ name: 'Address and search bar', value: 'abc' }, { platform: p } as any);
    expect(r.success).toBe(true);
    expect(p.typeText).toHaveBeenCalledWith('abc');
  });
});
