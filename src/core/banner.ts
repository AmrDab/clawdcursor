/**
 * Control banner — the on-screen "desktop control in progress" indicators:
 *   - the pill: topmost, never-focused; a small dotted orb, what the agent is doing
 *     ("Typing in Edge", sent as `ACTIVITY <text>` on its stdin), the time since
 *     it appeared, and a Stop button (a double-click anywhere stops too).
 *   - the outline: a click-through beam along the edge of the window the agent
 *     is working in (control.ts workingWindow), and nothing else: no fill,
 *     nothing on the rest of the screen, nothing at all while that window is not
 *     in front. It is the "border beam" of libraries.dev (#392): an amber beam
 *     going round the edge (the paused form is a steady blue ring; still where
 *     the OS reduces motion), with a soft glow reaching a little into the window.
 *     When the window is the desktop itself, it goes around the monitor. Spawned/
 *     killed in lockstep with the pill; `TARGET <handle> <pid>` on its stdin
 *     names the window, a bare `TARGET` none.
 * Both exit by themselves when their stdin closes: a host that hard-kills this
 * process must not leave them on screen.
 *
 * One contract, three drawers (same modes, same stdout lines):
 *   - Windows: scripts/banner.ps1 + scripts/window-outline.ps1 (WinForms)
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
 * roadblock, both overlays are respawned in their paused form — a BLUE outline and
 * a pill that says what to do, with Resume / End task. The pill prints
 * BANNER_RESUME / BANNER_END; showRunning() swaps back to the amber form. The card can add choice buttons
 * (CLAWD_BANNER_CHOICES, a JSON array of strings; a click prints BANNER_CHOICE <index>) and a text box
 * (CLAWD_BANNER_INPUT, JSON {placeholder?, multiline?}; sent as BANNER_REPLY like "Something else").
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
import { psOpts, powershellExe } from '../platform/ps-spawn';
import * as readline from 'readline';
import { getPackageRoot } from '../paths';
import { macOverlayBinary } from '../platform/mac-swift-binary';
import { setBeforePointerPress, setBeforeCapture, setOwnUiPids, setOnAgentInput, GUARDED_METHODS } from '../platform/pointer-guard';
import type { PauseAnswer, PauseInfo } from './pause-gate';
import { publishOverlayState, foreignOverlayState } from './overlay-state';
import { isStopped, workingIn, workingWindow } from './control';

const IDLE_HIDE_MS = 30_000;
/** How long the pill stays hidden around an agent's click, and how long to wait for it to be gone before clicking. */
const DODGE_MS = 1_500;
const DODGE_SETTLE_MS = 90;
const PAUSED_OUTLINE = '#3b82f6'; // blue — "your turn"

/**
 * Which form of the overlay to draw: running (default) or paused for the user. `activity` is what the running pill says
 * ("Typing in Edge"); `app` names the agent's window on the paused card.
 */
export interface OverlayMode { paused?: PauseInfo; activity?: string; app?: string }

// Where the OS gave no display name (Linux, an elevated process the bridge may not open): process names that say little.
const APP_NAMES: Record<string, string> = {
  msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', explorer: 'File Explorer', code: 'VS Code',
  winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook',
};
const oneLine = (s: string | undefined) => (s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);

/**
 * The app as a person knows it: its own display name when the OS gave one ("Designcenter NX" for ugraf.exe), as it is;
 * else from the process name: "msedge.exe" → "Edge", "notepad" → "Notepad". The one exception: explorer.exe calls itself
 * "Windows Explorer", and people know it as File Explorer.
 */
