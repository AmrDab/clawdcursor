# own-window probe (Windows)

Step 1 of `notes/internal/own-window-plan.md`. Measurement only; no product code changes.

## What it measures

While a fake "user" window (`ClawdUser`, a WinForms form holding `user-was-here`) stays in front, which apps
accept input addressed to a BACKGROUND window? The answer sizes rung R1 ("input addressed to the agent's window").

Targets (each skipped with a reason if missing): a WinForms form `ClawdTarget` (Win32 baseline), Notepad,
Calculator (UWP), Edge (InPrivate, temp page), VS Code (throwaway profile, only if `code` is on PATH).

Methods:

| id | method | rung |
|---|---|---|
| M0 | UIA `ValuePattern.SetValue` on the edit element | R0 baseline, text |
| M1 | `PostMessage WM_CHAR` per character to the owning HWND | R1 |
| M2 | `SendMessageTimeout WM_SETTEXT` (SMTO_ABORTIFHUNG, 1500 ms), same HWND | R1 |
| M3 | `PostMessage WM_KEYDOWN/WM_KEYUP` using `VkKeyScan` | R1 |
| M4 | posted `WM_LBUTTONDOWN/UP` at the button's client coordinates | R1 click |
| M5 | UIA `InvokePattern.Invoke` on the same button | R0 baseline, click |

Text is `hello@1!` (the `@` and `!` need Shift). Calculator types `123` instead. HWND used: the edit's
`NativeWindowHandle` (nearest ancestor with a handle if 0); `Chrome_RenderWidgetHostHWND` for Edge/VS Code;
the `Windows.UI.Core.CoreWindow` child for Calculator. The class used is recorded.

For every method the script records: did the effect land (read back through UI Automation, 400 ms after), did the
foreground window change, did the cursor move, did the `ClawdUser` text change.

## Run

```powershell
# plan only: lists what it would open and what is installed, opens nothing
powershell -NoProfile -ExecutionPolicy Bypass -File eval\own-window\probe-windows.ps1 -DryRun

# the real run (interactive desktop; do not touch mouse or keyboard for about 1-2 minutes)
powershell -NoProfile -ExecutionPolicy Bypass -File eval\own-window\probe-windows.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File eval\own-window\probe-windows.ps1 -Targets winforms,notepad
```

Output: `eval\own-window\results\windows-<timestamp>.jsonl` (do not commit it) and a markdown table on stdout.
The JSONL has one `type:"method"` line per target x method and one `type:"target"` summary per target.

## Read the table

Row = target, columns M0..M5. Cell values:

- `ok`: the exact expected text appeared (or the click effect was seen).
- `no-effect`: nothing changed in the target.
- `partial`: something changed but not as expected. Expected for M3 on `@` and `!`: a post cannot hold Shift, so you get `2` and `1`.
- `error`: the call threw, the element was missing, or it could not be read back (the `detail` field says why).
- `n/a`: method does not apply (for example no button in Notepad).

The last columns say whether any method changed the foreground, moved the cursor, or changed the user text, and
which methods did. The class column is the HWND class the posts went to. The R1 answer per app: a method that is
`ok` with `no` in all three flag columns is usable in the background; M0/M5 `ok` means R0 already covers it.

## Safety

- Sends only to windows this script opened (root HWND or exclusive PID check); refuses the user form. It only reads the user form.
- Everything it opens is closed in `finally` (WM_CLOSE, then kill of processes it alone started). Edge's process is shared with your browser, so only the InPrivate window is closed, never the process.
- Calculator is skipped if already running. Notepad is skipped if it opens with restored text.
- Each target's methods are time-boxed to 20 s (launch has its own wait limits, up to 20 s for VS Code).

## Known limits

