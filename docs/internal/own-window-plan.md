# Plan (h): the agent works in its own window — GO 2026-11-16

Owner 2026-11-16: "yes proceed, do all, and yes with the ghost cursor". D1 = (a): bursts are allowed when the user is
idle, counted and shown. D2 = yes. D3 = probe now, the rest after Plan (f) steps 1–3.

Owner, 2026-11-16: "the next phase of clawdcursor … still give clawdcursor's agent the capability of doing everything,
it just doesn't have to take full control of the PC and leave me doing nothing. The agent should be able to call me if
it needs something specific, or just control its own window."

Inspiration (private, never named in public docs): a commercial Windows tool gives each mouse its own cursor and lets
an AI agent own one app window inside the same Windows session, with input routed to that window. That settles the
question of whether this is possible on Windows. clawdcursor already has most of the pieces. This plan builds on
Plan (f) "background first, ask when stuck" in tasks/todo.md and does not replace it.

## The goal in one line

While a task runs, you keep your mouse, your keyboard and the window you are in. The agent works in the windows it
was given or opened, and taps you on the pause card only for a step only you can do.

Done looks like this, measured on the eval: **0 focus steals and 0 cursor moves during a task** in which the user
keeps typing in another window, with the same success rate as today.

## What already exists (origin/main 8b9af1d6)

| Piece | Where | Role here |
|---|---|---|
| Acting by name in the background with a processId, all 3 OSes | UIA patterns / AXPress, AXValue / AT-SPI actions; `control.ts` byName skips the foreground check | rung 0, already there |
| The window the agent works in (lease), the foreground-changed guard | `src/core/control.ts` | becomes "the agent's windows" |
| Bounded window messages | `scripts/ps-bridge.ps1` SendMessageTimeout (LBN_SELCHANGE, WM_SETTEXT via ValuePattern) | base for rung 1 on Windows |
| Focus save/restore | `scripts/mac/ax-helper.swift` restoreFocus | base for rung 2 on macOS |
| AT-SPI EditableText set/insert | `scripts/linux/atspi-bridge.py` | rung 0/1 typing on Linux |
| Pause card with choices, done_when, reply | `pause_for_user`, banner drawers ×3 | "call me" |
| Window outline overlay, pill with activity | `src/core/banner.ts`, drawers | shows which window is the agent's |
| Stop / pause gate, pointer guard | `control.ts`, `pointer-guard.ts` | every new path goes through it |
| Eval harness (tasks, state checks, session-log tallies), Linux VM | `eval/perception`, cc-linux | measurement |

## Probe results

### Windows, 2026-11-16 (Windows 11, eval/own-window/probe-windows.ps1, a "user" WinForms window in front)

| App | Text, no focus | Click, no focus | Notes |
|---|---|---|---|
| Win32 / WinForms | WM_CHAR ✓, WM_SETTEXT ✓, WM_KEY partial (no Shift) | BM_CLICK ✓, posted mouse ✗ | the managed UIA client sees cross-process WinForms controls as Panes (no Value/Invoke) |
| Notepad (Win11) | WM_CHAR ✓ (shifted ok), WM_SETTEXT ✓ to RichEditD2DPT | n/a | UIA SetValue works but **takes the foreground** |
| Calculator (UWP) | WM_CHAR ✓, WM_KEY ✓ to CoreWindow | posted mouse ✗, UIA Invoke ✗ (and took the foreground) | |
| Edge (Chromium) | WM_CHAR/KEY/SETTEXT ✗ | posted mouse ✓, UIA Invoke ✓ | UIA SetValue works but **takes the foreground**; CDP is the background route |
| VS Code (Electron) | ✗ all, including UIA SetValue | n/a | CDP (relaunch with a debug port) is the route |

No method moved the cursor or changed the user's text.

**Design consequences:**
1. **R0 is not guaranteed to stay in the background.** UIA SetValue and Invoke took the foreground in Notepad, Edge and Calculator. So every act must check the foreground afterwards and give it back. "Give it back" needs the foreground-lock workaround (a key event from our process, then SetForegroundWindow); without it the probe could not restore its own user window.
2. **On Windows, R1 means window messages:** WM_CHAR for text (works with shifted characters, unlike WM_KEYDOWN), WM_SETTEXT for whole edits, BM_CLICK for native buttons.
3. **Browsers and Electron ignore posted input.** Their background rung is the existing CDP path (Input.insertText / dispatchMouseEvent), not R1.
4. **To check:** the ps-bridge uses the same managed UIA client, so clawdcursor may not see WinForms controls of other apps at all.

## The design

### 1. The agent's windows

- **What counts:** a window the agent opened (open_app / launch), or one it was handed: the user names it in the
  task, or the agent names it by app or title. The lease grows from "one window" into a small set of agent windows.
- **Never touched:** the user's foreground window is never a target unless it is one of the agent's windows.
- **Shown on screen:** each agent window is marked by the existing outline overlay. Optional (D2): a drawn "ghost"
  cursor shows where the agent is acting. It is drawn by the overlay and never moves the real cursor.

### 2. One delivery ladder per action, in one place

This is the same ladder as Plan (f) step 4, with D3 promoted from a spike to rung 1.

- **R0, by name in the background (exists):** invoke / toggle / select / set_value / get_value by processId. No focus,
  no cursor.
