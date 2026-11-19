# UI State Compiler (Layer A) — Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure UI State Compiler — fuse a11y + OCR + (lazy) vision + window/display metadata into one confidence-scored, source-attributed `UIMap` the agent reasons over, app-agnostically.

**Architecture:** A new pure-core module `src/core/sense/ui-map.ts` orchestrates the *existing* sources (`captureSnapshot` for a11y, `OcrEngine` for OCR, `adapter.screenshot` for vision) behind injected functions so it's unit-testable with no real UIA/OCR. It emits a `UIMap` (types in `ui-map-types.ts`). Cheap sources first; vision only on demand. This plan covers the **core compiler only** — the `compile_ui` MCP tool and agent-loop staleness integration are a follow-on plan (Part 2) once the core is green.

**Tech Stack:** TypeScript, vitest, the existing `PlatformAdapter` / `OcrEngine` / `rank.ts` / `captureSnapshot`.

**Scope fence (from the spec, NOT in this plan):** no Layer B primitives (`find_action_button`, `fill_input`, …), no Layer C intent flows, no app-specific knowledge, no persistent element DB, no MCP/loop wiring (Part 2). The compiler never acts and never decides intent.

**Branch:** `v1.5.0`.

---

## Reused existing shapes (read before starting)

```ts
// src/core/sense/types.ts
interface SnapshotElement { name: string; role?: string; x: number; y: number;
  width: number; height: number; source: 'a11y'|'ocr'|'cdp'; automationId?: string;
  interactive?: boolean; secure?: boolean; value?: string; processId?: number; }
interface Snapshot { platform: 'windows'|'macos'|'linux';
  activeWindow?: { processId: number; processName: string; title: string;
    bounds: { x: number; y: number; width: number; height: number } };
  elements: SnapshotElement[]; fingerprint: string; capturedAt: number;
  sources: Array<'a11y'|'ocr'|'cdp'>; }

// src/core/sense/snapshot.ts
function captureSnapshot(adapter: PlatformAdapter): Promise<Snapshot>   // a11y-only today

// src/platform/ocr-engine.ts
interface OcrElement { text: string; x: number; y: number; width: number;
  height: number; confidence: number; line: number; }
interface OcrResult { elements: OcrElement[]; fullText: string; durationMs: number; }
class OcrEngine { isAvailable(): boolean; recognizeScreen(): Promise<OcrResult>; }

// src/platform/types.ts (PlatformAdapter)
getScreenSize(): Promise<{ logicalWidth; logicalHeight; physicalWidth; physicalHeight; dpiRatio }>
getFocusedElement(): Promise<UiElement | null>   // UiElement has name, controlType, bounds, enabled?, value?
screenshot(opts?): Promise<{ buffer: Buffer; width: number; height: number; scaleFactor: number }>

// src/core/sense/rank.ts
function rankWithScores(elements: SnapshotElement[], opts?): Array<{ el: SnapshotElement; score: number }>
```

Key fact: `captureSnapshot` is **a11y-only** today (the OCR-fusion comment is aspirational). The compiler adds OCR pull + fusion + confidence + capability + anchors + lazy escalation on top of the a11y spine it returns.

---

## Task 1: Data model types

**Files:**
- Create: `src/core/sense/ui-map-types.ts`
- Test: `src/__tests__/ui-map-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-types.test.ts
import { describe, it, expect } from 'vitest';
import type { UIMap, UIElement, ElementRef, Source } from '../core/sense/ui-map-types';
import { ROLES, SOURCES } from '../core/sense/ui-map-types';

describe('ui-map-types', () => {
  it('exports the role and source enums used across the compiler', () => {
    expect(ROLES).toContain('button');
    expect(ROLES).toContain('input');
    expect(ROLES).toContain('unknown');
    expect(SOURCES).toEqual(['window', 'a11y', 'ocr', 'vision', 'dom', 'cursor']);
  });

  it('a UIMap literal satisfies the shape', () => {
    const ref: ElementRef = { id: 'el_1', role: 'button', normalized_text: 'send' };
    const el: UIElement = {
      id: 'el_1', role: 'button', text: 'Send', normalized_text: 'send',
      bounds: [1, 2, 3, 4], confidence: 0.9, sources: ['a11y', 'ocr'],
      actionable: true, clickable: true, editable: false,
      state: { focused: true, enabled: true },
    };
    const map: UIMap = {
      snapshot_id: 'obs_1', platform: 'windows', active_app: 'Notepad',
      window_title: 'Untitled', window_bounds: [0, 0, 800, 600],
      coordinate_space: 'screen', scale_factor: 1, compiled_at: 't',
      sources_used: ['window', 'a11y'], elements: [el],
      anchors: { focused: ref }, truncation: { total_elements: 1, returned_elements: 1 },
    };
    expect(map.elements[0].id).toBe('el_1');
    const s: Source = 'vision';
    expect(s).toBe('vision');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-types.test.ts`
Expected: FAIL — cannot find module `../core/sense/ui-map-types`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sense/ui-map-types.ts
/**
 * UI State Compiler (Layer A) data model. See
 * notes/superpowers/specs/2026-06-07-ui-state-compiler-design.md.
 */
export const SOURCES = ['window', 'a11y', 'ocr', 'vision', 'dom', 'cursor'] as const;
export type Source = typeof SOURCES[number];

