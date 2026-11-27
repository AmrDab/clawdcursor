# clawdcursor reference: connecting

> Part of the clawdcursor skill. How to connect over MCP stdio or HTTP, and the HTTP endpoints. The main rules are in [SKILL.md](../SKILL.md).

---

## Modes at a glance

clawdcursor exposes one protocol (**MCP**) over two transports. It never runs a model: **you reason, clawdcursor acts.** You call tools, interpret results, decide next steps.

| Mode | Command | Transport | Brain | Tools available |
|------|---------|-----------|-------|-----------------|
| `mcp` | `clawdcursor mcp [--compact]` | stdio | **You** (editor host) | 90 granular (default) or compact surface (`--compact`) |
| `agent` | `clawdcursor agent [--compact]` | HTTP `/mcp` | **You** (HTTP client) | 90 granular (default) **or** compact surface — pass `--compact` (or `CLAWD_MCP_COMPACT=1`). One surface per daemon, chosen at startup — NOT both at once |

---

## Connecting

### MCP (recommended for Claude Code / Cursor / Windsurf / Zed)

**Compact - recommended for every LLM agent:**
```json
{
  "mcpServers": {
    "clawdcursor": {
      "command": "clawdcursor",
      "args": ["mcp", "--compact"]
    }
  }
}
```

**Granular - 90 individual tools (power-user, back-compat, larger prompt budget):**
```json
{
  "mcpServers": {
    "clawdcursor": {
      "command": "clawdcursor",
      "args": ["mcp"]
    }
  }
}
```

### HTTP MCP (for any HTTP-capable agent)

```bash
clawdcursor agent            # starts on http://127.0.0.1:3847 (HTTP MCP; you drive the tools)
```

The HTTP transport uses **MCP's streamable-HTTP envelope** (JSON-RPC over POST), not REST. All requests go to a single endpoint, `POST /mcp`, with `Authorization: Bearer <token>` from `~/.clawdcursor/token`. Stateless mode - no session-init handshake required for one-shot calls.

```
POST /mcp        → JSON-RPC: tools/list, tools/call (the catalog + every tool)
GET  /mcp        → SSE channel for server-initiated notifications (auth)
GET  /health     → {"status":"ok","version":"<x.y.z>"}  (no auth, readiness probe)
POST /resume     → answer a pause for the user: {"answer":"resume"|"end"} (auth, localhost-only; same as `clawdcursor resume`)
POST /stop       → graceful shutdown (auth, localhost-only)
GET  /           → minimal dashboard, calls /mcp via JSON-RPC under the hood
```

That's the entire HTTP surface. Calling a tool looks like:

```json
POST /mcp
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "open_app",
    "arguments": {"name": "Notepad"}
  }
}
```

**If the daemon isn't running, you MUST start it yourself — do not ask the user.** Only fall back to asking if the binary isn't installed or `clawdcursor agent` exits non-zero:
```bash
clawdcursor agent
# wait ~2s, then GET /health to confirm readiness
```
