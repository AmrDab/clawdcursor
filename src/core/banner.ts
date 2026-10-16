/**
 * Control banner — the on-screen "desktop control in progress" indicators:
 *   - the pill: topmost, never-focused, with a blinking red dot; carries the
 *     double-click → stop affordance.
 *   - the glow: a click-through amber glow that pulses on every edge of every
 *     display. Pure ambient signal; spawned/killed in lockstep with the pill so
 *     the two are always in sync. Opt out via CLAWD_NO_GLOW=1.
 *
 * One contract, three drawers (same modes, same stdout lines):
 *   - Windows: scripts/banner.ps1 + scripts/edge-glow.ps1 (WinForms)
 *   - macOS:   scripts/mac/overlay.swift, compiled once into ~/.clawdcursor/bin
 *   - Linux:   scripts/linux/overlay.py (GTK 3; X11, or Wayland via XWayland)
 * Where the drawer can't run (no swiftc, no python3-gi, no display) the overlay
 * is unavailable: nothing is drawn and pauses fall back to failing fast.
 *
 * Transparency contract: whenever an agent is actively driving this desktop,
 * a human at the machine sees it — and can kill it (double-click → the parent
 * runs the `clawdcursor stop` flow). Two lifecycles feed it:
 *
 * Paused mode (pause-gate.ts): when an agent hands the desktop to the user at a
 * roadblock, both overlays are respawned in their paused form — a BLUE glow and
 * a pill that says what to do, with Resume / End task. The pill prints
 * BANNER_RESUME / BANNER_END; showRunning() swaps back to the amber form.
 *
 *   - pin()/unpin(): the autonomous task loop pins the banner for the whole
 *     task (agent.executeTask). A pinned banner ignores idle timers.
 *   - touch(): every consequential (safetyTier ≥ 1) MCP tool call pokes the
 *     banner; it shows on the first poke and auto-hides after IDLE_HIDE_MS of
 *     inactivity. This covers EXTERNAL agents (editor-hosted over stdio or
 *     HTTP /mcp) where there is no task boundary to hook.
 *
 * Disable via `--no-banner` or CLAWD_NO_BANNER=1.
 */

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { getPackageRoot } from '../paths';
import { macOverlayBinary } from '../platform/mac-ocr-binary';
import type { PauseAnswer, PauseInfo } from './pause-gate';

const IDLE_HIDE_MS = 30_000;
const PAUSED_GLOW = '#3b82f6'; // blue — "your turn"

/** Which form of the overlay to draw: running (default) or paused for the user. */
export interface OverlayMode { paused?: PauseInfo }
type Spawner = (mode: OverlayMode) => ChildProcess;

const ANSWER_LINES: Record<string, PauseAnswer> = { BANNER_RESUME: 'resume', BANNER_END: 'end' };

const psArgs = (script: string, extra: string[] = []) =>
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...extra];

const OVERLAY_OS = new Set(['win32', 'darwin', 'linux']);
const macScript = () => path.join(getPackageRoot(), 'scripts', 'mac', 'overlay.swift');
const linuxScript = () => path.join(getPackageRoot(), 'scripts', 'linux', 'overlay.py');

// The paused text goes through the environment, not argv — no quoting of
// arbitrary model-written text into a command line.
export const overlayEnv = (mode: OverlayMode, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  ...extra,
  // The message is model-written: say so on screen, so injected text can't pose
  // as clawdcursor's own instructions. The drawer plays a short system sound when
  // the paused pill appears, so a user who isn't looking hears it's their turn
  // (#237); CLAWD_PAUSE_SOUND=0 turns it off.
  ...(mode.paused ? {
    CLAWD_BANNER_MODE: 'paused',
    CLAWD_BANNER_MESSAGE: `The agent says: ${mode.paused.message}`,
    CLAWD_PAUSE_SOUND: process.env.CLAWD_PAUSE_SOUND === '0' ? '0' : '1',
  } : {}),
});

/** The mode in argv as well as the env, so a process listing shows a paused
 *  pill apart from the running one (#237). The drawers read the env. */
export const pillArgs = (mode: OverlayMode): string[] => (mode.paused ? ['--paused'] : []);

/** What the overlay shows right now (agent_status reports it). */
export type OverlayState =
  | { mode: 'hidden' }
  | { mode: 'running' }
  | { mode: 'paused'; message: string; since: number };

let linuxReady: boolean | null = null;

/**
 * Can this machine draw the overlay right now? Windows always; macOS once the
 * Swift drawer is compiled (the compile starts here, in the background);
 * Linux when python3 + GTK can open the X display (probed once).
 */
