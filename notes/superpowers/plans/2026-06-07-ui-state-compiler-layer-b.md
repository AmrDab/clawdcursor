# UI State Compiler — Layer B Implementation Plan (semantic finders)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, OS-agnostic semantic finders — `find_action_button(intent)` and `find_input_field(purpose)` — that resolve an intent to the best `el_NN` over the UIMap and return a ref the agent acts on via the shipped Part-2 path.

**Architecture:** A pure matcher (`src/core/sense/ui-map-find.ts`) over `UIElement[]`: curated intent synonyms + score×confidence ranking + geometric label association (left/above, a11y OR OCR) for unnamed editable fields. A small `UIMapHolder` extension records each map's compiled `max_cost` so finders reuse a fresh compatible map (else compile fresh `ocr_ok`). Two System B tools project to the MCP surface. Tri-state result (`ok`/`ambiguous`/`none`).

**Tech Stack:** TypeScript, vitest, the shipped `compileUIMap`/`defaultCompileDeps`/`UIMapHolder`/`normText`.

**Spec:** `notes/superpowers/specs/2026-06-07-ui-state-compiler-layer-b-design.md`. **Branch:** `v1.5.0`.

**Scope fence:** NO find-and-act combinators, NO request_approval/HITL, NO Layer C, NO vision fusion, NO LLM in the matcher, NO `process.platform` branching anywhere in Layer B.

**Known boundary (by design):** finders rank only elements the UIMap marks `clickable`/`editable` — i.e. a11y-exposed interactive elements, where the Part-2 ref-act chain is valid. OCR text is used only as a *label source* to name an a11y-editable field, not as an independent actionable candidate. Pure-canvas/OCR-only interactive targets remain smart_click's domain; finders return `none` there.

---

## Reused shapes (read first)
```ts
// ui-map-types.ts
type Role = 'button'|'input'|'text'|'link'|'checkbox'|'list'|'listitem'|'tab'|'image'|'unknown';
type MaxCost = 'cheap'|'ocr_ok'|'vision_ok';
interface UIElement { id; role: Role; text?; normalized_text?; bounds:[x,y,w,h]; confidence:number; sources; clickable?; editable?; actionable?; state? }
// ui-map-holder.ts (CURRENT): put(map, now): void; resolve(id, now); nextId(); invalidate(); currentId(); TTL_MS=5000; MAX_HELD=2
//   held entries are { map: UIMap; compiledAt: number }
// ui-map.ts: compileUIMap(deps, hints), defaultCompileDeps(adapter, now, snapshotId, prevAnchors?)
// ui-map-normalize.ts: normText(text?) -> trimmed/lowercased/space-collapsed
// existing put callers to update: tools.ts:1454 (compile_ui), agent.ts:867 (storeUIMap)
```

---

## Task 1: UIMapHolder — record compiled max_cost + currentIfCost reuse

**Files:**
- Modify: `src/core/sense/ui-map-holder.ts`
- Modify: `src/core/agent-loop/tools.ts` (compile_ui `put` call), `src/core/agent-loop/agent.ts` (storeUIMap `put` call)
- Test: `src/__tests__/ui-map-holder.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/ui-map-holder.test.ts`:

```ts
import { COST_RANK } from '../core/sense/ui-map-holder';

describe('UIMapHolder — currentIfCost (cost-aware reuse)', () => {
  it('reuses a fresh current map compiled at >= requested cost', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000, 'ocr_ok');
    expect(h.currentIfCost('ocr_ok', 1000)?.snapshot_id).toBe(id); // equal cost ok
    expect(h.currentIfCost('cheap', 1000)?.snapshot_id).toBe(id);  // higher-than-requested ok
  });

  it('refuses a cheaper-than-requested map (compile fresh)', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000, 'cheap');
    expect(h.currentIfCost('ocr_ok', 1000)).toBeNull(); // cheap < ocr_ok
  });

  it('refuses a stale/expired/invalidated map', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000, 'ocr_ok');
    expect(h.currentIfCost('ocr_ok', 1000 + TTL_MS + 1)).toBeNull(); // expired
    h.invalidate();
    expect(h.currentIfCost('ocr_ok', 1000)).toBeNull();             // invalidated
  });

  it('treats an unrecorded (undefined) cost as not satisfying an ocr_ok request', () => {
    const h = new UIMapHolder();
    const id = h.nextId();
    h.put(mapWith(id), 1000);                 // legacy 2-arg put, no cost recorded
    expect(h.currentIfCost('ocr_ok', 1000)).toBeNull();
    expect(COST_RANK.cheap).toBeLessThan(COST_RANK.ocr_ok);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-holder.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement** — in `src/core/sense/ui-map-holder.ts`:

Add import + rank table near the top (after the existing imports/constants):
```ts
import type { MaxCost } from './ui-map-types';

