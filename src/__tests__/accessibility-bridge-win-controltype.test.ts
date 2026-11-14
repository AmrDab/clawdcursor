/**
 * AccessibilityBridge (the System-A tools' Windows path) sends the bridge the same control-type vocabulary as
 * WindowsAdapter. It passed "ControlType.Button" raw: the bridge's $ctMap has no such key, so the role filter was dropped
 * and the name fuzzy-matched any element type (audit 2026-11-13).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCalls: Array<Record<string, unknown>> = [];
vi.mock('../platform/ps-runner', () => ({
  psRunner: {
    run: (payload: Record<string, unknown>) => { runCalls.push(payload); return Promise.resolve([]); },
    start: vi.fn(), stop: vi.fn(),
  },
}));

import { AccessibilityBridge } from '../platform/accessibility';

beforeEach(() => { runCalls.length = 0; });

// The bridge picks its OS at load: these run where it takes the Windows path.
describe.runIf(process.platform === 'win32')('AccessibilityBridge on Windows — controlType', () => {
  it('find sends the bare name the bridge can match', async () => {
    await new AccessibilityBridge().findElement({ name: 'OK', controlType: 'ControlType.Button', processId: 7 });
    expect(runCalls.find(c => c.cmd === 'find-element')).toMatchObject({ controlType: 'Button', processId: 7 });
  });

  it('invoke sends the bare name too', async () => {
    await new AccessibilityBridge().invokeElement({ name: 'Save as', controlType: 'menu item', action: 'click', processId: 7 });
    expect(runCalls.find(c => c.cmd === 'invoke-element')).toMatchObject({ controlType: 'MenuItem' });
  });

  it('a type the bridge cannot honor fails closed, never searching without the filter', async () => {
    const bridge = new AccessibilityBridge();
    expect(await bridge.findElement({ name: 'OK', controlType: 'ControlType.Bogus', processId: 7 })).toEqual([]);
    const res = await bridge.invokeElement({ name: 'OK', controlType: 'Bogus', action: 'click', processId: 7 });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/Unknown controlType "Bogus" — use one of: Button, CheckBox, .*MenuItem.*Window$/) });
    expect(runCalls.filter(c => c.cmd === 'find-element' || c.cmd === 'invoke-element')).toEqual([]);
  });
});
