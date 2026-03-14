# ClawdCursor v0.8.0 — Claude Code Instructions

## Overview

This document defines the architecture and implementation plan for ClawdCursor v0.8.0.

**The core shift:** v0.7.0 is an accessibility-tree-first agent with a vision LLM fallback.
v0.8.0 inverts this. The primary read layer is **OCR over screenshot** — universal, works on any UI,
no app-specific dependencies. The a11y tree becomes a **skill cache** (fast path for learned, repeated tasks).
Vision LLM drops to final fallback only.

**Why:** OCR output is structured text the LLM can reason about without seeing the image.
This means cheaper models, faster responses, and universal UI coverage (Electron, game UIs, remote desktops,
anything that renders pixels). The a11y tree is faster but brittle and app-specific — it belongs in a
"learned shortcut" layer, not the default path.

---

## Current Architecture (v0.7.0 — do not delete, only extend)

```
Task
 ├─ L0: LocalTaskParser (regex, no LLM)
 ├─ L1: ActionRouter (deterministic flows)
 ├─ L1.5: SmartInteractionLayer (CDP + UIDriver + cheap text LLM)
 ├─ L2: A11yReasoner (a11y tree + text LLM loop)
 └─ L3: ComputerUse / GenericComputerUse (screenshot + vision LLM loop)
```

Key files:
- `src/agent.ts` — main orchestration loop
- `src/a11y-reasoner.ts` — L2, a11y tree reader + text LLM
- `src/generic-computer-use.ts` — L3, vision LLM loop
- `src/accessibility.ts` — a11y tree bridge (Windows UIA / macOS AX)
- `src/native-desktop.ts` — nut-js mouse/keyboard + screenshot
- `src/smart-interaction.ts` — L1.5, CDP + UIDriver
- `src/action-router.ts` — L1, deterministic patterns
- `src/providers.ts` — LLM provider config

**Do not break any of this.** v0.7.0 behavior must remain intact.
The new layers are additive inserts into the pipeline.

---

## Target Architecture (v0.8.0)

```
Task
 ├─ L0: LocalTaskParser (unchanged)
 ├─ L1: ActionRouter (unchanged)
 ├─ L1.5: SmartInteractionLayer (unchanged — CDP tasks)
 ├─ L2: SkillCache — fast path for KNOWN repeated tasks
 │        (uses saved a11y tree snapshots + element maps)
 ├─ L2.5: OCRReasoner — PRIMARY universal read layer
 │        (screenshot → OCR → structured text → text LLM → action)
 └─ L3: VisionLLM — fallback only (unchanged, last resort)
```

**Pipeline decision logic (in `agent.ts`):**
1. L0 / L1 / L1.5 — unchanged, same as v0.7.0
2. Check SkillCache: does a skill exist for this task+app pair?
   - YES → execute cached a11y path → verify result → done (or fall through to L2.5 if fail)
   - NO → continue to L2.5
3. OCRReasoner: take screenshot → OCR → feed bounding boxes as text to text LLM → act → repeat
   - After each successful loop: offer to save as skill (promote to SkillCache)
4. VisionLLM: only if OCRReasoner explicitly signals "cannot read UI" (e.g. captcha, pure image content)

---

## What to Build

### 1. `src/ocr-engine.ts` — OCR Bridge

**Purpose:** Take a screenshot (or region), return structured OCR results with bounding boxes.

**Interface:**
```typescript
export interface OcrElement {
  text: string;
  x: number;        // left edge in screen pixels
  y: number;        // top edge
  width: number;
  height: number;
  confidence: number; // 0.0–1.0
  line: number;     // line index (for grouping)
}

export interface OcrResult {
  elements: OcrElement[];
  fullText: string;  // flat concatenation for quick search
  durationMs: number;
}

export class OcrEngine {
  async recognizeScreen(): Promise<OcrResult>
  async recognizeRegion(x: number, y: number, w: number, h: number): Promise<OcrResult>
  isAvailable(): boolean  // false if OS OCR not found — graceful degrade
}
```

