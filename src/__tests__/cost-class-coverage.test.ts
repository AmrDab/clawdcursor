/**
 * Coverage test for `ToolDefinition.costClass`.
 *
 * Phase A introduces `costClass` as an OPTIONAL field on tool definitions
 * so the rollout can land in batches. This test runs in WARN mode today:
 * it never fails, it just emits a console line listing tools that still
 * lack a `costClass`. Once every tool is annotated, flip the bottom
 * `expect(missing.length).toBe(0)` block from `it.skip` to `it` and the
 * coverage becomes enforced.
 *
 * Compound dispatcher tools (compactGroup-as-tool: `computer`,
 * `accessibility`, `window`, `system`, `browser`, `task`) are exempt —
 * their cost varies per-action and they intentionally leave costClass
 * undefined. The exemption list is below; if a compound tool is added,
 * extend it.
 */
import { describe, it, expect } from 'vitest';
import { getAllTools } from '../tools/registry';
import { validateCostClassMap } from '../tools/cost-class';
import type { ToolCostClass } from '../tools/types';

const COMPOUND_EXEMPTIONS = new Set([
  'computer', 'accessibility', 'window', 'system', 'browser',
]);

const VALID_CLASSES: ToolCostClass[] = ['act', 'inspect', 'perceive-text', 'perceive-image'];

describe('costClass coverage (Phase A — warn mode)', () => {
  const tools = getAllTools();

  it('every assigned costClass is one of the valid string literals', () => {
    const invalid = tools
      .filter(t => t.costClass !== undefined)
      .filter(t => !VALID_CLASSES.includes(t.costClass as ToolCostClass));
    expect(invalid.map(t => `${t.name} -> ${t.costClass}`)).toEqual([]);
  });

  it('every cheaperAlternatives entry references an existing tool', () => {
    const knownNames = new Set(tools.map(t => t.name));
    const bad: string[] = [];
    for (const t of tools) {
      for (const alt of t.cheaperAlternatives ?? []) {
        if (!knownNames.has(alt)) bad.push(`${t.name}.cheaperAlternatives -> "${alt}" (unknown)`);
      }
    }
    expect(bad).toEqual([]);
  });

  // Enforced (Phase A back-fill complete): every granular tool must carry a
  // costClass, and the central table must have no stale entries.
  it('every granular tool has a costClass (table is complete and current)', () => {
    const toolNames = tools
      .filter(t => !COMPOUND_EXEMPTIONS.has(t.name))
      .map(t => t.name);
    expect(validateCostClassMap(toolNames)).toEqual([]);
  });
});