export function appLabel(processName: string | undefined, appName?: string): string | undefined {
  const base = oneLine((processName ?? '').replace(/\.(exe|app)$/i, ''));
  const own = base.toLowerCase() === 'explorer' ? '' : oneLine(appName);
  if (own) return own;
  if (!base || /^pid \d+$/.test(base)) return undefined;
  return APP_NAMES[base.toLowerCase()] ?? base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * "Typing in Edge" — what the running pill shows for a guarded method (pointer-guard.ts GUARDED_METHODS); undefined for
 * one it has no words for. Only window-checked input names the app: it read the window in front first. The others
 * (accessibility, the browser driver) only say what they do.
 */
export function activityLabel(method: string, processName?: string, appName?: string): string | undefined {
  const g = GUARDED_METHODS[method];
  if (!g?.activity) return undefined;
  const app = g.kind === 'input' ? appLabel(processName, appName) : undefined;
  return app ? `${g.activity} in ${app}` : g.activity;
}
type Spawner = (mode: OverlayMode) => ChildProcess;
/** The window the outline goes around: Windows and Linux find it by handle, macOS by its process. */
type WorkingWindow = { processId: number; handle?: number | string };

/** One line to an overlay's stdin; false when it has none or is gone. */
function send(child: ChildProcess | null, line: string): boolean {
  const stdin = child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return false;
  try { stdin.write(`${line}\n`); return true; } catch { return false; }
}

const ANSWER_LINES: Record<string, PauseAnswer> = { BANNER_RESUME: 'resume', BANNER_END: 'end' };

/**
 * "Something else" on the paused pill: `BANNER_REPLY <base64 of the UTF-8 text>` — base64 so a typed newline or
 * a line that happens to read "BANNER_END" can't be mistaken for another answer.
 */
export function parseReplyLine(line: string): string | null {
  const m = /^BANNER_REPLY ([A-Za-z0-9+/=]*)$/.exec(line);
  if (!m) return null;
  const text = Buffer.from(m[1], 'base64').toString('utf8').trim();
  return text || null;
}

/**
 * A choice button on the paused card: `BANNER_CHOICE <index>` (0-based, into the pause's `choices`). Only the index
 * crosses the pipe; the gate looks the text up itself, so the pill can never put words in the user's mouth.
 */
export function parseChoiceLine(line: string): number | null {
  const m = /^BANNER_CHOICE (\d{1,2})$/.exec(line);
  return m ? Number(m[1]) : null;
}

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
  // Always set, so a stray variable in our own environment never shows.
  CLAWD_BANNER_ACTIVITY: mode.activity ?? '',
  CLAWD_BANNER_APP: mode.app ?? '',
  // The message is model-written: say so on screen, so injected text can't pose
  // as clawdcursor's own instructions. The drawer plays a short system sound when
  // the paused pill appears, so a user who isn't looking hears it's their turn
  // (#237); CLAWD_PAUSE_SOUND=0 turns it off.
  ...(mode.paused ? {
    CLAWD_BANNER_MODE: 'paused',
    CLAWD_BANNER_MESSAGE: `The agent says: ${mode.paused.message}`,
    CLAWD_PAUSE_SOUND: process.env.CLAWD_PAUSE_SOUND === '0' ? '0' : '1',
    // The card: JSON, so any text survives (always set, so a stray variable in our own environment never shows).
    CLAWD_BANNER_CHOICES: mode.paused.choices ? JSON.stringify(mode.paused.choices) : '',
    CLAWD_BANNER_INPUT: mode.paused.input ? JSON.stringify(mode.paused.input) : '',
  } : {}),
});

/** The mode in argv as well as the env, so a process listing shows a paused
 *  pill apart from the running one (#237). The drawers read the env. */
export const pillArgs = (mode: OverlayMode): string[] => (mode.paused ? ['--paused'] : []);

/** What the overlay shows right now (the control banner state). */
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

/** The outline drawer's flags: the paused form is blue and still (#392). */
export function outlineFlags(paused: boolean, platform: NodeJS.Platform): string[] {
  if (!paused) return [];
  return platform === 'win32' ? ['-Color', PAUSED_OUTLINE, '-Paused'] : ['--color', PAUSED_OUTLINE, '--paused'];
}

