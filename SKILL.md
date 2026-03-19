---
name: clawdcursor
version: 0.7.2
description: >
  OS-level desktop automation server. 40 tools for controlling any application
  on Windows/macOS/Linux. Model-agnostic — works with any AI that can do
  function calling (Claude, GPT, Gemini, Llama, Mistral, or plain cURL).
  No API keys needed. No config. Just install and start.
homepage: https://clawdcursor.com
source: https://github.com/AmrDab/clawdcursor
privacy: >
  All processing runs locally on the user's machine. The tool server binds to
  127.0.0.1 only — not network accessible. No telemetry, no analytics, no
  phone-home. Screenshots stay in memory. When using the Pro autonomous agent,
  screenshots/text are sent to the user's configured AI provider only.
metadata:
  openclaw:
    requires: {}
    install:
      - npm install -g clawdcursor
      - clawdcursor consent --accept
      - clawdcursor serve
    skill_dir: ~/.openclaw/workspace/skills/clawdcursor
---

**If a human can do it on a screen, you can too.** No API? No integration? No problem.
Every app already has a UI — clawdcursor gives you eyes and hands to use all of them.

> **IMPORTANT — READ THIS BEFORE ANYTHING ELSE**
>
> clawdcursor is a **FALLBACK**, not your first choice. Before using ANY clawdcursor tool, ask yourself:
>
> - **Do I have an API for this?** (Gmail API, GitHub API, Slack API, etc.) → Use the API. It's faster, more reliable, and doesn't need a screen.
> - **Do I have a CLI tool?** (`git`, `npm`, `curl`, `gh`, etc.) → Use the CLI. Same result, no GUI needed.
> - **Do I have a browser extension or MCP connector?** (Puppeteer, Playwright, a dedicated MCP server for the service) → Use that. Direct DOM access beats screen reading.
> - **Can I read/write the file directly?** → Do that. Don't open an app to edit a file you can edit programmatically.
> - **None of the above work?** → NOW use clawdcursor. This is what it's for: the last mile where no API, CLI, or integration exists.
>
> clawdcursor gives you **eyes and hands** on the user's desktop. You can:
> 1. Open apps, click buttons, type text, fill forms, read screen content
> 2. See what's on screen via accessibility tree, OCR, or screenshots
> 3. Interact with ANY application — browsers, desktop apps, system dialogs
>
> **Rules:**
> 4. You **MUST** ask the user before accessing sensitive apps (see list below)
> 5. You **MUST** never self-approve Confirm-tier safety actions

---

## Quick Start

### MCP Mode (tools only — no built-in LLM)
1. Add clawdcursor as an MCP server in your IDE/CLI config
2. All 40 tools are immediately available — no server needed

### Agent Mode (autonomous task execution)
1. Run `clawdcursor start` in a terminal (keeps running in background)
2. Use `delegate_to_agent` tool to send complex multi-step tasks
3. IMPORTANT: delegate_to_agent requires the agent server running on port 3847

---

## Section 1: How to Drive Any GUI Task

clawdcursor gives you **eyes and hands** on the user's desktop. You can operate ANY application — if a human can see it and click it, you can too.

### The universal loop

Every GUI task follows the same pattern — observe, act, verify:

```
1. SEE the screen    →  read_screen(), ocr_read_screen(), or desktop_screenshot()
2. ACT on an element →  smart_click(), smart_type(), key_press(), or mouse_click()
3. VERIFY it worked  →  see below
4. REPEAT until done
```

### Verification (how you confirm actions worked)

**Never assume an action succeeded.** GUI actions fail silently — clicks miss, text goes to the wrong field, dialogs block input. Always verify after critical steps.

There are 5 verification methods, from cheapest to most thorough:

**Method 1: Tool return value** (free — already in the response)
Every tool returns status. Check it before moving on:
- `smart_click` → tells you *how* it clicked (a11y, OCR, or coordinates) and whether it found the element
- `smart_type` → confirms how many chars were typed and which element received them
- `open_app` / `focus_window` → confirms which window is now active
- `delegate_to_agent` → returns `{ success: true/false, steps: [...] }` with a full execution log

