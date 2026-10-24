/**
 * clawdcursor's own on-screen controls are the user's (owner requirement, live macOS 2026-10-24): the pill's tree was readable
 * by pid, its Resume button invokable by name — faking the user's answer — and nothing stopped acting while a pause waited.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const overlay = { pids: [] as number[] };
const pause = { pending: null as null | { message: string } };
vi.mock('../core/banner', () => ({ controlBanner: { overlayPids: () => overlay.pids } }));
vi.mock('../core/pause-gate', () => ({ pauseGate: { current: () => pause.pending } }));

import { ownUiRefusal, isPauseSafeCall } from '../core/own-ui-guard';
import { classifyResult } from '../core/result-codes';

beforeEach(() => { overlay.pids = [4242, 4243]; pause.pending = null; });

describe('ownUiRefusal', () => {
  it('a call aimed at an overlay pid is refused — reads too, under every pid argument name', () => {
    for (const args of [{ processId: 4242 }, { pid: 4243 }, { process_id: '4242' }]) {
      const why = ownUiRefusal(args, true);
      expect(why).toMatch(/is clawdcursor's own on-screen control/);
      expect(classifyResult(why!, true, false)?.code).toBe('OWN_UI');
    }
  });

  it('a call naming the macOS overlay process is refused', () => {
    for (const name of ['clawd-overlay', 'clawd-overlay-815dcbe9955a']) {
      expect(ownUiRefusal({ processName: name }, true)).toMatch(/is clawdcursor's own on-screen control/);
      expect(ownUiRefusal({ app: name }, true)).toMatch(/is clawdcursor's own on-screen control/);
    }
  });

  it('another app, or no target, is fine', () => {
    expect(ownUiRefusal({ processId: 954, processName: 'Finder' }, false)).toBeNull();
    expect(ownUiRefusal({}, false)).toBeNull();
    expect(ownUiRefusal(undefined, false)).toBeNull();
  });

  it('with no overlay running nothing is refused for its pid', () => {
    overlay.pids = [];
    expect(ownUiRefusal({ processId: 4242 }, false)).toBeNull();
  });

  it('while a pause waits, every call is refused — reads too — except the ones about the pause', () => {
    pause.pending = { message: 'Sign in' };
    for (const args of [{ name: 'Resume' }, {}]) {
      const why = ownUiRefusal(args, false);
      expect(why).toMatch(/a pause is waiting for the user on screen/);
      expect(classifyResult(why!, true, true)?.code).toBe('PAUSED');
    }
    expect(ownUiRefusal({}, true)).toBeNull();
  });
});

describe('isPauseSafeCall — deny by default', () => {
  it('waiting on, ending or reporting the pause is allowed', () => {
    for (const [tool, action] of [['system', 'pause_for_user'], ['task', 'status'], ['task', 'abort'], ['task', 'resume'],
      ['pause_for_user', undefined], ['agent_status', undefined], ['abort_task', undefined], ['resume_task', undefined],
      ['ask_user', undefined], ['done', undefined], ['give_up', undefined]] as const) {
      expect(isPauseSafeCall(tool, action), `${tool} ${action ?? ''}`).toBe(true);
    }
  });

  it('everything else is not — reads, scripts, key-sending reads, batches, starting a task', () => {
    for (const [tool, action] of [['accessibility', 'read_tree'], ['accessibility', 'invoke'], ['browser', 'evaluate'],
      ['system', 'copy_all_text'], ['system', 'clipboard_write'], ['computer', 'key'], ['computer', 'hover'], ['task', 'run'],
      ['batch', undefined], ['read_screen', undefined], ['invoke_element', undefined], ['type_text', undefined]] as const) {
      expect(isPauseSafeCall(tool, action), `${tool} ${action ?? ''}`).toBe(false);
    }
  });
});
