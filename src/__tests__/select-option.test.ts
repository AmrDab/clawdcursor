/**
 * `select name:"Plan" value:"Pro"` — choose an option inside a dropdown/list.
 * Live gap (Linux VM, 2026-10): `select` had no `value`, so the agent could
 * not change a combo box and the form submitted the default ("Free").
 */
import { describe, it, expect, vi } from 'vitest';
import { selectOption } from '../platform/select-option';

function fakePlatform(opts: { value?: string | null; options: string[]; sticks?: boolean; selectOnlyHighlights?: boolean }) {
  let current = opts.value ?? 'Free';
  const calls: Array<{ name?: string; action?: string; controlType?: string }> = [];
  const platform = {
    calls,
    invokeElement: vi.fn(async (q: { name?: string; action?: string; controlType?: string }) => {
      calls.push(q);
      if (q.action === 'get-value') return opts.value === null ? { success: false } : { success: true, data: { value: current } };
      if (q.action === 'expand' || q.action === 'collapse') return { success: true };
      if ((q.action === 'select' || q.action === 'click') && opts.options.includes(q.name ?? '')) {
        if (opts.sticks !== false && !(opts.selectOnlyHighlights && q.action === 'select')) current = q.name!;
        return { success: true };
      }
      return { success: false };
    }),
    findElements: vi.fn(async (q: { name?: string }) =>
      [...opts.options, 'Profile', 'Plan'].filter(n => n.toLowerCase().includes(String(q.name).toLowerCase()))
        .map(n => ({ name: n, controlType: n === 'Plan' ? 'ComboBox' : 'ListItem', bounds: { x: 0, y: 0, width: 1, height: 1 } }))),
  };
  return platform;
}

