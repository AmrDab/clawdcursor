/**
 * open_file — the implementation of the MCP tool (extras.ts).
 *
 * The path goes to the OS opener as data: `open` (macOS) and `xdg-open` (Linux) get it as one argv element, Windows
 * Explorer through launchApp's $env: channel. No launcher search (Start menu, Spotlight) is ever typed into, and no
 * window is reported that is not the opened thing's own.
 */
import { promises as fsp } from 'node:fs';
import type { PlatformAdapter } from '../platform/types';
import { windowTextIncludes } from './window-text';
import { quoteScreenText } from '../core/untrusted-screen-content';
import { resolveAlias, startedNoWindowText } from '../core/router/aliases';

export async function openFilePath(
  platform: PlatformAdapter,
  filePath: string,
): Promise<{ text: string; isError?: boolean }> {
  const p = String(filePath);
  // Leaf segment — for a directory this is the Explorer window title.
  const leaf = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  let isDir = false;
  try { isDir = (await fsp.stat(p)).isDirectory(); } catch { /* unknown/missing — treat as file */ }
  try {
    if (platform.platform === 'darwin' || platform.platform === 'linux') {
      // The opener accepted the path (a refusal throws); which app answers is not known, so no window is claimed.
      await platform.launchApp(platform.platform === 'darwin' ? 'open' : 'xdg-open', { url: p });
      return { text: `Opened: ${p} — handed to its default app; no window was checked, so read the screen before acting on it.` };
    }
    if (!isDir) {
      // A file is opened by its own program, not by Explorer, so no Explorer window is ever the result (live:
      // `Opened: …/calc.exe (window: "Screenshots - File Explorer")`). For a program the window reported must be
      // the program's own — calc.exe → the alias row's CalculatorApp; for a document the program is unknown.
      const exe = /\.(exe|com)$/i.test(leaf) ? leaf.replace(/\.(exe|com)$/i, '') : '';
      const alias = exe ? resolveAlias(exe) : null;
      const res = await platform.launchApp('explorer.exe', {
        url: p, noStartMenuFallback: true, viaLauncher: true,
        processNames: exe ? [exe, ...(alias?.processNames ?? [])] : [],
        searchTerm: alias?.searchTerm,
      });
      if (res?.title) return { text: `Opened: ${p} (window: ${quoteScreenText(res.title)})` };
      if (!exe) return { text: `Opened: ${p}` };
      if (res?.pid) return { text: `Opened: ${p} — ${startedNoWindowText(leaf, res)}` };
      const by = `"processName":${JSON.stringify(exe)}`;
      const focus = `window {"action":"focus",${by}}`;
      return { text: `Opened: ${p} — handed to Windows, but neither a window nor a process of ${leaf} was found: it may not have started. Wait, then ${focus} before acting on it.` };
    }
    // Windows: open the path in Explorer. For a DIRECTORY, VERIFY the
    // right folder window actually surfaced — launchApp must not fall
    // back to a Start-Menu search (which types "explorer" and opens
    // File Explorer at Home), and a pre-existing window is not proof.
    // Previously open_file returned "Opened" unconditionally even when
    // it landed on Home (live bug 2026-06-12).
    const res = await platform.launchApp('explorer.exe', { url: p, noStartMenuFallback: true });
    const title = res?.title ?? '';
    if (!leaf || !windowTextIncludes(title, leaf)) {
      return {
        text: `open_file: launched Explorer but could NOT confirm the folder "${leaf}" opened (window: ${quoteScreenText(title || 'none')}). The path may not exist, or Explorer focused a different window. Verify with list_windows.`,
        isError: true,
      };
    }
    return { text: `Opened folder "${leaf}" (window: ${quoteScreenText(title)})` };
  } catch (err) {
    return {
      text: `open_file failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
