/**
 * Screenshot-bound pointer actions: image coordinates only mean something on the screenshot they were read off. A click
 * that names an older screenshot, comes with no screenshot at all, or arrives after the window in front changed is
 * refused before anything moves.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recordShot, checkImagePointer, latestShotId, __resetShotsForTests } from '../core/screen-binding';
import { isImagePointerCall, isFullScreenshotCall } from '../tools/screen-guard';
import { classifyResult } from '../core/result-codes';

const notepad = { processId: 10, title: 'Untitled - Notepad', handle: 1 };

beforeEach(() => __resetShotsForTests());

describe('checkImagePointer', () => {
  it('no screenshot yet → refused, and points at space:"screen" for accessibility coordinates', () => {
    expect(checkImagePointer(undefined, notepad)).toMatch(/none has been taken.*space:"screen"/);
  });

  it('the latest screenshot, same window → allowed (with or without its id)', () => {
    const id = recordShot(notepad);
    expect(checkImagePointer(undefined, notepad)).toBeNull();
    expect(checkImagePointer(id, notepad)).toBeNull();
  });

  it('coordinates from an older screenshot → refused', () => {
    const old = recordShot(notepad);
    recordShot(notepad);
    expect(checkImagePointer(old, notepad)).toMatch(/older screenshot; the latest is s2/);
  });

  it('a dialog came to the front (another window) → refused, with no window title in the message', () => {
    recordShot(notepad);
    const why = checkImagePointer(undefined, { processId: 10, title: 'Save As', handle: 2 });
    expect(why).toMatch(/window in front changed since screenshot s1/);
    expect(why).not.toMatch(/Save As|Notepad/);
  });

  it('another app → refused; the page in the same browser window changed (title) → refused', () => {
    recordShot({ processId: 5, title: 'Inbox - Mail', handle: 9 });
    expect(checkImagePointer(undefined, { processId: 6, title: 'Inbox - Mail', handle: 9 })).toBeTruthy();
    expect(checkImagePointer(undefined, { processId: 5, title: 'Checkout - Shop', handle: 9 })).toBeTruthy();
  });

  it('a title\'s own churn is the same screen: unsaved markers and unread counts', () => {
    recordShot(notepad);
    expect(checkImagePointer(undefined, { ...notepad, title: '*Untitled - Notepad' })).toBeNull();
    recordShot({ processId: 3, title: 'Inbox', handle: 4 });
    expect(checkImagePointer(undefined, { processId: 3, title: '(3) Inbox', handle: 4 })).toBeNull();
    recordShot({ processId: 3, title: 'file.ts - Editor', handle: 4 });
    expect(checkImagePointer(undefined, { processId: 3, title: '● file.ts - Editor', handle: 4 })).toBeNull();
  });

  it('the window in front unknown (adapter failed) → only the id is checked', () => {
    recordShot(notepad);
    expect(checkImagePointer(undefined, null)).toBeNull();
    expect(latestShotId()).toBe('s1');
  });
});

describe('which calls are checked', () => {
  it('image-space pointer actions with coordinates, on the compact and granular surfaces', () => {
    expect(isImagePointerCall('computer', 'click', { x: 1, y: 2 })).toBe(true);
    expect(isImagePointerCall('computer', 'drag', { startX: 1, startY: 1, endX: 2, endY: 2 })).toBe(true);
    expect(isImagePointerCall('computer', 'drag_path', { path: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })).toBe(true);
    expect(isImagePointerCall('mouse_click', undefined, { x: 1, y: 2 })).toBe(true);
  });

  it('not: screen-space (accessibility) coordinates, actions at the cursor, keys, typing, reads', () => {
    expect(isImagePointerCall('computer', 'click', { x: 1, y: 2, space: 'screen' })).toBe(false);
    expect(isImagePointerCall('computer', 'scroll', { direction: 'down' })).toBe(false);
    expect(isImagePointerCall('computer', 'key', { combo: 'Return' })).toBe(false);
    expect(isImagePointerCall('computer', 'type', { text: 'x' })).toBe(false);
    expect(isImagePointerCall('accessibility', 'invoke', { name: 'OK' })).toBe(false);
  });

  it('full screenshots are recorded; zoom / region crops keep the frame they came from', () => {
    expect(isFullScreenshotCall('computer', 'screenshot')).toBe(true);
    expect(isFullScreenshotCall('desktop_screenshot', undefined)).toBe(true);
    expect(isFullScreenshotCall('computer', 'zoom')).toBe(false);
    expect(isFullScreenshotCall('computer', 'screenshot_region')).toBe(false);
  });
});

describe('the refusal reads as one', () => {
  it('STALE_SCREENSHOT, refused, with a fresh screenshot as the next call', () => {
    for (const why of ['computer {action:"click"}: these coordinates are from screenshot s1, an older screenshot; the latest is s2.',
      'computer {action:"click"}: the window in front changed since screenshot s3, so its coordinates may point at something else.',
      'computer {action:"click"}: image coordinates refer to a screenshot, and none has been taken.']) {
      expect(classifyResult(why, true, true)).toMatchObject({ outcome: 'refused', code: 'STALE_SCREENSHOT', next: 'computer {"action":"screenshot"}' });
    }
  });
});
