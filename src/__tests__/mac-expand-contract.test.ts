/**
 * expand / collapse on macOS must never report AXShowMenu as an expansion. On web content AXShowMenu opens the PAGE's context
 * menu (Reload, Back, ...): the tool said "Expanded", nothing had opened, and a menu stayed on screen (1.5.27 live test on a Mac).
 * The behaviour itself is covered live (mac-ax-live.test.ts, CLAWD_LIVE_MAC_TESTS=1); these are the rules that must hold in the
 * sources whatever machine runs the tests.
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

describe('expand / collapse never use AXShowMenu', () => {
  it('the helper does not press AXShowMenu anywhere', () => {
    expect(swift).not.toMatch(/press\(\s*\w+\s*,\s*"AXShowMenu"/);
  });

  it('the osascript fallback does not perform AXShowMenu for expand or collapse', () => {
    for (const c of ['expand', 'collapse']) expect(jxaCase(c)).not.toMatch(/actions\[\s*['"]AXShowMenu['"]\s*\]/);
  });

  it('the helper reads the result back before it reports one (settles / waitForMenu), never "the call returned"', () => {
    const body = swift.slice(swift.indexOf('func expandOrCollapse('), swift.indexOf('func perform('));
    expect(body).toMatch(/settles\(el, to: want\)/);
    expect(body).toMatch(/waitForMenu\(under: el/);
    // every success goes through done(), which names the state the element was found in: it is the only place that says success
    expect(body.match(/"success": true/g) ?? []).toHaveLength(1);
  });

  it('an element is pressed to expand it only when it is a disclosure triangle (WebKit gives plain buttons an AXExpanded too)', () => {
    const body = swift.slice(swift.indexOf('func expandOrCollapse('), swift.indexOf('func perform('));
    expect(body).toMatch(/h\.role == "AXDisclosureTriangle" && actionNames\(el\)\.contains\("AXPress"\)/);
    expect(body).not.toMatch(/before != nil && actionNames/);
  });

  it('a Return key is sent only to the element\'s own app, and only once the app\'s focus is really on it', () => {
    const body = swift.slice(swift.indexOf('func expandOrCollapse('), swift.indexOf('func perform('));
    expect(body).toMatch(/hasKeyboardFocus\(el, pid: pid\) && pressKey\(36, to: pid\)/);
    expect(swift).toMatch(/ev\.postToPid\(pid\)/);
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
