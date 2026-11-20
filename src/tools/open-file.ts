/**
 * open_file — the implementation of the MCP tool (extras.ts).
 *
 * The path goes to the OS opener as data: `open` (macOS) and `xdg-open` (Linux) get it as one argv element, Windows
 * Explorer through launchApp's $env: channel. No launcher search (Start menu, Spotlight) is ever typed into, and no
 * window is reported that is not the opened thing's own.
 */
import { promises as fsp } from 'node:fs';
import type { PlatformAdapter } from '../platform/types';
import { windowTextIncludes } from '../platform/window-text';
import { quoteScreenText } from '../core/untrusted-screen-content';
import { resolveAlias, startedNoWindowText } from '../platform/app-aliases';
import { withGuideHint } from '../core/guides/hint';

export async function openFilePath(
  platform: PlatformAdapter,
  filePath: string,
): Promise<{ text: string; isError?: boolean }> {
  const p = String(filePath);
  // Leaf segment — for a directory this is the Explorer window title.
  const leaf = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  let isDir = false;
  try { isDir = (await fsp.stat(p)).isDirectory(); }
  catch (err) {
    // A path that is not there is a failure, not an "Opened:" the opener may never have honoured. Any other stat error
    // (permissions, a path form stat cannot read) is not proof of absence: the opener decides.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { text: `open_file failed: no such file or folder: ${p}`, isError: true };
  }
  try {
    if (platform.platform === 'darwin' || platform.platform === 'linux') {
      // The opener accepted the path (a refusal throws); which app answers is not known, so no window is claimed.
      await platform.launchApp(platform.platform === 'darwin' ? 'open' : 'xdg-open', { url: p });
      // The one app the path itself names: Finder for a folder, the app for a .app bundle. A document's app is not known.
      const app = platform.platform === 'darwin' ? (isDir ? 'Finder' : /[.]app$/i.test(leaf) ? leaf.slice(0, -4) : '') : '';
      return { text: withGuideHint(`Opened: ${p} — handed to its default app; no window was checked, so read the screen before acting on it.`, { names: [app] }, platform.platform) };
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
      // The window (or process) launchApp reports is the program's own: only a program's processNames are asked for.
      const probe = { names: [exe, ...(alias?.processNames ?? []), res?.processName ?? ''], title: res?.title };
      if (res?.title) return { text: withGuideHint(`Opened: ${p} (window: ${quoteScreenText(res.title)})`, probe, platform.platform) };
      if (!exe) return { text: `Opened: ${p}` };
      if (res?.pid) return { text: withGuideHint(`Opened: ${p} — ${startedNoWindowText(leaf, res)}`, probe, platform.platform) };
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
        text: `open_file: launched Explorer but could NOT confirm the folder "${leaf}" opened (window: ${quoteScreenText(title || 'none')}). The path may not exist, or Explorer focused a different window. Verify with get_windows.`,
        isError: true,
      };
    }
    return { text: withGuideHint(`Opened folder "${leaf}" (window: ${quoteScreenText(title)})`, { names: ['explorer'] }, platform.platform) };
  } catch (err) {
    return {
      text: `open_file failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
