# clawdcursor Agent Guide

> **This file is a stub.** The canonical agent-facing documentation is
> [`SKILL.md`](../SKILL.md) at the repo root. Load that — it has the full
> compact-tool workflow, compound → granular action reference, safety rules,
> per-OS capability matrix, and error recovery.

## One-line summary

clawdcursor is the skill that gives AI agents a cursor and a keyboard on a real
desktop. Open source (MIT). If a human can do it on a screen, you can too — no
app-specific API required.

## Two ways to connect

**MCP (recommended for Claude Code / Cursor / Windsurf / Zed):**
```json
{
  "mcpServers": {
    "clawdcursor": { "command": "clawdcursor", "args": ["mcp", "--compact"] }
  }
}
```
You see 6 compound tools: `computer`, `accessibility`, `window`, `system`,
`browser`, `batch`.

**MCP HTTP (for any HTTP-capable agent):**
```bash
clawdcursor agent           # HTTP MCP daemon; you drive the tools (clawdcursor never runs a model)
```
JSON-RPC at `POST http://127.0.0.1:3847/mcp` — `tools/list` returns the catalog, `tools/call` invokes a tool. Auth via `Authorization: Bearer <token>` from `~/.clawdcursor/token`. Stateless — no session init handshake required.

## For full detail

See [`SKILL.md`](../SKILL.md) at the repo root.

## Links

- Homepage: <https://clawdcursor.com>
- Repo: <https://github.com/AmrDab/clawdcursor>
- SKILL.md (canonical): [`../SKILL.md`](../SKILL.md)
