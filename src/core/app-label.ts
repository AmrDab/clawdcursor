/**
 * The name a person knows an app by, for the overlay's pill and paused card (banner.ts) and the window clawdcursor
 * acted in (control.ts). Pure, with no imports.
 */

// Where the OS gave no display name (Linux, an elevated process the bridge may not open): process names that say little.
const APP_NAMES: Record<string, string> = {
  msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', explorer: 'File Explorer', code: 'VS Code',
  winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook',
};
const oneLine = (s: string | undefined) => (s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);

/**
 * The app as a person knows it: its own display name when the OS gave one ("Designcenter NX" for ugraf.exe), as it is;
 * else from the process name: "msedge.exe" → "Edge", "notepad" → "Notepad". The one exception: explorer.exe calls itself
 * "Windows Explorer", and people know it as File Explorer.
 */
export function appLabel(processName: string | undefined, appName?: string): string | undefined {
  const base = oneLine((processName ?? '').replace(/\.(exe|app)$/i, ''));
  const own = base.toLowerCase() === 'explorer' ? '' : oneLine(appName);
  if (own) return own;
  if (!base || /^pid \d+$/.test(base)) return undefined;
  return APP_NAMES[base.toLowerCase()] ?? base.charAt(0).toUpperCase() + base.slice(1);
}