/** Perception-cost ordering for reuse decisions: cheap < ocr_ok < vision_ok. */
export const COST_RANK: Record<MaxCost, number> = { cheap: 0, ocr_ok: 1, vision_ok: 2 };
```

Change the held-entry type and `put` signature to record cost:
```ts
  private held: Array<{ map: UIMap; compiledAt: number; maxCost?: MaxCost }> = [];
```
```ts
  /** Store a compiled map as the new current; records the compiled max_cost
   *  (for currentIfCost reuse); un-invalidates; bounds to MAX_HELD. */
  put(map: UIMap, now: number, maxCost?: MaxCost): void {
    this.held.push({ map, compiledAt: now, maxCost });
    if (this.held.length > MAX_HELD) this.held.shift();
    this.invalidated = false;
  }
```

Add `currentIfCost` after `resolve`:
```ts
  /** Return the current map iff it resolves (fresh/in-TTL/not-invalidated) AND
   *  was compiled at a cost >= requested. Else null (caller compiles fresh).
   *  Correctness first, cost-reuse second. */
  currentIfCost(requested: MaxCost, now: number): UIMap | null {
    const current = this.held[this.held.length - 1];
    if (!current) return null;
    if (this.resolve(current.map.snapshot_id, now).ok !== true) return null;
    if (current.maxCost === undefined) return null;              // unknown cost → don't reuse
    return COST_RANK[current.maxCost] >= COST_RANK[requested] ? current.map : null;
  }
```

- [ ] **Step 4: Update the two existing `put` callers** to pass their cost:
  - `src/core/agent-loop/tools.ts` compile_ui (`holder.put(map, now)`) → `holder.put(map, now, hints.max_cost ?? 'ocr_ok')` (use the effective max_cost the tool compiled with; read the surrounding code to use the exact var — it builds `hints` with `max_cost`; pass `hints.max_cost ?? 'ocr_ok'`).
  - `src/core/agent-loop/agent.ts` storeUIMap (`holder.put(map, now)`) → `holder.put(map, now, 'cheap')` (the loop compiles with `max_cost: 'cheap'`).

- [ ] **Step 5: Run** `npx vitest run src/__tests__/ui-map-holder.test.ts src/__tests__/ui-map-compile-ui-tool.test.ts src/__tests__/run-agent.test.ts` → PASS (holder new tests + the two callers still work).
- [ ] **Step 6: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 7: Commit**
```bash
git add src/core/sense/ui-map-holder.ts src/core/agent-loop/tools.ts src/core/agent-loop/agent.ts src/__tests__/ui-map-holder.test.ts
git commit -m "feat(ui-map): holder records compiled max_cost + currentIfCost reuse"
```

---

## Task 2: Pure matcher core — synonyms, scoring, tri-state, find_action_button

**Files:**
- Create: `src/core/sense/ui-map-find.ts`
- Test: `src/__tests__/ui-map-find.test.ts`

- [ ] **Step 1: Write the failing test** `src/__tests__/ui-map-find.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findActionButton, MATCH_THRESHOLD, AMBIGUITY_MARGIN, MAX_CANDIDATES } from '../core/sense/ui-map-find';
import type { UIElement } from '../core/sense/ui-map-types';

const btn = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'normalized_text'>): UIElement => ({
  role: 'button', text: over.normalized_text, bounds: [0, 0, 40, 12], confidence: 0.9,
  sources: ['a11y'], clickable: true, actionable: true, ...over });

