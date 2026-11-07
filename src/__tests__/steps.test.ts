/**
 * Where a call's time went (steps.ts): child processes and bridge commands started and ended inside one tool call.
 * Real processes, no mocks: the hook sits on ChildProcess.prototype.spawn.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { withSteps, timeStep, watchChildProcesses } from '../core/observability/steps';

const node = process.execPath;
const run = (ms: number) => new Promise<void>((res, rej) =>
  execFile(node, ['-e', `setTimeout(() => {}, ${ms})`], err => (err ? rej(err) : res())));
const slowLines = () => {
  const dir = process.env.CLAWDCURSOR_LOG_DIR!;
  return fs.readdirSync(dir).filter(f => f.endsWith('.log')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
    .filter(Boolean).map(l => JSON.parse(l)).filter(r => r.msg === 'step.slow');
};

beforeAll(() => watchChildProcesses());

describe('steps of a tool call', () => {
  it('counts each child process by its program name, and logs the slow ones with the call', async () => {
    const r = await withSteps('steps_test_tool', 'type', async () => { await run(10); await run(10); await run(1100); return 'done'; });
    expect(r.ok && r.result).toBe('done');
    expect(r.steps.node.n).toBe(3);
    expect(r.steps.node.ms).toBeGreaterThanOrEqual(1100);
    const slow = slowLines().filter(l => l.meta.tool === 'steps_test_tool');
    expect(slow).toHaveLength(1);
    expect(slow[0].meta).toMatchObject({ step: 'node', action: 'type' });
    expect(slow[0].meta.ms).toBeGreaterThanOrEqual(1100);
  }, 20_000);

  it('never keeps an argument, only the program name', async () => {
    const r = await withSteps('steps_args_tool', undefined, () => run(5));
    expect(Object.keys(r.steps)).toEqual(['node']);
  });

  it('a process that outlives its call (a bridge, the pill) is not its step; one outside any call is not recorded', async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const r = await withSteps('steps_long_tool', undefined, async () => {
      child = spawn(node, ['-e', 'setTimeout(() => {}, 1500)']);
    });
    await new Promise(res => child!.once('exit', res));
    expect(r.steps).toEqual({});
    expect(slowLines().filter(l => l.meta.tool === 'steps_long_tool')).toHaveLength(0);
    await run(5);  // no call running: nothing to attach it to, and no throw
  }, 20_000);

  it('a handler that throws still reports its steps, and timeStep names a bridge command', async () => {
    const r = await withSteps('steps_throw_tool', undefined, async () => {
      await timeStep('ps-bridge find-element', () => new Promise(res => setTimeout(res, 20)));
      throw new Error('boom');
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && (r.error as Error).message).toBe('boom');
    expect(r.steps['ps-bridge find-element'].n).toBe(1);
  });
});
