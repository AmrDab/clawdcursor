/**
 * clawdcursor's own on-screen controls are the user's (owner requirement, live macOS 2026-10-24): the pill's tree was readable
 * by pid, its Resume button invokable by name — faking the user's answer — and nothing stopped acting while a pause waited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const overlay = { pids: [] as number[] };
const pause = { pending: null as null | { message: string } };
vi.mock('../core/banner', () => ({ controlBanner: { overlayPids: () => overlay.pids } }));
vi.mock('../core/pause-gate', () => ({ pauseGate: { current: () => pause.pending } }));

import { ownUiRefusal } from '../core/own-ui-guard';
import { classifyResult } from '../core/result-codes';

beforeEach(() => { overlay.pids = [4242, 4243]; pause.pending = null; });

describe('ownUiRefusal', () => {
  it('a call aimed at an overlay pid is refused — reads too, under every pid argument name', () => {
    for (const args of [{ processId: 4242 }, { pid: 4243 }, { process_id: '4242' }]) {
      const why = ownUiRefusal(args, false);
      expect(why).toMatch(/is clawdcursor's own on-screen control/);
      expect(classifyResult(why!, true, false)?.code).toBe('OWN_UI');
    }
  });

  it('another app\'s pid, or no pid, is fine', () => {
    expect(ownUiRefusal({ processId: 954 }, true)).toBeNull();
    expect(ownUiRefusal({}, true)).toBeNull();
    expect(ownUiRefusal(undefined, true)).toBeNull();
  });

  it('with no overlay running nothing is refused for its pid', () => {
    overlay.pids = [];
    expect(ownUiRefusal({ processId: 4242 }, true)).toBeNull();
  });

  it('while a pause waits, every acting call is refused; reads still run', () => {
    pause.pending = { message: 'Sign in' };
    const why = ownUiRefusal({ name: 'Resume' }, true);
    expect(why).toMatch(/a pause is waiting for the user on screen/);
    expect(classifyResult(why!, true, true)?.code).toBe('PAUSED');
    expect(ownUiRefusal({}, false)).toBeNull();
  });
});
