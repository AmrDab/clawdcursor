# macOS setup

How to install clawdcursor 2.0 on macOS and grant the two permissions it needs. For other hosts and operating systems see the [README](../README.md#install).

## Requirements

| | |
|---|---|
| macOS | 12 (Monterey) or later, Intel or Apple Silicon |
| Node.js | 20 or later (not needed for the Claude Desktop extension) |
| Xcode Command Line Tools | `xcode-select --install`. Needed to build the native helpers. Without them the install still completes and the slower `osascript` path is used. |

## 1. Install

Pick the route for your agent's host:

- **Claude Desktop:** open `clawdcursor-darwin.mcpb` from the [latest release](https://github.com/AmrDab/clawdcursor/releases/latest) and turn on "Allow clawdcursor to control this computer".
- **Claude Code:** `claude plugin marketplace add AmrDab/clawdcursor`, then `claude plugin install clawdcursor@clawdcursor`.
- **Codex, Cursor and other MCP hosts, or HTTP:**

  ```bash
  npm i -g clawdcursor
  clawdcursor consent --accept
  ```

  Then register `clawdcursor mcp --compact` in the host, or run `clawdcursor agent` for HTTP. The config shapes are in the [README](../README.md#install).

The npm install builds and ad-hoc-signs the native helpers when the Command Line Tools are present. If they were missing, run `xcode-select --install`; the fast accessibility helper then builds on first use (about 3 seconds).

## 2. Grant permissions

clawdcursor needs two entries under **System Settings → Privacy & Security**:

| Permission | Needed for | Without it |
|---|---|---|
| **Accessibility** | Reading the UI tree, clicking, typing. Required. | Nothing works. |
| **Screen & System Audio Recording** | Screenshots and OCR only. | Screenshots and OCR return an error that says how to fix it. Windows, keys and the accessibility tree keep working. |

```bash
clawdcursor grant
```

This opens the system dialogs and prints which permissions are granted.

macOS gives these permissions to an **app**, not to clawdcursor as a command. The app that needs them is the one that starts clawdcursor: your terminal when you run `clawdcursor agent`, or the agent's host (Claude, Cursor, VS Code, …) when it starts `clawdcursor mcp`. If you use clawdcursor from two hosts, each needs its own grant. Restart the app after granting.

## 3. Check

```bash
clawdcursor doctor     # version, consent, screen capture, accessibility, permissions
clawdcursor status     # short readiness check
```

`doctor` checks the permissions of the terminal it runs in. An MCP host has its own grant, so a pass in the terminal does not prove the host is allowed. The reliable test is to ask your agent to read a window: `accessibility {"action":"read_tree"}`.

## Keys on macOS

The server tells the agent it is on macOS and that the shortcut modifier is `cmd`. `mod` in a key combo means `cmd` here (`mod+s` is Cmd+S). An explicit `ctrl+…` is sent as the real Control key. `Ctrl+Cmd+Q`, `Cmd+Shift+Q` and any combination with the Power or Eject key are never sent.

## Browsers and Electron apps

The `browser` tool drives Chrome, Edge and Electron apps over the Chrome DevTools Protocol. The agent does not need you to start the browser with a flag: `browser {"action":"navigate"}` opens a browser clawdcursor controls, and `system {"action":"relaunch_with_cdp"}` restarts an Electron app with the protocol enabled (it closes the app first, so unsaved work in it can be lost).

## Troubleshooting

**Every tool returns a consent prompt.** Run `clawdcursor consent --accept`, or turn on the consent toggle in the Claude Desktop extension settings.

**The tree is empty or actions are refused with a permission error.** The app that started clawdcursor has no Accessibility grant. Enable it under Privacy & Security → Accessibility and restart that app.

**Screenshots or OCR fail, everything else works.** Screen Recording is missing for the app that started clawdcursor. Enable it under Privacy & Security → Screen & System Audio Recording and restart that app.

**Reads are slow, or "native helper not found".** The Swift helpers were not built. Run `xcode-select --install`; `clawdcursor doctor` reports the helper's state, and an error that needs a manual build prints the command to run.

**Keys or focus go nowhere while a password field is active.** macOS secure input is on, and macOS sends keys and focus only to the app holding it. The error from `window focus` names that app. clawdcursor does not type credentials; the agent hands that step to you with a pause.

**An old copy is still running.** `clawdcursor versions` lists every installed copy (global npm, Claude Desktop extension, Claude Code plugin). Update with `npm i -g clawdcursor@latest` and restart the host.
