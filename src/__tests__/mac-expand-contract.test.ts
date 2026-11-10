/**
 * expand / collapse on macOS: rules that must hold in the sources whatever machine runs the tests. The behaviour itself is
 * covered live (mac-ax-live.test.ts, CLAWD_LIVE_MAC_TESTS=1) and, for the key step, in macos-expand-key.test.ts.
 *
 *  - AXShowMenu is never an expansion: on web content it opens the PAGE's context menu (Reload, Back, ...); the tool said
 *    "Expanded", nothing had opened, and a menu stayed on screen (1.5.27 live test on a Mac).
 *  - Only a menu that is tied to THIS control counts as its list: a page's always-visible role="menu" navigation, a context menu
 *    or another open pop-up is not it (review of #335).
 *  - The helper never presses a key on its own say-so: the caller runs the input guard and passes --allow-key (review of #335).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { toUiElement } from '../platform/mac-ax';

const scripts = path.join(__dirname, '..', '..', 'scripts', 'mac');
const swift = fs.readFileSync(path.join(scripts, 'ax-helper.swift'), 'utf8');
const jxa = fs.readFileSync(path.join(scripts, 'invoke-element.jxa'), 'utf8');

/** The text of one `case 'name':` block of a JXA switch, up to the next case. */
function jxaCase(name: string): string {
  const start = jxa.indexOf(`case '${name}':`);
  expect(start).toBeGreaterThan(-1);
  const next = jxa.indexOf('\n            case ', start + 10);
  return jxa.slice(start, next === -1 ? undefined : next);
}
const expandBody = () => swift.slice(swift.indexOf('func expandOrCollapse('), swift.indexOf('func perform('));

