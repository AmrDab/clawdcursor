# clawdcursor Agent Guide

> **This file is a stub.** The canonical agent-facing documentation is
> [`SKILL.md`](../SKILL.md) at the repo root. Load that — it has the full
> compact-tool workflow, compound → granular action reference, what clawdcursor
> enforces and what it leaves to you, per-OS capability matrix, and error recovery.
> The same guide is served at <https://clawdcursor.com/llms.txt>.

## One-line summary

clawdcursor 2.0 is a local MCP tool layer that gives an AI agent a cursor and a
keyboard on a real desktop. It has no model, API key or agent loop of its own:
you drive its tools. Open source (MIT). Prefer an API, a CLI or a file edit when
one exists; use clawdcursor for the steps that only exist in a GUI.

Read blind first (`accessibility read_tree`, then `system copy_all_text`, then
`system ocr`, a screenshot last) and act by name (`accessibility invoke` /
`set_value`, then `smart_click`, a coordinate click last).

clawdcursor does not judge what you do: there is no policy gate. Before an
irreversible action the user did not ask for, ask with `system pause_for_user`.

## Two ways to connect

**MCP over stdio (Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Zed):**
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
clawdcursor agent --compact   # HTTP MCP server; you drive the tools (clawdcursor never runs a model)
```
JSON-RPC at `POST http://127.0.0.1:3847/mcp` — `tools/list` returns the catalog, `tools/call` invokes a tool. Auth via `Authorization: Bearer <token>` from `~/.clawdcursor/token`. Stateless — no session init handshake required.

## For full detail

See [`SKILL.md`](../SKILL.md) at the repo root.

## Links

- Homepage: <https://clawdcursor.com>
- Repo: <https://github.com/AmrDab/clawdcursor>
- SKILL.md (canonical): [`../SKILL.md`](../SKILL.md)
