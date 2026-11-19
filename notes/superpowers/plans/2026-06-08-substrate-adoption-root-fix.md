# Substrate Adoption Root-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v1.5.0 UI State Compiler substrate (compile_ui → find_* → el_NN refs → expect) the path of least resistance for the agent, by unifying per-turn perception onto the el_NN UIMap and rewriting the system prompt to teach the substrate as the default — so a cheap model actually uses it instead of legacy smart_click/screenshot habits.

**Architecture:** Diagnosis (4-agent study, 2026-06-08): the substrate is invisible to `buildSystemPrompt()` (0 mentions), the prompt teaches the legacy path as authoritative, and every turn shows TWO perception views (legacy `renderSnapshot` + `COMPILED UI`) with two action vocabularies — the model takes the prompt-endorsed legacy one. Root fix: (1) unify per-turn perception onto the el_NN UIMap (the sole view; also retires the dual-render token cost), (2) rewrite the prompt so el_NN refs + finders are the default and the cost ladder leads with the compiled path, (3) fix the confirm-tier dead-end so el_NN ref clicks carry a label to the safety gate, (4) consolidate the duplicate chip rule into a worked example, (5) add a narrow browser-pivot guardrail + soften the stagnation nudge.

**Tech Stack:** TypeScript, vitest, the shipped UIMap/holder/finders/reactive engine. All changes OS-agnostic (no `process.platform`).

**Diagnosis source:** the 4 study reports (this session). **Branch:** `v1.5.0`.

**Scope fence:** NO new tools, NO recipes/pipeline, NO removing the legacy `renderSnapshot` export (tests + turn-1 fallback may use it), NO weakening the safety gate (only surface a label earlier), NO `process.platform`. Per-turn perception compile stays a11y-only `cheap` (finders self-escalate to `ocr_ok` on demand — see Task 4 prompt) — do NOT add per-turn OCR (cost/complexity, YAGNI).

---

## Reused shapes (read first)
```ts
// ui-map-render.ts: renderUIMap(map, {max?}) — ranked (actionable first, then confidence), DEFAULT_MAX=50,
//   line(): `${id} [${role}] "${text}" (${conf} ${sources}) @x,y WxH {flags}`. state.value NOT shown yet.
//   state.value is ALREADY redacted at build (ui-map-elements.ts:19 → value undefined when secure) — safe to show.
// agent.ts:197 firstSnapshot; :201 renderSnapshot (turn-1); :227 initial block "ACCESSIBILITY SNAPSHOT".
// agent.ts:415-417 targetLabel (name||target); :424 safetyEvaluate; :431-451 !isAllowed branch.
// agent.ts:706-720 §6b captures snap + renderSnapshot "FRESH ACCESSIBILITY SNAPSHOT" + RECENT ACTIONS;
//   :737-750 the COMPILED UI block (renderUIMap); :890-908 storeUIMap (compiles cheap, returns {render,anchors,id}).
// agent.ts:850 firm stagnation nudge ("switch to a FUNDAMENTALLY different method").
// ui-map-resolve.ts:26 resolveRef(ref{element_id?,snapshot_id?}, holder, now, intent, activeWindow): RefPlan
//   RefPlan ok variants: {ok:true, via:'name', name, element} | {ok:true, via:'bounds', bounds, element}.
// prompt.ts:32 buildSystemPrompt(); header :37-40; rule 2 cost-ladder :59-68; rule 4a :76-82;
//   DUPLICATE "5b": chip :87-91 and protocol :125; rule 5d reactive :168-177.
```

---

## Task 1: `renderUIMap` parity — show field value + raise the per-turn cap

The unified per-turn view must match `renderSnapshot`'s usefulness. Two gaps: it doesn't show a field's current value (needed to see what's typed in To/Subject), and its cap (50) is below `renderSnapshot`'s (120).

**Files:**
- Modify: `src/core/sense/ui-map-render.ts`
- Test: `src/__tests__/ui-map-render.test.ts` (create or append)

