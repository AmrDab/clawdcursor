# own-window probe (Windows)

Step 1 of `docs/internal/own-window-plan.md`. Measurement only; no product code changes.

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
