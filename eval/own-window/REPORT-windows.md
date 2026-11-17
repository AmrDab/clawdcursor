# clawdcursor — own-window + indicator + mascot: Windows test report

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
- **Foreground input / R2 burst → full-screen amber edge glow** (`scripts/edge-glow.ps1`), for the burst + a 1.5 s tail, then back to the outline.
- **Pill** (`scripts/banner.ps1`) with Stop: always on top, draggable by its body, amber flash on appear, burst count shown, "Paused — your turn" while a burst is paused. Verified on-screen by pixel capture (the pill/glow are capture-excluded, so a 0x11→0x0 temp copy was grabbed).

### 4. Foreground burst pauses for the user (resume threshold 4 s)
On user interference mid-burst: user's window + cursor returned at once, glow off, pill stays "Paused — your turn"; after 4 s idle it re-focuses, glow back on, re-applies the whole change from a clean state; if it can't re-establish safely → asks the user. Two correctness fixes from the security review applied (no stale-coordinate replay; restore to where the user actually was at resume). Covered by unit tests.

### 5. Mascot
Retro arrow cursor with two glowing capsule eyes (Notcho-inspired), one pixel grid in `scripts/mascot.json`, rendered identically by the pill and the ghost cursor; blink frame every 4–6 s. A parity test checks both drawers embed the exact grid.

## Known limits (honest)
- Pill pixel art is slightly soft at 225 % DPI (powershell.exe is DPI-unaware); ghost cursor is crisp.
- The in-place user-typing during this specific run raced with the owner's own apps (Notcho/Node popping focus); the 0-steal + screenshot-free facts come from the logged bridge + sampler, not from that typing.

## Reproduce
```
node eval/own-window/live-windows.mjs --external <dir>      # sets up form + Edge + sampler, writes setup.json
node eval/own-window/agent-bridge.mjs <dir>                 # token-gated localhost bridge the agent drives
# an agent drives clawdcursor via curl with the X-Bridge-Token from <dir>/bridge-ready; calls logged to <dir>/calls.jsonl
```
