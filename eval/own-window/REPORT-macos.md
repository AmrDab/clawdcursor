# clawdcursor — own-window + indicator: macOS test report

**Branch:** `feat/own-window` · **PR:** AmrDab/clawdcursor #453 · **Date:** 2026-11-18
**Machine:** macOS 26.5, iMac 2240×1260 pt @2x, node v25.9.0 · a separate test checkout, not the owner's
**Tested:** `60a0c497` (first two-agent run, §1–§5), `58dbe13b` (two-agent re-run with the pill's Pause, §6), `0f8d8d98` (one combined background → foreground → pause run, §7)
**Build:** `npm ci` + `npm run build` ✓ · **`swiftc`** `overlay.swift` and `ax-helper.swift`: exit 0, **no warnings** (on `60a0c497`, `58dbe13b`, `7c97b7be`) · **Mac unit tests:** 70/70, then the six changed test files 86/86
The owner approved every on-screen step.

**Result:** the agent works in its own windows with **0 focus steals** and **0 screenshots**. The indicator shows the three states on macOS: an **outline** round the agent's windows in background work (✓ after the fix in `0f8d8d98`), the **amber full-screen glow** in foreground work, and the **blue glow with no outline** when the agent needs the user. The pill's **Pause** holds the agent until Resume.

## 1. The agent works in its own window — 0 focus steals (`60a0c497`)

Two-agent live run (`live-macos.mjs --external` + `agent-bridge.mjs`). **Agent A — the user:** the owner typed by hand in a TextEdit window (`user.txt`) for the whole run; the owner had declined computer-use access to TextEdit, so a human took agent A's place, which is the harder case because a person types unpredictably. **Agent B:** a clawdcursor agent driving the MCP server through the bridge, with curl only, every call addressed by `processId` to its own windows (ClawdTarget, a native Cocoa window, and a temp Chrome).

| Agent B call | Result |
|---|---|
| `accessibility read_tree` ClawdTarget | ✓ |
| `accessibility set_value` "ClawdField" | ✗ NOT_FOUND: the test window's field had no accessibility name (harness bug, fixed; ✓ on `58dbe13b`) |
| `accessibility invoke` "ClawdGo" | ✓ the label reads **CLICKED** |
| `accessibility compile_ui` ClawdTarget, then `set_value el_1` | ✗ STALE_REF "window changed since compile" (product bug, fixed in §8; ✓ on `58dbe13b`) |
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
**Screenshot/image calls: 0 of 12.** Everything went through the accessibility tree and the browser connection. `route` was `null` on every line: macOS replies carry no route note for an act by name (R0) or a browser-tool call, so this means "no note", not "unknown path". The re-runs (§6, §7) used the same tools: accessibility by `processId`, the browser, and `pause_for_user`; the bridge refuses anything else.

## 3. The indicator

| State | Evidence | Owner |
|---|---|---|
| **Background → outline round the agent's windows** | `0f8d8d98`: the recorder saw an outline window exactly on ClawdTarget (200,728 300×232 = MATCH) and on Chrome (22,52 1200×1096 = MATCH) for every background act, 3 rounds of set_value / invoke / browser type / browser click; no glow. (On `60a0c497`–`7c97b7be` it never appeared: §8.4.) | "Both yes" (a frame round the test window and Chrome) |
| **Foreground → full-screen amber glow** | One window per screen at layer 25 (status bar), full-screen bounds. Pixels from a copy allowed in captures, the average colour of a 20 pt strip: top 50,129,183 → **164,146,108**, bottom 98,133,118 → **178,147,76**, left 72,148,177 → **174,154,103**, right 85,132,153 → **174,147,95**; centre 85,120,135 unchanged. `0f8d8d98`: `computer type` after `window focus` → glow at layer 25, about 4 s. | "Yes, amber edges" |
| **No glow during background work** | No glow window during any background act (both runs). | ✓ |
| **The user's step (pause_for_user) → blue glow, no outline** | `0f8d8d98`: the card (pill 460×116) + glow at layer 25, **no outline window**; Resume → `resumed, confirmedByUser`. | "Both yes" (blue pulsing edges with the card, no frame) |
| **Pill (orb)** | Layer 1000 (screen saver), 278×38 pt; still the top-most window at 5, 15 and 25 s with Finder in front. | "Yes, the orb", "Stayed on top" |
| **Ghost cursor** | Layer 25, 22×34 pt. | "Yes, plain arrow" (dark body, light rim, no eyes) |

The amber frame the owner first saw round the pill is the pill's own 3 s flash when it appears, not the window outline. On the first run (`c9a7959c`) the owner said the pill "went behind" other windows; that was not reproduced on `60a0c497`, where it stayed on top in all three checks.
In foreground work the outlines stay up next to the glow; the glow is what changes.

## 4. Background delivery probe (`probe-macos.mjs`)

| target | M0 AX setValue | M1 AXPress | M2 posted keys | M3 posted click | M4 AppleScript | M5 CDP |
|---|---|---|---|---|---|---|
| native Cocoa window | ok | ok | ok | no-effect | n/a | n/a |
| TextEdit (new instance) | ok | n/a | ok | n/a | ok | n/a |
| Chrome (temp profile, incognito) | ok | ok | ok | no-effect | n/a | text ok / click ok |

Side effects: **none** for every target and method: the front app never changed, the real cursor never moved, and the user's text never changed. Safari was skipped (it was already running with the owner's windows).
A posted mouse click (`CGEventPostToPid`) does nothing in a background window on macOS, so background clicks go by AXPress (R0) or CDP, and both work.

