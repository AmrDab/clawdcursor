/**
 * Mac bench 2026-11-17, web-long-read: the Answer field and the Submit button sit at the end of a long page, scrolled out of
 * view. Chrome gives them a frame of height 0 at the window's bottom edge ("Answer" @270,960 198x0).
 * - find listed that frame as a position, with no "offscreen";
 * - find_field / find_button answered "none" with no candidates, though set_value and invoke by name reach them;
 * - smart_type focused "Answer" by name, the page kept the focus, and the reply said the text went into "Answer".
 */
import { describe, it, expect } from 'vitest';
import { toUiElement } from '../platform/mac-ax';
import { buildCoreTools } from '../tools/core-tools';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import { focusStayedOnPage } from '../tools/smart';
import type { AgentToolContext } from '../tools/types';
import type { PlatformAdapter } from '../platform/types';

describe('macOS: an element with no area is offscreen', () => {
  it('a frame of height 0 at the window edge (Chrome, scrolled out of view)', () => {
    const el = toUiElement({ role: 'AXTextField', name: 'Answer', bounds: { x: 270, y: 960, width: 198, height: 0 } });
    expect(el.offscreen).toBe(true);
  });
  it('no frame at all', () => {
    expect(toUiElement({ role: 'AXButton', name: 'Submit' }).offscreen).toBe(true);
  });
  it('a frame with an area is not', () => {
    expect(toUiElement({ role: 'AXButton', name: 'Submit', bounds: { x: 472, y: 400, width: 71, height: 24 } }).offscreen).toBeUndefined();
  });
});

const tool = (name: string) => buildCoreTools().find(t => t.name === name)!;
function ctx(tree: object[]): AgentToolContext {
  const adapter = {
    getActiveWindow: async () => ({ processId: 9, processName: 'Google Chrome', title: 'Bench Reading', bounds: { x: 80, y: 60, width: 1000, height: 900 } }),
    getUiTree: async () => tree,
    getScreenSize: async () => ({ logicalWidth: 1440, logicalHeight: 900, physicalWidth: 1440, physicalHeight: 900, dpiRatio: 1 }),
    getFocusedElement: async () => null,
    screenshot: async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 }),
  } as unknown as PlatformAdapter;
  return { platform: adapter, task: 't', screen: { logicalWidth: 1440, logicalHeight: 900, physicalWidth: 1440, physicalHeight: 900, dpiRatio: 1 },
    screenshotsCaptured: { n: 0 }, uiMaps: new UIMapHolder() } as unknown as AgentToolContext;
}
const LONG_PAGE = [
  { name: 'Bench Reading', controlType: 'Heading', bounds: { x: 100, y: 120, width: 300, height: 30 }, enabled: true },
  { name: 'Station Delta-17', controlType: 'StaticText', bounds: { x: 100, y: 400, width: 200, height: 18 }, enabled: true },
  { name: 'Answer', controlType: 'TextField', bounds: { x: 270, y: 960, width: 198, height: 0 }, enabled: true },
  { name: 'Submit', controlType: 'Button', bounds: { x: 472, y: 960, width: 71, height: 0 }, enabled: true },
];

describe('find_field / find_button: a match scrolled out of view', () => {
  it('find_field names it, with the set_value by name that reaches it', async () => {
    const r = JSON.parse((await tool('find_input_field').execute({ purpose: 'Answer' }, ctx(LONG_PAGE))).text);
    expect(r.status).toBe('none');
    expect(r.offscreen).toEqual({ name: 'Answer', role: expect.any(String) });
    expect(r.next).toBe('accessibility {"action":"set_value","name":"Answer","value":"<text>"} (works out of view, no scrolling)');
  });

  it('find_button names it, with the invoke by name', async () => {
    const r = JSON.parse((await tool('find_action_button').execute({ intent: 'Submit' }, ctx(LONG_PAGE))).text);
    expect(r.status).toBe('none');
    expect(r.offscreen?.name).toBe('Submit');
    expect(r.next).toMatch(/^accessibility \{"action":"invoke","name":"Submit"\}/);
  });

  it('a match on screen wins, and an off-screen element that does not match is not named', async () => {
    const onScreen = [...LONG_PAGE, { name: 'Submit', controlType: 'Button', bounds: { x: 472, y: 500, width: 71, height: 24 }, enabled: true }];
    const ok = JSON.parse((await tool('find_action_button').execute({ intent: 'Submit' }, ctx(onScreen))).text);
    expect(ok.status).toBe('ok');
    expect(ok.offscreen).toBeUndefined();
    const miss = JSON.parse((await tool('find_input_field').execute({ purpose: 'password' }, ctx(LONG_PAGE))).text);
    expect(miss.status).toBe('none');
    expect(miss.offscreen).toBeUndefined();
  });
});

describe('smart_type: did the focus stay on the page?', () => {
  it('a web page in focus, named otherwise: yes, with its name', () => {
    expect(focusStayedOnPage({ controlType: 'WebArea', name: 'Bench Reading' }, 'Answer')).toBe('Bench Reading');
    expect(focusStayedOnPage({ controlType: 'AXWebArea', name: 'Bench Reading' }, 'Answer')).toBe('Bench Reading');
  });
  // Mac, 2026-11-17: `focused` after the old smart_type read {"name":"Smart Type Check","controlType":"Document"}.
  it('macOS reports the page as "Document": a page there, not elsewhere', () => {
    expect(focusStayedOnPage({ controlType: 'Document', name: 'Smart Type Check' }, 'Answer', 'darwin')).toBe('Smart Type Check');
    expect(focusStayedOnPage({ controlType: 'Document', name: 'Answer form' }, 'Answer', 'darwin')).toBeNull();
    expect(focusStayedOnPage({ controlType: 'Edit', name: 'Smart Type Check' }, 'Answer', 'darwin')).toBeNull();
  });
  it('the field, a page named like the target, a nameless page or a document: no', () => {
    expect(focusStayedOnPage({ controlType: 'TextField', name: 'Answer' }, 'Answer')).toBeNull();
    expect(focusStayedOnPage({ controlType: 'WebArea', name: 'Answer form' }, 'Answer')).toBeNull();
    expect(focusStayedOnPage({ controlType: 'WebArea', name: '' }, 'Answer')).toBeNull();
    expect(focusStayedOnPage({ controlType: 'Document', name: 'Text editor' }, 'Body')).toBeNull();
    expect(focusStayedOnPage({ controlType: 'Document', name: 'Text editor' }, 'Body', 'win32')).toBeNull();
    expect(focusStayedOnPage(null, 'Answer')).toBeNull();
  });
});
