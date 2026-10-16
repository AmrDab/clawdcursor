/**
 * What every macOS keystroke path shares: who owns the keyboard right now, and how a keystroke program reaches osascript.
 *
 * There are two macOS keyboards in clawdcursor — `MacOSAdapter` (the platform adapter the built-in agent and a few tools use)
 * and `NativeDesktop` (`ctx.desktop`, which the MCP tools `type_text` / `key_press` / `smart_type` use). The "does a system
 * dialog own the keyboard?" guard (B11) was written into the first only, so the route Claude Code actually takes never asked.
 * Both now ask this one class.
 */
import { execFile } from 'child_process';
import { logger } from '../core/observability/logger';
import { classifyKeyboardOwner, describeKeyboardOwner, type MacAx } from './mac-ax';

/** How long a "the keyboard is free" probe is trusted — a burst of keystrokes probes once. */
const PROBE_TTL_MS = 250;
/** A modal dialog of another app is logged once per this long, not once per probe. */
const WARN_EVERY_MS = 10_000;

/** The Escape key on its own. (`cmd+Escape` and the like are other keys.) */
export const isBareEscape = (combo: string | undefined): boolean => combo !== undefined && /^(escape|esc)$/i.test(String(combo).trim());

/**
 * Run an AppleScript program. The program goes to osascript on STDIN, not argv: argv is readable by every process on the Mac
 * for as long as osascript runs, and a `keystroke` program contains the text being typed.
 */
export function runAppleScript(script: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('osascript', [], { timeout: timeoutMs }, err => (err ? reject(err) : resolve()));
    // osascript may exit (or be killed at the timeout) before it has read everything: a closed pipe is not our error.
    child?.stdin?.on('error', () => { /* EPIPE */ });
    child?.stdin?.end(script);
  });
}

export interface KeyboardOwnerCheck {
  /** Something other than the app being driven owns the keyboard: the error to throw, worded for an agent. */
  error: Error | null;
  /** A modal dialog of some other app has it. Keys are sent (launchers and password managers are exactly that); say so. */
  warning?: string;
}

/**
 * Refuses to send keys while something other than the app being driven owns the keyboard. System Events names the last
 * ORDINARY app "frontmost", so a TCC prompt, an auth dialog or the lock screen takes the keys while every "typed OK" still
 * reads as success — and a stray Return can press Allow. NSWorkspace sees them. A failed probe never blocks input.
 */
export class MacKeyboardGuard {
  private checkedAt = 0;
  private cachedWarning: string | undefined;
  private warned: { text: string; at: number } | null = null;

  constructor(private readonly ax: Pick<MacAx, 'frontmost'>) {}

  /** Probe once, without throwing. `strict` is for clawdcursor's own plumbing: a modal dialog of any app is then a refusal. */
  async owner(opts: { strict?: boolean } = {}): Promise<KeyboardOwnerCheck> {
    if (process.env.CLAWD_NO_MAC_AX === '1') return { error: null };
    try {
      const owner = classifyKeyboardOwner(await this.ax.frontmost());
      if (owner.kind !== 'app') return { error: new Error(describeKeyboardOwner(owner)) };
      if (!owner.warning) return { error: null };
      // An agent may type into a modal dialog of another app when it asks to; the Spotlight launch fallback's own keystrokes —
      // and a Return that presses the dialog's default button — must not.
      if (opts.strict) return { error: new Error(owner.warning) };
      this.logOnce(owner.warning);
      return { error: null, warning: owner.warning };
    } catch {
      return { error: null };
    }
  }

  /**
   * Throws when typing now would go to something other than the app being driven. Returns the warning, if any. A bare Escape is
   * never checked: it cancels, so an agent needs it to dismiss the very dialog that is in the way (the Escape that comes with
   * a permission prompt is "Don't Allow", which macOS remembers — but it can never grant anything).
   */
  async assert(combo?: string, opts: { strict?: boolean } = {}): Promise<{ warning?: string }> {
    if (isBareEscape(combo)) return {};
    // Trust a clean probe briefly so a burst of keystrokes costs one lookup; a blocked result is never cached — the dialog may
    // be gone a moment later. A strict check never trusts the cache: a probe that merely warned was cached too.
    if (!opts.strict && Date.now() - this.checkedAt < PROBE_TTL_MS) return this.cachedWarning ? { warning: this.cachedWarning } : {};
    const { error, warning } = await this.owner(opts);
    if (error) throw error;
    this.checkedAt = Date.now();
    this.cachedWarning = warning;
    return warning ? { warning } : {};
  }

  private logOnce(text: string): void {
    const now = Date.now();
    if (this.warned?.text === text && now - this.warned.at < WARN_EVERY_MS) return;
    this.warned = { text, at: now };
    logger.warn('keyboard.modal-dialog', { warning: text });
  }
}
