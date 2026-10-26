/**
 * An open popover is visible to read_tree, compile_ui, find_button, find and invoke (issue #273).
 *
 * AppKit exposes an open NSPopover (AXPopover) as a child of the control that presented it: in Freeform, the
 * "Insert Shape" AXMenuButton. Both walkers in scripts/mac/ax-helper.swift (buildNode for `tree`, search for `find` /
 * `invoke`) never read a leaf role's children, so they stopped at the button. Its buttons are often icon-only, named by
 * nothing but AXHelp. Swift does not compile here, so this pins the source; the JXA fallbacks run against a fake tree in
 * macos-jxa-search.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageRoot } from '../paths';

const src = readFileSync(join(getPackageRoot(), 'scripts', 'mac', 'ax-helper.swift'), 'utf8');
const body = (fn: string) => { const at = src.indexOf(`func ${fn}(`); return src.slice(at, src.indexOf('\n}\n', at)); };
const list = (name: string) => src.match(new RegExp(`let ${name}(?:: [^=]+)? = \\[([^\\]]*)\\]`))![1];

describe('ax-helper.swift walks into a popover a leaf control presented', () => {
  it('ordinary buttons are still leaves', () => {
    expect(list('leafRoles')).toContain('"AXButton"');
    expect(list('leafRoles')).toContain('"AXMenuButton"');
  });

  it('presentedPopovers keeps only AXPopover children', () => {
    expect(src).toMatch(/func presentedPopovers\([^)]*\)[^\n]*\.filter \{[^\n]*"AXRole"[^\n]*== "AXPopover"/);
  });

  for (const fn of ['buildNode', 'search']) {
    it(`${fn}: a leaf role's children are read only for its popover`, () => {
      const b = body(fn);
      expect(b).not.toMatch(/!leafRoles\.contains\(role\)/);
      expect(b).toMatch(/leafRoles\.contains\(role\) \? presentedPopovers\(kids\) : kids/);
    });
  }
});

describe('ax-helper.swift names a control by its AXHelp when nothing else names it', () => {
  it('both walkers read AXHelp', () => {
    expect(list('nodeAttrs')).toContain('"AXHelp"');
    expect(list('searchAttrs')).toContain('"AXHelp"');
  });

  it('tree: AXHelp comes after title, description and the label peek, and names controls only', () => {
    const b = body('buildNode');
    const peek = b.indexOf('name = firstStaticTextValue(kids)');
    expect(peek).toBeGreaterThan(-1);
    expect(b.search(/if name\.isEmpty && \(alwaysKeepRoles\.contains\(role\) \|\| labelPeekRoles\.contains\(role\)\) \{ name = str\(a\["AXHelp"\]\) \?\? "" \}/)).toBeGreaterThan(peek);
  });

  it('the popover probe stays inside the time budget', () => {
    expect(src).toMatch(/func presentedPopovers[^\n]*!timeUp\(\) &&/);
  });

  it('find / invoke: AXHelp matches and names a hit, last', () => {
    const b = body('search');
    expect(b).toMatch(/let help = title\.isEmpty && desc\.isEmpty && label\.isEmpty \? \(str\(a\["AXHelp"\]\)/);
    expect(b).toMatch(/hl\.contains\(w\)/);
    expect(b).toMatch(/hl == w/);
    expect(b).toMatch(/\[title, desc, label, help\]\.first/);
  });
});