## 5. Attempt 1 (not counted)

It hit the script's 480 s hard timeout before agent B started, while the agent-A role was being settled. Two harness problems showed up there: the timeout path **left its temp Chrome running**, and agent B made an **unscoped `window list`, which returned the owner's real window titles**. Both are fixed (§8.3).

## 6. Two-agent re-run with the pill's Pause (`58dbe13b`)

| Step | Result |
|---|---|
| a) `set_value` ClawdField | ✓ lands |
| b) `compile_ui max_cost:"cheap"` → `el_1`, then `set_value` by ref | ✓ confirmed "via ref", no STALE_REF |
| c) `invoke` ClawdGo | ✓ |
| d) browser type + click | ✓ page `{"name":"Agent B","out":"CLICKED"}` |
| e) `pause_for_user` | ✗ "no on-screen prompt": the harness turned pauses off for the agent (`CLAWD_NO_PAUSE`). Harness fixed in `0f8d8d98`; ✓ in §7 |
| f) the owner clicked **Pause** on the pill, then agent B `set_value` | ✓ the call waited and the value landed **only after the owner clicked Resume** (31.5 s); final value "after resume" |

Focus steals: 0.

## 7. Combined background → foreground → pause run (`0f8d8d98`)

One script (ClawdTarget, the owner's TextEdit in front, a temp Chrome, a server with pauses allowed, and a window recorder every 0.5 s) tags every act with the overlays on screen at that moment. Run 2, exit 0, 187 snapshots, 1703 frontmost samples (run 1's pause row was a test bug: the drawers were named after the paused overlays had already exited; fixed by naming each at snapshot time).

```
[BACKGROUND] +0.0s  set_value ClawdField  → confirmed | outline 200,728 300x232 (ClawdTarget MATCH) | glow no | pill yes
[BACKGROUND] +6.9s  browser type #n       → confirmed | outline 22,52 1200x1096 (Chrome MATCH) + ClawdTarget | glow no
… 3 rounds × (set_value, invoke ClawdGo, browser type, browser click), all MATCH, glow no …
[FOREGROUND] +52.5s window focus ClawdTarget → ok        | both outlines | glow no
[FOREGROUND] +53.9s computer type            → confirmed | both outlines | glow yes, layer 25
[PAUSE]      +70.3s pause_for_user           → resumed, confirmedByUser | outline none | glow yes, layer 25 | pill yes
```

| Check | Result |
|---|---|
| Outline round ClawdTarget in background | PASS |
| Outline round Chrome in background | PASS |
| No glow in background | PASS |
| Glow in foreground | PASS |
| Glow and no outline in the pause | PASS |
| Focus steals during background work | PASS (0) |
| The user's typing intact (ClawdField ends "agent-round-3") | PASS |

## 8. Fixes found by the macOS runs

1. **The outline in background mode, on every OS** (`37994387`). A by-name act or page act on a process that is not in front never made it the window the outline goes round, so an agent that never touched the window in front got no frame. Now that process is the working window (`control.ts` `byProcess`), and a page act tells the pill and outline once its browser is known. Tests: `agent-windows.test.ts`.
2. **Element refs into a background window** (`37994387`). `compile_ui` refs failed with STALE_REF as soon as the user was in another app. A ref into a window that is not in front now acts by name in that process (focus not moved); an element with no unique name there is refused, since a click at its bounds would land on the user's window. Tests: `ui-map-ref-actions.test.ts`.
3. **Harness** (`37994387`, `8328273e`, `0f8d8d98`): ClawdTarget's field has an accessibility name; every exit path closes the temp Chrome; the bridge allows only listed actions (accessibility reads and acts by the test's own pids, `compile_ui` without OCR, the browser on the test page, `pause_for_user`) and refuses and logs anything else, such as `window list` or screenshots; the two-agent setups allow pauses.
4. **No outline at all on macOS** (`0f8d8d98`). macOS lists windows without a window number, so a window's handle is its process id; the outline drawer was told "the window numbered like the pid", found none, and drew nothing, in background and foreground mode alike. Such a handle now goes out as 0, the drawer's "this process's front window". Found independently by this session and the Mac session's agent; the Mac session tested this commit (§7). Test: `banner.test.ts` `outlineWindowNumber`.
5. **The three states** (`8328273e`, the owner's rule): background = outline; foreground = amber glow; the user's step = blue glow and never an outline (a framed sign-in page invites the user to take that window over).
6. **The user's turn** (`58dbe13b`, `7c97b7be`, the owner's rule): every real input waits for the user to be idle 1 s; if they take over, the agent goes on after 5 s if they are idle, else waits for Resume on the pill; the pill's Pause holds every act, background ones included. Live on macOS: §6 f. Tests: `user-turn.test.ts`.

## 9. Known limits and what is left

- **The idle reader** (`ax-helper idle`, which the user's-turn wait relies on on macOS): ✓ checked with the owner typing on the Mac's own keyboard. While typing: `idleMs` 123, then 51 a second later, with a new `lastAt` each time; after they stopped plus 3.5 s: 5213; read again straight after: the **same `lastAt`**, 0 ms apart. So the agent sees typing as busy, a pause as idle, and "no input since" exactly.
- The test script for §7 is `full-macos.mjs` + `overlay-recorder.swift` (README §3).
- On macOS a click by name comes back `[unverified]` even when it worked (the label did read CLICKED). It is a verification gap, not fixed here.
- Agent A was the owner by hand, not computer use. Safari was not probed.