**Method 2: Window state check** (fast — one call)
```
get_active_window()   →  is the expected app in the foreground?
get_windows()         →  did a new window appear? did a dialog open?
get_focused_element() →  is keyboard focus on the right field?
```
Window title changes are strong signals: "Untitled" → "report.docx" means save worked. A new window appearing after a button click means the action triggered.

**Method 3: Text presence check** (medium — reads the screen)
```
read_screen(processId=PID)  →  search the a11y tree for expected text/elements
ocr_read_screen()           →  search ALL visible text on screen via OCR
smart_read(processId=PID)   →  read text from the focused element or window
```
Use this to confirm: typed text appeared in the right field, a success message is visible, a new element was created, or an error dialog is showing.

**Method 4: Visual verification** (expensive — uses a screenshot)
```
desktop_screenshot()  →  see the full screen state as an image
```
Use when text-based methods can't confirm the result — layout changes, color changes, image content, or when both a11y and OCR return empty. This costs the most tokens but gives you full visual context.

**Method 5: Negative check** (catch failures proactively)
After any action, watch for:
- Error dialogs or popups blocking the UI → dismiss them first, then retry
- Wrong window in foreground → `focus_window()` back to the target, retry
- "Save failed" / "Connection error" messages → report to user
- Screen unchanged after action → the click missed, try again or use a different method

**When to verify:**
- **Always verify** after: form submissions, sends, saves, deletes, purchases — anything irreversible
- **Spot-check** after: navigation, opening apps, clicking tabs — verify if the next step depends on it
- **Skip verification** for: keyboard shortcuts in sequence, typing mid-sentence, scrolling

### Perception tools (how you see)

| Tool | What it returns | When to use |
|------|----------------|-------------|
| `read_screen()` | Accessibility tree — buttons, inputs, text, with coordinates | **Default.** Structured, fast, works on native apps |
| `ocr_read_screen()` | All visible text with bounding boxes (OS-level OCR) | When a11y tree is empty or incomplete (canvas UIs, custom controls) |
| `desktop_screenshot()` | Visual screenshot image | When you need to see layout, colors, or images — or both above return nothing |
| `smart_read()` | Text content from focused element or window | Quick read of what's on screen without full tree |

**Start with `read_screen()`. If it returns nothing useful, try `ocr_read_screen()`. Screenshot is last resort — it costs the most tokens.**

### Action tools (how you interact)

**Tier 1 — Smart tools (preferred).** They find elements by name automatically. **Always pass `processId`** to target the right window — without it, they scan your IDE instead of the target app.

```
get_windows()                                    →  find the target app's PID
smart_click("Save", processId=PID)               →  finds & clicks "Save" button
smart_type("Search", "query text", processId=PID) →  finds "Search" field & types
```

Each smart tool tries: accessibility → OCR text match → coordinate click. Automatic fallback.

**Tier 2 — Direct tools.** When you know exactly what to do:

```
open_app("Notepad")       →  launch an app
focus_window(title="...")  →  bring a window to front
key_press("ctrl+n")       →  keyboard shortcut
type_text("hello world")  →  type into the focused element
```

**Tier 3 — Coordinate clicks (last resort).** Only after smart tools fail with the correct processId:

```
desktop_screenshot()   →  see the screen, note target (x, y)
mouse_click(x, y)     →  click that position
```

**Do not jump to coordinate clicks before trying smart tools with processId.**

### delegate_to_agent — autonomous multi-step execution

For complex tasks (3+ GUI steps), you can delegate the entire task to clawdcursor's autonomous agent. It has its own OCR + LLM pipeline that sees the screen, plans steps, and recovers from errors.

**Requires:** `clawdcursor start` running on port 3847. If connection fails, tell the user to run it first.

```
delegate_to_agent("Open Outlook, compose email to john@example.com, subject Hello, body Just checking in, then send")
```

The agent handles everything — app launch, window management, form filling, popups, error recovery. You describe the goal, it figures out the clicks. Use this when the task is too complex to drive step-by-step.

### Sensitive app policy

Always ask the user before accessing: email clients, banking/financial apps, private messaging, password managers, admin panels, or anything with credentials. Never access these silently.

---

## Section 2: Connecting

### REST mode (`clawdcursor serve`)

```bash
clawdcursor serve   # starts on http://localhost:3847
```

