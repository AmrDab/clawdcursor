# clawdcursor — own-window + indicator: Windows test report

**Branch:** `feat/own-window` · **PR:** AmrDab/clawdcursor #453 · **Date:** 2026-11-17
**Build:** `npm run build` ✓ · **Typecheck/lint:** ✓ · **Full suite:** 3903 passed, 0 failed, 80 skipped (`vitest --project unit --project system`)

## What was verified

### 1. The agent works in its own window (0 focus steals)
Live two-agent run: a **computer-use agent** acted as the user (typing in Calculator) while a **separate clawdcursor-driven agent** worked in its own windows at the same time.

| Agent B step | Route | Effect (read back from the app) | Focus moved |
|---|---|---|---|
| Set form field "ClawdField" | R1 window message | "agent B here" ✓ | no |
| Set form field "ClawdNote" | R1 window message | "done in the background" ✓ | no |
| Click form button "ClawdGo" | R1 window message | label → "CLICKED" ✓ | no |
| Connect to its private Edge | browser (CDP) | dedicated agent instance ✓ | no |
| Set Edge field "Your name" | CDP page act | "Agent B" ✓ | no |
| Click Edge "Send" | CDP page act | page shows CLICKED ✓ | no |

- **Focus steals: 0** (foreground sampled every 50 ms for the whole run).
- **The user side was active throughout** (cursor moved across 2221 of the samples).
- Agent B **never touched Calculator** (it refuses any window it was not given).

### 2. Agents do not depend on screenshots
The bridge logs every tool call agent B made, including whether the result carried an image/screenshot:

```
accessibility set_value  image=False  route=R1 window message, focus not moved
accessibility set_value  image=False  route=R1 window message, focus not moved
accessibility invoke     image=False  route=R1 window message, focus not moved
browser       connect    image=False
accessibility set_value  image=False  route=CDP page act, focus not moved
accessibility invoke     image=False  route=CDP page act, focus not moved
```
**Screenshot/image calls: 0 / 6.** The whole task ran through the accessibility tree, window messages and the browser connection — clawdcursor's tree-first path, no pixels.

### 3. Two-mode indicator (owner's design)
- **Background work → outline** around the agent's own window(s) only (`scripts/window-outline.ps1`). Multi-window `TARGET` line now emitted on every OS.
  **Correction (2026-11-18):** in pure background mode, as in this run (the agent never touched the window in front), the outline was never told which window to frame, so no frame was drawn. The Mac run found this; it is fixed in `37994387` (REPORT-macos.md §8.1), verified live on macOS (REPORT-macos.md §7), and still needs a live re-check on Windows.
- **Foreground input / R2 burst → full-screen amber edge glow** (`scripts/edge-glow.ps1`), for the burst + a 1.5 s tail, then back to the outline.
- **Pill** (`scripts/banner.ps1`) with Stop: always on top, draggable by its body, amber flash on appear, burst count shown, "Paused — your turn" while a burst is paused. Verified on-screen by pixel capture (the pill/glow are capture-excluded, so a 0x11→0x0 temp copy was grabbed).
- **The user's step (pause_for_user) → full-screen blue glow, no outline** (`8328273e`, the owner's third state). Unit-tested; live on macOS (REPORT-macos.md §7), not yet on Windows.

### 4. The user's turn (updated 2026-11-18, the owner's rule: `58dbe13b`, `7c97b7be`)
Every real input (keys, typing, clicks, drags, pointer moves, bringing a window to the front, launching an app) waits until the user has been idle 1 s; background acts (by name, window messages, browser page acts) do not. When the user takes over (busy as the agent wants to start, or their input mid-burst): their window and cursor come back at once, nothing more is sent, the glow goes off and the pill says "Paused — your turn"; after 5 s it goes on if they are idle, else it waits for **Resume** on the pill. The pill's new **Pause** button holds every act, background ones included, until Resume. A held call returns a waiting reply ("call the same step again") before a host's 60 s limit. This replaces the 4 s auto-resume this run had. Covered by unit tests (`user-turn.test.ts`, `foreground-burst.test.ts`); the Pause hold is verified live on macOS (REPORT-macos.md §6 f); **not yet live on Windows**.

### 5. Agent cursor (updated 2026-11-18, owner's call)
The pill keeps its original orb (the mascot was removed). The ghost cursor that shows where the agent acts is a retro pixel arrow with **no eyes** — dark body, light rim — so it never looks like the user's own cursor. One grid in `scripts/agent-cursor.json`, drawn by the Windows ghost (`window-outline.ps1`) and the macOS ghost (`overlay.swift`); a parity test checks both embed the exact grid.

## Known limits (honest)
- **Not yet re-checked live on Windows** (one on-screen run, needs the owner's go): the outline in background mode (fixed after this run), the blue glow at a pause, and the user's turn (the idle wait, the 5 s takeover, the pill's Pause / Resume).
- Pill pixel art is slightly soft at 225 % DPI (powershell.exe is DPI-unaware); ghost cursor is crisp.
- The in-place user-typing during this specific run raced with the owner's own apps (Notcho/Node popping focus); the 0-steal + screenshot-free facts come from the logged bridge + sampler, not from that typing.

## Reproduce
```
node eval/own-window/live-windows.mjs --external <dir>      # sets up form + Edge + sampler, writes setup.json
node eval/own-window/agent-bridge.mjs <dir>                 # token-gated localhost bridge the agent drives
# an agent drives clawdcursor via curl with the X-Bridge-Token from <dir>/bridge-ready; calls logged to <dir>/calls.jsonl
```