describe('findActionButton', () => {
  it('matches an intent to a synonym-labeled button (submit -> "Send")', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'send' }), btn({ id: 'el_1', normalized_text: 'cancel' })], 'obs_1', 'submit');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.best.element_id).toBe('el_0'); expect(r.snapshot_id).toBe('obs_1'); }
  });

  it('ignores non-clickable elements', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'send', clickable: false, actionable: false })], 'obs_1', 'submit');
    expect(r.status).toBe('none');
  });

  it('exact literal match outranks a synonym', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'post', confidence: 0.8 }), btn({ id: 'el_1', normalized_text: 'publish', confidence: 0.99 })], 'obs_1', 'post');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_0'); // exact 1.0*0.8=0.8 > synonym 0.9*0.99=0.891? -> see note
  });

  it('returns ambiguous when top two are within the margin', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'ok', confidence: 0.9 }), btn({ id: 'el_1', normalized_text: 'confirm', confidence: 0.9 })], 'obs_1', 'submit');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') { expect(r.candidates.length).toBe(2); expect(r.reason).toMatch(/margin/i); }
  });

  it('returns none with candidates when nothing clears the threshold', () => {
    const r = findActionButton([btn({ id: 'el_0', normalized_text: 'weather widget' })], 'obs_1', 'submit');
    expect(r.status).toBe('none');
    if (r.status === 'none') expect(Array.isArray(r.candidates)).toBe(true);
  });

  it('caps candidates at MAX_CANDIDATES', () => {
    const els = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => btn({ id: `el_${i}`, normalized_text: 'send' }));
    const r = findActionButton(els, 'obs_1', 'send');
    expect(r.candidates.length).toBe(MAX_CANDIDATES);
  });
});
```

> NOTE on the "exact outranks synonym" test: exact match scores `1.0 × conf`, synonym `0.9 × conf`. With el_0 exact@0.8 = 0.80 and el_1 synonym@0.99 = 0.891, the SYNONYM would actually win. To make the test assert what we want (exact wins on equal-ish confidence), set confidences so exact wins: change el_1 confidence to 0.85 (synonym 0.9×0.85=0.765 < exact 0.8). UPDATE the test literals so el_0 (exact) wins: `btn({id:'el_1', normalized_text:'publish', confidence: 0.85})`. Implementer: ensure the test encodes a real exact-wins case; the scoring formula is `rawMatch × confidence`.

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-find.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/core/sense/ui-map-find.ts`:

