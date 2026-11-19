# UI State Compiler — Layer A Design

**Date:** 2026-06-07
**Status:** Approved (design); implementation not started
**Author:** brainstormed with the maintainer

---

## 1. Context & motivation

clawdcursor drives a GUI for an AI agent. Today the agent perceives through
*separate* channels it must orchestrate by hand — `captureSnapshot` (a11y
tree), `read_text`/`ocr` (OCR), `screenshot` (vision), `listWindows` (window
metadata) — and decide, per call, which to use and how to reconcile them. This
pushes perception strategy into the model and produces brittle behavior:

- **Wrong-window actions** — a coordinate click lands on an occluding window
  because nothing fused window metadata with element bounds (live 2026-06-07:
  Settings combobox hidden behind full-screen Outlook).
- **Stray low-quality matches** — `smart_click("OK")` clicked a 1-char OCR
  fragment "O" at 0.45 because OCR had no corroboration signal.
- **DPI / coordinate-space confusion** — clicks off by a scale factor because
  coordinate space wasn't explicit on the data.
- **Token cost** — the agent reaches for screenshots (the most expensive
  perception) when it can't reason over a11y/OCR, defeating the whole
  cost argument for clawdcursor over raw computer-use. This matters most for
  external agents driving via OpenClaw, who pay per token.

**The fix is a UI State Compiler:** fuse every available perception source into
one *unified, confidence-scored, source-attributed* UI map that the agent
reasons over — app-agnostically. No per-app guides. The agent observes a
compiled screen, reasons over elements, acts, and verifies.

### The three-layer architecture (this spec is Layer A only)

```
Layer A — UI State Compiler   (THIS SPEC)
  fuse a11y + OCR + vision + window/process/display + cursor/keyboard + DOM
  -> one UIMap (elements with id, role, text, bounds, confidence, sources)

Layer B — Semantic primitives  (later spec)
  find_action_button(intent), find_input_field(purpose), fill_input,
  click_element, verify_state, request_approval — operate OVER the UIMap

Layer C — Intent flows         (later spec)
  send_message -> find recipient -> fill -> find body -> fill -> find submit
  -> approve -> click -> verify   (compose Layer B primitives; app-agnostic)
```

Layer A is the foundation; B and C are meaningless without it and get their
own spec → plan → implementation cycles.

### Design decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Primary goals | reliability of tool usage, token efficiency, security/constraint, reusability |
| Build order | Layer A first; B and C later, each its own cycle |
| Vision usage | **lazy escalation** — cheap sources first; vision only on low confidence / disagreement / sparse a11y+OCR |
| Element identity | **hybrid anchors** — per-snapshot element IDs + two cross-turn anchors (focused, primary-action candidate) |
| Structure | **evolve `captureSnapshot` into `sense/ui-map.ts`**; used by the loop per-turn AND exposed as a `compile_ui` MCP tool; reuses `captureSnapshot`, `OcrEngine`, `screenshot`, `rank`, `renderSnapshot` |
| Layer A boundary | observes and compiles ONLY — never acts, never decides intent |

---

## 2. Data model

The canonical object the compiler emits each observation.

```ts
type Source = 'window' | 'a11y' | 'ocr' | 'vision' | 'dom' | 'cursor';

interface UIMap {
  snapshot_id: string;            // e.g. "obs_104" — referenced by actions; staleness-checked
  platform: 'macos' | 'windows' | 'linux';

  active_app: string;
  process_id?: string;
  window_id?: string;
  window_title: string;
  window_bounds: [number, number, number, number]; // [x, y, w, h]

  display_id?: string;
  coordinate_space: 'screen';     // all bounds are screen-space pixels (see §6)
  scale_factor?: number;          // physical/logical for the element's display

  compiled_at: string;            // ISO timestamp (passed in; see §6 note on time)
  sources_used: Source[];         // HONEST record of what was actually consulted/paid for

  elements: UIElement[];

  anchors: {
    focused?: ElementRef;                  // the focused element
    primary_action_candidate?: ElementRef; // a candidate — NOT a directive
  };

  truncation?: {
    total_elements: number;
    returned_elements: number;
  };
}

interface UIElement {
  id: string;                     // "el_21" — per-snapshot, stable only within this UIMap
  role: 'button' | 'input' | 'text' | 'link' | 'checkbox' | 'list'
      | 'listitem' | 'tab' | 'image' | 'unknown';   // normalized across sources

  text?: string;                  // raw text
  normalized_text?: string;       // trimmed, lowercased, whitespace-collapsed
  bounds: [number, number, number, number];         // [x, y, w, h], screen-space

  confidence: number;             // 0.0–1.0
  sources: Source[];              // which channels corroborate THIS element

  actionable?: boolean;           // can be acted on at all
  clickable?: boolean;            // supports an activation (Invoke/Toggle/SelectionItem/etc.)
  editable?: boolean;             // supports value entry (ValuePattern / AXValue)

  state?: {
    focused?: boolean;
    enabled?: boolean;
    selected?: boolean;
    expanded?: boolean;
    value?: string;
  };
}

interface ElementRef {            // a stable cross-turn handle for the two anchors
  id: string;                     // the el_NN in the CURRENT snapshot
  role: UIElement['role'];
  normalized_text?: string;
}
```

