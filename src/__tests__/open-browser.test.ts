/**
 * `clawdcursor dashboard` opens its one-time link with the OS opener: the URL is one argv element, never a shell string,
 * and only a plain http(s) URL is opened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawn = vi.hoisted(() => vi.fn((_program: string, _args: string[], _opts: unknown) => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock('child_process', () => ({ spawn }));

import { openInDefaultBrowser } from '../platform/open-browser';

beforeEach(() => { spawn.mockClear(); });

describe('openInDefaultBrowser', () => {
  it('opens an http link as a single argument', () => {
    const url = `http://127.0.0.1:3847/?k=${'a'.repeat(64)}`;
    expect(openInDefaultBrowser(url)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [program, args] = spawn.mock.calls[0];
    expect(args[args.length - 1]).toBe(url);
    if (process.platform === 'win32') expect(program).toMatch(/[\\/]System32[\\/]rundll32\.exe$/i);
    else expect(program).toBe(process.platform === 'darwin' ? 'open' : 'xdg-open');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'C:\\Windows\\System32\\calc.exe', '-a Terminal', 'http://x/ y', 'http://x/"&calc', ''])(
    'opens nothing for %j', (url) => {
      expect(openInDefaultBrowser(url)).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
