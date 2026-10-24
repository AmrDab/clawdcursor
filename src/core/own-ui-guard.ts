/**
 * clawdcursor's own on-screen controls (the pill, its pause prompt, the edge glow) are the USER's: the agent never reads,
 * presses or types into them. Found live on macOS (2026-10-24): `accessibility read_tree {processId:<overlay pid>}` returned
 * the pill's tree, the pause prompt's Resume button was findable and invokable by name — faking the user's answer — and
 * nothing stopped an agent from acting while a pause waited.
 *
 * One check, called before every tool runs (MCP wrapper, both batch executors, the agent loop):
 *  - a call aimed at an overlay process (by pid, or by the overlay's process name) is refused;
 *  - while a pause is pending, EVERY call is refused except the few that wait on, end or report it. Deny by default: the
 *    pause prompt's buttons and reply box exist only while paused, and the reply box takes the keyboard and the foreground
 *    then (on every OS), so any read with no target, any key, click or script could reach it. Nothing else needs doing
 *    while the user has the screen.
 */
import { controlBanner } from './banner';
import { pauseGate } from './pause-gate';
import { foreignOverlayState } from './overlay-state';

const PID_ARGS = ['processId', 'pid', 'process_id'];
const NAME_ARGS = ['processName', 'process_name', 'app', 'appName'];
/** The macOS overlay's process name (cached as clawd-overlay-<hash>). On Windows and Linux it runs under a shared interpreter. */
const OVERLAY_NAME = /^clawd-overlay(-[0-9a-f]+)?$/i;

/** Calls that wait on, end or report a pause (compact `tool:action`, or the granular / agent tool name). `resume` is recorded as
 * unverified — it cannot pass for the user's answer. */
const PAUSE_SAFE = new Set([
  'system:pause_for_user', 'pause_for_user', 'ask_user',
  'task:status', 'agent_status', 'task:abort', 'abort_task', 'task:resume', 'resume_task',
  'done', 'give_up',
  // Re-calling a paused delegated task with the same text is how a caller keeps waiting (orchestration.ts); it never
  // starts a new run while a pause is up.
  'task:run', 'delegate_to_agent',
  // Waiting and reporting touch nothing on screen.
  'computer:wait', 'wait', 'system:report',
]);

export function isPauseSafeCall(toolName: string, action?: string): boolean {
  return PAUSE_SAFE.has(action ? `${toolName}:${action}` : toolName) || PAUSE_SAFE.has(toolName);
}

const OWN = (what: string) => `${what} is clawdcursor's own on-screen control — it is the user's, never read or acted on. Target the app instead.`;

export function ownUiRefusal(args: Record<string, unknown> | undefined, pauseSafe: boolean): string | null {
  // This process's overlay, and every other live clawdcursor process's (a daemon's pause is the user's to a stdio server too).
  const foreign = foreignOverlayState();
  const pids = [...controlBanner.overlayPids(), ...foreign.pids];
  for (const k of PID_ARGS) {
    const v = Number(args?.[k]);
    if (Number.isInteger(v) && pids.includes(v)) return OWN(`pid ${v}`);
  }
  for (const k of NAME_ARGS) {
    const v = args?.[k];
    if (typeof v === 'string' && OVERLAY_NAME.test(v.trim())) return OWN(`"${v.trim()}"`);
  }
  if (!pauseSafe && (pauseGate.current() || foreign.paused)) {
    return 'paused — a pause is waiting for the user on screen, and nothing runs until they answer it. Keep waiting; do not read, press, type or click.';
  }
  return null;
}
