# The clawdcursor benchmark

One automatic benchmark replaces app-by-app testing (issue #384). Every fix names a general mechanism (M1 to M5, issues
#385 to #389) and must pass the whole benchmark, on each OS, with several models. A release ships only when it is green.

It is not part of the npm package (`bench/` is not in `package.json` "files").

## What it measures

Each task is run by an agent through the six clawdcursor tools, against a fixture the benchmark controls. Nothing is
judged by a model:

- **success** is a predicate on the fixture's own state: what the web page posted to the fixture server, the JSON file
  the native fixture writes, or a read-only probe of a real app;
- **calls, screenshots, by-name and by-coordinates share** come from the isolated server's session log, which classes
  every call (blind / vision / act-name / act-coords / act-other). All of them count the same way: a batch by its
  steps, any other call as one. "Trips" in the report are top-level calls (a batch is one); they are not gated;
- **false successes**: an action the server reported ok during which the fixture recorded nothing, plus an agent that
  ended with `BENCH_RESULT: DONE` while the fixture state says otherwise;
- **loops**: the same call (tool and arguments) three times in a row;
- **time**, and **screenshots / oracle**.

The oracle of a task is the cost of a scripted trajectory: one read, then one call per action, no batch. A batch saves
round trips, not calls: its steps are counted.

A web run in which the page was loaded more than once fails: a reload resets the page's counters. The fixture server
keeps every event of every load.

With `--repeats N` each task runs N times per model. Its row takes the (upper) median of calls, screenshots and time,
and is done when most runs were done; false successes and loops take the worst run, so one of them in any run fails
the row. A privacy stop or a reload in any run stays.

### The gate

Per task and model, for every task that has a predicate:

| Threshold | |
|---|---|
| done | the predicate holds on the fixture state (100% of tasks) |
| screenshots | at most oracle + 1 |
| calls | at most 1.5 x oracle (rounded up) |
| false successes | 0 |
| loops | 0 |
| privacy | the watchdog never had to stop the agent for acting outside the fixture |

Manual-verify tasks (Designcenter) give metrics only. `npm run bench -- --live` exits 0 only when every gated row passes.

## Running it

```
npm run bench                         # the plan: tasks for this OS, agents found. Starts nothing.
npm run bench -- --selfcheck --build .  # proves fixtures, predicates, isolation and the fence. No agent, no window.
npm run build
npm run bench -- --live --build .     # runs the tasks
```

Before a live run:

- turn on Do Not Disturb / Focus Assist, because toasts and always-on-top windows inside the fixture rect would be
  captured;
- close a browser that listens on debug port 9223 (the run refuses to start otherwise);
- close Calculator if it is open (its task is skipped otherwise), and keep other Store apps closed;
- have the primary monitor free: fixture windows open there.

**A live run takes over the mouse and keyboard until it ends.** Do not use the computer meanwhile, and close a browser
that listens on debug port 9223 first (the run refuses to start otherwise).

Options of a live run:

| Option | |
|---|---|
| `--build <dir>` | the clawdcursor under test: `<dir>/dist/surface/cli.js`. Without it, the global install. |
| `--models a:b,c:d` | e.g. `claude-code:sonnet,claude-code:haiku,codex:default,ollama:qwen2.5:7b`. Default: every installed agent with its default models. |
| `--tasks id,id` | only these tasks |
| `--claude-bin <file>`, `--codex-bin <file>` | the native binary to use (`claude.exe`, `codex.exe`) when it is not on PATH. An npm `.cmd` launcher is not accepted: nothing is run through a shell. |
| `--include-manual` | also the manual-verify tasks (open Designcenter with a part loaded first) |
| `--out <dir>` | results directory: new or empty (default: a new folder under the temp directory). A directory that holds anything is refused, so an earlier run's logs cannot be read back. |
| `--repeats N` | run each task N times per model (1 to 9, default 1) |
| `--update-baseline` | write `bench/baseline/<os>.json` from this run |
| `--baseline <file>` | compare with another baseline |

Results: `report.md` (a table per model, the skipped tasks, the comparison with the baseline), `report.json`, and per
task the session log, the fixture state, the agent's log and the server's log.

### Agents

Only what is installed is used.

- **claude-code**: `claude -p --model <m> --mcp-config <file> --strict-mcp-config --allowedTools "mcp__clawdcursor__*"`,
  `--setting-sources project`, no built-in tools, prompt on stdin. Models: `sonnet`, `haiku`.
- **codex**: `codex exec --json --ignore-user-config --disable plugins --disable shell_tool -c project_doc_max_bytes=0
  -c mcp_servers.clawdcursor.*`. The token travels in an environment variable. Model: `default` (Codex's own), or any name.
- **ollama**: a function-calling loop in `lib/adapters/ollama.ts` against `127.0.0.1:11434`. The model is shown no
  images, so the tasks whose oracle needs a screenshot (canvas, CAD) are not run for it: they are listed as n/a, not failed.

Every agent runs in a new empty directory outside the owner's home (the Public folder on Windows), so no `CLAUDE.md`,
`AGENTS.md`, hook or project setting of the owner's loads. The directory holds the MCP config with the daemon's token:
it is readable by the current user alone (an ACL on Windows, mode 0700 elsewhere) and removed after the run.

### Isolation and privacy

- **clawdcursor** runs as a separate daemon per task with a temp `HOME` / `USERPROFILE` (so its own `~/.clawdcursor`:
  consent, token, config, logs), its own port and its own session-log directory. The owner's install and data are not
  read or written.
- **The browser** is a separate instance with a temp profile, in a private window. It picks its own debug port and
  writes it into that profile; clawdcursor's browser tool is pointed at that port.
- **Real apps** (Calculator, TextEdit) are used only when installed and not already running: an open window of the
  owner's is never reused. Notepad is never used.
- **Every prompt** starts with the rules: only the fixture window, never list windows, never another app.
- **The fence** is the first layer, and it acts BEFORE anything happens: the daemon is started with
  `CLAWD_FENCE_PIDS=<the fixture's processes>` and clawdcursor itself refuses (code `FENCED`) every input, act, window
  action, launch, clipboard access, window list, OCR and capture outside those processes and their children, each
  step of a batch included. It is an allow list: a tool nobody classified is refused. See "What the fence changes for
  agents" below, SECURITY.md and `src/core/fence.ts`.
- **Fixture windows open on the primary monitor only.** The fence refuses a fixture window anywhere else until its
  geometry is proven across monitors with different scaling, so M4 is guarded on the primary display for now.
- **The fixture server takes state only from its own page script**: each run has a nonce that is inside the script,
  not in the page or its accessibility tree, and a post without it is refused. The state cannot be read back over HTTP.
- **Ctrl+C, a kill or a crash** stops the agent, kills the daemon, closes every fixture and browser and removes the
  temp homes before the runner exits.
- **The watchdog** is the second layer. It follows the session log, after each call, and stops the agent on:
  1. *privacy*: a call that does something to a window, or such a step of a batch, that is not proven to be in the
     fixture. It fails closed, and an app name alone never passes:
     - the log names an app: it must be the fixture's name, and the keyboard focus must belong to a process the
       benchmark started (or a child of one);
     - no app, `browser` tool (the 2.0 log names none for a CDP act): the fixture profile must say it owns the debug
       port clawdcursor uses, and nothing may listen on the owner's port 9223;
     - no app, input or an act by name (the log leaves the app out when it went to a background process): stop;
     - no app, a window or launch call: the focus must end in a process the benchmark started;
     - a Store app's window belongs to ApplicationFrameHost: it counts only with the exact title and one of the launched
       processes hosted in it.
     A privacy stop ends the whole run.
  2. *loop*: the same call 3 times in a row;
  3. *repeat-failure*: the same failure code 3 times in a task;
  4. *call-cap* and *time-cap*: the task's `caps`.

  The proofs take one to three seconds, so an agent can make one more call before it is stopped.

## What the fence changes for agents

A benchmark run is not an ordinary session: the daemon is fenced to the fixture. Read the results with this in mind.

Works as usual, scoped to the fixture window:

- `accessibility` reads and acts (`read_tree`, `find`, `compile_ui`, `invoke`, `set_value`, `select`, `toggle`, ...);
- `smart_read`, `smart_click`, `smart_type`, and `system ocr`: their OCR sees only the fixture window's pixels;
- `computer` keys, typing, clicks, drags and scrolls: inside the fixture window;
- `computer screenshot`, `screenshot_region` and `zoom`: the image keeps its size and coordinates, with everything
  outside the fixture window black;
- `window focus / close / minimize / maximize / restore / resize` on the fixture window;
- `system copy_all_text`, `undo`; `browser` reads, clicks, typing and scrolling in the fixture browser;
- waits, the clock, the screen size, the display list, the pointer position.

Different from an ordinary session:

- `read_tree` lists the fixture's windows only in its WINDOWS section;
- a pointer move, press or release outside the fixture window is refused, also as a step of a drag path;
- text with Enter or Tab is typed a piece at a time (the foreground is checked before each piece), so it is a little slower;
- a `processId` given as a string is normalised; any other non-integer target is refused;
- a window action on a Store app (Calculator) by title is refused while another Store app's window is open, because
  both belong to one host process.

Refused (code `FENCED`):

- `window list`, `system clipboard_read` / `clipboard_write`;
- `open_app`, `open_file`, `open_url`, `open_uri`, `navigate`, OS tab switching, `shortcuts_run`, `relaunch_with_cdp`,
  `detect_webview`;
- `browser evaluate` (a script could forge the fixture's state);
- `system report`, `pause_for_user`;
- anything while a window that is not the fixture's is in front, and any fixture window that is not wholly on the
  primary monitor.

None of the tasks needs a refused call: every fixture is already open and in front when the agent starts.

## The tasks

| Task | App type | OS | Guards | Oracle (calls / shots) | What it catches |
|---|---|---|---|---|---|
| web-form-fill | web form | all | M1 | 10 / 0 | every control takes its value: text, spinner, select, checkboxes, `<details>`, contenteditable, Confirm |
| web-trap-new | web, target resolution | all | M2 | 2 / 0 | "New" is not "What's New" |
| web-trap-dialog-close | web, target resolution | all | M2 | 2 / 0 | the dialog's Close, not the page's |
| web-trap-hidden-link | web, target resolution | all | M2 | 2 / 0 | the visible link, not the off-screen one with the same name |
| web-trap-label-button | web, target resolution | all | M2 | 2 / 0 | the button, not the label next to it |
| web-timing-late-dialog | web, timing | all | M5 | 4 / 0 | a dialog that opens 3 s after the click |
| web-timing-gated-field | web, timing | all | M5 M1 | 5 / 0 | a field that throws input away until it has loaded |
| web-canvas-draw | canvas, no tree | all | M3 M4 | 2 / 1 | one look, then a drag that lands where the image said |
| web-canvas-targets | canvas, no tree | all | M3 M4 | 6 / 1 | coordinate clicks within 30 px at the primary display's scale |
| web-long-read | long text | all | M3 | 3 / 0 | one table row in the middle of a long page, read exactly |
| native-dialog-fill | native dialog | all | M1 | 6 / 0 | text fields, a list, a checkbox, Apply |
| native-dialog-modal | native dialog | all | M2 M5 | 3 / 0 | the modal's OK, not the window's OK behind it |
| native-dialog-duplicate | native dialog | all | M2 | 2 / 0 | two "Edit" buttons told apart by their group |
| calc-multiply | Store/UWP app | Windows | M1 | 3 / 0 | keys reach Calculator; the display AND the expression are read, so typing the result does not pass |
| editor-type-lines | document editor | Windows | M1 M5 | 2 / 0 | two lines land whole in the fixture editor |
| textedit-type-lines | document editor | macOS | M1 M5 | 2 / 0 | the same in TextEdit |
| cad-designcenter-orbit | 3D/CAD viewport | Windows | M3 | 4 / 2 | manual verify: metrics only |

Where success is read:

- **web tasks**: `bench.js` in each page posts every interaction and a snapshot of the page's state to the fixture
  server (`lib/fixture-server.ts`, 127.0.0.1 only);
- **native tasks**: the fixture (`fixtures/native/<os>`: WinForms built with Add-Type, AppKit built with swiftc, GTK
  through python3 gi) writes `{state, events}` to a JSON file on every change;
- **Calculator**: the display and the expression, read through UI Automation (`fixtures/apps/calculator-probe.ps1`);
- **TextEdit**: the document text, through AppleScript.

Not covered yet, from the epic's list of app types: Electron, Java or Qt, and a read-only terminal.

## Adding a task

The rule: **a new bug becomes a new task for an existing mechanism.** It is not a fix for one app.

1. Name the mechanism (M1 to M5) the bug belongs to, and the app *type* it shows up in.
2. Reproduce it in a fixture you control: a new element or page under `fixtures/web/` (load `/bench.js` and set
   `bench.snapshot`; add the page to `WEB_PAGES`), or a new control in all three native fixtures (same names and state
   keys: a unit test checks they agree).
3. Add `tasks/<id>.json`:

   ```json
   {
     "id": "web-trap-new",
     "archetype": "web-target-resolution",
     "os": ["windows", "macos", "linux"],
     "mechanisms": ["M2"],
     "guards": "one line: the bug class this catches",
     "fixture": { "kind": "web", "page": "trap" },
     "prompt": "what the agent is asked to do (the privacy rules are added by the runner)",
     "success": { "all": [{ "path": "clicks.new", "equals": 1 }, { "path": "clicks.whatsNew", "equals": 0 }] },
     "oracle": { "screenshots": 0, "calls": 2 },
     "caps": { "calls": 10, "seconds": 120 }
   }
   ```

   Predicates: `path` (dotted, into the state) or `count` (`{type, target}` of recorded events), with `equals`,
   `notEquals`, `matches`, `gte`, `lte`, `sameMembers`, `exists`; combined with `all`, `any`, `not`. The predicate must
   also say what must NOT have happened (the trap).
4. For a web task, add the right and the wrong trajectory to `lib/selfcheck.ts`, and run
   `npm run bench -- --selfcheck`: the predicate must hold on the first and fail on the second.
5. `npx vitest run bench` validates the spec. Then run the task live on the current release: it should fail there, and
   pass with the fix.

## Tests

`bench/__tests__` (vitest, no desktop, part of `npm run test:ci`): the scorer and the gate, the watchdog rules, task-spec
validation, the fixture server, the adapters' command lines, and the Windows fixture's state recording (its self-test
shows no window), and the cleanup on Ctrl+C. The fence has its own tests in `src/__tests__/fence.test.ts`. CI also compiles and self-tests the macOS fixture and syntax-checks the Linux one. Live runs are manual.