Endpoints:

```
GET  /tools              Tool schemas (OpenAI function-calling format)
POST /execute/{name}     Execute a tool by name
GET  /health             Server status check
GET  /docs               Full documentation
```

Example:

```python
import requests
tools = requests.get("http://localhost:3847/tools").json()
result = requests.post("http://localhost:3847/execute/read_screen").json()
```

### MCP mode (`clawdcursor mcp`)

```bash
clawdcursor mcp   # stdio transport
```

Register in your MCP client settings:

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

Works with Claude Code, Cursor, Windsurf, Zed, or any MCP-compatible client.

### Built-in agent (`clawdcursor start`)

Full autonomous agent with its own LLM pipeline. Send a task, get a result:

```bash
clawdcursor start
curl http://localhost:3847/task -H "Content-Type: application/json" \
  -d '{"task": "Open Notepad and write a haiku"}'
```

### Auto-start guidance

If the server is not running when you need it, **start it yourself — do not ask the user:**

```bash
# Any platform
clawdcursor serve
```

```powershell
# Windows (background, no window)
Start-Process -FilePath "clawdcursor" -ArgumentList "serve" -WindowStyle Hidden
```

Wait 2 seconds, then verify:

```bash
curl http://localhost:3847/health
```

Expected: `{"status":"ok","version":"0.7.2"}`

If Chrome CDP is not available on port 9222, launch Chrome yourself:

```powershell
Start-Process chrome -ArgumentList "--remote-debugging-port=9222"
```

---

## Section 3: Tool Decision Guide

This is the most important section. Follow these decision trees exactly.

### Perception — always start here

Before doing anything, read what is on screen:

```
1. smart_read          Best first call. Combines OCR + accessibility tree.
                       Returns structured text of everything visible.

2. read_screen         Accessibility tree only. Fast, structured, no OCR cost.
                       Use when smart_read is unavailable or you want raw a11y.

3. ocr_read_screen     Raw OCR text extraction (Windows OCR engine).
                       Use when a11y tree is empty (canvas apps, image-based UIs).

4. desktop_screenshot  Full screenshot as image. LAST RESORT.
                       Only use when you need pixel-level detail (colors, layout,
                       images) that text-based tools cannot provide.
```

### Clicking — choose the right tool

```
1. smart_click("Save")         FIRST CHOICE. Finds element by label/text using
                               OCR + a11y, then clicks it. Handles fallbacks
                               internally. Pass the visible text of the element.

2. cdp_click(text="Submit")    Use for browser DOM elements specifically.
                               Requires cdp_connect() first. Works by visible
                               text or CSS selector.

3. invoke_element(name="Save") Use when you know the exact automation ID or
                               element name from read_screen output.

4. mouse_click(x, y)           LAST RESORT. Raw coordinates. Only use when all
                               text-based methods fail. Get coordinates from
                               desktop_screenshot (1280px-wide image space).
```

### Typing — choose the right tool

```
1. smart_type(text, target)    FIRST CHOICE. Finds the input field by label or
                               nearby text, focuses it, then types. One call
                               does find + focus + type.

2. cdp_type(label, text)       Use for browser input fields. Finds by label
                               text or CSS selector. Requires cdp_connect().

3. type_text(text)             Raw clipboard paste into whatever is currently
                               focused. Use after you have manually focused the
                               right element with smart_click or focus_window.
```

### Browser workflow — follow this exact sequence

```
1. navigate_browser(url)       Opens URL, auto-launches browser with CDP enabled
2. wait(3)                     Let the page load
3. cdp_connect()               Connect to the browser's CDP
4. cdp_page_context()          Get interactive elements on the page

   IMPORTANT: Check the connected URL. If CDP connected to the wrong tab:
5. cdp_list_tabs()             List all browser tabs
6. cdp_switch_tab(target)      Switch to the correct tab

Then interact:
   cdp_click(text="...")       Click by visible text
   cdp_type(label="...", text) Type into input by label
   cdp_read_text()             Extract page text
   cdp_evaluate(script)        Run JavaScript
```

### CDP fast path (quick page reads)

For reading page content without a full task, skip `navigate_browser` and connect directly if Chrome is already open:

