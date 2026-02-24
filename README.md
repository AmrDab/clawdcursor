<p align="center">
  <img src="docs/favicon.svg" width="80" alt="Clawd Cursor">
</p>

<h1 align="center">Clawd Cursor</h1>

<p align="center">
  <strong>AI Desktop Agent - Smart 3-Layer Pipeline</strong><br>
  Works with any AI provider · Runs free with local models · Self-healing doctor
</p>

<p align="center">
  <a href="https://clawdcursor.com">Website</a> · <a href="#quick-start">Quick Start</a> · <a href="#how-it-works">How It Works</a> · <a href="#api-endpoints">API</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What's New in v0.5.0

**Smart pipeline + self-healing doctor.** Clawd Cursor now auto-detects your AI provider, tests your models, and builds the optimal execution pipeline - from completely free (Ollama) to full power (Anthropic Computer Use).

- **`clawd-cursor doctor`** - auto-diagnoses your setup and configures everything
- **3-layer pipeline** - Action Router → Accessibility Reasoner → Screenshot fallback
- **Multi-provider** - Anthropic, OpenAI, Ollama (local/free), Kimi
- **95% cheaper** - simple tasks run for $0 with local Qwen
- **HD screenshots at 1280px** — clear enough for Claude to identify toolbar icons reliably
- **Streaming responses** - early JSON return saves 1-3s per LLM call
- **Self-healing** - if a model fails, the pipeline adapts automatically

### Performance

| Task | v0.4 (Anthropic only) | v0.5 (Ollama, $0) | v0.5 (Anthropic) |
|------|-----------------------|---------------------|-------------------|
| Calculator (255*38=) | 43s | **2.6s** | **20.1s** |
| Notepad (type hello) | 73s | **2.0s** | **54.2s** |
| File Explorer | 53s | **1.9s** | **22.1s** |
| GitHub → read → Notepad | N/A | - | **134.1s** |

---

## Quick Start

```bash
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor
npm install
npm run build
```

Run the doctor to auto-configure:
```bash
npm run doctor
```

The doctor will:
1. Test your screen capture and accessibility bridge
2. Detect available AI providers (Anthropic, OpenAI, Ollama)
3. Test each model and find what works
4. Build your optimal pipeline and save it

Then start:
```bash
npm start
```

Send a task:
```bash
curl http://localhost:3847/task -d '{"task": "Open Notepad and type hello world"}'
```

### Provider Quick Setup

**Free (no API key needed):**
```bash
# Just need Ollama running locally
ollama pull qwen2.5:7b
npm run doctor -- --provider ollama
npm start -- --provider ollama
```

**Anthropic (recommended for complex tasks):**
```bash
echo "AI_API_KEY=sk-ant-api03-..." > .env
npm run doctor
npm start
```

**OpenAI:**
```bash
echo "AI_API_KEY=sk-..." > .env
npm run doctor -- --provider openai
npm start -- --provider openai
```

---

## How It Works

### The 3-Layer Pipeline

Every task flows through up to 3 layers. Each layer is cheaper and faster than the next. Most tasks never reach Layer 3.

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: Action Router (instant, free)              │
│  Regex + UI Automation. "Open X", "type Y", "click Z"│
│  Handles ~80% of simple tasks with ZERO LLM calls    │
├─────────────────────────────────────────────────────┤
│  Layer 2: Accessibility Reasoner (fast, cheap/free)   │
│  Reads the accessibility tree, sends to cheap LLM     │
│  (Haiku, Qwen, GPT-4o-mini). No screenshots needed   │
├─────────────────────────────────────────────────────┤
│  Layer 3: Screenshot + Vision (powerful, expensive)   │
│  Full screenshot → vision LLM. Computer Use for       │
│  Anthropic, vision fallback for OpenAI/others         │
└─────────────────────────────────────────────────────┘
```

**The doctor decides which layers are available** based on your setup. No API key? Layers 1+2 with Ollama. Anthropic key? All 3 layers with Computer Use.

### Provider-Specific Behavior

| Provider | Layer 1 | Layer 2 (text) | Layer 3 (vision) | Computer Use |
|----------|---------|----------------|-------------------|-------------|
| Anthropic | ✅ | Haiku or Qwen | Sonnet | ✅ Native |
| OpenAI | ✅ | GPT-4o-mini | GPT-4o | ❌ |
| Ollama | ✅ | Qwen 7B (free) | Limited | ❌ |
| Kimi | ✅ | Moonshot-8k | Moonshot-8k | ❌ |
| No key | ✅ | ❌ | ❌ | ❌ |

### Self-Healing

The pipeline adapts at runtime:
- **Model fails?** → Circuit breaker trips, falls to next layer
- **API rate limited?** → Exponential backoff + automatic retry
- **Doctor detects issues?** → Falls back to available alternatives (e.g., Haiku unavailable → Ollama Qwen)

---

## Doctor

```bash
npm run doctor
```

```
🩺 Clawd Cursor Doctor - diagnosing your setup...

📸 Screen capture...
   ✅ 2560x1440, 93ms
♿ Accessibility bridge...
   ✅ 17 windows detected, 761ms

🔑 AI Provider: Anthropic
   ✅ claude-haiku-4: 400ms
   ✅ claude-sonnet-4: 1285ms

🧠 Recommended pipeline:
   Layer 1: Action Router (offline, instant) ✅
   Layer 2: Accessibility Reasoner → claude-haiku-4 ✅
   Layer 3: Screenshot → claude-sonnet-4 ✅
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
| `/task` | POST | Execute a task: `{"task": "Open Chrome"}` |
| `/status` | GET | Agent state and current task |
| `/confirm` | POST | Approve/reject pending action |
| `/abort` | POST | Stop the current task |

---

## Architecture

```
┌───────────────────────────────────────────────────┐
│           Your Desktop (Native Control)            │
│        @nut-tree-fork/nut-js · OS-level            │
└──────────────────────┬────────────────────────────┘
                       │
┌──────────────────────┴────────────────────────────┐
│              Clawd Cursor Agent                    │
│                                                    │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Layer 1   │  │ Layer 2       │  │ Layer 3     │ │
│  │ Action    │→ │ Accessibility │→ │ Screenshot  │ │
│  │ Router    │  │ Reasoner      │  │ + Vision    │ │
│  │ (free)    │  │ (cheap/free)  │  │ (powerful)  │ │
│  └──────────┘  └──────────────┘  └─────────────┘ │
│       ↑                                            │
│  ┌──────────┐                                     │
│  │ Doctor   │ ← Auto-configures pipeline          │
│  └──────────┘                                     │
│                                                    │
│  Safety Layer · REST API · Circuit Breaker         │
└────────────────────────────────────────────────────┘
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
clawd-cursor start      Start the agent
clawd-cursor doctor     Diagnose and auto-configure
clawd-cursor task <t>   Send a task to running agent

Options:
  --port <port>          API port (default: 3847)
  --provider <provider>  anthropic|openai|ollama|kimi
  --model <model>        Override vision model
  --api-key <key>        AI provider API key
  --debug                Save screenshots to debug/ folder
```

## Prerequisites

- **Node.js 20+**
- **PowerShell** (Windows) or **osascript** (macOS) - for accessibility features
- **AI API Key** - optional. Works offline with Ollama or Action Router only.

## Tech Stack

TypeScript · Node.js · @nut-tree-fork/nut-js · sharp · Express · Anthropic Computer Use API · Windows UI Automation · Ollama

## License

MIT

---

<p align="center">
  <a href="https://clawdcursor.com">clawdcursor.com</a>
</p>
