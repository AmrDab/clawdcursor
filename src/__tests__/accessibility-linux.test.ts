import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();
const psRunMock = vi.fn();

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('../ps-runner', () => ({
  psRunner: {
    start: vi.fn(),
    run: psRunMock,
  },
}));

const originalPlatform = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('AccessibilityBridge on Linux', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    psRunMock.mockReset();
    setPlatform('linux');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('reports shell unavailable instead of attempting macOS osascript', async () => {
    const { AccessibilityBridge } = await import('../accessibility');
    const bridge = new AccessibilityBridge();
    await expect(bridge.isShellAvailable()).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns empty windows/elements and non-throwing unsupported results', async () => {
    const { AccessibilityBridge } = await import('../accessibility');
    const bridge = new AccessibilityBridge();
    await expect(bridge.getWindows()).resolves.toEqual([]);
    await expect(bridge.findElement({ name: 'Save' })).resolves.toEqual([]);
    await expect(bridge.invokeElement({ name: 'Save', action: 'click' })).resolves.toMatchObject({ success: false });
  });

  it('returns an explanatory screen context message', async () => {
    const { AccessibilityBridge } = await import('../accessibility');
    const bridge = new AccessibilityBridge();
    await expect(bridge.getScreenContext()).resolves.toContain('Accessibility unavailable on Linux');
  });
});