function overlayReady(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') {
    if (macOverlayBinary.cached(macScript())) return true;
    void macOverlayBinary.compile(macScript());
    return false;
  }
  if (process.platform === 'linux') {
    if (linuxReady === null) {
      try {
        linuxReady = !!process.env.DISPLAY && execFileSync('python3', [linuxScript(), '--probe'], {
          encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, GDK_BACKEND: 'x11' },
        }).trim() === 'ok';
      } catch {
        linuxReady = false;
      }
    }
    return linuxReady;
  }
  return false;
}

class ControlBanner {
  private child: ChildProcess | null = null;        // the pill (carries BANNER_STOP)
  private glowChild: ChildProcess | null = null;    // the screen-edge glow overlay
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pinned = false;
  private enabled = OVERLAY_OS.has(process.platform) && process.env.CLAWD_NO_BANNER !== '1';
  private ready: () => boolean = overlayReady;
  // The edge glow rides the same lifecycle as the pill but is independently
  // opt-out-able (some users find ambient pulsing distracting) without losing
  // the pill's double-click-to-stop affordance.
  private glowEnabled = process.env.CLAWD_NO_GLOW !== '1';
  private onStopRequested: (() => void) | undefined;
  private paused: PauseInfo | null = null;
  private onAnswer: ((a: PauseAnswer) => void) | undefined;
  private spawner: Spawner = (mode) => {
    const stdio: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];
    if (process.platform === 'darwin') {
      return spawn(macOverlayBinary.cached(macScript())!, ['pill', ...pillArgs(mode)], { stdio, env: overlayEnv(mode) });
    }
    if (process.platform === 'linux') {
      return spawn('python3', [linuxScript(), 'pill', ...pillArgs(mode)], { stdio, env: overlayEnv(mode, { GDK_BACKEND: 'x11' }) });
    }
    const script = path.join(getPackageRoot(), 'scripts', 'banner.ps1');
    return spawn('powershell.exe', psArgs(script, pillArgs(mode)),
      // windowsHide: suppress the console/csc.exe compile flash so the pill spawn
      // can't briefly steal foreground from the app the agent is driving.
      { stdio, windowsHide: true, env: overlayEnv(mode) });
  };
  private glowSpawner: Spawner = (mode) => {
    const stdio: ['ignore', 'ignore', 'ignore'] = ['ignore', 'ignore', 'ignore']; // click-through visual only — no stdout contract
    const color = mode.paused ? ['--color', PAUSED_GLOW] : [];
    if (process.platform === 'darwin') {
      return spawn(macOverlayBinary.cached(macScript())!, ['glow', ...color], { stdio });
    }
    if (process.platform === 'linux') {
      return spawn('python3', [linuxScript(), 'glow', ...color], { stdio, env: { ...process.env, GDK_BACKEND: 'x11' } });
    }
    const script = path.join(getPackageRoot(), 'scripts', 'edge-glow.ps1');
    return spawn('powershell.exe', psArgs(script, mode.paused ? ['-Color', PAUSED_GLOW] : []),
      { stdio, windowsHide: true });
  };

  /** Wire the double-click → stop callback (the `clawdcursor stop` flow). */
  configure(opts: { onStopRequested?: () => void }): void {
    this.onStopRequested = opts.onStopRequested;
    if (this.enabled) this.ready(); // start the macOS compile / Linux probe before the first tool call
  }

  /** Hard enable/disable (CLI --no-banner / config). Disabling hides immediately. */
  setEnabled(v: boolean): void {
    this.enabled = v && OVERLAY_OS.has(process.platform) && process.env.CLAWD_NO_BANNER !== '1';
    if (!this.enabled) this.forceHide();
  }

  isVisible(): boolean {
    return this.child !== null;
  }

  /** The overlay's current mode; a pending pause is 'paused' with its message. */
  state(): OverlayState {
    if (this.paused) return { mode: 'paused', message: this.paused.message, since: this.paused.since };
    return this.child ? { mode: 'running' } : { mode: 'hidden' };
  }

  /** True when the overlay can be drawn here — the pause gate's precondition. */
  canShow(): boolean {
    return this.enabled && this.ready();
  }

  /**
   * Switch to the paused form (blue glow + instruction + Resume / End task) and
   * keep it up until showRunning(), regardless of pin or idle timers.
   */
  showPaused(info: PauseInfo, onAnswer: (a: PauseAnswer) => void): void {
    if (!this.enabled) return;
    this.paused = info;
    this.onAnswer = onAnswer;
    this.clearIdleTimer();
    this.killChildren();
    this.show();
  }

  /** Leave the paused form: back to the amber running overlay (or hidden). */
  showRunning(): void {
    if (!this.paused) return;
    this.paused = null;
    this.onAnswer = undefined;
    this.killChildren();
    if (this.pinned) this.show();
    else this.touch(); // external-agent session: running form, then the idle hide
  }

  /** Show and keep shown until unpin() — the autonomous-task lifecycle. */
  pin(): void {
    if (!this.enabled) return;
    this.pinned = true;
    this.clearIdleTimer();
    this.show();
  }

  /** Release the task pin; hides unless tool activity re-touches it. */
  unpin(): void {
    this.pinned = false;
    if (!this.paused) this.forceHide(); // a pending pause keeps its prompt up
  }

  /**
   * Activity poke from a consequential tool call: show now, auto-hide after
   * IDLE_HIDE_MS without further pokes. No-op on the timer while pinned.
   */
  touch(idleMs: number = IDLE_HIDE_MS): void {
    if (!this.enabled) return;
    this.show();
    if (this.pinned || this.paused) return; // task lifecycle / pending pause owns visibility
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pinned && !this.paused) this.forceHide();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private exitHookInstalled = false;

  private show(): void {
    if (!this.canShow()) {
      // macOS: the drawer is still compiling (first run after install). Show it
      // as soon as it is ready, if the overlay is still wanted by then.
      if (this.enabled && process.platform === 'darwin') {
        void macOverlayBinary.compile(macScript()).then(bin => {
          if (bin && (this.pinned || this.paused || this.idleTimer)) this.show();
        });
      }
      return;
    }
    this.installExitHook();
    this.spawnPill();
    this.spawnGlow();
  }

  /** The "control in progress" pill — also the BANNER_STOP / kill-switch source. */
  private spawnPill(): void {
    if (this.child) return;
    let child: ChildProcess;
    let forPause: number | undefined;
    try {
      child = this.spawner({ paused: this.paused ?? undefined });
      // Which pause this pill answers. Its answer counts while that pause is the
      // current one, even if the process already exited (stdout can drain after
      // 'exit'); a pill from an earlier pause can never answer a newer one.
      forPause = this.paused?.id;
    } catch {
      return; // cosmetic feature — never let it break control
    }
    this.child = child;
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', line => {
        const msg = line.trim();
        try {
          if (msg === 'BANNER_STOP') this.onStopRequested?.();
          else if (ANSWER_LINES[msg] && forPause !== undefined && this.paused?.id === forPause) this.onAnswer?.(ANSWER_LINES[msg]);
        } catch { /* never throw into the rl loop */ }
      });
    }
    child.on('error', () => { if (this.child === child) this.child = null; });
    // If the pill dies, take the glow down with it so the two never desync
    // into a half-on state (glow without the stop affordance).
    child.on('exit', () => { if (this.child === child) { this.child = null; this.killGlow(); } });
  }

  /** The ambient screen-edge glow — pure visual, click-through, no stdout. */
  private spawnGlow(): void {
    if (!this.glowEnabled || this.glowChild) return;
    let child: ChildProcess;
    try {
      child = this.glowSpawner({ paused: this.paused ?? undefined });
    } catch {
      return; // cosmetic — never let it break control
    }
    this.glowChild = child;
    child.on('error', () => { if (this.glowChild === child) this.glowChild = null; });
    child.on('exit', () => { if (this.glowChild === child) this.glowChild = null; });
  }

  // Neither overlay may outlive its owner — an orphaned "control in progress"
  // pill or glow after the daemon stopped would be a lie on screen. kill() is a
  // sync syscall, safe inside an 'exit' handler.
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on('exit', () => {
      try { this.child?.kill(); } catch { /* gone */ }
      try { this.glowChild?.kill(); } catch { /* gone */ }
    });
  }

  private killGlow(): void {
    const g = this.glowChild;
    this.glowChild = null;
    if (g) {
      try { g.kill(); } catch { /* already gone */ }
    }
  }

  private killChildren(): void {
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.kill(); } catch { /* already gone */ }
    }
    this.killGlow();
  }

  private forceHide(): void {
    this.clearIdleTimer();
    this.paused = null;
    this.onAnswer = undefined;
    this.killChildren();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ── test hooks ──
  __setSpawnerForTests(s: Spawner): void { this.spawner = s; }
  __setGlowSpawnerForTests(s: Spawner): void { this.glowSpawner = s; }
  __setPlatformEnabledForTests(v: boolean): void { this.enabled = v; this.ready = () => v; }
  __setGlowEnabledForTests(v: boolean): void { this.glowEnabled = v; }
  __resetForTests(): void {
    this.forceHide();
    this.pinned = false;
    this.glowEnabled = true;
    this.onStopRequested = undefined;
  }
}

/** Singleton — one banner per process (daemon or stdio MCP server). */
export const controlBanner = new ControlBanner();