- [ ] **Step 1: Write the failing test** — `src/__tests__/ui-map-render.test.ts` (append if it exists):
```ts
import { describe, it, expect } from 'vitest';
import { renderUIMap } from '../core/sense/ui-map-render';
import type { UIMap, UIElement } from '../core/sense/ui-map-types';

const el = (over: Partial<UIElement> & Pick<UIElement, 'id'>): UIElement => ({
  role: 'input', text: 'To', bounds: [10, 20, 100, 24], confidence: 0.85, sources: ['a11y'],
  actionable: true, editable: true, ...over });
const mapWith = (elements: UIElement[]): UIMap => ({
  snapshot_id: 'obs_1', platform: 'win32', active_app: 'olk', window_title: 'Mail',
  sources_used: ['a11y'], elements, anchors: [] } as unknown as UIMap);

describe('renderUIMap — value + cap', () => {
  it('shows the current field value when present', () => {
    const out = renderUIMap(mapWith([el({ id: 'el_0', state: { value: 'amr@x.com' } })]));
    expect(out).toContain('= "amr@x.com"');
  });
  it('omits the value clause when there is no value', () => {
    const out = renderUIMap(mapWith([el({ id: 'el_0' })]));
    expect(out).not.toContain('= "');
  });
  it('renders up to 120 elements (raised cap)', () => {
    const many = Array.from({ length: 130 }, (_, i) => el({ id: `el_${i}`, confidence: 0.5 }));
    const out = renderUIMap(mapWith(many));
    expect(out).toContain('120 of 130 shown');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/ui-map-render.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `src/core/sense/ui-map-render.ts`:
  - Change `const DEFAULT_MAX = 50;` → `const DEFAULT_MAX = 120;`
  - In `line(e)`, after the `conf`/`flagStr` computation, add a value clause (value is already secure-redacted at build, so it is safe to show):
```ts
  const val = e.state?.value ? ` = "${e.state.value.length > 60 ? e.state.value.slice(0, 59) + '…' : e.state.value}"` : '';
  return `${e.id} [${e.role}] "${e.text ?? e.normalized_text ?? ''}"${val} (${conf} ${e.sources.join(',')}) @${x},${y} ${w}x${h}${flagStr}`;
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/ui-map-render.test.ts` → PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/sense/ui-map-render.ts src/__tests__/ui-map-render.test.ts
git commit -m "feat(ui-map): renderUIMap shows field value + raises cap to 120 (perception parity)"
```

---

## Task 2: Unify per-turn perception onto the el_NN UIMap

Replace the legacy `renderSnapshot` view with the compiled UIMap (el_NN) as the SOLE per-turn perception, on turn 1 and every subsequent turn. The model now sees one view with one action vocabulary.

**Files:**
- Modify: `src/core/agent-loop/agent.ts`
- Test: `src/__tests__/run-agent.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/run-agent.test.ts`:
```ts
describe('runAgent — unified el_NN perception', () => {
  beforeEach(() => { llmTurnQueue.length = 0; capturedLlmCalls.length = 0; });

  function firstUserText() {
    const u = capturedLlmCalls[0].messages.find((m: any) => m.role === 'user');
    return (u.content as any[]).map((b: any) => (typeof b === 'string' ? b : b.text ?? '')).join('\n');
  }
  function turnUserText(i: number) {
    const u = [...capturedLlmCalls[i].messages].reverse().find((m: any) => m.role === 'user');
    return (u.content as any[]).map((b: any) => (typeof b === 'string' ? b : b.text ?? '')).join('\n');
  }

  it('turn 1 perception is the compiled UI map (el_NN), not the legacy snapshot', async () => {
    llmTurnQueue.push(turnCall('done', { evidence: 'nothing to do' }));
    await runAgent({ task: 't', maxTurns: 3 }, { adapter: makeAdapter(), llm: LLM_CONFIG });
    expect(firstUserText()).toContain('COMPILED UI');
    expect(firstUserText()).not.toContain('ACCESSIBILITY SNAPSHOT');
  });

  it('subsequent turns show the UI map and NOT the legacy "FRESH ACCESSIBILITY SNAPSHOT"', async () => {
    llmTurnQueue.push(turnCall('key', { key: 'a' }));
    llmTurnQueue.push(turnCall('done', { evidence: 'ok' }));
    await runAgent({ task: 't', maxTurns: 4 }, { adapter: makeAdapter(), llm: LLM_CONFIG });
    expect(turnUserText(1)).toContain('COMPILED UI');
    expect(turnUserText(1)).not.toContain('FRESH ACCESSIBILITY SNAPSHOT');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/run-agent.test.ts` → the 2 new tests FAIL.

