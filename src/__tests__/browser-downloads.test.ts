/**
 * What the agent's own browser downloads is kept in the user's Downloads folder under its own name, and the next tool
 * result says where (owner, 2026-11-20: Playwright's temp folder, random names and no extension, hid a downloaded picture).
 * Only pictures, PDFs, text, audio and video are kept, under a safe name; a user's own browser is left alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ browser: null as unknown }));
vi.mock('playwright', () => ({ chromium: { connectOverCDP: vi.fn(async () => h.browser) } }));

import { CDPDriver, downloadsDir, freeDownloadPath, keptDownload } from '../platform/cdp-driver';
import { AGENT_CDP_PORT } from '../platform/browser-config';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-dl-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const fakePage = () => Object.assign(new EventEmitter(), { url: () => 'https://upload.wikimedia.org/a.jpg', title: async () => 'a.jpg' });
/** A download Playwright reports: saveAs writes the finished file where it is told. */
const fakeDownload = (name: string) => ({ suggestedFilename: () => name, saveAs: async (to: string) => fs.writeFileSync(to, 'x') });

/** A driver connected to a browser with one page, in the agent's own browser (its port) unless `port` says otherwise. */
async function connected(dir: string, port = AGENT_CDP_PORT) {
  const page = fakePage();
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  h.browser = { contexts: () => [context] };
  const driver = new CDPDriver(9223);
  driver.__setDownloadsDirForTests(dir);
  expect(await driver.connect(port)).toBe(true);
  return { driver, page, context };
}

describe('the Downloads folder, on every OS', () => {
  it('is ~/Downloads on Windows and macOS', () => {
    expect(downloadsDir(tmp, 'win32')).toBe(path.join(tmp, 'Downloads'));
    expect(downloadsDir(tmp, 'darwin')).toBe(path.join(tmp, 'Downloads'));
  });

  it('on Linux is the folder user-dirs.dirs names, else ~/Downloads, and never the home folder itself', () => {
    expect(downloadsDir(tmp, 'linux')).toBe(path.join(tmp, 'Downloads'));
    fs.mkdirSync(path.join(tmp, '.config'));
    const dirs = path.join(tmp, '.config', 'user-dirs.dirs');
    fs.writeFileSync(dirs, 'XDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n');
    expect(downloadsDir(tmp, 'linux')).toBe(`${tmp}/Téléchargements`);
    fs.writeFileSync(dirs, 'XDG_DOWNLOAD_DIR="$HOME"\n');
    expect(downloadsDir(tmp, 'linux')).toBe(path.join(tmp, 'Downloads'));
  });
});

describe('a download\'s file name', () => {
  it('is the site\'s own name; a taken one gets " (1)", " (2)"', () => {
    expect(freeDownloadPath(tmp, 'Hopetoun_falls.jpg')).toBe(path.join(tmp, 'Hopetoun_falls.jpg'));
    fs.writeFileSync(path.join(tmp, 'Hopetoun_falls.jpg'), '');
    expect(freeDownloadPath(tmp, 'Hopetoun_falls.jpg')).toBe(path.join(tmp, 'Hopetoun_falls (1).jpg'));
    fs.writeFileSync(path.join(tmp, 'Hopetoun_falls (1).jpg'), '');
    expect(freeDownloadPath(tmp, 'Hopetoun_falls.jpg')).toBe(path.join(tmp, 'Hopetoun_falls (2).jpg'));
  });

  it('never leaves the folder, never hides, never reads back to front, never names a device', () => {
    expect(freeDownloadPath(tmp, '../../evil.jpg')).toBe(path.join(tmp, 'evil.jpg'));
    expect(freeDownloadPath(tmp, 'C:\\Windows\\evil.jpg')).toBe(path.join(tmp, 'evil.jpg'));
    expect(freeDownloadPath(tmp, '..')).toBe(path.join(tmp, 'download'));
    expect(freeDownloadPath(tmp, '')).toBe(path.join(tmp, 'download'));
    expect(freeDownloadPath(tmp, 'a?b*c.jpg')).toBe(path.join(tmp, 'a_b_c.jpg'));
    expect(freeDownloadPath(tmp, '.bashrc')).toBe(path.join(tmp, '_.bashrc'));
    expect(freeDownloadPath(tmp, 'invoice\u202Egpj.exe')).toBe(path.join(tmp, 'invoicegpj.exe'));   // shown as "invoiceexe.jpg"
    expect(freeDownloadPath(tmp, 'setup.exe. . ')).toBe(path.join(tmp, 'setup.exe'));
    expect(freeDownloadPath(tmp, 'CON.jpg')).toBe(path.join(tmp, '_CON.jpg'));
  });

  it('pictures, PDFs, text, audio and video are kept; programs, scripts, archives and shortcuts are not', () => {
    for (const f of ['a.JPG', 'a.png', 'a.pdf', 'a.txt', 'a.csv', 'a.mp4']) expect(keptDownload(f)).toBe(true);
    for (const f of ['a.exe', 'a.msi', 'a.bat', 'a.ps1', 'a.lnk', 'a.js', 'a.zip', 'a.docm', 'a.svg', 'a.app', 'a.command', 'a.sh', 'download', '_.bashrc'])
      expect(keptDownload(f)).toBe(false);
  });
});

describe('the agent\'s own browser keeps its downloads', () => {
  it('a download on an open page, or on one opened later, lands in Downloads under its own name, named once', async () => {
    const dir = path.join(tmp, 'Downloads');   // created on the first download
    const { driver, page, context } = await connected(dir);
    page.emit('download', fakeDownload('Hopetoun_falls.jpg'));
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, 'Hopetoun_falls.jpg'))).toBe(true));
    expect(driver.takeSavedDownloads()).toEqual([path.join(dir, 'Hopetoun_falls.jpg')]);
    expect(driver.takeSavedDownloads()).toEqual([]);   // named once

    const later = fakePage();
    context.emit('page', later);
    later.emit('download', fakeDownload('Hopetoun_falls.jpg'));
    await vi.waitFor(() => expect(driver.takeSavedDownloads()).toEqual([path.join(dir, 'Hopetoun_falls (1).jpg')]));
  });

  it('a program a page downloads is not kept in Downloads', async () => {
    const { driver, page } = await connected(tmp);
    page.emit('download', fakeDownload('setup.exe'));
    await new Promise(r => setTimeout(r, 20));
    expect(driver.takeSavedDownloads()).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('a download that fails keeps nothing and names nothing', async () => {
    const { driver, page } = await connected(tmp);
    page.emit('download', { suggestedFilename: () => 'x.jpg', saveAs: async () => { throw new Error('canceled'); } });
    await new Promise(r => setTimeout(r, 20));
    expect(driver.takeSavedDownloads()).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('a browser of the user\'s (attached on another port) is left alone: its downloads are theirs', async () => {
    const { driver, page } = await connected(tmp, 9223);
    page.emit('download', fakeDownload('photo.jpg'));
    await new Promise(r => setTimeout(r, 20));
    expect(driver.takeSavedDownloads()).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
