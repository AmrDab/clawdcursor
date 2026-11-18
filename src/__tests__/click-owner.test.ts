// A Windows Store app's frame belongs to ApplicationFrameHost and hosts the app's own process. Window lists report the
// frame host as processId and the app as hostedProcessId, so the "another app on top" check must accept either, or every
// smart_click in Calculator / Settings is refused (live 2026-11-17: window-at-point at Calculator's centre).
import { describe, it, expect } from 'vitest';
import { ownsPoint, foreignWindowRefusal, describeWindowAt } from '../tools/click-owner';

const FRAME = { processId: 34452, processName: 'ApplicationFrameHost', title: 'Calculator', hostedProcessId: 61248, hostedProcessName: 'CalculatorApp' };

describe('a Store app frame owns its point for either of its processes', () => {
  it('ownsPoint matches the frame host or the hosted app, nothing else', () => {
    expect(ownsPoint(FRAME, 34452)).toBe(true);
    expect(ownsPoint(FRAME, 61248)).toBe(true);
    expect(ownsPoint(FRAME, undefined, 61248)).toBe(true);
    expect(ownsPoint(FRAME, 999)).toBe(false);
    expect(ownsPoint(null, 34452)).toBe(false);
    expect(ownsPoint({ processId: 5 }, undefined)).toBe(false);
  });

  it('smart_click is not refused in Calculator whichever pid the caller targets', async () => {
    const platform = { windowAtPoint: async () => FRAME };
    expect(await foreignWindowRefusal(platform, 10, 10, 34452, 'Equals')).toBeNull();
    expect(await foreignWindowRefusal(platform, 10, 10, 61248, 'Equals')).toBeNull();
  });

  it('a different app on top is still refused, and named by the app, not by its frame host', async () => {
    const platform = { windowAtPoint: async () => FRAME };
    const r = await foreignWindowRefusal(platform, 10, 10, 777, 'Settings', 'Notcho');
    expect(r).toMatch(/^refused: the point .* matched is in .* \(CalculatorApp, pid 34452\), which is on top of Notcho/);
    expect(describeWindowAt(FRAME)).toContain('(CalculatorApp, pid 34452)');
  });
});