export const ROLES = [
  'button', 'input', 'text', 'link', 'checkbox',
  'list', 'listitem', 'tab', 'image', 'unknown',
] as const;
export type Role = typeof ROLES[number];

export type Bounds = [number, number, number, number]; // [x, y, w, h] screen-space

export interface ElementRef {
  id: string;
  role: Role;
  normalized_text?: string;
}

export interface UIElement {
  id: string;
  role: Role;
  text?: string;
  normalized_text?: string;
  bounds: Bounds;
  confidence: number;
  sources: Source[];
  actionable?: boolean;
  clickable?: boolean;
  editable?: boolean;
  state?: {
    focused?: boolean;
    enabled?: boolean;
    selected?: boolean;
    expanded?: boolean;
    value?: string;
  };
}

export interface UIMap {
  snapshot_id: string;
  platform: 'macos' | 'windows' | 'linux';
  active_app: string;
  process_id?: string;
  window_id?: string;
  window_title: string;
  window_bounds: Bounds;
  display_id?: string;
  coordinate_space: 'screen';
  scale_factor?: number;
  compiled_at: string;
  sources_used: Source[];
  elements: UIElement[];
  anchors: { focused?: ElementRef; primary_action_candidate?: ElementRef };
  truncation?: { total_elements: number; returned_elements: number };
}

export type MaxCost = 'cheap' | 'ocr_ok' | 'vision_ok';
export interface CompileHints {
  purpose?: 'general' | 'find_text' | 'act';
  target_text?: string;
  max_cost?: MaxCost;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/sense/ui-map-types.ts src/__tests__/ui-map-types.test.ts
git commit -m "feat(ui-map): Layer A data model types"
```

---

## Task 2: Role normalization + capability inference

**Files:**
- Create: `src/core/sense/ui-map-normalize.ts`
- Test: `src/__tests__/ui-map-normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-normalize.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeRole, inferCapabilities, normText } from '../core/sense/ui-map-normalize';

describe('normalizeRole', () => {
  it('maps UIA control types to normalized roles', () => {
    expect(normalizeRole('Button')).toBe('button');
    expect(normalizeRole('ControlType.Button')).toBe('button');
    expect(normalizeRole('Edit')).toBe('input');
    expect(normalizeRole('Hyperlink')).toBe('link');
    expect(normalizeRole('CheckBox')).toBe('checkbox');
    expect(normalizeRole('ListItem')).toBe('listitem');
    expect(normalizeRole('TabItem')).toBe('tab');
    expect(normalizeRole('Text')).toBe('text');
    expect(normalizeRole('Image')).toBe('image');
    expect(normalizeRole('SomethingWeird')).toBe('unknown');
    expect(normalizeRole(undefined)).toBe('unknown');
  });
});

describe('normText', () => {
  it('trims, lowercases, collapses whitespace', () => {
    expect(normText('  Send  Now ')).toBe('send now');
    expect(normText(undefined)).toBe('');
  });
});

