/**
 * P2 (2026-06-13): open_file no longer reports a false "Opened" for a folder.
 * It used to route through launchApp and return "Opened: <path>"
 * unconditionally — even when launchApp's Start-Menu fallback typed
 * "explorer" and opened File Explorer at **Home** instead of the folder
 * (live bug). Now: directory opens are VERIFIED by the leaf-folder window
 * title, with no Start-Menu fallback, and return isError when unconfirmed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExtraTools } from '../tools/extras';
import type { ToolContext } from '../tools/types';

const openFile = getExtraTools().find(t => t.name === 'open_file')!;

const dir = join(tmpdir(), `clawd-of-${process.pid}`);
beforeAll(async () => { await fs.mkdir(dir, { recursive: true }); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function ctx(launchApp: any): ToolContext {
  return {
    ensureInitialized: async () => {},
    platform: { platform: 'win32', launchApp: vi.fn(launchApp) },
  } as unknown as ToolContext;
}

describe('open_file — directory open is verified, not assumed (Windows)', () => {
  const leaf = dir.split(/[\\/]/).pop()!;

  it('reports success when the matching folder window surfaces', async () => {
    const r = await openFile.handler({ path: dir }, ctx(async () => ({ title: `${leaf} - File Explorer`, pid: 5 })));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(new RegExp(`Opened folder "${leaf}"`));
  });

  it('returns isError when Explorer landed on Home (false-success guard)', async () => {
    const r = await openFile.handler({ path: dir }, ctx(async () => ({ title: 'Home - File Explorer', pid: 5 })));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could NOT confirm the folder/);
  });

  it('returns isError when no window surfaced at all (no Start-Menu fallback)', async () => {
    const r = await openFile.handler({ path: dir }, ctx(async () => ({}))); // launchApp returned {} (fallback skipped)
    expect(r.isError).toBe(true);
  });

  it('passes noStartMenuFallback to launchApp for the directory path', async () => {
    const spy = vi.fn(async () => ({ title: `${leaf} - File Explorer` }));
    await openFile.handler({ path: dir }, ctx(spy));
    expect(spy).toHaveBeenCalledWith('explorer.exe', expect.objectContaining({ url: dir, noStartMenuFallback: true }));
  });
});

describe('open_file — a file is opened by its own program: no Explorer window is ever reported as it (Windows)', () => {
  // Live: `Opened: C:/Windows/System32/calc.exe (window: "Screenshots - File Explorer")`, and Calculator never started.
  it('a program: launchApp is told Explorer is only the launcher, and which processes are the program', async () => {
    const spy = vi.fn(async () => ({}));
    await openFile.handler({ path: 'C:/Windows/System32/calc.exe' }, ctx(spy));
    expect(spy).toHaveBeenCalledWith('explorer.exe', expect.objectContaining({
      url: 'C:/Windows/System32/calc.exe', viaLauncher: true, noStartMenuFallback: true,
      processNames: expect.arrayContaining(['calc', 'CalculatorApp']),
    }));
  });

  it('a program whose window was not found: says so, and names no window', async () => {
    const r = await openFile.handler({ path: 'C:/Windows/System32/calc.exe' }, ctx(async () => ({})));
    expect(r.text).toMatch(/neither a window nor a process of calc\.exe was found/);
    expect(r.text).not.toMatch(/\(window:/);
  });

  it('a program whose process is up but whose window is not yet: started, with its pid, and how to reach it', async () => {
    const r = await openFile.handler({ path: 'C:/Windows/System32/calc.exe' }, ctx(async () => ({ pid: 400, processName: 'CalculatorApp' })));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/pid=400\) but its window isn't up yet/);
    expect(r.text).toContain('window {"action":"focus","processName":"CalculatorApp"}');
  });

  it('a program whose own window surfaced is reported', async () => {
    const r = await openFile.handler({ path: 'C:/Windows/System32/calc.exe' }, ctx(async () => ({ title: 'Calculator', pid: 400 })));
    expect(r.text).toMatch(/Opened: .*calc\.exe \(window: .*Calculator/);
  });

  it('a document: the program is unknown, so launchApp is given no process to look for', async () => {
    const spy = vi.fn(async () => ({}));
    const r = await openFile.handler({ path: join(dir, 'report.pdf') }, ctx(spy));
    expect(spy).toHaveBeenCalledWith('explorer.exe', expect.objectContaining({ viaLauncher: true, processNames: [] }));
    expect(r.text).not.toMatch(/window/);
  });
});

describe('open_file — a refused path says why; macOS and Linux go through the OS opener', () => {
  const tool = (platform: string, launchApp: any): ToolContext =>
    ({ ensureInitialized: async () => {}, platform: { platform, launchApp: vi.fn(launchApp) } } as unknown as ToolContext);

  it('Windows: the adapter\'s refusal reaches the agent', async () => {
    const r = await openFile.handler({ path: 'C:\\x\\a"b.txt' }, ctx(async () => { throw new Error('launchApp: the path or URL to open contains a double quote or a control character'); }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/double quote or a control character/);
  });

  it.each([['darwin', 'open'], ['linux', 'xdg-open']])('%s: hands the path to `%s`, and claims no window', async (platform, opener) => {
    const spy = vi.fn(async () => ({}));
    const r = await openFile.handler({ path: "/home/x/Sam's $notes.txt" }, tool(platform, spy));
    expect(spy).toHaveBeenCalledWith(opener, { url: "/home/x/Sam's $notes.txt" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Opened: .*no window was checked/);
  });

  it.each([['darwin'], ['linux']])('%s: the opener\'s failure is the result', async (platform) => {
    const r = await openFile.handler({ path: '/nope' }, tool(platform, async () => { throw new Error('The file /nope does not exist.'); }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not exist/);
  });
});
