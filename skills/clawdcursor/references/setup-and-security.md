# clawdcursor reference: setup and security

> Part of the clawdcursor skill. Security properties, per-OS setup, how to report a bug, and where the full docs are. The main rules are in [SKILL.md](../SKILL.md).

---

## Security

- **Network isolation:** Binds to `127.0.0.1` only. Verify with `netstat -an | grep 3847` on macOS/Linux, or `netstat -an | findstr 3847` on Windows PowerShell - should show `127.0.0.1:3847`, never `0.0.0.0:3847`. There is no setting that opens it to the network; to drive it from another machine, tunnel the port over SSH: `ssh -L 3847:127.0.0.1:3847 user@host`, then use `http://127.0.0.1:3847/mcp` on your side. Keep the same port on both ends: the server refuses (403) a Host other than `127.0.0.1:<its port>` or `localhost:<its port>`.
- **No model calls:** clawdcursor never calls a model. Screenshots and text go
  only to the MCP client that asked for them.
- **No-vision mode:** `clawdcursor agent --no-vision` (or `CLAWD_DISABLE_VISION=1`, also for stdio `clawdcursor mcp`) sends no screenshot to any model; a call that would return one is refused with `VISION_DISABLED`, so read the screen with the accessibility tree or OCR.
- **Token auth:** All mutating POST endpoints require `Authorization: Bearer <token>`
  from `~/.clawdcursor/token`.
- **Consent gate:** First run requires explicit `clawdcursor consent --accept`.
- **Log privacy:** The JSON file log at `~/.clawdcursor/logs/` redacts password-field values (a11y role `AXSecureTextField`, UIA `IsPassword=true`).

---

## Platform support

| Platform | Mouse/Keyboard | A11y tree | Screenshots | Clipboard |
|---|---|---|---|---|
| Windows 10/11 | nut-js + PowerShell | UIA (ps-bridge.ps1) | nut-js | Get/Set-Clipboard |
| macOS 12+ | nut-js + System Events | AX (invoke-element.jxa) | screenshot-helper.swift | pbcopy/pbpaste |
| Linux X11 | nut-js | AT-SPI via python3-gi | nut-js | xclip |
| Linux Wayland | ydotool / wtype | AT-SPI via python3-gi | nut-js | wl-copy/wl-paste |

Per-OS setup notes:

- **Windows 10/11** - no setup required. PowerShell bridge spawns on demand.
- **macOS 12+** - first run needs Accessibility + Screen Recording permissions granted via `System Settings → Privacy & Security`. Run `clawdcursor grant` to walk through the dialogs. Retina / HiDPI handled automatically; do not pre-scale.
- **Linux X11** - for accessibility support install `python3-gi gir1.2-atspi-2.0` (Debian/Ubuntu) or equivalent (`python3-gobject atspi` on Fedora, `python-gobject at-spi2-core` on Arch).
- **Linux Wayland** - keyboard/mouse input requires `ydotool` + a running `ydotoold` daemon (preferred), OR `wtype` (keyboard only). Accessibility works via the same AT-SPI packages as X11.

---

## Reporting a problem

Hit a clawdcursor bug (a tool throws/crashes or behaves contrary to this doc — not "I couldn't finish the task")? Two ways:
- **Built-in (preferred):** `clawdcursor report --note "<summary + your model + the goal>"` — redacts sensitive data (no screenshots, clipboard, or typed text) and previews before sending. Non-interactive calls send directly, so check your note first.
- **GitHub issue:** open https://github.com/AmrDab/clawdcursor/issues with: what you asked, expected vs. actual, OS + `clawdcursor --version`, and relevant lines from `~/.clawdcursor/logs/`. Don't paste private on-screen content.

---

## Full documentation

- **Tool catalog (90 granular or compact):** `tools/list` JSON-RPC over stdio MCP or HTTP `/mcp`
- **Architecture detail:** README.md in the repo
- **Changelog:** CHANGELOG.md
