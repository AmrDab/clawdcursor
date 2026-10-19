/**
 * system copy_all_text — exact page text via select-all + copy, clipboard
 * restored. Field session (Stripe in Edge): OCR read `l` as `1` and `Ko4Wn`
 * as `K04Wn`; ctrl+A / ctrl+C / clipboard_read got every ID right.
 */
import { describe, it, expect, vi } from 'vitest';
import { copyAllText, isTerminalWindow, selectAllHazard } from '../platform/copy-all-text';

function fakePlatform(opts: { processName: string; pageText?: string | null; prior?: string }) {
  let clip = opts.prior ?? 'user clipboard';
  const keys: string[] = [];
  return {
    keys,
    get clip() { return clip; },
    getActiveWindow: vi.fn(async () => ({ processName: opts.processName, title: 'Stripe', processId: 1 } as any)),
    keyPress: vi.fn(async (k: string) => {
      keys.push(k);
      if (k === 'mod+c' && opts.pageText !== null) clip = opts.pageText ?? 'page text';
    }),
    readClipboard: vi.fn(async () => clip),
    writeClipboard: vi.fn(async (t: string) => { clip = t; }),
  };
}

describe('copyAllText', () => {
  it('returns the exact page text and restores the user clipboard', async () => {
    const p = fakePlatform({ processName: 'msedge', pageText: 'price_1TcLWTCMmq8Ko4WnKwK37pVL $29.99' });
    const r = await copyAllText(p as any);
    expect(r).toMatchObject({ ok: true, text: 'price_1TcLWTCMmq8Ko4WnKwK37pVL $29.99' });
    expect(p.keys).toEqual(['mod+a', 'mod+c']);
    expect(p.clip).toBe('user clipboard');
  });

  it('refuses in a terminal without pressing anything (Ctrl+C would interrupt it)', async () => {
    for (const name of ['WindowsTerminal', 'pwsh.exe', 'iTerm2', 'gnome-terminal-server', 'Terminal']) {
      const p = fakePlatform({ processName: name });
      const r = await copyAllText(p as any);
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/terminal/i);
      expect(p.keys).toEqual([]);
    }
  });

  it('reports "nothing copied" instead of returning stale clipboard text', async () => {
    const p = fakePlatform({ processName: 'someapp', pageText: null, prior: 'old secret' });
    const r = await copyAllText(p as any);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Nothing was copied/);
    expect(r.text).not.toContain('old secret');
    expect(p.clip).toBe('old secret');
  });

  it('window class decides for shell-owned windows (Windows)', () => {
    expect(isTerminalWindow({ processName: 'powershell', className: 'ConsoleWindowClass' })).toBe(true);
    expect(isTerminalWindow({ processName: 'WindowsTerminal', className: 'CASCADIA_HOSTING_WINDOW_CLASS' })).toBe(true);
    // a WinForms window owned by powershell.exe is an ordinary GUI window
    expect(isTerminalWindow({ processName: 'powershell', className: 'WindowsForms10.Window.8.app.0.141b42a_r6_ad1' })).toBe(false);
    // no class known (other OSes): conservative process check
    expect(isTerminalWindow({ processName: 'powershell' })).toBe(true);
  });

  it('isTerminalWindow does not flag ordinary apps', () => {
    expect(isTerminalWindow({ processName: 'msedge' })).toBe(false);
    expect(isTerminalWindow({ processName: 'Code' })).toBe(false);
    expect(isTerminalWindow({ processName: 'notepad' })).toBe(false);
  });

  // Live Win11 re-test 2026-10-15: copy_all_text in Settings (a UWP/XAML page)
  // took 13.4 s — 15 clipboard polls, each a PowerShell spawn — then said
  // "Nothing was copied". A XAML page has no select-all; its text is in the
  // accessibility tree.
  const tree = [
    { name: 'Settings', controlType: 'Window', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { name: 'Edition', controlType: 'Text', bounds: { x: 0, y: 0, width: 0, height: 0 } },
    { name: 'Windows 11 Pro', controlType: 'Text', bounds: { x: 0, y: 0, width: 0, height: 0 } },
    { name: 'Search box', controlType: 'Edit', value: 'about', bounds: { x: 1, y: 1, width: 9, height: 9 } },
    { name: '', controlType: 'Pane', bounds: { x: 1, y: 1, width: 9, height: 9 } },
  ];

  it('a UWP / XAML window skips select-all and returns its accessibility text, saying so', async () => {
    const p = { ...fakePlatform({ processName: 'ApplicationFrameHost' }), getUiTree: vi.fn(async () => tree) };
    p.getActiveWindow = vi.fn(async () => ({ processName: 'ApplicationFrameHost', title: 'Settings', processId: 4, className: 'ApplicationFrameWindow' } as any));
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('accessibility');
    expect(r.text).toContain('Windows 11 Pro');
    expect(r.text).toContain('Search box: about');
  });

  it('falls back to accessibility text when nothing was copied', async () => {
    const p = { ...fakePlatform({ processName: 'someapp', pageText: null }), getUiTree: vi.fn(async () => tree) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual(['mod+a', 'mod+c']);
    expect(r).toMatchObject({ ok: true, source: 'accessibility' });
    expect(r.text).toContain('Edition');
  });

  // #249: Ctrl+A acts on whatever has focus. In an editor it selected the whole document and left it selected, so the
  // agent's next keystroke replaced all of it; in a mail list it selected every message.
  const withFocus = (processName: string, focused: unknown) => ({
    ...fakePlatform({ processName }),
    getUiTree: vi.fn(async () => tree),
    getFocusedElement: vi.fn(async () => focused as any),
  });

  it.each([
    ['notepad', { controlType: 'Edit', name: 'Text editor' }, /editable field/],
    ['notepad', { controlType: 'ControlType.Document', name: 'Text editor' }, /document/],
    ['WINWORD', { controlType: 'Document', name: 'Report.docx' }, /document/],
    ['msedge', { controlType: 'Edit', name: 'Address and search bar' }, /editable field/],
    ['olk', { controlType: 'ListItem', name: 'Inbox message from Sarah' }, /every item/],
    ['explorer', { controlType: 'DataItem', name: 'report.pdf' }, /every item/],
  ])('%s with focus on %o: no select-all, accessibility text instead, and it says why', async (proc, focused, why) => {
    const p = withFocus(proc, focused);
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(r).toMatchObject({ ok: true, source: 'accessibility' });
    expect(r.text).toMatch(/not pressing Ctrl\+A/);
    expect(r.text).toMatch(why);
    expect(p.clip).toBe('user clipboard');
  });

  it('a hazard with an empty accessibility tree refuses rather than pressing Ctrl+A', async () => {
    const p = { ...withFocus('notepad', { controlType: 'Edit', name: 'Text editor' }), getUiTree: vi.fn(async () => []) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Not pressing Ctrl\+A/);
  });

  it('a web page (the browser document has focus) is still copied exactly, and the result says the page is now selected', async () => {
    const p = withFocus('msedge', { controlType: 'Document', name: 'Glama' });
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual(['mod+a', 'mod+c']);
    expect(r).toMatchObject({ ok: true, source: 'clipboard', text: 'page text' });
    expect(r.note).toMatch(/now selected/);
  });

  it('unknown focus (no reading, or it failed) does not block the copy', async () => {
    const p = { ...fakePlatform({ processName: 'msedge' }), getFocusedElement: vi.fn(async () => { throw new Error('bridge down'); }) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual(['mod+a', 'mod+c']);
    expect(r.ok).toBe(true);
  });

  it('an Electron app that reports its focus as a bare Pane is not select-all\'d (live: the Claude app\'s prompt read as "Pane")', async () => {
    const p = withFocus('claude', { controlType: 'Pane', name: '' });
    p.getActiveWindow = vi.fn(async () => ({ processName: 'claude', title: 'Claude', processId: 9, className: 'Chrome_WidgetWin_1' } as any));
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(r.text).toMatch(/Electron app/);
    // a browser with the same window class is a page, not an Electron app
    expect(selectAllHazard({ controlType: 'Document', name: 'page' }, 'msedge', 'Chrome_WidgetWin_1')).toBeNull();
    expect(selectAllHazard({ controlType: 'Pane', name: '' }, 'chrome', 'Chrome_WidgetWin_1')).toBeNull();
    // an Electron app that DOES expose its focus is judged by the role, as everywhere else
    expect(selectAllHazard({ controlType: 'Edit', name: 'Message' }, 'slack', 'Chrome_WidgetWin_1')).toMatch(/editable/);
  });

  it('reads the document through accessibility first: no keystrokes, nothing selected, clipboard untouched', async () => {
    const p = { ...withFocus('msedge', { controlType: 'Document', name: 'Stripe' }), getPageText: vi.fn(async () => ({ text: 'price_1TcLWT $29.99', name: 'Stripe' })) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(p.writeClipboard).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, source: 'document', text: 'price_1TcLWT $29.99' });
    expect(r.note).toBeUndefined();
  });

  it('an editor read through its document needs no refusal: the full text, still no keys', async () => {
    const p = { ...withFocus('notepad', { controlType: 'Document', name: 'Text editor' }), getPageText: vi.fn(async () => ({ text: 'line one\nline two' })) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(r).toMatchObject({ ok: true, source: 'document', text: 'line one\nline two' });
  });

  it('an empty or failing document read falls through to the guarded select-all path', async () => {
    for (const getPageText of [vi.fn(async () => ({ text: '  ' })), vi.fn(async () => null), vi.fn(async () => { throw new Error('bridge down'); })]) {
      const p = { ...withFocus('msedge', { controlType: 'Document', name: 'page' }), getPageText };
      const r = await copyAllText(p as any);
      expect(p.keys).toEqual(['mod+a', 'mod+c']);
      expect(r.source).toBe('clipboard');
    }
  });

  it('selectAllHazard: page-like roles are safe', () => {
    for (const role of ['Pane', 'Window', 'Group', 'Hyperlink', 'Button', 'Text', 'Custom']) {
      expect(selectAllHazard({ controlType: role, name: 'x' }, 'someapp')).toBeNull();
    }
    expect(selectAllHazard({ controlType: 'Document', name: 'page' }, 'chrome.exe')).toBeNull();
    expect(selectAllHazard({ controlType: 'Document', name: 'page' }, 'Google Chrome')).toBeNull();
    expect(selectAllHazard(null, 'notepad')).toBeNull();
  });

  it('gives up on the clipboard within ~2 s even when each read is slow', async () => {
    const p = fakePlatform({ processName: 'someapp', pageText: null });
    const slow = p.readClipboard;
    p.readClipboard = vi.fn(async () => { await new Promise(r => setTimeout(r, 300)); return slow(); });
    const t0 = Date.now();
    const r = await copyAllText(p as any);
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2600);
  });
});
