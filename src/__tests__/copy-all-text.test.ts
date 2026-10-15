/**
 * system copy_all_text — exact page text via select-all + copy, clipboard
 * restored. Field session (Stripe in Edge): OCR read `l` as `1` and `Ko4Wn`
 * as `K04Wn`; ctrl+A / ctrl+C / clipboard_read got every ID right.
 */
import { describe, it, expect, vi } from 'vitest';
import { copyAllText, isTerminalWindow } from '../platform/copy-all-text';

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
