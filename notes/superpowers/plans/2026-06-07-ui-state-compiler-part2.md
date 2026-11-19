# UI State Compiler — Layer A Part 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the UI State Compiler into the live agent loop + MCP surface, with a session-scoped UIMap holder and a strict `snapshot_id` staleness contract enabling safe `el_NN` element references on `invoke_element`/`set_field_value`.

**Architecture:** A pure `UIMapHolder` (session state on `ToolContext`/`AgentToolContext`) caches the last 1–2 compiled maps with TTL + invalidate-on-change. `compile_ui` (MCP) and the agent loop both compile via `compileUIMap` and `put` into the holder. `invoke_element`/`set_field_value` gain optional `{element_id, snapshot_id}` refs that resolve against the holder (strict reject on stale/expired/unknown), gated by confidence + capability, dispatching by unique a11y name or by validated bounds. By-name behavior is unchanged.

**Tech Stack:** TypeScript, vitest, existing `compileUIMap`/`renderUIMap`/`defaultCompileDeps`, invoke-cascade, `set_field_value`, the MCP projection (`project-mcp.ts`).

**Spec:** `notes/superpowers/specs/2026-06-07-ui-state-compiler-part2-design.md`. **Branch:** `v1.5.0`.

**Scope fence:** NO vision-element fusion, NO Layer B (`find_*`/`verify_state`/`request_approval`), NO Layer C, NO new standalone action tool, NO change to by-name behavior, NO `automationId` on `UIElement`.

---

## Reused shapes (read first)
```ts
// src/core/sense/ui-map-types.ts: UIMap, UIElement, CompileHints, Bounds
// src/core/sense/ui-map.ts: compileUIMap(deps, hints), defaultCompileDeps(adapter, now, snapshotId, prevAnchors?), CompileDeps
// src/core/sense/ui-map-render.ts: renderUIMap(map, {max?})
// src/core/agent-loop/types.ts: AgentToolContext { platform; task; screen; screenshotsCaptured; activeApp?; targetWindow?; cdp?; _platform? }
// src/tools/types.ts: ToolContext { desktop; a11y; cdp; platform?; agent?; getMouseScaleFactor; getScreenshotScaleFactor; ensureInitialized; ... }
// src/core/agent-loop/project-mcp.ts: toolContextToAgent(ctx) -> AgentToolContext (returns a literal at ~line 145)
// src/platform/types.ts: PlatformAdapter.getActiveWindow() -> { processId; processName; title; bounds:{x,y,width,height} } | null
```

---

## Task 1: UIMapHolder (session-scoped, TTL, strict resolve)

**Files:**
- Create: `src/core/sense/ui-map-holder.ts`
- Test: `src/__tests__/ui-map-holder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-holder.test.ts
import { describe, it, expect } from 'vitest';
import { UIMapHolder, TTL_MS, MAX_HELD } from '../core/sense/ui-map-holder';
import type { UIMap } from '../core/sense/ui-map-types';

const mapWith = (id: string): UIMap => ({
  snapshot_id: id, platform: 'windows', active_app: 'Notepad', window_title: 'Untitled',
  window_bounds: [0, 0, 800, 600], coordinate_space: 'screen', scale_factor: 1,
  compiled_at: '0', sources_used: ['window', 'a11y'], elements: [], anchors: {},
});

describe('UIMapHolder', () => {
  it('nextId mints monotonic obs_N ids', () => {
    const h = new UIMapHolder();
    expect(h.nextId()).toBe('obs_1');
    expect(h.nextId()).toBe('obs_2');
  });

  it('resolves the current map within TTL', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);
    const r = h.resolve(id, 1000 + TTL_MS - 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.snapshot_id).toBe(id);
  });

  it('rejects an expired map (past TTL) even if it is the latest', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);
    const r = h.resolve(id, 1000 + TTL_MS + 1);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an unknown / evicted id', () => {
    const h = new UIMapHolder();
    expect(h.resolve('obs_999', 0)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a held-but-not-current id as stale', () => {
    const h = new UIMapHolder();
    const a = h.nextId(); h.put(mapWith(a), 0);
    const b = h.nextId(); h.put(mapWith(b), 0);
    expect(h.resolve(a, 0)).toEqual({ ok: false, reason: 'stale' });
    expect(h.resolve(b, 0).ok).toBe(true);
  });

  it('keeps at most MAX_HELD maps (oldest evicted -> unknown)', () => {
    const h = new UIMapHolder();
    const ids = Array.from({ length: MAX_HELD + 1 }, () => { const i = h.nextId(); h.put(mapWith(i), 0); return i; });
    expect(h.resolve(ids[0], 0)).toEqual({ ok: false, reason: 'unknown' }); // evicted
    expect(h.resolve(ids[ids.length - 1], 0).ok).toBe(true);
  });

  it('invalidate() makes the current map resolve as stale', () => {
    const h = new UIMapHolder();
    const id = h.nextId(); h.put(mapWith(id), 0);
    h.invalidate();
    expect(h.resolve(id, 0)).toEqual({ ok: false, reason: 'stale' });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-holder.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/core/sense/ui-map-holder.ts
/**
 * Session-scoped cache of recently compiled UIMaps, enabling safe el_NN element
 * references (resolve {snapshot_id, element_id} -> live element). Strict by
 * design: only the CURRENT, non-invalidated, in-TTL map resolves. See
 * notes/superpowers/specs/2026-06-07-ui-state-compiler-part2-design.md §2.
 */
import type { UIMap } from './ui-map-types';

/** GUI state changes fast — action refs expire quickly. 5s strict default. */
export const TTL_MS = 5_000;
/** Keep the current map + one prior (diagnostics); only current resolves. */
export const MAX_HELD = 2;

type Resolution = { ok: true; map: UIMap } | { ok: false; reason: 'unknown' | 'stale' | 'expired' };

export class UIMapHolder {
  private held: Array<{ map: UIMap; compiledAt: number }> = [];
  private counter = 0;
  private invalidated = false;

  /** Mint the next session-scoped id; caller passes it to compileUIMap. */
  nextId(): string {
    this.counter += 1;
    return `obs_${this.counter}`;
  }

  /** Store a compiled map as the new current; un-invalidates; bounds to MAX_HELD. */
  put(map: UIMap, now: number): void {
    this.held.push({ map, compiledAt: now });
    if (this.held.length > MAX_HELD) this.held.shift();
    this.invalidated = false;
  }

  /** Resolve a ref. Only the current, non-invalidated, in-TTL map is usable. */
  resolve(snapshotId: string, now: number): Resolution {
    const current = this.held[this.held.length - 1];
    if (!current || current.map.snapshot_id !== snapshotId) {
      // Distinguish "held but not current" (stale) from "never/evicted" (unknown).
      const heldOlder = this.held.some(h => h.map.snapshot_id === snapshotId);
      return { ok: false, reason: heldOlder ? 'stale' : 'unknown' };
    }
    if (this.invalidated) return { ok: false, reason: 'stale' };
    if (now - current.compiledAt > TTL_MS) return { ok: false, reason: 'expired' };
    return { ok: true, map: current.map };
  }

  /** Mark all held maps invalid — called after any screen-changing action. */
  invalidate(): void {
    this.invalidated = true;
  }

  currentId(): string | undefined {
    return this.held[this.held.length - 1]?.map.snapshot_id;
  }
}
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/ui-map-holder.test.ts` → PASS (7 tests).
- [ ] **Step 5: Commit**
```bash
git add src/core/sense/ui-map-holder.ts src/__tests__/ui-map-holder.test.ts
git commit -m "feat(ui-map): session-scoped UIMapHolder with TTL + strict staleness"
```

