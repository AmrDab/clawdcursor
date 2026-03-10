---
name: clawdcursor
version: 0.7.0
description: >
  OS-level desktop automation server. 33 tools for controlling any application
  on Windows/macOS/Linux. Model-agnostic — works with any AI that can do
  function calling (Claude, GPT, Gemini, Llama, Mistral, or plain cURL).
  No API keys needed. No config. Just install and start.
homepage: https://clawdcursor.com
source: https://github.com/AmrDab/clawd-cursor
privacy: >
  All processing runs locally on the user's machine. The tool server binds to
  127.0.0.1 only — not network accessible. No telemetry, no analytics, no
  phone-home. Screenshots stay in memory. When using the Pro autonomous agent,
  screenshots/text are sent to the user's configured AI provider only.
metadata:
  openclaw:
    requires: {}
    install:
      - npm install -g clawd-cursor
      - clawd-cursor consent --accept
      - clawd-cursor serve
---

# clawd-cursor

**OS-level desktop automation for any AI model.**

clawd-cursor is not a browser tool. It operates on the entire desktop:
native apps, Electron apps, browsers, canvas UIs, image-based UIs, terminal
apps, file pickers, system dialogs, and OS-level popups.

It is not an AI agent. It does not think or decide. It is **hands, eyes, and
ears** for whatever AI model you connect to it.

---

## Quick Start

```bash
npm install -g clawd-cursor
clawd-cursor consent --accept   # one-time: grants desktop control
clawd-cursor serve
```

Server runs on `http://localhost:3847`. No API keys. No config.

---

## For AI Models: How to Use This

> **READ THIS FIRST.** This section tells you how to effectively control a
> desktop computer using these tools.

### Strategy

1. **Read before you act.** Always call `read_screen` first. It returns the
   accessibility tree — structured text showing every window, button, input,
   and text element on screen. Fast, precise, no vision model needed.

2. **Use CDP for browsers.** When working with a browser (Edge/Chrome), use
   `cdp_connect` → `cdp_page_context` → `cdp_click`/`cdp_type`. This is
   more reliable than mouse coordinates — you interact by CSS selector or
   visible text.

3. **Verify after acting.** After clicking or typing, call `read_screen`
   again to confirm the action worked. Don't assume success.

4. **Screenshots are last resort.** Only use `desktop_screenshot` when the
   accessibility tree can't tell you what you need (layouts, images, colors).

### Connecting

```
GET  http://localhost:3847/tools           → Tool schemas (OpenAI function format)
POST http://localhost:3847/execute/{name}  → Execute a tool
GET  http://localhost:3847/docs            → Full documentation
GET  http://localhost:3847/health          → Server status
```

### Python example (any model)

```python
import requests

# 1. Fetch tool schemas
response = requests.get("http://localhost:3847/tools")
data = response.json()
guide = data["_system_guide"]   # Strategy guide — inject into system prompt
tools = data["tools"]           # OpenAI function-calling format

# 2. Pass to your model (Claude, GPT, Gemini, Llama, etc.)
result = client.chat(
    messages=[{"role": "system", "content": guide},
              {"role": "user", "content": "Open notepad and type hello"}],
    tools=tools
)

# 3. Execute tool calls
for call in result.tool_calls:
    r = requests.post(f"http://localhost:3847/execute/{call.function.name}",
                      json=call.function.arguments)
    print(r.json())
```

### MCP mode (Claude Code, Cursor, Zed)

```bash
clawd-cursor mcp   # stdio transport
```

Or register in settings:
```json
{ "mcpServers": { "clawd-cursor": { "command": "clawd-cursor", "args": ["mcp"] } } }
```

---

## 33 Tools

### Perception (3)
| Tool | Description |
|------|-------------|
| `desktop_screenshot` | Full screen capture (1280px wide) |
| `desktop_screenshot_region` | Zoomed crop of specific area |
| `get_screen_size` | Screen dimensions and DPI info |

### Screen Reading (1)
| Tool | Description |
|------|-------------|
| `read_screen` | Accessibility tree — **always use this first** |

### Mouse (6)
| Tool | Description |
|------|-------------|
| `mouse_click` | Left click at (x, y) |
| `mouse_double_click` | Double click |
| `mouse_right_click` | Right click (context menu) |
| `mouse_hover` | Move cursor without clicking |
| `mouse_scroll` | Scroll up/down |
| `mouse_drag` | Click-drag from A to B |

