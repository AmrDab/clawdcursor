/**
 * clawdcursor's own on-screen controls (the pill, its pause prompt, the edge glow) are the USER's: the agent never reads,
 * presses or types into them. Found live on macOS (2026-10-24): `accessibility read_tree {processId:<overlay pid>}` returned
 * the pill's tree, the pause prompt's Resume button was findable and invokable by name — faking the user's answer — and
 * nothing stopped an agent from acting while a pause waited for the user.
 *
 * One check, called before every tool runs (MCP wrapper, both batch executors, the agent loop):
 *  - any call aimed at an overlay process by pid is refused;
 *  - while a pause is pending, every acting call is refused — that alone covers the pill's buttons and reply box on every
 *    OS (they exist only while paused, and the reply box takes focus there), coordinate clicks, keys, and the dashboard's
 *    Resume button.
 */
import { controlBanner } from './banner';
import { pauseGate } from './pause-gate';

const PID_ARGS = ['processId', 'pid', 'process_id'];

export function ownUiRefusal(args: Record<string, unknown> | undefined, acting: boolean): string | null {
  const pids = controlBanner.overlayPids();
  for (const k of PID_ARGS) {
    const v = Number(args?.[k]);
    if (Number.isInteger(v) && pids.includes(v)) {
      return `pid ${v} is clawdcursor's own on-screen control — it is the user's, never read or acted on. Target the app instead.`;
    }
  }
  if (acting && pauseGate.current()) {
    return 'paused — a pause is waiting for the user on screen, and nothing acts until they answer it. Keep waiting; do not press, type or click.';
  }
  return null;
}
