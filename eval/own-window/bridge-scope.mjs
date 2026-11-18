// The test's scope for agent B (agent-bridge.mjs). Pure, so it is unit-tested (src/__tests__/own-window-bridge-scope.test.ts).

/** The pids agent B may address, from <dir>/setup.json: ClawdTarget and the test browser (macOS `chrome`, Windows `edge`); never the user app. */
export function allowedPids(setup) {
  const user = setup?.user?.pid;
  return [setup?.target?.pid, setup?.chrome?.pid, setup?.edge?.pid].filter(p => Number.isInteger(p) && p > 0 && p !== user);
}

/**
 * null when the call is in scope, else the refusal text. In scope: `browser` (the test's own CDP browser) and `accessibility`
 * with a processId in `pids`, except `focused`, which ignores processId and reports whatever window is in front (the user's).
 */
export function outOfScope(name, args, pids) {
  if (name === 'browser') return null;
  const p = args?.processId;
  const pid = typeof p === 'number' ? p : typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : NaN;
  if (name === 'accessibility' && args?.action !== 'focused' && pids.includes(pid)) return null;
  return `out of scope for this test: ${[name, args?.action].filter(Boolean).join(' ')} (only accessibility with processId in [${pids.join(', ')}] and browser)`;
}