describe('expand / collapse never use AXShowMenu', () => {
  it('the helper does not press AXShowMenu anywhere', () => {
    expect(swift).not.toMatch(/press\(\s*\w+\s*,\s*"AXShowMenu"/);
  });

  it('the osascript fallback does not perform AXShowMenu for expand or collapse, and does not open a pop-up it could not close', () => {
    for (const c of ['expand', 'collapse']) {
      expect(jxaCase(c)).not.toMatch(/actions\[\s*['"]AXShowMenu['"]\s*\]/);
      expect(jxaCase(c)).not.toMatch(/actions\[\s*['"]AXPress['"]\s*\]/);
    }
  });

  it('the helper reads the result back before it reports one, never "the call returned"', () => {
    const body = expandBody();
    expect(body).toMatch(/settles\(el, to: want\)/);
    expect(body).toMatch(/waitUntil\(900/);
    // every success goes through done(), which names the state the element was found in: it is the only place that says success
    expect(body.match(/"success": true/g) ?? []).toHaveLength(1);
  });

  it('the result carries data.expandState ("Expanded" / "Collapsed"), the key #334 reads', () => {
    expect(expandBody()).toMatch(/"data": \["expandState": want \? "Expanded" : "Collapsed"\]/);
  });
});

describe('only a disclosure triangle is pressed to expand it', () => {
  it('(WebKit gives plain buttons an AXExpanded too)', () => {
    const body = expandBody();
    expect(body).toMatch(/h\.role == "AXDisclosureTriangle" && actionNames\(el\)\.contains\("AXPress"\)/);
    expect(body).not.toMatch(/before != nil && actionNames/);
  });

  it('once its press was accepted there is no Return afterwards: a change that shows late would be toggled back', () => {
    const body = expandBody();
    const press = body.indexOf('// 2. The element\'s own press');
    const keyboard = body.indexOf('// 3. The keyboard');
    expect(press).toBeGreaterThan(-1);
    expect(keyboard).toBeGreaterThan(press);
    const between = body.slice(press, keyboard);
    expect(between).toMatch(/return missed\("pressed it, but it did not/);      // a press that was accepted ends the call here
  });
});

describe('the helper presses no key on its own say-so', () => {
  it('a key is posted only by postKeyToFrontmost, and only to the app in front', () => {
    expect(swift).not.toMatch(/postToPid/);
    const fn = swift.slice(swift.indexOf('func postKeyToFrontmost('), swift.indexOf('func focusedElement('));
    expect(fn).toMatch(/frontmostApplication\?\.processIdentifier == pid/);
    expect(fn.indexOf('frontmostApplication')).toBeLessThan(fn.indexOf('.post(tap:'));
    // the only callers are inside expandOrCollapse
    expect(swift.match(/postKeyToFrontmost\(/g) ?? []).toHaveLength(3);          // definition + Escape + Return
  });

  it('Return and Escape each wait for --allow-key (needsKey) and for the keyboard focus before they are pressed', () => {
    const body = expandBody();
    expect(body).toMatch(/guard keyAllowed\("Return"\) else \{ return needsKey\("Return"\) \}/);
    expect(body).toMatch(/guard keyAllowed\("Escape"\) else \{ return needsKey\("Escape"\) \}/);
    expect(body.indexOf('guard keyAllowed("Return")')).toBeLessThan(body.indexOf('postKeyToFrontmost(36'));
    expect(body.indexOf('guard keyAllowed("Escape")')).toBeLessThan(body.indexOf('postKeyToFrontmost(53'));
    expect(body).toMatch(/hasKeyboardFocus\(el, pid: pid\)/);
    expect(body).toMatch(/focusIsWithin\(m\.element, pid: pid\) \|\| hasKeyboardFocus\(el, pid: pid\)/);
    // the focus a failed keyboard expand moved is put back
    expect(body).toMatch(/restoreFocus\(\)/);
  });

  it('uses the pid of the app that was asked (cmdInvoke), not the pid of whichever process owns the element', () => {
    expect(swift).toMatch(/perform\(action, best, pid: app\.processIdentifier,/);
    expect(swift).toMatch(/perform\(action, hit, pid: app\.processIdentifier,/);
    expect(expandBody()).not.toMatch(/AXUIElementGetPid/);
  });
});

describe('a list is "this control\'s" only when it is tied to the control', () => {
  it('ownMenu: a menu hung under the control, or one right next to it - never "any menu in the window"', () => {
    const fn = swift.slice(swift.indexOf('func ownMenu('), swift.indexOf('/// expand / collapse. Every success'));
    expect(fn).toMatch(/\$0\.child/);
    expect(fn).toMatch(/insetBy\(dx: -16, dy: -16\)/);
    expect(fn).toMatch(/zone\.intersects\(\$0\.frame\)/);
  });

  it('expand counts only a menu that appeared with the press, or the control saying it is open', () => {
    const body = expandBody();
    expect(body).toMatch(/!before\.contains \{ \$0\.frame == n\.frame \}/);
    expect(body).toMatch(/ownMenu\(of: el, in: fresh\)/);
    expect(body).toMatch(/openState\(el\) == true/);
  });

  it('"already open" and collapse look at this control\'s menu only, and Escape is sent only for a menu that is the control\'s', () => {
    const body = expandBody();
    expect(body).toMatch(/let mine = ownMenu\(of: el, in: before\)/);
    expect(body).toMatch(/if mine != nil \|\| openState\(el\) == true \{ return done\("unchanged"\) \}/);
    // Escape sits inside `if let m = mine`: it is never sent for a menu that is not the control's
    const mineBlock = body.indexOf('if let m = mine {');
    expect(mineBlock).toBeGreaterThan(-1);
    expect(body.indexOf('needsKey("Escape")')).toBeGreaterThan(mineBlock);
  });

  it('a press that opened nothing the helper could see says so, and tells the caller it acted (so select cleans up)', () => {
    const body = expandBody();
    expect(body).toMatch(/did not open a list of options that I could see/);
    expect(body).toMatch(/missed\([^\n]*acted: p\.done\)/);
  });
});

describe('the open / closed state the helper reports (toUiElement)', () => {
  it('a disclosure triangle\'s state reaches UiElement.expandable / expanded', () => {
    const open = toUiElement({ name: 'More options', controlType: 'AXDisclosureTriangle', value: '1', expandable: true, expanded: true, bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(open).toMatchObject({ controlType: 'DisclosureTriangle', expandable: true, expanded: true });
    const closed = toUiElement({ name: 'More options', controlType: 'AXDisclosureTriangle', value: '0', expandable: true, expanded: false, bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(closed).toMatchObject({ expandable: true, expanded: false });
  });

  it('an element with no open / closed state is not marked expandable', () => {
    const el = toUiElement({ name: 'Save', controlType: 'AXButton', bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(el.expandable).toBeUndefined();
    expect(el.expanded).toBeUndefined();
  });
});
