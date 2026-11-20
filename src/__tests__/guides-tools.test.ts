/** shortcuts_list with a guide, and the once-per-app hint. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getShortcutTools } from '../tools/shortcuts';
import { getExtraTools } from '../tools/extras';
import { guideHint, resetGuideHints, setGuideSurface } from '../core/guides/hint';
import { __setGuidePathsForTests, loadGuides } from '../core/guides/store';
import { renderGuide } from '../core/guides/render';
import { toCompactNames } from '../tools/compact';
import type { ToolContext } from '../tools/types';

const tool = (name: string) => getShortcutTools().find(t => t.name === name)!;
const ctx = {} as ToolContext;

const gmail = {
  app: 'gmail', name: 'Gmail', kind: 'web', domainHints: ['mail.google.com'],
  shortcuts: { compose: 'c', go_to_inbox: 'g i', send: { default: 'mod+Return' }, find_in_page: { win32: 'ctrl+f', darwin: 'cmd+f', linux: '' }, mark_unread: 'shift+u' },
  consequential: ['send'],
  workflows: { compose_and_send: { name: 'compose and send an email', steps: [{ type: 'pressKey', key: 'c' }, { type: 'typeAtFocus', field: 'recipient' }, { type: 'pressKey', key: 'mod+Return' }] } },
  tips: ['Single-letter shortcuts need keyboard shortcuts turned on in settings.'],
  sources: ['https://support.google.com/mail/answer/6594'], lastVerified: '2026-11-18',
};

let dir: string;
const paths = () => ({ bundledFile: path.join(dir, 'bundled.json') });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-tools-'));
  __setGuidePathsForTests(paths());
  fs.writeFileSync(paths().bundledFile, JSON.stringify({ schemaVersion: 2, generatedAt: 'x', guides: { gmail } }));
  resetGuideHints();
});
afterEach(() => {
  __setGuidePathsForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shortcuts_list with a guide', () => {
  const list = async (args: Record<string, unknown>) => (await tool('shortcuts_list').handler(args, ctx)).text;
  const render = (platform: string, query?: string) => renderGuide(loadGuides().get('gmail')!, platform, query);

  it('returns the guide first, chords resolved for this OS, consequential marked, one line per shortcut', () => {
    const win = render('win32');
    expect(win.split('\n')[0]).toBe('Gmail guide (web mail.google.com; verified 2026-11-18; Windows): 5 shortcuts');
    expect(win).toContain('send *: ctrl+Return');
    expect(win).toContain('find_in_page: ctrl+f');
    expect(win).toContain('go_to_inbox: g i');
    expect(win).toContain('compose_and_send: compose and send an email -> c, type <recipient>, ctrl+Return');   // workflow keys too
    expect(win).toContain('- Single-letter shortcuts');
    expect(win).not.toContain('<untrusted-screen-content>');
    const mac = render('darwin');
    expect(mac).toContain('send *: cmd+Return');
    expect(mac).toContain('find_in_page: cmd+f');
    expect(mac).toContain('-> c, type <recipient>, cmd+Return');
    expect(render('linux')).not.toContain('find_in_page');   // "" = not on that OS
  });

  it('the tool returns the guide for an app id, a name or a site, before anything else', async () => {
    for (const context of ['gmail', 'Gmail', 'mail.google.com', 'https://mail.google.com/mail/u/0']) {
      expect((await list({ context })).startsWith('Gmail guide (web mail.google.com; verified 2026-11-18;')).toBe(true);
    }
  });

  it('query keeps only the matching shortcuts', async () => {
    const t = render('win32', 'inbox');
    expect(t).toContain('1 of 5 shortcuts for "inbox"');
    expect(t).toContain('go_to_inbox: g i');
    expect(t).not.toContain('compose:');
    expect(t).not.toContain('Tips:');
    expect(await list({ context: 'gmail', query: 'inbox' })).toContain('1 of ');
  });

  it('a context with no guide behaves as before', async () => {
    expect(await list({ context: 'no-such-app-xyz' })).not.toContain('guide');
  });
});

describe('guide hint', () => {
  it('one line, once per app per session, from a process name, a url or a window title', () => {
    expect(guideHint({ names: ['notepad'] })).toBe('');
    expect(guideHint({ url: 'https://mail.google.com/mail/u/0/' }, 'win32')).toBe('guide: Gmail keys (Windows): compose c · go_to_inbox g i · send* ctrl+Return · find_in_page ctrl+f · mark_unread shift+u (* = hard to undo). All 5 shortcuts, 1 workflows and tips: the shortcuts_list tool, context gmail');
    expect(guideHint({ url: 'https://mail.google.com/' })).toBe('');
    resetGuideHints();
    expect(guideHint({ names: ['x'], title: 'Inbox - Gmail - Google Chrome' })).toContain('guide: Gmail');
    expect(guideHint({ names: ['x'], title: 'Inbox - Gmail' })).toBe('');
  });
});

describe('guide hint: the pointer to the full guide', () => {
  afterEach(() => setGuideSurface(false));

  it('is prose naming the tool of the surface, never a call to copy; the compact rewrite leaves it as written', () => {
    expect(guideHint({ url: 'https://mail.google.com/' })).toContain('tips: the shortcuts_list tool, context gmail');
    resetGuideHints();
    setGuideSurface(true);
    const h = guideHint({ url: 'https://mail.google.com/' });
    expect(h).toContain('tips: the system tool, action shortcuts_list, context gmail');
    expect(toCompactNames(h, 'system')).toBe(h);
    expect(h).not.toContain('{');
  });
});

describe('guide hint: the keys', () => {
  const put = (over: Record<string, unknown>) => {
    fs.writeFileSync(paths().bundledFile, JSON.stringify({ schemaVersion: 2, generatedAt: 'x', guides: { gmail: { ...gmail, ...over } } }));
    __setGuidePathsForTests(paths()); resetGuideHints();
  };
  const url = { url: 'https://mail.google.com/' };
  const rest = 'All 5 shortcuts, 1 workflows and tips: the shortcuts_list tool, context gmail';

  it('essentials in their order, resolved per OS: mod, a skipped key, * on a consequential one', () => {
    put({ essentials: ['send', 'find_in_page', 'compose'] });
    expect(guideHint(url, 'win32')).toBe(`guide: Gmail keys (Windows): send* ctrl+Return · find_in_page ctrl+f · compose c (* = hard to undo). ${rest}`);
    resetGuideHints();
    expect(guideHint(url, 'darwin')).toBe(`guide: Gmail keys (macOS): send* cmd+Return · find_in_page cmd+f · compose c (* = hard to undo). ${rest}`);
    // linux has no key for find_in_page: skipped; nothing marked is shown, so no * legend
    put({ essentials: ['find_in_page', 'compose'] });
    expect(guideHint(url, 'linux')).toBe(`guide: Gmail keys (Linux): compose c. ${rest}`);
  });

  it('without essentials, the first 8 shortcuts in file order', () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`key_${i}`, `ctrl+${i}`]));
    put({ shortcuts: many, consequential: [] });
    const h = guideHint(url, 'win32');
    expect(h).toContain('key_0 ctrl+0 · key_1 ctrl+1');
    expect(h).toContain('key_7 ctrl+7. All 10 shortcuts');
    expect(h).not.toContain('key_8');
  });

  it('a name that is also a tool name is shown as words, so the compact surface does not rewrite it', () => {
    put({ shortcuts: { close_window: 'mod+w', compose: 'c' }, consequential: ['close_window'] });
    expect(guideHint(url, 'win32')).toContain('keys (Windows): close window* ctrl+w · compose c');
    // the full guide too
    const full = renderGuide(loadGuides().get('gmail')!, 'win32');
    expect(full).toContain('close window *: ctrl+w');
    expect(full).not.toContain('close_window');
  });

});

describe('guide hint on open_file', () => {
  const ctxFor = (platform: string, res: Record<string, unknown> = {}): ToolContext => ({
    ensureInitialized: async () => {},
    platform: { platform, launchApp: vi.fn(async () => res) },
  }) as unknown as ToolContext;
  const openFile = getExtraTools().find(t => t.name === 'open_file')!;
  const desk = (app: string, name: string, os: string, proc: string, chord: string) =>
    ({ app, name, kind: 'desktop', os: [os], processNames: [proc], shortcuts: { new_item: chord }, sources: gmail.sources, lastVerified: gmail.lastVerified });
  beforeEach(() => {
    const guides = { 'file-explorer': desk('file-explorer', 'File Explorer', 'win32', 'explorer', 'ctrl+n'), finder: desk('finder', 'Finder', 'darwin', 'Finder', 'mod+n'), notepad: desk('notepad', 'Notepad', 'win32', 'notepad', 'mod+n') };
    fs.writeFileSync(paths().bundledFile, JSON.stringify({ schemaVersion: 2, generatedAt: 'x', guides }));
    __setGuidePathsForTests(paths()); resetGuideHints();
  });

  it('a folder on Windows: the File Explorer guide, once per app', async () => {
    const leaf = dir.split(/[\/]/).pop()!;
    const res = { title: `${leaf} - File Explorer`, pid: 5 };
    expect((await openFile.handler({ path: dir }, ctxFor('win32', res))).text).toContain('guide: File Explorer keys (Windows): new_item ctrl+n.');
    expect((await openFile.handler({ path: dir }, ctxFor('win32', res))).text).not.toContain('guide:');
  });

  it('a program on Windows: the guide of the program the open reports', async () => {
    const notepad = path.join(dir, 'notepad.exe');   // a real file on every OS: CI runs Linux
    fs.writeFileSync(notepad, '');
    const r = await openFile.handler({ path: notepad }, ctxFor('win32', { title: 'Untitled - Notepad', pid: 7 }));
    expect(r.text).toContain('guide: Notepad keys (Windows): new_item ctrl+n.');
  });

  it('a document: the result names no app, so no hint and no extra read', async () => {
    expect((await openFile.handler({ path: 'C:/docs/a.txt' }, ctxFor('win32'))).text).not.toContain('guide');
  });

  it('a folder on macOS: the Finder guide', async () => {
    expect((await openFile.handler({ path: dir }, ctxFor('darwin'))).text).toContain('guide: Finder keys (macOS): new_item cmd+n.');
  });
});
