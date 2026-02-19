# 🐾 Clawd Cursor

**AI Desktop Overlay Agent** — your AI gets its own cursor.

Like TeamViewer, but the remote user is an AI. It operates alongside you on your desktop with its own independent cursor, using Windows accessibility APIs (automation-first, vision as fallback). You see everything it does in real time. Kill switch = close the app.

## Architecture

- **Automation-first**: Uses Windows UI Automation APIs to interact with apps directly — no screenshots needed for 80%+ of tasks
- **Vision fallback**: Screenshots + AI vision only when accessibility APIs fail
- **Overlay**: Transparent Electron window renders the AI's cursor and status on top of your desktop
- **Safety tiers**: 🟢 Auto (read/navigate) · 🟡 Preview (type/fill) · 🔴 Confirm (send/delete/purchase)

## Packages

| Package | Description |
|---------|-------------|
| `@clawd-cursor/shared` | Types, protocols, constants |
| `@clawd-cursor/automation` | Windows UI Automation bindings |
| `@clawd-cursor/vision` | Screenshot capture + vision model integration |
| `@clawd-cursor/router` | Action routing + safety layer |
| `@clawd-cursor/server` | Node.js backend + WebSocket IPC |
| `@clawd-cursor/overlay` | Electron transparent overlay app |

## Getting Started

```bash
pnpm install
pnpm build
pnpm dev
```

## Tech Stack

- TypeScript monorepo (pnpm workspaces)
- Electron (overlay)
- Windows UI Automation via node-ffi-napi
- Node.js + ws (server)
- LLM integration (OpenClaw / direct API)

## Safety

Clawd Cursor is designed with real-time human oversight:
- You see every action as it happens (overlay cursor)
- Three-tier safety system (auto/preview/confirm)
- Full audit log of all actions
- Kill switch: close the app or press `Ctrl+Shift+G`
- No background/hidden operations

## License

MIT
