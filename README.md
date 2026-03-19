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

## What's New in v0.7.2

**Architecture overhaul. Universal tool server. True independence.**

- **8-layer smart pipeline** — L0 (Browser) -> L1 (Action Router) -> L1.5 (Deterministic Flows) -> L2 (Skill Cache) -> L2.5 (OCR Reasoner) -> L2.5b (A11y Reasoner) -> L3 (Computer Use). Most tasks never reach L3.
- **40 universal tools** — served via REST (`GET /tools`, `POST /execute/:name`) and MCP stdio from a single definition. Any model that can call functions can control your desktop.
- **3 transport modes** — `start` (full agent + tools), `serve` (tools only, bring your own brain), `mcp` (MCP stdio for Claude Code, Cursor, Windsurf, Zed)
- **CDP browser integration** — Chrome DevTools Protocol for DOM interaction, text extraction, click-by-selector. Auto-connects to Edge/Chrome.
- **Action verifier** — ground-truth checking after every action. Blocks false success reports.
- **A11y click resolver** — bounds-based coordinate resolution, zero LLM cost
- **Deterministic flows** — hardcoded keyboard sequences for common tasks (email compose, app switch). Zero LLM calls, instant.
- **No-progress loop detector** — blocks same action repeated 3+ times. Forces the LLM to try something different.
- **Premature-done blocker** — evidence-based completion checking. Won't report success unless verified.
- **Structured task logging** — JSONL per-task logs with `verified_success` vs `unverified_success` distinction
- **First-run onboarding** — consent flow explains what desktop control means before tools activate
- **Standalone data directory** — all data in `~/.clawdcursor/` (migrates from legacy paths automatically)
- **Error reporting** (opt-in) — `clawdcursor report` lets users send redacted task logs to help improve the agent
- **API key validation on startup** — clear checkmark/cross messages so you know immediately if your key works
- **Graceful error handling** — 401/402/429 responses produce actionable messages instead of hanging
- **Configurable browser** — custom exe path, process name, and CDP port via config
- **DPI-safe coordinate conversion** — consistent across all 8 call sites
- **13 providers auto-detected** — up from 6, plus any OpenAI-compatible endpoint
- **OCR Reasoner** — screenshot + OS-level OCR + cheap text LLM, with stagnation detection and done-verification

### v0.6.3 vs v0.7.2

| | v0.6.3 | v0.7.2 |
|---|---|---|
| **Architecture** | 4-layer pipeline (L0-L3) | 8-layer pipeline (L0, L1, L1.5, L2, L2.5, L2.5b, L3) |
| **Transport** | REST API only | REST + MCP stdio + tools-only server |
| **Tools** | Monolithic agent, no tool exposure | 40 discrete tools, OpenAI function-calling format |
| **Browser** | Playwright-only, no DOM access | CDP integration — click by selector, read text, type by label |
| **Verification** | LLM self-reports success (often wrong) | Ground-truth action verifier — reads actual content back |
| **False positives** | Common — agent says "done" prematurely | Premature-done blocker + evidence-based completion |
| **Loops** | Agent can repeat same failed action forever | No-progress detector blocks after 3 repeats in 8 steps |
| **Click resolution** | Vision model guesses coordinates | A11y bounds-based resolver (zero LLM cost), vision as fallback |
| **Common tasks** | Every task goes through LLM | Deterministic flows for email, app-switch — zero LLM calls |
| **Task logging** | Console output only | Structured JSONL per-task, verified vs unverified success |
| **Data directory** | `~/.openclaw/clawdcursor/` (coupled) | `~/.clawdcursor/` (standalone, auto-migrates) |
| **Dependencies** | Tied to OpenClaw platform | Fully standalone — works with any AI, any client |
| **Onboarding** | None — starts immediately | First-run consent flow for desktop control |
| **MCP support** | None | Native MCP stdio for Claude Code, Cursor, Windsurf, Zed |
| **Error reporting** | None | Opt-in redacted task log submission |
| **Model coupling** | Anthropic-favored defaults | Truly model-agnostic — 13 providers auto-detected + any OpenAI-compatible endpoint |

---

## The Glove for Any AI Hand

Think of your AI as the **hand** and Clawd Cursor as the **glove**.

The hand has the intelligence — it reasons, plans, and decides what to do. The glove gives it grip on the physical world. Clawd Cursor wraps your entire desktop — every window, every button, every text field, every pixel — and exposes it as simple tool calls that any AI model can use.

**Your AI is the brain. Clawd Cursor is the body.**

If it's visible on your screen, Clawd Cursor can interact with it. Native apps, web apps, legacy software, internal tools, desktop games — anything with a GUI. No app-specific integrations needed. No APIs to configure per-service. One universal interface that turns any AI into a desktop operator.

This is what makes v0.7.2 different from every other automation tool: **it doesn't care which AI drives it.** Claude, GPT, Gemini, Llama running locally, a custom model you trained yourself, or a simple Python script making function calls. If it can call tools, it can control your computer.

```
Your AI (any model)          Clawd Cursor (the glove)
  "Click the Send button"  ->  find_element + mouse_click
  "What's on screen?"      ->  desktop_screenshot + read_screen
  "Type my email"          ->  type_text
  "Open Chrome to gmail"   ->  open_app + navigate_browser
  "Read that table"        ->  cdp_read_text
```

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