**Implementation:**
- **Windows:** Use `Windows.Media.Ocr` via PowerShell bridge (same pattern as `ps-runner.ts`).
  Script template:
  ```powershell
  Add-Type -AssemblyName System.Drawing
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
  # ... load bitmap from path, run OcrEngine.TryCreateFromUserProfileLanguages()
  # ... return JSON array of { text, x, y, width, height, confidence, line }
  ```
- **macOS:** Use Vision framework via JXA (JavaScript for Automation) or a Swift one-shot binary.
  Use `VNRecognizeTextRequest` — returns observation bounding boxes in normalized coords (0.0–1.0),
  multiply by image dimensions to get pixels.
- **Fallback:** If OS OCR unavailable, return `{ elements: [], fullText: '', durationMs: 0 }` — caller
  falls through to vision LLM. Do NOT throw.
- **Screenshot path:** Save screenshot to temp file, pass path to OS OCR, delete after. Reuse
  `NativeDesktop.captureForLLM()` for the screenshot (already handles multi-monitor, scaling).
- **Cache:** Keep the last result for 300ms. If called again within that window return cached.
  Invalidate on any action execution (same dirty-bit pattern planned for Fix 2).

---

### 2. `src/ocr-reasoner.ts` — OCR-Based Task Reasoner (L2.5)

**Purpose:** The primary task execution loop. Replaces A11yReasoner as the default path.

**How it works:**
1. Take screenshot → run OCR → build a structured "UI snapshot" string
2. Feed snapshot + task to text LLM (same cheap model as L2, `pipelineConfig.layer2`)
3. LLM returns a structured action (click at coords, type text, press key, done, or "cannot_read")
4. Execute action via `NativeDesktop`
5. Loop — re-OCR after each action, verify progress
6. On `done`: record successful element interactions for skill promotion
7. On `cannot_read` after 3 retries: signal caller to fall through to vision LLM

**The UI snapshot format fed to the LLM:**

```
=== SCREEN SNAPSHOT ===
[OCR Text Elements with positions]
(12,45) "File" | (72,45) "Edit" | (132,45) "View"
(20,120) "To:" | (60,120) "amr@example.com"
(20,150) "Subject:" | (80,150) "Hello"
...

=== A11Y TREE (if available) ===
[Window: Outlook - New Message]
  Button "Send" (alt+s) at ~(800,40)
  EditField "To" focused: empty
...
```

The LLM gets BOTH OCR output AND whatever a11y tree is available — it decides which to trust.
This means the a11y tree still provides value (keyboard shortcuts, semantic roles) without being the primary read source.

**LLM response format:**
```typescript
type OcrAction =
  | { action: 'click';     x: number; y: number; description: string }
  | { action: 'type';      text: string; description: string }
  | { action: 'key';       key: string; description: string }
  | { action: 'scroll';    x: number; y: number; direction: 'up'|'down'; amount: number }
  | { action: 'wait';      ms: number; reason: string }
  | { action: 'done';      evidence: string }
  | { action: 'cannot_read'; reason: string }  // triggers vision LLM fallback
```

**Coordinate handling:**
OCR returns coordinates in real screen pixels. No scaling needed — unlike vision LLM which gets
a downscaled screenshot and needs `scaleFactor` correction. This simplifies the coordinate path significantly.

**Interface:**
```typescript
export class OcrReasoner {
  constructor(
    ocr: OcrEngine,
    desktop: NativeDesktop,
    a11y: AccessibilityBridge,
    pipelineConfig: PipelineConfig,
    logger?: TaskLogger,
  ) {}

  async run(task: string, config: ClawdConfig): Promise<StepResult>
}
```

---

### 3. `src/skill-cache.ts` — Skill Cache (L2)

**Purpose:** Store and replay learned task paths. When a user runs the same task multiple times,
the a11y element map from a successful run is saved. Future runs skip OCR+LLM and execute directly.

