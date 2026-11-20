/**
 * What the agent's browser downloads is kept in the user's Downloads folder under its own name, and the next tool result
 * says where (owner, 2026-11-20: Playwright's temp folder, random names and no extension, hid a downloaded picture).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({ browser: null as unknown }));
vi.mock('playwright', () => ({ chromium: { connectOverCDP: vi.fn(async () => h.browser) } }));

import { CDPDriver, downloadsDir, freeDownloadPath } from '../platform/cdp-driver';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-dl-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const fakePage = () => Object.assign(new EventEmitter(), { url: () => 'https://upload.wikimedia.org/a.jpg', title: async () => 'a.jpg' });
/** A download Playwright reports: saveAs writes the finished file where it is told. */
const fakeDownload = (name: string) => ({ suggestedFilename: () => name, saveAs: async (to: string) => fs.writeFileSync(to, 'jpg') });

describe('the Downloads folder, on every OS', () => {
  it('is ~/Downloads on Windows and macOS', () => {
    expect(downloadsDir(tmp, 'win32')).toBe(path.join(tmp, 'Downloads'));
    expect(downloadsDir(tmp, 'darwin')).toBe(path.join(tmp, 'Downloads'));
  });

  it('on Linux is the folder user-dirs.dirs names, else ~/Downloads', () => {
    expect(downloadsDir(tmp, 'linux')).toBe(path.join(tmp, 'Downloads'));
    fs.mkdirSync(path.join(tmp, '.config'));
    fs.writeFileSync(path.join(tmp, '.config', 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n');
    expect(downloadsDir(tmp, 'linux')).toBe(`${tmp}/Téléchargements`);
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

  it('never leaves the folder, and drops characters a file name cannot hold', () => {
    expect(freeDownloadPath(tmp, '../../evil.jpg')).toBe(path.join(tmp, 'evil.jpg'));
    expect(freeDownloadPath(tmp, 'C:\\Windows\\evil.jpg')).toBe(path.join(tmp, 'evil.jpg'));
    expect(freeDownloadPath(tmp, '..')).toBe(path.join(tmp, 'download'));
    expect(freeDownloadPath(tmp, '')).toBe(path.join(tmp, 'download'));
    expect(freeDownloadPath(tmp, 'a?b*c.jpg')).toBe(path.join(tmp, 'a_b_c.jpg'));
  });
});

describe('the agent\'s browser keeps its downloads', () => {
  it('a download on an open page, or on one opened later, lands in Downloads under its own name, named once', async () => {
    const page = fakePage();
    const context = Object.assign(new EventEmitter(), { pages: () => [page] });
    h.browser = { contexts: () => [context] };
    const driver = new CDPDriver(9223);
    const dir = path.join(tmp, 'Downloads');   // created on the first download
    driver.__setDownloadsDirForTests(dir);
    expect(await driver.connect()).toBe(true);

    page.emit('download', fakeDownload('Hopetoun_falls.jpg'));
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, 'Hopetoun_falls.jpg'))).toBe(true));
    expect(driver.takeSavedDownloads()).toEqual([path.join(dir, 'Hopetoun_falls.jpg')]);
    expect(driver.takeSavedDownloads()).toEqual([]);   // named once

    const later = fakePage();
    context.emit('page', later);
    later.emit('download', fakeDownload('Hopetoun_falls.jpg'));
    await vi.waitFor(() => expect(driver.takeSavedDownloads()).toEqual([path.join(dir, 'Hopetoun_falls (1).jpg')]));
  });

  it('a download that fails keeps nothing and names nothing', async () => {
    const page = fakePage();
    h.browser = { contexts: () => [Object.assign(new EventEmitter(), { pages: () => [page] })] };
    const driver = new CDPDriver(9223);
    driver.__setDownloadsDirForTests(tmp);
    await driver.connect();
    page.emit('download', { suggestedFilename: () => 'x.jpg', saveAs: async () => { throw new Error('canceled'); } });
    await new Promise(r => setTimeout(r, 20));
    expect(driver.takeSavedDownloads()).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