- Never run by the author of the script: unverified on a live desktop. Parse and C# compile checks only.
- Windows foreground lock: `SetForegroundWindow` is setup only and uses the AttachThreadInput trick; if it fails the run aborts.
- Posting cannot hold Shift, so M3 shifted characters are lost by design.
- Chromium: a11y tree may appear late; page text is focused with `autofocus` but the OS window is not active, so results can differ for a real page.
- VS Code: the editor is often not exposed to UIA (accessibility off), so read-back may fail with `error`. `--force-renderer-accessibility` is passed but unverified.
- Calculator, Notepad: window detection relies on class names (`ApplicationFrameWindow`, `Notepad`); Notepad restoring a session or opening as a tab makes it skip.
- DPI: the script is DPI aware; target forms are not. Click coordinates are exact at 100% scale and may be off on scaled displays for unaware targets.
- Elevated targets (UIPI) are not tested. WordPad, Explorer rename, Settings and Chrome from the plan are not covered yet.
- Not covered: macOS and Linux (separate probes).

## Live run through the real agent path (Windows): `live-windows.mjs`

Plan (h) step 7, one run. Unlike the probe above (window messages sent directly), this calls the built MCP server over
stdio, the way an agent does, and measures what the user would see: focus steals and cursor moves.

```
npm run build
node eval/own-window/live-windows.mjs --dry-run    # prints the plan and checks; starts and sends nothing
node eval/own-window/live-windows.mjs              # the live run, about 40 s; hands off keyboard and mouse
```

`--no-banner` starts the server without the on-screen banner, outline and ghost cursor (to compare).

- Starts: the server (`dist/surface/cli.js mcp --compact`, a temp `HOME`/`USERPROFILE`, telemetry off, so your settings are untouched), a fake user window `ClawdUser` (kept in front), a new Notepad, a WinForms `ClawdTarget` (two TextBoxes named `ClawdField` / `ClawdNote`, a Button `ClawdGo`, a status label), and a 50 ms sampler of the foreground window and the real cursor.
- Four tool calls (plus the browser steps below), each addressed by `processId` to a process it started: (a) `set_value` on Notepad's `Text editor`; (b) `set_value` on `ClawdField`; (c) `invoke` on `ClawdGo`; (d) `set_value` with shifted characters on `ClawdNote`. (b) and (d) are the text paths that reach the ladder (`typeIntoField`, rung R1 `setText`); (c) reaches it through `clickBoundsFallback` when UIA gives no invoke pattern. `smart_type` does not use the ladder.
- Effect is read from the apps (WM_GETTEXT on the edits and the label), and the `ClawdUser` text must be unchanged.
- Before each step `ClawdUser` is put back in front and the script waits 1.5 s, so an R2 burst is allowed (it needs about 1 s of idle).
- Output: a table (step, success, rung note, effect verified, focus steals with durations, cursor moved) and `results/live-windows-<time>.jsonl` (meta, one line per step, all samples). Steals are samples whose foreground was not `ClawdUser`; "cursor moved" is any sample differing from the cursor position before the server started.
- Safety: never addresses a pid it did not start, never touches the user form; Notepad is skipped if it would reuse one of your processes or opens with text; everything is closed in `finally`; hard timeout 120 s.
- An R2 burst is a deliberate focus steal and will show as one; a R0 act that takes the foreground and is given back shows as a short steal. The goal line in the plan is 0 steals and 0 cursor moves.
- Browser steps (f)-(h): before the sampler starts, it opens Microsoft Edge as its own instance (`--inprivate --new-window --remote-debugging-port=<free port> --user-data-dir=<new dir in the temp home> --no-first-run`, a local page with a field `Your name` and a button `Send`; never your Edge). The server gets `CLAWD_AGENT_CDP_PORT=<that port>`, so `browser {"action":"connect"}` attaches to it as clawdcursor's own browser. Then `accessibility set_value` / `invoke` with `processId` = that Edge's browser pid are page acts (route note "CDP page act, focus not moved"); the script reads the field and the button's effect back over CDP itself. The Edge pids count as agent windows in the steal analysis. Cleanup kills that Edge by its pid tree (found from its debug port) and deletes its profile with the temp home. The hard timeout is 120 s (170 s with `--with-you`).