- [ ] **Step 3a: Turn-1 perception** — in `src/core/agent-loop/agent.ts`, replace the turn-1 `renderSnapshot` (lines ~201-205) and the initial block text (~227). After `fph.push(firstSnapshot.fingerprint);`, compile+store the UIMap and use it instead of `snapshotText`:
```ts
    // Turn-1 perception = the compiled UI map (el_NN), so the agent acts on the
    // same vocabulary from its very first decision. storeUIMap stores it in the
    // holder, so turn-1 el_NN refs resolve.
    let firstUiRender: string;
    try {
      const ui0 = await storeUIMap(holder, firstSnapshot, deps.adapter, prevAnchors);
      prevAnchors = ui0.anchors;
      firstUiRender = ui0.render;
    } catch {
      // Fallback to the legacy snapshot render if compilation fails.
      firstUiRender = renderSnapshot(firstSnapshot, { screenWidth: screen.physicalWidth, screenHeight: screen.physicalHeight, focusProcessId: firstSnapshot.activeWindow?.processId });
    }
```
  (Delete the old `const snapshotText = renderSnapshot(...)` block at ~201-205.) Then change the initial block text (~227) from `...ACCESSIBILITY SNAPSHOT:\n${wrapUntrustedScreenContent(snapshotText)}\n\nPICK ONE TOOL CALL.` to:
```ts
        text: `${windowAnchor}TASK: ${input.task}${dpiNote}\n\nCOMPILED UI (act on an element via invoke_element/set_field_value with {element_id, snapshot_id}):\n${wrapUntrustedScreenContent(firstUiRender)}\n\nPICK ONE TOOL CALL.`,
```
  NOTE: `prevAnchors` must be declared (a `let prevAnchors: UIMap['anchors'] | undefined`) in a scope that covers both turn-1 and §6b. If it is currently declared only inside/after the loop, hoist its declaration above the turn-1 block. Verify and adjust.

- [ ] **Step 3b: §6b per-turn perception** — remove the legacy `FRESH ACCESSIBILITY SNAPSHOT` push (lines ~708-716, the `const snapText = renderSnapshot(...)` and its `nextBlocks.push({... FRESH ACCESSIBILITY SNAPSHOT ...})`). KEEP the `const snap = await captureSnapshot(...)` + `activeApp = ...` (storeUIMap needs `snap`), KEEP the `RECENT ACTIONS` push, and KEEP the existing `COMPILED UI` block (lines ~737-750) — it becomes the sole perception. The `COMPILED UI` block already renders `renderUIMap`; leave its logic intact.

- [ ] **Step 4: Run** `npx vitest run src/__tests__/run-agent.test.ts` → PASS (2 new + all existing). If an existing test asserted the presence of "ACCESSIBILITY SNAPSHOT"/"FRESH ACCESSIBILITY SNAPSHOT" text, update it to assert "COMPILED UI" (the perception block was renamed/unified) — report any such change.
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean (note: `renderSnapshot` is still imported for the turn-1 fallback, so the import stays).
- [ ] **Step 6: Commit**
```bash
git add src/core/agent-loop/agent.ts src/__tests__/run-agent.test.ts
git commit -m "feat(agent): unify per-turn perception onto the el_NN UI map (drop dual render)"
```

---

## Task 3: Confirm-tier — el_NN ref clicks carry a label to the safety gate + actionable headless rejection

