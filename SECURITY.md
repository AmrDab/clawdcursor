# Security Policy

clawdcursor gives an AI agent your mouse, keyboard and screen. This page says what clawdcursor is responsible for, what it leaves to the agent and its host, and how to report a problem.

**Please do not report security issues in public GitHub issues, pull requests, or the Discord.** See [Reporting a vulnerability](#reporting-a-vulnerability).

## Threat model

### clawdcursor is a tool layer that runs as you

clawdcursor has no model of its own. An agent you chose (Claude, Codex, Cursor, a local model, …) calls its MCP tools, and clawdcursor carries them out with **your own OS permissions**: Accessibility and Screen Recording on macOS, UI Automation on Windows, AT-SPI and `ydotool`/`wtype` on Linux. Anything you can do at your desktop with a mouse and a keyboard, the agent can do through it. It adds no privilege you do not have, and it removes none.

Only connect agents you trust, on a machine you control.

### Who decides what the agent may do

Not clawdcursor. Up to 1.5 it carried a policy gate that refused some tool calls by tier and by label (a button named Send or Delete, `close_window`, some shortcuts, some apps). **2.0 removed it** (first published as 1.6.0): a click by coordinates went around it, so it stopped nothing a determined agent wanted to do, while it blocked ordinary work and suggested a protection that was not there. See the [changelog](CHANGELOG.md).

The decision about what to do sits where it can be made well:

- **The agent**, which knows the task. The server instructions and tool descriptions tell it to ask you with `pause_for_user` before an irreversible action you did not ask for (sending, deleting, paying, closing unsaved work), and never to type or ask for credentials.
- **The MCP host's permission prompts** (Claude, Codex, Cursor and others ask before a tool call, or let you allow one for good). **Approving a clawdcursor tool in a host means approving desktop control with your rights**, not one narrow action: the keyboard tool alone can open a Run dialog and start any program you could. That is true of any desktop-control tool, so a prompt per action would only look like a finer permission. clawdcursor feeds them accurate tool annotations: a tool that only reads says `readOnlyHint`; a tool that is destructive by itself says `destructiveHint` (closing a window, opening a file or URI, overwriting the clipboard, running page JavaScript, navigating the agent's browser, relaunching an app, sending a report). `open_app` is not marked destructive because it only starts an application by name and refuses a path, a URI or anything else that is not a plain name: on Windows a program on PATH or an app the Start menu lists under exactly that name, on macOS an app known to LaunchServices (`open -a`; that includes an app bundle sitting in Downloads, not only apps you installed), on Linux an executable on PATH or a `.desktop` entry. Ordinary input tools (click, type, key press, scroll) say neither: what they do depends on where the agent points them, and they keep the values earlier versions published so a host's approval behaviour does not change under you. On the compact surface (`--compact`, the six-tool surface recommended for most agents) each of the six tools covers many actions (`window` both lists windows and closes them), so all six say `destructiveHint` for that reason, and a host cannot tell their actions apart. If you want a host to prompt per kind of action, run the granular surface (`clawdcursor mcp` or `clawdcursor agent` without `--compact`), where each action is its own tool with its own hint. If you want a human in the loop for every action, that is your host's setting.

