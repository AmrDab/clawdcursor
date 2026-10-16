/**
 * Bounded-sync delegation (#bug 2026-06-12): delegate_to_agent used to await
 * the WHOLE autonomous loop, so any task longer than the MCP client's
 * call-timeout (~60s) "timed out" on the caller while the work finished
 * invisibly in the background. The contract under test:
 *   - completes within the bound → result returned directly (old behavior)
 *   - exceeds the bound → {status:"running"} receipt, loop keeps running
 *   - re-call with the SAME task → re-attaches (no duplicate executeTask)
 *   - re-call after settle → final result handed over, holder cleared
 *   - different task while busy → explicit BUSY error
 *   - busy via another route (submit_task/scheduler) → explicit error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getOrchestrationTools, __resetInflightDelegationForTests } from '../tools/orchestration';
import type { ToolContext } from '../tools/types';

const delegate = getOrchestrationTools().find(t => t.name === 'delegate_to_agent')!;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function makeCtx(opts: {
  durationMs?: number;
  result?: { success: boolean; steps?: Array<{ description?: string }>; duration?: number };
  reject?: Error;
  /** Force getState to this fixed value (simulates a run started elsewhere). */
  state?: { status: string; currentStep?: string; stepsCompleted?: number; stepsTotal?: number };
}): { ctx: ToolContext; executeTask: ReturnType<typeof vi.fn> } {
  // Realistic state machine: idle until executeTask is invoked, 'acting' while
  // the fake loop runs, idle again after it settles — unless a fixed state is
  // forced via opts.state.
  let running = 0;
  const executeTask = vi.fn(() => new Promise((resolve, rejectP) => {
    running++;
    setTimeout(() => {
      running--;
      if (opts.reject) rejectP(opts.reject);
      else resolve(opts.result ?? { success: true, steps: [{ description: 'did it' }], duration: 1234 });
    }, opts.durationMs ?? 10);
  }));
  const ctx = {
    agent: {
      executeTask,
      getState: vi.fn(() => opts.state ?? (running > 0
        ? { status: 'acting', currentStep: 'clicking Personalize', stepsCompleted: 2, stepsTotal: 5 }
        : { status: 'idle' })),
    },
    ensureInitialized: async () => {},
  } as unknown as ToolContext;
  return { ctx, executeTask };
}

beforeEach(() => {
  __resetInflightDelegationForTests();
});

describe('delegate_to_agent — bounded-sync', () => {
  it('returns the result directly when the task completes within the bound', async () => {
    const { ctx } = makeCtx({ durationMs: 30 });
    const r = await delegate.handler({ task: 'open notepad', timeout: 1 }, ctx);
    const parsed = JSON.parse(r.text);
    expect(parsed.success).toBe(true);
    expect(parsed.steps).toBe(1);
    expect(parsed.lastAction).toBe('did it');
    expect(r.isError).toBeFalsy();
  });

  it('returns a running receipt when the task exceeds the bound — and the loop keeps running', async () => {
    const { ctx, executeTask } = makeCtx({ durationMs: 1600 });
    const r = await delegate.handler({ task: 'change the wallpaper', timeout: 1 }, ctx);
    expect(r.isError).toBeFalsy();                       // a receipt is NOT an error
    const parsed = JSON.parse(r.text);
    expect(parsed.status).toBe('running');
    expect(parsed.task).toBe('change the wallpaper');
    expect(parsed.progress.currentStep).toBe('clicking Personalize');
    expect(parsed.next).toMatch(/SAME task text/);
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it('re-call with the SAME task re-attaches (no restart) and returns the final result', async () => {
    const { ctx, executeTask } = makeCtx({ durationMs: 1500 });
    const r1 = await delegate.handler({ task: 'change the wallpaper', timeout: 1 }, ctx);
    expect(JSON.parse(r1.text).status).toBe('running');
    // Second bounded wait overlaps the task finishing (~0.5s into it).
    const r2 = await delegate.handler({ task: 'Change The Wallpaper', timeout: 1 }, ctx); // case/space-insensitive match
    const parsed = JSON.parse(r2.text);
    expect(parsed.success).toBe(true);
    expect(executeTask).toHaveBeenCalledTimes(1);        // re-attached, never restarted
  });

  it('hands over a stored result when the task settled while the caller was away', async () => {
    const { ctx, executeTask } = makeCtx({ durationMs: 1200 });
    const r1 = await delegate.handler({ task: 'do the thing', timeout: 1 }, ctx);
    expect(JSON.parse(r1.text).status).toBe('running');
    await sleep(400);                                     // task settles in the background
    const r2 = await delegate.handler({ task: 'do the thing', timeout: 1 }, ctx);
    expect(JSON.parse(r2.text).success).toBe(true);
    expect(executeTask).toHaveBeenCalledTimes(1);
    // Holder cleared — a NEW task can start now (it gets its own receipt,
    // since this mock task also outlives the 1s bound).
    const r3 = await delegate.handler({ task: 'another thing', timeout: 1 }, ctx);
    expect(JSON.parse(r3.text).status).toBe('running');
    expect(executeTask).toHaveBeenCalledTimes(2);
  });

  it('rejects a DIFFERENT task while one is running, with actionable guidance', async () => {
    const { ctx, executeTask } = makeCtx({ durationMs: 1500 });
    await delegate.handler({ task: 'long task A', timeout: 1 }, ctx);
    const r = await delegate.handler({ task: 'unrelated task B', timeout: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/BUSY with a different task/);
    expect(r.text).toMatch(/abort/);
    expect(executeTask).toHaveBeenCalledTimes(1);        // B was never started
  });

  it('surfaces a task error as isError after settle', async () => {
    const { ctx } = makeCtx({ durationMs: 30, reject: new Error('pipeline exploded') });
    const r = await delegate.handler({ task: 'doomed', timeout: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/pipeline exploded/);
  });

  it('marks an unsuccessful task result as isError', async () => {
    const { ctx } = makeCtx({ durationMs: 30, result: { success: false, steps: [], duration: 10 } });
    const r = await delegate.handler({ task: 'fails', timeout: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).success).toBe(false);
  });

  it('refuses to start when the agent is busy via another route (submit_task/scheduler)', async () => {
    const { ctx, executeTask } = makeCtx({ state: { status: 'acting' } });
    const r = await delegate.handler({ task: 'new task', timeout: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/started elsewhere/);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('errors on an empty task', async () => {
    const { ctx } = makeCtx({});
    const r = await delegate.handler({ task: '   ' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('compact task tool — status/abort routing', () => {
  it('exposes run/status/abort and routes them to the delegation family', async () => {
    const { getCompactTools } = await import('../tools/compact');
    const taskTool = getCompactTools().find(t => t.name === 'task')!;
    expect(taskTool.parameters.action?.enum).toEqual(['run', 'status', 'abort', 'resume']);
    // status routes to agent_status (works without instruction)
    const { ctx } = makeCtx({ state: { status: 'idle' } });
    const r = await taskTool.handler({ action: 'status' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text).status).toBe('idle');
  });

  it('defaults to run when only instruction is given (backward compatible)', async () => {
    const { getCompactTools } = await import('../tools/compact');
    const taskTool = getCompactTools().find(t => t.name === 'task')!;
    const { ctx, executeTask } = makeCtx({ durationMs: 20 });
    const r = await taskTool.handler({ instruction: 'open calc' }, ctx);
    expect(executeTask).toHaveBeenCalledWith('open calc');
    expect(JSON.parse(r.text).success).toBe(true);
  });
});
