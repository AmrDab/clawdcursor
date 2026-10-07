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

  it('isTerminalWindow does not flag ordinary apps', () => {
    expect(isTerminalWindow({ processName: 'msedge' })).toBe(false);
    expect(isTerminalWindow({ processName: 'Code' })).toBe(false);
    expect(isTerminalWindow({ processName: 'notepad' })).toBe(false);
  });
});