---

## Task 2: compileUIMap resilience (OCR/vision throws degrade, not crash)

**Files:**
- Modify: `src/core/sense/ui-map.ts` (wrap `deps.ocr()` and `deps.vision()` calls)
- Test: `src/__tests__/ui-map-compile.test.ts` (append)

Once wired to the live loop, a throwing OCR/vision source must not crash perception. Today `compileUIMap` calls `await deps.ocr()` / `await deps.vision()` unguarded.

- [ ] **Step 1: Write the failing test** — append to `src/__tests__/ui-map-compile.test.ts` inside the existing `describe('compileUIMap — lazy escalation', ...)` block:

```ts
  it('a throwing OCR source degrades to no OCR (does not crash compile)', async () => {
    const d = deps({
      captureSnapshot: vi.fn(async () => snap([])),           // empty a11y -> OCR would fire
      ocr: vi.fn(async () => { throw new Error('OCR engine unavailable'); }),
    });
    const map = await compileUIMap(d, {});
    expect(map.sources_used).toEqual(['window']);             // ocr failed -> not recorded
    expect(map.elements).toEqual([]);
  });

  it('a throwing vision source degrades to no vision', async () => {
    const d = deps({
      captureSnapshot: vi.fn(async () => snap([])),
      ocr: vi.fn(async () => ({ elements: [], fullText: '', durationMs: 1 })),
      vision: vi.fn(async () => { throw new Error('no display'); }),
    });
    const map = await compileUIMap(d, { max_cost: 'vision_ok' });
    expect(map.sources_used).not.toContain('vision');         // vision failed -> not recorded
  });
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-compile.test.ts` → the two new tests FAIL (throw propagates).

- [ ] **Step 3: Implement** — in `src/core/sense/ui-map.ts`, guard the two source calls. Change the OCR block's `const ocrRes = await deps.ocr();` to a guarded call, and the vision block's `await deps.vision();` likewise:

```ts
// OCR block — replace `const ocrRes = await deps.ocr();` with:
    const ocrRes = await deps.ocr().catch(() => null);
    if (ocrRes && ocrRes.elements.length > 0) {
      sourcesUsed.push('ocr');
      const base = elements.length;
      elements = fuse([...elements, ...ocrRes.elements.map((oe, i) => ocrToUI(oe, `el_${base + i}`))]);
    }
```

```ts
// Vision block — replace `await deps.vision(); sourcesUsed.push('vision');` with:
    const shot = await deps.vision().catch(() => null);
    if (shot) sourcesUsed.push('vision');
```

(Keep the surrounding `if (ocrAllowed && (sparse || !a11yHasTarget))` / `if (visionAllowed && nothingActionable)` gates unchanged — only the inner calls become guarded.)

