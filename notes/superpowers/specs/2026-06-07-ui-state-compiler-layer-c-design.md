# UI State Compiler — Layer C Design (reactive step discipline)

**Date:** 2026-06-07
**Status:** Approved (design); implementation not started
**Branch:** `v1.5.0`
**Builds on:** Layer A + Part 2 (UIMap, holder, el_NN ref actions) + Layer B
(semantic finders) + the shipped `verify`/`done(assertions)` engine.

---

## 1. Context & principle

Maintainer's principle: **"Layer C should be modular but reactive. It does not
assume the UI will obey the plan. It checks, adapts, and continues."**

The agent loop (`runAgent`) already reasons → acts → re-perceives each turn.
What it lacks is *discipline*: it can perform an action and proceed as if it
worked, building on a false assumption (the 2026-06-06 Outlook failure — typed a
recipient, assumed success, sent, failed). Layer C closes that gap **without** a
fixed recipe (a recipe is a plan the UI might not obey) and **without** a second
loop. It makes each consequential action *self-checking*: act → verify the
expected effect → on deviation, feed back so the agent adapts → otherwise
continue. The step *sequence* stays fully reasoned by the model.

**Approved decisions (brainstorming):**

| Decision | Choice |
|---|---|
| Nature | reactive executor with **reasoned** steps (no fixed recipes) |
| Structure | **modular reactive-step wrapper** over the existing `runAgent` loop (loop unchanged as the reasoner; each consequential action becomes self-checking) |
| Expected-change | **hybrid** — agent-stated `expect` = HARD check (chip-safe); tolerant "did anything change?" = SOFT always-on advisory |
| `expect` lives on | the four consequential acting tools: `invoke_element`, `set_field_value`, `type`, `key` |
| Deviation | sets `success:false` (surfaces as an error the agent must address) |

**Hard constraint:** OS-agnostic — assertions run via `PlatformAdapter` reads;
no `process.platform` branching.

---

## 2. The reactive step

The consequential acting tools gain an **optional `expect`** parameter — an
array of assertions in the *exact shape the `verify`/`done` tools already accept*
(`window_title_contains`, `app_running`, `element_exists`,
`element_value_contains`, `clipboard_contains`, `file_exists`, `file_contains`,
`ocr_contains`). Parsed/validated by the existing `parseAssertions`; checked by
the existing `checkAssertions`.

After such a tool executes, the loop applies a post-action check:

### 2a. Hard check (agent-reasoned → chip-safe)
If `expect` was provided:
- Run `checkAssertions(expect, { adapter, ocrText })` against live state.
- **All pass** → the action result is unchanged (success), with a short
  `— verified: <n> check(s)` suffix.
- **Any fail** → the result becomes a **DEVIATION**: `success: false`,
  `isError: true`, text:
  `DEVIATION: expected <failed assertion(s)>; actual <observed>. The action did not achieve its effect — adapt (re-find, retry, or a different approach) before continuing.`
  This already flows back as the next turn's tool_result, so the agent re-plans.