```javascript
// Chrome must have --remote-debugging-port=9222
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
const text = await page.textContent('body');
```

| Scenario | Use | Why |
|----------|-----|-----|
| Read page content | CDP direct | Instant, no LLM cost |
| Fill a form | `cdp_type` + `cdp_click` | clawd handles the interaction |
| Check if a page loaded | `cdp_read_text()` | Fast DOM query |
| Desktop app interaction | Individual tools | CDP is browser-only |
| Complex multi-step task | `delegate_to_agent` | Built-in agent handles planning |

### Window focus rule (CRITICAL)

**Always call focus_window before key_press.**

`key_press` sends keystrokes to whatever window currently has focus. If your
agent runs in a terminal, key presses go to the terminal — not the app you
intended. Always focus the target window first:

```
focus_window("Notepad")        Focus the window
read_screen()                  Confirm it is focused
key_press("ctrl+s")            Now the keystroke goes to Notepad
```

### Shortcuts — use before reaching for mouse clicks

`shortcuts_list` returns keyboard shortcuts for the current app context.
`shortcuts_execute` runs a named shortcut with fuzzy matching.

For known actions (save, copy, paste, undo, new tab, close tab, find, etc.),
use shortcuts first — they are instant and never miss:

```
shortcuts_execute("save")      Instead of clicking File > Save
shortcuts_execute("copy")      Instead of right-click > Copy
shortcuts_execute("new tab")   Instead of clicking the + button
```

### Canvas app handling (Google Docs, Figma, Notion)

These apps use canvas rendering. The DOM has no readable text. Pattern:

```
1. cdp_read_text()             Try first — will return empty or garbage
2. ocr_read_screen()           Fall back to OCR for actual content
3. smart_read()                Also works — OCR component will pick it up

To type in canvas apps:
1. mouse_click(x, y)           Click the canvas area where you want to type
2. type_text("your text")      Clipboard paste works even on canvas
```

### Delegate complex tasks to the built-in agent

> **PREREQUISITE:** `delegate_to_agent` requires `clawdcursor start` running in a
> terminal. Without it, calls will fail with "connection refused". Other tools
> (smart_click, type_text, read_screen, etc.) work without the server.

Use `delegate_to_agent` for complex multi-step GUI tasks that can't be done with
individual tool calls — it has **its own LLM reasoning loop**, so the calling
agent doesn't need to plan each click and keystroke. Just describe the goal:

```
delegate_to_agent("Open Gmail, find the latest email from Stripe, and forward it to billing@example.com")
```

Then poll for completion:

```
1. delegate_to_agent(task)     Submit the task
2. wait(2)                     Let it start
3. GET /status                 Check: acting | waiting_confirm | idle
4. If waiting_confirm          → ASK the user, then POST /confirm
5. If idle                     → task complete
6. If acting after 60s         → POST /abort and retry with simpler phrasing
```

**Response states:**

| State | What it means | What to do |
|-------|--------------|------------|
| `acting` | Task in progress | Keep polling every 2s |
| `waiting_confirm` | Safety-gated action pending | Ask the user → POST /confirm |
| `idle` | Task complete | Read the result |
| `error` | Task failed | Check /logs, retry or rephrase |

**Never self-approve `waiting_confirm`.** Always ask the user first.

### Verifying actions succeeded

See **Section 1 → Verification** for the 5 verification methods ranked by cost. Quick reference:

```
1. Check tool return value     →  free, already in the response
2. Window state check          →  get_active_window(), get_focused_element()
3. Text presence check         →  read_screen(), ocr_read_screen(), smart_read()
4. Visual verification         →  desktop_screenshot()
5. Negative check              →  look for error dialogs, wrong window, unchanged screen
```

**Always verify** after irreversible actions (send, save, delete, purchase). **Spot-check** after navigation. **Skip** for mid-sequence keystrokes.

---

## Section 4: Task Examples