Exposes 40 desktop tools via REST API. **You** bring the brain — Claude, GPT, Gemini, Llama, a script, anything.

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
    "clawdcursor": {
      "command": "node",
      "args": ["/path/to/clawdcursor/dist/index.js", "mcp"]
    }
  }
}
```

### Tool Categories (40 tools)

| Category | Tools | Examples |
|----------|-------|---------|
| Perception | 9 | `desktop_screenshot`, `read_screen`, `get_active_window`, `get_focused_element`, `smart_read`, `ocr_read_screen` |
| Mouse | 6 | `mouse_click`, `mouse_double_click`, `mouse_drag`, `mouse_scroll` |
| Keyboard | 5 | `key_press`, `type_text`, `smart_type`, `shortcuts_list`, `shortcuts_execute` |
| Window/App | 6 | `focus_window`, `open_app`, `get_windows`, `invoke_element` |
| Browser CDP | 10 | `cdp_connect`, `cdp_click`, `cdp_type`, `cdp_read_text` |
| Orchestration | 4 | `delegate_to_agent`, `smart_click`, `navigate_browser`, `wait` |

---

## Quick Start

### Windows

```powershell
git clone https://github.com/AmrDab/clawdcursor.git
cd clawdcursor
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
git clone https://github.com/AmrDab/clawdcursor.git
cd clawdcursor && npm install && npm run setup

# Grant Accessibility permissions to your terminal first!
# System Settings -> Privacy & Security -> Accessibility -> Add Terminal/iTerm

chmod +x scripts/mac/*.sh scripts/mac/*.jxa
clawdcursor start
```

### Linux

```bash
git clone https://github.com/AmrDab/clawdcursor.git
cd clawdcursor && npm install && npm run setup

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
| DeepSeek | `sk-` | Yes | No |
| Kimi/Moonshot | `sk-` (long) | No | No |
| Gemini (Google) | `AI...` | Yes | No |
| Mistral | - | Yes | No |
| xAI (Grok) | `xai-` | Yes | No |
| Alibaba/Qwen (DashScope) | `sk-` | Yes | No |
| Fireworks | `fw_...` | Yes | No |
| Cohere | - | Yes | No |
| Perplexity | `pplx-` | Yes | No |
| Ollama (local) | - | Auto-detected | No |
| Any OpenAI-compatible | - | Varies | No |

---

## How It Works

### The 8-Layer Pipeline

Every task flows through layers cheapest-first. Most tasks complete before Layer 3 — the expensive vision fallback.

```
User Task
    |
    v
Pre-processor (1 cheap LLM call)
    Decomposes compound tasks into structured intent:
    {app, navigate, action, contextHints}
    Local parser runs first (regex, zero LLM cost)
    |
    v
Layer 0: Browser (free, instant)
    Direct CDP: page.goto(), DOM reads, click by selector
    |
    v
Layer 1: Action Router + Shortcuts (free, instant)
    Regex matching + 30 keyboard shortcuts
    "scroll down" -> Page Down, "save" -> Ctrl+S
    |
    v
Layer 1.5: Deterministic Flows (free, instant)
    Zero-LLM verified workflows for known patterns
    Email compose, find & replace, app switching
    |
    v
Layer 2: Skill Cache (free, instant)
    Replays previously learned task sequences
    Falls through on cache miss
    |
    v
Layer 2.5: OCR Reasoner  [PRIMARY] (cheap, 1 text LLM call per step)
    Screenshot -> OS-level OCR -> text snapshot -> cheap text LLM
    LLM decides: click, type, key, scroll, drag, done
    Stagnation detection (4 identical screens -> bail)
    Done-verification (evidence matching before accepting completion)
    System prompt rules for multi-field forms
    |
    v
Layer 2.5b: A11y Reasoner (fallback, 1 text LLM call)
    Only runs when OCR Reasoner is unavailable
    Accessibility tree -> cheap LLM -> structured actions
    Circuit breaker on repeated failures
    |
    v
Layer 3: Computer Use / Vision (expensive)
    PATH A: Anthropic native Computer Use (claude-sonnet)
    PATH B: Generic Computer Use (any OpenAI-compatible vision model)
    Screenshot -> vision LLM with function calling
    20-step limit, taskbar click blocking, stagnation detection
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
| `/tools` | GET | List all 40 tools (OpenAI function-calling format) |
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
               40 tools, single definition
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
  --provider <provider>  anthropic|openai|ollama|groq|together|deepseek|kimi|gemini|mistral|xai|qwen|fireworks|cohere|perplexity|...
  --model <model>        Override vision model
  --api-key <key>        AI provider API key
  --base-url <url>       Custom API endpoint
  --debug                Save screenshots to debug/ folder
```

## Platform Support

| Platform | UI Automation | OCR | Browser (CDP) | Status |
|----------|---------------|-----|---------------|--------|
| **Windows** (x64/ARM64) | PowerShell + .NET UI Automation | Windows.Media.Ocr | Chrome/Edge | Full support |
| **macOS** (Intel/Apple Silicon) | JXA + System Events | Apple Vision framework | Chrome/Edge | Full support |
| **Linux** (x64/ARM64) | AT-SPI (planned) | Tesseract OCR | Chrome/Edge | Browser + OCR |

## Prerequisites

- **Node.js 20+** (x64 or ARM64)
- **Windows**: PowerShell (included)
- **macOS 10.15+**: Accessibility permissions granted, Xcode CLI tools (`xcode-select --install`)
- **Linux**: `tesseract-ocr` and `python3` for OCR (`sudo apt install tesseract-ocr`)
- **AI API Key** — optional. Works offline with Ollama or tools-only mode.

## Tech Stack

TypeScript - Node.js - @nut-tree-fork/nut-js - Playwright - sharp - Express - MCP SDK - Zod - Any OpenAI-compatible API - Anthropic Computer Use - Windows UI Automation - macOS Accessibility (JXA) - Chrome DevTools Protocol

## License

MIT

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
