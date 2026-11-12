/**
 * Where a tool call's time went. A 19-character type_text took 25 s on a loaded Windows machine (2026-11-06): six
 * PowerShell starts of 2–4 s each, and nothing in the log said so.
 *
 * A step is a child process, or a PowerShell-bridge command, that starts and ends inside one tool call. Each call keeps a
 * count and total per step name; the day log gets a `step.slow` line for every step of 1 s or more, and `tool.done` carries
 * the call's totals when the call itself was slow. Only the program's name and the bridge command's name are kept, never
 * an argument: arguments carry typed text and window titles.
 *
 * Not covered: spawnSync / execFileSync (they block the event loop and bypass ChildProcess), CDP and the macOS helper.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { ChildProcess } from 'child_process';
import * as path from 'path';
import { logger } from './logger';
import { WAIT_STEP } from './telemetry-lists';

export const SLOW_STEP_MS = 1000;

export interface StepTotal { n: number; ms: number }

class CallSteps {
  ended = false;
  readonly totals = new Map<string, StepTotal>();
  constructor(readonly tool: string, readonly action?: string) {}

  add(name: string, ms: number): void {
    if (this.ended) return;  // it outlived the call (a bridge, the pill): not this call's step
    const t = this.totals.get(name) ?? { n: 0, ms: 0 };
    t.n++; t.ms += ms;
    this.totals.set(name, t);
    if (ms >= SLOW_STEP_MS) {
      logger.info('step.slow', { step: name, ms: Math.round(ms), tool: this.tool, ...(this.action ? { action: this.action } : {}) });
    }
  }

  summary(): Record<string, StepTotal> {
    return Object.fromEntries([...this.totals].map(([k, v]) => [k, { n: v.n, ms: Math.round(v.ms) }]));
  }
}

const current = new AsyncLocalStorage<CallSteps>();

export type Stepped<T> = { steps: Record<string, StepTotal> } & ({ ok: true; result: T } | { ok: false; error: unknown });

/** Run one tool call, collecting its steps. Never throws: a handler's throw comes back as `error`, with the steps it took. */
export async function withSteps<T>(tool: string, action: string | undefined, fn: () => Promise<T>): Promise<Stepped<T>> {
  const call = new CallSteps(tool, action);
  try {
    const result = await current.run(call, fn);
    call.ended = true;
    return { ok: true, result, steps: call.summary() };
  } catch (error) {
    call.ended = true;
    return { ok: false, error, steps: call.summary() };
  }
}

/** Time one step of the call running now. Outside a call it is not recorded. */
export async function timeStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const call = current.getStore();
  const t0 = performance.now();
  try { return await fn(); }
  finally { call?.add(name, performance.now() - t0); }
}

/** A deliberate wait (a pause for the user, `wait`, a wait_for): slow by design, so it is not counted as a slow call. */
export function timeWait<T>(fn: () => Promise<T>): Promise<T> { return timeStep(WAIT_STEP, fn); }

let watching = false;

/**
 * Every child process started during a tool call becomes a step, named after its program ("powershell", "python3",
 * "osascript"). One hook on ChildProcess.prototype.spawn: execFile, exec, spawn and fork all go through it.
 */
export function watchChildProcesses(): void {
  if (watching) return;
  watching = true;
  const proto = ChildProcess.prototype as unknown as { spawn: (this: ChildProcess, opts: { file?: string }) => unknown };
  const original = proto.spawn;
  proto.spawn = function (this: ChildProcess, opts: { file?: string }) {
    const call = current.getStore();
    if (call) {
      const name = path.basename(String(opts?.file ?? 'process')).replace(/\.exe$/i, '');
      const t0 = performance.now();
      let done = false;
      const end = () => { if (!done) { done = true; call.add(name, performance.now() - t0); } };
      // Not 'error': a listener there would swallow an error nobody else handles. 'close' follows a failed start.
      this.once('exit', end);
      this.once('close', end);
    }
    return original.call(this, opts);
  };
}
