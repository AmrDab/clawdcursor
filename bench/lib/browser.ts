/**
 * The fixture browser: a SEPARATE Chromium instance with a temp profile, opened in a private window on the fixture
 * page. It never joins the owner's browser session: a different profile directory is a different browser process.
 */
import * as fs from 'fs';
import { chromium } from 'playwright';
import * as path from 'path';
import { profileDebugPort } from './ownership';
import { killByCommandLine, pidsByCommandLine, start, waitFor } from './proc';

export interface BrowserExe { exe: string; kind: 'edge' | 'chrome' | 'chromium' }

const CANDIDATES: Record<string, BrowserExe[]> = {
  win32: [
    { exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', kind: 'edge' },
    { exe: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', kind: 'edge' },
    { exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', kind: 'chrome' },
    { exe: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', kind: 'chrome' },
  ],
  darwin: [
    { exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
    { exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
    { exe: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' },
  ],
  linux: [
    { exe: '/usr/bin/google-chrome', kind: 'chrome' }, { exe: '/usr/bin/google-chrome-stable', kind: 'chrome' },
    { exe: '/usr/bin/microsoft-edge', kind: 'edge' }, { exe: '/usr/bin/chromium', kind: 'chromium' },
    { exe: '/usr/bin/chromium-browser', kind: 'chromium' },
  ],
};

export function findBrowser(platform: string = process.platform, exists: (p: string) => boolean = fs.existsSync): BrowserExe | null {
  return (CANDIDATES[platform] ?? []).find(c => exists(c.exe)) ?? null;
}

/** The names the session log gives this browser. A name alone never passes the privacy guard: the process must be the fixture's (ownership.ts). */
export function browserAppNames(kind: BrowserExe['kind']): string[] {
  return kind === 'edge' ? ['Edge', 'Microsoft Edge'] : kind === 'chrome' ? ['Chrome', 'Google Chrome'] : ['Chromium'];
}

export function browserArgs(o: { kind: BrowserExe['kind']; profileDir: string; url: string; pos?: [number, number]; extraArgs?: string[] }): string[] {
  return [
    `--user-data-dir=${o.profileDir}`,
    // Port 0: the browser picks a free port and writes it to DevToolsActivePort in ITS profile. Reading it there is the
    // proof that this port is this instance's (ownership.ts).
    '--remote-debugging-port=0',
    // A new profile in Edge signs in with the Windows account and brings the owner's tabs: a private window does not.
    o.kind === 'edge' ? '--inprivate' : '--incognito',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window',
    '--window-size=1000,900',
    `--window-position=${(o.pos ?? [80, 60]).join(',')}`,
    ...(o.extraArgs ?? []),
    o.url,
  ];
}

export interface FixtureBrowser { cdpPort: number; close(): Promise<void> }

export async function openBrowser(b: BrowserExe, o: { profileDir: string; url: string; pos?: [number, number]; extraArgs?: string[] }): Promise<FixtureBrowser> {
  fs.mkdirSync(o.profileDir, { recursive: true, mode: 0o700 });
  start(b.exe, browserArgs({ kind: b.kind, ...o }), { stdio: 'ignore' });
  const image = path.basename(b.exe);
  // Stop whatever runs on this profile, by its own debug port when there is one, and remove the profile.
  const close = async (cdpPort?: number) => {

      // Ask this instance (by its own debug port) to close, then stop whatever still runs on its profile.
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5000 });
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close').catch(() => { /* the connection closes with it */ });
      } catch { /* already gone */ }
      // The browser process can outlive its windows by a few seconds. Whatever still runs on this profile after that is stopped.
      const gone = async () => (await pidsByCommandLine(o.profileDir, image)).length === 0;
      if (!await waitFor(gone, 10_000, 'the fixture browser to exit', 500).catch(() => false)) {
        await killByCommandLine(o.profileDir, image);
        await waitFor(gone, 10_000, 'the fixture browser to be stopped', 500).catch(() => false);
      }
      try { fs.rmSync(o.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp dir: the OS cleans it */ }
  };
  let cdpPort: number;
  try {
    cdpPort = await waitFor(() => profileDebugPort(o.profileDir), 30_000, 'the fixture browser to start');
    const endpoint = `http://127.0.0.1:${cdpPort}`;
    await waitFor(async () => {
      const tabs = await (await fetch(`${endpoint}/json/list`)).json() as Array<{ type: string; url: string }>;
      return tabs.some(t => t.type === 'page' && t.url.startsWith(o.url.split('?')[0]));
    }, 30_000, 'the fixture page to open');
  } catch (e) {
    await close(profileDebugPort(o.profileDir) ?? undefined);   // the browser started but the page never showed: it is not left running
    throw e;
  }
  const port = cdpPort;
  return { cdpPort: port, close: () => close(port) };
}
