# UI State Compiler — Layer A Part 2 Design (wiring + safe-action)

**Date:** 2026-06-07
**Status:** Approved (design); implementation not started
**Branch:** `v1.5.0`
**Builds on:** Layer A core (`src/core/sense/ui-map*.ts`, shipped) — see
`2026-06-07-ui-state-compiler-design.md`.

---

## 1. Context & scope

Layer A's core compiler (`compileUIMap` → `UIMap`, `renderUIMap`) is built and
unit-tested but **not wired into anything live**. Part 2 wires it in and adds the
*safe-action* contract so an agent can act on a specific compiled element
(`el_NN`) without the stale-coordinate risk that by-name actions can't express
(e.g. two "Open" buttons).

**In scope (this cycle):**
1. `compile_ui` MCP tool — expose the compiler on the granular surface.
2. Agent-loop integration — per-turn perception via `compileUIMap`.
3. `snapshot_id` lifecycle + staleness + `el_NN` resolution on
   `invoke_element` / `set_field_value` (additive optional params).

**Out of scope (deferred):**
- Vision-element fusion (a screenshot isn't elements without a model — its own
  design).
- Layer B semantic resolvers (`find_action_button`/`find_input_field`),
  `verify_state`, `request_approval`.
- Layer C intent flows.

**Approved decisions (brainstorming):**

| Decision | Choice |
|---|---|
| Action contract | `el_NN` refs **additive** alongside by-name; by-name unchanged |
| Where refs live | optional params on `invoke_element` + `set_field_value`, **not** a new tool |
| Map holder | on the shared `ToolContext`, **session-scoped**, last 1–2 maps |
| Ref params | `{snapshot_id, element_id}` required **together** (both or neither) |
| Staleness | **TTL** + **invalidate after any screen-changing action** + strict rejection |

---

## 2. The UIMap holder (session-scoped)

A small holder lives on the shared `ToolContext` (one per daemon/agent session),
so both the internal loop and external MCP callers resolve refs the same way.

```ts
// src/core/sense/ui-map-holder.ts
interface HeldMap { map: UIMap; compiledAt: number; }   // compiledAt = caller-passed ms

class UIMapHolder {
  // Mint the next session-scoped id ("obs_<n>", monotonic). The caller gets the
  // id FIRST, passes it to compileUIMap (which takes snapshot_id as input), then
  // calls put() with the resulting map. This resolves the "who owns obs_N"
  // question: the holder mints, the caller compiles-with-it, the holder stores.
  nextId(): string;
  // Keeps the most recent MAX_HELD maps keyed by snapshot_id (insertion order).
  put(map: UIMap, now: number): void;
  // Returns the map for snapshot_id ONLY if it is the current (latest) one,
  // not invalidated, and within TTL. Otherwise returns a typed rejection reason.
  resolve(snapshotId: string, now: number):
    | { ok: true; map: UIMap }
    | { ok: false; reason: 'unknown' | 'stale' | 'expired' };
  // Marks all held maps invalid (called after any screen-changing action).
  invalidate(): void;
  currentId(): string | undefined;
}
```

Usage (loop and `compile_ui` alike):
```ts
const id = ctx.uiMaps.nextId();                 // "obs_7"
const map = await compileUIMap(defaultCompileDeps(adapter, now, id, prevAnchors), hints);
ctx.uiMaps.put(map, now);                        // map.snapshot_id === id
```

- `MAX_HELD = 2` (current + one prior, for diagnostics; only the current is
  resolvable).
- `TTL_MS = 5_000` — a held map older than this resolves as `'expired'` even if
  it is the latest. GUI state changes fast, so action refs must expire quickly
  (a 30s window would be fine for diagnostics but risky for dispatch); 5s is the
  strict default, tunable. "Current-only + invalidate-on-change" guards
  causality; the short TTL guards wall-clock drift the agent can't observe.
- **Strict rejection:** `resolve` returns `ok:false` for: a `snapshot_id` not
  held / evicted (`'unknown'`); a `snapshot_id` that isn't the current one or
  was invalidated by a screen-changing action (`'stale'`); a map past TTL
  (`'expired'`). Only the **current, non-invalidated, in-TTL** map resolves.
- Pure/clock-free: `now` is caller-passed (consistent with the compiler).