- [ ] **Step 4: Run** `npx vitest run src/__tests__/ui-map-compile.test.ts` → PASS (all, incl. the 2 new). The existing OCR-fires tests still pass (a non-throwing OCR returns elements as before).
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/sense/ui-map.ts src/__tests__/ui-map-compile.test.ts
git commit -m "fix(ui-map): degrade gracefully when OCR/vision source throws"
```

---

## Task 3: Thread the holder through the tool contexts

**Files:**
- Modify: `src/core/agent-loop/types.ts` (`AgentToolContext.uiMaps?`)
- Modify: `src/tools/types.ts` (`ToolContext.uiMaps?`)
- Modify: `src/core/agent-loop/project-mcp.ts` (`toolContextToAgent` copies `uiMaps`)
- Test: `src/__tests__/ui-map-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-context.test.ts
import { describe, it, expect, vi } from 'vitest';
import { toolContextToAgent } from '../core/agent-loop/project-mcp';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { ToolContext } from '../tools/types';

describe('toolContextToAgent — uiMaps holder passthrough', () => {
  it('copies ctx.uiMaps onto the synthetic AgentToolContext', async () => {
    const holder = new UIMapHolder();
    const ctx = {
      ensureInitialized: async () => {},
      platform: { } as any,
      desktop: { getScreenSize: () => ({ width: 800, height: 600 }) },
      cdp: null,
      getMouseScaleFactor: () => 1,
      getScreenshotScaleFactor: () => 1,
      uiMaps: holder,
    } as unknown as ToolContext;
    const agentCtx = await toolContextToAgent(ctx);
    expect(agentCtx.uiMaps).toBe(holder);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-context.test.ts` → FAIL (`uiMaps` not on the returned object / type error).

- [ ] **Step 3: Implement**

In `src/core/agent-loop/types.ts`, add to `AgentToolContext` (after `cdp?`):
```ts
  /** Session-scoped UIMap cache for safe el_NN element refs (Part 2). */
  uiMaps?: import('../sense/ui-map-holder').UIMapHolder;
```

In `src/tools/types.ts`, add to `ToolContext`:
```ts
  /** Session-scoped UIMap cache for safe el_NN element refs (Part 2). */
  uiMaps?: import('../core/sense/ui-map-holder').UIMapHolder;
```

In `src/core/agent-loop/project-mcp.ts`, in the object returned by `toolContextToAgent` (the literal near line 145), add:
```ts
    uiMaps: ctx.uiMaps,
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/ui-map-context.test.ts` → PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/agent-loop/types.ts src/tools/types.ts src/core/agent-loop/project-mcp.ts src/__tests__/ui-map-context.test.ts
git commit -m "feat(ui-map): thread UIMapHolder through ToolContext + AgentToolContext"
```

---

## Task 4: `compile_ui` tool + MCP wiring

**Files:**
- Modify: `src/core/agent-loop/tools.ts` (add `compile_ui` tool)
- Modify: `src/core/agent-loop/tool-meta.ts`, `src/tools/cost-class.ts`, `src/core/safety.ts`, `src/tools/registry.ts`
- Test: `src/__tests__/ui-map-compile-ui-tool.test.ts`
- Regen: `schema.snapshot.json`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-compile-ui-tool.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { AgentToolContext } from '../core/agent-loop/types';
import type { PlatformAdapter } from '../platform/types';

const tool = () => buildUnifiedTools().find(t => t.name === 'compile_ui')!;

function ctx(holder: UIMapHolder): AgentToolContext {
  const adapter = {
    getActiveWindow: async () => ({ processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    getUiTree: async () => [{ name: 'Send', controlType: 'Button', bounds: { x: 10, y: 20, width: 40, height: 12 }, enabled: true }],
    getScreenSize: async () => ({ logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }),
    getFocusedElement: async () => null,
    screenshot: async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 }),
  } as unknown as PlatformAdapter;
  return { platform: adapter, task: 't', screen: { logicalWidth: 800, logicalHeight: 600, physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 }, screenshotsCaptured: { n: 0 }, uiMaps: holder } as unknown as AgentToolContext;
}

describe('compile_ui tool', () => {
  it('is registered, perception, changesScreen=false', () => {
    const t = tool();
    expect(t).toBeTruthy();
    expect(t.changesScreen).toBe(false);
  });

  it('compiles, stores the map in the holder, and returns a render mentioning the snapshot id', async () => {
    const holder = new UIMapHolder();
    const res = await tool().execute({}, ctx(holder));
    expect(res.success).toBe(true);
    const id = holder.currentId();
    expect(id).toBe('obs_1');
    expect(res.text).toContain('obs_1');     // render includes the snapshot id context line
    expect(res.text.toLowerCase()).toContain('send'); // the a11y button surfaced
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-compile-ui-tool.test.ts` → FAIL (no compile_ui tool).

- [ ] **Step 3: Implement the tool** — in `src/core/agent-loop/tools.ts`, add imports at the top with the other `./ui-map*` imports (note: Task 5 will reuse some):
```ts
import { compileUIMap, defaultCompileDeps } from '../sense/ui-map';
import { renderUIMap } from '../sense/ui-map-render';
```
Add the tool definition next to the other perception tools (e.g. after `read_text`):
```ts
    {
      name: 'compile_ui',
      description: 'Compile the current screen into one fused UI map (a11y + OCR + lazy vision) of elements with stable ids, roles, confidence and sources. Returns a ranked element list with a snapshot id; act on a specific element via invoke_element/set_field_value with {element_id, snapshot_id}. Cheap by default (window+a11y); pass max_cost to allow OCR/vision.',
      inputSchema: {
        type: 'object',
        properties: {
          purpose: { type: 'string', enum: ['general', 'find_text', 'act'], description: 'What the compile is for' },
          target_text: { type: 'string', description: 'If set and absent from a11y, pull OCR to find it' },
          max_cost: { type: 'string', enum: ['cheap', 'ocr_ok', 'vision_ok'], description: 'Hard ceiling on perception cost (default ocr_ok)' },
        },
        additionalProperties: false,
      },
      changesScreen: false,
      async execute(args, ctx) {
        const holder = ctx.uiMaps;
        if (!holder) return { success: false, text: 'compile_ui: no UIMap holder on this context.' };
        const now = Date.now();
        const id = holder.nextId();
        const hints = {
          purpose: typeof args.purpose === 'string' ? args.purpose as 'general' | 'find_text' | 'act' : undefined,
          target_text: typeof args.target_text === 'string' ? args.target_text : undefined,
          max_cost: typeof args.max_cost === 'string' ? args.max_cost as 'cheap' | 'ocr_ok' | 'vision_ok' : undefined,
        };
        const map = await compileUIMap(defaultCompileDeps(ctx.platform, now, id), hints);
        holder.put(map, now);
        return { success: true, text: renderUIMap(map) };
      },
    },
```
> NOTE: `Date.now()` is allowed here (this is the live tool layer, not the pure compiler). The compiler stays clock-free; the caller supplies the clock.

- [ ] **Step 4: Wire metadata.** In `src/core/agent-loop/tool-meta.ts` add (near `read_screen`):
```ts
  compile_ui: {
    category: 'perception',
    safetyTier: 0,
    costClass: 'perceive-text',
    paramDescriptions: {
      purpose: 'What the compile is for',
      target_text: 'Text to find (may pull OCR)',
      max_cost: 'Perception cost ceiling',
    },
  },
```
In `src/tools/cost-class.ts`, in the `inspect`/`perceive-text` group add: `compile_ui: 'perceive-text',` (place with the other perceive-text entries; if none, add near `read_screen`/`ocr_read_screen`).
In `src/core/safety.ts` TOOL_TIER add: `'compile_ui': 'read',`.
In `src/tools/registry.ts` add `'compile_ui'` to BOTH `A11Y_SYSB_NAMES` and `A11Y_MCP_NAMES`.

- [ ] **Step 5: Run** `npx vitest run src/__tests__/ui-map-compile-ui-tool.test.ts` → PASS.
- [ ] **Step 6: Regenerate schema snapshot + run its test**
```bash
npx tsx scripts/build-mcp-schema.ts --write
npx vitest run src/__tests__/mcp-schema-snapshot.test.ts
```
Expected: snapshot rewritten (tool count +1), test passes.
- [ ] **Step 7: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 8: Commit**
```bash
git add src/core/agent-loop/tools.ts src/core/agent-loop/tool-meta.ts src/tools/cost-class.ts src/core/safety.ts src/tools/registry.ts schema.snapshot.json src/__tests__/ui-map-compile-ui-tool.test.ts
git commit -m "feat(ui-map): compile_ui MCP tool (compiles + stores in holder)"
```

---

## Task 5: `el_NN` refs on invoke_element + set_field_value

**Files:**
- Create: `src/core/sense/ui-map-resolve.ts` (shared resolve+gate+dispatch-plan helper)
- Modify: `src/core/agent-loop/tools.ts` (`invoke_element`, `set_field_value`)
- Test: `src/__tests__/ui-map-ref-actions.test.ts`

The shared helper turns a ref into a vetted dispatch decision so both tools share identical staleness/gate logic.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-ref-actions.test.ts
import { describe, it, expect } from 'vitest';
import { resolveRef, REF_MIN_CONFIDENCE } from '../core/sense/ui-map-resolve';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { UIMap, UIElement } from '../core/sense/ui-map-types';

const el = (over: Partial<UIElement> & Pick<UIElement, 'id'>): UIElement => ({
  role: 'button', text: 'Send', normalized_text: 'send', bounds: [10, 20, 40, 12],
  confidence: 0.9, sources: ['a11y'], clickable: true, actionable: true, ...over });

const mapWith = (els: UIElement[], id = 'obs_1'): UIMap => ({
  snapshot_id: id, platform: 'windows', active_app: 'notepad', process_id: '9',
  window_title: 'Untitled - Notepad', window_bounds: [0, 0, 800, 600],
  coordinate_space: 'screen', scale_factor: 1, compiled_at: '0',
  sources_used: ['window', 'a11y'], elements: els, anchors: {} });

const active = { processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 } };

function holderWith(map: UIMap): UIMapHolder {
  const h = new UIMapHolder();
  // align the holder's id with the map's id
  while (h.nextId() !== map.snapshot_id) { /* advance counter to match */ }
  h.put(map, 0);
  return h;
}

describe('resolveRef', () => {
  it('rejects when only one of the two params is present', () => {
    const r = resolveRef({ element_id: 'el_0', snapshot_id: undefined }, holderWith(mapWith([el({ id: 'el_0' })])), 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/together/i);
  });

  it('rejects a stale snapshot (no dispatch plan)', () => {
    const h = holderWith(mapWith([el({ id: 'el_0' })]));
    h.invalidate();
    const r = resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, h, 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/stale/i);
  });

  it('rejects element_id not in the snapshot', () => {
    const r = resolveRef({ element_id: 'el_99', snapshot_id: 'obs_1' }, holderWith(mapWith([el({ id: 'el_0' })])), 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not in snapshot/i);
  });

  it('rejects a low-confidence element', () => {
    const r = resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, holderWith(mapWith([el({ id: 'el_0', confidence: REF_MIN_CONFIDENCE - 0.01 })])), 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/confidence/i);
  });

  it('rejects click on a non-actionable element / fill on a non-editable element', () => {
    const h = holderWith(mapWith([el({ id: 'el_0', actionable: false })]));
    expect(resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, h, 0, 'click', active).ok).toBe(false);
    const h2 = holderWith(mapWith([el({ id: 'el_0', role: 'input', editable: false })]));
    expect(resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, h2, 0, 'fill', active).ok).toBe(false);
  });

  it('plans an a11y dispatch when the name is unique', () => {
    const r = resolveRef({ element_id: 'el_0', snapshot_id: 'obs_1' }, holderWith(mapWith([el({ id: 'el_0' })])), 0, 'click', active);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toMatchObject({ via: 'name', name: 'send' });
  });

  it('plans a bounds dispatch for a duplicate name (and passes window/bounds guards)', () => {
    const els = [el({ id: 'el_0' }), el({ id: 'el_1', bounds: [100, 200, 40, 12] })]; // two "send"
    const r = resolveRef({ element_id: 'el_1', snapshot_id: 'obs_1' }, holderWith(mapWith(els)), 0, 'click', active);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toMatchObject({ via: 'bounds', bounds: [100, 200, 40, 12] });
  });

  it('rejects bounds dispatch when the active window no longer matches the map window', () => {
    const els = [el({ id: 'el_0' }), el({ id: 'el_1', bounds: [100, 200, 40, 12] })];
    const otherWin = { processId: 5, processName: 'calc', title: 'Calculator', bounds: { x: 0, y: 0, width: 400, height: 400 } };
    const r = resolveRef({ element_id: 'el_1', snapshot_id: 'obs_1' }, holderWith(mapWith(els)), 0, 'click', otherWin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/window/i);
  });

  it('rejects bounds dispatch when bounds fall outside the active window', () => {
    const els = [el({ id: 'el_0' }), el({ id: 'el_1', bounds: [5000, 5000, 40, 12] })]; // off-window
    const r = resolveRef({ element_id: 'el_1', snapshot_id: 'obs_1' }, holderWith(mapWith(els)), 0, 'click', active);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/window|bounds/i);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-ref-actions.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the resolver**

```ts
// src/core/sense/ui-map-resolve.ts
/**
 * Shared resolve + gate + dispatch-plan for el_NN element refs on
 * invoke_element / set_field_value. Pure (no platform calls) — the caller
 * passes the live active window so this stays unit-testable. See the Part 2
 * spec §5.
 */
import type { UIElement, Bounds } from './ui-map-types';
import type { UIMapHolder } from './ui-map-holder';

/** Below this, an el_NN ref is too uncertain to act on. */
export const REF_MIN_CONFIDENCE = 0.5;

export type RefIntent = 'click' | 'fill';
interface ActiveWindow { processId: number; processName: string; title: string; bounds: { x: number; y: number; width: number; height: number }; }

export type RefPlan =
  | { ok: true; via: 'name'; name: string; element: UIElement }
  | { ok: true; via: 'bounds'; bounds: Bounds; element: UIElement }
  | { ok: false; error: string };

function boundsInside(b: Bounds, w: ActiveWindow['bounds']): boolean {
  const [x, y, bw, bh] = b;
  return x >= w.x && y >= w.y && x + bw <= w.x + w.width && y + bh <= w.y + w.height;
}

export function resolveRef(
  ref: { element_id?: string; snapshot_id?: string },
  holder: UIMapHolder | undefined,
  now: number,
  intent: RefIntent,
  activeWindow: ActiveWindow | null,
): RefPlan {
  const hasId = typeof ref.element_id === 'string' && ref.element_id !== '';
  const hasSnap = typeof ref.snapshot_id === 'string' && ref.snapshot_id !== '';
  if (hasId !== hasSnap) return { ok: false, error: 'provide element_id and snapshot_id together, or neither (use name)' };
  if (!holder) return { ok: false, error: 'no UIMap holder on this context' };

  const r = holder.resolve(ref.snapshot_id as string, now);
  if (!r.ok) {
    const msg = r.reason === 'unknown' ? `unknown snapshot ${ref.snapshot_id} — call compile_ui first`
      : r.reason === 'expired' ? 'snapshot expired — call compile_ui again'
      : 'stale snapshot — the screen changed; call compile_ui again';
    return { ok: false, error: msg };
  }
  const map = r.map;
  const element = map.elements.find(e => e.id === ref.element_id);
  if (!element) return { ok: false, error: `element ${ref.element_id} not in snapshot ${ref.snapshot_id}` };

  // Capability + confidence gate (both dispatch paths).
  if (element.confidence < REF_MIN_CONFIDENCE) return { ok: false, error: `element ${element.id} confidence too low to act on — recompile / re-find` };
  if (intent === 'click' && (!element.actionable || element.state?.enabled === false)) return { ok: false, error: `element ${element.id} is not actionable (disabled?)` };
  if (intent === 'fill' && !element.editable) return { ok: false, error: `element ${element.id} is not editable` };

  // Dispatch by unique a11y name when possible (reliable, blind-route).
  const name = element.normalized_text ?? '';
  const uniqueName = name !== '' && map.elements.filter(e => e.normalized_text === name).length === 1;
  if (uniqueName) return { ok: true, via: 'name', name, element };

  // Otherwise bounds dispatch — with the extra guards (current+TTL is necessary,
  // not sufficient). Active window must still match the map; bounds must be inside it.
  if (!activeWindow) return { ok: false, error: 'cannot verify active window for bounds dispatch — recompile' };
  const sameWin = String(activeWindow.processId) === map.process_id || activeWindow.title === map.window_title;
  if (!sameWin) return { ok: false, error: 'window changed since compile — call compile_ui again' };
  if (!boundsInside(element.bounds, activeWindow.bounds)) return { ok: false, error: 'element is off the active window — call compile_ui again' };
  return { ok: true, via: 'bounds', bounds: element.bounds, element };
}
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/ui-map-ref-actions.test.ts` → PASS (all).

- [ ] **Step 5: Wire into `invoke_element` + `set_field_value`** (`src/core/agent-loop/tools.ts`).

Add `import { resolveRef } from '../sense/ui-map-resolve';` with the other ui-map imports.

For `invoke_element`: add `element_id` + `snapshot_id` to its `inputSchema.properties`:
```ts
          element_id: { type: 'string', description: 'Target a compiled element from compile_ui (requires snapshot_id)' },
          snapshot_id: { type: 'string', description: 'The compile_ui snapshot the element_id came from (requires element_id)' },
```
At the START of `invoke_element.execute`, before the existing name handling, add the ref branch:
```ts
        const refIds = { element_id: typeof args.element_id === 'string' ? args.element_id : undefined,
                         snapshot_id: typeof args.snapshot_id === 'string' ? args.snapshot_id : undefined };
        if (refIds.element_id || refIds.snapshot_id) {
          const aw = await ctx.platform.getActiveWindow().catch(() => null);
          const plan = resolveRef(refIds, ctx.uiMaps, Date.now(), 'click', aw);
          if (!plan.ok) return { success: false, text: `invoke_element ref rejected: ${plan.error}`, isError: true };
          if (plan.via === 'name') {
            const res = await ctx.platform.invokeElement({ name: plan.name, action: 'click' });
            return { success: res.success, text: res.success ? `Invoked "${plan.name}" via a11y (via ${plan.element.id}).` : `a11y invoke of ${plan.element.id} missed.`, targetLabel: plan.name };
          }
          // bounds dispatch — scaled coordinate click at the element center.
          const [bx, by, bw, bh] = plan.bounds;
          const sf = ctx.platform.platform === 'win32' ? 1 : 1; // bounds are screen-space; mouseClick takes screen coords
          await ctx.platform.mouseClick(Math.round(bx + bw / 2), Math.round(by + bh / 2));
          return { success: true, text: `Clicked ${plan.element.id} at its bounds center.`, targetLabel: plan.element.id };
        }
```

For `set_field_value`: add the same two schema props; at the START of its `execute`, add:
```ts
        const refIds = { element_id: typeof args.element_id === 'string' ? args.element_id : undefined,
                         snapshot_id: typeof args.snapshot_id === 'string' ? args.snapshot_id : undefined };
        if (refIds.element_id || refIds.snapshot_id) {
          const fillValue = String(args.value ?? '');
          const aw = await ctx.platform.getActiveWindow().catch(() => null);
          const plan = resolveRef(refIds, ctx.uiMaps, Date.now(), 'fill', aw);
          if (!plan.ok) return { success: false, text: `set_field_value ref rejected: ${plan.error}`, isError: true };
          if (plan.via === 'name') {
            const res = await ctx.platform.invokeElement({ name: plan.name, action: 'set-value', value: fillValue });
            return { success: res.success, text: res.success ? `Set "${plan.name}" = ${fillValue.length} chars (via ${plan.element.id}).` : `Set of ${plan.element.id} failed.`, targetLabel: plan.name };
          }
          const [bx, by, bw, bh] = plan.bounds;
          await ctx.platform.mouseClick(Math.round(bx + bw / 2), Math.round(by + bh / 2));
          await ctx.platform.typeText(fillValue);
          return { success: true, text: `Filled ${plan.element.id} via bounds + type (${fillValue.length} chars).`, targetLabel: plan.element.id };
        }
```
> NOTE: read the actual signatures of `ctx.platform.mouseClick` and `ctx.platform.typeText` in `src/platform/types.ts` before writing; adapt arg order if needed. Bounds are screen-space pixels (the map's `coordinate_space: 'screen'`), which is what `mouseClick` expects for screen-space targets — confirm against how `smart_click` calls `mouseClick`. The existing by-name code paths below the ref branch are UNCHANGED.

- [ ] **Step 6: Run** `npx vitest run src/__tests__/ui-map-ref-actions.test.ts src/__tests__/smart-tools.test.ts` → PASS (ref helper + existing by-name unaffected). Add one integration assertion to `ui-map-ref-actions.test.ts` if practical, but the resolver unit tests are the core coverage.
- [ ] **Step 7: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 8: Commit**
```bash
git add src/core/sense/ui-map-resolve.ts src/core/agent-loop/tools.ts src/__tests__/ui-map-ref-actions.test.ts
git commit -m "feat(ui-map): el_NN refs on invoke_element/set_field_value (resolve+gate+dispatch)"
```

---

## Task 6: Agent-loop integration (per-turn compile, reuse snapshot, invalidate)

**Files:**
- Modify: `src/core/agent-loop/agent.ts`
- Test: `src/__tests__/run-agent.test.ts` (append)

KEY SAFETY: do NOT remove the existing `captureSnapshot`/fingerprint/stagnation logic. Reuse the already-captured snapshot to build the UIMap (no double a11y read, stagnation untouched).

- [ ] **Step 1: Read the loop** — in `src/core/agent-loop/agent.ts` find: the initial-perception block (`captureSnapshot`, ~line 33 of the function), the per-turn §5c post-snapshot, and §6b where `renderSnapshot` builds the `FRESH ACCESSIBILITY SNAPSHOT` text. Confirm where a `Snapshot` object is in hand each turn.

- [ ] **Step 2: Write the failing test** — append to `src/__tests__/run-agent.test.ts`:

```ts
import { UIMapHolder } from '../core/sense/ui-map-holder';

describe('runAgent — UIMap holder integration (Part 2)', () => {
  beforeEach(() => { llmTurnQueue.length = 0; capturedLlmCalls.length = 0; });

  it('stores a per-turn UIMap in the provided holder with an obs_N id', async () => {
    const holder = new UIMapHolder();
    llmTurnQueue.push(turnCall('read_screen'));
    llmTurnQueue.push(turnCall('done', { evidence: 'the window shows the expected content' }));
    await runAgent({ task: 'orient', maxTurns: 5 }, { adapter: makeAdapter(), llm: LLM_CONFIG, uiMaps: holder });
    expect(holder.currentId()).toMatch(/^obs_\d+$/);
  });

  it('invalidates the holder after a screen-changing tool', async () => {
    const holder = new UIMapHolder();
    llmTurnQueue.push(turnCall('key', { key: 'a' }));   // changesScreen:true
    llmTurnQueue.push(turnCall('done', { evidence: 'typed a character into the field' }));
    await runAgent({ task: 'type', maxTurns: 5 }, { adapter: makeAdapter(), llm: LLM_CONFIG, uiMaps: holder });
    // After the key press the latest snapshot is invalidated -> a ref to it is stale.
    const id = holder.currentId();
    if (id) expect(holder.resolve(id, 0)).toEqual({ ok: false, reason: 'stale' });
  });
});
```
This requires `runAgent`'s deps to accept `uiMaps?: UIMapHolder`. Add it to `AgentDeps` in `agent.ts`.

- [ ] **Step 3: Run** `npx vitest run src/__tests__/run-agent.test.ts` → the two new tests FAIL (deps.uiMaps unused).

- [ ] **Step 4: Implement** — in `src/core/agent-loop/agent.ts`:

(a) Add to `AgentDeps`: `uiMaps?: import('../sense/ui-map-holder').UIMapHolder;` and imports:
```ts
import { UIMapHolder } from '../sense/ui-map-holder';
import { compileUIMap } from '../sense/ui-map';
import { renderUIMap } from '../sense/ui-map-render';
```

(b) Near the top of `runAgent`, after the holder is needed: `const holder = deps.uiMaps ?? new UIMapHolder();` and ensure the tool context the loop builds carries `uiMaps: holder` (find where the loop assembles its `AgentToolContext` for tool execution and add `uiMaps: holder`).

(c) A helper that builds a UIMap from an ALREADY-captured snapshot (no second a11y read) and stores it:
```ts
async function storeUIMap(holder: UIMapHolder, snap: Awaited<ReturnType<typeof captureSnapshot>>, deps: AgentDeps, prevAnchors: import('../sense/ui-map-types').UIMap['anchors'] | undefined): Promise<{ render: string; anchors: import('../sense/ui-map-types').UIMap['anchors'] }> {
  const now = Date.now();
  const id = holder.nextId();
  const map = await compileUIMap({
    captureSnapshot: async () => snap,                     // REUSE — no double read
    ocr: async () => ({ elements: [], fullText: '', durationMs: 0 }),   // loop perception stays a11y-only
    vision: async () => { throw new Error('no vision in loop perception'); },
    getScreenSize: () => deps.adapter.getScreenSize(),
    getFocusedElement: () => deps.adapter.getFocusedElement(),
    now, snapshotId: id, prevAnchors,
  }, { max_cost: 'cheap' });                                // cheap = window+a11y only
  holder.put(map, now);
  return { render: renderUIMap(map), anchors: map.anchors };
}
```

(d) In §6b, where the loop currently appends `FRESH ACCESSIBILITY SNAPSHOT:\n${renderSnapshot(...)}`, ALSO (or instead) append the UIMap render built from the same `snap`. Minimal + safe: keep the existing snapshot text AND append the compiled map so the agent gets el_NN ids:
```ts
        const ui = await storeUIMap(holder, snap, deps, prevAnchors);
        prevAnchors = ui.anchors;
        nextBlocks.push({ type: 'text', text: `\nCOMPILED UI (act on an element via invoke_element/set_field_value with {element_id, snapshot_id="${holder.currentId()}"}):\n${ui.render}` });
```
(Declare `let prevAnchors: UIMap['anchors'] | undefined = undefined;` once near the loop top. `snap` is the §6b snapshot variable already captured.)

(e) Invalidate after screen-changing tools: in §5c (or wherever `tool.changesScreen` is handled post-execute), after a `changesScreen` tool runs, call `holder.invalidate();`.

> NOTE: keep all existing fingerprint/stagnation/runaway logic exactly as-is. The UIMap is ADDITIVE perception. If the §6b snapshot variable name differs, adapt. Do not call `compileUIMap` with the real OCR/vision deps in the loop — use the cheap, snapshot-reusing deps above so there is no extra perception cost and no double a11y read.

- [ ] **Step 5: Run** `npx vitest run src/__tests__/run-agent.test.ts` → PASS (new + all existing — verify the existing 14+ run-agent tests still pass; if a test asserted on exact perception text, reconcile).
- [ ] **Step 6: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 7: Commit**
```bash
git add src/core/agent-loop/agent.ts src/__tests__/run-agent.test.ts
git commit -m "feat(ui-map): per-turn UIMap in the agent loop (reuse snapshot; invalidate on change)"
```

---

## Task 7: Daemon wiring + full gate

**Files:**
- Modify: `src/surface/cli.ts` (create one holder per session; attach to toolCtx + pass to the agent loop)
- Test: full gate

- [ ] **Step 1: Read** `src/surface/cli.ts` around where `toolCtx` is built (the `agent ?` branch, ~line 428) and where the agent/runAgent is invoked.

- [ ] **Step 2: Implement** — create one holder per daemon session and share it:
```ts
import { UIMapHolder } from '../core/sense/ui-map-holder';
// ... where the session/toolCtx is set up:
const uiMapHolder = new UIMapHolder();
```
Add `uiMaps: uiMapHolder` to the `toolCtx` object literal (both the `agent ?` branch and the `--no-llm` branch). Where the Agent is constructed/`executeTask` leads into `runAgent`, ensure the holder reaches `runAgent`'s `deps.uiMaps` — thread it through `Agent` (e.g. store on the agent and pass into the `runAgent({...}, { adapter, llm, cdp, uiMaps })` call in `src/core/agent.ts`). Read `src/core/agent.ts` `_executeTask` and add `uiMaps: (this as any).uiMapHolder ?? undefined` to the deps, with cli.ts setting `(agent as any).uiMapHolder = uiMapHolder;` next to the existing `cdpDriver` wiring.

> NOTE: mirror exactly how `cdpDriver` is already attached to the agent + placed on toolCtx in cli.ts (search `cdpDriver`). Same pattern, new field.

- [ ] **Step 3: FULL GATE** — run all and report each:
```
npx tsc --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npx vitest run
npx eslint src
```
Expected: both tsc clean; full suite passes (was 795 pass/1 skip + the new Part 2 tests); eslint 0 errors (16 pre-existing warnings OK — do not touch). Fix any eslint issue in NEW files inline. If a pre-existing test you didn't touch fails, report it.
- [ ] **Step 4: Commit**
```bash
git add src/surface/cli.ts src/core/agent.ts
git commit -m "feat(ui-map): wire session UIMapHolder into the daemon (loop + MCP share it)"
```

---

## Self-review (completed)

**Spec coverage:** §2 holder (nextId/put/resolve/invalidate, TTL=5s, MAX_HELD=2, strict unknown/stale/expired) → Task 1. §3 compile_ui tool + wiring → Task 4. §4 loop integration + invalidate-on-change → Task 6. §5 ref params (both-or-neither, capability+confidence gate, unique-name vs bounds dispatch, window+bounds guards) → Tasks 3 (plumbing) + 5 (resolver/dispatch). Holder on ToolContext+AgentToolContext + bridge → Task 3. Daemon/session wiring → Task 7. OCR/vision resilience (load-bearing once live) → Task 2.

**Placeholder scan:** none — every code step is complete. Two explicit "read the real signature before writing" NOTES (mouseClick/typeText in Task 5; §6b snapshot var + cdpDriver pattern in Tasks 6/7) are verification instructions, not placeholders — the surrounding code is given.

**Type consistency:** `UIMapHolder` (nextId/put/resolve/invalidate/currentId), `resolveRef`/`RefPlan`/`REF_MIN_CONFIDENCE`, `compileUIMap`/`defaultCompileDeps`/`renderUIMap`, `uiMaps?: UIMapHolder` on both contexts + `AgentDeps` — consistent across tasks. `now`/`snapshot_id` caller-passed throughout.

**Risk note:** Task 6 is the only one touching the live loop. It is deliberately ADDITIVE (reuse the captured snapshot; keep fingerprint/stagnation untouched; append compiled-UI text). If the existing run-agent suite shows perception-text-coupled failures, reconcile by appending (not replacing) the snapshot render.