## macOS

Plan (h) step 1 for macOS, plus the `--external` two-agent run. Written on Windows, never run on a Mac: expect to fix small things.
Files: `probe-macos.mjs`, `live-macos.mjs`, `full-macos.mjs`, `macos-common.mjs` (shared), `macos-helper.swift` and `overlay-recorder.swift` (compiled with `swiftc` into a temp dir at each run).

Needs: macOS with Xcode command line tools (`xcode-select --install`), node 22+, TextEdit, Google Chrome (skipped if missing), Safari (skipped if already running).
Permissions for the terminal app that runs the commands (System Settings > Privacy & Security): **Accessibility** (required: AX reads/writes and posted events),
**Screen Recording** (not used by the probe; needed for the computer-use agent and clawdcursor in the live run), and **Automation** (allow the terminal to control
System Events, TextEdit and Safari when macOS asks, for the AppleScript method). Restart the terminal after granting.

### 1. The probe (M0..M5 per app, background delivery)

```
cd <the clawdcursor checkout on feat/own-window>
node eval/own-window/probe-macos.mjs --dry-run                 # plan and checks, launches nothing
node eval/own-window/probe-macos.mjs                           # the run, about 2 minutes; hands off keyboard and mouse
node eval/own-window/probe-macos.mjs --targets native,textedit # a subset (native, textedit, chrome, safari)
```

A "user" window `ClawdUser` (our own Cocoa window holding `user-was-here`) is put in front before each method. Targets, all started by the script and closed at the end:
our own Cocoa window (baseline: field + buttons), a new TextEdit instance on a temp file (never your TextEdit windows), Chrome with a temp `--user-data-dir`, incognito, own
debug port (never your Chrome), Safari as a new private window on the same local page (only if Safari is not already running; Notes is not probed). Methods:

| id | method | rung |
|---|---|---|
| M0 | AX `setValue` (AXValue) on the text element | R0, text |
| M1 | `AXPress` on the button | R0, click |
| M2 | `CGEventPostToPid` keyboard, one unicode event per char (`hello@1!`, so shifted chars) | R1 text |
| M3 | `CGEventPostToPid` left click at the button's AX centre | R1 click |
| M4 | AppleScript `tell application ... to set ...` (TextEdit `set text of document`, Safari `do JavaScript`) | text |
| M5 | Chrome DevTools Protocol: `Input.insertText`, `Input.dispatchMouseEvent` (`t:` / `c:` in the table) | R1 for browsers |

Output: `eval/own-window/results/macos-<time>.jsonl` (do not commit; one `method` line per target x method with outcome, `foregroundChanged`/`foregroundTo`, `cursorMoved`,
`userTextChanged`; one `target` line each) and two tables on stdout: outcomes (`ok`, `no-effect`, `partial`, `error`, `n/a`, as for Windows) and side effects
(`F` frontmost app changed, `C` real cursor moved, `U` user text changed, `none`). An `ok` counts as background delivery only with `none`.

Caveats: Safari reads back through Accessibility only (page eval needs "Allow JavaScript from Apple Events"), so its M0 is read through the route it used. AppleScript
addresses `application "TextEdit"` by name, so with your own TextEdit running it may reach the wrong instance (it names a unique document, so the worst case is an error).
The `File > New Private Window` step needs English menus. The frontmost app is read with NSWorkspace every 50 ms; bringing `ClawdUser` back uses `activate`, then System Events.

### 2. The two-agent live run (`--external`)

Agent A is computer use typing in the user app; agent B is a subagent driving clawdcursor through the bridge.

```
npm run build
node eval/own-window/live-macos.mjs --dry-run
node eval/own-window/live-macos.mjs --external /tmp/cc-ext         # terminal 1: sets up, writes /tmp/cc-ext/setup.json, waits
node eval/own-window/agent-bridge.mjs /tmp/cc-ext                  # terminal 2: writes /tmp/cc-ext/bridge-ready (the token), serves 127.0.0.1:8766
```

