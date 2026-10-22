/**
 * Screenshot-bound pointer actions: image coordinates only mean something on the screenshot they were read off. A click
 * that names an older screenshot, comes with no screenshot at all, or arrives while a window the screenshot did not have
 * is in front (a dialog opened) is refused before anything moves. Bringing a window that WAS on it to the front is fine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recordShot, checkImagePointer, latestShotId, __resetShotsForTests } from '../core/screen-binding';
import { isImagePointerCall, isFullScreenshotCall } from '../tools/screen-guard';
import { classifyResult } from '../core/result-codes';

const host = { processId: 1, title: 'Claude', handle: 100 };
const notepad = { processId: 10, title: 'Untitled - Notepad', handle: 1 };

beforeEach(() => __resetShotsForTests());

describe('checkImagePointer', () => {
  it('no screenshot yet → refused, and points at space:"screen" for accessibility coordinates', () => {
    expect(checkImagePointer(undefined, notepad)).toMatch(/none has been taken.*space:"screen"/);
  });

  it('the latest screenshot → allowed (with or without its id)', () => {
    const id = recordShot([host, notepad]);
    expect(checkImagePointer(undefined, host)).toBeNull();
    expect(checkImagePointer(id, host)).toBeNull();
  });

  it('a window that WAS on the screenshot coming to the front (clicked into) is fine — the normal multi-click flow', () => {
    recordShot([host, notepad]);                                  // the agent's host was in front at capture
    expect(checkImagePointer(undefined, notepad)).toBeNull();     // click a field in Notepad: it comes to the front
    expect(checkImagePointer(undefined, { ...notepad, title: '*Untitled - Notepad' })).toBeNull();   // typed: title churn
  });

  it('coordinates from an older screenshot → refused', () => {
    const old = recordShot([notepad]);
    recordShot([notepad]);
    expect(checkImagePointer(old, notepad)).toMatch(/older screenshot; the latest is s2/);
  });

  it('a window the screenshot did not have is in front (a dialog opened) → refused, no titles in the message', () => {
    recordShot([host, notepad]);
    const why = checkImagePointer(undefined, { processId: 10, title: 'Save As', handle: 2 });
    expect(why).toMatch(/a window that was not on screenshot s1 is in front/);
    expect(why).not.toMatch(/Save As|Notepad/);
  });

  it('an app that opened since → refused', () => {
    recordShot([host, notepad]);
    expect(checkImagePointer(undefined, { processId: 77, title: 'Calculator', handle: 9 })).toBeTruthy();
  });

  it('no handle on the active window (some adapters) → matched by process instead', () => {
    recordShot([host, notepad]);
    expect(checkImagePointer(undefined, { processId: 10, title: 'whatever' })).toBeNull();
    expect(checkImagePointer(undefined, { processId: 11, title: 'whatever' })).toBeTruthy();
  });

  it('a window not on the screenshot is refused even untitled and of a known app (no title-based exemption)', () => {
    recordShot([host, notepad]);
    expect(checkImagePointer(undefined, { processId: 10, title: '', handle: 555 })).toBeTruthy();
    expect(checkImagePointer(undefined, { processId: 10, title: 'Save As', handle: 556 })).toBeTruthy();
  });

  it('an untitled window that was in front at capture (frameless app: never in a window list) is on the screenshot', async () => {
    const { noteScreenshot } = await import('../tools/screen-guard');
    const frameless = { processId: 10, title: '', handle: 555 };
    const ctx = { platform: { listWindows: async () => [host, notepad], getActiveWindow: async () => frameless } } as any;
    await noteScreenshot(ctx);
    expect(checkImagePointer(undefined, frameless)).toBeNull();
    expect(checkImagePointer(undefined, { processId: 10, title: '', handle: 556 })).toBeTruthy();   // a popup after capture
  });

  it('window list unknown at capture, or the window in front unknown now → only the id is checked', () => {
    recordShot([]);
    expect(checkImagePointer(undefined, { processId: 99, handle: 9 })).toBeNull();
    recordShot([notepad]);
    expect(checkImagePointer(undefined, null)).toBeNull();
    expect(latestShotId()).toBe('s2');
  });
});

describe('which calls are checked', () => {
  it('image-space pointer actions with coordinates, on the compact and granular surfaces', () => {
    expect(isImagePointerCall('computer', 'click', { x: 1, y: 2 })).toBe(true);
    expect(isImagePointerCall('computer', 'drag', { startX: 1, startY: 1, endX: 2, endY: 2 })).toBe(true);
    expect(isImagePointerCall('computer', 'drag_path', { path: '[{"x":1,"y":1},{"x":2,"y":2}]' })).toBe(true);   // a JSON string on the wire
    expect(isImagePointerCall('mouse_drag', undefined, { x1: 1, y1: 1, x2: 2, y2: 2 })).toBe(true);
    expect(isImagePointerCall('mouse_click', undefined, { x: 1, y: 2 })).toBe(true);
  });

  it('not: screen-space (accessibility) coordinates, actions at the cursor, keys, typing, reads', () => {
    expect(isImagePointerCall('computer', 'click', { x: 1, y: 2, space: 'screen' })).toBe(false);
    expect(isImagePointerCall('computer', 'scroll', { direction: 'down' })).toBe(false);
    expect(isImagePointerCall('computer', 'key', { combo: 'Return' })).toBe(false);
    expect(isImagePointerCall('computer', 'type', { text: 'x' })).toBe(false);
    expect(isImagePointerCall('accessibility', 'invoke', { name: 'OK' })).toBe(false);
  });

  it('full screenshots are recorded (any path); zoom / region crops keep the frame they came from', () => {
    expect(isFullScreenshotCall('computer', 'screenshot')).toBe(true);
    expect(isFullScreenshotCall('desktop_screenshot', undefined)).toBe(true);
    expect(isFullScreenshotCall('screenshot_full', undefined)).toBe(true);
    expect(isFullScreenshotCall('computer', 'zoom')).toBe(false);
    expect(isFullScreenshotCall('computer', 'screenshot_region')).toBe(false);
  });
});

describe('the refusal reads as one', () => {
  it('STALE_SCREENSHOT, refused, with a fresh screenshot as the next call', () => {
    for (const why of ['computer {action:"click"}: these coordinates are from screenshot s1, an older screenshot; the latest is s2.',
      'computer {action:"click"}: a window that was not on screenshot s3 is in front now (a dialog or another app opened)',
      'computer {action:"click"}: image coordinates refer to a screenshot, and none has been taken.']) {
      expect(classifyResult(why, true, true)).toMatchObject({ outcome: 'refused', code: 'STALE_SCREENSHOT', next: 'computer {"action":"screenshot"}' });
    }
  });
});