class ControlBanner {
  private child: ChildProcess | null = null;        // the pill (carries BANNER_STOP)
  private outlineChild: ChildProcess | null = null; // the border around the agent's window
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pinned = false;
  private enabled = OVERLAY_OS.has(process.platform) && process.env.CLAWD_NO_BANNER !== '1';
  private ready: () => boolean = overlayReady;
  private onStopRequested: (() => void) | undefined;
  private paused: PauseInfo | null = null;
  private onAnswer: ((a: PauseAnswer, reply?: string, choice?: number) => void) | undefined;
  private onRefocus: ((pid?: number) => void) | undefined;
  private spawner: Spawner = (mode) => {
    // stdin carries `HIDE <ms>` (dodge) to the pill; stdout carries its answers.
    const stdio: ['pipe', 'pipe', 'ignore'] = ['pipe', 'pipe', 'ignore'];
    if (process.platform === 'darwin') {
      return spawn(macOverlayBinary.cached(macScript())!, ['pill', ...pillArgs(mode)], { stdio, env: overlayEnv(mode) });
    }
    if (process.platform === 'linux') {
      return spawn('python3', [linuxScript(), 'pill', ...pillArgs(mode)], { stdio, env: overlayEnv(mode, { GDK_BACKEND: 'x11' }) });
    }
    const script = path.join(getPackageRoot(), 'scripts', 'banner.ps1');
    return spawn(powershellExe(), psArgs(script, pillArgs(mode)),
      // windowsHide: suppress the console/csc.exe compile flash so the pill spawn
      // can't briefly steal foreground from the app the agent is driving.
      psOpts({ stdio, windowsHide: true, env: overlayEnv(mode) }));
  };
  private outlineSpawner: Spawner = (mode) => {
    const stdio: ['pipe', 'pipe', 'ignore'] = ['pipe', 'pipe', 'ignore']; // stdin names the window; stdout: OUTLINE_CAPTURABLE
    const flags = outlineFlags(!!mode.paused, process.platform);
    if (process.platform === 'darwin') {
      return spawn(macOverlayBinary.cached(macScript())!, ['outline', ...flags], { stdio });
    }
    if (process.platform === 'linux') {
      return spawn('python3', [linuxScript(), 'outline', ...flags], { stdio, env: { ...process.env, GDK_BACKEND: 'x11' } });
    }
    const script = path.join(getPackageRoot(), 'scripts', 'window-outline.ps1');
    return spawn(powershellExe(), psArgs(script, flags),
      psOpts({ stdio, windowsHide: true }));
  };

  /**
   * Hide the pill for a moment so an agent's click under it reaches the app instead (it comes back by itself after `ms`).
   * The pill is a real window at the top centre — where browsers keep their tab strip and address bar. Called before every
   * synthetic mouse press, drag or scroll (pointer-guard.ts). The outline is click-through and stays — except
   * `forCapture`, where the OS cannot keep a window out of a capture: then it steps aside too.
   */
  async dodge(ms = DODGE_MS, forCapture = false): Promise<void> {
    const pill = send(this.child, `HIDE ${ms}`);
    const outline = forCapture && send(this.outlineChild, `HIDE ${ms}`);
    if (pill || outline) await new Promise(r => setTimeout(r, DODGE_SETTLE_MS));
  }

  // The Windows and macOS overlays keep themselves out of captures (WDA_EXCLUDEFROMCAPTURE, sharingType none + the
  // helper's filter). Linux cannot, and Windows 10 before 2004 cannot either: there the outline says OUTLINE_CAPTURABLE.
  private capturable = process.platform === 'linux';

  /** Before a screenshot or OCR: where the overlay would be in the capture, the pill and the outline step aside. */
  async beforeCapture(): Promise<void> {
    if (this.capturable) await this.dodge(DODGE_MS, true);
  }

  private working: WorkingWindow | undefined;
  private target = ''; // the last line the live outline was sent

  /** The window the agent works in now: the outline moves to it, or draws nothing when there is none. */
  setWorkingWindow(w: WorkingWindow | undefined): void {
    this.working = w;
    const line = w ? `TARGET ${Number(w.handle) || 0} ${w.processId}` : 'TARGET';
    if (line === this.target) return;
    if (send(this.outlineChild, line)) this.target = line;
  }