The holder is attached to `ToolContext` (e.g. `ctx.uiMaps`), created once per
session. `snapshot_id` is `obs_<n>` minted by `nextId()` (see usage above) so the
caller can pass it into `compileUIMap` before storing the result.

---

## 3. `compile_ui` MCP tool

A System B tool (in `agent-loop/tools.ts`) over `compileUIMap` + `renderUIMap`,
projected to the granular MCP surface exactly like `verify`/`read_screen`.

- **Params:** the existing `CompileHints` — `purpose` (`general`/`find_text`/
  `act`), `target_text`, `max_cost` (`cheap`/`ocr_ok`/`vision_ok`).
- **Behavior:** build deps via `defaultCompileDeps(ctx.platform, now, nextObsId)`,
  compile, `ctx.uiMaps.put(map, now)`, return `{ text: renderUIMap(map), ... }`
  and the structured `UIMap` (mirrors how `ocr_read_screen` returns JSON).
- **Wiring:** `TOOL_META` (`category: perception`, `costClass: perceive-text`
  documented may-escalate), `COST_CLASS_BY_TOOL`, `core/safety` TOOL_TIER
  `read`, registry `A11Y_SYSB_NAMES` + `A11Y_MCP_NAMES`, regenerate
  `schema.snapshot.json`.
- `changesScreen: false`.

So an external/OpenClaw agent can: `compile_ui` → read the ranked map + ids →
act with `invoke_element({element_id, snapshot_id})`.

---

## 4. Agent-loop integration

Replace the loop's per-turn perception (currently `captureSnapshot` +
`renderSnapshot`, `agent.ts` §5c/§6b) with the compiler:

- Each turn: `const id = ctx.uiMaps` next `obs_N`; `map = await
  compileUIMap(defaultCompileDeps(adapter, now, id, prevAnchors), {})`;
  `ctx.uiMaps.put(map, now)`; render via `renderUIMap(map)` into the turn's
  perception text. Default cost = window+a11y — **same cost as today**.
- `prevAnchors` = the previous turn's `map.anchors` (cross-turn continuity seam;
  re-id stays as-built).
- **Invalidate on change:** after any tool with `changesScreen: true` executes,
  call `ctx.uiMaps.invalidate()` so any `el_NN` ref from the pre-action map is
  strictly rejected until the next compile. (The loop already re-perceives after
  screen-changing tools — that re-compile produces the fresh `obs_N+1`.)
- The existing fingerprint/stagnation machinery is unchanged (the UIMap render
  replaces the snapshot render; the fingerprint still comes from the a11y
  snapshot inside `compileUIMap`'s spine).

---

## 5. `el_NN` resolution on `invoke_element` / `set_field_value`

Both tools gain two **optional** params: `element_id` and `snapshot_id`.

- **Both-or-neither:** if exactly one is present → error
  `"provide element_id and snapshot_id together, or neither (use name)"`. If
  neither → the existing **by-name path, unchanged**. If both → the ref path.
- **Ref path:**
  1. `r = ctx.uiMaps.resolve(snapshot_id, now)`. If `!r.ok` → reject:
     `unknown` → `"unknown snapshot <id> — call compile_ui first"`;
     `stale` → `"stale snapshot — the screen changed; call compile_ui again"`;
     `expired` → `"snapshot expired — call compile_ui again"`. **No action runs.**
  2. Look up `element_id` in `r.map.elements`. Not found → reject
     `"element <id> not in snapshot <id>"`.
  3. **Capability + confidence gate (both dispatch paths).** Reject before any
     action if the resolved element fails the intent:
     - `confidence < REF_MIN_CONFIDENCE` (`0.5`) → `"element <id> confidence too
       low to act on — recompile / re-find"`.
     - click intent and not `actionable` (or `state.enabled === false`) →
       `"element <id> is not actionable (disabled?)"`.
     - fill intent and not `editable` → `"element <id> is not editable"`.
  4. **Dispatch by resolved identity** (preserves disambiguation):
     - If the element has a non-empty `normalized_text` that is **unique** in the
       map → dispatch the existing a11y path by that name (invoke-cascade for
       click; set-value for fill) — keeps the reliable blind-route a11y path.
     - Otherwise (duplicate name, or empty name) → dispatch by the element's
       **bounds**. Before the coordinate action, run the bounds pre-dispatch
       guards (in addition to step 3): (a) the **active window still matches** the
       map's window (live `getActiveWindow()` — `processId`/title equals
       `map.process_id`/`window_title`); (b) the element's **bounds lie within the
       active window's bounds**. If either fails → reject `"window changed or
       element off the active window — call compile_ui again"` and do NOT click.
       Only then: click = scaled coordinate click at the bounds center (existing
       focus-guard + scale-factor path); fill = coordinate focus at center then
       type. These guards make the "bounds are trustworthy" claim explicit rather
       than assumed — current + in-TTL is necessary but not sufficient.
  5. On success, return the normal tool result, tagged with the resolved id
     (e.g. `… (via el_21)`).