```ts
/**
 * Layer B — pure, deterministic semantic finders over a compiled UIMap.
 * Turn an intent/purpose into the best el_NN. No LLM, no platform calls,
 * no process.platform branching. See the Layer B design spec.
 */
import type { UIElement, Role } from './ui-map-types';
import { normText } from './ui-map-normalize';

export const MATCH_THRESHOLD = 0.4;   // min score×confidence to count as a match
export const AMBIGUITY_MARGIN = 0.05; // top-two closeness that forces 'ambiguous'
export const MAX_CANDIDATES = 5;

export interface FindCandidate { element_id: string; label: string; role: Role; score: number; confidence: number; }
export type FindResult =
  | { status: 'ok'; snapshot_id: string; best: FindCandidate; candidates: FindCandidate[] }
  | { status: 'ambiguous'; snapshot_id: string; reason: string; candidates: FindCandidate[] }
  | { status: 'none'; snapshot_id: string; reason: string; candidates: FindCandidate[] };

/** Curated intent → synonym sets. Unknown intents fall back to literal/token match. */
const ACTION_SYNONYMS: Record<string, string[]> = {
  submit: ['submit', 'send', 'ok', 'confirm', 'save', 'continue', 'next', 'post', 'publish', 'apply', 'done', 'go'],
  cancel: ['cancel', 'close', 'dismiss', 'back', 'no'],
  delete: ['delete', 'remove', 'trash', 'discard'],
  search: ['search', 'find', 'go', 'query'],
  login: ['login', 'log in', 'sign in', 'signin'],
  open: ['open', 'launch', 'view'],
  add: ['add', 'new', 'create', 'plus'],
};

/** Expand an intent into a match-term set: the literal, its tokens, and any
 *  synonym list the literal keys into or appears within. */
export function expandTerms(intent: string, table: Record<string, string[]>): Set<string> {
  const lit = normText(intent);
  const terms = new Set<string>([lit]);
  lit.split(' ').filter(Boolean).forEach(t => terms.add(t));
  for (const [key, syns] of Object.entries(table)) {
    if (key === lit || syns.includes(lit)) syns.forEach(s => terms.add(s));
  }
  terms.delete('');
  return terms;
}

/** Raw 0..1 match of a label against the term set (no confidence yet). */
export function scoreLabel(label: string, terms: Set<string>, intentTokens: string[]): number {
  const L = normText(label);
  if (!L) return 0;
  if (terms.has(L)) return 1.0;
  const lTokens = L.split(' ').filter(Boolean);
  const lSet = new Set(lTokens);
  for (const t of terms) {
    if (lSet.has(t)) return 0.9;                          // term is a whole word in the label
    if (t.length > 2 && L.includes(t)) return 0.9;        // term is a substring of the label
  }
  const overlap = intentTokens.filter(t => lSet.has(t)).length;
  return intentTokens.length > 0 ? 0.5 * (overlap / intentTokens.length) : 0;
}

/** Shared finder core. `labelOf` lets fields override with geometric association. */
export function runFinder(
  elements: UIElement[],
  snapshotId: string,
  intent: string,
  table: Record<string, string[]>,
  isCandidate: (e: UIElement) => boolean,
  labelOf: (e: UIElement, all: UIElement[]) => string,
): FindResult {
  const terms = expandTerms(intent, table);
  const intentTokens = normText(intent).split(' ').filter(Boolean);
  const scored: FindCandidate[] = [];
  for (const e of elements) {
    if (!isCandidate(e)) continue;
    const label = labelOf(e, elements);
    const raw = scoreLabel(label, terms, intentTokens);
    if (raw <= 0) continue;
    scored.push({ element_id: e.id, label, role: e.role, score: raw * e.confidence, confidence: e.confidence });
  }
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, MAX_CANDIDATES);
  const best = scored[0];
  if (!best || best.score < MATCH_THRESHOLD) {
    return { status: 'none', snapshot_id: snapshotId, reason: 'no candidate cleared the match threshold', candidates };
  }
  const second = scored[1];
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return { status: 'ambiguous', snapshot_id: snapshotId, reason: `top candidates within ${AMBIGUITY_MARGIN} score margin`, candidates };
  }
  return { status: 'ok', snapshot_id: snapshotId, best, candidates };
}

export function findActionButton(elements: UIElement[], snapshotId: string, intent: string): FindResult {
  return runFinder(elements, snapshotId, intent, ACTION_SYNONYMS,
    e => e.clickable === true,
    e => e.normalized_text ?? '');
}
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/ui-map-find.test.ts` → PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/sense/ui-map-find.ts src/__tests__/ui-map-find.test.ts
git commit -m "feat(ui-map): pure matcher core + find_action_button (synonyms, scoring, tri-state)"
```

---

## Task 3: find_input_field + geometric label association

**Files:**
- Modify: `src/core/sense/ui-map-find.ts`
- Test: `src/__tests__/ui-map-find.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `src/__tests__/ui-map-find.test.ts`:

```ts
import { findInputField, associateLabel } from '../core/sense/ui-map-find';

const field = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'bounds'>): UIElement => ({
  role: 'input', normalized_text: '', text: '', confidence: 0.85, sources: ['a11y'],
  editable: true, actionable: true, clickable: false, ...over });
const text = (over: Partial<UIElement> & Pick<UIElement, 'id' | 'normalized_text' | 'bounds'>): UIElement => ({
  role: 'text', text: over.normalized_text, confidence: 0.8, sources: ['a11y'], ...over });

describe('findInputField', () => {
  it('matches a field by its OWN name when present', () => {
    const els = [field({ id: 'el_0', normalized_text: 'subject', text: 'Subject', bounds: [200, 50, 400, 24] })];
    const r = findInputField(els, 'obs_1', 'subject');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_0');
  });

  it('ignores non-editable elements', () => {
    const els = [text({ id: 'el_0', normalized_text: 'to', bounds: [10, 50, 30, 20] })];
    expect(findInputField(els, 'obs_1', 'recipient').status).toBe('none');
  });

  it('associates a LEFT label to a label-less field (To -> recipient)', () => {
    const els = [
      text({ id: 'el_lbl', normalized_text: 'to', bounds: [10, 50, 30, 20] }),     // label left
      field({ id: 'el_fld', bounds: [60, 48, 500, 24] }),                          // unnamed field to its right
    ];
    const r = findInputField(els, 'obs_1', 'recipient'); // recipient synonyms include 'to'
    expect(r.status).toBe('ok');
    if (r.status === 'ok') { expect(r.best.element_id).toBe('el_fld'); expect(r.best.label).toBe('to'); }
  });

  it('associates an ABOVE label when no left label exists', () => {
    const els = [
      text({ id: 'el_lbl', normalized_text: 'subject', bounds: [60, 20, 80, 18] }), // label above
      field({ id: 'el_fld', bounds: [60, 46, 500, 24] }),
    ];
    const r = findInputField(els, 'obs_1', 'subject');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_fld');
  });

  it('uses an OCR-sourced label (WebView field)', () => {
    const els = [
      text({ id: 'el_lbl', normalized_text: 'to', bounds: [10, 50, 30, 20], sources: ['ocr'] }),
      field({ id: 'el_fld', bounds: [60, 48, 500, 24], sources: ['a11y'] }),
    ];
    const r = findInputField(els, 'obs_1', 'recipient');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.best.element_id).toBe('el_fld');
  });
});

describe('associateLabel', () => {
  it('prefers a left label over an above label', () => {
    const fld = field({ id: 'f', bounds: [100, 100, 200, 24] });
    const all = [fld,
      text({ id: 'left', normalized_text: 'leftlabel', bounds: [40, 102, 50, 20] }),
      text({ id: 'above', normalized_text: 'abovelabel', bounds: [100, 70, 80, 18] })];
    expect(associateLabel(fld, all)).toBe('leftlabel');
  });
  it('returns empty when no label is within range', () => {
    const fld = field({ id: 'f', bounds: [100, 100, 200, 24] });
    const far = text({ id: 't', normalized_text: 'faraway', bounds: [2000, 2000, 50, 20] });
    expect(associateLabel(fld, [fld, far])).toBe('');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-find.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement** — append to `src/core/sense/ui-map-find.ts`:

```ts
const MAX_LABEL_GAP_X = 240;  // px: a left label's right edge to the field's left edge
const MAX_LABEL_GAP_Y = 64;   // px: an above label's bottom edge to the field's top edge

