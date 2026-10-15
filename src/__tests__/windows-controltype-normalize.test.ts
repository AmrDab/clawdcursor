/**
 * Windows findElements must normalize — and fail closed on — controlType.
 *
 * Found by driving clawdcursor for real: asking for
 * `{name:'Allow npm publish', controlType:'ControlType.CheckBox'}` returned a
 * ControlType.Text element named "npm".
 *
 * The bridge keys its $ctMap on BARE names ("CheckBox"), but everything the
 * agent READS is normalized the other way (normalizeElement strips the prefix,
 * windows.ts:1325) and the tool schema's own example says to send the PREFIXED
 * form. So the documented input was the one form the bridge could not match:
 * ContainsKey failed, no role condition was added, and the search silently ran
 * UNFILTERED — and with no role filter the bridge falls back to bidirectional
 * substring name matching, so "allow npm publish".Contains("npm") wins.
 *
 * A dropped role filter is worse than an error: the same path backs invoke /
 * toggle / select / set_value, so it can ACT on a confidently wrong control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class { constructor(public l: number, public t: number, public w: number, public h: number) {} },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

const runCalls: Array<Record<string, unknown>> = [];
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (payload: Record<string, unknown>) => { runCalls.push(payload); return Promise.resolve({ elements: [] }); },
    start: vi.fn(), stop: vi.fn(),
  },
}));

import { WindowsAdapter } from '../platform/windows';

describe('WindowsAdapter.findElements — controlType normalization', () => {
  let adapter: WindowsAdapter;

  beforeEach(() => {
    runCalls.length = 0;
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 42 } as never);
  });

  it('sends the BARE name the bridge can match, given the documented prefixed form', async () => {
    await adapter.findElements({ name: 'Allow npm publish', controlType: 'ControlType.CheckBox' });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].controlType).toBe('CheckBox');
  });

  it('accepts the bare form unchanged', async () => {
    await adapter.findElements({ name: 'x', controlType: 'Button' });
    expect(runCalls[0].controlType).toBe('Button');
  });

  it('FAILS CLOSED on a type the bridge cannot honor, rather than searching unfiltered', async () => {
    const res = await adapter.findElements({ name: 'x', controlType: 'ControlType.Bogus' });
    expect(res).toEqual([]);
    expect(runCalls).toHaveLength(0); // never reaches the bridge
  });

  it('omitting controlType still searches with no role filter', async () => {
    await adapter.findElements({ name: 'x' });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).not.toHaveProperty('controlType');
  });
});

describe('WindowsAdapter — controlType spelling (MenuItem / "menu item" / menuitem)', () => {
  let adapter: WindowsAdapter;

  beforeEach(() => {
    runCalls.length = 0;
    adapter = new WindowsAdapter();
    vi.spyOn(adapter, 'getActiveWindow').mockResolvedValue({ processId: 42 } as never);
  });

  // Live Win11 VM 2026-10-14: invoke with a controlType missed a menu item that
  // the same invoke WITHOUT a controlType found. UIA itself spells the role
  // several ways — ProgrammaticName "ControlType.MenuItem", LocalizedControlType
  // "menu item" — and agents copy whichever they saw; only the exact PascalCase
  // bare name was honored, every other spelling failed closed.
  for (const spelling of ['MenuItem', 'ControlType.MenuItem', 'menuitem', 'menu item', 'Menu Item', 'controltype.menuitem']) {
    it(`invokeElement sends MenuItem for "${spelling}"`, async () => {
      await adapter.invokeElement({ name: 'Save as', controlType: spelling, processId: 7 });
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0].controlType).toBe('MenuItem');
    });
  }

  it('findElements maps localized multi-word types too ("list item" → ListItem)', async () => {
    await adapter.findElements({ name: 'x', controlType: 'list item' });
    expect(runCalls[0].controlType).toBe('ListItem');
  });

  it('still fails closed on an unknown type', async () => {
    const res = await adapter.invokeElement({ name: 'x', controlType: 'menu thing', processId: 7 });
    expect(res.success).toBe(false);
    expect(runCalls).toHaveLength(0);
  });
});