### Keyboard (2)
| Tool | Description |
|------|-------------|
| `type_text` | Type text (via clipboard paste — reliable) |
| `key_press` | Key combo (ctrl+s, Return, alt+tab, etc.) |

### Window Management (5)
| Tool | Description |
|------|-------------|
| `get_windows` | List all open windows |
| `get_active_window` | Current foreground window |
| `get_focused_element` | What has keyboard focus |
| `focus_window` | Bring window to front |
| `find_element` | Search UI elements by name/type |

### Clipboard (2)
| Tool | Description |
|------|-------------|
| `read_clipboard` | Read clipboard text |
| `write_clipboard` | Write to clipboard |

### Browser CDP (11)
| Tool | Description |
|------|-------------|
| `cdp_connect` | Connect to browser CDP |
| `cdp_page_context` | List interactive elements |
| `cdp_read_text` | Extract text from DOM |
| `cdp_click` | Click by selector or text |
| `cdp_type` | Type into input field |
| `cdp_select_option` | Select dropdown option |
| `cdp_evaluate` | Run JavaScript |
| `cdp_wait_for_selector` | Wait for element |
| `cdp_list_tabs` | List browser tabs |
| `cdp_switch_tab` | Switch to tab |

### Orchestration (4)
| Tool | Description |
|------|-------------|
| `delegate_to_agent` | Autonomous pipeline (Pro — has its own LLM) |
| `open_app` | Launch application |
| `navigate_browser` | Open URL with CDP enabled |
| `wait` | Pause for duration |

---

## Common Patterns

### Open an app and type
```
open_app("notepad") → wait(2) → type_text("Hello world")
```

### Web lookup
```
navigate_browser("https://example.com") → wait(3) → cdp_connect() → cdp_read_text()
```

### Fill a web form
```
cdp_connect() → cdp_page_context() → cdp_type(label="Email", text="...") → cdp_click(text="Submit")
```

### Copy between apps
```
focus_window("msedge") → key_press("ctrl+a") → key_press("ctrl+c") → read_clipboard() → focus_window("notepad") → type_text(...)
```

### Handle system dialog
```
read_screen() → find the button → mouse_click(x, y)
```

---

## Coordinate System

All mouse tools use **image-space coordinates** (1280px wide), matching the
screenshots from `desktop_screenshot`. DPI scaling is handled automatically.
You don't need to worry about logical vs physical pixels.

---

## Modes

### `clawd-cursor serve` (Free, open source)
Tool server only. 33 primitives. Your AI is the brain.
No LLM calls, no API keys, no config.

### `clawd-cursor start` (Pro)
Full autonomous agent + tool server. Internal LLM pipeline
(Layer 0→3) handles complex multi-step tasks via `delegate_to_agent`.
Requires AI provider configuration.

### `clawd-cursor mcp`
MCP stdio mode for Claude Code, Cursor, Zed, and other MCP clients.
Same 33 tools, different transport.

---

## Safety

- `alt+f4`, `ctrl+alt+delete` are **blocked**
- Server binds to **127.0.0.1 only** (localhost)
- First run requires **explicit user consent** (desktop control warning)
- All actions are logged
- No telemetry, no analytics, no phone-home

### Pro mode safety tiers
| Tier | Actions | Behavior |
|------|---------|----------|
| Auto | Navigation, reading, opening apps | Runs immediately |
| Preview | Typing, form filling | Logged before executing |
| Confirm | Sending messages, deleting | Pauses for user approval |

---

## Platform Support

| Platform | Screen | Mouse/KB | Accessibility | Browser CDP |
|----------|--------|----------|---------------|-------------|
| Windows | nut-js | nut-js | UIAutomation (PowerShell) | Edge/Chrome |
| macOS | nut-js | nut-js | AXUIElement (planned) | Chrome |
| Linux | nut-js | nut-js | AT-SPI (planned) | Chrome |

---

## Setup

```bash
npm install -g clawd-cursor    # Install
clawd-cursor serve             # Start tool server (free, no config)
clawd-cursor start             # Start autonomous agent (Pro, needs AI provider)
clawd-cursor doctor            # Diagnose and configure
clawd-cursor stop              # Stop
```

**macOS:** Grant Accessibility permission: System Settings → Privacy → Accessibility

**First run:** You'll see a desktop control warning and must type `yes` to continue.
