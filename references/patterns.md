# clawdcursor reference: patterns

> Part of the clawdcursor skill. Worked call sequences (copy/paste between apps, web forms, Outlook, drawing on a canvas) and which granular tools each compound covers. The main rules are in [SKILL.md](../SKILL.md).

---

## Quick patterns

**Cross-app copy/paste** (no select-all: the page never turns blue):
```
window {"action":"focus","processName":"chrome"}
system {"action":"copy_all_text"}
window {"action":"focus","processName":"notepad"}
computer {"action":"type","text": <the text you need>}
```

**Read a webpage (DOM-level, no OCR):**
```
browser {"action":"navigate","url":"https://example.com"}
browser {"action":"read_text"}
```

**Fill a web form:**
```
browser {"action":"connect"}
browser {"action":"type","label":"Email","text":"user@x.com"}
browser {"action":"type","label":"Password","text":"..."}
browser {"action":"click","text":"Submit"}
```

**Send email via Outlook (native app):**
```
window {"action":"open_app","name":"Outlook"}
computer {"action":"wait","seconds":2}
accessibility {"action":"invoke","name":"New Email"}
accessibility {"action":"set_value","name":"To","value":"recipient@x.com"}
accessibility {"action":"set_value","name":"Subject","value":"Hi"}
accessibility {"action":"invoke","name":"Message"}
computer {"action":"type","text":"Body of the email"}
system {"action":"pause_for_user","message":"Send this email to recipient@x.com?","choices":["Yes, send","Not yet"]}   // ← unless the user already asked you to send it
accessibility {"action":"invoke","name":"Send"}
// verify: accessibility read_tree - is the sent-folder visible?
```

**Draw on a canvas (whiteboards such as Miro, FigJam, Excalidraw, tldraw, Freeform; Paint; a CAD viewport):**

The board has no names: `read_tree` shows the toolbar, and an `Opaque area` line for the board itself. Drive the toolbar by name and draw from a screenshot. A toolbar that `read_tree` lists only as panes (a CAD ribbon) is still pressed by its visible label with `accessibility {"action":"smart_click","target":"Extrude"}`, no screenshot; a screenshot and x,y are for points inside the drawn area.
1. **Import before drawing.** If the app builds a diagram from text (a Mermaid or text-to-diagram dialog, or pasting a diagram's source), use it: `system clipboard_write` + paste, then check once.
2. **Pick the tool by name** (`accessibility invoke`; `help="…"` on a `read_tree` line is the button's tooltip), then `computer wait` about 1 s: the first canvas click right after switching tools can be dropped.
3. **One screenshot, then one batch.** Shapes first, connectors second. Rectangles, ellipses and straight lines: the shape or line tool with `drag`. Pen points: one `click` with `path`. Never click an existing pen point again, as some pen tools drop that click and the next one.
4. **Check once:** `computer screenshot_region` of only the changed area with `max_edge` 512, plus `system ocr` for labels you typed.
5. **Take a new screenshot before the next group of strokes.** The board can pan between shapes, so old coordinates may point at empty canvas. Report what exists, and resume from the last check.

```json
batch({"steps":[
  {"name":"accessibility","arguments":{"action":"invoke","name":"Rectangle"}},
  {"name":"computer","arguments":{"action":"wait","seconds":1}},
  {"name":"computer","arguments":{"action":"drag","startX":300,"startY":200,"endX":460,"endY":280}},
  {"name":"accessibility","arguments":{"action":"invoke","name":"Pen"}},
  {"name":"computer","arguments":{"action":"wait","seconds":1}},
  {"name":"computer","arguments":{"action":"click","path":[{"x":500,"y":240},{"x":560,"y":240},{"x":560,"y":320}],"interval_ms":150}},
  {"name":"computer","arguments":{"action":"screenshot_region","x":280,"y":180,"width":320,"height":160,"max_edge":512}}
]})
```
The batch returns the region image with its trace, so drawing and checking take one call.

---

## Compound → granular action reference

When you need a specific action's full parameter list, look it up in the
granular surface. Every compact action delegates to exactly one granular tool
with the same semantics. Full reference via the MCP `tools/list` request.

| Compound | Covers granular tools |
|---|---|
| `computer`      | mouse_click, mouse_{double,right,middle,triple}_click, mouse_hover, mouse_move_relative, mouse_drag, mouse_drag_stepped, mouse_down, mouse_up, mouse_scroll, mouse_scroll_horizontal, type_text, key_press, key_down, key_up, wait, desktop_screenshot, desktop_screenshot_region |
| `accessibility` | read_screen, find_element, a11y_get_element, get_focused_element, invoke_element, focus_element, set_field_value, a11y_get_value, a11y_expand, a11y_collapse, a11y_toggle, a11y_select, get_element_state, a11y_list_children, wait_for_element |
| `window`        | get_windows, get_active_window, focus_window, maximize_window, minimize_window_to_taskbar, restore_window, close_window, resize_window, list_displays, get_screen_size, open_app, open_file, open_url, switch_tab_os, navigate_browser |
| `system`        | read_clipboard, write_clipboard, get_system_time, ocr_read_screen, undo_last, shortcuts_list, shortcuts_execute |
| `browser`       | cdp_connect, cdp_page_context, cdp_read_text, cdp_click, cdp_type, cdp_select_option, cdp_evaluate, cdp_wait_for_selector, cdp_list_tabs, cdp_switch_tab, cdp_scroll |
| `batch`         | ordered list of tool calls in one round-trip — see Execution playbook |
