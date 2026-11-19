# UI State Compiler — Layer C Implementation Plan (reactive step discipline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each consequential agent action self-checking — act, verify the agent-stated expected effect (or a tolerant "did anything change" net), and on deviation feed back a signal that forces the agent to adapt instead of blindly continuing.

**Architecture:** A pure post-action helper `reactiveCheck` (reuses the shipped assertion engine) is wired into `runAgent`'s existing §5c post-tool path. The four consequential tools (`invoke_element`, `set_field_value`, `type`, `key`) gain an optional `expect` (assertions) param. Hard check on `expect` → DEVIATION (`success:false`); tolerant soft "no observable change" note (reuses `fingerprintChanged`) when `expect` is omitted. No recipes, no second loop. `done(assertions)` remains the final goal gate.

**Tech Stack:** TypeScript, vitest, the shipped `parseAssertions`/`checkAssertions`/`renderReport` (verify engine), the loop's existing `postSnapshot`/`fingerprintChanged`.

**Spec:** `notes/superpowers/specs/2026-06-07-ui-state-compiler-layer-c-design.md`. **Branch:** `v1.5.0`.

**Scope fence:** NO fixed recipes/flows, NO separate pursue loop, NO find-and-act combinators, NO request_approval/HITL, NO vision fusion, NO change to by-name/no-`expect` behavior (additive), NO `process.platform` branching.

---

## Reused shapes (read first)
```ts
// src/core/verify/assertions.ts
parseAssertions(raw): { assertions: Assertion[] } | { error: string }
checkAssertions(assertions, { adapter, ocrText? }): Promise<{ ok: boolean; passed: number; failed: number; outcomes: {...}[] }>
renderReport(report): string   // ✓/✗ lines
// assertion types: window_title_contains{value}, app_running{name}, element_exists{name},
//   element_value_contains{name,value}, clipboard_contains{value}, file_exists{path},
//   file_contains{path,value}, ocr_contains{value}
// src/core/agent-loop/agent.ts §5c: after `tool.execute`, computes
//   `let postSnapshot`, `const fingerprintChanged = ...`, `fph.push(...)`, then `steps.push` (result.success/text)
//   + `toolResults.push({ text: result.text, isError: !result.success, ... })`. `result` is a mutable `let`.
// the 4 tools in src/core/agent-loop/tools.ts: invoke_element(~169), set_field_value(~271), type(~652), key(~687) — all changesScreen:true
// OCR singleton pattern: see getAgentOcr() in tools.ts / _ocr in ui-map.ts
```

---

## Task 1: Pure `reactiveCheck` helper

**Files:**
- Create: `src/core/sense/reactive-check.ts`
- Test: `src/__tests__/reactive-check.test.ts`

- [ ] **Step 1: Write the failing test** `src/__tests__/reactive-check.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { reactiveCheck } from '../core/sense/reactive-check';
import type { PlatformAdapter } from '../platform/types';

// Minimal adapter: app_running('notepad') passes via listWindows; element_value_contains via invokeElement.
function adapter(over: Partial<Record<string, unknown>> = {}): PlatformAdapter {
  return {
    listWindows: vi.fn(async () => [{ processId: 9, processName: 'notepad', title: 'Untitled - Notepad', bounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false }]),
    findElements: vi.fn(async () => []),
    invokeElement: vi.fn(async () => ({ success: true, data: { value: 'amr@x.com' } })),
    readClipboard: vi.fn(async () => ''),
    ...over,
  } as unknown as PlatformAdapter;
}

const base = { toolText: 'Pressed a', toolSuccess: true, changesScreen: true, observedChange: false };

describe('reactiveCheck', () => {
  it('passing expect → success preserved, "verified" note', async () => {
    const r = await reactiveCheck({ ...base, expect: [{ type: 'app_running', name: 'notepad' }], adapter: adapter() });
    expect(r).not.toBeNull();
    expect(r!.success).toBe(true);
    expect(r!.text).toMatch(/verified/i);
  });

  it('failing expect → DEVIATION, success:false', async () => {
    const r = await reactiveCheck({ ...base, expect: [{ type: 'app_running', name: 'photoshop' }], adapter: adapter() });
    expect(r!.success).toBe(false);
    expect(r!.text).toContain('DEVIATION');
    expect(r!.text).toContain('adapt');
  });

  it('malformed expect → rejected (not a crash), success:false', async () => {
    const r = await reactiveCheck({ ...base, expect: [{ type: 'not_a_real_type' }], adapter: adapter() });
    expect(r!.success).toBe(false);
    expect(r!.text.toLowerCase()).toContain('expect rejected');
  });

  it('no expect + consequential + no observable change → soft note, success stays true', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, observedChange: false, adapter: adapter() });
    expect(r!.success).toBe(true);
    expect(r!.text).toContain('no observable change');
  });

  it('no expect + observable change → null (no modification)', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, observedChange: true, adapter: adapter() });
    expect(r).toBeNull();
  });

  it('no expect + NOT consequential → null', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, changesScreen: false, observedChange: false, adapter: adapter() });
    expect(r).toBeNull();
  });

  it('does not add a soft note to an already-failed action', async () => {
    const r = await reactiveCheck({ ...base, expect: undefined, toolSuccess: false, observedChange: false, adapter: adapter() });
    expect(r).toBeNull();
  });

  it('chip-safe: an outcome assertion (element_exists) passes regardless of typed text', async () => {
    const a = adapter({ findElements: vi.fn(async () => [{ name: 'Amr Dabbas', controlType: 'Text', bounds: { x: 1, y: 1, width: 10, height: 10 } }]) });
    const r = await reactiveCheck({ ...base, toolText: 'Typed amr@x.com', expect: [{ type: 'element_exists', name: 'Amr Dabbas' }], adapter: a });
    expect(r!.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/reactive-check.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/core/sense/reactive-check.ts`:

```ts
/**
 * Layer C — reactive step discipline. After a consequential action, verify the
 * agent-stated expected effect (hard) or a tolerant "did anything change" net
 * (soft), so the agent never blindly proceeds on an action that didn't take.
 * Pure over its inputs + PlatformAdapter reads (OS-agnostic, unit-testable).
 * See notes/superpowers/specs/2026-06-07-ui-state-compiler-layer-c-design.md.
 */
import type { PlatformAdapter } from '../../platform/types';
import { parseAssertions, checkAssertions, renderReport } from '../verify/assertions';

export interface ReactiveInput {
  /** Raw `expect` arg from the tool call (assertions array), or undefined. */
  expect: unknown;
  /** The tool's own result text + success, to fold the note into. */
  toolText: string;
  toolSuccess: boolean;
  /** Whether the tool is screen-changing (consequential). */
  changesScreen: boolean;
  /** Whether the loop observed a change after the action (fingerprint/pixel). */
  observedChange: boolean;
  adapter: PlatformAdapter;
  /** Lazy OCR reader for ocr_contains assertions; omit when unavailable. */
  ocrText?: () => Promise<string>;
}

/** A modified result (success/text) to replace the tool's, or null = leave as-is. */
export interface ReactiveOutcome { success: boolean; text: string; }

export async function reactiveCheck(input: ReactiveInput): Promise<ReactiveOutcome | null> {
  const hasExpect = input.expect !== undefined && input.expect !== null;

  if (hasExpect) {
    const parsed = parseAssertions(input.expect);
    if ('error' in parsed) {
      return { success: false, text: `${input.toolText}\nexpect rejected: ${parsed.error}` };
    }
    const report = await checkAssertions(parsed.assertions, { adapter: input.adapter, ocrText: input.ocrText });
    if (report.ok) {
      return { success: input.toolSuccess, text: `${input.toolText} — verified ${report.passed} check(s)` };
    }
    return {
      success: false,
      text: `${input.toolText}\nDEVIATION: ${report.failed}/${report.outcomes.length} expected check(s) failed — the action did not achieve its effect. Adapt (re-find, retry, or a different approach) before continuing:\n${renderReport(report)}`,
    };
  }

  // No expect: tolerant soft net — only for a SUCCESSFUL consequential action
  // that produced no observable change. Never fails the action.
  if (input.changesScreen && input.toolSuccess && !input.observedChange) {
    return { success: true, text: `${input.toolText}\n⚠ no observable change — verify it took (pass \`expect\`) or try another approach.` };
  }

  return null;
}
```

- [ ] **Step 4: Run** `npx vitest run src/__tests__/reactive-check.test.ts` → PASS (8 tests).
- [ ] **Step 5: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit**
```bash
git add src/core/sense/reactive-check.ts src/__tests__/reactive-check.test.ts
git commit -m "feat(ui-map): pure reactiveCheck helper (hard expect / soft no-change)"
```

---

## Task 2: `expect` param on the four tools + wire reactiveCheck into the loop

**Files:**
- Modify: `src/core/agent-loop/tools.ts` (add `expect` to 4 tool schemas)
- Modify: `src/core/agent-loop/agent.ts` (§5c wiring + OCR dep)
- Test: `src/__tests__/run-agent.test.ts` (append)
- Regen: `schema.snapshot.json`

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/run-agent.test.ts`:

