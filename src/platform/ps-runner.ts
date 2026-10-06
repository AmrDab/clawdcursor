/**
 * PSRunner — Persistent PowerShell UIA bridge.
 *
 * Keeps one powershell.exe alive for the entire session.
 * UI Automation assemblies are loaded once at startup (~800ms).
 * Each subsequent command costs only the actual work — no 200-500ms spawn overhead.
 *
 * Protocol: newline-delimited JSON on stdin/stdout.
 *   Send: {"cmd":"invoke-element","processId":123,...}\n
 *   Recv: {"success":true,...}\n
 *
 * Commands are serialized (one at a time), queued if a call is in-flight.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
import { getPackageRoot } from '../paths';

const BRIDGE_SCRIPT = path.join(getPackageRoot(), 'scripts', 'ps-bridge.ps1');
const READY_TIMEOUT = 12000; // initial PS startup + assembly load
const CALL_TIMEOUT  = 20000; // per command (reduced from 45s — PSRunner is fast enough)
const MAX_QUEUE_SIZE = 100;  // backpressure — reject if queue exceeds this

interface PendingCall {
  command: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject:  (reason: unknown) => void;
  timer:   ReturnType<typeof setTimeout>;
}

export class PSRunner {
  private proc:         ChildProcessWithoutNullStreams | null = null;
  private rl:           readline.Interface | null = null;
  private ready  = false;
  private dead   = false;
  private queue: PendingCall[] = [];
  private current: PendingCall | null = null;
  private startPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().catch(err => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private _start(): Promise<void> {
    // Capture reject so the exit handler can settle the startup promise even
    // when the PS bridge exits before it outputs {"ready":true}.  Without
    // this, clearTimeout(readyTimer) in the exit handler would leave
    // startPromise as a zombie — never resolved, never rejected — causing
    // every subsequent `await this.startPromise` to hang forever.
    let startReject!: (err: Error) => void;

    return new Promise<void>((resolve, reject) => {
      startReject = reject;
      this.dead  = false;
      this.ready = false;

      const proc = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', BRIDGE_SCRIPT,
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proc = proc;

      this.rl = readline.createInterface({ input: proc.stdout! });

      const readyTimer = setTimeout(() => {
        reject(new Error('PSRunner: timed out waiting for bridge ready'));
      }, READY_TIMEOUT);

      this.rl.on('line', (line) => {
        // A bridge torn down after a command timeout may still answer later.
        // The protocol has no request ids — replies match calls by ORDER — so
        // a late line from a superseded process must never reach `current`.
        if (this.proc !== proc) return;
        line = line.trim();
        if (!line) return;

        let data: any;
        try { data = JSON.parse(line); } catch { return; }

        if (!this.ready) {
          if (data.ready) {
            this.ready = true;
            clearTimeout(readyTimer);
            console.log('[PSBridge] Ready — UIA assemblies loaded');
            resolve();
          } else if (data.error) {
            clearTimeout(readyTimer);
            reject(new Error(`PSRunner startup: ${data.error}`));
          }
          return;
        }

        // Deliver to in-flight call
        const call = this.current;
        this.current = null;
        if (call) {
          clearTimeout(call.timer);
          if (data.error) call.reject(new Error(data.error));
          else            call.resolve(data);
        }
        this._drain();
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) console.error(`[PSBridge] ${msg}`);
      });

      proc.on('exit', (code) => {
        if (this.proc !== proc) return; // superseded after a timeout — already torn down
        const pending = this.current ? [this.current, ...this.queue] : [...this.queue];
        this.dead  = true;
        this.ready = false;
        this.startPromise = null;
        clearTimeout(readyTimer);
        if (pending.length > 0) {
          console.error(`[PSBridge] Process exited (code ${code}) with ${pending.length} pending command(s) — will restart on next call`);
        }
        this.current = null;
        this.queue   = [];
        const err = new Error(`PSRunner exited (code ${code})`);
        // Reject the startup promise if the bridge never signalled ready.
        // Previously this was omitted: clearTimeout(readyTimer) disabled the
        // 12-second safety net but no rejection was issued, leaving
        // startPromise as an unsettled zombie.  Any awaiter (e.g.
        // getActiveWindow inside key_press) would then hang forever.
        startReject(err);
        for (const c of pending) { clearTimeout(c.timer); c.reject(err); }
      });
    });
  }

  async run(command: Record<string, unknown>): Promise<unknown> {
    // Auto-start or auto-restart
    if (!this.startPromise || this.dead) {
      if (this.dead) console.log('[PSBridge] Restarting crashed bridge process...');
      this.dead = false;
      await this.start();
    } else {
      await this.startPromise;
    }

    return new Promise((resolve, reject) => {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        reject(new Error(`PSRunner queue full (${MAX_QUEUE_SIZE}) — backpressure. Try again later.`));
        return;
      }
      const call: PendingCall = {
        command,
        resolve,
        reject,
        timer: setTimeout(() => {
          console.error(`[PSBridge] Command timeout after ${CALL_TIMEOUT}ms: ${String(command.cmd)}`);
          reject(new Error(`PSRunner timeout: ${String(command.cmd)}`));
          // The bridge is still busy with THIS command. Sending the next one
          // would make its late reply resolve the wrong call (no request ids),
          // so tear the process down; the next run() starts a fresh bridge.
          if (this.current === call) this._teardownAfterTimeout();
        }, CALL_TIMEOUT),
      };
      this.queue.push(call);
      this._drain();
    });
  }

  /** Kill a bridge whose in-flight command timed out. Queued commands are
   *  rejected (they would have run against a wedged bridge); the next run()
   *  auto-restarts. */
  private _teardownAfterTimeout(): void {
    const proc = this.proc;
    const queued = this.queue;
    this.current = null;
    this.queue   = [];
    this.proc    = null;
    this.rl?.close();
    this.rl      = null;
    this.ready   = false;
    this.dead    = true;
    this.startPromise = null;
    try { proc?.kill(); } catch {}
    const err = new Error('PSRunner bridge restarted after a command timeout');
    for (const c of queued) { clearTimeout(c.timer); c.reject(err); }
  }

  private _drain(): void {
    if (this.current || this.queue.length === 0 || !this.proc || this.dead) return;
    this.current = this.queue.shift()!;
    try {
      const line = JSON.stringify(this.current.command) + '\n';
      this.proc.stdin!.write(line);
    } catch (err) {
      const call = this.current;
      this.current = null;
      clearTimeout(call.timer);
      call.reject(err);
      this._drain();
    }
  }

  stop(): void {
    if (this.proc) {
      try { this.proc.stdin!.write('EXIT\n'); } catch {}
      setTimeout(() => { try { this.proc?.kill(); } catch {} }, 500);
    }
    this.ready = false;
    this.dead  = true;
  }
}

// Singleton — shared across all AccessibilityBridge instances
export const psRunner = new PSRunner();
