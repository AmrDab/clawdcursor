/**
 * Plan (h) ghost cursor: every act on an agent window that has a point tells the outline process to draw a pointer there
 * (`GHOST <x> <y>`). It is only drawn: nothing here ever moves the real cursor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import { controlBanner } from '../core/banner';
import { stopControl, resumeControl, __setControlDirForTests, __setForegroundReaderForTests } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  written: string[] = [];
  constructor() { super(); this.stdin.on('data', d => this.written.push(...String(d).split('\n').filter(Boolean))); }
  kill(): boolean { this.emit('exit', 0); return true; }
}

let outlines: FakeChild[];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const ghosts = () => outlines[0].written.filter(l => l.startsWith('GHOST'));

beforeEach(() => {
  outlines = [];
  Object.defineProperty(process, 'platform', { value: 'win32' });
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
  controlBanner.__setOutlineSpawnerForTests(() => { const c = new FakeChild(); outlines.push(c); return c as unknown as ChildProcess; });
  __setForegroundReaderForTests(async () => ({ processId: 100, processName: 'msedge', handle: 0x5a0 }));
  controlBanner.pin();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  controlBanner.__resetForTests();
  __setForegroundReaderForTests(null);
  __setControlDirForTests(null);
});

function desktop() {
  const moved: string[] = [];
  const d = guardInputMethods({
    moved,
    async mouseClick(x: number, y: number) { moved.push(`click ${x},${y}`); },
    async mouseScroll(x: number, y: number) { moved.push(`scroll ${x},${y}`); },
    async keyPress(_k: string) {},
    async invokeElement(q: { name: string; action?: string }) {
      return q.action === 'get-value' ? { success: true } : { success: true, bounds: { x: 100, y: 200, width: 40, height: 20 } };
    },
  });
  return d;
}

describe('the ghost cursor', () => {
  it('a click on the agent window tells the outline where: GHOST x y', async () => {
    await desktop().mouseClick(640, 360);
    expect(ghosts()).toEqual(['GHOST 640 360']);
  });

  it('a scroll has a point too; a key press has none', async () => {
    const d = desktop();
    await d.keyPress('a');
    await d.mouseScroll(10, 20);
    expect(ghosts()).toEqual(['GHOST 10 20']);
  });

  it('an act by name with element bounds goes to the centre of the element; reading a value has no point', async () => {
    const d = desktop();
    await d.invokeElement({ name: 'Save', action: 'get-value' });
    expect(ghosts()).toEqual([]);
    await d.invokeElement({ name: 'Save' });
    expect(ghosts()).toEqual(['GHOST 120 210']);
  });

  it('a refused click draws nothing', async () => {
    const dir = (await import('os')).tmpdir();
    __setControlDirForTests(dir);
    stopControl('test');
    try { await expect(desktop().mouseClick(1, 2)).rejects.toThrow(/stopped/); } finally { resumeControl('test'); }
    expect(ghosts()).toEqual([]);
  });

  it('is only sent where the outline is drawn by this protocol (Windows)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await desktop().mouseClick(5, 6);
    expect(ghosts()).toEqual([]);
  });

  it('the Windows drawer: a small pointer, click-through, no-activate, kept out of captures, just above the agent window', () => {
    const ps = readFileSync(join(__dirname, '..', '..', 'scripts', 'window-outline.ps1'), 'utf8');
    expect(ps).toContain('public class GhostCursor : OverlayForm');
    expect(ps).toContain('p[0].EndsWith("GHOST")');
    expect(ps).toContain('SetWindowPos(Handle, above, ');
    expect(ps).not.toContain('new IntPtr(-1)');   // never topmost
    // Never the real cursor.
    expect(ps).not.toMatch(/SetCursorPos|mouse_event|SendInput|SetCursor\b/);
  });
});
