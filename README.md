<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>OS-level desktop automation server. Gives any AI model eyes, hands, and ears on a real computer.</strong><br>
  Model-agnostic &middot; Works with Claude, GPT, Gemini, Llama, or any tool-calling model &middot; Free with local models
</p>

<p align="center">
  <a href="https://discord.gg/UGBWKvmj"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://clawdcursor.com">Website</a> &middot; <a href="https://discord.gg/UGBWKvmj">Discord</a> &middot; <a href="#quick-start">Quick Start</a> &middot; <a href="#three-ways-to-connect">Connect</a> &middot; <a href="#how-it-works">How It Works</a> &middot; <a href="#api-endpoints">API</a> &middot; <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What's New in v0.7.0

**Architecture overhaul. Universal tool server. True independence.**

- **6-layer smart pipeline** — L0 (Browser) -> L1 (Action Router) -> L1.5 (Deterministic Flows) -> L2 (A11y Reasoner + CDP) -> L2.5 (Vision Hints) -> L3 (Computer Use). Most tasks never reach L3.
- **33 universal tools** — served via REST (`GET /tools`, `POST /execute/:name`) and MCP stdio from a single definition. Any model that can call functions can control your desktop.
- **3 transport modes** — `start` (full agent + tools), `serve` (tools only, bring your own brain), `mcp` (MCP stdio for Claude Code, Cursor, Windsurf, Zed)
- **CDP browser integration** — Chrome DevTools Protocol for DOM interaction, text extraction, click-by-selector. Auto-connects to Edge/Chrome.
- **Action verifier** — ground-truth checking after every action. Blocks false success reports.
- **A11y click resolver** — bounds-based coordinate resolution, zero LLM cost
- **Deterministic flows** — hardcoded keyboard sequences for common tasks (email compose, app switch). Zero LLM calls, instant.
- **No-progress loop detector** — blocks same action repeated 3+ times. Forces the LLM to try something different.
- **Premature-done blocker** — evidence-based completion checking. Won't report success unless verified.
- **Structured task logging** — JSONL per-task logs with `verified_success` vs `unverified_success` distinction
- **First-run onboarding** — consent flow explains what desktop control means before tools activate
- **Standalone data directory** — all data in `~/.clawd-cursor/` (migrates from legacy paths automatically)
- **Error reporting** (opt-in) — `clawdcursor report` lets users send redacted task logs to help improve the agent

### Test Results

| Task | Result | Time | Method |
|------|--------|------|--------|
| Notepad haiku | PASS | 77s | Layer 2 (A11y) |
| Wikipedia lookup | PASS | 58s | Layer 2 (CDP) |
| Wikipedia -> Notepad (multi-app) | PASS | 17s | Layer 2 |
| Creative story in Notepad | PASS | 15s | Layer 2 |
| GitHub repo count | PASS | 16s | Layer 0 (CDP) |
| Google Flights search | PASS | 140s | Layer 2 (CDP) |

---

## Three Ways to Connect

Clawd Cursor is a **tool server**. It doesn't care which AI model drives it.

### 1. Built-in Agent (`start`)

Full autonomous agent with built-in LLM pipeline. Send a task, get a result.

```bash
clawdcursor start
curl http://localhost:3847/task -H "Content-Type: application/json" \
  -d '{"task": "Open Notepad and write a haiku about the ocean"}'
```

### 2. Tools-Only Server (`serve`)

Exposes 33 desktop tools via REST API. **You** bring the brain — Claude, GPT, Gemini, Llama, a script, anything.

```bash
clawdcursor serve

# Discover available tools (OpenAI function-calling format)
curl http://localhost:3847/tools

# Execute any tool
curl http://localhost:3847/execute/desktop_screenshot
curl http://localhost:3847/execute/mouse_click -d '{"x": 500, "y": 300}'
curl http://localhost:3847/execute/type_text -d '{"text": "Hello world"}'
```

### 3. MCP Mode (`mcp`)

Runs as an MCP tool server over stdio. Works with Claude Code, Cursor, Windsurf, Zed, or any MCP-compatible client.

```jsonc
// Claude Code: ~/.claude/settings.json
{
  "mcpServers": {
    "clawd-cursor": {
      "command": "node",
      "args": ["/path/to/clawd-cursor/dist/index.js", "mcp"]
    }
  }
}
```

### Tool Categories (33 tools)