| Goal | How to do it |
|------|-------------|
| **Open app and type** | `open_app("notepad")` → `wait(2)` → `type_text("Hello world")` |
| **Read a webpage** | `navigate_browser(url)` → `cdp_connect()` → `cdp_read_text()` |
| **Fill a web form** | `cdp_connect()` → `cdp_type(label, text)` × N → `cdp_click("Submit")` |
| **Cross-app copy/paste** | `focus_window("Chrome")` → `key_press("ctrl+a")` → `key_press("ctrl+c")` → `focus_window("Notepad")` → `type_text(clipboard)` |
| **Interact with desktop app** | `open_app("Spotify")` → `smart_click("Discover Weekly")` |
| **Canvas editor (Google Docs)** | `navigate_browser(url)` → `cdp_connect()` → `ocr_read_screen()` → `mouse_click(500,400)` → `type_text("content")` |
| **Send email (with confirm)** | `delegate_to_agent("Open Gmail, compose to john@example.com, subject: Meeting, body: Confirming 2pm")` → poll → user approves confirm |
| **Check deployment status** | `navigate_browser("https://vercel.com/dashboard")` → `cdp_connect()` → `cdp_read_text()` |
| **Take a screenshot** | `desktop_screenshot()` |
| **Play music** | `open_app("Spotify")` → `smart_read()` → `smart_click("Play")` |
| **System settings** | `delegate_to_agent("Open Windows Settings and turn on Dark Mode")` |
| **Complex browser flow** | `delegate_to_agent("Open YouTube, search for Adele Hello, play the first result")` |

### Task writing guidelines (for delegate_to_agent)

1. **Be specific** — include app names, URLs, exact text to type, button names
2. **One task at a time** — wait for completion before sending the next
3. **Describe the goal, not the clicks** — "Send an email to john@" not "click compose, click to field..."
4. **Don't include credentials in task text** — tasks are logged
5. **If it fails once, rephrase** — break into smaller steps, be more explicit about app name / button label

---

## Section 5: Tool Reference (40 tools)

Speed/cost tier: ⚡ Free+instant · 🔵 Cheap · 🟡 Moderate · 🔴 Expensive (vision LLM)

### Perception (5 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `smart_read` | OCR + accessibility tree combined | 🔵 | **Best first call** for reading anything on screen |
| `read_screen` | Accessibility tree (windows, buttons, inputs, text) | ⚡ | Fast structured read when you want raw a11y |
| `ocr_read_screen` | Raw OCR text extraction | 🔵 | Canvas apps or image-based UIs where a11y fails |
| `desktop_screenshot` | Full screen capture (1280px wide) | ⚡ | **Last resort** — when you need pixel-level visual detail |
| `desktop_screenshot_region` | Zoomed crop of a specific area | ⚡ | When you need detail in one part of the screen |
| `get_screen_size` | Screen dimensions and DPI | ⚡ | When you need to calculate coordinates |

### Mouse (6 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `smart_click` | Find element by label/text via OCR + a11y, click it | 🔵 | **First choice** for clicking — handles fallbacks internally |
| `mouse_click` | Left click at (x, y) | ⚡ | Last resort — when text-based click methods fail |
| `mouse_double_click` | Double click at (x, y) | ⚡ | Open files, select words |
| `mouse_right_click` | Right click at (x, y) | ⚡ | Open context menus |
| `mouse_hover` | Move cursor without clicking | ⚡ | Trigger hover menus or tooltips |
| `mouse_scroll` | Scroll up/down at position | ⚡ | Scroll content not responding to Page Down |
| `mouse_drag` | Drag from (x1,y1) to (x2,y2) | ⚡ | Resize windows, move objects, select text ranges |

### Keyboard (5 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `smart_type` | Find input by label, focus it, type — all in one | 🔵 | **First choice** for typing into a specific field |
| `type_text` | Type via clipboard paste | ⚡ | After you have focused the correct input |
| `key_press` | Send key combo (ctrl+s, Return, alt+tab) | ⚡ | After focus_window — never without focusing first |
| `shortcuts_list` | List keyboard shortcuts for current app | ⚡ | Before reaching for mouse clicks on known actions |
| `shortcuts_execute` | Execute a named shortcut (fuzzy match) | ⚡ | Save, copy, paste, undo, new tab, etc. |

### Window Management (4 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `get_windows` | List all open windows | ⚡ | Find which apps are running |
| `get_active_window` | Current foreground window | ⚡ | Check what has focus right now |
| `get_focused_element` | What has keyboard focus | ⚡ | Debug typing going to wrong element |
| `focus_window` | Bring window to front | ⚡ | **ALWAYS** before key_press or type_text |

