import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
const psRunMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    start: vi.fn(),
    run: psRunMock,
  },
}));

// The legacy AccessibilityBridge has no AT-SPI code of its own — on Linux it
// routes to the LinuxAdapter (src/platform/linux.ts), which owns the Python
// bridge. Stub the adapter so this file stays process-free.
const adapter = vi.hoisted(() => ({
  platform: 'linux',
  checkPermissions: vi.fn(),
  listWindows: vi.fn(),
  getActiveWindow: vi.fn(),
  findElements: vi.fn(),
  invokeElement: vi.fn(),
  focusWindow: vi.fn(),
  getFocusedElement: vi.fn(),
}));
vi.mock('../platform/index', () => ({ getPlatform: async () => adapter }));

const originalPlatform = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform });
}

const WIN = {
  title: 'Calculator', processName: 'gnome-calculator', processId: 4242,
  bounds: { x: 100, y: 200, width: 800, height: 600 }, isMinimized: false, handle: 62914563,
};

describe('AccessibilityBridge on Linux', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    psRunMock.mockReset();
    for (const fn of Object.values(adapter)) if (typeof fn === 'function') (fn as any).mockReset();
    adapter.checkPermissions.mockResolvedValue({ input: true, accessibility: true, screenRecording: true });
    adapter.listWindows.mockResolvedValue([WIN]);
    adapter.getActiveWindow.mockResolvedValue(WIN);
    adapter.findElements.mockResolvedValue([]);
    adapter.invokeElement.mockResolvedValue({ success: false });
    adapter.focusWindow.mockResolvedValue(true);
    adapter.getFocusedElement.mockResolvedValue(null);
    setPlatform('linux');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('reports shell availability from the adapter instead of attempting macOS osascript', async () => {
    const { AccessibilityBridge } = await import('../platform/accessibility');
    const bridge = new AccessibilityBridge();
    await expect(bridge.isShellAvailable()).resolves.toBe(true);
    adapter.checkPermissions.mockResolvedValue({ input: true, accessibility: false, screenRecording: true });
    await expect(bridge.isShellAvailable()).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('getWindows / getActiveWindow come from the adapter (with a real processName)', async () => {
    const { AccessibilityBridge } = await import('../platform/accessibility');
    const bridge = new AccessibilityBridge();
    const wins = await bridge.getWindows();
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ title: 'Calculator', processName: 'gnome-calculator', processId: 4242, handle: 62914563 });
    await expect(bridge.getActiveWindow()).resolves.toMatchObject({ processId: 4242, processName: 'gnome-calculator' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('findElement delegates to adapter.findElements and maps to the legacy UIElement shape', async () => {
    adapter.findElements.mockResolvedValue([
      { name: 'Save', controlType: 'Button', bounds: { x: 1, y: 2, width: 30, height: 40 }, enabled: true, automationId: 'save-btn' },
    ]);
    const { AccessibilityBridge } = await import('../platform/accessibility');
    const bridge = new AccessibilityBridge();
    const els = await bridge.findElement({ name: 'Save' });
    expect(adapter.findElements).toHaveBeenCalledWith(expect.objectContaining({ name: 'Save', processId: 4242 }));
    expect(els).toEqual([
      { name: 'Save', automationId: 'save-btn', controlType: 'Button', className: '', isEnabled: true, bounds: { x: 1, y: 2, width: 30, height: 40 } },
    ]);
  });

  it('invokeElement delegates and turns a failed invoke with bounds into a clickPoint', async () => {
    adapter.invokeElement.mockResolvedValueOnce({ success: true, data: { value: '42' } });
    const { AccessibilityBridge } = await import('../platform/accessibility');
    const bridge = new AccessibilityBridge();
    const ok = await bridge.invokeElement({ name: 'Display', action: 'get-value' });
    expect(adapter.invokeElement).toHaveBeenCalledWith(expect.objectContaining({ name: 'Display', action: 'get-value', processId: 4242 }));
    expect(ok).toMatchObject({ success: true, value: '42' });

    adapter.invokeElement.mockResolvedValueOnce({ success: false, bounds: { x: 10, y: 20, width: 30, height: 40 } });
    const miss = await bridge.invokeElement({ name: 'canvas', action: 'click' });
    expect(miss.success).toBe(false);
    expect(miss.clickPoint).toEqual({ x: 25, y: 40 });
  });

  it('focusWindow delegates to adapter.focusWindow', async () => {
    const { AccessibilityBridge } = await import('../platform/accessibility');
    const bridge = new AccessibilityBridge();
    const res = await bridge.focusWindow('Calculator');
    expect(adapter.focusWindow).toHaveBeenCalledWith({ title: 'Calculator', processId: undefined });
    expect(res).toMatchObject({ success: true, title: 'Calculator', processId: 4242 });
  });

  it('getFocusedElement delegates to the adapter', async () => {
    adapter.getFocusedElement.mockResolvedValue({
      name: 'Name', controlType: 'Edit', bounds: { x: 1, y: 2, width: 3, height: 4 }, enabled: true, value: 'Ada', processId: 4242,
    });
    const { AccessibilityBridge } = await import('../platform/accessibility');
    const bridge = new AccessibilityBridge();
    await expect(bridge.getFocusedElement()).resolves.toMatchObject({ name: 'Name', controlType: 'Edit', value: 'Ada', processId: 4242, isEnabled: true });
  });

  it('returns an explanatory screen context message', async () => {
    const { AccessibilityBridge } = await import('../platform/accessibility');
    const bridge = new AccessibilityBridge();
    await expect(bridge.getScreenContext()).resolves.toContain('Linux');
  });
});