const LABEL_ROLES = new Set<Role>(['text', 'link', 'unknown']);

/** Find the descriptive label for an (unnamed) field by geometry: nearest text
 *  element to the LEFT (same row) preferred, else ABOVE (same column). a11y OR
 *  OCR sourced. Returns '' when none is within range. Pure geometry. */
export function associateLabel(field: UIElement, all: UIElement[]): string {
  const [fx, fy, , fh] = field.bounds;
  const fCenterY = fy + fh / 2;
  let left: { gap: number; label: string } | null = null;
  let above: { gap: number; label: string } | null = null;
  for (const e of all) {
    if (e.id === field.id || !LABEL_ROLES.has(e.role)) continue;
    const label = e.normalized_text ?? '';
    if (!label) continue;
    const [ex, ey, ew, eh] = e.bounds;
    const eRight = ex + ew, eBottom = ey + eh, eCenterY = ey + eh / 2, eCenterX = ex + ew / 2;
    // LEFT, same row: label's vertical center within the field's y-band, right edge just left of the field.
    const sameRow = eCenterY >= fy && eCenterY <= fy + fh;
    if (sameRow && eRight <= fx + 4) {
      const gap = fx - eRight;
      if (gap >= 0 && gap <= MAX_LABEL_GAP_X && (!left || gap < left.gap)) left = { gap, label };
    }
    // ABOVE, same column: label horizontally overlaps the field, bottom just above the field top.
    const sameCol = eCenterX >= fx && eCenterX <= fx + (field.bounds[2]);
    if (sameCol && eBottom <= fy + 4) {
      const gap = fy - eBottom;
      if (gap >= 0 && gap <= MAX_LABEL_GAP_Y && (!above || gap < above.gap)) above = { gap, label };
    }
  }
  return (left ?? above)?.label ?? '';
}

const FIELD_SYNONYMS: Record<string, string[]> = {
  recipient: ['to', 'recipient', 'email', 'address', 'send to'],
  cc: ['cc', 'carbon copy'],
  subject: ['subject', 'title', 're'],
  body: ['body', 'message', 'content', 'compose', 'note'],
  search: ['search', 'query', 'find', 'filter'],
  password: ['password', 'pass', 'pwd'],
  username: ['username', 'user', 'login', 'email'],
  name: ['name', 'full name'],
};