el_NN ref clicks (`invoke_element({element_id, snapshot_id})`) reach the safety gate with NO `targetLabel`, tripping the blunt "sensitive app + no target label → confirm" dead-end. Resolve the ref to its element name BEFORE the gate (so the correct label-pattern rule + intent-match bypass apply — no safety weakening), and make a `confirm` rejection actionable instead of a dead reject.

**Files:**
- Modify: `src/core/agent-loop/agent.ts`
- Test: `src/__tests__/run-agent.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/run-agent.test.ts`:
```ts
import { resolveRef } from '../core/sense/ui-map-resolve'; // (top of file if not present)

describe('runAgent — confirm-tier is actionable + ref clicks carry a label', () => {
  beforeEach(() => { llmTurnQueue.length = 0; capturedLlmCalls.length = 0; });

  it('a confirm rejection tells the model how to proceed (headless, no dead-end)', async () => {
    // raw coordinate click in a sensitive app → confirm; the message must be actionable
    const adapter = makeAdapter({ activeProcessName: 'olk' }); // see makeAdapter opts; sets active app to olk
    llmTurnQueue.push(turnCall('click', { x: 100, y: 200 }));
    llmTurnQueue.push(turnCall('done', { evidence: 'adapted' }));
    const result = await runAgent({ task: 'send an email', maxTurns: 4 }, { adapter, llm: LLM_CONFIG });
    const blocked = result.steps.find(s => /safety_confirm/.test(s.result.text));
    expect(blocked).toBeTruthy();
    // the tool_result fed back must be actionable, not a bare "[confirm] requires confirm"
    const u = [...capturedLlmCalls[1].messages].reverse().find((m: any) => m.role === 'user');
    const txt = (u.content as any[]).map((b: any) => (typeof b === 'string' ? b : b.text ?? '')).join('\n');
    expect(txt.toLowerCase()).toMatch(/name the target|find_action_button|invoke_element\(name/);
  });
});
```
  NOTE: `makeAdapter` may not support an `activeProcessName` option. If it doesn't, extend the test harness's `makeAdapter` to let `getActiveWindow`/`listWindows` report a configurable `processName` (default unchanged), so the sensitive-app branch can be exercised. Keep the default behavior identical for existing tests.

- [ ] **Step 2: Run** `npx vitest run src/__tests__/run-agent.test.ts` → new test FAILS.

- [ ] **Step 3a: Pre-resolve the ref label** — in `src/core/agent-loop/agent.ts`, add the import:
```ts
import { resolveRef } from '../sense/ui-map-resolve';
```
  Then replace the `targetLabel` computation (lines ~415-417) with one that also resolves an el_NN ref to its element name BEFORE the safety gate:
```ts
        let targetLabel = typeof call.args.name === 'string' ? call.args.name
          : typeof call.args.target === 'string' ? call.args.target
          : undefined;
        // el_NN ref clicks carry no name/target — resolve the ref to its element
        // name so the safety gate sees a real label (correct label-pattern rule +
        // intent-match bypass) instead of the blunt "no target label" confirm.
        // No safety weakening: the same gate runs, just with more information.
        if (!targetLabel && call.name === 'invoke_element' && typeof call.args.element_id === 'string') {
          const plan = resolveRef(
            { element_id: call.args.element_id, snapshot_id: typeof call.args.snapshot_id === 'string' ? call.args.snapshot_id : undefined },
            holder, Date.now(), 'click', null,
          );
          if (plan.ok && plan.via === 'name') targetLabel = plan.name;
          else if (plan.ok && plan.via === 'bounds') targetLabel = plan.element.text ?? plan.element.normalized_text ?? undefined;
        }
```