**If your host auto-approves tool calls, nothing asks before an irreversible action.** The agent's own judgement is then the only check between it and a Send, Delete or Pay button, and the tool annotations only help hosts that honour them. For agents you don't fully trust, or for unattended runs, use a host with approval prompts. An opt-in confirm mode is planned for 2.1 ([#373](https://github.com/AmrDab/clawdcursor/issues/373)): it asks you on the pause card before Send/Delete/Pay/Close-like actions, whether by name or by position.

### What clawdcursor itself always guarantees

These hold whatever the agent sends, alone or inside a `batch`. A way around any of them is a vulnerability.

| Guarantee | What it means |
|---|---|
| **Stop** | Double-click the on-screen pill, run `clawdcursor stop`, or `POST /stop`. The stop is a file (`~/.clawdcursor/stopped.json`) every clawdcursor process honours and that outlives a restart. While it is set every tool call except asking you is refused, and so is every synthetic key, click and scroll in the input layer, including in a call already running. Only you clear it (Resume on screen, `clawdcursor resume`, starting the daemon). |
| **The pause** | While a `pause_for_user` prompt is up, no other tool call runs. Only you on screen can pick a choice or type a reply; an agent's `resume_task` is reported as unverified. A tool call that names clawdcursor's own pill or prompt (by process id or name) is refused, and input is refused while the pill or prompt is the window in front. |
| **No stray input into an AI assistant's window** | Input is refused when the window in front is an AI assistant (the chat the agent runs in) that the agent did not explicitly focus or open, and when the window in front is no longer the one the agent was working in. |
| **The hard key list** | A few OS-level key combinations are not sent by clawdcursor's keyboard tools, because they lock or end your session, or cut the agent off from the desktop. Windows: `Win+L`, `Ctrl+Alt+Del`. macOS: `Ctrl+Cmd+Q`, `Cmd+Shift+Q` (and `Cmd+Opt+Shift+Q`), any combination with the Power or Eject key. Linux: `Super+L`, `Ctrl+Alt+Del`, `Ctrl+Alt+Backspace`, `Ctrl+Alt+F1`–`F12`, SysRq, the Power key. Only the list of the OS in use applies. It is checked in one place, the input layer under every tool, on the normalized input: case, spacing, key order, aliases (`cmd`/`meta`/`super`/`win`) and sequences make no difference; a key held with `key_down` counts toward the next key press and toward typed text, and stays counted until `key_up` names that one key, as it was held, and it is released. An unknown key name is an error in every executor, never typed as text, and `key_down` / `key_up` take one key, not a chord. Every other shortcut is allowed. **Limits:** held keys are tracked per clawdcursor server process, so a key held through one process is not known to another (two hosts, or stdio beside the daemon). And this stops a stray or injected key press, not every way to lock a machine: an agent can still reach Lock or Sign out through the Start menu or a command, as you can. |
| **Token-authenticated, loopback-only HTTP** | `clawdcursor agent` binds `127.0.0.1` only and requires the bearer token in `~/.clawdcursor/token` on `/mcp`, `/stop` and `/resume`. `clawdcursor mcp` (stdio) opens no port. |
| **Screen text is data** | Text that a page, a document, the clipboard or another app controls is marked as data before it reaches the agent, through one helper: free text (page text, OCR, an accessibility tree, the clipboard, a field's value) inside an `<untrusted-screen-content>` block; a short name inline (a window or tab title, an element name, a URL) in quotes; a JSON result as JSON string values. In all three the delimiter itself is made inert inside the text, so content cannot close a block early or open a fake one (near misses such as a tag with attributes or `/>` included), and a name cannot end its quotes. Result codes are decided from clawdcursor's own words only. A process or app name is quoted like a title. **Limits:** the reply you type on a pause prompt is passed as you typed it. And this marks the text; whether the model obeys text it reads is the model's and the host's side of prompt-injection defence. |
| **No credential handling** | clawdcursor has no model keys, accounts or stored secrets of its own. It tells the agent never to type or ask for a password, and hands sign-in, 2FA and CAPTCHA to you through the pause. Its session log records which tool ran and whether it worked, not typed text or screen content. |
| **Password field values stay out of tree reads** | Password field values are never returned by tree, find or value reads (Windows, macOS, Linux). A screenshot or OCR can still show whatever is visible on screen. |
| **Input is never code** | Tool arguments are data. An argument that gets executed (as PowerShell, AppleScript, a shell command) is a vulnerability, whatever the tool. |
| **One-time consent** | No tool runs until you accept once (`clawdcursor consent --accept`, or your host's prompt). `--no-vision` / `CLAWD_DISABLE_VISION=1` keeps every screenshot from the model. |

Stop, the pause and the AI-host guard protect against an agent that works through the tools. An agent that also has a shell of its own on your machine is not confined by clawdcursor at all.

### The test and automation fence (`CLAWD_FENCE_PIDS`)

For unattended runs on a machine a person also uses (the benchmark in `bench/`, a CI job with a desktop), clawdcursor can be limited to the windows of named processes. Start it with `CLAWD_FENCE_PIDS=<pid>,<pid>` and every tool call is checked **before** it does or reads anything (`src/core/fence.ts`); a call outside the fence is refused with the code `FENCED` and nothing happens.

The fence is an **allow list**. Every tool is classified in one table (`FENCE_POLICY`), and a tool that is not in it is refused, so a tool added later is outside the fence until someone classifies it. A test lists every registered tool and every action of the compound tools against the table. A step of a `batch` runs the same handler as a direct call, so it is judged by the same table, step by step.

| Class | Tools | Rule |
|---|---|---|
| free | wait, the clock, the screen size, the display list, the pointer position | touch no window |
| read | `read_tree`, `find`, `compile_ui`, `get_value`, `copy_all_text`, `ocr`, `smart_read`, the active window, ... | one window, which must be fenced: the window handle or process named, else the window in front. OCR captures are masked to that window before the OCR engine sees them, and text positioned outside it is dropped |
| act | `invoke`, `set_value`, `smart_click`, `smart_type`, typing, keys, every mouse action, `undo` | the same, and checked again where the input is sent (a click `smart_click` makes after its OCR fallback is a pointer press like any other) |
| window | focus, close, minimize, maximize, restore, resize | only a window identified as fenced, and a name that also matches a window outside the fence is refused. On Windows the call then reaches the platform as that window's exact handle, never as a title or a process to search by (a title is matched by "contains", and the Store apps share one host process); elsewhere it is pinned to the fenced process, and refused when that process also owns a window outside the fence |
| capture | `screenshot`, `screenshot_region` / `zoom`, `screenshot_full` | every image is built by one helper that blacks out everything but the fenced window in front; an image that did not come through it never leaves |
| cdp | the `browser` actions | the driver attaches only to the agent's own debug port (`CLAWD_AGENT_CDP_PORT`), never to a browser on the user's port, and launches nothing |
| refuse | the window list, the clipboard, `open_app` / `open_file` / `open_url` / `open_uri` / `navigate`, `evaluate`, shortcuts, reports and logs, `pause_for_user` | no single target, or outside by nature |

Below the tools, where input is sent:

- keys and text go only to a fenced window in front; text with Enter or Tab is sent a piece at a time, and the foreground is checked again before each piece;
- the pointer may only move, press and release inside the fenced window in front: every point a call names (each point of a drag path too), the end of a relative move, and, for a press or release that names no point, the live pointer position;
- the platform's window list holds fenced windows only, so a tool that prints "the open windows" shows no others;
- a target field (`processId`, `pid`, `handle`, `windowId`) must be a positive integer; a numeric string is normalised and passed on, anything else is refused.

A process counts as fenced when it is one of the named processes or a descendant of one; a Store app's frame counts by the app it hosts. Fenced windows must be wholly on the primary display (pointer checks and the mask compare coordinates with window bounds, and that is not proven across monitors with different scaling). Whatever cannot be decided (no foreground, no process table, no bounds, no pointer position) is refused.

With the variable unset nothing changes. The fence is a limit for tests and automation, not a sandbox: like the guarantees above, it confines an agent that works through the tools, not one with a shell of its own. A way for a tool call to act or read outside it is a vulnerability.

## Scope

**In scope:**

- Code execution from tool arguments or from content the agent handles (text it reads and types, a file name, a key name, a URL) that does not need code already running on the machine.
- A way around a guarantee in the table above: input sent after a stop or during a pause, the hard key list bypassed by a spelling, a sequence, a held key, typed text, a tool or a batch (within one server process), input landing in an AI assistant's window the agent did not choose, a click on clawdcursor's own pill or prompt.
- Access to the HTTP MCP surface without the token, or from a non-loopback interface; the token leaking through logs, error responses or CORS.
- Screen text (page text, a title, the clipboard, OCR, an element name or value) reaching the agent unmarked, or able to end its block or its quotes, so that it can pose as clawdcursor's own output.
- A tool annotation that understates what the tool does by itself (a tool that acts announced as read-only, or one that closes, overwrites or executes announced as not destructive).
- Supply-chain issues in pinned dependencies (`package-lock.json`) that have a fixed version available.

**Out of scope:**

- "The agent did something I did not want" with tools working as documented: clicking Send, closing a window, opening a file, locking the machine through its menus. That is the agent's decision and the host's permission prompt, by design. (Tell us if a description or annotation misled the agent or the host; that part is ours.)
- Anything that needs the attacker to already run code as you. clawdcursor does not defend against malware that already has your permissions, and the token file is readable by your own processes.
- Issues in `@nut-tree-fork/nut-js`, `playwright`, `sharp` or other dependencies: report them upstream first; we track them but cannot patch them here alone.
- Style, or missing rate-limiting on a loopback-only port: file a normal issue or PR.

## Published advisories

| Advisory | What it was | Status |
|---|---|---|
| [GHSA-9ppf-38v8-h97v](https://github.com/AmrDab/clawdcursor/security/advisories/GHSA-9ppf-38v8-h97v) | PowerShell injection in the Windows clipboard helper: typed text could run as code | Fixed in 1.5.26. A code-execution bug, unrelated to the gate; the fix and its tests stay. |
| [GHSA-r54p-hj6c-2434](https://github.com/AmrDab/clawdcursor/security/advisories/GHSA-r54p-hj6c-2434) | macOS key press built AppleScript from unescaped key names | Fixed. A code-execution bug, unrelated to the gate; the fix and its tests stay. |
| [GHSA-35pc-g74h-p476](https://github.com/AmrDab/clawdcursor/security/advisories/GHSA-35pc-g74h-p476) | The keyboard gate was skipped for one tool name, and by a whitespace-separated sequence | The gate it bypassed is gone. The hard key list that replaces it is checked in the input layer, below every tool, so no tool name can skip it, and sequences are checked element by element. The advisory's inputs are regression tests. |
| [GHSA-3v3f-5rwv-whc9](https://github.com/AmrDab/clawdcursor/security/advisories/GHSA-3v3f-5rwv-whc9) | `batch` with `allowConfirm:true` ran confirm-tier steps | Confirm tiers, `allowConfirm`, `CLAWD_BATCH_ALLOW_CONFIRM` and `dryRun` no longer exist. A batch step is refused by Stop, the pause and the hard key list exactly as a direct call is. |

## Reporting a vulnerability

There are two private channels:

1. **GitHub Private Vulnerability Reporting** (preferred). Open the [Security tab](https://github.com/AmrDab/clawdcursor/security/advisories/new) on this repo and click "Report a vulnerability". This creates a private advisory only the maintainers can see and lets us work on a fix and a coordinated disclosure inside GitHub.

2. **Email**: `amraldabbas19@gmail.com` with subject prefix `[clawdcursor security]`. PGP is not currently offered.

If you have not received an acknowledgment within 72 hours, please follow up: incoming mail is occasionally lost to spam filters.

### What to include

- The clawdcursor version (`clawdcursor --version`), the OS and its version.
- Which surface is affected: MCP stdio (`clawdcursor mcp`), MCP HTTP (`clawdcursor agent` on `127.0.0.1:3847/mcp`), the installer, or a dependency.
- A minimal reproducer or proof of concept. Logs from `CLAWD_LOG=debug` help.
- Which guarantee above it breaks, or what code it runs, and your assessment of the impact.

## Disclosure

We aim to ship a fix within 14 days for high-severity issues and to publish an advisory crediting the reporter (unless you would rather stay anonymous) once users have had a reasonable window to upgrade.