export function findInputField(elements: UIElement[], snapshotId: string, purpose: string): FindResult {
  return runFinder(elements, snapshotId, purpose, FIELD_SYNONYMS,
    e => e.editable === true,
    e => {
      const own = e.normalized_text ?? '';
      return own !== '' ? own : associateLabel(e, elements);
    });
}
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/ui-map-find.test.ts` → PASS (all).
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/sense/ui-map-find.ts src/__tests__/ui-map-find.test.ts
git commit -m "feat(ui-map): find_input_field + geometric label association (a11y/OCR, left/above)"
```

---

## Task 4: Finder tools + MCP wiring + full gate

**Files:**
- Modify: `src/core/agent-loop/tools.ts` (two tools), `tool-meta.ts`, `src/tools/cost-class.ts`, `src/core/safety.ts`, `src/tools/registry.ts`
- Test: `src/__tests__/ui-map-find-tools.test.ts`
- Regen: `schema.snapshot.json`

- [ ] **Step 1: Write the failing test** `src/__tests__/ui-map-find-tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildUnifiedTools } from '../core/agent-loop/tools';
import { UIMapHolder } from '../core/sense/ui-map-holder';
import type { AgentToolContext } from '../core/agent-loop/types';
import type { PlatformAdapter } from '../platform/types';

const tool = (name: string) => buildUnifiedTools().find(t => t.name === name)!;

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

describe('find_action_button / find_input_field tools', () => {
  it('both tools are registered, perception, changesScreen=false', () => {
    expect(tool('find_action_button').changesScreen).toBe(false);
    expect(tool('find_input_field').changesScreen).toBe(false);
  });

  it('find_action_button compiles, stores a current map, and returns an OK result resolvable by the ref path', async () => {
    const holder = new UIMapHolder();
    const res = await tool('find_action_button').execute({ intent: 'submit' }, ctx(holder)); // a11y "Send" button
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe('ok');
    expect(parsed.snapshot_id).toBe(holder.currentId());                       // current
    expect(holder.resolve(parsed.snapshot_id, Date.now()).ok).toBe(true);     // ref-resolvable (find->act chain)
    expect(parsed.best.label).toBe('send');
  });

  it('returns none JSON when nothing matches', async () => {
    const holder = new UIMapHolder();
    const res = await tool('find_action_button').execute({ intent: 'delete' }, ctx(holder)); // no delete button
    expect(JSON.parse(res.text).status).toBe('none');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-find-tools.test.ts` → FAIL (tools not found).

- [ ] **Step 3: Implement the tools** in `src/core/agent-loop/tools.ts`. Add imports with the other `../sense/ui-map*` imports:
```ts
import { findActionButton, findInputField } from '../sense/ui-map-find';
```
Add a shared helper (module scope near the other helpers in the file) that picks the map (reuse-or-compile) — read how compile_ui builds `defaultCompileDeps` and mirror it:
```ts
async function finderMap(ctx: AgentToolContext, rawMaxCost: unknown) {
  const holder = ctx.uiMaps;
  if (!holder) return null;
  const requested = (rawMaxCost === 'cheap' || rawMaxCost === 'ocr_ok' || rawMaxCost === 'vision_ok') ? rawMaxCost : 'ocr_ok';
  const now = Date.now();
  const reuse = holder.currentIfCost(requested, now);
  if (reuse) return reuse;
  const id = holder.nextId();
  const map = await compileUIMap(defaultCompileDeps(ctx.platform, now, id), { max_cost: requested });
  holder.put(map, now, requested);
  return map;
}
```
Add the two tools (next to compile_ui):
```ts
    {
      name: 'find_action_button',
      description: 'Semantically locate the best clickable element for an intent (e.g. "submit", "cancel", "search") over the compiled UI. Returns JSON {status:"ok"|"ambiguous"|"none", snapshot_id, best?, candidates}. On "ok", act with invoke_element({element_id: best.element_id, snapshot_id}). Matches by synonyms + text + confidence; deterministic, no guessing.',
      inputSchema: { type: 'object', properties: {
        intent: { type: 'string', description: 'What you want to do (submit/cancel/search/login/...)' },
        max_cost: { type: 'string', enum: ['cheap', 'ocr_ok', 'vision_ok'], description: 'Perception cost ceiling (default ocr_ok)' },
      }, required: ['intent'], additionalProperties: false },
      changesScreen: false,
      async execute(args, ctx) {
        const map = await finderMap(ctx, args.max_cost);
        if (!map) return { success: false, text: 'find_action_button: no UIMap holder on this context.' };
        const r = findActionButton(map.elements, map.snapshot_id, String(args.intent ?? ''));
        return { success: r.status === 'ok', text: JSON.stringify(r) };
      },
    },
    {
      name: 'find_input_field',
      description: 'Semantically locate the best editable field for a purpose (e.g. "recipient", "subject", "body", "search") over the compiled UI, including label-less fields via their adjacent label. Returns JSON {status, snapshot_id, best?, candidates}. On "ok", fill with set_field_value({element_id: best.element_id, snapshot_id, value}). Deterministic.',
      inputSchema: { type: 'object', properties: {
        purpose: { type: 'string', description: 'What the field is for (recipient/subject/body/search/...)' },
        max_cost: { type: 'string', enum: ['cheap', 'ocr_ok', 'vision_ok'], description: 'Perception cost ceiling (default ocr_ok)' },
      }, required: ['purpose'], additionalProperties: false },
      changesScreen: false,
      async execute(args, ctx) {
        const map = await finderMap(ctx, args.max_cost);
        if (!map) return { success: false, text: 'find_input_field: no UIMap holder on this context.' };
        const r = findInputField(map.elements, map.snapshot_id, String(args.purpose ?? ''));
        return { success: r.status === 'ok', text: JSON.stringify(r) };
      },
    },
```

