// The test's scope for agent B (agent-bridge.mjs). Pure, so it is unit-tested (src/__tests__/own-window-bridge-scope.test.ts).
// Allowlists, not exclusions: a call is in scope only if its action is named here (a live run had an unscoped `window list`
// return the owner's real window titles).

/** The pids agent B may address, from <dir>/setup.json: ClawdTarget and the test browser (macOS `chrome`, Windows `edge`); never the user app. */
export function allowedPids(setup) {
  const user = setup?.user?.pid;
  return [setup?.target?.pid, setup?.chrome?.pid, setup?.edge?.pid].filter(p => Number.isInteger(p) && p > 0 && p !== user);
}

/** The test browser's debug port(s): the only browser agent B may connect to. */
export function allowedPorts(setup) {
  return [setup?.chrome?.port, setup?.edge?.port].filter(p => Number.isInteger(p) && p > 0);
}

// accessibility actions that read or act inside the process named by processId. Not here: `focused`, find_button / find_field
// (they read the window in front, whatever processId says), focus (moves the focus), smart_* (OCR and screen fallbacks).
const ACCESSIBILITY = new Set(['read_tree', 'find', 'get_element', 'get_value', 'state', 'list_children', 'compile_ui', 'invoke', 'set_value']);
// browser actions on the page already open in the test browser. Not here: navigate (any URL), evaluate (any script), tabs.
const BROWSER = new Set(['connect', 'page_context', 'read_text', 'click', 'type', 'select_option', 'wait_for', 'scroll']);

const asPid = p => (typeof p === 'number' ? p : typeof p === 'string' && /^\d+$/.test(p) ? Number(p) : NaN);

/** null when the call is in scope, else the refusal text. */
export function outOfScope(name, args, pids, ports = []) {
  const action = args?.action;
  const why = (rule) => `out of scope for this test: ${[name, action].filter(Boolean).join(' ')} (${rule})`;
  if (name === 'accessibility') {
    if (!ACCESSIBILITY.has(action)) return why(`accessibility allows only ${[...ACCESSIBILITY].join(', ')}`);
    if (!pids.includes(asPid(args?.processId))) return why(`processId must be one of [${pids.join(', ')}]`);
    // compile_ui fuses OCR of the window's screen area: with the agent's window covered, that is the user's window. A11y only.
    if (action === 'compile_ui' && args?.max_cost !== 'cheap') return why('compile_ui needs max_cost:"cheap" (no OCR, no screenshot)');
    return null;
  }
  if (name === 'browser') {
    if (!BROWSER.has(action)) return why(`browser allows only ${[...BROWSER].join(', ')}`);
    if (action === 'connect') {
      // The server is already pointed at the test browser (CLAWD_AGENT_CDP_PORT); no other host, URL or port.
      if (['url', 'host', 'endpoint', 'wsEndpoint', 'browserURL', 'launch'].some(k => args?.[k] !== undefined)) return why('connect takes no host, URL or launch here');
      if (args?.port !== undefined && !ports.includes(asPid(args.port))) return why(`connect only to the test browser's port [${ports.join(', ')}]`);
    }
    return null;
  }
  // The user's turn, the indicator's third state (the blue glow): the agent asks on the pause card. It reads nothing.
  if (name === 'system' && action === 'pause_for_user') return null;
  return why('only accessibility (processId in the test\'s windows), browser (the test browser\'s page) and system pause_for_user');
}
