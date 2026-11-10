# Security Policy

clawdcursor gives an AI agent your mouse, keyboard and screen. This page says what clawdcursor is responsible for, what it leaves to the agent and its host, and how to report a problem.

**Please do not report security issues in public GitHub issues, pull requests, or the Discord.** See [Reporting a vulnerability](#reporting-a-vulnerability).

## Threat model

### clawdcursor is a tool layer that runs as you

clawdcursor has no model of its own. An agent you chose (Claude, Codex, Cursor, a local model, …) calls its MCP tools, and clawdcursor carries them out with **your own OS permissions**: Accessibility and Screen Recording on macOS, UI Automation on Windows, AT-SPI and `ydotool`/`wtype` on Linux. Anything you can do at your desktop with a mouse and a keyboard, the agent can do through it. It adds no privilege you do not have, and it removes none.

Only connect agents you trust, on a machine you control.

### Who decides what the agent may do

Not clawdcursor. Up to 1.5 it carried a policy gate that refused some tool calls by tier and by label (a button named Send or Delete, `close_window`, some shortcuts, some apps). **1.6 removed it**: a click by coordinates went around it, so it stopped nothing a determined agent wanted to do, while it blocked ordinary work and suggested a protection that was not there. See the [changelog](CHANGELOG.md).

The decision about what to do sits where it can be made well:

- **The agent**, which knows the task. The server instructions and tool descriptions tell it to ask you with `pause_for_user` before an irreversible action you did not ask for (sending, deleting, paying, closing unsaved work), and never to type or ask for credentials.
- **The MCP host's permission prompts** (Claude, Codex, Cursor and others ask before a tool call, or let you allow one for good). clawdcursor feeds them accurate tool annotations: a tool that only reads says `readOnlyHint`; a tool that clicks, types, presses keys, closes a window, opens a file or URI, writes the clipboard or runs page JavaScript says `destructiveHint`. Only tools that cannot destroy anything by themselves say they are not destructive: moving the pointer, scrolling, arranging or focusing a window, switching a tab, opening an app or a web page, releasing a key. On the default compact surface each of the six tools covers many actions, so all six say `destructiveHint`. If you want a human in the loop for every action, that is your host's setting.

### What clawdcursor itself always guarantees

These hold whatever the agent sends, alone or inside a `batch`. A way around any of them is a vulnerability.

| Guarantee | What it means |
|---|---|
| **Stop** | Double-click the on-screen pill, run `clawdcursor stop`, or `POST /stop`. The stop is a file (`~/.clawdcursor/stopped.json`) every clawdcursor process honours and that outlives a restart. While it is set every tool call except asking you is refused, and so is every synthetic key, click and scroll in the input layer, including in a call already running. Only you clear it (Resume on screen, `clawdcursor resume`, starting the daemon). |
| **The pause** | While a `pause_for_user` prompt is up, nothing acts. Only you on screen can answer it; an agent's `resume_task` is reported as unverified. The pill and the prompt are never a target for the agent's own clicks. |
| **No stray input into an AI assistant's window** | Input is refused when the window in front is an AI assistant (the chat the agent runs in) that the agent did not explicitly focus or open, and when the window in front is no longer the one the agent was working in. |
| **The hard key list** | A few OS-level key combinations are never sent, because they lock the machine, end the session or are reserved by the OS. Windows: `Win+L`, `Ctrl+Alt+Del`. macOS: `Ctrl+Cmd+Q`, `Cmd+Shift+Q` (and `Cmd+Opt+Shift+Q`), any combination with the Power or Eject key. Linux: `Super+L`, `Ctrl+Alt+L`, `Ctrl+Alt+Del`, `Ctrl+Alt+Backspace`, `Ctrl+Alt+F1`–`F12`, SysRq, the Power key. Only the list of the OS in use applies. It is checked in one place, the input layer under every tool, on the normalized input: case, spacing, key order, aliases (`cmd`/`meta`/`super`/`win`), sequences and keys held with `key_down` make no difference. Every other shortcut is allowed. |
| **Token-authenticated, loopback-only HTTP** | `clawdcursor agent` binds `127.0.0.1` only and requires the bearer token in `~/.clawdcursor/token` on `/mcp`, `/stop` and `/resume`. `clawdcursor mcp` (stdio) opens no port. |
| **Screen text is data** | Text read from the screen (accessibility names, OCR, page text, the clipboard) reaches the agent wrapped in `<untrusted-screen-content>`, and never decides a result code. This marks the text; whether the model obeys text it reads is the model's and the host's side of prompt-injection defence. |
| **No credential handling** | clawdcursor has no model keys, accounts or stored secrets of its own. It tells the agent never to type or ask for a password, and hands sign-in, 2FA and CAPTCHA to you through the pause. Its session log records which tool ran and whether it worked, not typed text or screen content. |
| **Input is never code** | Tool arguments are data. An argument that gets executed (as PowerShell, AppleScript, a shell command) is a vulnerability, whatever the tool. |
| **One-time consent** | No tool runs until you accept once (`clawdcursor consent --accept`, or your host's prompt). `--no-vision` / `CLAWD_DISABLE_VISION=1` keeps every screenshot from the model. |

Stop, the pause and the AI-host guard protect against an agent that works through the tools. An agent that also has a shell of its own on your machine is not confined by clawdcursor at all.

## Scope

**In scope:**

- Code execution from tool arguments or from content the agent handles (text it reads and types, a file name, a key name, a URL) that does not need code already running on the machine.
- A way around a guarantee in the table above: input sent after a stop or during a pause, the hard key list bypassed by a spelling, a sequence, a tool or a batch, input landing in an AI assistant's window the agent did not choose, a click on clawdcursor's own pill or prompt.
- Access to the HTTP MCP surface without the token, or from a non-loopback interface; the token leaking through logs, error responses or CORS.
- Screen text reaching the agent outside the `<untrusted-screen-content>` wrapper in a way that lets it pose as clawdcursor's own output.
- A tool annotation that understates what the tool can do (a tool that acts announced as read-only, or one that can destroy announced as not destructive).
- Supply-chain issues in pinned dependencies (`package-lock.json`) that have a fixed version available.

**Out of scope:**

- "The agent did something I did not want" with tools working as documented: clicking Send, closing a window, opening a file. That is the agent's decision and the host's permission prompt, by design. (Tell us if a description or annotation misled the agent or the host; that part is ours.)
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
