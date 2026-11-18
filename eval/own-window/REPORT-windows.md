# clawdcursor — own-window + indicator: Windows test report

**Branch:** `feat/own-window` · **PR:** AmrDab/clawdcursor #453 · **Dates:** 2026-11-17 (§1–§5), 2026-11-18 (§6, the release candidate)
**Build:** `npm run build` ✓ · **Typecheck/lint:** ✓ · **Full suite:** 3903 passed, 0 failed, 80 skipped (`vitest --project unit --project system`); on the release candidate (§6) 3897 passed, 0 failed, and the MCP schema snapshot OK (compact 6, granular 90 tools)

**Result:** the agent works in its own windows with **0 focus steals** and **0 screenshots**. On the release candidate every state of the indicator and the user's turn were verified live (§6, **14/14**, the owner confirming each one).

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
  **Correction (2026-11-18):** in pure background mode, as in this run (the agent never touched the window in front), the outline was never told which window to frame, so no frame was drawn. The Mac run found this; it is fixed in `37994387` (REPORT-macos.md §8.1) and verified live on macOS (REPORT-macos.md §7) and on Windows (§6).
- **Foreground input / R2 burst → full-screen amber edge glow** (`scripts/edge-glow.ps1`), for the burst + a 1.5 s tail, then back to the outline.
- **Pill** (`scripts/banner.ps1`) with Stop: always on top, draggable by its body, amber flash on appear, burst count shown, "Paused — your turn" while a burst is paused. Verified on-screen by pixel capture (the pill/glow are capture-excluded, so a 0x11→0x0 temp copy was grabbed).
- **The user's step (pause_for_user) → full-screen blue glow, no outline** (`8328273e`, the owner's third state). Verified live on macOS (REPORT-macos.md §7) and on Windows (§6).

### 4. The user's turn (updated 2026-11-18, the owner's rule: `58dbe13b`, `7c97b7be`)
Every real input (keys, typing, clicks, drags, pointer moves, bringing a window to the front, launching an app) waits until the user has been idle 1 s; background acts (by name, window messages, browser page acts) do not. When the user takes over (busy as the agent wants to start, or their input mid-burst): their window and cursor come back at once, nothing more is sent, the glow goes off and the pill says "Paused — your turn"; after 5 s it goes on if they are idle, else it waits for **Resume** on the pill. The pill's new **Pause** button holds every act, background ones included, until Resume. A held call returns a waiting reply ("call the same step again") before a host's 60 s limit. This replaces the 4 s auto-resume this run had. Covered by unit tests (`user-turn.test.ts`, `foreground-burst.test.ts`); verified live on macOS (REPORT-macos.md §6 f) and on Windows (§6).

### 5. Agent cursor (updated 2026-11-18, owner's call)
The pill keeps its original orb (the mascot was removed). The ghost cursor that shows where the agent acts is a retro pixel arrow with **no eyes** — dark body, light rim — so it never looks like the user's own cursor. One grid in `scripts/agent-cursor.json`, drawn by the Windows ghost (`window-outline.ps1`) and the macOS ghost (`overlay.swift`); a parity test checks both embed the exact grid.

### 6. The release candidate, one combined run (`5857fb71`, main `1d5c528f` merged in; 2026-11-18)

`full-windows.mjs`: the owner at the PC, with spoken cues; their answers went on clawdcursor's own pause card. ClawdUser (the owner's stand-in window), ClawdTarget (the agent's WinForms window) and Edge as its own instance; `overlay-recorder.ps1` recorded the test server's overlay windows and the agent's windows only (268 snapshots); a 50 ms foreground sampler (4060 samples).

```
[BACKGROUND]  set_value ClawdField  -> R1 window message, focus not moved [confirmed] | outline 1418,887 1003x502 (ClawdTarget MATCH) | glow no
[BACKGROUND]  invoke ClawdGo        -> R1 window message, focus not moved            | outline (ClawdTarget MATCH) | glow no
[BACKGROUND]  browser type #n       -> read back ✓ [confirmed]                        | outline 35,23 2339x2236 (Edge MATCH) | glow no
[BACKGROUND]  browser click Send    -> clicked                                       | outline (Edge MATCH) | glow no
   … 2 rounds, all MATCH, glow no …
[FOREGROUND]  window focus ClawdTarget, computer type " foreground-typed" [confirmed] | glow amber
[PAUSE]       question card: blue glow, no outline; owner: "Both yes"
[YOUR TURN]   the owner typed in ClawdUser; window focus ClawdTarget waited 43.4 s (takeover, then held until their Resume); then computer type " after-your-turn" [confirmed]
[PILL PAUSE]  the owner clicked Pause; set_value ClawdNote waited 9.9 s and landed only after their Resume; no glow; owner: "Yes"
```

| Check | Result |
|---|---|
| Outline round ClawdTarget in background | PASS |
| Outline round Edge in background | PASS |
| No glow in background | PASS |
| Amber glow in foreground | PASS |
| Blue glow and no outline at the pause | PASS |
| Owner: the frame earlier, blue edges now | PASS ("Both yes") |
| Focus steals during background work | PASS (0) |
| The owner's typing intact (no agent text in ClawdUser; ClawdField "agent-round-2"; page "page-round-2", CLICKED) | PASS |
| Foreground typing landed in ClawdTarget | PASS |
| Your turn: the agent waited for the owner (43.4 s, held) | PASS |
| Your turn: nothing of the agent's in the owner's window; it typed in ClawdTarget after Resume | PASS |
| The pill's Pause held a background act until Resume (9.9 s) | PASS |
| No glow while paused from the pill | PASS |
| Owner: the pill said Paused with Resume, no glow | PASS ("Yes") |

## Known limits (honest)
- Pill pixel art is slightly soft at 225 % DPI (powershell.exe is DPI-unaware); ghost cursor is crisp.
- The in-place user-typing during this specific run raced with the owner's own apps (Notcho/Node popping focus); the 0-steal + screenshot-free facts come from the logged bridge + sampler, not from that typing.

## Reproduce
```
node eval/own-window/live-windows.mjs --external <dir>      # sets up form + Edge + sampler, writes setup.json
node eval/own-window/agent-bridge.mjs <dir>                 # token-gated localhost bridge the agent drives
# an agent drives clawdcursor via curl with the X-Bridge-Token from <dir>/bridge-ready; calls logged to <dir>/calls.jsonl
```