describe('selectOption', () => {
  it('selects the option and verifies by reading the control back', async () => {
    const p = fakePlatform({ options: ['Free', 'Pro', 'Team'] });
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r).toMatchObject({ success: true, verified: true });
    expect(r.text).toMatch(/^Selected \(read back ✓\) "Pro" in "Plan"\./);
    expect(p.calls.map(c => c.action)).toEqual(['get-value', 'expand', 'select', 'get-value']);
  });

  it('falls through to "click" when "select" only highlights (GTK combo popup)', async () => {
    const p = fakePlatform({ options: ['Free', 'Pro'], selectOnlyHighlights: true });
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r).toMatchObject({ success: true, verified: true });
    expect(p.calls.map(c => c.action)).toEqual(['get-value', 'expand', 'select', 'get-value', 'click', 'get-value']);
  });

  it('is a no-op when the control already shows the value', async () => {
    const p = fakePlatform({ value: 'Pro', options: ['Free', 'Pro'] });
    const r = await selectOption(p as any, { name: 'Plan', value: 'pro' });
    expect(r).toMatchObject({ success: true, verified: true });
    expect(p.calls.map(c => c.action)).toEqual(['get-value']);
  });

  it('never presses a fuzzy look-alike ("Pro" must not click "Profile")', async () => {
    const p = fakePlatform({ options: ['Free', 'Team'] }); // no "Pro" option, but "Profile" exists
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/no option named exactly "Pro".*Nothing was changed/);
    expect(p.calls.some(c => c.action === 'select' || c.action === 'click')).toBe(false);
    expect(p.calls.at(-1)?.action).toBe('collapse');
  });

  it('without a controlType, aims at the dropdown, not the label with the same name (1.5.27 live test)', async () => {
    const p = fakePlatform({ options: ['Free', 'Pro'] });
    p.findElements.mockImplementation(async (q: any) => q.name === 'Plan'
      ? [{ name: 'Plan', controlType: 'Text' }, { name: 'Plan', controlType: 'ComboBox' }]
      : [{ name: q.name, controlType: 'ListItem' }]);
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r).toMatchObject({ success: true, verified: true });
    expect(p.calls.filter(c => c.name === 'Plan').every(c => c.controlType === 'ComboBox')).toBe(true);
  });

  it('says so when only a label has that name, instead of "no option named"', async () => {
    const p = fakePlatform({ options: ['Free', 'Pro'] });
    p.findElements.mockImplementation(async () => [{ name: 'Plan', controlType: 'Text' }]);
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/No dropdown or list named "Plan"; only Text matched/);
    expect(r.text).not.toMatch(/no option named/);
    expect(p.calls).toEqual([]);
  });

  it('recognises the macOS, AT-SPI and UIA spellings of a control that holds options', async () => {
    for (const role of ['AXPopUpButton', 'combo box', 'List', 'AXComboBox']) {
      const p = fakePlatform({ options: ['Free', 'Pro'] });
      p.findElements.mockImplementation(async (q: any) => q.name === 'Plan'
        ? [{ name: 'Plan', controlType: 'Text' }, { name: 'Plan', controlType: role }]
        : [{ name: q.name, controlType: 'ListItem' }]);
      const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
      expect(r.success, role).toBe(true);
      expect(p.calls.find(c => c.name === 'Plan')?.controlType, role).toBe(role);
    }
  });

  it('reports failure when the read-back disagrees', async () => {
    const p = fakePlatform({ options: ['Free', 'Pro'], sticks: false });
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r).toMatchObject({ success: false, verified: true });
    expect(r.text).toMatch(/now shows "Free"/);
  });

  it('says "unverified" when the control has no readable value', async () => {
    const p = fakePlatform({ value: null, options: ['Free', 'Pro'] });
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r).toMatchObject({ success: true, verified: false });
    expect(r.text).toMatch(/unverified/);
  });

  describe('a pick that is applied a moment after the press returns (WebKit pop-up: the menu is still closing)', () => {
    /** A dropdown whose value changes only on the Nth read after the pick (0 = never). */
    function lateControl(applyOnRead: number) {
      let current = 'Free';
      let pending: string | null = null;
      let readsSincePick = 0;
      const calls: string[] = [];
      return {
        calls,
        invokeElement: vi.fn(async (q: { name?: string; action?: string }) => {
          calls.push(String(q.action));
          if (q.action === 'get-value') {
            if (pending && applyOnRead > 0 && ++readsSincePick >= applyOnRead) { current = pending; pending = null; }
            return { success: true, data: { value: current } };
          }
          if (q.action === 'expand' || q.action === 'collapse') return { success: true };
          if ((q.action === 'select' || q.action === 'click') && ['Free', 'Pro'].includes(q.name ?? '')) { pending = q.name!; readsSincePick = 0; return { success: true }; }
          return { success: false };
        }),
        findElements: vi.fn(async (q: { name?: string }) =>
          ['Free', 'Pro', 'Plan'].filter(n => n.toLowerCase().includes(String(q.name).toLowerCase()))
            .map(n => ({ name: n, controlType: n === 'Plan' ? 'PopUpButton' : 'MenuItem', bounds: { x: 0, y: 0, width: 1, height: 1 } }))),
      };
    }

    it('is re-read until it shows the new value - not reported as "Tried to select ... but it now shows"', async () => {
      const p = lateControl(5);                     // the value shows up on the 5th read after the pick
      const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' }, { settleMs: 3000 });
      expect(r).toMatchObject({ success: true, verified: true });
      expect(r.text).toMatch(/Selected \(read back ✓\) "Pro" in "Plan"\./);
    });

    it('a control that never shows it is still a failure, once the wait is over', async () => {
      const p = lateControl(0);
      const t0 = Date.now();
      const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' }, { settleMs: 400 });
      expect(r.success).toBe(false);
      expect(r.text).toMatch(/Tried to select "Pro" in "Plan", but it now shows "Free"/);
      expect(Date.now() - t0).toBeLessThan(4000);
    });

    it('settleMs: 0 reads once, as before', async () => {
      const p = lateControl(5);
      const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' }, { settleMs: 0 });
      expect(r.success).toBe(false);
    });
  });
});
