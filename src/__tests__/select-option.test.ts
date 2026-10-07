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
        .map(n => ({ name: n, controlType: 'ListItem', bounds: { x: 0, y: 0, width: 1, height: 1 } }))),
  };
  return platform;
}

describe('selectOption', () => {
  it('selects the option and verifies by reading the control back', async () => {
    const p = fakePlatform({ options: ['Free', 'Pro', 'Team'] });
    const r = await selectOption(p as any, { name: 'Plan', value: 'Pro' });
    expect(r).toMatchObject({ success: true, verified: true });
    expect(r.text).toMatch(/Selected "Pro" in "Plan" \(verified\)/);
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
});
