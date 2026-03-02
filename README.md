<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>AI Desktop Agent — Universal Smart Pipeline</strong><br>
  Works with any AI provider · Runs free with local models · Self-healing doctor
</p>

<p align="center">
  <a href="https://discord.gg/UGBWKvmj"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <a href="https://clawdcursor.com">Website</a> · <a href="https://discord.gg/UGBWKvmj">Discord</a> · <a href="#quick-start">Quick Start</a> · <a href="#how-it-works">How It Works</a> · <a href="#api-endpoints">API</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What's New in v0.6.3

**Universal Pipeline, Multi-App Workflows, Provider-Agnostic.**

- **🧠 LLM-based task pre-processor** — one cheap text LLM call decomposes any command into structured intent. No more brittle regex parsing.
- **📋 Multi-app workflows** — copy from Wikipedia, paste in Notepad. 6-checkpoint tracking ensures every step completes: select → copy → switch app → click → paste → verify.
- **⌨️ Site-specific shortcuts** — Reddit (j/k/a/c), Twitter/X, YouTube, Gmail, GitHub, Slack + generic hints. Vision LLM uses keyboard instead of slow mouse clicks.
- **🌐 OS-level browser detection** — reads Windows registry or macOS LaunchServices for actual default browser. No hardcoded Edge/Safari.
- **🔄 3 smart verification retries** — on failure, builds step log digest + checkpoint status so the vision LLM fixes the exact missed step.
- **🔌 Mixed-provider pipelines** — kimi for text + anthropic for Computer Use, with per-layer API key resolution from OpenClaw auth-profiles.
- **🔧 Global install fix** — config discovery now checks package dir first, then cwd.
- **🏗️ Provider-agnostic internals** — no hardcoded model names, no hardcoded app lists, universal checkpoint detection.

## What's New in v0.6.1

**Keyboard Shortcuts, Pipeline Fixes, Better URL Handling.**

- **⌨️ Keyboard shortcuts registry** — common actions (scroll, copy, reddit upvote) execute as direct keystrokes. Zero LLM calls, instant.
- **🔧 Pipeline gate fix** — Action Router now always runs, even for browser-context tasks. Shortcuts work everywhere.
- **🌐 Smarter URL extraction** — "open gmail and send email to foo@bar.com" correctly navigates to Gmail instead of bar.com.
- **🔄 CDP→UIDriver fallback** — Smart Interaction falls back to accessibility tree when browser CDP fails.
- **🛑 Reliable force-stop** — `clawdcursor stop` kills lingering processes.
- **📊 Provider label inference** — startup logs show text/vision providers clearly.

## What's New in v0.6.0

**Universal Provider Support, OpenClaw Integration, Security Hardening.**

- **🔗 OpenClaw integration** — auto-discovers all configured providers from OpenClaw's config. No separate API key needed when running as a skill.
- **🌐 Universal provider support** — Anthropic, OpenAI, Groq, Together AI, DeepSeek, Kimi, Ollama, or any OpenAI-compatible endpoint. Provider auto-detected from API key format.
- **🧠 Mixed provider pipelines** — use Ollama for text (free) + cloud for vision (best quality). Doctor picks the optimal split automatically.
- **🔒 Security hardened** — sensitive app policy (agents must ask before email/banking/messaging), safety tiers enforced, no credentials stored in skill files.
- **🔧 Auto-detection as default** — no hardcoded models or providers. Doctor dynamically picks the best available setup.

### v0.5.6 — Fluid Decomposition, Interactive Doctor, Smart Vision Fallback

- **🧠 Fluid task decomposition** — LLM reasons about what ANY app needs instead of matching hardcoded patterns.
- **🩺 Interactive doctor** — scans all providers, detects GPU/VRAM, lets you pick TEXT and VISION LLMs.
- **🖥️ Smart vision fallback** — remaining subtasks bundled and handed to vision when cheap layers fail midway.

### v0.5.2 — Web Dashboard + Browser Foreground Focus

- **🖥️ Web Dashboard** — real-time logs, approve/reject safety confirmations, kill switch. Dark theme, zero dependencies.
- **🪟 Browser foreground focus** — Playwright activates Chrome at OS level. No more invisible background tabs.
- **Multi-provider** — 7+ providers supported out of the box
- **95% cheaper** — simple tasks run for $0 with local models
- **Self-healing** — if a model fails, the pipeline adapts automatically