This reuses the hardened invoke-cascade / set-value paths; the only new logic is
resolve-then-choose-dispatch. By-name callers (incl. all current MCP usage) are
completely unaffected.

> Future enhancement (noted, not in scope): carry `automationId` into `UIElement`
> so ref dispatch can use a precise UIA handle instead of coordinates for
> duplicate-name a11y elements — avoids coordinates entirely. Deferred to keep
> Layer A types frozen this cycle.

---

## 6. Testing

Mocked-adapter / mocked-holder harness, matching the existing suite.

**Holder (unit):**
- `put` keeps ≤ MAX_HELD; oldest evicted.
- `resolve` returns `ok` only for the current id within TTL; older-but-held id →
  `stale`; evicted/never-put id → `unknown`; current id past TTL → `expired`;
  after `invalidate()` the current id → `stale`.

**`compile_ui` tool:**
- Returns a render + structured map; calls `holder.put`; honors hints (passes
  `max_cost`/`target_text` through to `compileUIMap`).

**Ref resolution on invoke_element / set_field_value:**
- Both params present + current snapshot + unique name → dispatches the a11y
  path; result tagged with the id.
- Duplicate name → dispatches by bounds (coordinate), not by ambiguous name.
- Stale snapshot (after a screen-changing action / `invalidate`) → **rejected,
  no dispatch** (assert the platform action mock was NOT called).
- Expired (TTL — element compiled >5s ago) snapshot → rejected.
- Only one of the two params → error, no dispatch.
- Neither param → by-name path unchanged (existing tests still pass).
- **Capability/confidence gate:** click on a non-actionable/disabled element →
  rejected; fill on a non-editable element → rejected; element with
  `confidence < 0.5` → rejected. No dispatch in any case.
- **Bounds pre-dispatch guards:** when falling back to coordinate dispatch
  (duplicate/empty name), if the active window no longer matches the map's
  window, or the element's bounds fall outside the active window → rejected, no
  coordinate click (assert the mouse mock was NOT called).

**Loop integration (run-agent harness):**
- A turn's perception text is the `renderUIMap` output with an `obs_N` id.
- After a screen-changing tool, the holder is invalidated (a subsequent ref
  action referencing the pre-action id is rejected).
- Default-cost compile pulls neither OCR nor vision (cost parity with today).

**Gate:** `tsc` src+tests, full `vitest`, `eslint` 0 errors, schema-snapshot
regenerated and committed.

---

## 7. Files

- **New:** `src/core/sense/ui-map-holder.ts` (+ test), `compile_ui` tool in
  `src/core/agent-loop/tools.ts` (+ tests).
- **Modify:** `src/core/agent-loop/tools.ts` (`invoke_element` +
  `set_field_value` ref params + resolution), `src/core/agent-loop/types.ts`
  (`AgentToolContext.uiMaps?`), `src/tools/types.ts` (`ToolContext.uiMaps?`),
  `src/core/agent-loop/agent.ts` (per-turn `compileUIMap` + invalidate on
  screen-change), `tool-meta.ts` / `cost-class.ts` / `core/safety.ts` /
  `tools/registry.ts` (compile_ui wiring), `schema.snapshot.json` (regen).
- **Reused:** `compileUIMap`, `renderUIMap`, `defaultCompileDeps`, the
  invoke-cascade, `set_field_value`, focus-guard, scale-factor coord path.

## 8. Scope fence

- ❌ vision-element fusion (deferred — own design).
- ❌ Layer B (`find_*`, `verify_state`, `request_approval`) and Layer C flows.
- ❌ no new standalone action tool — refs are params on the two existing tools.
- ❌ no change to by-name behavior or the existing MCP by-name surface.
- ❌ no `automationId` on `UIElement` this cycle (Layer A types stay frozen).
