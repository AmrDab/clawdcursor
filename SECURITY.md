# Security Policy

Clawd Cursor runs with high-trust OS permissions: Accessibility on macOS (full input + UI tree read), Screen Recording on macOS (frame capture for OCR/vision), UI Automation + global hooks on Windows, AT-SPI + `ydotool`/`wtype` on Linux. A vulnerability in this codebase, in a dependency it ships, or in the local MCP surfaces it exposes can give an attacker the same control over the user's desktop session that the user has themselves.

We take that seriously. **Please do not report security issues in public GitHub issues, pull requests, or the Discord.**

## Reporting a vulnerability

There are two private channels:

1. **GitHub Private Vulnerability Reporting** (preferred). Open the [Security tab](https://github.com/AmrDab/clawdcursor/security/advisories/new) on this repo and click "Report a vulnerability". This creates a private advisory only the maintainers can see and lets us collaborate on a fix and a coordinated disclosure inside GitHub.

2. **Email**: `amraldabbas19@gmail.com` with subject prefix `[clawdcursor security]`. PGP not currently offered.

If you have not received an acknowledgment within 72 hours, please follow up — incoming mail is occasionally lost to spam filters.

## What to include

A useful report tells us:

- The clawdcursor version (`clawdcursor --version`) and the OS + version it's running on.
- Which surface is affected: MCP stdio (`clawdcursor mcp`), MCP HTTP (`clawdcursor agent` on `127.0.0.1:3847/mcp`), the `guides` marketplace fetch path, the installer, or a dependency.
- A minimal reproducer or proof-of-concept. Logs from `CLAWD_LOG=debug` are helpful.
- Your assessment of impact — local privilege use, cross-process exfiltration, remote exposure, etc.

## Scope — what counts as a vulnerability

**In scope:**

- Bypasses of the SafetyLayer chokepoint that allow destructive verbs (e.g. `delete`, `send`, `close_window`, blocked keyboard combos like `Cmd+Q`) to execute without the documented confirm/escalation.
- Remote-attacker access to the localhost MCP HTTP surface — including unintended exposure on a non-loopback interface, missing/weak bearer-token enforcement on `POST /mcp`, or auth-bypass via path traversal / proxy confusion.
- Code execution from user-controllable input that does not require pre-existing local code execution (e.g. a malicious tool argument that escapes the safety layer and runs arbitrary shell, or a poisoned guide fetched from the marketplace registry that bypasses `lintGuide` and injects instructions into the agent prompt).
- Token theft — the bearer token at `~/.clawdcursor/token` being leaked through logs, error responses, or a CORS misconfiguration that lets a webpage in the local browser read it.
- Supply-chain issues in pinned dependencies (`package-lock.json`) that have a fixed version available, or in the guides registry at `clawdcursor.com/app-guides` / `AmrDab/clawdcursor-guides`.

**Out of scope:**

- Anything that requires the user to first run untrusted code on their machine — clawdcursor is a local tool that the user explicitly grants high permissions to. We do not defend against malware that already has those permissions.
- Issues in `@nut-tree-fork/nut-js`, `playwright`, `sharp`, or other dependencies should be reported upstream first; we will track them but cannot patch them in clawdcursor alone.
- Best-practice gripes about TypeScript style, missing rate-limiting on a localhost-only port, etc. — file a normal issue or PR.

## Disclosure

We aim to ship a fix within 14 days for high-severity issues and to publish an advisory crediting the reporter (unless you'd rather stay anonymous) once users have had a reasonable window to upgrade.
