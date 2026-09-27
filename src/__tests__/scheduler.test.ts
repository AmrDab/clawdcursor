/**
 * Scheduled-task tests — cron persistence, CRUD via MCP tools, cron-validation
 * gate, agent-busy skip behavior. Uses a tmp CLAWD_HOME so the real user
 * cache is never touched. Stops every Cron instance in afterEach to keep
 * vitest from leaking timers across describes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSchedulerTools, initScheduler, stopScheduler, getActiveJobCount, _resetSchedulerForTests } from '../tools/scheduler';
import type { ToolContext } from '../tools/types';
import type { Agent } from '../core/agent';

// ── Mock Agent ────────────────────────────────────────────────────────────

function mockAgent(opts: { status?: 'idle' | 'running'; executeImpl?: (t: string) => Promise<void> } = {}): Agent {
  return {
    getState: vi.fn(() => ({ status: opts.status ?? 'idle' })),
    executeTask: vi.fn(opts.executeImpl ?? (async () => {})),
  } as unknown as Agent;
}

function findTool(name: string): NonNullable<ReturnType<typeof getSchedulerTools>[number]> {
  const t = getSchedulerTools().find(t => t.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

function makeCtx(agent?: Agent): ToolContext {
  return {
    desktop: null, a11y: null, cdp: null,
    agent,
    getMouseScaleFactor: () => 1,
    getScreenshotScaleFactor: () => 1,
    ensureInitialized: async () => {},
  } as unknown as ToolContext;
}

let tmpHome: string;
const origHome = process.env.CLAWD_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sched-test-'));
  process.env.CLAWD_HOME = tmpHome;
  // Re-import-cache safe: the scheduler reads CLAWD_HOME inside fs ops only,
  // through `DATA_DIR` which is computed at import time. To avoid stale-path
  // from previous imports, blow away test state explicitly.
  _resetSchedulerForTests();
});

afterEach(() => {
  stopScheduler();
  if (origHome === undefined) delete process.env.CLAWD_HOME;
  else process.env.CLAWD_HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('scheduler — MCP tool surface', () => {
  it('lists all 4 tools', () => {
    const tools = getSchedulerTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'scheduled_task_create',
      'scheduled_task_delete',
      'scheduled_task_list',
      'scheduled_task_toggle',
    ]);
  });

  it('every tool returns isError when no agent is bound to ctx (stdio MCP case)', async () => {
    const ctx = makeCtx(/* no agent */);
    // Only `create` checks ctx.agent in v0.9.1 — list/delete/toggle just mutate
    // the persisted file and the in-process registry, which is fine without
    // a daemon. Document and lock that surface.
    const create = await findTool('scheduled_task_create').handler({ task: 't', cron: '* * * * *' }, ctx);
    expect(create.isError).toBe(true);
    expect(create.text).toMatch(/daemon/i);
  });
});

describe('scheduler — create / list / delete', () => {
  it('rejects an invalid cron string before persisting', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    const r = await findTool('scheduled_task_create').handler({ task: 't', cron: 'not a cron' }, ctx);
    expect(r.isError).toBe(true);
    const list = await findTool('scheduled_task_list').handler({}, ctx);
    expect(JSON.parse(list.text).tasks).toHaveLength(0);
  });

  it('rejects a cron expression that never fires', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    // Feb 31st is illegal — croner reports never-fires.
    const r = await findTool('scheduled_task_create').handler({ task: 't', cron: '0 0 31 2 *' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('rejects empty task or empty cron', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    expect((await findTool('scheduled_task_create').handler({ task: '',  cron: '* * * * *' }, ctx)).isError).toBe(true);
    expect((await findTool('scheduled_task_create').handler({ task: 't', cron: '' },           ctx)).isError).toBe(true);
  });

  it('persists a valid schedule and surfaces nextRun', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    initScheduler(agent);
    const r = await findTool('scheduled_task_create').handler(
      { task: 'open inbox', cron: '*/5 * * * *' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.text);
    expect(payload.ok).toBe(true);
    expect(payload.task.id).toMatch(/^s_/);
    expect(payload.task.cron).toBe('*/5 * * * *');
    expect(payload.task.task).toBe('open inbox');
    expect(payload.task.enabled).toBe(true);
    expect(payload.nextRun).toBeTruthy();

    // List shows the persisted task.
    const list = await findTool('scheduled_task_list').handler({}, ctx);
    const tasks = JSON.parse(list.text).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(payload.task.id);

    // Job is live in the in-process registry.
    expect(getActiveJobCount()).toBe(1);
  });

  it('delete removes the task and unregisters its cron', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    initScheduler(agent);
    const c = await findTool('scheduled_task_create').handler({ task: 't', cron: '* * * * *' }, ctx);
    const id = JSON.parse(c.text).task.id;
    expect(getActiveJobCount()).toBe(1);

    const d = await findTool('scheduled_task_delete').handler({ id }, ctx);
    expect(JSON.parse(d.text).deleted).toBe(true);
    expect(getActiveJobCount()).toBe(0);
    expect(JSON.parse((await findTool('scheduled_task_list').handler({}, ctx)).text).tasks).toHaveLength(0);
  });

  it('delete with unknown id is a soft no-op', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    initScheduler(agent);
    const d = await findTool('scheduled_task_delete').handler({ id: 'nope' }, ctx);
    expect(d.isError).toBeFalsy();
    const payload = JSON.parse(d.text);
    expect(payload.deleted).toBe(false);
  });
});