- [ ] **Step 3b: Actionable confirm rejection** — in the `!isAllowed(decision)` branch (lines ~431-451), make a `confirm` decision return an actionable message instead of the bare `requires confirm: <tier>`:
```ts
        if (!isAllowed(decision)) {
          const reason = decision.decision === 'block'
            ? decision.reason
            : decision.decision === 'confirm'
              ? `${decision.reason} — headless run: there is no human to confirm. DO NOT retry the same click. Instead name the target: find_action_button(intent:"...") then invoke_element({element_id, snapshot_id}), or invoke_element(name:"<label>"). If the user's task explicitly asked for this action, restate that intent.`
              : `requires ${decision.decision}: ${decision.tier}`;
          log.info('agent.tool.blocked', { turn, tool: call.name, decision: decision.decision, reason });
          toolResults.push({ id: call.id, text: `[${decision.decision}] ${reason}`, isError: true });
          steps.push({ turn, toolName: call.name, toolArgs: call.args, result: { success: false, text: `safety_${decision.decision}: ${decision.reason ?? decision.tier}` }, durationMs: Date.now() - turnStart, fingerprintChanged: false, thought: llmResult.text });
          continue;
        }
```
  (Keep the `steps.push` `result.text` matching the existing `safety_<decision>` convention so existing assertions/telemetry still match.)

- [ ] **Step 4: Run** `npx vitest run src/__tests__/run-agent.test.ts src/__tests__/safety.test.ts` → PASS (new + existing).
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/agent-loop/agent.ts src/__tests__/run-agent.test.ts
git commit -m "fix(agent): el_NN ref clicks carry a label to the safety gate + actionable confirm rejection"
```

---

## Task 4: Prompt rewrite A — teach the substrate as the default

Make the system prompt describe the el_NN UI map (not the a11y snapshot), lead the cost ladder with the compiled path, and add a FORM/FIELD workflow rule naming `compile_ui`/`find_*`/el_NN refs/`expect`.

**Files:**
- Modify: `src/core/agent-loop/prompt.ts`
- Test: `src/__tests__/prompt.test.ts` (create or append)

- [ ] **Step 1: Write the failing test** — `src/__tests__/prompt.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../core/agent-loop/prompt';

describe('buildSystemPrompt — substrate is the default', () => {
  const p = buildSystemPrompt();
  it('names the substrate tools', () => {
    for (const t of ['compile_ui', 'find_input_field', 'find_action_button', 'element_id', 'snapshot_id']) {
      expect(p).toContain(t);
    }
  });
  it('has a FORM/FIELD workflow rule', () => {
    expect(p).toMatch(/FORM|FIELD/);
    expect(p).toMatch(/find_input_field.*set_field_value|set_field_value.*element_id/s);
  });
  it('describes the UI map (el_NN), not only the legacy a11y snapshot, in the header', () => {
    expect(p).toMatch(/UI map|el_NN|element id/i);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/prompt.test.ts` → FAIL.

- [ ] **Step 3a: Header** — in `buildSystemPrompt`, change the `visionLine` and the "You ALWAYS see" block (lines ~33-40) to describe the UI map:
```ts
  const visionLine = 'You prefer the attached UI map (accessibility, already compiled) over screenshots. Call screenshot() ONLY if the map is empty, if the app uses a custom canvas, or after an action that needs a visual check.';
```
  and the bullet (line ~38):
```
  • The active window title + a ranked COMPILED UI map of its contents. Each
    element has an id (el_NN), a role, a name, coordinates, and flags
    (clickable/editable/focused). ACT on an element by its id with
    invoke_element/set_field_value({element_id, snapshot_id}).
```

- [ ] **Step 3b: Cost ladder (rule 2)** — replace the ladder body (lines ~59-68) with one that leads with the compiled path:
```
2. CHEAPEST RELIABLE TOOL. The COMPILED UI map is already attached every turn —
   act on it FIRST. Climb only when the rung below cannot answer:
     act on a named/el_NN element (invoke_element/set_field_value by
       {element_id, snapshot_id} or by name — near-free, survives DPI/resize) <
     find a target semantically (find_input_field / find_action_button —
       cheap, returns the el_NN to act on; reuses the compiled map) <
     compile_ui (re-fuse the screen when the attached map looks stale/sparse) <
     read_text / OCR (when a11y is sparse and a finder returned "none") <
     smart_click (OCR-click a visible label — FALLBACK when no a11y/el_NN target) <
     screenshot (an image — most expensive; last resort).
   Prefer el_NN refs and finders over coordinate clicks and OCR: they are
   cheaper and survive layout shifts.
```