- **R1, input addressed to the window (new):** keys, text and clicks delivered to the agent's window without
  focusing it. Per OS:
  - **Windows:** WM_CHAR / WM_KEYDOWN / WM_SETTEXT and WM_LBUTTON* posted to the target HWND or child control.
    SendMessageTimeout where a reply matters. Classic Win32, WinForms and WPF edit controls accept these. Chromium,
    UWP and DirectInput apps mostly ignore them.
  - **macOS:** CGEventPostToPid for keyboard events, which most Cocoa apps accept in the background. Background mouse
    clicks are unreliable, so clicks stay on R0 (AXPress) or go to R2. AX setValue / AXSelectedText for text.
  - **Linux X11:** AT-SPI EditableText insert for text (R0). XSendEvent through `xdotool --window` for keys; many
    GTK, Qt and Chromium apps drop synthetic events, so the probe decides per app.
  - **Linux Wayland:** no window-addressed input exists. R0 only, then R2/R3.
- **R2, a foreground burst (exists in pieces):** only when R0/R1 cannot do the step:
  - wait until the user has been idle about 1 s: GetLastInputInfo / CGEventSourceSecondsSinceLastEventType / XScreenSaver idle;
  - save the user's foreground window and cursor;
  - focus the agent's window, act in milliseconds, put both back;
  - if the user moves or types mid-burst, abort and yield. The user always wins.

  Each burst is counted and shown on the pill. D1 decides whether bursts happen without asking.
- **R3, call the user (exists):** `pause_for_user` with one step and done_when. Used when only the user can do it
  (sign-in, 2FA, a choice), or when R2 is not allowed and nothing else works.

The result says which rung did the step and whether focus moved: the route tally from Plan (f) step 1.

### 3. Safety, unchanged in kind

- Every rung goes through the same stop/pause gate and safety gate.
- Posted input is never sent to the user's foreground window. It is refused into password fields, matching the
  existing secure-field rule.
- An elevated (higher-integrity) window refuses posted input on Windows (UIPI). That is reported as such, with
  escalation to R2/R3, never silently retried.

### 4. Later, not in this train

- An isolated workspace for long jobs: a second session or virtual display, so the agent gets its own cursor and
  focus but works on a screen the user doesn't see.
- MPX multi-pointer on Linux X11.

Both are separate decisions after R0–R3 are measured.

## Build order (each step: a test that fails first; one PR per step; review before merge)

1. **Probe, measure only, no product change.** `eval/own-window/probe`: for a fixed app set per OS, try R1
   type/key/click on the app in the background, with another window in front, and check the effect from app state.
   - Windows: Notepad, WordPad, Explorer rename, Calculator (UWP), Settings, Edge, Chrome, VS Code.
   - macOS: TextEdit, Notes, Safari, Chrome.
   - Linux X11: Mousepad, gedit, Chrome.

   Output: an app × rung acceptance table. This resolves Plan (f) D3 with data, and it decides how big R1 is.
2. **Agent windows.** Extend the control.ts lease to a set (opened by or handed to the agent). Every act resolves its
   target from it, and the outline marks them. Builds on Plan (f) step 3 (target by app) when that lands.
3. **R1 on Windows, then macOS, then Linux X11.** One adapter method, `deliverToWindow(win, input)`, per OS, used only
   for apps the probe marked as accepting; app classes are learned per process. Reuse the ps-bridge SendMessageTimeout
   path, add CGEventPostToPid to the Swift helper, and use `xdotool --window` / AT-SPI on Linux.
4. **R2 burst.** Idle wait, save, act, restore, yield on user input. Built from the existing restoreFocus (macOS) and
   the Windows foreground calls, plus a user-input watch.
5. **One ladder in one place.** Replace today's scattered focus-then-type fallbacks (prefer-control.ts:106,
   select-option.ts:104, tools.ts:1532) with the ladder. Results name the rung.
6. **Guidance.** One paragraph, building on #447 and Plan (f) step 6: "say which app; you work in your own windows;
   the user keeps theirs; pause_for_user for what only they can do."
7. **Verify.** The eval gets a "user busy" variant: a fake user types in a window in front for the whole task.
   - Metrics: success, focus steals, cursor moves, bursts, time.
   - Before/after on the Linux VM (Claude Code + Codex) and a Windows run here.
   - ONE announced live run per OS on the release commit (Mac via the Mac session).

## OS expectations, honestly

| OS | Without taking your screen | Needs a burst or you |
|---|---|---|
| Windows | most apps: R0 + R1 (Win32/WinForms/WPF, Office text) | Chromium/Electron typing outside set_value, UWP, games, elevated windows |
| macOS | most Cocoa apps: R0 (AX) + R1 keys (CGEventPostToPid) | background clicks without an AX action, some Electron |
| Linux X11 | AT-SPI apps (GTK/Qt) via R0 | apps that drop synthetic events |
| Linux Wayland | R0 only | everything else |

So macOS mostly does work: AX actions and per-process keyboard events cover a lot. What it lacks is background mouse
clicks, which R0 replaces with AXPress for anything named.

## Decisions for the owner

- **D1:** R2 bursts. (a) allowed when the user is idle, counted and shown on the pill (recommended); (b) only after
  asking on the pause card; (c) never, so R3 instead.
- **D2:** show a ghost cursor for the agent? Recommended yes, drawn by the existing overlay.
- **D3:** train. Recommended: step 1 (probe) now, since it is measurement only; steps 2–7 as 2.4, after 2.2/2.3.
- **D4:** isolated workspace and MPX stay "later", decided after the probe.

## Coordination

This work is on branch feat/own-window (worktree clawdcursor-wt/own-window). Until merge it touches only new files
(eval/own-window, this plan) and does not touch the main agent's 2.2/2.3 branches. Steps 2–5 change control.ts and the
adapters, so they start only after Plan (f) steps 1–3 land, and rebase on them.