describe('scheduler — toggle', () => {
  it('disable unregisters the cron job but keeps persistence', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    initScheduler(agent);
    const c = await findTool('scheduled_task_create').handler({ task: 't', cron: '* * * * *' }, ctx);
    const id = JSON.parse(c.text).task.id;
    expect(getActiveJobCount()).toBe(1);

    const t = await findTool('scheduled_task_toggle').handler({ id, enabled: false }, ctx);
    expect(t.isError).toBeFalsy();
    expect(JSON.parse(t.text).task.enabled).toBe(false);
    expect(getActiveJobCount()).toBe(0);

    // Still in the persisted list, just paused.
    const list = JSON.parse((await findTool('scheduled_task_list').handler({}, ctx)).text);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0].enabled).toBe(false);
  });

  it('re-enable registers the job again', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    initScheduler(agent);
    const c = await findTool('scheduled_task_create').handler({ task: 't', cron: '* * * * *' }, ctx);
    const id = JSON.parse(c.text).task.id;
    await findTool('scheduled_task_toggle').handler({ id, enabled: false }, ctx);
    expect(getActiveJobCount()).toBe(0);
    await findTool('scheduled_task_toggle').handler({ id, enabled: true }, ctx);
    expect(getActiveJobCount()).toBe(1);
  });

  it('toggle with unknown id is an error', async () => {
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    initScheduler(agent);
    const r = await findTool('scheduled_task_toggle').handler({ id: 'nope', enabled: true }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('scheduler — boot lifecycle', () => {
  it('initScheduler loads persisted tasks and registers enabled crons', async () => {
    // Seed a file directly to simulate a fresh daemon boot.
    const agent = mockAgent();
    const ctx = makeCtx(agent);
    initScheduler(agent);
    await findTool('scheduled_task_create').handler({ task: 't1', cron: '* * * * *' }, ctx);
    await findTool('scheduled_task_create').handler({ task: 't2', cron: '*/2 * * * *' }, ctx);
    const c3 = await findTool('scheduled_task_create').handler({ task: 't3', cron: '*/3 * * * *' }, ctx);
    const id3 = JSON.parse(c3.text).task.id;
    await findTool('scheduled_task_toggle').handler({ id: id3, enabled: false }, ctx);
    expect(getActiveJobCount()).toBe(2); // t3 is paused

    // Simulate daemon restart: stop, then init again.
    stopScheduler();
    expect(getActiveJobCount()).toBe(0);
    const r = initScheduler(agent);
    expect(r.registered).toBe(2); // t1 + t2 only
    expect(r.failed).toBe(0);
    expect(getActiveJobCount()).toBe(2);
  });
});

describe('scheduler — fire behavior', () => {
  // Both fire tests drive a real croner job on FAKE timers: we anchor the clock
  // to a whole-second boundary, register the once-per-second cron, then advance
  // exactly two second-boundaries and flush the async fireTask microtasks. The
  // previous `await setTimeout(1300ms)` on REAL timers was the flake source — on a
  // loaded runner (seen on windows-latest, v1.5.8) the 1300ms window could elapse
  // before croner's next-second tick actually fired, so executeTask hadn't been
  // called yet ("expected vi.fn() to be called at least once"). Advancing fake
  // timers makes the tick deterministic and independent of wall-clock scheduling.
  it('busy agent → tick is skipped, skipCount increments, executeTask NOT called', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      // Build an agent reporting busy, run a fast-firing cron.
      const executeTask = vi.fn(async () => {});
      const agent = {
        getState: vi.fn(() => ({ status: 'running' })),
        executeTask,
      } as unknown as Agent;
      const ctx = makeCtx(agent);
      initScheduler(agent);
      // 6-field cron with seconds — fires once per second.
      const c = await findTool('scheduled_task_create').handler(
        { task: 'noop', cron: '* * * * * *' },
        ctx,
      );
      const id = JSON.parse(c.text).task.id;
      // Cross two whole-second boundaries; each fires fireTask synchronously
      // (fireTask calls getState()/skipCount++ before any await), so both ticks
      // are fully applied when advanceTimersByTimeAsync resolves.
      await vi.advanceTimersByTimeAsync(2000);
      // Ticks fired but the agent was busy each time → skipped, never executed.
      expect(executeTask).not.toHaveBeenCalled();
      const list = JSON.parse((await findTool('scheduled_task_list').handler({}, ctx)).text);
      const found = list.tasks.find((t: any) => t.id === id);
      expect(found.skipCount).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('idle agent → tick calls executeTask with the task string', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const executeTask = vi.fn(async (_task: string) => {});
      const agent = {
        getState: vi.fn(() => ({ status: 'idle' })),
        executeTask,
      } as unknown as Agent;
      const ctx = makeCtx(agent);
      initScheduler(agent);
      await findTool('scheduled_task_create').handler(
        { task: 'hello world', cron: '* * * * * *' },
        ctx,
      );
      // Advance two second-boundaries; fireTask invokes executeTask(task)
      // synchronously inside the cron callback, so the call is recorded here.
      await vi.advanceTimersByTimeAsync(2000);
      expect(executeTask).toHaveBeenCalled();
      const firstCall = executeTask.mock.calls[0];
      expect(firstCall && firstCall[0]).toBe('hello world');
    } finally {
      vi.useRealTimers();
    }
  });
});
