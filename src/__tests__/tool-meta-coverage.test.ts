/**
 * Coverage test for TOOL_META (Step 1 of the MCP re-projection refactor).
 *
 * Enforced invariant: every System B tool name returned by buildUnifiedTools()
 * (across blind, hybrid, vision modes) has a TOOL_META entry, EXCEPT for:
 *   - terminal actions: done, give_up, cannot_read
 *   - vision compound tools: mouse, keyboard, window (from compound.ts)
 *
 * When a new tool is added to buildUnifiedTools() this test will fail
 * immediately, requiring the author to also add the TOOL_META entry.
 *
 * Mirrors the pattern of src/__tests__/cost-class-coverage.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// ── Mock heavy native deps ───────────────────────────────────────────────────

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse: { config: {}, move: vi.fn(), click: vi.fn(), setPosition: vi.fn() },
  keyboard: { config: {}, type: vi.fn() },
  screen: { grab: vi.fn() },
  Button: { LEFT: 0 },
  Key: new Proxy({}, { get: (_t, p) => p }),
  Point: class { constructor(public x: number, public y: number) {} },
  Region: class {
    constructor(
      public left: number, public top: number,
      public width: number, public height: number,
    ) {}
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  })),
}));

vi.mock('../../src/platform/ocr-engine', async () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

vi.mock('../platform/ocr-engine', () => ({
  OcrEngine: class {
    isAvailable() { return false; }
    async recognizeScreen() { return { elements: [], fullText: '', durationMs: 0 }; }
    invalidateCache() {}
  },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { buildUnifiedTools } from '../core/agent-loop/tools';
import { TOOL_META } from '../core/agent-loop/tool-meta';

// ── Exclusion sets ────────────────────────────────────────────────────────────

/**
 * Terminal / loop-control actions — never projected to the MCP surface.
 * These tools tell the AGENT to stop (or, ask_user, to pause for the user —
 * MCP clients have pause_for_user); MCP clients use ToolResult.isError instead.
 */
const TERMINAL_ACTIONS = new Set(['done', 'give_up', 'cannot_read', 'ask_user']);

/**
 * Vision compound tool names — collapsed from many granulars, no 1:1 MCP counterpart.
 * These are the names defined in compound.ts (mouse, keyboard, window) plus screenshot
 * which is handled separately in vision mode.
 */
const VISION_COMPOUNDS: Set<string> = new Set([
  // COMPOUND_REPLACES is the Set of granular names that the compound tools REPLACE
  // (click, drag, type, key, etc.) — not the compound names themselves.
  // The compound tools themselves are 'mouse', 'keyboard', 'window'.
  'mouse',
  'keyboard',
  'window',
]);

// ── Build the complete System B tool name set ─────────────────────────────────

/**
 * Collect all tool names from the flat catalog.
 */
function getAllSystemBNames(): Set<string> {
  const names = new Set<string>();
  for (const tool of buildUnifiedTools()) {
    names.add(tool.name);
  }
  return names;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TOOL_META coverage (Step 1 — enforced)', () => {
  const allNames = getAllSystemBNames();

  // Names that require a TOOL_META entry (everything except excluded sets).
  const requiredNames = [...allNames].filter(
    name => !TERMINAL_ACTIONS.has(name) && !VISION_COMPOUNDS.has(name),
  );

  it('every non-excluded System B tool has a TOOL_META entry', () => {
    const missing = requiredNames.filter(name => !(name in TOOL_META));
    expect(missing).toEqual([]);
  });

  it('TOOL_META has no stale entries (all keys match a real System B tool)', () => {
    const stale = Object.keys(TOOL_META).filter(name => !allNames.has(name));
    expect(stale).toEqual([]);
  });

  it('every TOOL_META entry has required fields (category, safetyTier, costClass)', () => {
    const VALID_CATEGORIES = new Set([
      'perception', 'mouse', 'keyboard', 'window', 'clipboard', 'browser', 'orchestration',
    ]);
    const VALID_COST_CLASSES = new Set([
      'act', 'inspect', 'perceive-text', 'perceive-image',
    ]);
    const VALID_SAFETY_TIERS = new Set([0, 1, 2, 3]);

    const bad: string[] = [];
    for (const [name, meta] of Object.entries(TOOL_META)) {
      if (!VALID_CATEGORIES.has(meta.category)) {
        bad.push(`${name}: invalid category "${meta.category}"`);
      }
      if (!VALID_COST_CLASSES.has(meta.costClass)) {
        bad.push(`${name}: invalid costClass "${meta.costClass}"`);
      }
      if (!VALID_SAFETY_TIERS.has(meta.safetyTier)) {
        bad.push(`${name}: invalid safetyTier "${meta.safetyTier}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('excluded sets are disjoint (no name in both TERMINAL and VISION_COMPOUNDS)', () => {
    const intersection = [...TERMINAL_ACTIONS].filter(n => VISION_COMPOUNDS.has(n));
    expect(intersection).toEqual([]);
  });

  it('vision compound tool names (mouse/keyboard/window) are not in the flat catalog', () => {
    // The thin loop does not use compound tools — they were vision-only.
    // None of them should appear in the flat catalog returned by buildUnifiedTools().
    for (const name of VISION_COMPOUNDS) {
      expect(allNames.has(name)).toBe(false);
    }
  });

  it('mcpName values in TOOL_META are distinct from System B names where provided', () => {
    // When mcpName is set, it MUST differ from the System B key (or it is noise).
    const bad: string[] = [];
    for (const [sysb, meta] of Object.entries(TOOL_META)) {
      if (meta.mcpName !== undefined && meta.mcpName === sysb) {
        bad.push(`${sysb}: mcpName is the same as the System B name — remove it`);
      }
    }
    expect(bad).toEqual([]);
  });
});