| Category | Tools | Examples |
|----------|-------|---------|
| Perception | 7 | `desktop_screenshot`, `read_screen`, `get_active_window`, `get_focused_element` |
| Mouse | 6 | `mouse_click`, `mouse_double_click`, `mouse_drag`, `mouse_scroll` |
| Keyboard | 2 | `key_press`, `type_text` |
| Window/App | 5 | `focus_window`, `open_app`, `get_windows` |
| Browser CDP | 11 | `cdp_connect`, `cdp_click`, `cdp_type`, `cdp_read_text`, `navigate_browser` |
| Orchestration | 2 | `delegate_to_agent`, `wait` |

---

## Quick Start

### Windows

```powershell
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor
npm install
npm run setup      # builds + registers 'clawdcursor' command globally

# Start the full agent
clawdcursor start

# Or start tools-only (bring your own AI)
clawdcursor serve

# Or run as MCP server
clawdcursor mcp
```

### macOS

```bash
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor && npm install && npm run setup

# Grant Accessibility permissions to your terminal first!
# System Settings -> Privacy & Security -> Accessibility -> Add Terminal/iTerm

chmod +x scripts/mac/*.sh scripts/mac/*.jxa
clawdcursor start
```

### Linux

```bash
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor && npm install && npm run setup

# Linux: browser control via CDP only (no native desktop automation yet)
clawdcursor start
```

> See [docs/MACOS-SETUP.md](docs/MACOS-SETUP.md) for the full macOS onboarding guide.

First run will:
1. Show a desktop control consent warning (one-time)
2. Scan for AI providers from environment variables and CLI flags
3. Auto-configure the optimal pipeline
4. Start the server on `http://localhost:3847`

### Provider Setup

**Free (no API key needed):**
```bash
ollama pull qwen2.5:7b   # or any model
clawdcursor start
```

**Any cloud provider:**
```bash
echo "AI_API_KEY=your-key-here" > .env
clawdcursor doctor    # optional — auto-detects from key format
clawdcursor start
```

**Explicit provider:**
```bash
clawdcursor start --provider anthropic --api-key sk-ant-...
clawdcursor start --base-url https://api.example.com/v1 --api-key KEY
```

| Provider | Key prefix | Vision | Computer Use |
|----------|-----------|--------|-------------|
| Anthropic | `sk-ant-` | Yes | Yes |
| OpenAI | `sk-` | Yes | No |
| Groq | `gsk_` | Yes | No |
| Together AI | - | Yes | No |
| DeepSeek | - | Yes | No |
| Kimi/Moonshot | `sk-` (long) | No | No |
| Ollama (local) | - | Auto-detected | No |
| Any OpenAI-compatible | - | Varies | No |

---

## How It Works

### The 6-Layer Pipeline

Every task flows through layers cheapest-first. Most tasks complete at Layer 1 or 2 — Layer 3 is the expensive fallback.

```
User Task
  |
  v
Pre-processor (1 cheap LLM call)
  Decomposes "open gmail and send email to bob" into
  structured intent: {app, url, action, contextHints}
  |
  v
Layer 0: Browser (free, instant)
  Direct CDP: page.goto(), DOM reads, click by selector
  |
  v
Layer 1: Action Router + Shortcuts (free, instant)
  Regex matching + keyboard shortcuts registry
  "scroll down" -> Page Down, "copy" -> Ctrl+C
  |
  v
Layer 1.5: Deterministic Flows (free, instant)
  Hardcoded sequences for known tasks (email compose, app switch)
  |
  v
Layer 2: A11y Reasoner + CDP (cheap, 1 LLM call)
  Reads accessibility tree or CDP DOM -> sends to cheap LLM
  LLM decides: click, type, key_press, cdp_click, done
  Action verifier confirms each step worked
  |
  v
Layer 2.5: Vision Hints (1 screenshot)
  Screenshot -> vision LLM for spatial hints when A11y is blind
  |
  v
Layer 3: Computer Use / Vision (expensive, full)
  Screenshot -> vision LLM with site-specific shortcuts
  3 smart retries with step log analysis
```

### Action Verification

Every action is verified after execution:
- **Type actions**: Reads back the focused element's text content
- **Click actions**: Checks if window/focus changed as expected
- **Key presses**: Verifies the expected state change occurred
- **CDP actions**: Re-reads DOM to confirm changes
- **Task completion**: Ground-truth check reads actual content (Notepad text, email window state, etc.)

