# 🐾 Clawd Cursor

**AI Desktop Agent over VNC** — your AI connects to your desktop like a remote user.

## How It Works

1. You run a VNC server on your machine (TightVNC, UltraVNC, etc.)
2. Clawd Cursor connects as a VNC client
3. AI sees your screen (on-demand frames, not continuous streaming)
4. AI sends mouse clicks and keystrokes through the VNC protocol
5. You can watch everything happening in real time via your own VNC viewer

## Architecture

```
┌──────────────────────────┐
│     Your Desktop         │
│   (VNC Server running)   │
└──────────┬───────────────┘
           │ VNC Protocol (RFB)
┌──────────┴───────────────┐
│   Clawd Cursor Agent     │
│                          │
│  ┌────────────────────┐  │
│  │  VNC Client        │  │  ← connects as remote user
│  │  (rfb2 / node-vnc) │  │
│  └────────┬───────────┘  │
│           │              │
│  ┌────────┴───────────┐  │
│  │  Action Engine     │  │  ← translates AI intent → VNC input
│  │  mouse/keyboard    │  │
│  └────────┬───────────┘  │
│           │              │
│  ┌────────┴───────────┐  │
│  │  AI Brain          │  │  ← LLM decides what to do
│  │  (OpenClaw / API)  │  │
│  └────────┬───────────┘  │
│           │              │
│  ┌────────┴───────────┐  │
│  │  Safety Layer      │  │  ← tiered confirmations
│  └────────────────────┘  │
│                          │
│  ┌────────────────────┐  │
│  │  REST API / CLI    │  │  ← you tell it what to do
│  └────────────────────┘  │
└──────────────────────────┘
```

## Installation

### Prerequisites

