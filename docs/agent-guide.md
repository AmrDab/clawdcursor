# clawd-cursor Agent Guide

> This document teaches AI models how to use clawd-cursor tools effectively.
> Include this in your system prompt or reference it when connecting to the tool server.

## What is clawd-cursor?

clawd-cursor is an OS-level desktop automation server. It gives you (the AI model)
eyes, hands, and ears on a real computer desktop. You can see the screen, click,
type, read UI elements, interact with browsers, and control any application.

**You are the brain. clawd-cursor is the body.**

## Quick Start

```
1. read_screen          → See what's on screen (text, fast, structured)
2. Decide what to do    → Your reasoning
3. Execute an action    → mouse_click, key_press, type_text, cdp_click, etc.
4. read_screen again    → Verify the action worked
5. Repeat until done
```

## Core Principles

### 1. Text First, Vision Second
Always call `read_screen` before `desktop_screenshot`. The accessibility tree is:
- **Fast**: ~100ms vs ~500ms for screenshot
- **Structured**: Named buttons, input fields, text values
- **Small**: A few KB of text vs a large image

Only use `desktop_screenshot` when:
- You need to see visual layout (charts, images, colors)
- The accessibility tree is empty or unhelpful (canvas apps, games)
- You need to verify visual state

### 2. CDP for Browsers, A11y for Native Apps
When working with a browser (Edge, Chrome):
- Call `navigate_browser` to open a URL with CDP enabled
- Call `cdp_connect` to establish the connection
- Use `cdp_click`, `cdp_type`, `cdp_read_text` for all interactions
- CDP is faster and more reliable than mouse clicks for web pages

When working with native apps (Notepad, Excel, File Explorer):
- Use `read_screen` to see the UI tree
- Use `mouse_click` at coordinates from the accessibility tree
- Use `key_press` for keyboard shortcuts
- Use `type_text` for entering text

### 3. Verify Every Action
After every action, read the screen again to confirm it worked.
Don't assume success — verify it.

```
Bad:  click "Save" → assume saved → done
Good: click "Save" → read_screen → confirm save dialog closed → done
```

### 4. Use Keyboard Shortcuts
Keyboard shortcuts are faster and more reliable than clicking:
- `ctrl+s` to save
- `ctrl+a` to select all
- `ctrl+c` / `ctrl+v` for copy/paste
- `ctrl+n` for new document
- `alt+tab` to switch windows
- `ctrl+w` to close tab
- `Return` to confirm dialogs

## Tool Categories

### Perception (see the screen)
| Tool | When to use |
|------|-------------|
| `read_screen` | Always start here. Returns accessibility tree. |
| `desktop_screenshot` | When you need visual confirmation or a11y tree is empty. |
| `desktop_screenshot_region` | Zoom into a specific area for detail. |
| `get_screen_size` | Get screen dimensions and DPI info. |
| `get_windows` | List all open windows. |
| `get_active_window` | Check which window has focus. |
| `get_focused_element` | Check which UI element has keyboard focus. |

### Actions (control the computer)
| Tool | When to use |
|------|-------------|
| `mouse_click` | Click a UI element at image-space coordinates. |
| `mouse_double_click` | Open files, select words. |
| `mouse_right_click` | Open context menus. |
| `mouse_scroll` | Scroll pages, lists, documents. |
| `mouse_drag` | Select text, move objects, resize. |
| `mouse_hover` | Reveal tooltips or hover menus. |
| `key_press` | Keyboard shortcuts and special keys. |
| `type_text` | Enter text into focused input. |

### Window Management
| Tool | When to use |
|------|-------------|
| `focus_window` | Bring a window to front (by name, PID, or title). |
| `find_element` | Search for a specific UI element by name or type. |
| `open_app` | Launch an application. |

### Browser (CDP)
| Tool | When to use |
|------|-------------|
| `navigate_browser` | Open a URL (launches browser with CDP). |
| `cdp_connect` | Connect to browser's DevTools Protocol. |
| `cdp_page_context` | List interactive elements (buttons, inputs, links). |
| `cdp_read_text` | Extract text from a page or element. |
| `cdp_click` | Click by CSS selector or visible text. |
| `cdp_type` | Type into input by selector or label. |
| `cdp_select_option` | Select dropdown option. |
| `cdp_evaluate` | Run arbitrary JavaScript. |
| `cdp_wait_for_selector` | Wait for element to appear. |
| `cdp_list_tabs` | List open browser tabs. |
| `cdp_switch_tab` | Switch to a different tab. |

### Clipboard
| Tool | When to use |
|------|-------------|
| `read_clipboard` | Read clipboard contents. |
| `write_clipboard` | Write text to clipboard. |

### Orchestration
| Tool | When to use |
|------|-------------|
| `delegate_to_agent` | Hand off complex task to autonomous pipeline. |
| `wait` | Pause after animations, page loads, transitions. |

## Common Patterns

### Open an app and type something
```
1. open_app("notepad")
2. wait(2)
3. type_text("Hello, world!")
```

### Search the web
```
1. navigate_browser("https://google.com")
2. cdp_connect()
3. cdp_type(selector: "textarea[name='q']", text: "clawd-cursor")
4. key_press("Return")
5. wait(2)
6. cdp_read_text()  → extract search results
```

### Copy text between apps
```
1. focus_window(processName: "msedge")
2. key_press("ctrl+a")   → select all
3. key_press("ctrl+c")   → copy
4. read_clipboard()       → verify content
5. focus_window(processName: "notepad")
6. key_press("ctrl+v")   → paste
```

### Fill out a web form
```
1. navigate_browser("https://example.com/form")
2. cdp_connect()
3. cdp_page_context()     → see all inputs
4. cdp_type(label: "Name", text: "John Doe")
5. cdp_type(label: "Email", text: "john@example.com")
6. cdp_select_option(selector: "#country", value: "US")
7. cdp_click(text: "Submit")
```

### Multi-app workflow (web research → document)
```
1. navigate_browser("https://en.wikipedia.org/wiki/Tokyo")
2. cdp_connect()
3. cdp_read_text(selector: "#mw-content-text")  → extract info
4. open_app("notepad")
5. wait(2)
6. type_text("Tokyo Research Notes\n\n" + extracted_info)
7. key_press("ctrl+s")
```

## Coordinate System

All mouse tools use **image-space coordinates** — these match the 1280px-wide
screenshots from `desktop_screenshot`. The server automatically converts to
the correct OS coordinates (handling DPI scaling).

You do NOT need to worry about DPI, physical pixels, or logical pixels.
Just use the coordinates you see in screenshots.

## Safety

- `alt+f4`, `ctrl+alt+delete` are blocked
- The server only binds to localhost (127.0.0.1)
- `type_text` uses clipboard paste (reliable, no dropped characters)
- All actions are logged

## Error Handling

If a tool returns `isError: true`:
1. Read the error message
2. Try an alternative approach
3. Don't repeat the same failing action more than twice

Common errors:
- "Not connected to CDP" → call `cdp_connect` first
- "No window found" → check `get_windows` for the correct process name
- "Click failed" → verify coordinates with `read_screen` or `desktop_screenshot`
