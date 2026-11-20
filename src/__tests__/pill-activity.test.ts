/**
 * The running pill says what the agent is doing ("Typing in Edge").
 * Contract under test:
 *   - every guarded input announces its method once it passed the guard; a refused one announces nothing
 *   - the label names the app only for inputs that read the window in front (keys, typing, the pointer)
 *   - the label crosses to the pill as one `ACTIVITY <text>` stdin line, only when it changes, never while paused
 *   - a new pill starts with the current label (CLAWD_BANNER_ACTIVITY); the next session's pill does not inherit it
 *   - the paused card names the app the agent was working in (CLAWD_BANNER_APP)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { controlBanner, overlayEnv, activityLabel, type OverlayMode } from '../core/banner';
import { appLabel } from '../core/app-label';
import { guardInputMethods, setInputGuard, setOnAgentInput } from '../platform/pointer-guard';
import { withForegroundBurst, burstCount, resetBurstCount } from '../platform/foreground-burst';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  written: string[] = [];
  killed = false;
  constructor() { super(); this.stdin.on('data', d => this.written.push(...String(d).split('\n').filter(Boolean))); }
  kill(): boolean { this.killed = true; this.emit('exit', 0); return true; }
}

let pills: Array<{ child: FakeChild; mode: OverlayMode }>;
const last = () => pills[pills.length - 1];
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  pills = [];
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(mode => { const c = new FakeChild(); pills.push({ child: c, mode }); return c as unknown as ChildProcess; });
  controlBanner.__setOutlineSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
});
afterEach(() => controlBanner.__resetForTests());

describe('activityLabel / appLabel', () => {
  it('names the app for inputs that read the window in front', () => {
    expect(activityLabel('typeText', 'msedge.exe')).toBe('Typing in Edge');
    expect(activityLabel('mouseClick', 'notepad')).toBe('Clicking in Notepad');
    expect(activityLabel('keyPress', 'Google Chrome')).toBe('Pressing keys in Google Chrome');
  });
  // Live 2026-11-10: Siemens Designcenter (ugraf.exe) showed as "Clicking in Ugraf".
  it("uses the app's own display name when the OS gave one, as it is", () => {
    expect(activityLabel('mouseClick', 'ugraf', 'Designcenter NX')).toBe('Clicking in Designcenter NX');
    expect(appLabel('msedge', 'Microsoft Edge')).toBe('Microsoft Edge');
    expect(appLabel('paintdotnet', 'paint.net')).toBe('paint.net');
    expect(appLabel('ugraf', ' \n ')).toBe('Ugraf');
    expect(appLabel('x', 'evil\nACTIVITY x')).toBe('evil ACTIVITY x');
  });
  it('falls back to the known names when the OS gave none (an elevated app), and Explorer is "File Explorer" either way', () => {
    expect(appLabel('WINWORD.EXE')).toBe('Word');
    expect(appLabel('powerpnt')).toBe('PowerPoint');
    expect(appLabel('explorer')).toBe('File Explorer');
    expect(appLabel('explorer.exe', 'Windows Explorer')).toBe('File Explorer');
  });
  it('says only what it does for the others, and nothing for unknown methods', () => {
    expect(activityLabel('navigate', 'msedge')).toBe('Opening a page');
    expect(activityLabel('invokeElement', 'msedge')).toBe('Clicking');
    expect(activityLabel('getActiveWindow', 'msedge')).toBeUndefined();
  });
  it('drops an unknown app rather than inventing one', () => {
    expect(activityLabel('typeText', undefined)).toBe('Typing');
    expect(appLabel('pid 1234')).toBeUndefined();
    expect(appLabel('evil\nACTIVITY x')).toBe('Evil ACTIVITY x');
  });
});

describe('the pill line', () => {
  it('sends ACTIVITY only when the label changes', async () => {
    controlBanner.touch();
    controlBanner.setActivity('Typing in Edge');
    controlBanner.setActivity('Typing in Edge');
    controlBanner.setActivity('Clicking in Edge');
    await flush();
    expect(last().child.written).toEqual(['ACTIVITY running in background · Typing in Edge', 'ACTIVITY running in background · Clicking in Edge']);
  });

  it('keeps a label on one line', async () => {
    controlBanner.touch();
    controlBanner.setActivity('a\r\nHIDE 9999');
    await flush();
    expect(last().child.written).toEqual(['ACTIVITY running in background · a HIDE 9999']);
  });

  it('a new pill starts with the current label; the next session starts blank', () => {
    controlBanner.setActivity('Typing in Edge');
    controlBanner.touch();
    expect(last().mode.activity).toBe('running in background · Typing in Edge');
    expect(overlayEnv(last().mode).CLAWD_BANNER_ACTIVITY).toBe('running in background · Typing in Edge');
    controlBanner.pin(); controlBanner.unpin(); // the session ends: hidden
    controlBanner.touch();
    expect(last().mode.activity).toBe('running in background');   // the start value is the mode alone, never "Working"
    expect(overlayEnv(last().mode).CLAWD_BANNER_ACTIVITY).toBe('running in background');
  });

  it('writes nothing to the paused card', async () => {
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    controlBanner.setActivity('Typing in Edge');
    await flush();
    expect(last().child.written).toEqual([]);
    expect(overlayEnv(last().mode).CLAWD_BANNER_APP).toBe('');
  });

  it('the pill after a pause does not repeat the action from before it', () => {
    controlBanner.setActivity('Typing in Edge');
    controlBanner.touch();
    controlBanner.showPaused({ id: 1, message: 'Sign in', since: 0 }, () => {});
    controlBanner.showRunning();
    expect(last().mode.activity).toBe('running in background');
  });
});

describe('pointer-guard announces guarded inputs', () => {
  afterEach(() => { setInputGuard(null); setOnAgentInput(null); });

  it('after the guard passes, and not when it refuses', async () => {
    const seen: string[] = [];
    setOnAgentInput(m => seen.push(m));
    let refuse = false;
    setInputGuard({
      stopCheck: () => { if (refuse) throw new Error('stopped'); },
      before: async () => { if (refuse) throw new Error('stopped'); },
      done: () => {}, focused: async () => {}, launched: async () => {}, byName: async () => {},
    });
    const target = guardInputMethods({ typeText: async (_text: string) => {}, navigate: async (_url: string) => {} });
    await target.typeText('hi');
    await target.navigate('https://example.com');
    refuse = true;
    await expect(target.typeText('no')).rejects.toThrow('stopped');
    await expect(target.navigate('x')).rejects.toThrow('stopped');
    expect(seen).toEqual(['typeText', 'navigate']);
  });
});

describe('quick takeovers (R2 bursts) on the pill', () => {
  const USER = { processId: 10, handle: 500 };
  const TARGET = { processId: 42, handle: 900 };
  const burst = () => {
    let fg: typeof USER = USER;
    return withForegroundBurst({
      getActiveWindow: async () => fg as never,
      focusWindow: async () => { fg = TARGET; return true; },
      restoreForeground: async () => { fg = USER; return true; },
      userIdle: async () => ({ tick: 1, idleMs: 5000 }),
      cursorPos: async () => ({ x: 0, y: 0 }),
      mouseMove: async () => {},
    }, { processId: 42 }, async () => 'ok');
  };

  it('says nothing at 0, then the count after each burst', async () => {
    resetBurstCount();
    controlBanner.touch();
    controlBanner.setActivity('Typing in Edge');
    await burst();
    controlBanner.setActivity('Typing in Edge');
    await burst();
    controlBanner.setActivity('Typing in Edge');
    await flush();
    expect(last().child.written).toEqual([
      'ACTIVITY running in background · Typing in Edge',
      'ACTIVITY requires foreground · Typing in Edge · 1 quick takeover',
      'ACTIVITY requires foreground · Typing in Edge · 2 quick takeovers',
    ]);
  });

  it('the next session starts at 0', async () => {
    resetBurstCount();
    await burst();
    controlBanner.pin(); controlBanner.unpin();   // the session ends
    expect(burstCount()).toBe(0);
  });
});
