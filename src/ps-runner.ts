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

const BRIDGE_SCRIPT = path.join(__dirname, '..', 'scripts', 'ps-bridge.ps1');
const READY_TIMEOUT = 12000; // initial PS startup + assembly load
const CALL_TIMEOUT  = 45000; // per command (complex web pages need more time)
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
    return new Promise((resolve, reject) => {
      this.dead  = false;
      this.ready = false;

      this.proc = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', BRIDGE_SCRIPT,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      this.rl = readline.createInterface({ input: this.proc.stdout! });

      const readyTimer = setTimeout(() => {
        reject(new Error('PSRunner: timed out waiting for bridge ready'));
      }, READY_TIMEOUT);

      this.rl.on('line', (line) => {
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

      this.proc.stderr!.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) console.error(`[PSBridge] ${msg}`);
      });

      this.proc.on('exit', (code) => {
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
          if (this.current === call) this.current = null;
          console.error(`[PSBridge] Command timeout after ${CALL_TIMEOUT}ms: ${String(command.cmd)}`);
          reject(new Error(`PSRunner timeout: ${String(command.cmd)}`));
          this._drain();
        }, CALL_TIMEOUT),
      };
      this.queue.push(call);
      this._drain();
    });
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