Notes:
- `role` is **descriptive**; `actionable`/`clickable`/`editable` are
  **capability** flags. The agent must rely on capability, not role — a `text`
  element can be clickable, a `button` can be disabled (`enabled:false`,
  `actionable:false`). This promotes the activation-cascade lesson into data.
- `sources[]` on each element + `sources_used` on the map make cost and trust
  auditable: a high-confidence `[a11y,ocr]` element cost zero vision tokens.

---

## 3. Fusion — "best-available spine + corroboration"

1. **Pick the spine** (the structural skeleton):
   - a11y tree if non-empty; **else** OCR (sparse-a11y apps: new Outlook,
     WebViews, Electron); **else** vision. There is always a skeleton, even on
     canvas-only apps.
2. **Normalize** each spine element into `UIElement` (role mapping per source,
   raw + normalized text, screen-space bounds, capability flags from a11y
   patterns when present).
3. **Corroborate**: for each spine element, other already-consulted cheap
   sources that agree — bounds-overlap above a threshold **AND** normalized-text
   match — are added to `sources[]` and raise the element's confidence.
4. **OCR-fill**: OCR tokens that match no spine element become their own
   `UIElement`s (role inferred conservatively; bare text → `text`/`unknown`,
   lower confidence). This is how WebView/canvas buttons surface at all.
5. **Dedupe**: elements with overlapping bounds + matching normalized text
   merge into one with the union of `sources[]`.

**Confidence** = base-per-source (a11y high, OCR = its own recognizer score,
vision mid) **+** an agreement bonus per corroborating source, capped at 1.0.

> The stray-"O" mis-click dies structurally here: a 1-char OCR-only fragment
> has no corroboration and a low base, so it lands below the actionable
> threshold and never wins a match.

---

## 4. Lazy escalation (the cost guard)

Sources are consulted cheapest-first, and only as far as needed:

- **Always** (free/cheap): window/process/display metadata + a11y tree +
  cursor/keyboard state. DOM is included when a CDP browser is already
  connected (cheap, structured).
- **OCR**: pulled only when the a11y tree is **empty** (zero named elements —
  the spine-fallback case, e.g. a WebView/canvas compose surface), **or** a
  requested `target_text` is absent from the a11y tree. (Implementation:
  `SPARSE_A11Y_MAX = 0`. A non-empty-but-thin a11y tree relies on the
  `target_text` path or `max_cost: "vision_ok"` rather than a raw count
  threshold — the most cost-conservative reading of "sparse".)
- **Vision**: pulled **only** when both a11y and OCR are empty/sparse, **or**
  confidence on a needed element is below threshold / sources disagree.

Every escalation is recorded in `sources_used`. A clean a11y(+OCR) screen costs
**zero vision tokens** — identical to today's per-turn snapshot cost. Vision is
the documented exception, not the default.

### `compile_ui` hints (controlled escalation)

```ts
compile_ui({
  purpose?: 'general' | 'find_text' | 'act',   // default 'general'
  target_text?: string,                        // if set & absent from a11y -> pull OCR
  max_cost?: 'cheap' | 'ocr_ok' | 'vision_ok', // hard ceiling; default 'ocr_ok'
})
```

- `max_cost:'cheap'` → window + a11y only, **never** OCR or vision, even when
  sparse (the strictest OpenClaw budget).
- `max_cost:'ocr_ok'` (default) → may pull OCR; never vision.
- `max_cost:'vision_ok'` → may escalate all the way to vision when justified.

The ceiling is hard: the compiler will return a lower-confidence / partial map
rather than exceed `max_cost`.

---

## 5. Anchors (hybrid identity)

Element IDs (`el_NN`) are per-snapshot. On top of that, exactly **two**
cross-turn anchors give the agent short-term memory without a re-identification
engine:

- `anchors.focused` ← the element whose `state.focused` is true.
- `anchors.primary_action_candidate` ← the highest-confidence `clickable`
  element whose normalized text matches primary-action heuristics
  (send / save / submit / ok / continue / next) within the active window. It is
  a **candidate**, surfaced for convenience — Layer A never asserts the agent
  should click it.

**Re-identification** across consecutive turns is by (role + normalized_text +
nearest bounds). Bounded at two anchors → cheap, no element database, no general
frame-to-frame tracking.

---

## 6. Output, rendering & integration

### Rendering for the LLM
The structured `UIMap` is canonical. For LLM context it is rendered compact and
**ranked by role priority before truncation** (reuses `rank.ts`):

```
el_21 [button] "Send" (0.96 a11y,ocr) @42,88 70x32 {focused,clickable}
el_22 [input]  "To"   (0.91 a11y)     @140,160 760x30 {editable}
... (+38 more elements; 40 of 78 shown)
```