### UI Elements (2 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `find_element` | Search UI elements by name/type | ⚡ | When you need the automation ID before invoke |
| `invoke_element` | Invoke a UI element by automation ID or name | ⚡ | When you know the exact element from read_screen |

### Clipboard (2 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `read_clipboard` | Read clipboard text | ⚡ | After a copy operation to get the content |
| `write_clipboard` | Write text to clipboard | ⚡ | Before a paste operation |

### Browser CDP (10 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `cdp_connect` | Connect to browser's Chrome DevTools Protocol | ⚡ | First step for any browser interaction |
| `cdp_page_context` | List interactive elements on page | ⚡ | After connect — see what you can click/type |
| `cdp_read_text` | Extract text from DOM | ⚡ | Read page content (fails on canvas apps) |
| `cdp_click` | Click by CSS selector or visible text | ⚡ | Browser clicks — more reliable than mouse coordinates |
| `cdp_type` | Type into input by label or selector | ⚡ | Browser form filling |
| `cdp_select_option` | Select dropdown option | ⚡ | Dropdowns and select elements |
| `cdp_evaluate` | Run JavaScript in page context | ⚡ | Custom DOM queries or page manipulation |
| `cdp_wait_for_selector` | Wait for element to appear | ⚡ | After navigation or AJAX loads |
| `cdp_list_tabs` | List all browser tabs | ⚡ | When CDP connected to wrong tab |
| `cdp_switch_tab` | Switch to a different tab | ⚡ | After cdp_list_tabs identifies the right one |

### Orchestration (4 tools)

| Tool | What it does | Tier | When to use |
|------|-------------|------|-------------|
| `open_app` | Launch an application by name | ⚡ | First step for desktop app tasks |
| `navigate_browser` | Open URL with CDP auto-enabled | ⚡ | First step for browser tasks |
| `wait` | Pause for N seconds | ⚡ | After opening apps or navigating — let UI render |
| `delegate_to_agent` | Send task to built-in autonomous agent (requires `clawdcursor start`) | 🟡 | Complex multi-step GUI tasks — agent has its own LLM reasoning, no need to plan each step |

---

## Section 6: Common Patterns

### Open an app and type

```
open_app("notepad")
wait(2)
smart_read()                   Confirm Notepad is open and focused
type_text("Hello world")
smart_read()                   Verify text was typed
```

### Browser task (navigate, read, interact)

```
navigate_browser("https://example.com")
wait(3)
cdp_connect()
cdp_page_context()             See interactive elements
cdp_read_text()                Read page content
cdp_click(text="Sign In")
```

### Fill a web form

```
cdp_connect()
cdp_page_context()
cdp_type(label="Email", text="user@example.com")
cdp_type(label="Password", text="...")
cdp_click(text="Submit")
wait(2)
cdp_read_text()                Verify submission result
```

### Cross-app copy/paste

```
focus_window("Chrome")
key_press("ctrl+a")
key_press("ctrl+c")
read_clipboard()               Get the copied text
focus_window("Notepad")
type_text(clipboard_content)
```

### Canvas editor (Google Docs, Figma)

```
navigate_browser("https://docs.google.com/document/create")
wait(3)
cdp_connect()
ocr_read_screen()              OCR — DOM text extraction fails on canvas
mouse_click(500, 400)          Click into the document body
type_text("Your text here")   Clipboard paste works on canvas
```

### Verify an action succeeded (example flow)

```
smart_click("Send", processId=PID)
wait(1)

# Method 1: Check return value — did smart_click find and click the element?
# Method 2: Window state — did a new dialog or confirmation appear?
get_windows()

# Method 3: Text check — is "Message sent" visible? Is the "Send" button gone?
read_screen(processId=PID)

# Method 4: Visual — take a screenshot if text methods are inconclusive
desktop_screenshot()

# Method 5: Negative — any error dialog? Wrong window in foreground?
get_active_window()
```

---

## Section 7: Safety

### Safety tiers

| Tier | Actions | Behavior |
|------|---------|----------|
| 🟢 Auto | Navigation, reading, opening apps | Runs immediately |
| 🟡 Preview | Typing, form filling | Logged before executing |
| 🔴 Confirm | Sending messages, deleting, purchases | Pauses for user approval |

