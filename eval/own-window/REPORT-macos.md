# clawdcursor — own-window + indicator: macOS test report

**Branch:** `feat/own-window` · **PR:** AmrDab/clawdcursor #453 · **Date:** 2026-11-18
**Machine:** macOS 26.5, iMac 2240×1260 pt @2x, node v25.9.0 · **Tested:** `60a0c497` (a separate test checkout, not the owner's)
**Build:** `npm ci` + `npm run build` ✓ · **`swiftc -O scripts/mac/overlay.swift`:** exit 0, **no warnings** · **Mac unit tests:** 70/70
The owner approved every on-screen step. Fixes for what this run found are listed in §6; they are verified by unit tests on Windows and need one short live Mac re-check (§7).

## 1. The agent works in its own window — 0 focus steals

Two-agent live run (`live-macos.mjs --external` + `agent-bridge.mjs`). **Agent A — the user:** the owner typed by hand in a TextEdit window (`user.txt`) for the whole run; the owner had declined computer-use access to TextEdit, so a human took agent A's place, which is the harder case because a person types unpredictably. **Agent B:** a clawdcursor agent driving the MCP server through the bridge, with curl only, every call addressed by `processId` to its own windows (ClawdTarget, a native Cocoa window, and a temp Chrome).

| Agent B call | Result |
|---|---|
| `accessibility read_tree` ClawdTarget | ✓ |
| `accessibility set_value` "ClawdField" | ✗ NOT_FOUND: the test window's field had no accessibility name (harness bug, fixed) |
| `accessibility invoke` "ClawdGo" | ✓ the label reads **CLICKED** |
| `accessibility compile_ui` ClawdTarget, then `set_value el_1` | ✗ STALE_REF "window changed since compile" (product bug, fixed: §6) |
| `browser connect` → `page_context` → `type` "Agent B" → `click` Send → `read_text` | ✓ the page reads `{"name":"Agent B","out":"CLICKED"}` |

- **Focus steals: 0.** The frontmost app was sampled every 50 ms for the whole run.
- **All of the user's typing landed**: about 450 characters in `user.txt`, none lost to the agent.
- 1017 samples saw the cursor move (up to 244 px). That was the owner's own mouse; clawdcursor never moved it.
- Agent B never touched TextEdit.

## 2. Agents do not depend on screenshots

The bridge logs every call agent B made, with whether the result carried an image:

```
accessibility read_tree   image=false      accessibility read_tree  image=false
accessibility set_value   image=false      browser connect          image=false
accessibility invoke      image=false      browser page_context     image=false
accessibility read_tree   image=false      browser type             image=false
accessibility compile_ui  image=false      browser click            image=false
accessibility set_value   image=false      browser read_text        image=false
```
**Screenshot/image calls: 0 of 12.** Everything went through the accessibility tree and the browser connection. `route` was `null` on every line: macOS replies carry no route note for an act by name (R0) or a browser-tool call, so this means "no note", not "unknown path".

## 3. Two-mode indicator

| Mode | Evidence | Owner |
|---|---|---|
| **Foreground → full-screen glow** | One window per screen at layer 25 (status bar), full-screen bounds, on screen. Pixels from a copy allowed in captures, as the average colour of a 20 pt strip: top 50,129,183 → **164,146,108**, bottom 98,133,118 → **178,147,76**, left 72,148,177 → **174,154,103**, right 85,132,153 → **174,147,95**; centre 85,120,135 → 85,120,135 (unchanged). All four edges turn amber. | "Yes, amber edges" |
| **No glow during background work** | The window recorder saw no glow window during agent B's run. | "it should only flash around the screen during foreground work, background stays outlines" ✓ |
| **Background → outline around the agent's window** | ✗ **Did not appear.** The recorder saw no outline window around ClawdTarget or Chrome. Root cause found and fixed (§6.1); not yet re-checked live. | "framed first the pill … but then frame outline left" |
| **Pill (orb)** | Layer 1000 (screen saver), 278×38 pt, on screen; still the top-most window at 5, 15 and 25 s with Finder in front. | "Yes, the orb", "Stayed on top" |
| **Ghost cursor** | Layer 25, 22×34 pt, on screen. | "Yes, plain arrow" (dark body, light rim, no eyes) |

The amber frame the owner saw round the pill is the pill's own 3 s flash when it appears (added on Windows so it gets noticed), not the window outline.
On the first run (`c9a7959c`), the owner said the pill "went behind" other windows. This was not reproduced on `60a0c497`, where it stayed on top in all three checks.

## 4. Background delivery probe (`probe-macos.mjs`)

| target | M0 AX setValue | M1 AXPress | M2 posted keys | M3 posted click | M4 AppleScript | M5 CDP |
|---|---|---|---|---|---|---|
| native Cocoa window | ok | ok | ok | no-effect | n/a | n/a |
| TextEdit (new instance) | ok | n/a | ok | n/a | ok | n/a |
| Chrome (temp profile, incognito) | ok | ok | ok | no-effect | n/a | text ok / click ok |

Side effects: **none** for every target and method: the front app never changed, the real cursor never moved, and the user's text never changed. Safari was skipped (it was already running with the owner's windows).
A posted mouse click (`CGEventPostToPid`) does nothing in a background window on macOS, so background clicks go by AXPress (R0) or CDP, and both work.

## 5. Attempt 1 (not counted)

It hit the script's 480 s hard timeout before agent B started, while the agent-A role was being settled. Two harness problems showed up there: the timeout path **left its temp Chrome running**, and agent B made an **unscoped `window list`, which returned the owner's real window titles**. Both are fixed (§6.3).

## 6. Fixes (after `60a0c497`)

1. **The outline in background mode, on every OS.** A by-name act or page act on a process that is not in front added it to the agent's windows, but never made it the window the outline goes round. An agent that never touched the window in front therefore got no frame. That is exactly background mode, so the Windows run had the same gap; it went unnoticed there. Now that process is the working window (`control.ts` `byProcess`), and a page act tells the pill and outline once its browser is known (`pointer-guard.ts`). Tests: `agent-windows.test.ts` (both new cases fail on the old code).
2. **Element refs into a background window.** `compile_ui` with a `processId` gave refs that only worked if that window was in front, so they failed with STALE_REF as soon as the user was in another app. Now a ref into a window that is not in front acts by name in that process (R1 window messages, CDP, the ladder; focus not moved). An element with no unique name there is refused with a clear reason, because a click at its bounds would land on the user's window. Tests: `ui-map-ref-actions.test.ts` (3 new cases fail on the old code; invoke and set never click).
3. **Harness:** ClawdTarget's field has an accessibility name; every exit path closes the temp Chrome; the bridge accepts only `accessibility` calls addressed to the test's own pids, plus `browser`, and refuses and logs (`blocked: true`) anything else, such as `window list` or screenshots.

## 7. Known limits and what is left

- **Live re-check on the Mac (one short run):** the outline round ClawdTarget and Chrome in background mode, and `set_value` through a `compile_ui` ref while the user is in another app.
- On macOS a click by name comes back `[unverified]` even when it worked (the label did read CLICKED). It is a verification gap, not fixed here.
- Agent A was the owner by hand, not computer use. Safari was not probed.