- [ ] **Step 3c: FORM/FIELD workflow rule** — insert a new rule right after rule 2 (before rule 3):
```
2a. FORM AND FIELD TASKS (compose an email, fill a web form, any input UI).
    Use the compiled UI map — do NOT guess names or jump to OCR/screenshots:
      1. Find the field:  find_input_field(purpose:"recipient"|"subject"|"body"|
         "search"|…) → on status "ok", fill it by ref:
         set_field_value({element_id: best.element_id, snapshot_id, value})
      2. Find a button:   find_action_button(intent:"send"|"submit"|"compose"|…)
         → on status "ok", act: invoke_element({element_id: best.element_id, snapshot_id})
      3. On status "none" (sparse a11y / canvas): THEN fall back —
         invoke_element(name:"<name from the map>") or smart_click("<visible text>").
    NEVER skip the finder step for a form — it is cheaper than OCR and more
    reliable than guessing. "none" is information: the a11y tree is sparse, so
    use OCR/smart_click for that target.
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/prompt.test.ts src/__tests__/run-agent.test.ts` → PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/agent-loop/prompt.ts src/__tests__/prompt.test.ts
git commit -m "feat(prompt): teach the el_NN substrate as default (header, cost ladder, form/field rule)"
```

---

## Task 5: Prompt rewrite B — chip worked-example, fix duplicate `5b`, narrow browser-pivot rule, soften stagnation nudge

**Files:**
- Modify: `src/core/agent-loop/prompt.ts`, `src/core/agent-loop/agent.ts` (the stagnation nudge text)
- Test: `src/__tests__/prompt.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/prompt.test.ts`:
```ts
describe('buildSystemPrompt — chip flow, numbering, browser pivot', () => {
  const p = buildSystemPrompt();
  it('has no duplicate rule "5b" label', () => {
    const count = (p.match(/^\s*5b\./gm) || []).length;
    expect(count).toBeLessThanOrEqual(1);
  });
  it('chip rule gives the finder+expect worked example', () => {
    expect(p).toMatch(/tokeniz|chip/i);
    expect(p).toMatch(/key\(.*Return.*expect|expect.*element_exists/s);
  });
  it('forbids re-hosting a native app in the browser', () => {
    expect(p).toMatch(/web version|browser version|re-?host/i);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/prompt.test.ts` → new tests FAIL.

- [ ] **Step 3a: Renumber + consolidate the duplicate `5b`.** The prompt currently has TWO `5b.` rules (chip at ~87, protocol at ~125) and out-of-order `5a`/`5b`. Renumber the cluster to be monotonic and unique: `5.` STAGNATION, `5a.` SPARSE/EMPTY A11Y TREE, `5b.` FORM FIELDS THAT TOKENIZE INPUT (chip — rewritten per 3b), `5c.` PROTOCOL ESCAPE HATCHES (currently the second "5b" at ~125), `5d.` WEB-SERVICE POLICY (currently `5c`), `5e.` REACTIVE ACTIONS (currently `5d`). Update each label in place; keep each rule's body except the chip rule (3b) and stagnation cross-ref. (Order in the file becomes 5, 5a, 5b, 5c, 5d, 5e.)

- [ ] **Step 3b: Rewrite the chip rule (now `5b`)** with the finder+expect worked example, replacing the legacy `read_text`-verify body:
```
5b. FORM FIELDS THAT TOKENIZE INPUT (email To/Cc, tag pickers, chip inputs).
    Raw typing is NOT enough — the app discards uncommitted text at send time
    ("no recipient"). Required sequence (uses the substrate + a reactive check):
      1. find_input_field("recipient") → {element_id, snapshot_id}
      2. set_field_value({element_id, snapshot_id, value:"addr@example.com"})
      3. key({combo:"Return", expect:[{type:"element_exists", name:"addr@example.com"}]})
         — Return COMMITS the chip; expect verifies it rendered. The address may
         resolve to a display name, so an ocr_contains of the name also works.
    If step 3 returns a DEVIATION, the chip did NOT commit — re-find the field and
    retry (click it, type, Return) before moving on. NEVER Tab to the next field
    until the chip is verified.
```

- [ ] **Step 3c: Narrow browser-pivot rule** — append to rule `4a` (STAY IN YOUR WORKING WINDOW, ~line 82):
```
   Do NOT switch to the WEB version of an app you are already running natively
   (e.g. if a mail/office/chat DESKTOP app is your working window, do not open its
   *.office.com / web login as an escape — it forces a fresh sign-in and loses your
   in-progress state; that is a dead end, not an alternative). Re-hosting the same
   product in a browser is not a valid pivot. A different APPROACH within the same
   app (keyboard-only flow, a URI scheme, focus_window) is fine; a different
   PRODUCT the user named is fine.
```

- [ ] **Step 3d: Soften the stagnation nudge** — in `src/core/agent-loop/agent.ts` (~line 850), the firm nudge text says "Switch to a FUNDAMENTALLY different method now". Replace "a FUNDAMENTALLY different method" framing so it steers WITHIN the app, not to another surface. Change the firm-branch string to:
```ts
            ? `\n⚠ STAGNATION (${consecutiveStagnantTurns} turns, no accessibility change). The screen may still be advancing — this app likely has a sparse a11y tree (new Outlook, web/canvas UIs). STOP repeating the last action. Switch APPROACH WITHIN this app: prefer a keyboard-only flow (open a fresh compose, the recipient field is focused — type, Return to commit the chip, Tab to the next field), or find_input_field/find_action_button to get an el_NN target, or call focus_window to confirm the right window is active, or give_up with a concrete reason. Do NOT open the web version of this app or switch to another app.`
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/prompt.test.ts src/__tests__/run-agent.test.ts` → PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/agent-loop/prompt.ts src/core/agent-loop/agent.ts src/__tests__/prompt.test.ts
git commit -m "feat(prompt): chip worked-example, fix duplicate 5b numbering, narrow browser-pivot rule, soften stagnation nudge"
```

---

## Final gate + review

- [ ] **Full gate:**
```
npx tsc --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npx vitest run
npx eslint src
```
Both tsc clean; full suite passes (was 853 pass/1 skip + the new tests); eslint 0 errors (pre-existing warnings OK). If a pre-existing untouched test fails, report it.
- [ ] **Whole-feature review** (opus): does the unified perception + prompt coherently make the substrate the default path? Any place the prompt still references the old a11y-snapshot view inconsistently with the unified UI map? Confirm no safety weakening in Task 3 and no `process.platform` anywhere.

---

## Self-review (completed)

**Diagnosis coverage:** prompt invisibility → T4/T5 (substrate named, cost ladder, FORM rule, chip example). Dual-perception fork → T2 (unify onto el_NN; also retires dual-render token cost). renderUIMap parity for the swap → T1 (value + cap). Confirm-tier dead-end → T3 (ref label pre-resolve + actionable rejection, no safety weakening). Duplicate 5b / numbering → T5. Browser pivot + stagnation nudge → T5. (Per-turn `ocr_ok` escalation deliberately OUT — finders self-escalate; documented in the scope fence.)

**Placeholder scan:** none — full code/text in every step. The two NOTEs (prevAnchors scope in T2; makeAdapter active-app option in T3) are real verify-and-adjust instructions with the concrete change stated.

**Type consistency:** `renderUIMap`/`DEFAULT_MAX`, `storeUIMap` return `{render,anchors,id}`, `resolveRef` RefPlan `via:'name'|'bounds'`, `targetLabel`, the `safety_<decision>` step convention — consistent across tasks. OS-agnostic: pure prompt/perception/loop edits, no `process.platform`.

**Risk note:** T2 changes every turn's perception (highest risk). Mitigations: T1 brings renderUIMap to parity first; turn-1 keeps a `renderSnapshot` fallback on compile failure; the full run-agent suite is the regression guard; the final live re-run (the Outlook task) is the real validation.