### Rules

- **Never self-approve Confirm actions.** Always ask the user first.
- `Alt+F4` and `Ctrl+Alt+Delete` are **blocked** and will not execute.
- Server binds to **127.0.0.1 only** — not accessible from the network.
- First run requires **explicit user consent** for desktop control.
- All actions are logged.
- No telemetry, no analytics, no phone-home.

---

## Section 8: Error Recovery

| Problem | What to do |
|---------|-----------|
| Server not running (connection refused on :3847) | Run `clawdcursor serve` and wait 2 seconds |
| Chrome CDP not available (:9222) | `Start-Process chrome -ArgumentList "--remote-debugging-port=9222"` |
| CDP connects to wrong tab | Call `cdp_list_tabs()` then `cdp_switch_tab(target)` |
| `focus_window` fails | Try `mouse_click` on the window's title bar area, then `read_screen` to confirm |
| `smart_click` fails to find element | Fall back: `read_screen` to get coordinates, then `mouse_click(x, y)` |
| `smart_type` fails to find input | Fall back: `smart_click` on the input field, then `type_text(text)` |
| `cdp_read_text` returns empty (canvas app) | Use `ocr_read_screen()` instead |
| `key_press` goes to wrong window | You forgot `focus_window` — always focus first, then press keys |
| Agent returns "busy" | Wait for it to finish, or call `abort` and retry |
| Task completes but wrong result | Verify with `smart_read` or `read_screen`, then retry with more specific instructions |
| Same action fails 3+ times | Try a completely different approach — different tool, different target |

---

## Section 9: Coordinate System

All mouse tools use **image-space coordinates** based on a 1280px-wide viewport.
This matches the screenshots from `desktop_screenshot`. DPI scaling is handled
automatically. You do not need to worry about logical vs physical pixels.

---

## Section 10: Platform Support

| Platform | UI Automation | OCR | Browser (CDP) | Status |
|----------|---------------|-----|---------------|--------|
| **Windows** (x64/ARM64) | PowerShell + .NET UI Automation | Windows.Media.Ocr | Chrome/Edge | Full support |
| **macOS** (Intel/Apple Silicon) | JXA + System Events | Apple Vision framework | Chrome/Edge | Full support |
| **Linux** (x64/ARM64) | AT-SPI (planned) | Tesseract OCR | Chrome/Edge | Browser + OCR |

**macOS:** Grant Accessibility permission: System Settings > Privacy > Accessibility.
Install Xcode CLI tools if not present: `xcode-select --install`

**Linux:** Install Tesseract for OCR: `sudo apt install tesseract-ocr`

---

## Platform Notes

### macOS
- OCR may return empty for some apps — use `smart_read` or `read_screen` as alternatives
- CDP browser automation requires Chrome/Edge launched with --remote-debugging-port
- Use `open_app` to launch apps (uses macOS `open -a` internally)
- Coordinate scaling (Retina displays) is handled automatically by physicalToMouse()

---

## Troubleshooting

### delegate_to_agent returns "connection refused" or 404
The agent server is not running. Run `clawdcursor start` in a terminal first.
delegate_to_agent needs the server — other tools (smart_click, type_text, etc.) work without it.

### "Authentication failed (401)"
The server token changed. Run `clawdcursor stop && clawdcursor start` to regenerate.

### OCR returns empty on macOS
macOS OCR support requires additional setup. Try using `smart_read` instead which combines multiple perception methods.

### Coordinates seem off / clicks miss targets
clawdcursor handles DPI scaling automatically. If using raw coordinates from screenshots, they're in image-space — clawdcursor converts them. Don't pre-scale coordinates.

---

## Modes Summary

| Mode | Command | What it does | Who is the brain? | Cost |
|------|---------|-------------|-------------------|------|
| `serve` | `clawdcursor serve` | 40 tools via REST API, no LLM | Your AI model | Your calls only |
| `mcp` | `clawdcursor mcp` | 40 tools via MCP stdio, no LLM | Your AI model | Your calls only |
| `start` | `clawdcursor start` | Full autonomous agent + 40 tools | Built-in LLM pipeline | Varies by provider |