```ts
describe('runAgent — Layer C reactive step discipline', () => {
  beforeEach(() => { llmTurnQueue.length = 0; capturedLlmCalls.length = 0; });

  it('a failing expect on an action yields a DEVIATION (success:false) fed back to the agent', async () => {
    llmTurnQueue.push(turnCall('key', { key: 'a', expect: [{ type: 'app_running', name: 'photoshop' }] })); // not running
    llmTurnQueue.push(turnCall('done', { evidence: 'adapted after the deviation occurred' }));
    const result = await runAgent({ task: 'react', maxTurns: 6 }, { adapter: makeAdapter(), llm: LLM_CONFIG });
    const step = result.steps[0];
    expect(step.result.success).toBe(false);
    expect(step.result.text).toContain('DEVIATION');
    // the deviation reaches the next LLM turn as a tool_result
    const user2 = [...capturedLlmCalls[1].messages].reverse().find((m: any) => m.role === 'user');
    const txt = (user2.content as any[]).map(b => (typeof b === 'string' ? b : b.text ?? (b.content?.map?.((c: any) => c.text).join(' ') ?? ''))).join('\n');
    expect(txt).toContain('DEVIATION');
  });

  it('a passing expect proceeds with a verified note', async () => {
    llmTurnQueue.push(turnCall('key', { key: 'a', expect: [{ type: 'app_running', name: 'notepad' }] }));
    llmTurnQueue.push(turnCall('done', { evidence: 'verified and continued' }));
    const result = await runAgent({ task: 'react', maxTurns: 6 }, { adapter: makeAdapter(), llm: LLM_CONFIG });
    expect(result.steps[0].result.success).toBe(true);
    expect(result.steps[0].result.text).toMatch(/verified/i);
  });

  it('a consequential action with no expect and no observable change gets a soft note', async () => {
    llmTurnQueue.push(turnCall('key', { key: 'a' }));   // makeAdapter getUiTree [] → fingerprint stable → no change
    llmTurnQueue.push(turnCall('done', { evidence: 'continued after the soft note' }));
    const result = await runAgent({ task: 'react', maxTurns: 6 }, { adapter: makeAdapter(), llm: LLM_CONFIG });
    expect(result.steps[0].result.text).toContain('no observable change');
    expect(result.steps[0].result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/__tests__/run-agent.test.ts` → the 3 new tests FAIL.

- [ ] **Step 3: Add `expect` to the four tool schemas** in `src/core/agent-loop/tools.ts`. For EACH of `invoke_element`, `set_field_value`, `type`, `key`, add to its `inputSchema.properties`:

```ts
          expect: {
            type: 'array',
            description: 'Optional post-conditions to verify after this action (same assertion types as the verify tool: window_title_contains, app_running, element_exists, element_value_contains, clipboard_contains, file_exists, file_contains, ocr_contains). If any FAIL the action returns a DEVIATION and you must adapt. State an OUTCOME you can observe (a window title, a rendered element/chip, a status) — NOT the raw text you typed.',
            items: {
              type: 'object',
              properties: { type: { type: 'string', enum: ['window_title_contains', 'app_running', 'element_exists', 'element_value_contains', 'clipboard_contains', 'file_exists', 'file_contains', 'ocr_contains'] } },
              required: ['type'],
            },
          },
```

Do NOT change the tools' `execute` bodies — the loop reads `call.args.expect`. The tools ignore `expect` themselves.

