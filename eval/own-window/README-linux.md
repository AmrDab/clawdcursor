# own-window probe: Linux X11

Step 1 of `notes/internal/own-window-plan.md`, Linux part. Measurement only; no product code changes.
Question: which apps accept input addressed to a **background** window while the user's window stays in front?

## Run it (on the Linux test VM only)

Prerequisites: Ubuntu 24.04 with Xvfb :99, openbox, D-Bus and AT-SPI running; `xdotool`, `mousepad`,
`google-chrome`, `python3-gi` (with `gir1.2-atspi-2.0`). `/tmp/session.env` must export `DISPLAY` and
`DBUS_SESSION_BUS_ADDRESS`; the script sources it itself when those are unset.

```
python3 eval/own-window/probe-linux.py --dry-run     # print the plan, launch nothing
python3 eval/own-window/probe-linux.py               # full run, about 1-2 minutes
python3 eval/own-window/probe-linux.py --targets gtk3 --methods M0,M2,M4
```

Options: `--targets mousepad,chrome,gtk3`, `--methods M0,...,C5`, `--timebox 20` (seconds of methods per target;
the wait for window and AT-SPI is separate, `--launch-timeout 15`), `--results-dir`.

What it does: launches a "user" Mousepad (`/tmp/probe-user.txt`, text `user-was-here`, `--disable-server` so it is a
separate process) and activates it. Then, one target at a time, it launches the target, sends `hello@1!` or a click
with each method, and reads the effect back. Only processes it launched are touched (process group, by pid); all are
killed in a `finally`. Temp files and `/tmp/probe-*.txt` are removed at the end. Do not run it on a desktop you are
using: it moves windows and, for M5 and the controls, the real pointer.

Output: `eval/own-window/results/linux-<timestamp>.jsonl` (one JSON object per target x method) and two markdown
tables on stdout.

## Methods

| id | what | rung |
|---|---|---|
| M0 | AT-SPI `EditableText.set_text_contents` | R0 |
| M1 | AT-SPI `EditableText.insert_text` at the caret | R0 |
| M2 | `xdotool type --window W` (XSendEvent) | R1 |
| M3 | `xdotool key --window W`, whole string in one call | R1 |
| M4 | AT-SPI `Action.do_action` (click / press) on the button | R0 |
| M5 | `xdotool mousemove --window W x y`, then `click --window W 1` | R1 |
| C2, C5 | **control**: `windowfocus --sync W`, then plain type / click (XTEST) | R2-like |

Targets: a second Mousepad window (text only, no button, so M4/M5/C5 are n/a), Chrome on a temp page with
`<input id=t>` and a button that sets `document.title="CLICKED"`, and a GTK3 app (Entry + button) as the toolkit
baseline. Between rows the target is reset (text emptied, title un-CLICKED through a "reset" button) and the user
window is re-activated and the pointer parked at (8,8).

## Reading the tables

Outcome table, one cell per target x method:

- `ok`: the exact text (`hello@1!`) is in the field, or the window title is `CLICKED`.
- `partial`: some other non-empty text arrived (dropped or altered characters, e.g. `@` or `!` lost).
- `no-effect`: the call ran but the field is still empty / the title unchanged. This is the "app dropped the
  synthetic event" result.
- `error`: the method or its readback could not run (element not found, exception, reset failed, timebox). The
  `detail` field in the JSONL says why.
- `n/a`: the target has no such element, or the method does not exist on this session type.

Side-effect table: `A` the active window changed (`xdotool getactivewindow`), `P` the real pointer moved
(`getmouselocation`), `U` the user window's text changed, `none` for no side effect. A trailing `?` means the value
could not be measured. **An `ok` only counts as background delivery when the side-effect cell is `none`.** M5 will
always show `P`, because `mousemove` moves the real pointer; that is the honest cost of this method. C2/C5 are
expected to show `A`: they are the price of taking focus, for comparison.

How to use the result: an app counts as accepting R1 when M2/M3 (text) or M5 (click) is `ok` with `none`. If
only M0/M1/M4 are `ok`, the app is R0-only and R1 is not worth building for it.

## Wayland

Wayland has no window-addressed input, so M2, M3, M5 and the controls do not exist there. On a Wayland session
the script marks them `n/a`, skips xdotool and reports only M0, M1, M4 (AT-SPI), with the side-effect fields
unmeasured. Treat that mode as best effort; the plan's conclusion for Wayland is "R0 only, then R2/R3".

## Known limits

- Window-relative click coordinates for M5 are the AT-SPI screen position of the button minus the xdotool window
  origin; a window manager that reports a decoration offset could shift the click. The `detail` field holds the
  coordinates used, so a surprising `no-effect` on M5 can be checked by hand.
- Chrome has to expose its tree to AT-SPI (`--force-renderer-accessibility` is passed); the text element is taken
  from the web document, not the omnibox.
- Mousepad is started with `--disable-server` so each window is its own process; otherwise the second window would
  belong to the first process and pid matching would fail.
