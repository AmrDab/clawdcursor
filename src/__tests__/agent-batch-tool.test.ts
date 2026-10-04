/**
 * The autonomous loop's `batch` tool (src/core/agent-loop/batch-tool.ts).
 * buildUnifiedTools + the loop safety are mocked so we test the executor's
 * orchestration over the agent-loop machinery in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unified: Record<string, any> = {};
let safetyFn: (a: any) => any = () => ({ decision: 'allow', tier: 'input' });

vi.mock('../core/agent-loop/tools', () => ({
  buildUnifiedTools: () => Object.values(unified),
}));
vi.mock('../core/safety', () => ({
  evaluate: (a: any) => safetyFn(a),
  isAllowed: (d: any) => d.decision === 'allow',
}));

import { buildBatchTool } from '../core/agent-loop/batch-tool';

const uTool = (name: string, fn?: any) => ({ name, execute: fn ?? vi.fn(async () => ({ success: true, text: `${name} ok` })) });
const ctx = { mode: 'blind', task: 'do the thing', activeApp: 'notepad' } as any;
const run = (steps: any, args: any = {}) => buildBatchTool().execute({ steps: JSON.stringify(steps), ...args }, ctx);

beforeEach(() => {
  for (const k of Object.keys(unified)) delete unified[k];
  safetyFn = () => ({ decision: 'allow', tier: 'input' });
  // read_screen used by guards — default: empty tree
  unified.read_screen = uTool('read_screen', vi.fn(async () => ({ success: true, text: '(empty a11y tree)' })));
});

describe('agent batch — happy path', () => {
  it('runs all steps and reports success', async () => {
    unified.open_app = uTool('open_app');
    unified.type = uTool('type');
    const r = await run([{ name: 'open_app', args: { name: 'notepad' } }, { name: 'type', args: { text: 'hi' } }]);
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/all 2 steps completed/);
    expect(unified.type.execute).toHaveBeenCalled();
  });

  it('accepts steps as a raw array, not only a JSON string (matches the README/MCP schema)', async () => {
    // Regression for the schema/contract mismatch: the MCP inputSchema used to
    // declare steps:string, so an agent following the README (`batch({steps:[...]})`)
    // got "Expected string, received array". Schema is now an array; the handler
    // still accepts a JSON string for resilience. Pass the array DIRECTLY here.
    unified.open_app = uTool('open_app');
    unified.type = uTool('type');
    const r = await buildBatchTool().execute(
      { steps: [{ name: 'open_app', args: { name: 'notepad' } }, { name: 'type', args: { text: 'hi' } }] },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/all 2 steps completed/);
  });
});

describe('agent batch — halting', () => {
  it('halts on a failed step and skips the rest', async () => {
    unified.open_app = uTool('open_app');
    unified.type = uTool('type', vi.fn(async () => ({ success: false, text: 'no focus' })));
    unified.key = uTool('key');
    const r = await run([{ name: 'open_app' }, { name: 'type' }, { name: 'key' }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/halted at step 1/);
    expect(unified.key.execute).not.toHaveBeenCalled();
  });

  it('halts on unknown tool', async () => {
    unified.open_app = uTool('open_app');
    const r = await run([{ name: 'open_app' }, { name: 'nope' }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/not available/);
  });

  it('never resolves the batch tool itself (no recursion)', async () => {
    unified.batch = uTool('batch'); // present in catalog but must be filtered out
    const r = await run([{ name: 'batch', args: { steps: '[]' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/not available/);
  });
});

describe('agent batch — guards (re-perceive)', () => {
  it('halts when the expected window is not focused', async () => {
    unified.read_screen = uTool('read_screen', vi.fn(async () => ({ success: true, text: 'WINDOWS [msedge] "YouTube"' })));
    unified.type = uTool('type');
    const r = await run([{ name: 'type', args: { text: 'x' }, expect: { window: 'notepad' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/window "notepad" not focused/);
    expect(unified.type.execute).not.toHaveBeenCalled();
  });

  it('proceeds when the expected window is present in the tree', async () => {
    unified.read_screen = uTool('read_screen', vi.fn(async () => ({ success: true, text: 'WINDOWS [Notepad] "Untitled - Notepad"' })));
    unified.type = uTool('type');
    const r = await run([{ name: 'type', args: { text: 'x' }, expect: { window: 'notepad' } }]);
    expect(r.success).toBe(true);
    expect(unified.type.execute).toHaveBeenCalled();
  });
});

describe('agent batch — per-step parity with the single-call pipeline (audit 2026-06-10 finding B)', () => {
  it('resolves an el_NN ref to its label for the safety gate (batched Send is gated like a single call)', async () => {
    unified.invoke_element = uTool('invoke_element');
    const seenLabels: Array<string | undefined> = [];
    safetyFn = (a) => { seenLabels.push(a.targetLabel); return { decision: 'allow', tier: 'input' }; };
    const uiMaps = {
      resolve: vi.fn(() => ({
        ok: true,
        map: { elements: [{ id: 'el_7', text: 'Send', normalized_text: 'send' }] },
      })),
      invalidate: vi.fn(),
    };
    await buildBatchTool().execute(
      { steps: [{ name: 'invoke_element', args: { element_id: 'el_7', snapshot_id: 'obs_3' } }] },
      { ...ctx, uiMaps } as any,
    );
    expect(seenLabels).toContain('Send');
  });

  it('invalidates the UIMap holder after a successful screen-changing step', async () => {
    unified.click = { ...uTool('click'), changesScreen: true };
    const uiMaps = { resolve: vi.fn(), invalidate: vi.fn() };
    const r = await buildBatchTool().execute(
      { steps: [{ name: 'click', args: { x: 1, y: 2 } }] },
      { ...ctx, uiMaps } as any,
    );
    expect(r.success).toBe(true);
    expect(uiMaps.invalidate).toHaveBeenCalled();
  });

  it('does NOT invalidate the holder for a failed step with no observable change', async () => {
    unified.click = { ...uTool('click', vi.fn(async () => ({ success: false, text: 'ref rejected' }))), changesScreen: true };
    const uiMaps = { resolve: vi.fn(), invalidate: vi.fn() };
    await buildBatchTool().execute(
      { steps: [{ name: 'click', args: { x: 1, y: 2 } }] },
      { ...ctx, uiMaps } as any,
    );
    expect(uiMaps.invalidate).not.toHaveBeenCalled();
  });

  it('honors an assertion-array expect inside a step\'s args — DEVIATION halts the batch', async () => {
    // app_running check throws against the stub ctx (no platform adapter) →
    // the assertion fails → reactiveCheck flips the step to DEVIATION.
    unified.key = { ...uTool('key'), changesScreen: true };
    unified.type = uTool('type');
    const r = await buildBatchTool().execute(
      {
        steps: [
          { name: 'key', args: { combo: 'Return', expect: [{ type: 'app_running', name: 'definitely-not-running' }] } },
          { name: 'type', args: { text: 'should never run' } },
        ],
      },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/DEVIATION/);
    expect(unified.type.execute).not.toHaveBeenCalled();
  });

  it('rejects a malformed expect BEFORE running the step (no double-act on retry)', async () => {
    unified.key = { ...uTool('key'), changesScreen: true };
    const r = await buildBatchTool().execute(
      { steps: [{ name: 'key', args: { combo: 'Escape', expect: 'window_title_contains:Identity' } }] },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/expect rejected \(nothing executed\)/);
    expect(unified.key.execute).not.toHaveBeenCalled();
  });

  it('blocks terminal tools inside a batch (done/give_up semantics would be discarded)', async () => {
    unified.done = { ...uTool('done'), terminal: true };
    const r = await run([{ name: 'done', args: { evidence: 'pretend finished' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/not available inside a batch/);
  });

  it('accepts the canonical `precheck` name for preconditions', async () => {
    unified.read_screen = uTool('read_screen', vi.fn(async () => ({ success: true, text: 'WINDOWS [msedge] "YouTube"' })));
    unified.type = uTool('type');
    const r = await run([{ name: 'type', args: { text: 'x' }, precheck: { window: 'notepad' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/window "notepad" not focused/);
    expect(unified.type.execute).not.toHaveBeenCalled();
  });
});

describe('agent batch — safety + cap + parsing', () => {
  it('halts at a step the loop safety blocks', async () => {
    unified.invoke_element = uTool('invoke_element');
    safetyFn = (a) => a.tool === 'invoke_element' ? { decision: 'confirm', tier: 'destructive', reason: 'Send' } : { decision: 'allow', tier: 'input' };
    const r = await run([{ name: 'invoke_element', args: { name: 'Send' } }]);
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/safety confirm/);
    expect(unified.invoke_element.execute).not.toHaveBeenCalled();
  });

  it('caps at 10 steps', async () => {
    unified.t = uTool('t');
    const r = await run(Array.from({ length: 12 }, () => ({ name: 't' })));
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/capped at 10/);
  });

  it('accepts steps as a real array too, and rejects malformed', async () => {
    unified.t = uTool('t');
    const direct = await buildBatchTool().execute({ steps: [{ name: 't' }] } as any, ctx);
    expect(direct.success).toBe(true);
    const bad = await buildBatchTool().execute({ steps: 'not json' } as any, ctx);
    expect(bad.success).toBe(false);
  });
});
