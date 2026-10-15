/**
 * get-foreground-window.jxa — the osascript fallback for "which window has the keyboard".
 *
 * It scored the frontmost app's windows by AREA (plus a bonus for standard windows), so with two
 * documents open it answered the big one ("Untitled 4", 2257×1140) while the user was typing in
 * the small one ("Untitled 7", 603×505, AXMain=true): `window active` named the wrong window and
 * smart_click warned "matched outside focused window" for the menu bar. The app's own AXMain /
 * AXFocused flag is the truth; area scoring stays only for apps that expose neither.
 *
 * (The compiled helper does this natively — see mac-ax-live.test.ts; this is the path used when
 * the helper cannot be built.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { getPackageRoot } from '../paths';

interface FakeWin { title: string; w: number; h: number; subrole?: string; main?: boolean; focused?: boolean }

function fakeWindow(f: FakeWin) {
  const flags: Record<string, unknown> = { AXMain: f.main ?? false, AXFocused: f.focused ?? false, AXSubrole: f.subrole ?? 'AXStandardWindow' };
  return {
    name: () => f.title,
    position: () => [10, 20],
    size: () => [f.w, f.h],
    subrole: () => f.subrole ?? 'AXStandardWindow',
    attributes: { byName: (n: string) => ({ value: () => flags[n] }) },
  };
}

function runForeground(wins: FakeWin[]) {
  const proc = { unixId: () => 4242, name: () => 'TextEdit', windows: wins.map(fakeWindow) };
  const app = { processes: { where: () => [proc] }, includeStandardAdditions: false };
  const ctx = vm.createContext({ Application: () => app, JSON, Date, String, Number, Math, Array, Object });
  const src = readFileSync(join(getPackageRoot(), 'scripts', 'mac', 'get-foreground-window.jxa'), 'utf8').replace(/^#!.*\n/, '');
  return JSON.parse(vm.runInContext(`${src}\nrun([])`, ctx));
}

describe('get-foreground-window.jxa — the window the app calls main', () => {
  it('B3: picks the AXMain window, not the biggest one', () => {
    const r = runForeground([
      { title: 'Untitled 4', w: 2257, h: 1140 },
      { title: 'Untitled 7', w: 603, h: 505, main: true },
    ]);
    expect(r).toMatchObject({ success: true, processId: 4242, title: 'Untitled 7', bounds: { width: 603, height: 505 } });
  });

  it('when the main window and the focused window differ, the focused one wins — it has the keyboard (same rule as the helper)', () => {
    const r = runForeground([
      { title: 'Document', w: 900, h: 700, main: true },
      { title: 'Find', w: 300, h: 120, focused: true },
    ]);
    expect(r.title).toBe('Find');
  });

  it('falls back to the AXFocused window when none is main', () => {
    const r = runForeground([
      { title: 'Big', w: 1600, h: 900 },
      { title: 'Focused one', w: 500, h: 400, focused: true },
    ]);
    expect(r.title).toBe('Focused one');
  });

  it('a floating panel that is larger than the main window never wins (the #101 "Downloads" popup case)', () => {
    const r = runForeground([
      { title: 'Downloads', w: 1200, h: 800, subrole: 'AXFloatingWindow' },
      { title: 'Project', w: 700, h: 500, main: true },
    ]);
    expect(r.title).toBe('Project');
  });

  it('with neither flag exposed, the old area scoring still picks the standard window', () => {
    const r = runForeground([
      { title: 'Downloads', w: 1200, h: 800, subrole: 'AXFloatingWindow' },
      { title: 'Document', w: 700, h: 500 },
    ]);
    expect(r.title).toBe('Document');
  });
});