  private activity = '';

  /** What the agent is doing now ("Typing in Edge"): the running pill shows it; a new pill starts with it. */
  setActivity(label: string): void {
    const line = label.replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    if (!line || line === this.activity) return;
    this.activity = line;
    if (!this.paused) send(this.child, `ACTIVITY ${line}`);
  }

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

  /** Pids of the live overlay processes (pill, outline) — the user's controls, never a target (own-ui-guard.ts). */
  overlayPids(): number[] {
    return [this.child?.pid, this.outlineChild?.pid].filter((p): p is number => typeof p === 'number');
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
   * Switch to the paused form (blue outline + instruction + Resume / End task) and
   * keep it up until showRunning(), regardless of pin or idle timers.
   */
  showPaused(info: PauseInfo, onAnswer: (a: PauseAnswer, reply?: string, choice?: number) => void, onRefocus?: (pid?: number) => void): void {
    if (!this.enabled) return;
    this.paused = info;
    this.activity = ''; // after the answer the pill says "Working" until the agent's next input, not what it did before
    this.onAnswer = onAnswer;
    this.onRefocus = onRefocus;
    this.clearIdleTimer();
    this.killChildren();
    this.show();
  }

  /** Leave the paused form: back to the amber running overlay (or hidden). */
  showRunning(): void {
    if (!this.paused) return;
    this.paused = null;
    this.onAnswer = undefined;
    this.onRefocus = undefined;
    this.killChildren();
    if (this.pinned) this.show();
    else this.touch(); // external-agent session: running form, then the idle hide
  }

  /** Show and keep shown until unpin() — the autonomous-task lifecycle. */
  pin(): void {
    if (!this.enabled || isStopped()) return;
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
    if (!this.enabled || isStopped()) return; // after a stop, a refused call must not bring the pill back
    this.show();
    if (this.pinned || this.paused) return; // task lifecycle / pending pause owns visibility
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // A call still in flight (a batch inside a 30 s wait) has control: hiding now told the user it was done (#294).
      if (this.holds > 0) { this.idleWhileHeld = true; return; }
      if (!this.pinned && !this.paused) this.forceHide();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private holds = 0;
  private idleWhileHeld = false;

  /** For the length of a tool call: the pill, if it is up, stays up until the returned release runs. Shows nothing by itself. */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0 && this.idleWhileHeld) {
        this.idleWhileHeld = false;
        this.touch(); // the idle countdown starts when control is really released
      }
    };
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
    this.spawnOutline();
  }

  /** The "control in progress" pill — also the BANNER_STOP / kill-switch source. */
  private spawnPill(): void {
    if (this.child) return;
    let child: ChildProcess;
    let forPause: number | undefined;
    try {
      child = this.spawner(this.paused
        ? { paused: this.paused, app: appLabel(workingIn()?.processName, workingIn()?.appName) }
        : { activity: this.activity || undefined });
      // Which pause this pill answers. Its answer counts while that pause is the
      // current one, even if the process already exited (stdout can drain after
      // 'exit'); a pill from an earlier pause can never answer a newer one.
      forPause = this.paused?.id;
    } catch {
      return; // cosmetic feature — never let it break control
    }
    this.child = child;
    this.publish();
    // A write to a pill that already exited is EPIPE on this stream — never an uncaught error.
    child.stdin?.on?.('error', () => { /* the pill is gone */ });
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', line => {
        const msg = line.trim();
        try {
          if (msg === 'BANNER_STOP') { this.onStopRequested?.(); return; }
          if (forPause === undefined || this.paused?.id !== forPause) return;
          // Esc in the reply box: give the keyboard back to the user's window (the pill names its app when it knows).
          const refocus = /^BANNER_REFOCUS(?: (\d+))?$/.exec(msg);
          if (refocus) { this.onRefocus?.(refocus[1] ? Number(refocus[1]) : undefined); return; }
          const reply = parseReplyLine(msg);
          const choice = parseChoiceLine(msg);
          if (reply) this.onAnswer?.('reply', reply);
          else if (choice !== null) this.onAnswer?.('choice', undefined, choice);
          else if (ANSWER_LINES[msg]) this.onAnswer?.(ANSWER_LINES[msg]);
        } catch { /* never throw into the rl loop */ }
      });
    }
    child.on('error', () => { if (this.child === child) { this.child = null; this.publish(); } });
    // If the pill dies, take the outline down with it so the two never desync
    // into a half-on state (outline without the stop affordance).
    child.on('exit', () => { if (this.child === child) { this.child = null; this.killOutline(); } });
  }

  /** The border around the agent's window — pure visual, click-through, no stdout. It starts with no window. */
  private spawnOutline(): void {
    if (this.outlineChild) return;
    let child: ChildProcess;
    try {
      child = this.outlineSpawner({ paused: this.paused ?? undefined });
    } catch {
      return; // cosmetic — never let it break control
    }
    this.outlineChild = child;
    this.target = '';
    this.publish();
    child.stdin?.on?.('error', () => { /* the outline is gone */ });
    child.stdout?.on?.('data', d => { if (String(d).includes('OUTLINE_CAPTURABLE')) this.capturable = true; });
    child.on('error', () => { if (this.outlineChild === child) { this.outlineChild = null; this.publish(); } });
    child.on('exit', () => { if (this.outlineChild === child) { this.outlineChild = null; this.publish(); } });
    if (this.working) this.setWorkingWindow(this.working);
  }

  // Neither overlay may outlive its owner — an orphaned "control in progress"
  // pill or outline after the daemon stopped would be a lie on screen. kill() is a
  // sync syscall, safe inside an 'exit' handler.
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on('exit', () => {
      try { this.child?.kill(); } catch { /* gone */ }
      try { this.outlineChild?.kill(); } catch { /* gone */ }
      publishOverlayState({ pids: [], paused: false });
    });
  }

  private killOutline(): void {
    const o = this.outlineChild;
    this.outlineChild = null;
    if (o) {
      try { o.kill(); } catch { /* already gone */ }
    }
    this.publish();
  }

  /** Tell the other clawdcursor processes what is on screen (overlay-state.ts). */
  private publish(): void {
    publishOverlayState({ pids: this.overlayPids(), paused: this.paused !== null });
  }

  private killChildren(): void {
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.kill(); } catch { /* already gone */ }
    }
    this.killOutline();
  }

  private forceHide(): void {
    this.clearIdleTimer();
    this.activity = ''; // the next session's pill must not open with this one's last action
    this.working = undefined; // ...nor its outline on this one's window
    this.paused = null;
    this.onAnswer = undefined;
    this.onRefocus = undefined;
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
  __setOutlineSpawnerForTests(s: Spawner): void { this.outlineSpawner = s; }
  __setPlatformEnabledForTests(v: boolean): void { this.enabled = v; this.ready = () => v; }
  __resetForTests(): void {
    this.forceHide();
    this.pinned = false;
    this.onStopRequested = undefined;
    this.capturable = process.platform === 'linux';
    this.holds = 0;
    this.idleWhileHeld = false;
  }
}

/** Singleton — one banner per process (daemon or stdio MCP server). */
export const controlBanner = new ControlBanner();

// Every synthetic mouse press, drag or scroll first moves the pill out of the way (pointer-guard.ts).
setBeforePointerPress(() => controlBanner.dodge());
setOwnUiPids(() => [...controlBanner.overlayPids(), ...foreignOverlayState().pids]);
// Every guarded input says what it does: the running pill reads "Typing in Edge", not just "in progress".
setOnAgentInput(method => {
  const label = activityLabel(method, workingIn()?.processName, workingIn()?.appName);
  if (label) controlBanner.setActivity(label);
  controlBanner.setWorkingWindow(workingWindow());
});
// Captures: the overlay is never in one — it excludes itself where the OS can, and steps aside where it cannot.
setBeforeCapture(() => controlBanner.beforeCapture());
