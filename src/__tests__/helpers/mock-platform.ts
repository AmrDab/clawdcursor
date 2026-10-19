/**
 * Shared PlatformAdapter mock factory.
 *
 * Extracted from agent-tools-characterization.test.ts so that any test
 * needing a fully-mocked PlatformAdapter can import it from one place.
 *
 * Every method is a vi.fn() with a sensible default resolved value so
 * tools that call ctx.platform.* don't throw in the test environment.
 */

import { vi } from 'vitest';
import type { PlatformAdapter } from '../../platform/types';

/**
 * Build a mock PlatformAdapter where every method is a vi.fn() with
 * a default resolved value matching the real adapter's return shape.
 *
 * The returned object satisfies the PlatformAdapter interface at the
 * TypeScript level so callers can pass it wherever PlatformAdapter is
 * expected without `as any` casts.
 */
export function makeMockPlatform(): PlatformAdapter {
  const clip = { value: 'prior-clipboard' };
  return {
    platform: 'win32',
    getActiveWindow: vi.fn().mockResolvedValue({
      title: 'TestApp',
      processName: 'test.exe',
      processId: 42,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isMinimized: false,
    }),
    listWindows: vi.fn().mockResolvedValue([]),
    focusWindow: vi.fn().mockResolvedValue(true),
    getUiTree: vi.fn().mockResolvedValue([]),
    findElements: vi.fn().mockResolvedValue([]),
    getFocusedElement: vi.fn().mockResolvedValue(null),
    invokeElement: vi.fn().mockResolvedValue({ success: true }),
    waitForElement: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake'),
      width: 1280,
      height: 720,
      scaleFactor: 1,
    }),
    screenshotRegion: vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake-region'),
      width: 100,
      height: 100,
      scaleFactor: 1,
    }),
    mouseClick: vi.fn().mockResolvedValue(undefined),
    mouseDrag: vi.fn().mockResolvedValue(undefined),
    mouseMove: vi.fn().mockResolvedValue(undefined),
    mouseMoveRelative: vi.fn().mockResolvedValue(undefined),
    mouseScroll: vi.fn().mockResolvedValue(undefined),
    mouseDown: vi.fn().mockResolvedValue(undefined),
    mouseUp: vi.fn().mockResolvedValue(undefined),
    keyPress: vi.fn().mockResolvedValue(undefined),
    keyDown: vi.fn().mockResolvedValue(undefined),
    keyUp: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    // A real clipboard: what was written is what is read back (paste paths check that before pasting).
    readClipboard: vi.fn(async () => clip.value),
    writeClipboard: vi.fn(async (t: string) => { clip.value = t; }),
    launchApp: vi.fn().mockResolvedValue({ pid: 99, title: 'App' }),
    openApp: vi.fn().mockResolvedValue({ pid: 99, title: 'App' }),
    setWindowState: vi.fn().mockResolvedValue(true),
    setWindowBounds: vi.fn().mockResolvedValue(true),
    listDisplays: vi.fn().mockResolvedValue([]),
    getScreenSize: vi.fn().mockResolvedValue({
      logicalWidth: 1920,
      logicalHeight: 1080,
      physicalWidth: 1920,
      physicalHeight: 1080,
      dpiRatio: 1,
    }),
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    checkPermissions: vi.fn().mockResolvedValue({
      input: true,
      accessibility: true,
      screenRecording: true,
    }),
    requestPermissions: vi.fn().mockResolvedValue({
      input: true,
      accessibility: true,
      screenRecording: true,
    }),
    maximizeWindow: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformAdapter;
}