### Performance

| Task | v0.4 (single provider) | v0.5+ (local, $0) | v0.5+ (cloud) |
|------|-----------------------|---------------------|-------------------|
| Calculator (255*38=) | 43s | **2.6s** | **20.1s** |
| Notepad (type hello) | 73s | **2.0s** | **54.2s** |
| File Explorer | 53s | **1.9s** | **22.1s** |
| Gmail compose | 162s (18 LLM calls) | — | **21.7s** (1 LLM call) |

---

## OpenClaw Integration

Clawd Cursor ships as an [OpenClaw](https://openclaw.ai) skill. Install it and any OpenClaw agent — yours or community-built — can control your desktop through natural language.

The [`SKILL.md`](SKILL.md) teaches agents **when and how** to use Clawd Cursor: REST API for full desktop control, CDP direct for fast browser reads. Agents learn to be independent — no more asking you to screenshot or copy-paste things they can do themselves.

For orchestration best practices (how to avoid overlap and keep OpenClaw + Clawd Cursor efficient), see [docs/OPENCLAW-INTEGRATION-RECOMMENDATIONS.md](docs/OPENCLAW-INTEGRATION-RECOMMENDATIONS.md).

```bash
# Install as OpenClaw skill
openclaw skills install clawd-cursor
```

---

## Quick Start

### Windows

```powershell
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor
npm install
npm run setup      # builds + registers 'clawdcursor' command globally

# Just install and start — auto-configures from OpenClaw or env vars
clawdcursor start

# Or specify any provider
clawdcursor start --base-url https://api.example.com/v1 --api-key KEY

# Fine-tune setup interactively (optional)
clawdcursor doctor
```

### macOS

```bash
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor && npm install && npm run setup

# Grant Accessibility permissions to your terminal first!
# System Settings → Privacy & Security → Accessibility → Add Terminal/iTerm

# Make macOS scripts executable
chmod +x scripts/mac/*.sh scripts/mac/*.jxa

# Just start — auto-detects available providers
clawdcursor start

# Or specify any provider
clawdcursor start --base-url https://api.example.com/v1 --api-key KEY
```

### Linux (CDP-only mode)

```bash
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor && npm install && npm run setup

# Linux: browser automation via CDP only (no native desktop automation)
# Auto-detects available providers and starts immediately
clawdcursor start

# Or specify any provider explicitly
clawdcursor start --base-url https://api.example.com/v1 --api-key KEY
```

> 📖 See [docs/MACOS-SETUP.md](docs/MACOS-SETUP.md) for the full macOS onboarding guide.

First run auto-configuration will:
1. Scan for AI providers from OpenClaw config, environment variables, and CLI flags
2. Quick-test discovered providers (5s timeout per provider)
3. Build the optimal pipeline automatically
4. Save config and start immediately

The optional `doctor` command provides interactive configuration:
1. Tests your screen capture and accessibility bridge
2. Scans all AI providers (Anthropic, OpenAI, Groq, Together, DeepSeek, Kimi, Ollama) and detects GPU/VRAM  
3. Tests each model and shows you what works with latency
4. Lets you pick your TEXT LLM and VISION LLM (or accept the recommended defaults)
5. Shows setup instructions for any unconfigured cloud providers
6. Builds your optimal pipeline and saves it

Send a task:
```bash
clawdcursor task "Open Notepad and type hello world"

# Or via API:
curl http://localhost:3847/task -H "Content-Type: application/json" \
  -d '{"task": "Open Notepad and type hello world"}'
```

> **Note:** `npm run setup` runs `npm run build && npm link`, which registers `clawdcursor` as a global command. If you prefer not to link globally, run `npm run build` instead and use `npx clawdcursor` or `node dist/index.js` to run commands.

### Provider Quick Setup

**Free local setup (no API key):**
```bash
# Install Ollama, then pull any model
ollama pull qwen2.5:7b   # or llama3.2, gemma2, etc.
clawdcursor doctor       # auto-detects and configures
clawdcursor start
```

**Any cloud provider:**
```bash
echo "AI_API_KEY=your-key-here" > .env
clawdcursor doctor
clawdcursor start
```

Doctor auto-detects your provider from the key format. Supported out of the box:

| Provider | Key prefix | Vision¹ | Computer Use² |
|----------|-----------|--------|-------------|
| Anthropic | `sk-ant-` | ✅ | ✅ |
| OpenAI | `sk-` | ✅ | ❌ |
| Groq | `gsk_` | ✅ | ❌ |
| Together AI | — | ✅ | ❌ |
| DeepSeek | — | ✅ | ❌ |
| Kimi/Moonshot | `sk-` (long) | ❌ | ❌ |
| Any OpenAI-compatible | — | varies | ❌ |

¹ **Vision**: Model can see screenshots and analyze UI elements  
² **Computer Use**: Anthropic's native structured tool API for precise mouse/keyboard actions — only Anthropic provides this specialized desktop automation interface

For providers without key prefix detection, specify explicitly:
```bash
clawdcursor doctor --provider together --api-key YOUR_KEY
```

**OpenClaw users:** Zero setup required — Clawd Cursor auto-discovers all configured providers from your OpenClaw auth profiles.

---

## Compatibility (v0.6.0 Audit)

Cross-platform checks are now automated in GitHub Actions on **Windows, macOS, and Linux** for both **Node 20** and **Node 22** (build + test).

| OS | Status | Notes |
|----|--------|-------|
| Windows 10/11 | ✅ Full support | Native desktop automation via PowerShell + UI Automation scripts. |
| macOS 13+ | ✅ Full support | Native desktop automation via JXA/System Events scripts. |
| Linux | ⚠️ CDP-only mode | Browser automation works perfectly. Native desktop automation requires X11 libs. |
| ARM64 (Pi 5, etc.) | ⚠️ Graceful degradation | Automatically falls back to browser-only mode when native libs fail. |

**Linux prerequisites for native automation** (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y libxtst6 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxtst-dev
```

Missing libraries cause `libXtst.so.6: cannot open shared object file` errors. Clawd Cursor gracefully falls back to CDP-only mode on ARM64 systems.

---

## How It Works

### The Smart Pipeline

Every task is pre-processed by a cheap text LLM to understand intent, then flows through up to 5 execution layers. Each layer is cheaper and faster than the next — most tasks complete in Layer 0-1 without expensive vision calls.

```
┌─────────────────────────────────────────────────────┐
│  Pre-processor: LLM Task Decomposition (1 text call) │
│  Parses any natural language → {app, navigate, task,  │
│  contextHints}. Opens app + navigates URL before      │
│  pipeline starts. Detects multi-app workflows.        │
├─────────────────────────────────────────────────────┤
│  Layer 0: Browser (Playwright — free, instant)       │
│  Direct browser control via CDP. page.goto(),        │
│  brings Chrome to foreground. Zero vision tokens.     │
├─────────────────────────────────────────────────────┤
│  Layer 1: Action Router + Shortcuts (instant, free)  │
│  Regex + UI Automation. "Open X", "type Y", "click Z"│
│  Includes keyboard shortcuts registry — common       │
│  actions like scroll, copy, undo, reddit upvote      │
│  execute as direct keystrokes. Zero LLM calls.       │
├─────────────────────────────────────────────────────┤
│  Layer 1.5: Smart Interaction (1 LLM call)           │
│  CDPDriver (browser) or UIDriver (desktop apps).     │
│  LLM plans steps → executes via selectors/a11y.      │
├─────────────────────────────────────────────────────┤
│  Layer 2: Accessibility Reasoner (fast, cheap/free)   │
│  Reads the accessibility tree, sends to cheap LLM     │
│  (Haiku, Qwen, GPT-4o-mini). No screenshots needed   │
├─────────────────────────────────────────────────────┤
│  Layer 3: Computer Use / Vision (powerful, expensive) │
│  Full screenshot → vision LLM with site-specific      │
│  shortcuts + scroll guidance + multi-app workflows.   │
│  3 smart verification retries with step log analysis. │
└─────────────────────────────────────────────────────┘
```

**The doctor decides which layers are available** based on your setup. No API key? Layers 0-2 with Ollama. Anthropic key? All layers with Computer Use.

### Keyboard Shortcuts (Layer 1)

Clawd Cursor ships with a keyboard shortcuts registry. Common actions execute as direct keystrokes — no LLM calls, no screenshots, instant.

| Category | Examples |
|----------|----------|
| Navigation | scroll up/down, page up/down, go back/forward |
| Editing | copy, paste, undo, redo, select all |
| Browser | new tab, close tab, refresh, find |
| Social | reddit upvote/downvote, next/prev post |
| System | minimize, maximize, switch window |

Custom shortcuts can be added to `src/shortcuts.ts`. The action router uses fuzzy matching — "scroll the page down" maps to the scroll-down shortcut automatically.

### Provider-Specific Behavior

| Provider | Layer 1 | Layer 2 (text) | Layer 3 (vision) | Computer Use |
|----------|---------|----------------|-------------------|-------------|
| Anthropic | ✅ | Haiku | Sonnet | ✅ Native |
| OpenAI | ✅ | GPT-4o-mini | GPT-4o | ❌ |
| Groq | ✅ | Llama 3.3 70B | Llama 3.2 90B Vision | ❌ |
| Together AI | ✅ | Llama 3.1 70B | Llama 3.2 90B Vision | ❌ |
| DeepSeek | ✅ | DeepSeek Chat | DeepSeek Chat | ❌ |
| Kimi | ✅ | Moonshot-8k | Moonshot-8k | ❌ |
| Ollama | ✅ | Auto-detected | Auto-detected | ❌ |
| No key | ✅ | ❌ | ❌ | ❌ |

**Mixed providers:** Doctor can configure Ollama for text (free) + a cloud provider for vision (best quality). The pipeline picks the cheapest option for each layer automatically.

### Self-Healing

The pipeline adapts at runtime:
- **Model fails?** → Circuit breaker trips, falls to next layer
- **API rate limited?** → Exponential backoff + automatic retry
- **Doctor detects issues?** → Falls back to available alternatives (e.g., cloud model unavailable → local Ollama)

---

## Doctor

```bash
npm run doctor
```

```
🩺 Clawd Cursor Doctor - diagnosing your setup...

📸 Screen capture...
   ✅ 2560x1440, 110ms
♿ Accessibility bridge...
   ✅ 20 windows detected, 822ms

🔍 Scanning providers...
   Anthropic:           ✅ key found (sk-ant-a...)
   OpenAI:              ❌ no key
   Groq:                ❌ no key
   Together AI:         ❌ no key
   DeepSeek:            ❌ no key
   Kimi (Moonshot):     ❌ no key
   Ollama (Local):      ✅ running (qwen2.5:7b, llama3.2)

   💡 Cloud providers not configured (add API keys to unlock):
      OpenAI: set OPENAI_API_KEY — https://platform.openai.com
      Groq: set GROQ_API_KEY — https://console.groq.com
      Together AI: set TOGETHER_API_KEY — https://api.together.xyz

   Testing models...
   Text:   claude-haiku-4-5 (Anthropic) ✅ 498ms
   Vision: claude-sonnet-4 (Anthropic) ✅ 1217ms
   Text:   qwen2.5:7b (Ollama) ✅ 4117ms
   Mixed:  ollama/qwen2.5:7b + anthropic/claude-sonnet-4 ✅

🎮 GPU detected: NVIDIA GeForce RTX 3080 (10240 MB VRAM)

🧩 Choose your pipeline models (press Enter for recommended).
   TEXT LLM (Layer 2):
   1. claude-haiku-4-5 (Anthropic, 498ms)
   2. qwen2.5:7b (Ollama, 4117ms) ★ recommended
   Pick 1-2 (Enter=2):

   VISION LLM (Layer 3):
   1. claude-sonnet-4 (Anthropic, 1217ms) ★ recommended
   Pick 1 (Enter=1):

🧠 Selected pipeline:
   Layer 1: Action Router (offline) ✅
   Layer 2: qwen2.5:7b via Ollama ✅
   Layer 3: claude-sonnet-4 via Anthropic ✅
   🖥️  Computer Use API: enabled

💾 Config saved to .clawd-config.json
```

Options:
```
--provider <name>   Force a provider (anthropic|openai|ollama|kimi)
--api-key <key>     Override API key
--no-save           Don't save config to disk
```

---

## API Endpoints

`http://localhost:3847`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard UI |
| `/task` | POST | Execute a task: `{"task": "Open Chrome"}` |
| `/status` | GET | Agent state and current task |
| `/logs` | GET | Last 200 log entries (JSON array) |
| `/confirm` | POST | Approve/reject pending action |
| `/abort` | POST | Stop the current task |
| `/stop` | POST | Graceful server shutdown |
| `/health` | GET | Server health + version |

---

## Architecture

```
┌───────────────────────────────────────────────────┐
│           Your Desktop (Native Control)            │
│     @nut-tree-fork/nut-js · Playwright · OS-level  │
└──────────────────────┬────────────────────────────┘
                       │
┌──────────────────────┴────────────────────────────┐
│              Clawd Cursor Agent                    │
│                                                    │
│  ┌─────────────┐ ┌────────┐ ┌───────┐ ┌─────┐ ┌─────┐│
│  │ Pre-Process │→│Layer 0 │→│Layer 1│→│ L2  │→│ L3  ││
│  │ LLM Decomp  │ │Browser │ │Action │ │A11y │ │Vision││
│  │ (1 text LLM)│ │Playwrt │ │Router+│ │Tree │ │+CU   ││
│  │ Universal   │ │(free)  │ │Shortct│ │(cheap││(full)││
│  └─────────────┘ └────────┘ └───────┘ └─────┘ └─────┘│
│       ↑                                              │
│  ┌──────────┐  ┌────────────────┐                   │
│  │ Doctor   │  │ Web Dashboard  │                   │
│  │ Auto-cfg │  │ localhost:3847 │                   │
│  └──────────┘  └────────────────┘                   │
│                                                      │
│  Multi-Provider · Safety Layer · REST API · Circuit Breaker │
└──────────────────────────────────────────────────────┘
```

---

## Safety Tiers

| Tier | Actions | Behavior |
|------|---------|----------|
| 🟢 Auto | Navigation, reading, opening apps | Runs immediately |
| 🟡 Preview | Typing, form filling | Logs before executing |
| 🔴 Confirm | Sending messages, deleting, purchases | Pauses for approval |

## CLI Options

```
clawdcursor start        Start the agent
clawdcursor doctor       Diagnose and auto-configure
clawdcursor task <task>  Send a task to running agent
clawdcursor dashboard    Open the web dashboard in your browser
clawdcursor stop         Stop the running server

Options:
  --port <port>          API port (default: 3847)
  --provider <provider>  Auto-detected, or: anthropic|openai|ollama|groq|together|deepseek|kimi
  --model <model>        Override vision model
  --api-key <key>        AI provider API key
  --debug                Save screenshots to debug/ folder
```

## Platform Support

| Platform | UI Automation | Browser (CDP) | Status |
|----------|---------------|---------------|--------|
| **Windows** | PowerShell + .NET UI Automation | ✅ Chrome/Edge | ✅ Full support |
| **macOS** | JXA + System Events (Accessibility API) | ✅ Chrome/Edge | ✅ Full support |
| **Linux** | — | ✅ Chrome/Edge (CDP only) | 🔶 Browser only |

### Platform Notes

- **Windows**: Uses `powershell.exe` + `.NET UIAutomationClient` for native app interaction. Shell chaining: `cd dir; npm start`
- **macOS**: Uses `osascript` + JXA (JavaScript for Automation) + System Events. Requires Accessibility permissions. Shell chaining: `cd dir && npm start`. See [docs/MACOS-SETUP.md](docs/MACOS-SETUP.md).
- **Both**: CDPDriver (browser automation) works identically — connects via WebSocket to `localhost:9222`.

### Browser CDP Setup

```bash
# Windows (PowerShell)
Start-Process chrome --ArgumentList "--remote-debugging-port=9222"

# macOS (Bash)
open -a "Google Chrome" --args --remote-debugging-port=9222

# Edge on macOS
open -a "Microsoft Edge" --args --remote-debugging-port=9222
```

## Prerequisites

- **Node.js 18+** (20+ recommended)
- **Windows**: PowerShell (included with Windows)
- **macOS 13+**: osascript (included), Accessibility permissions granted
- **AI API Key** - optional. Works offline with Ollama or Action Router only.

## Tech Stack

TypeScript · Node.js · @nut-tree-fork/nut-js · sharp · Express · Any OpenAI-compatible API · Anthropic Computer Use · Windows UI Automation · macOS Accessibility (JXA) · Ollama

## License

MIT

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
