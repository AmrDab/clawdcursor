/**
 * Focusing a window must not change its size, zoom or full-screen state — and, like Windows, must bring a MINIMIZED window
 * back (clearing AXMinimized returns it to the size and zoom it had; nothing else is touched).
 *
 * Windows' focus used SW_RESTORE, which also un-maximized a maximized window (fixed in cc92dc7). The macOS path
 * (scripts/mac/focus-window.jxa: process frontmost, window focused, app.activate(), AXRaise) has no such side effect;
 * this pins it, and adds the un-minimize the Windows path has.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { getPackageRoot } from '../paths';

const read = (...p: string[]) => readFileSync(join(getPackageRoot(), ...p), 'utf8');
const stripComments = (src: string) => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Everything a focus must never do to a window. */
function violations(code: string): string[] {
  const bad: Array<[string, RegExp]> = [
    ['writes size', /\.size\s*=[^=]/],
    ['writes position', /\.position\s*=[^=]/],
    ['writes bounds', /\.bounds\s*=[^=]/],
    ['touches zoom', /zoom/i],
    ['touches full screen', /full[-\s]?screen/i],
    ['sends the full-screen shortcut', /ctrl\+mod\+f|control down.*"f"/i],
  ];
  const found = bad.filter(([, re]) => re.test(code)).map(([what]) => what);
  // AXMinimized may only ever be CLEARED here
  for (const m of code.matchAll(/AXMinimized['"]\)\.value\s*=\s*(\w+)/g)) if (m[1] !== 'false') found.push(`sets AXMinimized to ${m[1]}`);
  return found;
}

describe('the macOS focus path never changes a window\'s size, zoom or full-screen state', () => {
  it('focus-window.jxa', () => {
    expect(violations(stripComments(read('scripts', 'mac', 'focus-window.jxa')))).toEqual([]);
  });

  it('the accessibility helper\'s focus command (cmdFocus in ax-helper.swift)', () => {
    const src = stripComments(read('scripts', 'mac', 'ax-helper.swift'));
    const start = src.indexOf('func cmdFocus()');
    const body = src.slice(start, src.indexOf('\nfunc ', start + 10));
    expect(body.length).toBeGreaterThan(500);
    for (const forbidden of ['AXZoom', 'AXFullScreen', 'zoom', 'fullScreen', 'setFrame']) expect(body, forbidden).not.toContain(forbidden);   // (reading AXSize / AXPosition is fine; the writes are listed below)
    // the only window attribute it writes besides raising is AXMinimized, and only to false
    const writes = [...body.matchAll(/AXUIElementSetAttributeValue\([^,]+,\s*"(\w+)" as CFString,\s*(\w+)\)/g)].map(m => `${m[1]}=${m[2]}`);
    expect(writes.sort()).toEqual(['AXFrontmost=kCFBooleanTrue', 'AXMain=kCFBooleanTrue', 'AXMinimized=kCFBooleanFalse']);
  });

  it('MacOSAdapter.focusWindow calls no state-changing helper', () => {
    const src = read('src', 'platform', 'macos.ts');
    const start = src.indexOf('async focusWindow(');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    expect(body.length).toBeGreaterThan(200);
    for (const forbidden of ['setWindowState', 'setWindowBounds', 'maximizeWindow', 'keyPress']) expect(body).not.toContain(forbidden);
  });

  it('the guard itself catches what it guards against', () => {
    expect(violations('win.size = [100, 100];')).toContain('writes size');
    expect(violations('win.position = [0, 0];')).toContain('writes position');
    expect(violations("win.actions.byName('AXZoomButton').perform()")).toContain('touches zoom');
    expect(violations("win.attributes.byName('AXFullScreen').value = true")).toContain('touches full screen');
    expect(violations("win.attributes.byName('AXMinimized').value = true;")).toContain('sets AXMinimized to true');
    expect(violations("win.attributes.byName('AXMinimized').value = false;")).toEqual([]);
  });
});

// ─── behaviour against a fake System Events ─────────────────────────────────

interface FakeWin { title: string; w: number; h: number; minimized?: boolean; main?: boolean; focused?: boolean }

function harness(wins: FakeWin[]) {
  const log: string[] = [];
  const state = wins.map(f => ({ ...f, minimized: f.minimized ?? false }));
  const fakeWindows = state.map((f, i) => {
    const win: any = {
      name: () => f.title,
      position: () => [10, 20],
      size: () => [f.w, f.h],
      subrole: () => 'AXStandardWindow',
      actions: { byName: (n: string) => ({ perform: () => { log.push(`perform:${f.title}:${n}`); } }) },
      attributes: {
        byName: (n: string) => {
          const attr: any = {};
          const read = () => (n === 'AXMinimized' ? f.minimized : n === 'AXMain' ? f.main ?? false : n === 'AXFocused' ? f.focused ?? false : n === 'AXSubrole' ? 'AXStandardWindow' : undefined);
          Object.defineProperty(attr, 'value', { get: () => read, set: (v: unknown) => { log.push(`set:${f.title}:${n}=${String(v)}`); if (n === 'AXMinimized') f.minimized = v as boolean; } });
          return attr;
        },
      },
    };
    // size / position / bounds must never be written
    for (const prop of ['size', 'position', 'bounds'] as const) {
      const original = win[prop];
      Object.defineProperty(win, prop, { get: () => original ?? (() => undefined), set: () => { log.push(`WRITE:${prop}`); } });
    }
    // JXA lets a script set `window.focused = true`
    Object.defineProperty(win, 'focused', { get: () => () => f.focused ?? false, set: (v: unknown) => { log.push(`set:${f.title}:focused=${String(v)}`); } });
    void i;
    return win;
  });
  const proc: any = {
    unixId: () => 4242, name: () => 'TextEdit', windows: fakeWindows,
  };
  Object.defineProperty(proc, 'frontmost', { get: () => () => false, set: (v: unknown) => { log.push(`set:process:frontmost=${String(v)}`); } });
  const se = { processes: { where: () => [proc] }, includeStandardAdditions: false };
  const app = { activate: () => { log.push('activate'); } };
  const ctx = vm.createContext({ Application: (n?: string) => (n === 'System Events' ? se : app), JSON, Date, String, Number, Math, Array, Object, parseInt });
  const src = read('scripts', 'mac', 'focus-window.jxa').replace(/^#!.*\n/, '');
  const run = (argv: string[]) => JSON.parse(vm.runInContext(`${src}\nrun(${JSON.stringify(argv)})`, ctx));
  return { run, log, state };
}

describe('focus-window.jxa — what it does to the window it focuses', () => {
  it('raises and activates; never writes size, position or bounds', () => {
    const h = harness([{ title: 'Doc', w: 1440, h: 900, main: true, focused: true }]);
    const r = h.run(['-processId', '4242']);
    expect(r.success).toBe(true);
    expect(h.log).toContain('perform:Doc:AXRaise');
    expect(h.log).toContain('activate');
    expect(h.log.filter(l => l.startsWith('WRITE:'))).toEqual([]);
  });

  it('a window that is not minimized is left alone (no AXMinimized write at all)', () => {
    const h = harness([{ title: 'Doc', w: 1440, h: 900, main: true }]);
    h.run(['-processId', '4242']);
    expect(h.log.filter(l => l.includes('AXMinimized'))).toEqual([]);
  });

  it('a minimized window is brought back: AXMinimized cleared, and nothing else about its geometry touched', () => {
    const h = harness([{ title: 'Doc', w: 1440, h: 900, minimized: true }]);
    const r = h.run(['-processId', '4242', '-title', 'Doc']);
    expect(r.success).toBe(true);
    expect(h.log).toContain('set:Doc:AXMinimized=false');
    expect(h.state[0].minimized).toBe(false);
    expect(h.log.filter(l => l.startsWith('WRITE:'))).toEqual([]);
    expect(h.log.indexOf('set:Doc:AXMinimized=false')).toBeLessThan(h.log.indexOf('perform:Doc:AXRaise'));   // un-minimize, THEN raise
  });

  it('with no title, a visible window is preferred over a minimized one — focus does not resurrect a window the user put away', () => {
    const h = harness([
      { title: 'Put away', w: 1600, h: 1000, minimized: true },
      { title: 'On screen', w: 700, h: 500 },
    ]);
    const r = h.run(['-processId', '4242']);
    expect(r.title).toBe('On screen');
    expect(h.log.filter(l => l.includes('AXMinimized'))).toEqual([]);
    expect(h.state[0].minimized).toBe(true);
  });

  it('when the only window is minimized it is restored', () => {
    const h = harness([{ title: 'Only', w: 700, h: 500, minimized: true }]);
    expect(h.run(['-processId', '4242']).success).toBe(true);
    expect(h.state[0].minimized).toBe(false);
  });
});
