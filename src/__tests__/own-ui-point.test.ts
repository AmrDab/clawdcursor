/**
 * A click, drag or scroll at coordinates lands on the window at that point, whichever window is in front. A host app
 * that draws the pill (docs/pill-host.md) names its own UI processes, and its card has the user's Yes button on it.
 * Contract under test: a pointer action whose point is on an own-UI window is refused and nothing is sent (either end
 * of a drag; the pointer's own position for a bare press); anywhere else it goes through; and with no own UI named,
 * the window at the point is not even read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import '../core/banner';   // registers the own-UI pid list with the platform layer
import { __setControlDirForTests, __setForegroundReaderForTests, isGuardRefusal } from '../core/control';
import { guardInputMethods, unguarded, __setPointPidReaderForTests } from '../platform/pointer-guard';
import { classifyResult } from '../core/result-codes';

const HOST = 4242;
const NOTEPAD = { processId: 300, processName: 'notepad' };
/** The host's card covers x 0..199; Notepad has the rest. */
const pidAt = (x: number) => (x < 200 ? HOST : NOTEPAD.processId);

let dir: string;
let cursor: { x: number; y: number };
let reads: number;

/** A pointer layer that says what reached it: the platform adapter's shapes, and NativeDesktop's composite action. */
function fakePointer() {
  const sent: string[] = [];
  const p = {
    sent,
    async mouseClick(x: number, y: number, _o?: { button?: string; count?: number }) { sent.push(`click ${x},${y}`); },
    async mouseDoubleClick(x: number, y: number) { sent.push(`double ${x},${y}`); },
    async mouseRightClick(x: number, y: number) { sent.push(`right ${x},${y}`); },
    async mouseDrag(x1: number, y1: number, x2: number, y2: number) { sent.push(`drag ${x1},${y1} ${x2},${y2}`); },
    async mouseScroll(x: number, y: number, _direction: string, _amount?: number) { sent.push(`scroll ${x},${y}`); },
    async mouseMove(x: number, y: number) { cursor = { x, y }; sent.push(`move ${x},${y}`); },
    async mouseDown(_button?: string) { sent.push('down'); },
    async mouseUp(_button?: string) { sent.push('up'); },
    async executeMouseAction(a: { kind: string; x: number; y: number; endX?: number; endY?: number }) { sent.push(`${a.kind} ${a.x},${a.y}`); },
  };
  return guardInputMethods(p);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-ownui-point-'));
  __setControlDirForTests(dir);
  process.env.CLAWD_OWN_UI_PIDS = String(HOST);
  __setForegroundReaderForTests(async () => NOTEPAD);   // Notepad is in front all along: the card is not
  cursor = { x: 500, y: 500 };
  reads = 0;
  __setPointPidReaderForTests(async at => { reads++; return pidAt((at ?? cursor).x); });
});
afterEach(() => {
  delete process.env.CLAWD_OWN_UI_PIDS;
  delete process.env.CLAWD_OWN_UI_PIDS_FILE;
  __setPointPidReaderForTests(null);
  __setControlDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const OWN = /is clawdcursor's own on-screen control/;

describe('a pointer action at a point on the own-UI window', () => {
  it('is refused with the own-UI refusal, and nothing is sent', async () => {
    const p = fakePointer();
    const err = await p.mouseClick(100, 50).catch(e => e);
    expect(err.message).toMatch(OWN);
    expect(isGuardRefusal(err)).toBe(true);
    expect(classifyResult(err.message, true, false)?.code).toBe('OWN_UI');
    await expect(p.mouseDoubleClick(100, 50)).rejects.toThrow(OWN);
    await expect(p.mouseRightClick(100, 50)).rejects.toThrow(OWN);
    await expect(p.mouseScroll(100, 50, 'down', 3)).rejects.toThrow(OWN);
    await expect(p.executeMouseAction({ kind: 'click', x: 100, y: 50 })).rejects.toThrow(OWN);
    expect(p.sent).toEqual([]);
  });

  it('a drag is refused when either end is on it', async () => {
    const p = fakePointer();
    await expect(p.mouseDrag(100, 50, 600, 50)).rejects.toThrow(OWN);
    await expect(p.mouseDrag(600, 50, 100, 50)).rejects.toThrow(OWN);
    await expect(p.executeMouseAction({ kind: 'drag', x: 600, y: 50, endX: 100, endY: 50 })).rejects.toThrow(OWN);
    expect(p.sent).toEqual([]);
    await p.mouseDrag(600, 50, 700, 80);
    expect(p.sent).toEqual(['drag 600,50 700,80']);
  });

  it('a move onto it and then a bare press is refused where the pointer is; the release is never refused', async () => {
    const p = fakePointer();
    await p.mouseMove(100, 50);
    await expect(p.mouseDown('left')).rejects.toThrow(OWN);
    await p.mouseUp('left');
    expect(p.sent).toEqual(['move 100,50', 'up']);
  });

  it('anywhere else goes through as before', async () => {
    const p = fakePointer();
    await p.mouseClick(600, 50);
    await p.mouseScroll(600, 50, 'down', 3);
    await p.mouseMove(650, 60);
    await p.mouseDown('left');
    await p.mouseUp('left');
    expect(p.sent).toEqual(['click 600,50', 'scroll 600,50', 'move 650,60', 'down', 'up']);
  });

  it('a point that cannot be read is let through, and clawdcursor\'s own housekeeping is not checked', async () => {
    const p = fakePointer();
    __setPointPidReaderForTests(async () => { throw new Error('bridge down'); });
    await p.mouseClick(100, 50);
    __setPointPidReaderForTests(async () => { reads++; return HOST; });
    await unguarded(() => p.mouseClick(100, 50));
    expect(reads).toBe(0);
    expect(p.sent).toEqual(['click 100,50', 'click 100,50']);
  });
});

describe('with no own UI named', () => {
  it('the window at the point is not read, and every action goes through', async () => {
    delete process.env.CLAWD_OWN_UI_PIDS;
    const p = fakePointer();
    await p.mouseClick(100, 50);
    await p.mouseDrag(100, 50, 600, 50);
    await p.mouseScroll(100, 50, 'down', 3);
    await p.mouseMove(100, 50);
    await p.mouseDown('left');
    expect(reads).toBe(0);
    expect(p.sent).toEqual(['click 100,50', 'drag 100,50 600,50', 'scroll 100,50', 'move 100,50', 'down']);
  });
});