`truncation` records `total_elements` vs `returned_elements`.

### Coordinate space
All `bounds` are **screen-space** pixels (`coordinate_space:'screen'`), matching
what the a11y/OCR sources already return (`real_screen_pixels`). `scale_factor`
and `display_id` are explicit on the map so action tools convert correctly on
Retina / mixed-DPI Windows / multi-monitor. Action tools consume bounds +
coordinate metadata; the map never stores image-space coordinates.

### Agent-loop integration & staleness
- The loop's per-turn perception becomes `compileUIMap()` (default cost = window
  + a11y, identical to today) instead of `captureSnapshot` + `renderSnapshot`.
- **Staleness = the safe-action guarantee.** A `snapshot_id` is invalidated the
  moment any screen-changing tool runs (backstop: when the existing
  a11y/pixel fingerprint moves). An action that references a **stale**
  `snapshot_id` (e.g. `click el_21 from obs_104`) is **rejected** with a
  "recompile first" error instead of clicking blind coordinates. An action on
  the **current** snapshot resolves `el_NN` → live bounds + coordinate metadata.
- Exposed as a `compile_ui` MCP tool (System B → projected to the granular
  surface, like the existing perception tools), returning the JSON `UIMap` for
  external/OpenClaw agents (mirrors how `ocr_read_screen` returns structured
  JSON today). `costClass` = `perceive-text` (the common a11y/OCR case),
  documented as *may escalate to vision* under `max_cost:'vision_ok'`. Safety
  tier: read.

### Time note
`Date.now()`/`new Date()` are unavailable in some execution contexts; the
compiler accepts `compiled_at` (and any timestamp) from its caller rather than
reading the clock internally, keeping the fusion pure and testable.

---

## 7. Testing plan

All tests use mocked `PlatformAdapter` + mocked `OcrEngine` (no real UIA — UIA
writes/reads can't run in the sandbox), matching the existing suite
(`run-agent.test.ts`, `smart-tools.test.ts`, `invoke-cascade.test.ts`).

- **Fusion:** a11y + OCR agree (bounds overlap + text match) → one merged
  element, `sources:['a11y','ocr']`, confidence raised by the agreement bonus.
- **Spine fallback:** empty a11y → OCR spine; empty a11y **and** OCR → vision
  spine (mocked).
- **Confidence / stray-O:** a 1-char OCR-only fragment scores below the
  actionable threshold and is not returned as actionable (regression lock).
- **Lazy escalation:**
  - a11y-sufficient map calls `OcrEngine`/`screenshot` **zero** times.
  - `target_text` present in a11y → no OCR; absent → exactly one OCR pull.
  - `max_cost:'cheap'` → never calls OCR or vision even on a sparse tree.
  - `max_cost:'ocr_ok'` → never calls vision.
- **Anchors:** `focused` + `primary_action_candidate` populated correctly;
  re-identified across two frames by role + normalized_text + nearest bounds.
- **Staleness:** an action referencing a stale `snapshot_id` is rejected; the
  current `snapshot_id` resolves to live bounds.
- **Coordinate metadata:** `scale_factor`, `coordinate_space`, `display_id`
  populated; render is ranked-before-truncated with an accurate `truncation`.
- **Capability flags:** disabled button → `actionable:false`; clickable `text`
  element → `clickable:true` (role ≠ capability).

---

## 8. Scope fence — deliberately NOT in Layer A

- ❌ `find_action_button` / `find_input_field` / `fill_input` / `click_element`
  / `verify_state` / `request_approval` — **Layer B**.
- ❌ intent flows (`send_message`, etc.) — **Layer C**.
- ❌ any app-specific knowledge, per-app guides, or playbooks (deleted in
  v1.0.0; not coming back).
- ❌ a persistent element database or general frame-to-frame re-identification
  beyond the two anchors.
- ❌ Layer A never **acts** and never **decides intent** — it observes and
  compiles. Acting and intent live in B and C.

---

## 9. Files (anticipated)

- **New:** `src/core/sense/ui-map.ts` (the compiler: orchestrate sources, fuse,
  score, anchor, render), `src/core/sense/ui-map-types.ts` (the data model),
  `src/__tests__/ui-map.test.ts`.
- **Edit (later, during implementation):** `src/core/agent-loop/agent.ts`
  (per-turn perception → `compileUIMap`, snapshot-id staleness), the MCP
  registry + `tool-meta` + `cost-class` + `safety` wiring for the `compile_ui`
  tool, and `rank.ts`/`renderSnapshot` reuse.
- **Reused:** `captureSnapshot`, `OcrEngine`, `screenshot`, `listWindows`,
  `rank`, `renderSnapshot`.

The new compiler is pure core: it depends on `PlatformAdapter` (reads) + the
existing source modules, never on the agent loop or the MCP surface — so it is
unit-testable in isolation and mountable both in the loop and as a tool.
