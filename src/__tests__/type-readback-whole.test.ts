/**
 * Typing is read back as ✓ only when the field's WHOLE value is what was typed; anything more is named, not confirmed.
 * Live 2026-11-19: a select-all did not take, "80" was typed after the old "26", and the field held "2680" yet the
 * reply said "read back ✓" [confirmed].
 */
import { describe, it, expect } from 'vitest';
import { buildCoreTools } from '../tools/core-tools';

const type = buildCoreTools().find(t => t.name === 'type_text')!;

/** A field that holds `start`, and after typing holds `after` (as read back). */
function field(start: string, after: string) {
  let typed = false;
  const platform = {
    takeInputWarning: () => null,
    typeText: async () => { typed = true; },
    keyPress: async () => {},
    getFocusedElement: async () => ({ value: typed ? after : start }),
  };
  return { platform } as any;
}

describe('computer type read-back', () => {
  it('a field that now holds more than was typed is not ✓ and names the whole value', async () => {
    const r = await type.execute({ text: '80\t' }, field('', '2680'));
    expect(r.text).not.toContain('read back ✓');
    expect(r.text).toMatch(/the field now holds [\s\S]*2680[\s\S]* \(not only what was typed\)/);
  });

  it('an exact value is ✓', async () => {
    const r = await type.execute({ text: '80' }, field('26', '80'));
    expect(r.text).toContain('read back ✓');
  });

  it('the value from before plus the typed text is named, not ✓: a select-all that did not take looks the same', async () => {
    const r = await type.execute({ text: '80' }, field('26', '2680'));
    expect(r.text).not.toContain('read back ✓');
    expect(r.text).toMatch(/the field now holds [\s\S]*2680/);
  });

  it('a trailing Tab the typing sent is ignored', async () => {
    const r = await type.execute({ text: '80\t' }, field('', '80 '));
    expect(r.text).toContain('read back ✓');
  });
});