- [ ] **Step 4: Wire metadata (mirror `compile_ui` exactly).**
  - `tool-meta.ts`: add `find_action_button` and `find_input_field` entries (category 'perception', safetyTier 0, costClass 'perceive-text', paramDescriptions for intent/purpose + max_cost).
  - `src/tools/cost-class.ts`: add `find_action_button: 'perceive-text', find_input_field: 'perceive-text',` in the perceive-text group.
  - `src/core/safety.ts` TOOL_TIER: add `'find_action_button': 'read', 'find_input_field': 'read',`.
  - `src/tools/registry.ts`: add both names to `A11Y_SYSB_NAMES` and `A11Y_MCP_NAMES`.

- [ ] **Step 5: Run** `npx vitest run src/__tests__/ui-map-find-tools.test.ts` → PASS.
- [ ] **Step 6: Regenerate schema + run its test**
```bash
npx tsx scripts/build-mcp-schema.ts --write
npx vitest run src/__tests__/mcp-schema-snapshot.test.ts src/__tests__/cost-class-coverage.test.ts
```
Expected: snapshot rewritten (tool count +2 → 98), both tests pass.
- [ ] **Step 7: FULL GATE**
```
npx tsc --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npx vitest run
npx eslint src
```
Both tsc clean; full suite passes (was 820 pass/1 skip + the new Layer B tests); eslint 0 errors (16 pre-existing warnings OK — don't touch; fix only new-file issues). If a pre-existing untouched test fails, report it.
- [ ] **Step 8: Commit**
```bash
git add src/core/agent-loop/tools.ts src/core/agent-loop/tool-meta.ts src/tools/cost-class.ts src/core/safety.ts src/tools/registry.ts schema.snapshot.json src/__tests__/ui-map-find-tools.test.ts
git commit -m "feat(ui-map): find_action_button + find_input_field MCP tools (reuse-or-compile, JSON result)"
```

---

## Self-review (completed)

**Spec coverage:** §2 result contract (tri-state, candidates, constants) → Task 2. §3 matcher (synonyms/scoring/label-association) → Tasks 2+3. §4 finder tools + map-source policy (currentIfCost reuse else fresh ocr_ok) + wiring → Tasks 1 (holder) + 4 (tools). §5 testing → each task. Holder extension → Task 1.

**Placeholder scan:** none — full code in every step. The one NOTE (Task 2 exact-vs-synonym test) instructs fixing the test literals so the assertion encodes a real exact-wins case (scoring is `rawMatch × confidence`); implementer must set confidences accordingly.

**Type consistency:** `FindResult`/`FindCandidate`/`runFinder`/`findActionButton`/`findInputField`/`associateLabel`/`expandTerms`/`scoreLabel`, `COST_RANK`/`currentIfCost`/`put(…,maxCost?)`, finder tool names — consistent across tasks. `MaxCost` reused from ui-map-types. Matcher is pure (UIElement[] in, FindResult out); no platform/OS branching.

**Boundary documented:** finders rank only `clickable`/`editable` (a11y) elements; OCR is a label source only. Pure-OCR interactive targets → `none` (agent uses smart_click). Stated in the plan header + the matcher doc comment.
