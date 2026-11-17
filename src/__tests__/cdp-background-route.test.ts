/**
 * Own-window plan, browser background route: a by-name set_value / click aimed at the browser clawdcursor holds a CDP
 * connection to is a page act (DOM fill / click). It never goes through UIA, which takes the foreground in Chromium.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../tools/projected/tools';

const setField = buildUnifiedTools().find(t => t.name === 'set_field_value')!;
const invoke = buildUnifiedTools().find(t => t.name === 'invoke_element')!;
const NOTE = 'CDP page act, focus not moved';

function ctxWith(opts: { connected?: boolean; pid?: number | null; typeOk?: boolean; clickOk?: boolean } = {}) {
  const { connected = true, pid = 4242, typeOk = true, clickOk = true } = opts;
  const cdp = {
    isConnected: vi.fn(async () => connected),
    getBrowserPid: vi.fn(async () => pid),
    typeByLabel: vi.fn(async () => typeOk
      ? { success: true, method: 'playwright.getByLabel', read: async () => ({ value: 'Ada', readable: true }) }
      : { success: false, error: 'field not found' }),
    clickByText: vi.fn(async () => clickOk ? { success: true, method: 'js.clickByText' } : { success: false, error: 'no element' }),
  };
  const platform = {
    platform: 'win32',
    invokeElement: vi.fn(async () => ({ success: true })),
    findElements: vi.fn(async () => []),
    getFocusedElement: vi.fn(async () => null),
    getActiveWindow: vi.fn(async () => null),
    noteRoute: vi.fn(),
  };
  return { ctx: { platform, cdp, screen: { physicalWidth: 1920, physicalHeight: 1080 } } as any, cdp, platform };
}

describe('browser background route', () => {
  it('set_field_value on the CDP browser fills the field over CDP, with no UIA call and a route note', async () => {
    const { ctx, cdp, platform } = ctxWith();
    const r = await setField.execute({ name: 'Your name', value: 'Ada', processId: 4242 }, ctx);
    expect(r.success).toBe(true);
    expect(cdp.typeByLabel).toHaveBeenCalledWith('Your name', 'Ada');
    expect(platform.invokeElement).not.toHaveBeenCalled();
    expect(platform.noteRoute).toHaveBeenCalledWith(NOTE);
  });

  it('invoke_element on the CDP browser clicks by text over CDP, with no UIA call and a route note', async () => {
    const { ctx, cdp, platform } = ctxWith();
    const r = await invoke.execute({ name: 'Send', processId: 4242 }, ctx);
    expect(r.success).toBe(true);
    expect(cdp.clickByText).toHaveBeenCalledWith('Send');
    expect(platform.invokeElement).not.toHaveBeenCalled();
    expect(platform.noteRoute).toHaveBeenCalledWith(NOTE);
  });

  it('another process, or no CDP connection: the by-name path as before', async () => {
    for (const o of [{ pid: 999 }, { connected: false }]) {
      const { ctx, cdp, platform } = ctxWith(o);
      await setField.execute({ name: 'Your name', value: 'Ada', processId: 4242 }, ctx);
      await invoke.execute({ name: 'Send', processId: 4242 }, ctx);
      expect(cdp.typeByLabel).not.toHaveBeenCalled();
      expect(cdp.clickByText).not.toHaveBeenCalled();
      expect(platform.invokeElement).toHaveBeenCalled();
    }
  });

  it('a page act that finds nothing falls back to the by-name path', async () => {
    const { ctx, platform } = ctxWith({ typeOk: false, clickOk: false });
    await setField.execute({ name: 'Your name', value: 'Ada', processId: 4242 }, ctx);
    await invoke.execute({ name: 'Send', processId: 4242 }, ctx);
    expect(platform.invokeElement).toHaveBeenCalled();
    expect(platform.noteRoute).not.toHaveBeenCalledWith(NOTE);
  });
});
