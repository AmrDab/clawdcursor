---
name: clawd-cursor
version: 0.3.3
description: >
  AI desktop agent that controls Windows/Mac via VNC. Gives your agent eyes and full cursor control —
  screen capture, mouse clicks, keyboard input, drag operations, and GUI automation.
  Use when the user wants desktop automation, VNC-based AI control, or GUI testing.
  Requires: VNC server with password, AI API key (Anthropic or OpenAI) for vision features.
  Installs: Node.js dependencies via npm, optionally TightVNC via setup script.
  Privacy note: screenshots are sent to AI provider APIs (Anthropic/OpenAI) for vision processing.
---

# Clawd Cursor

Desktop automation skill for OpenClaw. Controls any GUI application through VNC.

## Required Credentials

| Variable | Sensitivity | Purpose |
|----------|------------|---------|
| `VNC_PASSWORD` | **High** — grants full desktop control | Authenticates to your VNC server |
| `AI_API_KEY` | **High** — enables external API calls | Anthropic or OpenAI key for vision/planning |

**Privacy:** Screenshots of your desktop are sent to the configured AI provider (Anthropic or OpenAI) for processing. Only use on machines without sensitive data visible, or in a sandbox/VM.

**Optional variables:** `AI_PROVIDER` (anthropic\|openai), `VNC_HOST` (default: localhost), `VNC_PORT` (default: 5900)

## Installation

Requires **Node.js 20+** and a **VNC server** (TightVNC on Windows, built-in Screen Sharing on macOS).

```bash
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor
npm install && npx tsc
```

### Windows One-Command Setup

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

**What the setup script does:**
1. Checks Node.js version (requires 20+)
2. Downloads TightVNC installer from `https://www.tightvnc.com/` (requires admin for install — will prompt if not elevated)
3. Runs `npm install` and `npx tsc`
4. Creates `.env` from `.env.example`

Source: [`setup.ps1`](https://github.com/AmrDab/clawd-cursor/blob/main/setup.ps1) — review before running.

## Configuration

Create `.env` in project root:

```env
VNC_PASSWORD=your_vnc_password
AI_API_KEY=sk-ant-api03-...
AI_PROVIDER=anthropic
VNC_HOST=localhost
VNC_PORT=5900
```

## Running

```bash
# Computer Use (Anthropic — recommended for complex tasks)
npm start -- --vnc-password yourpass --provider anthropic

# Action Router (OpenAI/offline — fast for simple tasks)
npm start -- --vnc-password yourpass --provider openai
```

## Execution Paths

### Path A: Computer Use API (Anthropic)
Full task → Claude with native `computer_20250124` tools → screenshots, plans, executes autonomously.
Best for complex multi-app workflows. ~90-190s. Very reliable.

### Path B: Decompose + Route (OpenAI/Offline)
Task → subtasks → UI Automation tree → direct element interaction. Zero LLM for common patterns.
Best for simple tasks. ~2s. Works offline.

## Safety Tiers

| Tier | Actions | Behavior |
|------|---------|----------|
| 🟢 Auto | Navigation, reading, opening apps | Runs immediately |
| 🟡 Preview | Typing, form filling | Logs before executing |
| 🔴 Confirm | Sending messages, deleting, purchases | Pauses for `/confirm` approval |

## API Endpoints

`http://localhost:3847`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/task` | POST | `{"task": "Open Chrome"}` |
| `/status` | GET | Agent state |
| `/confirm` | POST | `{"approved": true}` |
| `/abort` | POST | Stop current task |

## Security Considerations

- VNC password grants **full GUI control** of the machine — use strong passwords, localhost only
- AI API keys allow **sending screenshots to external APIs** — use test keys first
- Run in a **sandbox or VM** when testing with sensitive data
- The `/confirm` endpoint enforces the 🔴 safety tier — verify it works before trusting autonomous operation
- Review [`setup.ps1`](https://github.com/AmrDab/clawd-cursor/blob/main/setup.ps1) source before running

## Changelog

### v0.3.3
- **Bulletproof headless setup** — setup.ps1 runs end-to-end in non-interactive AI agent shells
- Random VNC password generation when not provided interactively
- Fixed msiexec crash (`-PassThru -WindowStyle Hidden` with try/catch)
- Fixed Start-Service post-install crash (own try/catch)
- Replaced emoji with ASCII for cp1252 headless terminal compatibility

### v0.3.0
- 6 performance optimizations (~70% faster task execution, 90% fewer redundant LLM calls)
- Screenshot hash cache, adaptive VNC wait, parallel fetch, a11y context cache, async writes, exponential backoff

### v0.2.0
- Anthropic Computer Use API as primary execution path
- Action Router (zero-LLM) for simple tasks
