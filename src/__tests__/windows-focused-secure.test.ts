/**
 * Windows: the focused element says whether it is a password field (UIA IsPassword) and never carries a password
 * field's value. The type tool's "into a password field (not echoed)" relied on it, and it was missing on Windows only
 * (macOS and Linux already set it): the secret was echoed, and Edge's bullets read as a mismatch that held Return.
 * The bridge is run for real in windows-focused-secure.system.test.ts; this file is the adapter.
 */
import { describe, it, expect } from 'vitest';

describe('WindowsAdapter maps secure through', () => {
  it('a password field comes back secure; an ordinary one does not carry the flag', async () => {
    const { WindowsAdapter } = await import('../platform/windows');
    const a = new WindowsAdapter() as unknown as { normalizeElement: (raw: unknown) => { secure?: boolean } };
    expect(a.normalizeElement({ name: 'Password', controlType: 'ControlType.Edit', value: '', secure: true }).secure).toBe(true);
    expect(a.normalizeElement({ name: 'Search', controlType: 'ControlType.Edit', value: 'x', secure: false }).secure).toBeUndefined();
  });

  it('readable comes through, so an empty readable field reads as empty (#377)', async () => {
    const { WindowsAdapter } = await import('../platform/windows');
    const a = new WindowsAdapter() as unknown as { normalizeElement: (raw: unknown) => { readable?: boolean } };
    expect(a.normalizeElement({ name: 'Name', controlType: 'ControlType.Edit', value: '', readable: true }).readable).toBe(true);
    expect(a.normalizeElement({ name: 'Canvas', controlType: 'ControlType.Pane', value: '', readable: false }).readable).toBeUndefined();
  });
});