**What a skill stores:**
```typescript
export interface Skill {
  id: string;
  taskPattern: string;      // normalized task string or regex
  appName: string;          // process name (e.g. "OUTLOOK", "chrome")
  steps: SkillStep[];
  successCount: number;
  lastUsed: number;         // timestamp
  createdAt: number;
}

export interface SkillStep {
  type: 'a11y_click' | 'a11y_type' | 'key' | 'wait';
  // For a11y actions — use these to find elements reliably:
  automationId?: string;    // most stable identifier
  name?: string;            // element name/label
  role?: string;            // e.g. "Button", "Edit"
  // For key actions:
  key?: string;
  // For type actions:
  textTemplate?: string;    // supports {variable} placeholders for dynamic content
  // For wait:
  ms?: number;
}
```

**Skill matching:** Normalize task string (lowercase, strip punctuation, stem key verbs).
Match against stored `taskPattern`. Fuzzy match threshold: 0.85 similarity.

**Skill storage:** JSON file at `~/.clawd-cursor/skills.json`.
Load at startup, save after each new skill is created or updated.

**Skill promotion:** After `OcrReasoner` completes a task successfully, if `successCount === 0`
(first time seen), log steps but don't auto-promote. If the same task pattern succeeds 2+ times,
auto-promote: serialize the a11y element path and save as a skill.
(This prevents one-off tasks from bloating the cache.)

**Skill execution:**
```typescript
export class SkillCache {
  load(): void
  findSkill(task: string, appName: string): Skill | null
  executeSkill(skill: Skill, desktop: NativeDesktop, a11y: AccessibilityBridge): Promise<'success' | 'miss'>
  recordSuccess(task: string, appName: string, steps: SkillStep[]): void
  promote(taskPattern: string, appName: string): void
}
```

On `miss` (a11y element not found): fall through to `OcrReasoner` and invalidate the skill
(decrement `successCount`, remove if < 0 — elements may have moved after an app update).

---

### 4. Wire into `agent.ts`

Insert the new layers between the existing L1.5 and L2:

```typescript
// After SmartInteractionLayer attempt fails...

// NEW: L2 — SkillCache
const skill = this.skillCache.findSkill(subtask.task, activeApp.processName);
if (skill) {
  const skillResult = await this.skillCache.executeSkill(skill, this.desktop, this.a11y);
  if (skillResult === 'success') { /* done */ continue; }
  // miss → fall through
}

// NEW: L2.5 — OcrReasoner
if (this.ocrEngine.isAvailable() && pipelineConfig.layer2) {
  const ocrResult = await this.ocrReasoner.run(subtask.task, config);
  if (ocrResult.success) {
    // Offer skill promotion
    this.skillCache.recordSuccess(subtask.task, activeApp.processName, ocrResult.steps);
    continue;
  }
  if (ocrResult.fallbackReason !== 'cannot_read') {
    // Failed but not because OCR couldn't read — log and continue to L3
  }
}

// Existing L3: Vision LLM (unchanged)
```

---

### 5. `pipelineConfig` additions

In `src/providers.ts`, `PipelineConfig` needs:
```typescript
ocrEnabled: boolean;     // default true if OS OCR is available
skillCacheEnabled: boolean; // default true
```

In `src/doctor.ts`, auto-detect OCR availability:
```typescript
const ocrAvail = await new OcrEngine().isAvailable();
config.ocrEnabled = ocrAvail;
```

---

## Implementation Order

Do these in sequence. Each step is independently testable.

### Step 1: `src/ocr-engine.ts`
- Windows path first (PowerShell bridge)
- Unit test: take a screenshot of a known window, assert OCR finds expected text
- macOS path second
- `isAvailable()` must never throw

### Step 2: `src/ocr-reasoner.ts`
- Start with a simple single-step version (OCR → LLM → one action)
- Wire to text LLM via `pipelineConfig.layer2` (same model as A11yReasoner)
- The UI snapshot string builder is the most critical piece — get it right
- Add the verify loop (re-OCR after action, check progress) in a second pass
- Test: task "click the Start button" on a fresh desktop — should complete with 1 OCR read, 1 LLM call, 1 click

