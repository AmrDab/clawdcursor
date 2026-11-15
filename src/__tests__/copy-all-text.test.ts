/**
 * system copy_all_text: the exact text of a page or document through accessibility, never select-all + copy. Field
 * session (Stripe in Edge): OCR read `l` as `1` and `Ko4Wn` as `K04Wn`; the document's text got every ID right. The
 * select-all fallback for browser pages turned the whole page blue on screen (owner, 2026-11-15): it is gone.
 */
import { describe, it, expect, vi } from 'vitest';
import { copyAllText, isTerminalWindow } from '../platform/copy-all-text';

function fakePlatform(opts: { processName: string; prior?: string }) {
  const keys: string[] = [];
  return {
    keys,
    getActiveWindow: vi.fn(async () => ({ processName: opts.processName, title: 'Stripe', processId: 1 } as any)),
    keyPress: vi.fn(async (k: string) => { keys.push(k); }),
    readClipboard: vi.fn(async () => opts.prior ?? 'user clipboard'),
    writeClipboard: vi.fn(async () => {}),
  };
}

describe('copyAllText', () => {
  it('refuses in a terminal without pressing anything (Ctrl+C would interrupt it)', async () => {
    for (const name of ['WindowsTerminal', 'pwsh.exe', 'iTerm2', 'gnome-terminal-server', 'Terminal']) {
      const p = fakePlatform({ processName: name });
      const r = await copyAllText(p as any);
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/terminal/i);
      expect(p.keys).toEqual([]);
    }
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

  // Live Win11 re-test 2026-10-15: copy_all_text in Settings (a UWP/XAML page) has no document; its text is in the
  // accessibility tree.
  const tree = [
    { name: 'Settings', controlType: 'Window', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { name: 'Edition', controlType: 'Text', bounds: { x: 0, y: 0, width: 0, height: 0 } },
    { name: 'Windows 11 Pro', controlType: 'Text', bounds: { x: 0, y: 0, width: 0, height: 0 } },
    { name: 'Search box', controlType: 'Edit', value: 'about', bounds: { x: 1, y: 1, width: 9, height: 9 } },
    { name: '', controlType: 'Pane', bounds: { x: 1, y: 1, width: 9, height: 9 } },
  ];

  it('a UWP / XAML window returns its accessibility text, saying so', async () => {
    const p = { ...fakePlatform({ processName: 'ApplicationFrameHost' }), getUiTree: vi.fn(async () => tree) };
    p.getActiveWindow = vi.fn(async () => ({ processName: 'ApplicationFrameHost', title: 'Settings', processId: 4, className: 'ApplicationFrameWindow' } as any));
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.source).toBe('accessibility');
    expect(r.text).toContain('Windows 11 Pro');
    expect(r.text).toContain('Search box: about');
  });

  // Live 2026-11-10 (Siemens NX, a feature selected): a select-all selected every feature and opened NX's own Copy dialog.
  it('without document text the tree is returned as names only, labelled so, and no key is pressed', async () => {
    const p = { ...fakePlatform({ processName: 'someapp' }), getUiTree: vi.fn(async () => tree) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(p.writeClipboard).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, source: 'accessibility' });
    expect(r.text).toMatch(/^\(names only, not the document's text/);
    expect(r.text).toMatch(/Use ocr for the content/);
    expect(r.text).not.toMatch(/PARTIAL/);
    expect(r.text).toContain('Edition');
  });

  it('a truncated tree is marked PARTIAL', async () => {
    const p = { ...fakePlatform({ processName: 'someapp' }), getUiTree: vi.fn(async () => tree), lastTreeTruncated: true };
    const r = await copyAllText(p as any);
    expect(r.text).toMatch(/^\(names only[^\n]*PARTIAL/);
  });

  it.each([
    ['holds no text (a drawn view)', vi.fn(async () => [{ name: '', controlType: 'Window', bounds: { x: 0, y: 0, width: 800, height: 600 } }, { name: ' ', controlType: 'Pane', bounds: { x: 1, y: 1, width: 9, height: 9 } }])],
    ['is empty', vi.fn(async () => [])],
    ['throws (a slow walk timed out)', vi.fn(async () => { throw new Error('PSRunner timeout'); })],
    ['has no reader', undefined],
  ])('a tree that %s refuses and points at ocr: still no key', async (_what, getUiTree) => {
    const p = { ...fakePlatform({ processName: 'someapp' }), ...(getUiTree ? { getUiTree } : {}) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(p.writeClipboard).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/No keys were pressed/);
    expect(r.text).toMatch(/ocr/);
  });

  // #249 and 2026-11-15: in a browser select-all took the whole page (it turned blue) or, with focus in a field, its text.
  it.each([
    ['msedge', { controlType: 'Document', name: 'Glama' }],
    ['msedge', { controlType: 'Edit', name: 'Address and search bar' }],
    ['chrome', null],
    ['Safari', { controlType: 'Document', name: 'page' }],
    ['firefox-esr', { controlType: 'document web', name: 'page' }],
    ['google-chrome-stable', { controlType: 'document web', name: 'page' }],
  ])('a %s page whose document text cannot be read gets no select-all: names only', async (proc, focused) => {
    const p = { ...fakePlatform({ processName: proc }), getUiTree: vi.fn(async () => tree), getFocusedElement: vi.fn(async () => focused as any) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(p.writeClipboard).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, source: 'accessibility' });
    expect(r.text).toMatch(/No keys were pressed/);
  });

  it('reads the document through accessibility: no keystrokes, nothing selected, clipboard untouched', async () => {
    const p = { ...fakePlatform({ processName: 'msedge' }), getPageText: vi.fn(async () => ({ text: 'price_1TcLWT $29.99', name: 'Stripe' })) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(p.writeClipboard).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, source: 'document', text: 'price_1TcLWT $29.99' });
  });

  it('a browser whose document reads empty the first time (Chromium turning its accessibility on) is read again', async () => {
    const getPageText = vi.fn().mockResolvedValueOnce({ text: '' }).mockResolvedValueOnce({ text: 'Order 42 shipped' });
    const p = { ...fakePlatform({ processName: 'chrome' }), getPageText };
    const r = await copyAllText(p as any);
    expect(getPageText).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, source: 'document', text: 'Order 42 shipped' });
    expect(p.keys).toEqual([]);
  });

  it('another app is not read twice: no document means names only at once', async () => {
    const getPageText = vi.fn(async () => null);
    const p = { ...fakePlatform({ processName: 'someapp' }), getPageText, getUiTree: vi.fn(async () => tree) };
    await copyAllText(p as any);
    expect(getPageText).toHaveBeenCalledTimes(1);
  });

  it('an editor read through its document: the full text, no keys', async () => {
    const p = { ...fakePlatform({ processName: 'notepad' }), getPageText: vi.fn(async () => ({ text: 'line one\nline two' })) };
    const r = await copyAllText(p as any);
    expect(p.keys).toEqual([]);
    expect(r).toMatchObject({ ok: true, source: 'document', text: 'line one\nline two' });
  });

  it('text without object marks comes back exactly: blank and space-only lines kept (live macOS run: TextEdit)', async () => {
    const doc = 'line one\n   \n\n\n\nline two';
    const p = { ...fakePlatform({ processName: 'TextEdit' }), getPageText: vi.fn(async () => ({ text: doc })) };
    const r = await copyAllText(p as any);
    expect(r.text).toBe(doc);
  });

  it('embedded-object marks (U+FFFC) are dropped: TextPattern returned whole lines of them (live: GitHub in Edge)', async () => {
    const raw = '￼\r\nSkip to content\r\n￼\r\n￼\r\n￼\r\nCongratulations, you\'re all set!\r\nYour device is now connected.';
    const p = { ...fakePlatform({ processName: 'msedge' }), getPageText: vi.fn(async () => ({ text: raw })) };
    const r = await copyAllText(p as any);
    expect(r.text).not.toContain('￼');
    expect(r.text).toBe('\nSkip to content\n\nCongratulations, you\'re all set!\nYour device is now connected.');
  });

  it('a page that is nothing but object marks counts as empty and falls through, with no key', async () => {
    const p = { ...fakePlatform({ processName: 'msedge' }), getPageText: vi.fn(async () => ({ text: '￼\n￼' })), getUiTree: vi.fn(async () => tree) };
    const r = await copyAllText(p as any);
    expect(r.source).toBe('accessibility');
    expect(p.keys).toEqual([]);
  });

  it('an empty or failing document read falls through to names only: never select-all', async () => {
    for (const getPageText of [vi.fn(async () => ({ text: '  ' })), vi.fn(async () => null), vi.fn(async () => { throw new Error('bridge down'); })]) {
      const p = { ...fakePlatform({ processName: 'msedge' }), getPageText, getUiTree: vi.fn(async () => tree) };
      const r = await copyAllText(p as any);
      expect(p.keys).toEqual([]);
      expect(r.source).toBe('accessibility');
    }
  });
});
