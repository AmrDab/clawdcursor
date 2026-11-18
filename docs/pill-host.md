# Drawing the pill in your own app

While an agent drives the desktop, clawdcursor shows two things: the **pill** (what the agent is doing, a Stop
button, and the "Waiting for you" card when the agent pauses) and the **outline** around the agent's window.

An app that hosts clawdcursor (it starts `clawdcursor mcp` for its own agent) can draw the pill itself, in its own
window and style. The outline stays clawdcursor's. This is opt-in: with neither variable below set, nothing changes.

## The two variables

Set both in the environment of the clawdcursor process.

| Variable | Value | Effect |
| --- | --- | --- |
| `CLAWD_PILL_CMD` | A JSON array of strings: the command and its arguments, e.g. `["C:\\node.exe","C:\\app\\pill-host.mjs"]` | clawdcursor starts this command wherever it would start its own pill (Windows, macOS, Linux). |
| `CLAWD_OWN_UI_PIDS` | Process ids, comma-separated, e.g. `4242,4250` | Windows of these processes are clawdcursor's own on-screen controls: the agent cannot read, click, type into or focus them. Entries that are not a positive whole number are ignored. |
| `CLAWD_OWN_UI_PIDS_FILE` | The path of a file that holds more process ids, in the same form | Optional. The environment is read once, when clawdcursor starts; this file is read again while it runs (at most once a second), so the host can rewrite it when its processes change. A web view draws in helper processes that come and go (WebView2's `msedgewebview2.exe`): name them here. While the file cannot be read, the last list read stays. |

The command clawdcursor starts is usually a small relay that talks to your app, and the pill is a window of your
app's process, not of the relay. So name your app's process (every process that owns a pill window) in
`CLAWD_OWN_UI_PIDS`. The relay's own pid is protected without being named. Other clawdcursor processes on the machine
learn these pids from the first time this process shows its overlay.

An element is refused by the process it belongs to and by the process of the window it is in. A read or an act by
element that names no process goes to the window in front: when that is a window of one of these processes (the user
just clicked the host app), it is refused too, so "press Yes" can never land on the host's own button.

A click, drag or scroll at coordinates is refused when the window at that point is a window of one of these processes,
whichever window is in front (both ends of a drag; where the pointer is, for a press with no coordinates). Windows
only for now: on macOS and Linux the window at a point is not read, so only the window in front is checked there.

`CLAWD_NO_BANNER=1` and `--no-banner` still turn the pill and the outline off, hosted or not.

### When the command fails

clawdcursor draws its built-in pill instead, for the rest of that process, and logs one warning
(`banner.host_pill_failed`), when:

- `CLAWD_PILL_CMD` is not a JSON array of at least one string (the first not blank);
- the command cannot be started;
- the command exits less than 2 seconds after it started without having written a line to stdout.

A command that stays up, or that answers and then exits, is never treated as failed.

## The process

- **One process per form.** clawdcursor starts the command when the pill should appear and kills it when the pill
  should go (`SIGTERM`; on Windows the process is terminated with no warning). When the agent pauses, the running
  pill is killed and the command is started again in its paused form. After the answer, that one is killed and a
  running one is started.
- **Arguments.** Your own arguments, then the pill's: nothing for the running form, `--paused` for the paused form.
  That is all `--paused` means; the card's content is in the environment.
- **stdin** carries commands from clawdcursor, **stdout** carries your answers, stderr is discarded. Lines are UTF-8
  and end with `\n`.
- **Exit when stdin closes.** That means clawdcursor is gone, and no pill may stay on screen after it. Take the pill
  down too when the command is killed: your app should treat the relay's disconnect as "hide".
- The pill must never take the keyboard or the foreground by itself, only when the user clicks into its text box.

## Environment

The command gets clawdcursor's whole environment, plus:

| Variable | Form | Value |
| --- | --- | --- |
| `CLAWD_BANNER_ACTIVITY` | running | What the agent is doing when the pill appears, e.g. `Typing in Edge`. Empty: show a neutral word such as "Working". |
| `CLAWD_BANNER_APP` | paused | The app the agent was working in, e.g. `Edge`, for the card's title. May be empty. |
| `CLAWD_BANNER_MODE` | paused | `paused`. |
| `CLAWD_BANNER_MESSAGE` | paused | The instruction to show: `The agent says: ` followed by the agent's message (one line, at most 300 characters). Show it as it is: the prefix tells the user the text was written by the agent. |
| `CLAWD_BANNER_CHOICES` | paused | Empty, or a JSON array of 2 to 6 strings (each at most 40 characters): one button per option. |
| `CLAWD_BANNER_INPUT` | paused | Empty, or a JSON object `{"placeholder"?: string, "multiline"?: true}`: show a text box on the card. |
| `CLAWD_PAUSE_SOUND` | paused | `1`: play a short sound when the card appears. `0`: stay silent. |

`CLAWD_BANNER_ACTIVITY` and `CLAWD_BANNER_APP` are always set (possibly empty). The others are set only in the
paused form.

## Commands on stdin

| Line | Meaning |
| --- | --- |
| `ACTIVITY <text>` | Running form only. Replace the activity text. `<text>` is one line, at most 60 characters, sent raw (no escaping). |
| `HIDE <ms>` | Hide the pill now and show it again by itself after `<ms>` milliseconds (a whole number; the built-in pill keeps it between 50 and 10000). A later `HIDE` restarts the wait. clawdcursor sends it just before the agent clicks, drags or scrolls, and waits 90 ms for the pill to be gone, so hide at once. Sent in both forms. |
| `ORB working` / `ORB paused` | Running form only. The state of the pill's animated mark: `paused` while it is the user's turn (a hold or a takeover: stop it, in a muted colour), `working` after. The built-in pill's orb also has a `listening` state, which the paused card shows by itself while it waits for the user. |
| `HELD ON` / `HELD OFF` | Running form only. The user holds the agent (your Pause, or they kept working after taking over): show a Resume button in place of Pause; `HELD OFF`, Pause again. clawdcursor sends the label too (`ACTIVITY Paused`), and keeps the pill up while held. |

There are no other commands. In particular there is no "choices" or "input" command, and the user's hold above is not
a pause for the user: that paused form is a new process with `--paused` and the environment above. Ignore lines you do not know.

## Answers on stdout

Each answer is one line. clawdcursor trims it and matches it exactly.

| Line | When | Meaning |
| --- | --- | --- |
| `BANNER_STOP` | either form | The user pressed Stop (the built-in pill also takes a double-click anywhere on the running pill). clawdcursor stops all agent control. |
| `BANNER_PAUSE` | running | The user pressed Pause: every act of the agent's waits, background ones included, until `BANNER_RESUME`. clawdcursor answers `HELD ON`. Keep the pill up: this is not an answer that ends it. |
| `BANNER_RESUME` | paused, or running while held | The user pressed Resume: the agent continues. From the running pill it ends the user's hold (clawdcursor answers `HELD OFF`). |
| `BANNER_END` | paused | The user pressed End task. |
| `BANNER_CHOICE <index>` | paused, with choices | The user picked an option. `<index>` is the 0-based position in `CLAWD_BANNER_CHOICES`, in decimal, one or two digits. Send only the index, never the text. |
| `BANNER_REPLY <base64>` | paused | The user typed an answer ("Something else", or the text box of `CLAWD_BANNER_INPUT`). `<base64>` is the standard base64 (alphabet `A-Z a-z 0-9 + /`, `=` padding, no line breaks) of the UTF-8 text. Newlines inside the text are allowed. clawdcursor trims the text, ignores an empty one, and keeps at most 2000 characters. |
| `BANNER_REFOCUS` or `BANNER_REFOCUS <pid>` | paused | The user left the text box without answering (Esc): clawdcursor gives the keyboard back to the window of process `<pid>` (decimal), or with no pid to the window that was in front when the pause began. Not an answer: the pause stays up. |

Rules:

- The first of `BANNER_RESUME`, `BANNER_END`, `BANNER_CHOICE` or `BANNER_REPLY` settles the pause. clawdcursor then
  kills the paused pill. The built-in pill hides and exits right after writing its answer; yours may do the same.
- Answers other than `BANNER_STOP`, `BANNER_PAUSE` and the running pill's `BANNER_RESUME` count only from the pill that
  was started for the pause now on screen.
- A `BANNER_CHOICE` whose index is not in the list, and any other line, is ignored.
- Flush stdout after each line.

## Example

A running pill, then a pause with two options:

```
spawn:  node pill-host.mjs                       CLAWD_BANNER_ACTIVITY=""
stdin:  ACTIVITY Typing in Edge
stdin:  HIDE 1500
stdin:  ACTIVITY Clicking in Edge
(killed)
spawn:  node pill-host.mjs --paused              CLAWD_BANNER_MODE=paused
                                                 CLAWD_BANNER_APP=Edge
                                                 CLAWD_BANNER_MESSAGE="The agent says: Send this email?"
                                                 CLAWD_BANNER_CHOICES=["Send","Don't send"]
stdout: BANNER_CHOICE 0
(killed)
spawn:  node pill-host.mjs                       CLAWD_BANNER_ACTIVITY=""
```

The code is `src/core/banner.ts`; the built-in pills that speak the same lines are `scripts/banner.ps1` (Windows),
`scripts/mac/overlay.swift` (macOS) and `scripts/linux/overlay.py` (Linux).