### Step 3: `src/skill-cache.ts`
- Implement load/save to `~/.clawd-cursor/skills.json`
- Implement fuzzy match (use a simple token overlap ratio — no new npm deps)
- Implement `executeSkill` with graceful miss fallback
- Test: record a 3-step skill, reload, execute it

### Step 4: Wire into `agent.ts`
- Insert SkillCache check at L2 position
- Insert OcrReasoner at L2.5 position
- Existing L2 (A11yReasoner) becomes L3, shifting vision to L4
  OR: remove A11yReasoner as a standalone layer — its a11y-read logic is now a supplement
  to OcrReasoner (feeds the snapshot string), not a separate loop.
  **Decision:** Keep A11yReasoner but only call it when OcrReasoner signals `cannot_read`
  and there is no vision LLM configured. This preserves its value in zero-API-key setups.

### Step 5: Update `serve` tool descriptions
- `read_screen` tool description should note that v0.8.0 prefers OCR over raw a11y tree
- Add `ocr_read_screen` as a new tool in `src/tools/` that returns OCR elements as JSON
  (useful for agent integrations via `clawdcursor serve`)

---

## Constraints

- **No new npm dependencies** for OCR. Use OS bridges only (PowerShell / JXA / Swift).
- **Model-agnostic.** OcrReasoner uses `pipelineConfig.layer2` (text model). Any provider works.
- **Graceful degrade.** If OCR is unavailable, skip L2.5 silently. v0.7.0 behavior is preserved.
- **Coordinate simplicity.** OCR coordinates are real screen pixels — no `scaleFactor` needed.
  Document this clearly to avoid confusion with vision LLM coordinate path.
- **Skill cache is opt-out, not opt-in.** Enabled by default if the task succeeds ≥2 times.
  User can clear skills with `clawdcursor setup --clear-skills` (or by deleting `~/.clawd-cursor/skills.json`).
- **Existing tests must still pass.** Run `npx vitest run` after each step. Do not touch
  `__tests__/action-router.test.ts`, `coordinate-scaling.test.ts`, `safety.test.ts`, `verifiers.test.ts`.
- **TypeScript strict mode is on.** All new files must have full type annotations.
- **Windows first, macOS second.** OCR on Windows is the priority. macOS can stub with `isAvailable(): false`
  in Step 1, implemented in Step 1b.

---

## Files to Create

| File | Description |
|------|-------------|
| `src/ocr-engine.ts` | OcrEngine class, Windows + macOS bridges |
| `src/ocr-reasoner.ts` | L2.5 loop — OCR snapshot + text LLM + action |
| `src/skill-cache.ts` | Skill storage, match, execute, promote |
| `src/tools/ocr.ts` | `ocr_read_screen` tool for serve mode |
| `src/__tests__/ocr-engine.test.ts` | Unit tests for OcrEngine |
| `src/__tests__/skill-cache.test.ts` | Unit tests for SkillCache |

## Files to Modify

| File | Change |
|------|--------|
| `src/agent.ts` | Insert SkillCache (L2) and OcrReasoner (L2.5) into pipeline |
| `src/providers.ts` | Add `ocrEnabled`, `skillCacheEnabled` to PipelineConfig |
| `src/doctor.ts` | Auto-detect OCR availability, set `ocrEnabled` |
| `src/tool-server.ts` | Register `ocr_read_screen` tool |
| `src/a11y-reasoner.ts` | Expose `readSnapshot()` method so OcrReasoner can call it for the a11y supplement |

---

## Done Criteria

- [ ] `npx vitest run` — all 55 existing tests pass, ≥10 new tests added
- [ ] Windows OCR: `ocrEngine.recognizeScreen()` returns elements with correct bounding boxes
- [ ] OcrReasoner completes "open Notepad and type hello" with 0 vision LLM calls
- [ ] SkillCache: second run of same task skips OCR+LLM, executes from cache
- [ ] `clawdcursor serve` exposes `ocr_read_screen` tool, returns JSON
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] macOS: `OcrEngine.isAvailable()` returns false without crashing (stub acceptable for v0.8.0-alpha)
