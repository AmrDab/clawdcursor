/**
 * Guarded action-sequence executor (src/tools/batch.ts).
 * Registry + safety gate are mocked so we test the ORCHESTRATION logic in
 * isolation: ordered execution, precondition guards (re-perceive), safety
 * halting, error halting, the trace, dry-run, and the step cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the two collaborators the executor reuses ──────────────────────────
const tools: Record<string, any> = {};
let safetyFor: (name: string, args: any) => any = () => null; // null = allow

vi.mock('../tools/registry', () => ({
  getTool: (name: string) => tools[name],
  getCompactTools: () => [],
}));
vi.mock('../tools/safety-gate', () => ({
  evaluateToolCall: (tool: any, args: any) => safetyFor(tool.name, args),
}));

let pausePending: null | { message: string } = null;
vi.mock('../core/pause-gate', () => ({ pauseGate: { current: () => pausePending } }));

import { executeBatch, getBatchTools } from '../tools/batch';

const tool = (name: string, handler: any) => ({ name, parameters: {}, safetyTier: 1, handler });
const okTool = (name: string) => tool(name, vi.fn(async () => ({ text: `${name} ok` })));
const ctx = {} as any;

beforeEach(() => {
  for (const k of Object.keys(tools)) delete tools[k];
  safetyFor = () => null;
  pausePending = null;
});

describe('executeBatch — a pause waiting for the user', () => {
  it('halts before the first step runs — reads too (deny by default)', async () => {
    tools.read_screen = { ...okTool('read_screen'), safetyTier: 0 };
    tools.click = okTool('click');
    pausePending = { message: 'Sign in' };
    const r = await executeBatch([{ name: 'read_screen', arguments: {} }, { name: 'click', arguments: { x: 1, y: 2 } }], ctx);
    expect(tools.read_screen.handler).not.toHaveBeenCalled();
    expect(tools.click.handler).not.toHaveBeenCalled();
    expect(r.steps[0]).toMatchObject({ status: 'blocked' });
    expect(r.steps[0].text).toMatch(/a pause is waiting for the user on screen/);
  });

  it('a step precondition (a screen read) is not run during a pause', async () => {
    tools.click = okTool('click');
    tools.get_active_window = okTool('get_active_window');
    pausePending = { message: 'Sign in' };
    const r = await executeBatch([{ name: 'click', arguments: { x: 1, y: 2 }, precheck: { window: 'Notepad' } } as any], ctx);
    expect(tools.get_active_window.handler).not.toHaveBeenCalled();
    expect(r.steps[0]).toMatchObject({ status: 'blocked' });
  });
});

describe('executeBatch — happy path', () => {
  it('runs all steps in order and reports allDone', async () => {
    tools.open_app = okTool('open_app');
    tools.type_text = okTool('type_text');
    const r = await executeBatch(
      [{ name: 'open_app', arguments: { name: 'notepad' } }, { name: 'type_text', arguments: { text: 'hi' } }],
      ctx,
    );
    expect(r.allDone).toBe(true);
    expect(r.completed).toBe(2);
    expect(r.steps.map(s => s.status)).toEqual(['ok', 'ok']);
    expect(tools.open_app.handler).toHaveBeenCalledTimes(1);
  });

  // Live blind test: a step written with the agent-loop's `args` key ran with
  // NO arguments here. Both spellings are accepted on both batch surfaces.
  it('accepts `args` as an alias of `arguments` (handler, safety gate and label)', async () => {
    tools.type_text = okTool('type_text');
    const seen: any[] = [];
    safetyFor = (_n, a) => { seen.push(a); return null; };
    const r = await executeBatch([{ name: 'type_text', args: { action: 'x', text: 'hi' } } as any], ctx);
    expect(r.allDone).toBe(true);
    expect(tools.type_text.handler).toHaveBeenCalledWith({ action: 'x', text: 'hi' }, ctx);
    expect(seen).toEqual([{ action: 'x', text: 'hi' }]);
    expect(r.steps[0].label).toBe('type_text.x');
  });
});

describe('executeBatch — halting', () => {
  it('halts on a step error and does NOT run later steps', async () => {
    tools.open_app = okTool('open_app');
    tools.type_text = tool('type_text', vi.fn(async () => ({ text: 'boom', isError: true })));
    tools.key_press = okTool('key_press');
    const r = await executeBatch(
      [{ name: 'open_app' }, { name: 'type_text' }, { name: 'key_press' }],
      ctx,
    );
    expect(r.allDone).toBe(false);
    expect(r.completed).toBe(1);
    expect(r.stoppedAt).toBe(1);
    expect(r.steps[1].status).toBe('error');
    expect(tools.key_press.handler).not.toHaveBeenCalled(); // never reached
  });

  it('halts on an unknown tool', async () => {
    tools.open_app = okTool('open_app');
    const r = await executeBatch([{ name: 'open_app' }, { name: 'nope' }], ctx);
    expect(r.completed).toBe(1);
    expect(r.steps[1].status).toBe('unknown_tool');
  });

  it('caps the number of executed steps', async () => {
    tools.t = okTool('t');
    const steps = Array.from({ length: 5 }, () => ({ name: 't' }));
    const r = await executeBatch(steps, ctx, { maxSteps: 3 });
    expect(r.completed).toBe(3);
    expect(r.stopReason).toMatch(/capped at 3/);
  });
});

describe('executeBatch — guards (re-perceive precondition)', () => {
  it('halts with guard_failed when the foreground window does not match', async () => {
    tools.get_active_window = tool('get_active_window', vi.fn(async () => ({ text: '{"processName":"msedge","title":"YouTube"}' })));
    tools.type_text = okTool('type_text');
    const r = await executeBatch(
      [{ name: 'type_text', arguments: { text: 'x' }, expect: { window: 'notepad' } }],
      ctx,
    );
    expect(r.steps[0].status).toBe('guard_failed');
    expect(tools.type_text.handler).not.toHaveBeenCalled(); // action blocked by failed precondition
    expect(r.stopReason).toMatch(/precondition failed/);
  });

  it('proceeds when the guard matches the foreground window', async () => {
    tools.get_active_window = tool('get_active_window', vi.fn(async () => ({ text: '{"processName":"notepad","title":"Untitled - Notepad"}' })));
    tools.type_text = okTool('type_text');
    const r = await executeBatch(
      [{ name: 'type_text', arguments: { text: 'x' }, expect: { window: 'notepad' } }],
      ctx,
    );
    expect(r.allDone).toBe(true);
    expect(tools.type_text.handler).toHaveBeenCalled();
  });

  it('halts when an expected element is not present', async () => {
    tools.find_element = tool('find_element', vi.fn(async () => ({ text: 'Element "Send" not found' })));
    tools.invoke_element = okTool('invoke_element');
    const r = await executeBatch(
      [{ name: 'invoke_element', arguments: { name: 'Send' }, expect: { element: 'Send' } }],
      ctx,
    );
    expect(r.steps[0].status).toBe('guard_failed');
    expect(tools.invoke_element.handler).not.toHaveBeenCalled();
  });
});

describe('executeBatch — safety', () => {
  const ENV_KEY = 'CLAWD_BATCH_ALLOW_CONFIRM';
  let prevEnv: string | undefined;
  beforeEach(() => { prevEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
  afterEach(() => { if (prevEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prevEnv; });

  it('halts at a confirm-tier step by default (no allowConfirm)', async () => {
    tools.close_window = okTool('close_window');
    safetyFor = (name) => name === 'close_window' ? { text: 'close_window: safety confirm - destructive', isError: true } : null;

    const blocked = await executeBatch([{ name: 'close_window' }], ctx);
    expect(blocked.steps[0].status).toBe('needs_confirm');
    expect(tools.close_window.handler).not.toHaveBeenCalled();
  });

  // GHSA-3v3f-5rwv-whc9: a caller-supplied allowConfirm must NOT bypass the
  // confirm tier on its own — only the operator env flag unlocks it.
  it('SECURITY: caller allowConfirm alone does NOT bypass confirm tier', async () => {
    tools.close_window = okTool('close_window');
    safetyFor = (name) => name === 'close_window' ? { text: 'close_window: safety confirm - destructive', isError: true } : null;
    // env NOT set (cleared in beforeEach) → the exploit path
    const attempt = await executeBatch([{ name: 'close_window' }], ctx, { allowConfirm: true });
    expect(attempt.allDone).toBe(false);
    expect(attempt.steps[0].status).toBe('needs_confirm');
    expect(tools.close_window.handler).not.toHaveBeenCalled();
  });

  it('proceeds only when operator env flag AND caller allowConfirm are both set', async () => {
    tools.close_window = okTool('close_window');
    safetyFor = (name) => name === 'close_window' ? { text: 'close_window: safety confirm - destructive', isError: true } : null;

    process.env[ENV_KEY] = '1';
    // operator enabled, but caller did NOT ask → still halts
    const noAsk = await executeBatch([{ name: 'close_window' }], ctx);
    expect(noAsk.steps[0].status).toBe('needs_confirm');
    expect(tools.close_window.handler).not.toHaveBeenCalled();

    // both present → proceeds
    const allowed = await executeBatch([{ name: 'close_window' }], ctx, { allowConfirm: true });
    expect(allowed.allDone).toBe(true);
    expect(tools.close_window.handler).toHaveBeenCalled();
  });

  it('always halts at a hard block, even with the operator flag + allowConfirm', async () => {
    process.env[ENV_KEY] = '1';
    tools.dangerous = okTool('dangerous');
    safetyFor = () => ({ text: 'dangerous: safety block - not allowed', isError: true });
    const r = await executeBatch([{ name: 'dangerous' }], ctx, { allowConfirm: true });
    expect(r.steps[0].status).toBe('blocked');
    expect(tools.dangerous.handler).not.toHaveBeenCalled();
  });
});

describe('batch tool — dry run + parsing', () => {
  const batchTool = () => getBatchTools()[0];

  it('dry run reports tiers without executing', async () => {
    tools.open_app = okTool('open_app');
    tools.close_window = okTool('close_window');
    safetyFor = (name) => name === 'close_window' ? { text: 'safety confirm - x', isError: true } : null;
    const r = await batchTool().handler({ steps: [{ name: 'open_app' }, { name: 'close_window' }], dryRun: true }, ctx);
    expect(r.text).toMatch(/dry run/);
    expect(r.text).toMatch(/\[allow\] open_app/);
    expect(r.text).toMatch(/\[confirm\] close_window/);
    expect(tools.open_app.handler).not.toHaveBeenCalled(); // dry run executes nothing
  });

  it('accepts steps as a JSON string', async () => {
    tools.open_app = okTool('open_app');
    const r = await batchTool().handler({ steps: JSON.stringify([{ name: 'open_app', arguments: { name: 'notepad' } }]) }, ctx);
    expect(r.isError).toBeFalsy();
    expect(tools.open_app.handler).toHaveBeenCalled();
  });

  it('rejects empty / malformed steps', async () => {
    expect((await batchTool().handler({ steps: [] }, ctx)).isError).toBe(true);
    expect((await batchTool().handler({ steps: 'not json' }, ctx)).isError).toBe(true);
  });
});
