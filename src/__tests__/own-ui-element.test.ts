/**
 * A host app that draws the pill (docs/pill-host.md) names its own UI processes: CLAWD_OWN_UI_PIDS, and a file it can
 * rewrite (CLAWD_OWN_UI_PIDS_FILE) for a web view's helper processes, which come and go. Its window has buttons the
 * user answers with ("Yes", "Resume"), and after the user clicked it, it is the window in front. Contract under test:
 * an element inside an own-UI process is refused, for an act and for a read, whether the call names that process
 * (the element's own, or the window's) or names none and the own-UI window is in front.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { hostUiPids } from '../core/banner';   // registers the own-UI pid list with the platform layer
import { __setControlDirForTests, __setForegroundReaderForTests, isGuardRefusal } from '../core/control';
import { guardInputMethods, isOwnUiPid } from '../platform/pointer-guard';
import { classifyResult } from '../core/result-codes';

const HOST = 4242;      // the host app's process: its top-level window
const WEBVIEW = 4250;   // the web view's process: the elements drawn inside that window
type Win = { processId: number; processName: string };
const HOST_WINDOW: Win = { processId: HOST, processName: 'node' };
const NOTEPAD: Win = { processId: 300, processName: 'notepad' };

let fg: Win;
let dir: string;
let pidsFile: string;

/** An accessibility layer that says what reached it. Both real ones (the bridge and the platform adapter) are wrapped the same way. */
function fakeA11y() {
  const reached: string[] = [];
  const a = {
    reached,
    async invokeElement(q: { name?: string; processId?: number; action?: string }) { reached.push(`invoke ${q.name} ${q.action ?? 'click'}`); return { success: true }; },
    async findElements(q: { name?: string; processId?: number }) { reached.push(`find ${q.name}`); return []; },
    async getUiTree(_pid?: number) { reached.push('tree'); return []; },
    async getScreenContext(_pid?: number) { reached.push('context'); return ''; },
    async getPageText() { reached.push('text'); return null; },
  };
  return guardInputMethods(a);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-ownui-'));
  pidsFile = path.join(dir, 'pids');
  __setControlDirForTests(dir);
  process.env.CLAWD_OWN_UI_PIDS = String(HOST);
  process.env.CLAWD_OWN_UI_PIDS_FILE = pidsFile;
  fs.writeFileSync(pidsFile, String(WEBVIEW));
  fg = NOTEPAD;
  __setForegroundReaderForTests(async () => fg);
});
afterEach(() => {
  delete process.env.CLAWD_OWN_UI_PIDS;
  delete process.env.CLAWD_OWN_UI_PIDS_FILE;
  __setControlDirForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const OWN = /is clawdcursor's own on-screen control/;

describe('an element inside the own-UI process', () => {
  it('is refused when the call names the element\'s process or the window\'s process', async () => {
    const a = fakeA11y();
    for (const processId of [WEBVIEW, HOST]) {
      await expect(a.invokeElement({ name: 'Yes', processId, action: 'click' })).rejects.toThrow(OWN);
      await expect(a.invokeElement({ name: 'Yes', processId, action: 'get-value' })).rejects.toThrow(OWN);
      await expect(a.findElements({ name: 'Yes', processId })).rejects.toThrow(OWN);
      await expect(a.getUiTree(processId)).rejects.toThrow(OWN);
      await expect(a.getScreenContext(processId)).rejects.toThrow(OWN);
    }
    expect(a.reached).toEqual([]);
  });

  it('is refused when the call names no process and the own-UI window is in front (smart_click and invoke by name)', async () => {
    fg = HOST_WINDOW;   // the user just clicked the host app's bubble
    const a = fakeA11y();
    const err = await a.invokeElement({ name: 'Yes', action: 'click' }).catch(e => e);
    expect(err.message).toMatch(OWN);
    expect(isGuardRefusal(err)).toBe(true);   // a tool that falls back to another way (smart_click) lets it through as a refusal
    expect(classifyResult(err.message, true, false)?.code).toBe('OWN_UI');
    await expect(a.invokeElement({ name: 'Resume', action: 'get-value' })).rejects.toThrow(OWN);
    await expect(a.findElements({ name: 'Yes' })).rejects.toThrow(OWN);
    await expect(a.getUiTree()).rejects.toThrow(OWN);
    await expect(a.getScreenContext()).rejects.toThrow(OWN);
    await expect(a.getPageText()).rejects.toThrow(OWN);
    expect(a.reached).toEqual([]);
  });

  it('another app is read and acted on as before, in front or by its process', async () => {
    const a = fakeA11y();
    await a.invokeElement({ name: 'Save', action: 'click' });
    await a.invokeElement({ name: 'Save', processId: NOTEPAD.processId, action: 'click' });
    await a.findElements({ name: 'Save' });
    await a.getUiTree();
    await a.getPageText();
    expect(a.reached).toEqual(['invoke Save click', 'invoke Save click', 'find Save', 'tree', 'text']);
  });

  it('with no host UI named, the window in front is not even read (the built-in pill never takes the front)', async () => {
    delete process.env.CLAWD_OWN_UI_PIDS;
    delete process.env.CLAWD_OWN_UI_PIDS_FILE;
    let reads = 0;
    __setForegroundReaderForTests(async () => { reads++; return NOTEPAD; });
    const a = fakeA11y();
    await a.getUiTree();
    await a.findElements({ name: 'Save' });
    expect(reads).toBe(0);
    expect(a.reached).toEqual(['tree', 'find Save']);
  });
});

describe('CLAWD_OWN_UI_PIDS_FILE', () => {
  it('adds the file\'s pids to the named ones, and follows the file when the host rewrites it', () => {
    expect(hostUiPids('4242', pidsFile)).toEqual([HOST, WEBVIEW]);
    expect(isOwnUiPid(WEBVIEW)).toBe(true);
    const next = path.join(dir, 'pids-2');             // another path is read at once; the same one at most once a second
    fs.writeFileSync(next, '5001, 5002,junk');
    expect(hostUiPids('4242', next)).toEqual([HOST, 5001, 5002]);
    fs.rmSync(next);
    expect(hostUiPids('4242', next)).toEqual([HOST, 5001, 5002]);   // unreadable for a moment: the last list stays
    expect(hostUiPids('4242', '')).toEqual([HOST]);
    expect(hostUiPids('', path.join(dir, 'missing'))).toEqual([]);
  });
});
