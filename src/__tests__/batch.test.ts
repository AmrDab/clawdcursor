/**
 * Guarded action-sequence executor (src/tools/batch.ts).
 * The registry is mocked so we test the ORCHESTRATION logic in isolation: ordered execution, precondition guards
 * (re-perceive), halting on a refusal or an error, the trace, and the step cap — and that a batch is not a way around
 * the user's Stop or the hard key list (GHSA-3v3f-5rwv-whc9).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the collaborator the executor reuses ───────────────────────────────
const tools: Record<string, any> = {};

vi.mock('../tools/registry', () => ({
  getTool: (name: string) => tools[name],
  getCompactTools: () => [],
}));

let pausePending: null | { message: string } = null;
vi.mock('../core/pause-gate', () => ({ pauseGate: { current: () => pausePending } }));

import { executeBatch, getBatchTools } from '../tools/batch';
import { stopControl, sleepUnlessStopped, STOPPED_TEXT, __setControlDirForTests } from '../core/control';
import { guardInputMethods } from '../platform/pointer-guard';
import { getDesktopTools } from '../tools/desktop';

const tool = (name: string, handler: any) => ({ name, parameters: {}, safetyTier: 1, handler });
const okTool = (name: string) => tool(name, vi.fn(async () => ({ text: `${name} ok` })));
const ctx = {} as any;

beforeEach(() => {
  for (const k of Object.keys(tools)) delete tools[k];
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

describe('executeBatch — the user stops clawdcursor mid-batch (#294)', () => {
  afterEach(() => __setControlDirForTests(null));

  it('a stop during the wait ends it at once, and the queued key and type never run', async () => {
    tools.wait = { ...tool('wait', async () => (await sleepUnlessStopped(30_000)) ? { text: `wait: ${STOPPED_TEXT}`, isError: true } : { text: 'Waited' }), safetyTier: 0 };
    tools.key_press = okTool('key_press');
    tools.type_text = okTool('type_text');
    setTimeout(() => stopControl('pill'), 30);
    const started = Date.now();
    const r = await executeBatch([
      { name: 'wait', arguments: { seconds: 30 } },
      { name: 'key_press', arguments: { key: 'ctrl+l' } },
      { name: 'type_text', arguments: { text: 'https://example.com\n' } },
    ], ctx);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(tools.key_press.handler).not.toHaveBeenCalled();
    expect(tools.type_text.handler).not.toHaveBeenCalled();
    expect(r.allDone).toBe(false);
    expect(r.steps[0].text).toMatch(/stopped by the user/);
  });

  it('after a stop every step is refused before it runs', async () => {
    tools.key_press = okTool('key_press');
    stopControl('pill');
    const r = await executeBatch([{ name: 'key_press', arguments: { key: 'Return' } }], ctx);
    expect(tools.key_press.handler).not.toHaveBeenCalled();
    expect(r.steps[0]).toMatchObject({ status: 'blocked', text: STOPPED_TEXT });
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
  it('accepts `args` as an alias of `arguments` (handler and label)', async () => {
    tools.type_text = okTool('type_text');
    const r = await executeBatch([{ name: 'type_text', args: { action: 'x', text: 'hi' } } as any], ctx);
    expect(r.allDone).toBe(true);
    expect(tools.type_text.handler).toHaveBeenCalledWith({ action: 'x', text: 'hi' }, ctx);
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

// GHSA-3v3f-5rwv-whc9: `allowConfirm:true` on a batch carried confirm-tier steps past the gate. The confirm tier, the
// flag, its env switch and dryRun are gone in 1.6. What a batch must still not get around: the user's Stop and the
// hard key list. Both sit below the batch (own-ui-guard per step, the input layer under every handler).
describe('a batch is not a way around the Stop or the hard key list (GHSA-3v3f-5rwv-whc9)', () => {
  afterEach(() => __setControlDirForTests(null));
  const batchTool = () => getBatchTools()[0];
  const LOCK = process.platform === 'darwin' ? 'ctrl+cmd+q' : 'win+l';
  /** The real key_press tool over a guarded keyboard, as the MCP server wires it. */
  function realKeyPress() {
    const sent: string[] = [];
    const desktop = guardInputMethods({ keyPress: async (c: string) => { sent.push(c); }, takeInputWarning: () => null });
    const keyCtx = { ensureInitialized: async () => {}, desktop, a11y: { getActiveWindow: async () => null, invalidateCache: () => {} } } as any;
    tools.key_press = getDesktopTools().find(t => t.name === 'key_press')!;
    return { sent, keyCtx };
  }

  it('the tool no longer takes allowConfirm or dryRun', () => {
    expect(Object.keys(batchTool().parameters).sort()).toEqual(['maxSteps', 'steps']);
    expect(batchTool().description).not.toMatch(/allowConfirm|dryRun|confirm-tier|CLAWD_BATCH_ALLOW_CONFIRM/);
  });

  it.each([{}, { allowConfirm: true }, { allowConfirm: true, dryRun: false }])('a locking key combo in a step is refused, with %j', async (flags) => {
    const { sent, keyCtx } = realKeyPress();
    const r = await batchTool().handler({ steps: [{ name: 'key_press', arguments: { key: LOCK } }], ...flags }, keyCtx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/dangerous key combo/);
    expect(sent).toEqual([]);
  });

  it('the sequence form is refused inside a batch too, and the batch halts there', async () => {
    const { sent, keyCtx } = realKeyPress();
    tools.type_text = okTool('type_text');
    const r = await executeBatch([{ name: 'key_press', arguments: { key: `esc ${LOCK}` } }, { name: 'type_text', arguments: { text: 'x' } }], keyCtx);
    expect(r.steps[0].status).toBe('error');
    expect(sent).toEqual(['esc']);
    expect(tools.type_text.handler).not.toHaveBeenCalled();
  });

  it('after the user stops clawdcursor, allowConfirm changes nothing: no step runs', async () => {
    tools.close_window = okTool('close_window');
    stopControl('pill');
    const r = await batchTool().handler({ steps: [{ name: 'close_window' }], allowConfirm: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(STOPPED_TEXT);
    expect(tools.close_window.handler).not.toHaveBeenCalled();
  });

  it('with no stop and no locking combo, a step that used to be confirm-tier simply runs', async () => {
    tools.close_window = okTool('close_window');
    const r = await executeBatch([{ name: 'close_window' }], ctx);
    expect(r.allDone).toBe(true);
    expect(tools.close_window.handler).toHaveBeenCalledTimes(1);
  });
});

describe('batch tool — parsing', () => {
  const batchTool = () => getBatchTools()[0];

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

  it('ends with one effect line for the whole batch: the window in front, by identity (#357)', async () => {
    tools.open_app = okTool('open_app');
    let n = 0;
    const getActiveWindow = vi.fn(async () => (n++ === 0 ? { processId: 1, processName: 'explorer', title: 'Desktop' } : { processId: 2, processName: 'notepad', appName: 'Notepad', title: 'Untitled' }));
    const r = await batchTool().handler({ steps: [{ name: 'open_app', arguments: { name: 'notepad' } }] }, { platform: { getActiveWindow } } as any);
    expect(r.text).toMatch(/\neffect: another app is in front: "Notepad" "Untitled"$/);
  });
});
