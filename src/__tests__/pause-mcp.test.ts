/**
 * Pause for the user — the outside-AI (MCP) side:
 *   - delegate_to_agent reports {status:"paused", waitingFor} while the task
 *     waits for the user (so the caller waits instead of restarting)
 *   - pause_for_user: bounded wait → {status:"waiting"}, re-call re-attaches,
 *     Resume → {status:"resumed"}; unavailable → clear error
 *   - resume_task answers the pause
 *   - POST /resume answers the pause
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { controlBanner } from '../core/banner';
import { pauseGate } from '../core/pause-gate';
import { getOrchestrationTools, __resetInflightDelegationForTests } from '../tools/orchestration';
import { getAgentTools } from '../tools/agent';
import { createUtilityServer, initServerToken } from '../surface/http-utility';

// The daemon token lives in DATA_DIR — never touch the user's real one.
vi.mock('../paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../paths')>()),
  DATA_DIR: path.join(os.tmpdir(), `clawdcursor-pause-test-${process.pid}`),
}));
import type { ToolContext } from '../tools/types';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  kill(): boolean { this.emit('exit', 0); return true; }
}

const delegate = getOrchestrationTools().find(t => t.name === 'delegate_to_agent')!;
const pauseForUser = getAgentTools().find(t => t.name === 'pause_for_user')!;
const resumeTask = getAgentTools().find(t => t.name === 'resume_task')!;
const noCtx = {} as ToolContext;

beforeEach(() => {
  delete process.env.CLAWD_NO_PAUSE;
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  controlBanner.__setPlatformEnabledForTests(true);
  controlBanner.__setSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
  controlBanner.__setGlowSpawnerForTests(() => new FakeChild() as unknown as ChildProcess);
  __resetInflightDelegationForTests();
});

afterEach(() => {
  pauseGate.__resetForTests();
  controlBanner.__resetForTests();
  process.env.CLAWD_NO_PAUSE = '1';
});

describe('delegate_to_agent while the task is paused', () => {
  it('returns {status:"paused", waitingFor} with "keep waiting, do not restart"', async () => {
    let state = { status: 'idle' } as Record<string, unknown>;
    let finish!: (r: unknown) => void;
    const ctx = {
      agent: {
        executeTask: () => new Promise(r => { finish = r; }),
        getState: () => state,
      },
    } as unknown as ToolContext;

    const call = delegate.handler({ task: 'star the repo', timeout: 1 }, ctx); // starts the task
    // ...which then pauses for the user while the caller is waiting
    const p = pauseGate.request({ message: 'Sign in to GitHub, then click Resume' });
    state = { status: 'paused', currentStep: 'Sign in to GitHub, then click Resume' };
    const r = await call;
    const body = JSON.parse(r.text);
    expect(r.isError).toBeFalsy();
    expect(body.status).toBe('paused');
    expect(body.waitingFor).toBe('Sign in to GitHub, then click Resume');
    expect(body.next).toMatch(/Do NOT restart/);

    pauseGate.answer('resume');
    await p;
    finish({ success: true, steps: [], duration: 1 });
  });
});

describe('pause_for_user', () => {
  it('waits, returns {status:"waiting"} at the bound, re-attaches, and reports Resume', async () => {
    const first = JSON.parse((await pauseForUser.handler({ message: 'Enter the 2FA code', timeout: 1 }, noCtx)).text);
    expect(first.status).toBe('waiting');
    const pending = pauseGate.current();
    expect(pending?.message).toBe('Enter the 2FA code');

    const second = pauseForUser.handler({ message: 'enter the  2FA code', timeout: 5 }, noCtx); // same key (normalised)
    setTimeout(() => pauseGate.answer('resume'), 50);
    const body = JSON.parse((await second).text);
    expect(body.status).toBe('resumed');
    expect(pauseGate.current()).toBeNull();

    // the outcome was delivered → a new call asks the user again
    const third = pauseForUser.handler({ message: 'Enter the 2FA code', timeout: 1 }, noCtx);
    await new Promise(r => setTimeout(r, 20));
    expect(pauseGate.current()?.id).not.toBe(pending?.id);
    pauseGate.answer('end');
    expect(JSON.parse((await third).text).status).toBe('ended');
  });

  it('"Something else" on the pill: {status:"replied", reply} with "follow it"', async () => {
    const call = pauseForUser.handler({ message: 'Sign in to Stripe', timeout: 5 }, noCtx);
    setTimeout(() => pauseGate.answer('reply', 'user', 'Use the test account instead'), 50);
    const body = JSON.parse((await call).text);
    expect(body.status).toBe('replied');
    expect(body.reply).toBe('Use the test account instead');
    expect(body.next).toMatch(/follow it/);
  });

  it('a reply that lands between calls is handed to the next call, text included', async () => {
    await pauseForUser.handler({ message: 'Enter the code', timeout: 1 }, noCtx);
    pauseGate.answer('reply', 'user', 'the code is 4821');
    const body = JSON.parse((await pauseForUser.handler({ message: 'Enter the code', timeout: 1 }, noCtx)).text);
    expect(body).toMatchObject({ status: 'replied', reply: 'the code is 4821' });
  });

  it('a Resume that lands between calls is handed to the next call', async () => {
    await pauseForUser.handler({ message: 'Solve the CAPTCHA', timeout: 1 }, noCtx);
    pauseGate.answer('resume');
    const body = JSON.parse((await pauseForUser.handler({ message: 'Solve the CAPTCHA', timeout: 1 }, noCtx)).text);
    expect(body.status).toBe('resumed');
  });

  it('says so when no on-screen prompt can be shown', async () => {
    controlBanner.__setPlatformEnabledForTests(false);
    const r = await pauseForUser.handler({ message: 'Sign in' }, noCtx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Ask the user in your own chat/);
  });
});

describe('resume_task', () => {
  it('resumes the pause; says so when nothing is paused', async () => {
    expect((await resumeTask.handler({}, noCtx)).text).toMatch(/nothing is paused/);

    const turn = pauseGate.request({ message: 'Sign in' });
    expect(JSON.parse((await resumeTask.handler({}, noCtx)).text)).toEqual({ resumed: true, was: 'Sign in' });
    // an AI resuming is never the user's on-screen confirmation
    await expect(turn).resolves.toBe('resumed_unverified');
  });
});

describe('POST /resume', () => {
  it('answers the pending pause; 409 when nothing is paused; 400 on a bad answer', async () => {
    const app = createUtilityServer({ onStop: () => {} });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const token = initServerToken();
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      expect((await post({ answer: 'resume' })).status).toBe(409);
      expect((await post({ answer: 'maybe' })).status).toBe(400);
      expect((await post({ answer: 'allow' })).status).toBe(400);
      const p = pauseGate.request({ message: 'Sign in' });
      const res = await post({ answer: 'resume' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, outcome: 'resumed', was: 'Sign in' });
      await expect(p).resolves.toBe('resumed');
    } finally {
      server.close();
    }
  });
});

describe('pause_for_user done_when: the pause ends the moment the user\'s step is done (live 2026-10-20: the user signed in and waited on a Resume click)', () => {
  /** A platform whose active window title the test changes, like a sign-in finishing. */
  function titled(initial: string) {
    const state = { title: initial };
    const platform = {
      getActiveWindow: vi.fn(async () => ({ title: state.title, processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } })),
      listWindows: vi.fn(async () => [{ title: state.title, processName: 'msedge', processId: 1 }]),
      getWindows: vi.fn(async () => [{ title: state.title, processName: 'msedge', processId: 1 }]),
    };
    return { state, ctx: { platform } as unknown as ToolContext };
  }

  it('resumes by itself once done_when holds, reported as detected (no Resume click)', async () => {
    const { state, ctx } = titled('Sign in | Glama');
    const call = pauseForUser.handler({ message: 'Sign in to Glama', done_when: [{ type: 'window_title_contains', value: 'Dashboard' }], timeout: 10 }, ctx);
    await new Promise(r => setTimeout(r, 50));
    expect(pauseGate.current()?.message).toBe('Sign in to Glama');
    state.title = 'Dashboard | Glama';              // the user finished signing in
    const body = JSON.parse((await call).text);
    expect(body.status).toBe('resumed');
    expect(body.detected).toBe(true);
    expect(pauseGate.current()).toBeNull();          // the pill went back to amber
  }, 10_000);

  it('a done_when that is already true is rejected — it would end the pause at once', async () => {
    const { ctx } = titled('Dashboard | Glama');
    const r = await pauseForUser.handler({ message: 'Sign in to Glama', done_when: [{ type: 'window_title_contains', value: 'Glama' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already true/);
    expect(pauseGate.current()).toBeNull();
  });

  it('an invalid done_when is rejected before anything shows', async () => {
    const { ctx } = titled('x');
    const r = await pauseForUser.handler({ message: 'Sign in', done_when: [{ type: 'nonsense' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/done_when rejected/);
    expect(pauseGate.current()).toBeNull();
  });

  it('Resume still works while done_when is false, and is reported as the user\'s click', async () => {
    const { ctx } = titled('Sign in | Glama');
    const call = pauseForUser.handler({ message: 'Sign in to Glama', done_when: [{ type: 'window_title_contains', value: 'Dashboard' }], timeout: 10 }, ctx);
    await new Promise(r => setTimeout(r, 50));
    pauseGate.answer('resume');
    const body = JSON.parse((await call).text);
    expect(body.status).toBe('resumed');
    expect(body.detected).toBeUndefined();
    expect(body.confirmedByUser).toBe(true);
  });
});

describe('pause_for_user done_when — review fixes', () => {
  function titled(initial: string) {
    const state = { title: initial, calls: 0 };
    const platform = {
      getActiveWindow: vi.fn(async () => ({ title: state.title, processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } })),
      listWindows: vi.fn(async () => { state.calls++; return [{ title: state.title, processName: 'msedge', processId: 1 }]; }),
    };
    return { state, ctx: { platform } as unknown as ToolContext };
  }
  const args = (extra: Record<string, unknown> = {}) => ({ message: 'Sign in to Glama', done_when: [{ type: 'window_title_contains', value: 'Dashboard' }], ...extra });

  it('a detected resume is NOT reported as the user\'s confirmation (a page can make done_when true)', async () => {
    const { state, ctx } = titled('Sign in | Glama');
    const call = pauseForUser.handler(args({ timeout: 10 }), ctx);
    await new Promise(r => setTimeout(r, 50));
    state.title = 'Dashboard | Glama';
    const body = JSON.parse((await call).text);
    expect(body.detected).toBe(true);
    expect(body.confirmedByUser).toBe(false);
    expect(body.next).toMatch(/not a confirmation/);
  }, 10_000);

  it('a re-call after the user finished re-attaches instead of calling it "already true" (no second prompt)', async () => {
    const { state, ctx } = titled('Sign in | Glama');
    const first = JSON.parse((await pauseForUser.handler(args({ timeout: 1 }), ctx)).text);
    expect(first.status).toBe('waiting');
    state.title = 'Dashboard | Glama';                       // done, but the next 1.5 s check has not run yet
    const again = await pauseForUser.handler(args({ timeout: 10 }), ctx);
    expect(again.isError).toBeFalsy();
    expect(JSON.parse(again.text)).toMatchObject({ status: 'resumed', detected: true });
  }, 15_000);

  it('ocr_contains text that is part of the message is rejected — OCR would read it off the prompt itself', async () => {
    const { ctx } = titled('x');
    const r = await pauseForUser.handler({ message: 'Sign in, you will land on Dashboard', done_when: [{ type: 'ocr_contains', value: 'dashboard' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/shown by the prompt itself/);
    expect(pauseGate.current()).toBeNull();
  });

  it('nothing is checked when no prompt can be shown', async () => {
    controlBanner.__setPlatformEnabledForTests(false);
    const { state, ctx } = titled('x');
    const r = await pauseForUser.handler(args(), ctx);
    expect(r.isError).toBe(true);
    expect(state.calls).toBe(0);
  });
});

describe('pause_for_user done_when — second review', () => {
  function titled(initial: string) {
    const state = { title: initial };
    const platform = {
      getActiveWindow: vi.fn(async () => ({ title: state.title, processName: 'msedge', processId: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } })),
      listWindows: vi.fn(async () => [{ title: state.title, processName: 'msedge', processId: 1 }]),
    };
    return { state, ctx: { platform } as unknown as ToolContext };
  }
  const args = (extra: Record<string, unknown> = {}) => ({ message: 'Sign in to Glama', done_when: [{ type: 'window_title_contains', value: 'Dashboard' }], ...extra });

  it('a re-call AFTER the pause ended by itself gets that outcome — not "already true", not a second prompt', async () => {
    const { state, ctx } = titled('Sign in | Glama');
    expect(JSON.parse((await pauseForUser.handler(args({ timeout: 1 }), ctx)).text).status).toBe('waiting');
    state.title = 'Dashboard | Glama';
    await new Promise(r => setTimeout(r, 2000));           // one check has run: the pill is gone
    expect(pauseGate.current()).toBeNull();
    const again = await pauseForUser.handler(args({ timeout: 5 }), ctx);
    expect(again.isError).toBeFalsy();
    expect(JSON.parse(again.text)).toMatchObject({ status: 'resumed', detected: true, confirmedByUser: false });
    expect(pauseGate.current()).toBeNull();                 // no second prompt
  }, 15_000);

  for (const label of ['Resume', 'End task', 'Something else', 'the agent says']) {
    it(`ocr_contains "${label}" is rejected — the prompt shows it itself`, async () => {
      const { ctx } = titled('x');
      const r = await pauseForUser.handler({ message: 'Sign in', done_when: [{ type: 'ocr_contains', value: label }] }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/shown by the prompt itself/);
    });
  }
});