Chip-safety: the agent states the *success condition* (e.g.
`element_exists "Amr Dabbas"`, `window_title_contains "Sent"`, or "no error
banner" via absence), never "the field contains the raw typed text" — so the
Part-2 chip-transform false-contradiction cannot occur. (The tool description +
prompt steer the agent toward outcome assertions, not raw-text echoes.)

### 2b. Soft check (always-on, tolerant)
If `expect` was **not** provided and the tool is consequential
(`changesScreen: true`): reuse the loop's existing post-action signal —
`fingerprintChanged` (a11y). (The pixel-digest signal is computed later in §6c
and isn't available at the §5c wiring point, so the soft net is a11y-fingerprint
only. Consequence: a pure-canvas action that moves pixels but not the a11y tree,
called *without* `expect`, may get a spurious soft advisory — non-failing, low
impact; the agent should pass `expect` for canvas/WebView actions anyway.) If
**nothing observably changed**, append a soft, non-failing note:
`⚠ no observable change — verify it took (pass `expect`) or try another approach.`
Never sets `success:false` (a real chip commit *does* move the fingerprint, so
no false warning). This is the safety net for when the agent forgets to state an
expectation.

### 2c. checks → adapts → continues
- **checks** = §2a/§2b (reusing the shipped assertion engine + the loop's
  fingerprint/pixel signal).
- **adapts** = DEVIATION surfaces as the action result; the agent reasons a new
  step next turn — it does not blindly proceed.
- **continues** = on a passing check, normal flow.
- **goal completion** is unchanged: the shipped `done(assertions)` gate is the
  *final* check; Layer C adds *per-step* reactivity. No duplication.

---

## 3. Integration (modular, over the existing loop)

- **Schemas:** add optional `expect` (array; items `{type, ...}` mirroring
  `verify`'s schema) to `invoke_element`, `set_field_value`, `type`, `key` in
  `agent-loop/tools.ts`. Additive — existing callers and the MCP surface are
  unaffected when `expect` is omitted. Schema-snapshot regenerated.
- **Post-action check:** in `runAgent`'s §5c (where `postSnapshot` /
  `fingerprintChanged` are already computed after a `changesScreen` tool),
  invoke a small pure helper `reactiveCheck({ call, result, fingerprintChanged, pixelMoved, adapter })`:
  - reads `call.args.expect`; if present → `parseAssertions` → `checkAssertions`
    → on fail, rewrite `result` to the DEVIATION (success:false) + return;
  - else if the tool is consequential and `!fingerprintChanged && !pixelMoved`
    → append the soft note to `result.text` (success unchanged).
  The helper is pure over its inputs + adapter reads (OS-agnostic, unit-testable);
  the loop wires it in one place. The existing fingerprint/stagnation/runaway
  logic is untouched.
- **OCR for `ocr_contains` assertions:** reuse the agent-loop OCR singleton
  (as `verify`/`compile_ui` do) for the `ocrText` dep.
- **Prompt:** a tight rule in `buildSystemPrompt` — "For consequential actions
  (send/save/submit, filling a key field, committing a chip), pass `expect`
  with the post-condition you require (an outcome you can observe — a window
  title, a rendered chip/element, a status — NOT the raw text you typed). If a
  DEVIATION comes back, the action didn't take — adapt before continuing."

---

## 4. Testing

Loop-level (mocked adapter, the `run-agent.test.ts` harness):
- consequential action + passing `expect` → success, proceeds, result notes verified.
- consequential action + failing `expect` → DEVIATION: `success:false`, deviation
  text present, fed into the next LLM turn's user payload; the action is NOT
  treated as a completed step.
- consequential action, no `expect`, fingerprint unchanged → soft note appended,
  `success` still true.
- consequential action, no `expect`, fingerprint changed → no note.
- malformed `expect` → parse-error result (not a crash), no false success.
- chip-safety: `type` with `expect:[{element_exists:"Amr Dabbas"}]` (outcome, not
  raw text) → passes when the chip element exists.
- additive: actions called without `expect` behave exactly as before (existing
  tests green).

Helper unit tests (pure `reactiveCheck`): hard pass / hard fail→DEVIATION /
soft note path / no-op when tool not consequential.

**Gate:** `tsc` src+tests, full `vitest`, `eslint` 0 errors, schema-snapshot
regenerated + committed.

---

## 5. Files

- **New:** `src/core/sense/reactive-check.ts` (the pure post-action helper) +
  `src/__tests__/reactive-check.test.ts`.
- **Modify:** `src/core/agent-loop/tools.ts` (`expect` param on the four tools),
  `src/core/agent-loop/agent.ts` (§5c wires `reactiveCheck`),
  `src/core/agent-loop/prompt.ts` (the reactive rule), `schema.snapshot.json`
  (regen) + the run-agent tests.
- **Reused:** `parseAssertions`/`checkAssertions` (verify engine), the loop's
  `postSnapshot`/`fingerprintChanged`/pixel-digest, the OCR singleton, the
  `done(assertions)` final gate.

## 6. Scope fence

- ❌ no fixed recipes / declarative flows (a recipe assumes the UI obeys a plan).
- ❌ no separate `pursue(goal)` loop (the reasoner stays `runAgent`).
- ❌ no find-and-act combinators, no `request_approval`/HITL, no vision fusion.
- ❌ no app-specific knowledge; the step sequence stays fully reasoned.
- ❌ no change to by-name / no-`expect` behavior — `expect` is purely additive.
- ❌ no `process.platform` branching.
- ⚠ **KNOWN BOUNDARY (conscious, deferred):** actions run *inside* a `batch`
  bypass §5c, so they do NOT get the reactive `expect`/soft-net check — `batch`
  has its own *pre*-condition `{window,element}` guard, a separate, weaker
  mechanism. This is pre-existing architecture (batch was always opaque to §5c's
  fingerprint/stagnation logic); Layer C inherits rather than introduces it.
  "Every consequential action is self-checking" therefore holds for one-per-turn
  actions, not batched ones. Unifying batched sub-steps with post-condition
  reactive checks (vs batch's pre-condition `expect`) is a deliberate follow-up,
  out of Layer C scope.
