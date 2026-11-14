/**
 * expand / collapse on macOS. The osascript fallback (invoke-element.jxa) runs here in a vm against fake elements, on any
 * OS. The accessibility helper (ax-helper.swift) has no entry point that runs without a live AX tree, so its rules are
 * read from the source; its behaviour is covered live (mac-ax-live.system.test.ts, CLAWD_LIVE_MAC_TESTS=1) and, for the
 * key step, in macos-expand-key.test.ts.
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
import { el, fakeApp, runInvoke } from './helpers/jxa-harness';

const scripts = path.join(__dirname, '..', '..', 'scripts', 'mac');
const swift = fs.readFileSync(path.join(scripts, 'ax-helper.swift'), 'utf8');

const expandBody = () => swift.slice(swift.indexOf('func expandOrCollapse('), swift.indexOf('func perform('));

describe('expand / collapse never use AXShowMenu', () => {
  it('the helper does not press AXShowMenu anywhere', () => {
    expect(swift).not.toMatch(/press\(\s*\w+\s*,\s*"AXShowMenu"/);
  });

  it('the helper reads the result back before it reports one, never "the call returned"', () => {
    const body = expandBody();
    expect(body).toMatch(/settles\(el, to: want\)/);
    expect(body).toMatch(/waitUntil\(900/);
    // every success goes through done(), which names the state the element was found in: it is the only place that says success
    expect(body.match(/"success": true/g) ?? []).toHaveLength(1);
  });

  it('the result carries data.expandState ("Expanded" / "Collapsed"), the key #334 reads', () => {
    expect(expandBody()).toMatch(/\["expandState": want \? "Expanded" : "Collapsed"\]/);
  });

  it('an element that was already in the wanted state says so (expandChanged: false), so the tool reports "still expanded"', () => {
    expect(expandBody()).toMatch(/if method == "unchanged" \{ data\["expandChanged"\] = false \}/);
  });
});

describe('the osascript fallback (invoke-element.jxa, run in a vm): expand / collapse set AXExpanded and read it back', () => {
  // A disclosure triangle and a web <summary> (a button), each with AXPress and AXShowMenu on offer.
  const run = (action: string, p: { role: string; expanded?: boolean; expandSettable?: boolean }) => {
    const target = el({ name: 'More options', ...p });
    const r = runInvoke(fakeApp(el({ name: 'Win', role: 'AXWindow' }, [target])), ['-ProcessId', '4242', '-Action', action, '-Name', 'More options']);
    return { r, target };
  };

  it('a settable AXExpanded: set, read back, and reported with the method', () => {
    const open = run('expand', { role: 'AXDisclosureTriangle', expanded: false, expandSettable: true });
    expect(open.r).toEqual({ success: true, action: 'expand', method: 'AXExpanded' });
    expect(open.target.props.expanded).toBe(true);
    const shut = run('collapse', { role: 'AXDisclosureTriangle', expanded: true, expandSettable: true });
    expect(shut.r).toEqual({ success: true, action: 'collapse', method: 'AXExpanded' });
    expect(shut.target.props.expanded).toBe(false);
  });

  it('no settable AXExpanded: a failure that says the helper is needed, and neither AXShowMenu (the page\'s context menu) nor AXPress (a pop-up it could not close) is performed', () => {
    for (const action of ['expand', 'collapse']) {
      for (const p of [{ role: 'AXButton' }, { role: 'AXPopUpButton', expanded: false }, { role: 'AXDisclosureTriangle', expanded: true }]) {
        const { r, target } = run(action, p);
        expect(r.success, `${action} ${p.role}`).toBe(false);
        expect(r.error).toMatch(/does not support (expand|collapse) here \(no settable AXExpanded\)/);
        expect(target.showedMenu, `${action} ${p.role}`).toBeUndefined();
        expect(target.pressed, `${action} ${p.role}`).toBeUndefined();
        expect(target.clicked, `${action} ${p.role}`).toBeUndefined();
      }
    }
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
    // Escape for a list: the focus must be on the control or inside the list, checked before the key is posted
    const esc = body.slice(body.indexOf('func closeWithEscape('), body.indexOf('if want {'));
    expect(esc).toMatch(/hasKeyboardFocus\(el, pid: pid\) \|\| focusIsWithin\(list\.element, pid: pid\)/);
    expect(esc.indexOf('focusIsWithin')).toBeLessThan(esc.indexOf('postKeyToFrontmost(53'));
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
    expect(fn).toMatch(/insetBy\(dx: -28, dy: -28\)/);
    expect(fn).toMatch(/kinds\.contains\(\$0\.kind\) && zone\.intersects\(\$0\.frame\)/);
    // a plain AXList stands in for the control's menu only where the caller asks for it (default: menus only)
    expect(fn).toMatch(/kinds: Set<ListKind> = \[\.menu\]/);
  });

  it('a content list of the page (<ul>, <ol>) is never the list of a control: collapse must not send Escape for a list that was never open', () => {
    const fn = swift.slice(swift.indexOf('func shownMenus('), swift.indexOf('func ownMenu('));
    expect(swift).toMatch(/let contentListSubroles: Set<String> = \["AXContentList", "AXDefinitionList", "AXDescriptionList"\]/);
    expect(fn).toMatch(/for h in found\.hits where h\.role == "AXMenu" \|\| !contentListSubroles\.contains\(h\.subrole\) \{ add\(/);
    // the only way a plain list gets into the set
    expect(fn.match(/kind: [^)]*\.list\)/g) ?? []).toHaveLength(1);
  });

  it('expand counts only a menu that appeared with the press, or the control saying it is open', () => {
    const body = expandBody();
    expect(body).toMatch(/!before\.contains \{ \$0\.frame == n\.frame \}/);
    expect(body).toMatch(/ownMenu\(of: el, in: fresh, kinds: \[\.menu, \.list\]\)/);
    expect(body).toMatch(/openState\(el\) == true/);
  });

  it('"already open" and collapse look at this control\'s menu only, and Escape is sent only for a menu that is the control\'s', () => {
    const body = expandBody();
    expect(body).toMatch(/let mine = ownMenu\(of: el, in: before\)/);
    expect(body).toMatch(/if mine != nil \|\| openState\(el\) == true \{ return done\("unchanged"\) \}/);
    // "unchanged" is decided on menus only: a plain list standing next to the control is not proof that it is open
    expect(body).toMatch(/let mine = ownMenu\(of: el, in: before\)\s/);
    // Escape is only ever sent through closeWithEscape(list), and that is called only with the control's own menu or list
    const calls = body.match(/closeWithEscape\(/g) ?? [];
    expect(calls).toHaveLength(3);                                               // the definition + two callers
    expect(body).toMatch(/if let m = mine \{[\s\S]*return closeWithEscape\(m,/);
    expect(body).toMatch(/if let l = ownMenu\(of: el, in: before, kinds: \[\.list\]\) \{\s*return closeWithEscape\(l,/);
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
