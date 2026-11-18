/**
 * eval/own-window/agent-bridge.mjs lets agent B (the two-agent live run) call only the test's own windows. A live macOS run
 * had B's unscoped `window list` return the owner's real window titles; the allow-decision lives in bridge-scope.mjs, as
 * allowlists of actions (not exclusions), so a new or overlooked action is refused by default.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getPackageRoot } from '../paths';

type Scope = {
  allowedPids(setup: unknown): number[];
  allowedPorts(setup: unknown): number[];
  outOfScope(name: unknown, args: unknown, pids: number[], ports?: number[]): string | null;
};
const load = async (): Promise<Scope> =>
  (await import(pathToFileURL(path.join(getPackageRoot(), 'eval', 'own-window', 'bridge-scope.mjs')).href)) as Scope;

// setup.json as live-macos.mjs and live-windows.mjs write it
const MAC = { cli: 'x', env: {}, user: { pid: 100, file: '/tmp/user.txt' }, target: { pid: 200 }, chrome: { pid: 300, port: 9222 } };
const WIN = { cli: 'x', env: {}, user: { hwnd: 1, pid: 100, edit: 2, text: 'user-was-here' }, target: { hwnd: 3, pid: 200 }, edge: { pid: 400, port: 9333 } };
const pids = [200, 300], ports = [9222];

describe('allowedPids / allowedPorts', () => {
  it('take the target and the test browser, never the user app', async () => {
    const { allowedPids, allowedPorts } = await load();
    expect(allowedPids(MAC)).toEqual([200, 300]);
    expect(allowedPids(WIN)).toEqual([200, 400]);
    expect(allowedPids({ ...MAC, chrome: null })).toEqual([200]);
    expect(allowedPids({ ...MAC, target: { pid: 100 } })).toEqual([300]);   // a pid equal to the user's is dropped
    expect(allowedPorts(MAC)).toEqual([9222]);
    expect(allowedPorts(WIN)).toEqual([9333]);
  });
});

describe('outOfScope', () => {
  it('passes the test\'s accessibility reads and acts addressed to its own pids, and the browser on the open page', async () => {
    const { outOfScope } = await load();
    for (const action of ['read_tree', 'find', 'get_element', 'get_value', 'state', 'list_children', 'invoke', 'set_value']) {
      expect(outOfScope('accessibility', { action, processId: 200 }, pids, ports)).toBeNull();
    }
    expect(outOfScope('accessibility', { action: 'compile_ui', processId: 200, max_cost: 'cheap' }, pids, ports)).toBeNull();
    expect(outOfScope('accessibility', { action: 'set_value', name: 'Your name', processId: '300' }, pids, ports)).toBeNull();
    for (const action of ['connect', 'page_context', 'read_text', 'click', 'type', 'select_option', 'wait_for', 'scroll']) {
      expect(outOfScope('browser', { action }, pids, ports)).toBeNull();
    }
    expect(outOfScope('browser', { action: 'connect', port: 9222 }, pids, ports)).toBeNull();
  });

  it('refuses other tools, with the tool and action in the reply', async () => {
    const { outOfScope } = await load();
    expect(outOfScope('window', { action: 'list' }, pids, ports)).toMatch(/^out of scope for this test: window list \(/);
    expect(outOfScope('computer', { action: 'screenshot' }, pids, ports)).toMatch(/^out of scope for this test: computer screenshot/);
    expect(outOfScope('system', { action: 'copy_all_text' }, pids, ports)).not.toBeNull();
    expect(outOfScope('system', { action: 'ocr' }, pids, ports)).not.toBeNull();
    expect(outOfScope('system', { action: 'pause_for_user', message: 'Click Resume' }, pids, ports)).toBeNull();   // the blue-glow state
    expect(outOfScope('batch', { steps: [] }, pids, ports)).toMatch(/^out of scope for this test: batch \(/);
    expect(outOfScope('read_screen', { processId: 200 }, pids, ports)).not.toBeNull();   // granular names too
  });

  it('refuses accessibility actions that read the window in front or the screen, and any other pid', async () => {
    const { outOfScope } = await load();
    for (const action of ['focused', 'find_button', 'find_field', 'focus', 'smart_click', 'smart_type', 'smart_read', 'wait_for', 'toggle', undefined]) {
      expect(outOfScope('accessibility', { action, processId: 200 }, pids, ports)).not.toBeNull();
    }
    expect(outOfScope('accessibility', { action: 'read_tree' }, pids, ports)).not.toBeNull();                  // no processId
    expect(outOfScope('accessibility', { action: 'read_tree', processId: 100 }, pids, ports)).not.toBeNull();  // the user app
    expect(outOfScope('accessibility', { action: 'read_tree', processId: [200] }, pids, ports)).not.toBeNull();
    // compile_ui OCRs the window's screen area, which is the user's window when the agent's is covered: a11y only.
    expect(outOfScope('accessibility', { action: 'compile_ui', processId: 200 }, pids, ports)).toMatch(/max_cost:"cheap"/);
    expect(outOfScope('accessibility', { action: 'compile_ui', processId: 200, max_cost: 'vision_ok' }, pids, ports)).not.toBeNull();
  });

  it('refuses browser actions that leave the test page or the test browser', async () => {
    const { outOfScope } = await load();
    for (const action of ['navigate', 'evaluate', 'list_tabs', 'switch_tab', undefined]) {
      expect(outOfScope('browser', { action }, pids, ports)).not.toBeNull();
    }
    expect(outOfScope('browser', { action: 'connect', port: 9223 }, pids, ports)).toMatch(/test browser's port/);
    expect(outOfScope('browser', { action: 'connect', url: 'http://127.0.0.1:9223' }, pids, ports)).not.toBeNull();
    expect(outOfScope('browser', { action: 'connect', launch: true }, pids, ports)).not.toBeNull();
  });
});
