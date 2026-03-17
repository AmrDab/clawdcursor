# AI Keyboard Shortcuts Reference

This project includes a shortcut registry (`src/shortcuts.ts`) that maps natural language intents to keyboard combos.

## Example intents

- `scroll down` → `PageDown`
- `go to top` → `Control+Home` (`Super+Up` on macOS)
- `new tab` → `Control+t` (`Super+t` on macOS)
- `reddit upvote` → `a`
- `refresh` / `refesh` → `F5` (`Super+r` on macOS)

## Smart behavior

- **Fuzzy matching**: tolerates small typos like `newtab` and `refesh`.
- **Context-aware social shortcuts**: one-key social shortcuts (Reddit/X) only trigger when task text or active-window context indicates the right site/app.
- **Platform-aware mapping**: each shortcut resolves to OS-specific combos where needed.

## Categories

- Navigation
- Browser
- Editing
- Social media
- Window management
- File operations
- View
- Quick actions

## How routing works

`ActionRouter` checks shortcuts early:

1. Build context hint from active window title/process name.
2. `findShortcut(task, platform, { contextHint })`
3. `desktop.keyPress(combo)` if matched.
4. Fall back to existing route handlers or LLM path.

## Telemetry counters

`ActionRouter` now tracks:

- `totalRequests`
- `shortcutHits`
- `shortcutFuzzyHits`
- `nonShortcutHandled`
- `llmFallbacks`

Use `router.getTelemetry()` and `router.resetTelemetry()` to inspect/clear counters.