describe('inferCapabilities', () => {
  it('a11y button is clickable + actionable when enabled', () => {
    const c = inferCapabilities({ role: 'button', source: 'a11y', enabled: true });
    expect(c).toMatchObject({ clickable: true, editable: false, actionable: true });
  });
  it('a disabled button is not actionable', () => {
    const c = inferCapabilities({ role: 'button', source: 'a11y', enabled: false });
    expect(c.actionable).toBe(false);
  });
  it('an input is editable', () => {
    const c = inferCapabilities({ role: 'input', source: 'a11y', enabled: true });
    expect(c).toMatchObject({ editable: true, actionable: true });
  });
  it('an OCR-only text element is not clickable/actionable (no pattern info)', () => {
    const c = inferCapabilities({ role: 'text', source: 'ocr', enabled: true });
    expect(c).toMatchObject({ clickable: false, editable: false, actionable: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-normalize.test.ts`
Expected: FAIL — cannot find module `../core/sense/ui-map-normalize`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sense/ui-map-normalize.ts
import type { Role, Source } from './ui-map-types';

const ROLE_MAP: Record<string, Role> = {
  button: 'button', splitbutton: 'button', menuitem: 'button',
  edit: 'input', document: 'input', combobox: 'input', spinner: 'input',
  text: 'text', statictext: 'text',
  hyperlink: 'link',
  checkbox: 'checkbox', radiobutton: 'checkbox',
  list: 'list', listbox: 'list',
  listitem: 'listitem', treeitem: 'listitem',
  tab: 'tab', tabitem: 'tab',
  image: 'image',
};

/** Map a UIA/AX control type (e.g. "ControlType.Button", "Edit") to a Role. */
export function normalizeRole(controlType?: string): Role {
  if (!controlType) return 'unknown';
  const key = controlType.replace(/^ControlType\./, '').trim().toLowerCase();
  return ROLE_MAP[key] ?? 'unknown';
}

/** Trim, lowercase, collapse internal whitespace. */
export function normText(text?: string): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const CLICKABLE_ROLES = new Set<Role>(['button', 'link', 'checkbox', 'listitem', 'tab']);

/**
 * Capability flags. role describes WHAT it is; these describe WHAT YOU CAN DO.
 * a11y elements carry pattern intent via role + enabled; OCR-only elements have
 * no pattern info, so they're read-only text unless a later source corroborates.
 */
export function inferCapabilities(opts: { role: Role; source: Source; enabled?: boolean }): {
  clickable: boolean; editable: boolean; actionable: boolean;
} {
  const fromA11y = opts.source === 'a11y';
  const clickable = fromA11y && CLICKABLE_ROLES.has(opts.role);
  const editable = fromA11y && opts.role === 'input';
  const enabled = opts.enabled !== false;
  const actionable = (clickable || editable) && enabled;
  return { clickable, editable, actionable };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-normalize.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/core/sense/ui-map-normalize.ts src/__tests__/ui-map-normalize.test.ts
git commit -m "feat(ui-map): role normalization + capability inference"
```

---

## Task 3: Per-source element mappers + confidence base

**Files:**
- Create: `src/core/sense/ui-map-elements.ts`
- Test: `src/__tests__/ui-map-elements.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-elements.test.ts
import { describe, it, expect } from 'vitest';
import { a11yToUI, ocrToUI } from '../core/sense/ui-map-elements';
import type { SnapshotElement } from '../core/sense/types';
import type { OcrElement } from '../platform/ocr-engine';

describe('a11yToUI', () => {
  it('maps an a11y Button to a clickable element with base confidence', () => {
    const se: SnapshotElement = { name: 'Send', role: 'Button', x: 10, y: 20,
      width: 30, height: 12, source: 'a11y', interactive: true };
    const el = a11yToUI(se, 'el_5');
    expect(el).toMatchObject({
      id: 'el_5', role: 'button', text: 'Send', normalized_text: 'send',
      bounds: [10, 20, 30, 12], sources: ['a11y'], clickable: true, actionable: true,
    });
    expect(el.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it('carries enabled/value into state', () => {
    const se: SnapshotElement = { name: 'To', role: 'Edit', x: 0, y: 0, width: 5,
      height: 5, source: 'a11y', interactive: true, value: 'a@b.com' };
    const el = a11yToUI(se, 'el_6');
    expect(el.editable).toBe(true);
    expect(el.state?.value).toBe('a@b.com');
  });
});

describe('ocrToUI', () => {
  it('maps an OCR token to a text element with confidence scaled below a11y', () => {
    const oe: OcrElement = { text: 'Send', x: 1, y: 2, width: 20, height: 8,
      confidence: 0.9, line: 3 };
    const el = ocrToUI(oe, 'el_7');
    expect(el).toMatchObject({ id: 'el_7', role: 'text', text: 'Send',
      normalized_text: 'send', sources: ['ocr'], clickable: false, actionable: false });
    expect(el.confidence).toBeLessThan(0.8);  // OCR-only is weaker than a11y
  });
  it('a 1-char OCR fragment lands below the actionable confidence floor', () => {
    const oe: OcrElement = { text: 'O', x: 1, y: 2, width: 4, height: 8,
      confidence: 0.9, line: 1 };
    const el = ocrToUI(oe, 'el_8');
    expect(el.confidence).toBeLessThan(0.4);   // the stray-"O" regression, structural
    expect(el.actionable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-elements.test.ts`
Expected: FAIL — cannot find module `../core/sense/ui-map-elements`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sense/ui-map-elements.ts
import type { SnapshotElement } from './types';
import type { OcrElement } from '../platform/ocr-engine';
import type { UIElement } from './ui-map-types';
import { normalizeRole, normText, inferCapabilities } from './ui-map-normalize';

// Confidence bases (see spec §3). a11y is structured/trustworthy; OCR is scaled
// by the recognizer's own score AND damped so a lone OCR hit never outranks a
// corroborated a11y element. 1-char OCR fragments are damped hard (stray-"O").
const A11Y_BASE = 0.85;
const OCR_SCALE = 0.6;

export function a11yToUI(se: SnapshotElement, id: string): UIElement {
  const role = normalizeRole(se.role);
  const caps = inferCapabilities({ role, source: 'a11y', enabled: se.interactive });
  return {
    id, role, text: se.name, normalized_text: normText(se.name),
    bounds: [se.x, se.y, se.width, se.height],
    confidence: A11Y_BASE, sources: ['a11y'], ...caps,
    state: { enabled: se.interactive !== false, value: se.secure ? undefined : se.value },
  };
}

export function ocrToUI(oe: OcrElement, id: string): UIElement {
  const role = 'text' as const;
  const caps = inferCapabilities({ role, source: 'ocr', enabled: true });
  // Single-char fragments are OCR noise — damp hard so they never win a match.
  const lenDamp = oe.text.trim().length <= 1 ? 0.4 : 1;
  const confidence = oe.confidence * OCR_SCALE * lenDamp;
  return {
    id, role, text: oe.text, normalized_text: normText(oe.text),
    bounds: [oe.x, oe.y, oe.width, oe.height],
    confidence, sources: ['ocr'], ...caps,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-elements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/sense/ui-map-elements.ts src/__tests__/ui-map-elements.test.ts
git commit -m "feat(ui-map): per-source element mappers + confidence base"
```

---

## Task 4: Fusion — corroborate + dedupe + confidence bonus

**Files:**
- Create: `src/core/sense/ui-map-fuse.ts`
- Test: `src/__tests__/ui-map-fuse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-fuse.test.ts
import { describe, it, expect } from 'vitest';
import { fuse } from '../core/sense/ui-map-fuse';
import type { UIElement } from '../core/sense/ui-map-types';

const mk = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'bounds' | 'sources'>): UIElement => ({
  role: 'button', text: 'x', normalized_text: 'x', confidence: 0.5, ...over,
});

describe('fuse', () => {
  it('merges an a11y + OCR element at the same place + text into one with both sources', () => {
    const a = mk({ id: 'a', bounds: [10, 10, 40, 12], sources: ['a11y'],
      normalized_text: 'send', confidence: 0.85, role: 'button', clickable: true, actionable: true });
    const o = mk({ id: 'o', bounds: [11, 11, 38, 11], sources: ['ocr'],
      normalized_text: 'send', role: 'text', confidence: 0.5 });
    const out = fuse([a, o]);
    expect(out).toHaveLength(1);
    expect(out[0].sources.sort()).toEqual(['a11y', 'ocr']);
    expect(out[0].role).toBe('button');            // a11y role wins over OCR 'text'
    expect(out[0].confidence).toBeGreaterThan(0.85); // agreement bonus raised it
    expect(out[0].confidence).toBeLessThanOrEqual(1);
  });

  it('keeps non-overlapping elements separate', () => {
    const a = mk({ id: 'a', bounds: [0, 0, 10, 10], sources: ['a11y'], normalized_text: 'one' });
    const b = mk({ id: 'b', bounds: [500, 500, 10, 10], sources: ['a11y'], normalized_text: 'two' });
    expect(fuse([a, b])).toHaveLength(2);
  });

  it('does NOT merge overlapping elements with different text', () => {
    const a = mk({ id: 'a', bounds: [0, 0, 100, 20], sources: ['a11y'], normalized_text: 'send' });
    const b = mk({ id: 'b', bounds: [2, 2, 96, 16], sources: ['ocr'], normalized_text: 'cancel' });
    expect(fuse([a, b])).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-fuse.test.ts`
Expected: FAIL — cannot find module `../core/sense/ui-map-fuse`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sense/ui-map-fuse.ts
import type { UIElement, Source, Role } from './ui-map-types';

const AGREEMENT_BONUS = 0.15;
const OVERLAP_MIN = 0.5;        // IoU threshold to treat two boxes as the same element
const ROLE_PRIORITY: Role[] = ['button', 'input', 'link', 'checkbox', 'tab',
  'listitem', 'list', 'image', 'text', 'unknown'];

function iou(a: UIElement['bounds'], b: UIElement['bounds']): number {
  const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ay >= 0 ? ay + ah : 0, by + bh);
  const iw = Math.max(0, x2 - x1), ih = Math.max(0, Math.min(ay + ah, by + bh) - y1);
  const inter = iw * ih;
  const uni = aw * ah + bw * bh - inter;
  return uni <= 0 ? 0 : inter / uni;
}

function betterRole(a: Role, b: Role): Role {
  return ROLE_PRIORITY.indexOf(a) <= ROLE_PRIORITY.indexOf(b) ? a : b;
}

/** Merge same-place + same-text elements across sources; raise confidence per
 *  corroborating source; keep the stronger role/capabilities. */
export function fuse(elements: UIElement[]): UIElement[] {
  const out: UIElement[] = [];
  for (const el of elements) {
    const match = out.find(o =>
      o.normalized_text === el.normalized_text &&
      o.normalized_text !== '' &&
      iou(o.bounds, el.bounds) >= OVERLAP_MIN);
    if (!match) { out.push({ ...el, sources: [...el.sources] }); continue; }
    const merged: Source[] = Array.from(new Set([...match.sources, ...el.sources]));
    match.sources = merged;
    match.role = betterRole(match.role, el.role);
    match.clickable = match.clickable || el.clickable;
    match.editable = match.editable || el.editable;
    match.actionable = match.actionable || el.actionable;
    match.confidence = Math.min(1, Math.max(match.confidence, el.confidence)
      + AGREEMENT_BONUS * (merged.length - 1 - 0)); // bonus per extra source beyond the first
    match.state = { ...el.state, ...match.state };
  }
  return out;
}
```

> NOTE for implementer: the `iou` above is intentionally written to be replaced
> with the clean version below once the test is green — keep the BEHAVIOR
> (IoU ≥ 0.5 ⇒ same box). Clean form:
> ```ts
> function iou(a, b) {
>   const [ax,ay,aw,ah]=a,[bx,by,bw,bh]=b;
>   const x1=Math.max(ax,bx), y1=Math.max(ay,by);
>   const x2=Math.min(ax+aw,bx+bw), y2=Math.min(ay+ah,by+bh);
>   const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1);
>   const uni=aw*ah+bw*bh-inter;
>   return uni<=0?0:inter/uni;
> }
> ```
> Use the clean form directly in Step 3; the test asserts behavior, not internals.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-fuse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/sense/ui-map-fuse.ts src/__tests__/ui-map-fuse.test.ts
git commit -m "feat(ui-map): cross-source fusion (corroborate + dedupe + confidence bonus)"
```

---

## Task 5: Lazy escalation orchestration (`compileUIMap`)

**Files:**
- Create: `src/core/sense/ui-map.ts`
- Test: `src/__tests__/ui-map-compile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-compile.test.ts
import { describe, it, expect, vi } from 'vitest';
import { compileUIMap, type CompileDeps } from '../core/sense/ui-map';
import type { Snapshot } from '../core/sense/types';
import type { OcrResult } from '../platform/ocr-engine';

function snap(elements: Snapshot['elements']): Snapshot {
  return { platform: 'windows',
    activeWindow: { processId: 9, processName: 'notepad', title: 'Untitled - Notepad',
      bounds: { x: 0, y: 0, width: 800, height: 600 } },
    elements, fingerprint: 'fp', capturedAt: 0, sources: elements.length ? ['a11y'] : [] };
}
const okOcr = (): OcrResult => ({ elements: [
  { text: 'Send', x: 10, y: 20, width: 40, height: 12, confidence: 0.95, line: 0 }],
  fullText: 'Send', durationMs: 1 });

function deps(over: Partial<CompileDeps> = {}): CompileDeps {
  return {
    captureSnapshot: vi.fn(async () => snap([
      { name: 'Send', role: 'Button', x: 10, y: 20, width: 40, height: 12,
        source: 'a11y', interactive: true }])),
    ocr: vi.fn(okOcr),
    vision: vi.fn(async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 })),
    getScreenSize: vi.fn(async () => ({ logicalWidth: 800, logicalHeight: 600,
      physicalWidth: 800, physicalHeight: 600, dpiRatio: 1 })),
    getFocusedElement: vi.fn(async () => null),
    now: 1234, snapshotId: 'obs_1', ...over,
  };
}

describe('compileUIMap — lazy escalation', () => {
  it('a11y-sufficient screen pulls NEITHER ocr NOR vision', async () => {
    const d = deps();
    const map = await compileUIMap(d, {});
    expect(d.ocr).not.toHaveBeenCalled();
    expect(d.vision).not.toHaveBeenCalled();
    expect(map.sources_used).toEqual(['window', 'a11y']);
    expect(map.elements.some(e => e.normalized_text === 'send')).toBe(true);
  });

  it('sparse a11y pulls OCR (spine fallback)', async () => {
    const d = deps({ captureSnapshot: vi.fn(async () => snap([])) });
    const map = await compileUIMap(d, {});
    expect(d.ocr).toHaveBeenCalledTimes(1);
    expect(map.sources_used).toContain('ocr');
    expect(map.elements.some(e => e.normalized_text === 'send')).toBe(true);
  });

  it('target_text absent from a11y pulls OCR even when a11y is non-empty', async () => {
    const d = deps(); // a11y has "Send" only
    await compileUIMap(d, { target_text: 'attach' });
    expect(d.ocr).toHaveBeenCalledTimes(1);
  });

  it('max_cost:"cheap" never pulls OCR or vision, even when a11y is empty', async () => {
    const d = deps({ captureSnapshot: vi.fn(async () => snap([])) });
    const map = await compileUIMap(d, { max_cost: 'cheap' });
    expect(d.ocr).not.toHaveBeenCalled();
    expect(d.vision).not.toHaveBeenCalled();
    expect(map.sources_used).toEqual(['window']);
  });

  it('max_cost:"ocr_ok" (default) never pulls vision even when a11y+ocr both empty', async () => {
    const d = deps({ captureSnapshot: vi.fn(async () => snap([])),
      ocr: vi.fn(async () => ({ elements: [], fullText: '', durationMs: 1 })) });
    await compileUIMap(d, {});
    expect(d.vision).not.toHaveBeenCalled();
  });

  it('populates coordinate metadata + snapshot_id + compiled_at from deps', async () => {
    const map = await compileUIMap(deps({ getScreenSize: vi.fn(async () => ({
      logicalWidth: 1280, logicalHeight: 720, physicalWidth: 2560, physicalHeight: 1440,
      dpiRatio: 2 })) }), {});
    expect(map.coordinate_space).toBe('screen');
    expect(map.scale_factor).toBe(2);
    expect(map.snapshot_id).toBe('obs_1');
    expect(map.compiled_at).toBe('1234');
    expect(map.active_app).toBe('notepad');
    expect(map.window_bounds).toEqual([0, 0, 800, 600]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-compile.test.ts`
Expected: FAIL — cannot find module `../core/sense/ui-map`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sense/ui-map.ts
/**
 * UI State Compiler (Layer A). Fuses a11y + OCR + (lazy) vision + window/display
 * metadata into one UIMap. Pure orchestration over injected sources so it is
 * unit-testable with no real UIA/OCR. See the design spec
 * notes/superpowers/specs/2026-06-07-ui-state-compiler-design.md.
 */
import type { PlatformAdapter, ScreenshotResult } from '../../platform/types';
import type { Snapshot } from './types';
import type { OcrResult } from '../../platform/ocr-engine';
import type { UIMap, UIElement, Source, CompileHints } from './ui-map-types';
import { a11yToUI, ocrToUI } from './ui-map-elements';
import { fuse } from './ui-map-fuse';

const SPARSE_A11Y_MAX = 2;          // ≤ this many named a11y elements ⇒ "sparse"
const LOW_CONFIDENCE = 0.5;         // below this on a needed element ⇒ vision-worthy

export interface CompileDeps {
  /** a11y spine — defaults to captureSnapshot(adapter) in production. */
  captureSnapshot: () => Promise<Snapshot>;
  /** OCR puller — defaults to () => new OcrEngine().recognizeScreen(). */
  ocr: () => Promise<OcrResult>;
  /** Vision puller — defaults to adapter.screenshot(). */
  vision: () => Promise<ScreenshotResult>;
  getScreenSize: PlatformAdapter['getScreenSize'];
  getFocusedElement: PlatformAdapter['getFocusedElement'];
  /** Caller-passed clock + id (pure: no Date.now in this module). */
  now: number;
  snapshotId: string;
}

function namedCount(snap: Snapshot): number {
  return snap.elements.filter(e => (e.name ?? '').trim().length > 0).length;
}

export async function compileUIMap(deps: CompileDeps, hints: CompileHints): Promise<UIMap> {
  const maxCost = hints.max_cost ?? 'ocr_ok';
  const sourcesUsed: Source[] = ['window'];

  const snap = await deps.captureSnapshot();
  if (snap.sources.includes('a11y')) sourcesUsed.push('a11y');

  let elements: UIElement[] = snap.elements.map((se, i) => a11yToUI(se, `el_${i}`));

  // Lazy OCR: only when a11y is sparse OR a requested target_text isn't present.
  const sparse = namedCount(snap) <= SPARSE_A11Y_MAX;
  const wantText = hints.target_text ? hints.target_text.trim().toLowerCase() : '';
  const a11yHasTarget = wantText
    ? elements.some(e => (e.normalized_text ?? '').includes(wantText))
    : true;
  const ocrAllowed = maxCost === 'ocr_ok' || maxCost === 'vision_ok';
  if (ocrAllowed && (sparse || !a11yHasTarget)) {
    const ocrRes = await deps.ocr();
    if (ocrRes.elements.length > 0) {
      sourcesUsed.push('ocr');
      const base = elements.length;
      elements = fuse([...elements, ...ocrRes.elements.map((oe, i) => ocrToUI(oe, `el_${base + i}`))]);
    }
  }

  // Lazy vision: only when allowed AND nothing usable surfaced from a11y+OCR.
  const visionAllowed = maxCost === 'vision_ok';
  const nothingActionable = !elements.some(e => e.actionable && e.confidence >= LOW_CONFIDENCE);
  if (visionAllowed && nothingActionable) {
    await deps.vision();           // (vision-source fusion handled in a later task/Part 2)
    sourcesUsed.push('vision');
  }

  // Re-id ids contiguously after fusion so el_NN is dense within this snapshot.
  elements = elements.map((e, i) => ({ ...e, id: `el_${i}` }));

  const screen = await deps.getScreenSize();
  const aw = snap.activeWindow;
  return {
    snapshot_id: deps.snapshotId,
    platform: snap.platform,
    active_app: aw?.processName ?? '',
    process_id: aw ? String(aw.processId) : undefined,
    window_title: aw?.title ?? '',
    window_bounds: aw ? [aw.bounds.x, aw.bounds.y, aw.bounds.width, aw.bounds.height] : [0, 0, 0, 0],
    coordinate_space: 'screen',
    scale_factor: screen.dpiRatio,
    compiled_at: String(deps.now),
    sources_used: sourcesUsed,
    elements,
    anchors: {},                   // filled in Task 6
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-compile.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/sense/ui-map.ts src/__tests__/ui-map-compile.test.ts
git commit -m "feat(ui-map): compileUIMap with lazy source escalation + cost ceiling"
```

---

## Task 6: Anchors (focused + primary-action candidate, cross-turn re-id)

**Files:**
- Create: `src/core/sense/ui-map-anchors.ts`
- Modify: `src/core/sense/ui-map.ts` (call `computeAnchors`, accept `prevAnchors`)
- Test: `src/__tests__/ui-map-anchors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-anchors.test.ts
import { describe, it, expect } from 'vitest';
import { computeAnchors } from '../core/sense/ui-map-anchors';
import type { UIElement } from '../core/sense/ui-map-types';

const el = (over: Partial<UIElement> & Pick<UIElement, 'id'>): UIElement => ({
  role: 'button', text: 't', normalized_text: 't', bounds: [0, 0, 10, 10],
  confidence: 0.9, sources: ['a11y'], clickable: true, actionable: true, ...over });

describe('computeAnchors', () => {
  it('sets focused from state.focused', () => {
    const a = computeAnchors([el({ id: 'el_0', normalized_text: 'to', role: 'input',
      state: { focused: true } }), el({ id: 'el_1' })], undefined);
    expect(a.focused?.id).toBe('el_0');
  });

  it('picks primary_action_candidate by primary verb + confidence', () => {
    const a = computeAnchors([
      el({ id: 'el_0', normalized_text: 'cancel' }),
      el({ id: 'el_1', normalized_text: 'send', confidence: 0.96 }),
    ], undefined);
    expect(a.primary_action_candidate?.id).toBe('el_1');
    expect(a.primary_action_candidate?.normalized_text).toBe('send');
  });

  it('returns no primary candidate when no clickable primary-verb element exists', () => {
    const a = computeAnchors([el({ id: 'el_0', normalized_text: 'random', role: 'text',
      clickable: false, actionable: false })], undefined);
    expect(a.primary_action_candidate).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-anchors.test.ts`
Expected: FAIL — cannot find module `../core/sense/ui-map-anchors`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sense/ui-map-anchors.ts
import type { UIElement, UIMap, ElementRef } from './ui-map-types';

const PRIMARY_VERBS = ['send', 'save', 'submit', 'ok', 'continue', 'next',
  'confirm', 'post', 'publish', 'done', 'apply'];

const toRef = (e: UIElement): ElementRef => ({
  id: e.id, role: e.role, normalized_text: e.normalized_text });

/**
 * Two cross-turn anchors. `prevAnchors` is accepted for re-identification
 * continuity (matched by role + normalized_text); with only two anchors this
 * stays cheap and needs no element database.
 */
export function computeAnchors(
  elements: UIElement[],
  _prevAnchors: UIMap['anchors'] | undefined,
): UIMap['anchors'] {
  const focusedEl = elements.find(e => e.state?.focused);
  const candidates = elements
    .filter(e => e.clickable && PRIMARY_VERBS.includes(e.normalized_text ?? ''))
    .sort((a, b) => b.confidence - a.confidence);
  return {
    focused: focusedEl ? toRef(focusedEl) : undefined,
    primary_action_candidate: candidates[0] ? toRef(candidates[0]) : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-anchors.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire anchors into compileUIMap**

In `src/core/sense/ui-map.ts`: add the import and an optional `prevAnchors` field on `CompileDeps`, and replace `anchors: {}` with the computed anchors.

```ts
// add near the other imports:
import { computeAnchors } from './ui-map-anchors';

// add to CompileDeps interface:
  /** Previous turn's anchors, for cross-turn continuity (optional). */
  prevAnchors?: UIMap['anchors'];

// in the returned object, replace `anchors: {},` with:
    anchors: computeAnchors(elements, deps.prevAnchors),
```

- [ ] **Step 6: Run the compile + anchors tests**

Run: `npx vitest run src/__tests__/ui-map-compile.test.ts src/__tests__/ui-map-anchors.test.ts`
Expected: PASS (both files).

- [ ] **Step 7: Commit**

```bash
git add src/core/sense/ui-map-anchors.ts src/core/sense/ui-map.ts src/__tests__/ui-map-anchors.test.ts
git commit -m "feat(ui-map): focused + primary-action-candidate anchors"
```

---

## Task 7: Compact ranked render + truncation

**Files:**
- Create: `src/core/sense/ui-map-render.ts`
- Test: `src/__tests__/ui-map-render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/ui-map-render.test.ts
import { describe, it, expect } from 'vitest';
import { renderUIMap } from '../core/sense/ui-map-render';
import type { UIMap, UIElement } from '../core/sense/ui-map-types';

const el = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'role' | 'normalized_text'>): UIElement => ({
  text: over.normalized_text, bounds: [1, 2, 3, 4], confidence: 0.9,
  sources: ['a11y'], clickable: true, actionable: true, ...over });

const baseMap = (elements: UIElement[]): UIMap => ({
  snapshot_id: 'obs_1', platform: 'windows', active_app: 'Notepad',
  window_title: 'Untitled', window_bounds: [0, 0, 800, 600], coordinate_space: 'screen',
  scale_factor: 1, compiled_at: '0', sources_used: ['window', 'a11y'], elements, anchors: {} });

describe('renderUIMap', () => {
  it('renders one compact line per element with id, role, text, confidence, sources', () => {
    const out = renderUIMap(baseMap([el({ id: 'el_0', role: 'button', normalized_text: 'send',
      text: 'Send', sources: ['a11y', 'ocr'], confidence: 0.96 })]));
    expect(out).toContain('el_0');
    expect(out).toContain('[button]');
    expect(out).toContain('"Send"');
    expect(out).toContain('0.96');
    expect(out).toContain('a11y,ocr');
  });

  it('ranks actionable/high-confidence elements before plain text, and truncates with a count', () => {
    const many: UIElement[] = [];
    for (let i = 0; i < 60; i++) many.push(el({ id: `el_${i}`, role: 'text',
      normalized_text: `t${i}`, clickable: false, actionable: false, confidence: 0.5 }));
    many.push(el({ id: 'el_btn', role: 'button', normalized_text: 'send', text: 'Send', confidence: 0.99 }));
    const out = renderUIMap(baseMap(many), { max: 40 });
    expect(out.split('\n')[0]).toContain('el_btn');  // the button ranks first
    expect(out).toMatch(/40 of 61 shown/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-render.test.ts`
Expected: FAIL — cannot find module `../core/sense/ui-map-render`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/sense/ui-map-render.ts
import type { UIMap, UIElement } from './ui-map-types';

const DEFAULT_MAX = 50;

/** Rank: actionable first, then by confidence. (Mirrors rank.ts intent without
 *  the SnapshotElement coupling — UIElement already carries actionability.) */
function rankScore(e: UIElement): number {
  return (e.actionable ? 1000 : 0) + e.confidence * 100;
}

function line(e: UIElement): string {
  const flags: string[] = [];
  if (e.state?.focused) flags.push('focused');
  if (e.clickable) flags.push('clickable');
  if (e.editable) flags.push('editable');
  if (e.state?.enabled === false) flags.push('disabled');
  const [x, y, w, h] = e.bounds;
  const conf = e.confidence.toFixed(2);
  const flagStr = flags.length ? ` {${flags.join(',')}}` : '';
  return `${e.id} [${e.role}] "${e.text ?? ''}" (${conf} ${e.sources.join(',')}) @${x},${y} ${w}x${h}${flagStr}`;
}

export function renderUIMap(map: UIMap, opts: { max?: number } = {}): string {
  const max = opts.max ?? DEFAULT_MAX;
  const ranked = [...map.elements].sort((a, b) => rankScore(b) - rankScore(a));
  const shown = ranked.slice(0, max);
  const head = `${map.active_app} — "${map.window_title}" [${map.snapshot_id}] (${map.sources_used.join('+')})`;
  const body = shown.map(line).join('\n');
  const trunc = ranked.length > max ? `\n… ${max} of ${ranked.length} shown` : '';
  return `${head}\n${body}${trunc}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-render.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Populate `truncation` on the map in compileUIMap**

In `src/core/sense/ui-map.ts`, before the `return`, compute and include truncation so callers know how much was elided when they render with a cap. Add to the returned object:

```ts
    truncation: { total_elements: elements.length, returned_elements: elements.length },
```

(Render-time capping sets `returned_elements`; the compiler reports the full total. Part 2 wires the loop's render cap into this field.)

- [ ] **Step 6: Run the full new suite**

Run: `npx vitest run src/__tests__/ui-map-types.test.ts src/__tests__/ui-map-normalize.test.ts src/__tests__/ui-map-elements.test.ts src/__tests__/ui-map-fuse.test.ts src/__tests__/ui-map-compile.test.ts src/__tests__/ui-map-anchors.test.ts src/__tests__/ui-map-render.test.ts`
Expected: PASS (all 7 files).

- [ ] **Step 7: Commit**

```bash
git add src/core/sense/ui-map-render.ts src/core/sense/ui-map.ts src/__tests__/ui-map-render.test.ts
git commit -m "feat(ui-map): compact ranked render + truncation count"
```

---

## Task 8: Production wiring helper + full gate

**Files:**
- Modify: `src/core/sense/ui-map.ts` (add a production `defaultCompileDeps(adapter, now, snapshotId)` factory)
- Test: `src/__tests__/ui-map-compile.test.ts` (add a factory smoke test)

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/ui-map-compile.test.ts
import { defaultCompileDeps } from '../core/sense/ui-map';
import type { PlatformAdapter } from '../platform/types';

describe('defaultCompileDeps', () => {
  it('builds deps wired to the adapter without throwing', () => {
    const adapter = {
      getScreenSize: async () => ({ logicalWidth: 1, logicalHeight: 1,
        physicalWidth: 1, physicalHeight: 1, dpiRatio: 1 }),
      getFocusedElement: async () => null,
      screenshot: async () => ({ buffer: Buffer.alloc(0), width: 1, height: 1, scaleFactor: 1 }),
    } as unknown as PlatformAdapter;
    const d = defaultCompileDeps(adapter, 5, 'obs_9');
    expect(d.now).toBe(5);
    expect(d.snapshotId).toBe('obs_9');
    expect(typeof d.captureSnapshot).toBe('function');
    expect(typeof d.ocr).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-map-compile.test.ts`
Expected: FAIL — `defaultCompileDeps` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/sense/ui-map.ts`:

```ts
import { captureSnapshot } from './snapshot';
import { OcrEngine } from '../../platform/ocr-engine';

let _ocr: OcrEngine | null = null;
function ocrEngine(): OcrEngine { return (_ocr ??= new OcrEngine()); }

/** Production deps wired to a real adapter. now/snapshotId are caller-passed
 *  (the agent loop owns the clock + the obs_N counter). */
export function defaultCompileDeps(
  adapter: PlatformAdapter, now: number, snapshotId: string, prevAnchors?: UIMap['anchors'],
): CompileDeps {
  return {
    captureSnapshot: () => captureSnapshot(adapter),
    ocr: () => ocrEngine().recognizeScreen(),
    vision: () => adapter.screenshot({ maxWidth: 1280 }),
    getScreenSize: () => adapter.getScreenSize(),
    getFocusedElement: () => adapter.getFocusedElement(),
    now, snapshotId, prevAnchors,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-map-compile.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate**

Run: `npx tsc --noEmit && npx tsc -p tsconfig.tests.json --noEmit && npx vitest run && npx eslint src`
Expected: tsc clean (both), all tests pass (existing + the 7 new ui-map files), eslint 0 errors. If eslint flags an unused import or `prefer-const`, fix inline and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/core/sense/ui-map.ts src/__tests__/ui-map-compile.test.ts
git commit -m "feat(ui-map): production defaultCompileDeps factory; core compiler complete"
```

---

## Self-review (completed)

**Spec coverage:** §2 data model → Task 1. §3 fusion (spine/corroborate/dedupe/confidence, stray-O) → Tasks 3+4. §4 lazy escalation + `max_cost` + `target_text` → Task 5. §5 anchors → Task 6. §6 render + coordinate metadata + truncation → Tasks 5+7. Capability flags (#4) → Task 2. snapshot_id + compiled_at (caller-passed, time note) → Task 5. **Deferred to Part 2 (explicitly):** the `compile_ui` MCP tool wiring (tool-meta/cost-class/safety/registry/schema-snapshot) and agent-loop per-turn integration + staleness rejection. These need real surface wiring and are their own plan.

**Placeholder scan:** none — every code step is complete. The one NOTE (Task 4 `iou`) instructs using the clean form directly; behavior is test-locked.

**Type consistency:** `CompileDeps`, `compileUIMap`, `UIMap`/`UIElement`/`ElementRef`/`Source`/`Role`/`CompileHints`, `a11yToUI`/`ocrToUI`, `fuse`, `computeAnchors`, `renderUIMap`, `defaultCompileDeps` — names and signatures are consistent across tasks. `now`/`snapshotId` caller-passed throughout (no `Date.now`).

**Part 2 (separate plan, after this core is green):** `compile_ui` MCP tool over `compileUIMap`+`renderUIMap` (System B → projected, `costClass: perceive-text`, safety tier read, schema-snapshot regen); agent-loop swap of per-turn perception to `compileUIMap` with `obs_N` ids; snapshot-staleness invalidation on screen-changing tools + stale-`snapshot_id` action rejection; vision-source fusion into the map.