If verification fails, the agent retries with a different approach instead of reporting false success.

### No-Progress Detection

If the LLM repeats the same action 3+ times in an 8-step window, it's blocked and forced to try something different. Combined with the premature-done blocker (requires evidence of completion for write tasks), this prevents the two most common failure modes: infinite loops and premature success.

---

## API Endpoints

`http://localhost:3847`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard UI |
| `/tools` | GET | List all 33 tools (OpenAI function-calling format) |
| `/execute/:name` | POST | Execute a tool by name |
| `/task` | POST | Submit a task: `{"task": "Open Chrome"}` |
| `/status` | GET | Agent state and current task |
| `/task-logs` | GET | Recent task summaries (structured JSONL) |
| `/task-logs/current` | GET | Current task's step-by-step log |
| `/report` | POST | Submit an error report (opt-in) |
| `/logs` | GET | Last 200 console log entries |
| `/screenshot` | GET | Current screen as PNG |
| `/action` | POST | Direct action execution (LLM-space coords) |
| `/confirm` | POST | Approve/reject pending safety action |
| `/abort` | POST | Stop the current task |
| `/favorites` | GET/POST/DELETE | Saved command favorites |
| `/stop` | POST | Graceful server shutdown |
| `/health` | GET | Server health + version |

---

## Architecture

```
                     Any AI Model
                    (Claude, GPT, Gemini, Llama, scripts, etc.)
                          |
            +-------------+-------------+
            |             |             |
        REST API      MCP stdio    Built-in Agent
        (serve)        (mcp)        (start)
            |             |             |
            +-------------+-------------+
                          |
               Clawd Cursor Tool Server
               33 tools, single definition
                          |
        +---------+-------+-------+---------+
        |         |       |       |         |
    Perception  Mouse  Keyboard  Window  Browser
    screenshot  click  key_press focus   cdp_click
    read_screen drag   type_text open    cdp_type
    a11y_tree   scroll           switch  cdp_read
                          |
               Native Desktop Layer
          nut-js + PowerShell/JXA + Playwright
                          |
                    Your Desktop
```

---

## Safety

| Tier | Actions | Behavior |
|------|---------|----------|
| Auto | Navigation, reading, opening apps | Runs immediately |
| Preview | Typing, form filling | Logs before executing |
| Confirm | Sending messages, deleting, purchases | Pauses for approval |

First run shows a desktop control consent warning. Dangerous key combos (Alt+F4, Ctrl+Alt+Del) are blocked. Server binds to localhost only.

## CLI Commands

```
clawdcursor start        Start the full agent (built-in LLM pipeline)
clawdcursor serve        Start tools-only server (no built-in LLM)
clawdcursor mcp          Run as MCP tool server over stdio
clawdcursor doctor       Diagnose and auto-configure
clawdcursor task <t>     Send a task to running agent
clawdcursor report       Send an error report (opt-in, redacted)
clawdcursor dashboard    Open the web dashboard
clawdcursor install      Set up API key and configure pipeline
clawdcursor uninstall    Remove all config and data
clawdcursor stop         Stop the running server
clawdcursor kill         Force stop

Options:
  --port <port>          API port (default: 3847)
  --provider <provider>  anthropic|openai|ollama|groq|together|deepseek|kimi|...
  --model <model>        Override vision model
  --api-key <key>        AI provider API key
  --base-url <url>       Custom API endpoint
  --debug                Save screenshots to debug/ folder
```

## Platform Support

| Platform | UI Automation | Browser (CDP) | Status |
|----------|---------------|---------------|--------|
| **Windows** | PowerShell + .NET UI Automation | Chrome/Edge | Full support |
| **macOS** | JXA + System Events | Chrome/Edge | Full support |
| **Linux** | - | Chrome/Edge (CDP only) | Browser only |

## Prerequisites

- **Node.js 20+**
- **Windows**: PowerShell (included)
- **macOS 13+**: Accessibility permissions granted
- **AI API Key** — optional. Works offline with Ollama or tools-only mode.

## Tech Stack

TypeScript - Node.js - @nut-tree-fork/nut-js - Playwright - sharp - Express - MCP SDK - Zod - Any OpenAI-compatible API - Anthropic Computer Use - Windows UI Automation - macOS Accessibility (JXA) - Chrome DevTools Protocol

## License

MIT

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
