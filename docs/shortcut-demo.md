# Shortcut Demo Scenarios

## 1) Browser navigation

- Input: `new tab`
- Routed combo: `Control+t`
- Behavior: opens a tab without searching UI elements.

## 2) Typo tolerance (fuzzy)

- Input: `refesh`
- Routed combo: `F5`
- Behavior: still resolves to refresh (minor typo accepted).

## 3) Context-aware social shortcuts

- Input: `upvote`
- Routed combo: none unless context indicates Reddit.
- Behavior: prevents accidental `a` key presses in unrelated apps.

## 4) Social shortcut with context

- Input: `upvote` + active window hint `reddit.com`
- Routed combo: `a`
- Behavior: safe and fast Reddit interaction.

## 5) Telemetry check

- Call `router.getTelemetry()` after tasks.
- Inspect `shortcutHits` vs `llmFallbacks` to quantify keyboard-first performance impact.