- [ ] **Step 4: Wire `reactiveCheck` into §5c** in `src/core/agent-loop/agent.ts`. Add imports near the other `../sense/*` imports:
```ts
import { reactiveCheck } from '../sense/reactive-check';
import { OcrEngine } from '../../platform/ocr-engine';
```
Add a lazy OCR singleton near the top of the file (module scope, mirrors the pattern in tools.ts):
```ts
let _reactiveOcr: OcrEngine | null = null;
function reactiveOcr(): OcrEngine { return (_reactiveOcr ??= new OcrEngine()); }
```
In §5c, AFTER the line `if (postSnapshot) fph.push(postSnapshot.fingerprint);` (the `fingerprintChanged` const is already computed just above) and BEFORE `steps.push({`, insert:
```ts
        // Layer C: reactive step discipline — verify the agent-stated `expect`
        // (HARD → DEVIATION) or apply the tolerant soft net when omitted. Reuses
        // the verify engine + the fingerprintChanged signal already computed.
        const reactive = await reactiveCheck({
          expect: (call.args as Record<string, unknown>).expect,
          toolText: result.text,
          toolSuccess: result.success,
          changesScreen: tool.changesScreen,
          observedChange: fingerprintChanged,
          adapter: deps.adapter,
          ocrText: async () => (await reactiveOcr().recognizeScreen()).fullText ?? '',
        }).catch(() => null);
        if (reactive) {
          result = { ...result, success: reactive.success, text: reactive.text };
        }
```
(`result` is a mutable `let` in scope; the subsequent `steps.push` and `toolResults.push` read `result.success`/`result.text`, so the DEVIATION/soft-note flows to the step record AND the next turn's tool_result automatically. `isError: !result.success` makes a DEVIATION surface as an error.)

- [ ] **Step 5: Run** `npx vitest run src/__tests__/run-agent.test.ts` → PASS (3 new + all existing).
- [ ] **Step 6: Regenerate schema + run its test**
```bash
npx tsx scripts/build-mcp-schema.ts --write
npx vitest run src/__tests__/mcp-schema-snapshot.test.ts
```
Expected: snapshot rewritten (the 4 tools gain `expect`; tool COUNT unchanged at 98), test passes.
- [ ] **Step 7: Run** `npx tsc --noEmit` → clean.
- [ ] **Step 8: Commit**
```bash
git add src/core/agent-loop/tools.ts src/core/agent-loop/agent.ts schema.snapshot.json src/__tests__/run-agent.test.ts
git commit -m "feat(ui-map): reactive expect on consequential tools, wired into the loop (Layer C)"
```

---

## Task 3: Prompt guidance + full gate

**Files:**
- Modify: `src/core/agent-loop/prompt.ts`
- Test: full gate

- [ ] **Step 1: Add the reactive rule** to `buildSystemPrompt` in `src/core/agent-loop/prompt.ts`. Read the file; find a sensible numbered rule slot (near the verify/done guidance). Add:

```
N. REACTIVE ACTIONS. The UI may not obey your plan. For any CONSEQUENTIAL action
   (send/save/submit, filling a key field, committing a recipient/chip), pass
   `expect` on the action — the post-condition you require, as an OUTCOME you can
   observe (a window title, a rendered element/chip, a status message) and NOT
   the raw text you typed (apps transform input — a typed address becomes a
   "Name" chip). If the action returns a DEVIATION, it did NOT take — adapt
   (re-find the target, retry, or a different approach) before continuing; do
   not build on it. A "no observable change" note means the same: verify or
   try again. The final done() still takes assertions for the goal as a whole.
```
(Pick the next free rule number in the existing list; keep the wording tight — the prompt is sent every turn.)

- [ ] **Step 2: Run** `npx vitest run src/__tests__/run-agent.test.ts` → still PASS (prompt change shouldn't break the mocked-LLM tests; if any test asserts exact prompt text, reconcile — unlikely).

- [ ] **Step 3: FULL GATE** — run all and report each:
```
npx tsc --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npx vitest run
npx eslint src
```
Both tsc clean; full suite passes (was 842 pass/1 skip + the Layer C tests → ~853 pass/1 skip); eslint 0 errors (16-18 pre-existing warnings OK — don't touch; fix only new-file issues). If a pre-existing untouched test fails, report it.

- [ ] **Step 4: Commit**
```bash
git add src/core/agent-loop/prompt.ts
git commit -m "feat(ui-map): prompt guidance for reactive expect/adapt (Layer C)"
```

---

## Self-review (completed)

**Spec coverage:** §2 reactive step (hard expect → DEVIATION, soft no-change net) → Task 1 (helper) + Task 2 (wiring). §3 integration (`expect` on the 4 tools, §5c wiring, OCR dep, prompt) → Tasks 2 + 3. Chip-safety (outcome assertions, not raw-text) → enforced by the tool/prompt wording + tested in Task 1's chip-safe test. `done(assertions)` unchanged (final gate) — not touched. §4 testing → each task. OS-agnostic: `reactiveCheck` is pure over inputs + adapter reads.

**Placeholder scan:** none — full code in every step. The prompt rule says "pick the next free rule number" — that's a real instruction (the implementer reads the existing numbered list), with the complete rule text provided.

**Type consistency:** `ReactiveInput`/`ReactiveOutcome`/`reactiveCheck`, the `expect` array schema (8 enum'd assertion types, matching the verify engine), `result` mutation in §5c, `reactiveOcr()` singleton — consistent across tasks. Reuses `parseAssertions`/`checkAssertions`/`renderReport` verbatim.

**Risk note:** Task 2 touches §5c (the live loop) but ADDITIVELY — it only mutates `result` when `reactiveCheck` returns non-null (i.e. an `expect` was given, or a consequential no-change soft note). Actions without `expect` that change the screen → `reactiveCheck` returns null → result untouched → existing behavior preserved. The full run-agent suite is the regression guard.
