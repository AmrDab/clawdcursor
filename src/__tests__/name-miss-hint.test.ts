/**
 * A find that matched nothing used to say "Little or no accessibility structure here" whatever the window held — live
 * macOS: Freeform has 34 named elements, and the agent was told the app was blind. A miss in a structured window is a
 * wrong name: it now says how many elements there are and which names are close.
 */
import { describe, it, expect } from 'vitest';
import { nameMissHint } from '../tools/blind-hints';
import { wrapUntrustedScreenContent } from '../core/agent-loop/prompt';

const freeform = ['Show sidebar', 'Go Back', 'Content Hub', 'Insert Text Box', 'Insert Shape', 'Insert Sticky Note',
  'Insert Table', 'Insert Media', 'Share Board', 'New Board'].map(name => ({ name, controlType: 'Button' }));

describe('nameMissHint', () => {
  it('a structured window: the count and the closest names, as untrusted data', () => {
    const h = nameMissHint('Shape tool', freeform, wrapUntrustedScreenContent)!;
    expect(h).toMatch(/No element named "Shape tool" among the 10 named elements/);
    expect(h).toMatch(/<untrusted-screen-content>[\s\S]*"Insert Shape"/);
    expect(h).not.toMatch(/Little or no accessibility structure/);
  });

  it('nothing close: says so and points at reading the window', () => {
    const h = nameMissHint('zzzz', freeform, wrapUntrustedScreenContent)!;
    expect(h).toMatch(/None is close: read the window/);
  });

  it('a thin window (fewer than 5 named elements) → null: the caller keeps the sparse-structure advice', () => {
    expect(nameMissHint('Pen', [{ name: 'Canvas' }, { name: '' }, { name: 'OK' }], wrapUntrustedScreenContent)).toBeNull();
  });

  it('at most 5 suggestions, deduplicated, best first', () => {
    const tree = [...freeform, { name: 'Insert Shape', controlType: 'MenuItem' }, { name: 'Shape', controlType: 'Button' }];
    const h = nameMissHint('Shape', tree, s => s)!;
    const lines = h.split('\n').filter(l => l.startsWith('['));
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.filter(l => l.includes('"Insert Shape"')).length).toBe(1);
    expect(lines[0]).toContain('"Shape"');
  });
});
