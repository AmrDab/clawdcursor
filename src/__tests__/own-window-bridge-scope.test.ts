/**
 * eval/own-window/agent-bridge.mjs lets agent B (the two-agent live run) call only the test's own windows. A live macOS run
 * had B's unscoped `window list` return the owner's real window titles; the allow-decision lives in bridge-scope.mjs.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getPackageRoot } from '../paths';

type Scope = {
  allowedPids(setup: unknown): number[];
  outOfScope(name: unknown, args: unknown, pids: number[]): string | null;
};
const load = async (): Promise<Scope> =>
  (await import(pathToFileURL(path.join(getPackageRoot(), 'eval', 'own-window', 'bridge-scope.mjs')).href)) as Scope;

// setup.json as live-macos.mjs and live-windows.mjs write it
const MAC = { cli: 'x', env: {}, user: { pid: 100, file: '/tmp/user.txt' }, target: { pid: 200 }, chrome: { pid: 300, port: 9222 } };
const WIN = { cli: 'x', env: {}, user: { hwnd: 1, pid: 100, edit: 2, text: 'user-was-here' }, target: { hwnd: 3, pid: 200 }, edge: { pid: 400, port: 9333 } };

describe('allowedPids', () => {
  it('takes the target and the test browser, never the user app', async () => {
    const { allowedPids } = await load();
    expect(allowedPids(MAC)).toEqual([200, 300]);
    expect(allowedPids(WIN)).toEqual([200, 400]);
    expect(allowedPids({ ...MAC, chrome: null })).toEqual([200]);
    expect(allowedPids({ ...MAC, target: { pid: 100 } })).toEqual([300]);   // a pid equal to the user's is dropped
  });
});

describe('outOfScope', () => {
  it('passes accessibility addressed to an allowed pid, and browser', async () => {
    const { outOfScope } = await load();
    const pids = [200, 300];
    for (const action of ['read_tree', 'compile_ui', 'find_field', 'set_value', 'invoke']) {
      expect(outOfScope('accessibility', { action, processId: 200 }, pids)).toBeNull();
    }
    expect(outOfScope('accessibility', { action: 'set_value', name: 'Your name', processId: '300' }, pids)).toBeNull();
    expect(outOfScope('browser', { action: 'connect' }, pids)).toBeNull();
  });

  it('refuses everything else, with the tool and action in the reply', async () => {
    const { outOfScope } = await load();
    const pids = [200, 300];
    expect(outOfScope('window', { action: 'list' }, pids)).toBe('out of scope for this test: window list (only accessibility with processId in [200, 300] and browser)');
    expect(outOfScope('computer', { action: 'screenshot' }, pids)).toMatch(/^out of scope for this test: computer screenshot/);
    expect(outOfScope('system', { action: 'copy_all_text' }, pids)).not.toBeNull();
    expect(outOfScope('batch', { steps: [] }, pids)).toMatch(/^out of scope for this test: batch \(/);
    expect(outOfScope('accessibility', { action: 'read_tree' }, pids)).not.toBeNull();                  // no processId
    expect(outOfScope('accessibility', { action: 'read_tree', processId: 100 }, pids)).not.toBeNull();  // the user app
    expect(outOfScope('accessibility', { action: 'read_tree', processId: [200] }, pids)).not.toBeNull();
    expect(outOfScope('accessibility', { action: 'focused', processId: 200 }, pids)).not.toBeNull();    // ignores processId
    expect(outOfScope('read_screen', { processId: 200 }, pids)).not.toBeNull();                         // granular names too
  });
});
