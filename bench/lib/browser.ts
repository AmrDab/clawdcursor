/**
 * The fixture browser: a SEPARATE Chromium instance with a temp profile, opened in a private window on the fixture
 * page. It never joins the owner's browser session: a different profile directory is a different browser process.
 */
import * as fs from 'fs';
import { chromium } from 'playwright';
import * as path from 'path';
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

/** The names the session log may give this browser (process name, display name): the privacy guard allows these. */
export function browserAppNames(kind: BrowserExe['kind']): string[] {
  return kind === 'edge' ? ['Edge', 'msedge', 'Microsoft Edge']
    : kind === 'chrome' ? ['Chrome', 'Google Chrome', 'google-chrome']
      : ['Chromium', 'chromium-browser'];
}

export function browserArgs(o: { kind: BrowserExe['kind']; profileDir: string; cdpPort: number; url: string; pos?: [number, number]; extraArgs?: string[] }): string[] {
  return [
    `--user-data-dir=${o.profileDir}`,
    `--remote-debugging-port=${o.cdpPort}`,
    // A new profile in Edge signs in with the Windows account and brings the owner's tabs: a private window does not.
    o.kind === 'edge' ? '--inprivate' : '--incognito',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--new-window',
    '--window-size=1000,900',
    `--window-position=${(o.pos ?? [80, 60]).join(',')}`,
    ...(o.extraArgs ?? []),
    o.url,
  ];
}

export interface FixtureBrowser { close(): Promise<void> }

export async function openBrowser(b: BrowserExe, o: { profileDir: string; cdpPort: number; url: string; pos?: [number, number]; extraArgs?: string[] }): Promise<FixtureBrowser> {
  fs.mkdirSync(o.profileDir, { recursive: true });
  start(b.exe, browserArgs({ kind: b.kind, ...o }), { stdio: 'ignore' });
  const endpoint = `http://127.0.0.1:${o.cdpPort}`;
  await waitFor(async () => {
    const tabs = await (await fetch(`${endpoint}/json/list`)).json() as Array<{ type: string; url: string }>;
    return tabs.some(t => t.type === 'page' && t.url.startsWith(o.url.split('?')[0]));
  }, 30_000, 'the fixture page to open');
  return {
    close: async () => {
      // Ask this instance (by its own debug port) to close, then stop whatever still runs on its profile.
      try {
        const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close').catch(() => { /* the connection closes with it */ });
      } catch { /* already gone */ }
      // The browser process can outlive its windows by a few seconds. Whatever still runs on this profile after that is stopped.
      const image = path.basename(b.exe);
      const gone = () => pidsByCommandLine(o.profileDir, image).length === 0;
      if (!await waitFor(gone, 10_000, 'the fixture browser to exit', 500).catch(() => false)) {
        killByCommandLine(o.profileDir, image);
        await waitFor(gone, 10_000, 'the fixture browser to be stopped', 500).catch(() => false);
      }
      try { fs.rmSync(o.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* a temp dir: the OS cleans it */ }
    },
  };
}
