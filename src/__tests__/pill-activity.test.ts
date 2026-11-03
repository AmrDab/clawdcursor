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
import { controlBanner, overlayEnv, activityLabel, appLabel, type OverlayMode } from '../core/banner';
import { guardInputMethods, setInputGuard, setOnAgentInput } from '../platform/pointer-guard';

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
  controlBanner.__setGlowSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
});
afterEach(() => controlBanner.__resetForTests());

describe('activityLabel / appLabel', () => {
  it('names the app for inputs that read the window in front', () => {
    expect(activityLabel('typeText', 'msedge.exe')).toBe('Typing in Edge');
    expect(activityLabel('mouseClick', 'notepad')).toBe('Clicking in Notepad');
    expect(activityLabel('keyPress', 'Google Chrome')).toBe('Pressing keys in Google Chrome');
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
    expect(last().child.written).toEqual(['ACTIVITY Typing in Edge', 'ACTIVITY Clicking in Edge']);
  });

  it('keeps a label on one line', async () => {
    controlBanner.touch();
    controlBanner.setActivity('a\r\nHIDE 9999');
    await flush();
    expect(last().child.written).toEqual(['ACTIVITY a HIDE 9999']);
  });

  it('a new pill starts with the current label; the next session starts blank', () => {
    controlBanner.setActivity('Typing in Edge');
    controlBanner.touch();
    expect(last().mode.activity).toBe('Typing in Edge');
    expect(overlayEnv(last().mode).CLAWD_BANNER_ACTIVITY).toBe('Typing in Edge');
    controlBanner.pin(); controlBanner.unpin(); // the session ends: hidden
    controlBanner.touch();
    expect(last().mode.activity).toBeUndefined();
    expect(overlayEnv(last().mode).CLAWD_BANNER_ACTIVITY).toBe('');
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
    expect(last().mode.activity).toBeUndefined();
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
      done: () => {}, focused: () => {}, launched: () => {},
    });
    const target = guardInputMethods({ typeText: async () => {}, navigate: async () => {} });
    await target.typeText('hi');
    await target.navigate('https://example.com');
    refuse = true;
    await expect(target.typeText('no')).rejects.toThrow('stopped');
    await expect(target.navigate('x')).rejects.toThrow('stopped');
    expect(seen).toEqual(['typeText', 'navigate']);
  });
});