Then: agent A (computer use; grant it TextEdit) types in the TextEdit window `user.txt` (the user app). Agent B reads `setup.json` (`target.pid`, `chrome.pid`, `chrome.port`),
calls tools over HTTP (`POST /call`, header `X-Bridge-Token` = contents of `bridge-ready`) addressed by `processId` to the ClawdTarget window (`ClawdField` text area, `ClawdGo`,
`ClawdReset`) and to Chrome's page (`browser connect`, then field `Your name`, button `Send`). When B starts, write the time to the start file: `node -e "require('fs').writeFileSync('/tmp/cc-ext/start', String(Date.now()))"`;
when both are finished, `POST /done` to the bridge and `touch /tmp/cc-ext/done`. The script then prints the focus steals (an agent window frontmost), cursor moves (agent A's own
moves count), the agent effects and the text agent A typed, and writes `results/live-macos-<time>.jsonl` (meta, the step, all samples).
Every exit (done, an error, the 480 s hard timeout, Ctrl+C / SIGTERM) runs the same cleanup: ClawdTarget, the user TextEdit and the temp Chrome (by its pid) are
closed and the temp home with Chrome's profile is deleted.

The bridge (both OSes; `live-windows.mjs --external` writes the same `setup.json` with `edge` for `chrome`) keeps agent B in the test's scope, always:
allowlists of actions (`bridge-scope.mjs`), so anything not named is refused. `accessibility`: `read_tree`, `find`, `get_element`, `get_value`, `state`,
`list_children`, `compile_ui` (only with `max_cost:"cheap"`: its OCR would read the user's window when the agent's is covered), `invoke`, `set_value`, each
with a `processId` that is `target.pid` or the browser's pid (`chrome.pid` / `edge.pid`; never `user.pid`). Refused there: `focused`, `find_button` /
`find_field` (they read the window in front whatever `processId` says), `focus`, `smart_*`. `browser`: `connect` (no host, URL or launch; a `port` only the
test browser's), `page_context`, `read_text`, `click`, `type`, `select_option`, `wait_for`, `scroll`; no `navigate`, `evaluate` or tabs. `system`:
`pause_for_user` only (the indicator's blue-glow state; it reads nothing). Anything else
(`window`, `system`, `computer` including screenshots, `batch`, ...) is answered HTTP 403 `out of scope for this test: <tool> <action> (...)` without
reaching the server. Each call is one line in
`<dir>/calls.jsonl`: `t`, `tool`, `action`, `image` (the result carried a screenshot), `route`, `error`, plus `blocked: true` for a refused call.
`route` is the route note in the reply, `(R1 ...)` or `(CDP page act ...)`; `null` means the reply had no route note (an R0 act by name, or a `browser`
call), not a failure.

### 3. The indicator's three states, one run (`full-macos.mjs`)

The owner sits at the Mac; spoken cues say when to type and when to keep hands off. BACKGROUND: the owner types in a TextEdit window while the
script's own MCP client acts by `processId` on ClawdTarget and its Chrome page (3 rounds); expected: a frame round the agent's window, no glow, no focus
steal, the owner's typing intact. FOREGROUND: `window focus` + `computer type`; expected: the amber glow. PAUSE: `pause_for_user`; expected: the blue
glow and the card, no frame; the owner clicks Resume. `overlay-recorder.swift` records the overlay windows (and the test's own windows, never the
owner's) twice a second; each act is printed tagged with what was on screen, then a PASS/FAIL table. Every exit closes what it started (330 s hard timeout).

```
npm run build
node eval/own-window/full-macos.mjs --dry-run
node eval/own-window/full-macos.mjs
```

### Windows: the same three states and the user's turn, one run (`full-windows.mjs`)

The owner sits at the PC; spoken cues say when to type, when to keep hands off, and when to click Pause and Resume on the
pill; two Yes/No questions come on clawdcursor's own pause card. BACKGROUND (the owner types in ClawdUser; the agent acts
by `processId` on ClawdTarget and on its own Edge page), FOREGROUND (`window focus` + `computer type`: the amber glow),
PAUSE (a question card: the blue glow, no frame), YOUR TURN (the owner keeps typing while the agent wants the keyboard:
it waits, holds, and goes on after their Resume), PILL PAUSE (a background act waits for Resume). `overlay-recorder.ps1`
records only the test server's overlay windows and the agent's windows. A PASS/FAIL table at the end; results in
`results/full-windows-<time>.json`. Every exit closes what it started (480 s hard timeout).

```
npm run build
node eval/own-window/full-windows.mjs --dry-run
node eval/own-window/full-windows.mjs
```

### Send back

The `results/macos-*.jsonl` and `results/live-macos-*.jsonl` files and the printed tables (outcomes, side effects, the live summary), plus any `FAILED:` / `skip` / `note:` lines.

## Canvas probe (Windows): `probe-canvas-windows.ps1`

Plan (h), canvas/viewport apps. Question: does a background canvas accept a properly formed posted mouse click and drag (no focus steal, no cursor move), or does it need a burst?
Measurement only: posted/sent window messages, no injection, no hooking, no DLL in any process. Windows PowerShell 5.1.

```
powershell -NoProfile -ExecutionPolicy Bypass -File eval\own-window\probe-canvas-windows.ps1 -DryRun    # plan only, launches and compiles nothing
powershell -NoProfile -ExecutionPolicy Bypass -File eval\own-window\probe-canvas-windows.ps1            # the run, about 1 minute; hands off keyboard and mouse
powershell -NoProfile -ExecutionPolicy Bypass -File eval\own-window\probe-canvas-windows.ps1 -Targets canvas
```

- Targets: `canvas` (our own WinForms `Panel` in `ClawdCanvas`, compiled from C# by the .NET `csc.exe` into a temp dir; it logs every WM_MOUSEACTIVATE / SETCURSOR / MOUSEMOVE / LBUTTONDOWN / LBUTTONUP it receives and draws on them: the cooperative control), `mspaint` (a new Paint window), `nx` (Siemens NX: only noted if `ugraf.exe` runs, never driven; TODO: drive it with an empty part of our own).
- The deepest child HWND under the target point is resolved with `RealChildWindowFromPoint` (then `ChildWindowFromPointEx`) in a loop; lParam is in that HWND's client coordinates.
- Click: `WM_MOUSEACTIVATE`, `WM_SETCURSOR`, `WM_MOUSEMOVE`, `WM_LBUTTONDOWN` (`MK_LBUTTON`), `WM_LBUTTONUP`. Drag: the same prelude, `WM_LBUTTONDOWN`, 12 `WM_MOUSEMOVE` with `MK_LBUTTON` along a zigzag, `WM_LBUTTONUP`. Each is done with `PostMessage` (`post`) and with `SendMessageTimeout` (`send`, SMTO_ABORTIFHUNG, 1500 ms).
- Effect: `PrintWindow` (PW_RENDERFULLCONTENT) of the target's top-level window before and after; the pixels changed in the canvas region (beyond the noise between two "before" shots) mean `yes`. Paint's region is the largest UIA element named canvas, else a guess (noted in the output; tune if `effect` is `no`). `received` is exact for our canvas (its log) and only inferred from the effect for Paint.
- Foreground stolen / cursor moved: the foreground HWND and the real cursor are sampled every 50 ms while the row runs; `ClawdUser` is put back in front before each row.
- Sends only to windows it started; refuses the user form; closes everything in `finally` (a Paint process it did not start alone is closed by WM_CLOSE only).
- Output: `results\canvas-windows-<time>.jsonl` (do not commit) and a table `app | op | mode | received | effect | foreground stolen | cursor moved`.
- Never run live by its author: the dry run, the PowerShell parse, and the C# compile of the canvas and the helper class were checked.