- **Node.js 20+** — [Download here](https://nodejs.org/)
- **A VNC Server** on your target machine:
  - Windows: [TightVNC](https://www.tightvnc.com/download.php), [UltraVNC](https://uvnc.com/), or RealVNC
  - macOS: Built-in Screen Sharing (System Settings → General → Sharing → Screen Sharing)
  - Linux: `x11vnc`, `tigervnc`, etc.
- **PowerShell** (Windows) — for accessibility features
- **AI API Key** — Anthropic, OpenAI, or compatible provider

### Option 1: Clone & Build (Recommended)

```bash
# Clone the repo
git clone https://github.com/AmrDab/clawd-cursor.git
cd clawd-cursor

# Install dependencies
npm install

# Build TypeScript
npm run build

# Configure environment
cp .env.example .env
# Edit .env and add your AI_API_KEY

# Start the agent
npm start -- --vnc-host localhost --vnc-port 5900 --vnc-password yourpass
```

### Option 2: Global Install via NPM (Coming Soon)

```bash
npm install -g clawd-cursor
clawd-cursor start --vnc-password yourpass
```

### Option 3: Docker (Coming Soon)

```bash
docker run -e AI_API_KEY=sk-... -e VNC_PASSWORD=yourpass ghcr.io/amrdab/clawd-cursor
```

## Quick Start

```bash
# 1. Start your VNC server with a password
# TightVNC example: Set password when prompted on first launch

# 2. Run Clawd Cursor
npm start -- --vnc-host localhost --vnc-port 5900 --vnc-password yourpass

# 3. Send a task via curl
curl http://localhost:3847/task -d '{"task": "Open Chrome and go to github.com"}'

# Or use the CLI
npm run task -- "Open Notepad and type hello world"
```

## Configuration

### Environment Variables (`.env` file)

```env
# Required: AI Provider API Key
AI_API_KEY=sk-ant-api03-...
# Or specific provider keys:
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Optional: VNC settings (can also use CLI flags)
VNC_HOST=localhost
VNC_PORT=5900
VNC_PASSWORD=yourpass

# Optional: AI Model selection
AI_PROVIDER=anthropic  # or openai
AI_MODEL=claude-opus-4
```

### CLI Options

```bash
clawd-cursor start [options]

Options:
  --vnc-host <host>      VNC server host (default: localhost)
  --vnc-port <port>      VNC server port (default: 5900)
  --vnc-password <pass>  VNC server password
  --port <port>          API server port (default: 3847)
  --provider <provider>  AI provider: anthropic|openai (default: anthropic)
  --model <model>        Vision model to use
  --api-key <key>        AI provider API key
```

## API Endpoints

Once running, Clawd Cursor exposes a REST API at `http://localhost:3847`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/task` | POST | Execute a task: `{"task": "Open Chrome"}` |
| `/status` | GET | Get agent state and current task |
| `/confirm` | POST | Approve/reject pending action: `{"approved": true}` |
| `/abort` | POST | Stop the current task |

## How It Actually Works

Clawd Cursor uses a **hybrid approach** — it tries the fastest method first, then falls back to more expensive methods only when needed:

### The Decision Flow

```
User Request: "Open Chrome and go to github.com"
         │
         ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  1. Parse Intent │────▶│ 2. Try Action    │────▶│ 3. LLM Vision   │
│                 │     │    Router        │     │   Fallback      │
│  Decompose into │     │                  │     │                 │
│  subtasks via   │     │  Query Windows   │     │  Screenshot     │
│  text-only LLM  │     │  UI Automation   │     │  → LLM decides  │
│  (fast, cheap)  │     │  tree (no LLM!)  │     │  next action    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                         │                        │
         │              ┌──────────┘                        │
         │              │ (if not found)                   │
         │              ▼                                  │
         │     "Open Chrome" ──▶ Find "Chrome" in        │
         │                   taskbar via UI Automation   │
         │                   Click it directly            │
         │                                              │
         └──────────────────────────────────────────────┘
```

### The Two Paths

**Path A: Action Router (80% of tasks, zero LLM calls)**

The Action Router intercepts common patterns and handles them via **Windows UI Automation** — the same system screen readers use:

| Task Pattern | How It's Handled |
|--------------|------------------|
| `open [app]` | Query taskbar/start menu → click via accessibility |
| `type [text]` | Direct VNC keystroke injection |
| `click [button]` | Find element by name/ID in UI tree → invoke action |
| `go to [url]` | Focus browser → Ctrl+L → type URL |
| `focus [window]` | Win32 `SetForegroundWindow` via accessibility |

**Path B: LLM Vision Fallback (complex/new situations)**

When the router can't handle a task:
1. Capture resized screenshot
2. Send to vision LLM (Claude/GPT-4o)
3. LLM returns coordinates/actions
4. Execute via VNC

### Why This Matters

- **Speed**: "Open Paint" happens in ~500ms (no LLM round-trip)
- **Cost**: 80% of tasks use zero LLM tokens
- **Reliability**: UI Automation is more precise than pixel-clicking
- **Privacy**: Common actions never leave your machine for AI processing

### Windows UI Automation (The "Screen Reader" Layer)

On Windows, Clawd Cursor queries the **UI Automation tree** — a structured representation of all UI elements:

```typescript
// Example: Find and click a button without using mouse coordinates
const element = await a11y.findElement({ 
  name: "Submit", 
  controlType: "Button" 
});
await a11y.invokeElement({ 
  name: "Submit", 
  action: "click" 
});
```

This works because Windows exposes:
- **Window titles** and **process names**
- **Control types** (Button, Edit, Menu, etc.)
- **Automation IDs** (programmatic element names)
- **Bounding boxes** (for fallback coordinate clicking)

PowerShell scripts bridge Node.js → .NET UI Automation → Windows API.

## Safety Tiers

- 🟢 **Auto**: Navigation, reading, opening apps
- 🟡 **Preview**: Typing, form filling — logs before executing
- 🔴 **Confirm**: Sending messages, deleting, purchases — pauses for approval

## Troubleshooting

### "Failed to connect to VNC server"
- Ensure VNC server is running on the target machine
- Check firewall settings (port 5900 needs to be open)
- Verify password is correct
- Try connecting with a VNC viewer first to confirm it works

### "PowerShell not available"
- Windows: Ensure PowerShell is installed and in PATH
- Some features (accessibility) require PowerShell

### "AI API error"
- Check your API key is set correctly in `.env` or via `--api-key`
- Verify the provider is accessible from your network
- Check token limits and billing status

### Screenshots not working
- On Windows with multiple monitors, VNC may only capture the primary display
- Try setting the target window on the primary monitor
- Check VNC server settings for screen capture options

## Tech Stack

- TypeScript + Node.js
- `rfb2` — VNC client library (RFB protocol)
- `sharp` — screenshot processing
- LLM vision (Claude, GPT-4o) — understands what's on screen
- Express + WebSocket — REST API and real-time control

## License

MIT
