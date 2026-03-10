# App Knowledge Base for Clawd Cursor

This file is loaded into the LLM's context when interacting with desktop apps.
It tells the AI what to expect from each app and how to operate it reliably.

---

## Startup Context — Verify Focus First

**Before doing anything else, check FOCUSED ELEMENT processName.**

The preprocessor opens and navigates the browser, but the terminal window may still hold keyboard focus when you receive control.

| FOCUSED WINDOW processName | Meaning | Action |
|---------------------------|---------|--------|
| `msedge` or `chrome` | Browser focused ✓ | Proceed with task |
| `olk` | Outlook focused ✓ | Proceed with task |
| `notepad`, `mspaint`, etc. | Correct app ✓ | Proceed with task |
| `windowsterminal`, `cmd`, `powershell` | **Wrong window** | Return needs_human with reason "wrong_window" |
| `explorer` | **Wrong window** | Return needs_human with reason "wrong_window" |

**Wrong-window response format:**
```json
{"action":"needs_human","reason":"wrong_window","description":"Focused window is windowsterminal. Edge has the target page loaded but does not have keyboard focus. Pipeline must re-focus msedge before I can act."}
```

The pipeline will re-focus the correct window and retry. Do NOT try to switch windows yourself.

---

## Startup Flow Rules

**The agent handles startup for you.** By the time you (the LLM) receive control, the app is already open, focused, and maximized. You do NOT need to:
- Press the Windows/Super key
- Type an app name in the Start menu
- Press Enter to launch
- Press Win+Up to maximize
- Press Alt+Tab to switch apps
- Call focus-window

**Your job starts AFTER the app is ready.** Read the IMPORTANT CONTEXT section — it tells you exactly what has already been done. For example:
- `Opened "Outlook" — it is ALREADY the active, focused, maximized window` means Outlook is ready
- `Compose window is OPEN. Cursor is in the To field` means you can start typing the email address immediately

### What to do on step 0
1. Read the IMPORTANT CONTEXT to understand what's already done
2. Read the FOCUSED ELEMENT to know where the cursor is right now
3. Read the UI TREE to see available elements (may be sparse for WebView2 apps)
4. Start executing from the FIRST action that hasn't been done yet

### What NEVER to do
- Do NOT press Alt+Tab, Super/Windows key, or other window-switching keys
- Do NOT try to reopen an app that's already open
- Do NOT press Ctrl+N multiple times — each press toggles compose open/closed
- Do NOT click on window titles, taskbar items, or Pane elements
- Do NOT repeat an action that's already in the ACTIONS TAKEN SO FAR list

---

## General Rules

1. **You are a screen reader operator.** Keyboard shortcuts and accessibility actions come FIRST. need_visual (vision) is the LAST resort — only use it if keyboard methods truly cannot reach the target.

2. **WebView2/Electron apps have minimal a11y trees.** You will see mostly Pane, Group, and Text elements. Interactive controls (buttons, inputs) are inside the web content and often invisible to UIAutomation. DO NOT a11y_click elements that don't appear in the tree — use keyboard shortcuts instead.

3. **When the a11y tree is sparse, use keyboard shortcuts.** Tab navigates between fields. Enter/Ctrl+Enter submits. Escape cancels. Alt/F10 opens menus. These work universally across all Windows apps.

4. **Trust the keyboard.** After typing text, it IS in the field even if the a11y tree doesn't show it. After pressing Tab, focus HAS moved to the next field. Do not repeat actions because the tree didn't update.

5. **Never click window titles or taskbar items.** These are not interactive UI elements. Use keyboard shortcuts instead.

6. **The FOCUSED ELEMENT section tells you exactly where the cursor is.** Always check this before typing to confirm you are in the right field.

7. **Check the ACTIONS TAKEN SO FAR list.** If an action says SUCCEEDED or ALREADY TYPED, it worked. Move to the NEXT step. Never repeat a succeeded action.

8. **One action per response.** Return exactly one JSON action. After execution, you'll get the updated UI state to decide the next action.

9. **Use the simplest action available.** Prefer key_press and type over a11y_click or need_visual. Keyboard shortcuts are faster and more reliable than clicking.

10. **Before using need_visual**, ask yourself: is there a keyboard shortcut for this? Can I Tab to it? Can I Alt+key open a menu? Only if ALL keyboard approaches fail, use need_visual.

---

## App-Specific Interaction Patterns

### When to use keyboard vs clicking
| Scenario | Use | Why |
|----------|-----|-----|
| WebView2 app (Outlook, Teams) | Keyboard shortcuts | a11y tree is empty, clicking fails |
| Native app (Notepad, Paint) | a11y_click on visible elements | Elements are in the tree with valid bounds |
| Form navigation | Tab between fields | Universal, reliable |
| Submit/Send | Ctrl+Enter or Enter | No need to find Send button |
| Cancel/Close | Escape or Alt+F4 | Universal |

### How to navigate fields
The pattern for filling out any form:
```
1. Check FOCUSED ELEMENT — confirms which field has focus
2. type "content"    — fills the current field
3. key_press "Tab"   — moves to next field
4. type "content"    — fills that field
5. Repeat until done
6. key_press "ctrl+Return" or "Return" — submit
```

Do NOT try to click individual fields. Tab navigation is reliable across all apps.

---

## Outlook (New) -- process: `olk`

### What it is
Outlook (new) is a WebView2 wrapper. The a11y tree shows almost nothing -- just Panes and a TitleBar. You CANNOT see buttons, input fields, or email content in the tree.

### Process identity
- Outlook runs as process `olk` but its WebView2 content runs under `msedge`
- The FOCUSED ELEMENT may show pid for either process -- both are correct
- If Edge also has Outlook Web open, shortcuts may go to the wrong window
- The agent handles focusing the correct process before you get control

### How to operate it
**USE KEYBOARD SHORTCUTS ONLY. Do not try to click UI elements via a11y.**

### Compose Email Flow (step by step)
```
BEFORE STARTING: Check FOCUSED ELEMENT.
  - If it shows ControlType.Group name="To" className="EditorClass" -> compose IS open, go to step 2
  - If it shows anything else -> press Ctrl+N to open compose, wait 2s, then go to step 2
  - If FOCUSED ELEMENT shows "To" with existing content -> press Ctrl+A then Delete to clear, then type

1. key_press "ctrl+n"   -> Opens compose window (SKIP if compose is already open)
                           Wait for FOCUSED ELEMENT to show "To" group before continuing.
                           Do NOT press Ctrl+N again — each press toggles compose open/closed.

2. type "user@example.com"  -> Type the recipient's email address into the To field.
                                Even if the a11y tree doesn't show the text, it IS there.

3. key_press "Tab"      -> Moves focus To -> Cc (or directly to Subject in some configs)
                           Check FOCUSED ELEMENT: if it shows "Cc", press Tab again to skip to Subject.

4. type "subject text"  -> Type the subject line.

5. key_press "Tab"      -> Moves focus Subject -> Body.

6. type "body text"     -> Type the full email body. Use \n for newlines.
                           Write a REAL message — not a placeholder.

7. key_press "ctrl+Return"  -> SENDS the email immediately.
                               After this, return {"action":"done","evidence":"Sent email to [address] via Ctrl+Enter keyboard shortcut in Outlook"}
                               DO NOT second-guess this. The email IS sent. The tree will not update — that is normal.
```

### Critical: When to return "done"
After pressing `ctrl+Return` to send, **immediately return done**. Do NOT:
- Wait for the tree to update (it won't)
- Try to verify by checking the window title (may or may not change)
- Press Ctrl+Return again (would open a new compose)

The evidence string should be: `"Sent email to [address] with subject '[subject]' via Ctrl+Enter"`

### Important Notes
- Ctrl+N only works when the Outlook (olk) window has focus. The agent ensures this before handing off.
- Do NOT press Ctrl+N if compose is already open — check FOCUSED ELEMENT first.
- After sending, the a11y tree will still show Panes — this is NORMAL. Trust the keyboard sequence.

### Keyboard Shortcuts
| Action | Shortcut |
|--------|----------|
| New email | Ctrl+N |
| Send | Ctrl+Enter |
| Reply | Ctrl+R |
| Reply All | Ctrl+Shift+R |
| Forward | Ctrl+F |
| Search | F3 or Ctrl+E |
| Delete | Delete |
| Mark read/unread | Ctrl+Q / Ctrl+U |
| Flag message | Insert |

### What the a11y tree looks like
```
FOCUSED WINDOW UI TREE:
  [ControlType.Window] "Mail - amr dabbas - Outlook"
    [ControlType.Pane]    <-- many nested empty panes (WebView2 structure)
      [ControlType.Pane]
        [ControlType.Pane] "Mail - amr dabbas - Outlook - Web content"
          [ControlType.Pane]
            [ControlType.Text] "Untitled"
            [ControlType.Button] "Minimize"
            [ControlType.Button] "Maximize"
            [ControlType.Button] "Close"
    [ControlType.TitleBar] "Mail - amr dabbas - Outlook"
```
This is ALL you get. No mail list, no compose fields, no buttons. Keyboard only.

---

## Microsoft Edge -- process: `msedge`

### What it is
Chromium-based browser. Has a rich a11y tree for browser chrome but web page content varies.

### Important
- Ctrl+N opens a NEW BROWSER WINDOW (not related to Outlook)
- Ctrl+L focuses the address bar
- Ctrl+T opens a new tab
- If Outlook Web is open in Edge, keyboard shortcuts may conflict. Always ensure the correct process (olk vs msedge) has focus.

### Interacting with web pages — CDP FIRST

When **CDP PAGE CONTEXT** is shown in your UI STATE, the page DOM is directly accessible.
**Use cdp_click/cdp_type — they are faster and more reliable than Tab navigation for React/SPA pages.**

CDP action examples:
```
{"action":"cdp_click","by_text":"Compose","description":"open compose window"}
{"action":"cdp_type","by_label":"To","text":"user@example.com","description":"type recipient"}
{"action":"cdp_type","selector":"[aria-label='Subject']","text":"Meeting","description":"type subject"}
{"action":"checkpoint","description":"verify we navigated to results page"}
```

When CDP PAGE CONTEXT is NOT shown (CDP unavailable), use a11y tree or Tab navigation:
- `[ControlType.Edit]` or `[ControlType.Document]` → a11y_set_value or a11y_focus then type
- `[ControlType.Button]` with a name → a11y_click to activate
- `[ControlType.Hyperlink]` → a11y_click to follow

When filling a search form (no CDP):
1. a11y_focus the "From" or origin field
2. type the city/airport name
3. Tab to the next field and type
4. Tab to the date field, type or use arrow keys
5. Tab to the Submit/Search button, press Enter or Space

### Keyboard Shortcuts
| Action | Shortcut |
|--------|----------|
| New window | Ctrl+N |
| New tab | Ctrl+T |
| Close tab | Ctrl+W |
| Address bar | Ctrl+L or F6 |
| Find in page | Ctrl+F |
| Refresh | F5 or Ctrl+R |
| Back | Alt+Left |
| Forward | Alt+Right |
| Next interactive element | Tab |
| Previous interactive element | Shift+Tab |

---

## Google Docs -- process: `msedge`

### What it is
Google Docs (docs.google.com) is a web app running in Edge/Chrome. It uses a custom canvas renderer — most elements are NOT in the a11y tree. NEVER use a11y_click or a11y_focus — they will hang or crash.

### Key URLs
- `docs.google.com` — homepage (list of documents, "Blank" template at top)
- `docs.google.com/document/create` — INSTANTLY creates a new blank document (USE THIS)
- `docs.google.com/document/d/{id}/edit` — editing an existing document

### Creating a new document
The preprocessor navigates to `docs.google.com/document/create` which opens a blank doc directly.
- You will see the doc title "Untitled document" and a blinking cursor in the body
- The document body is ready for typing — just use `type` action
- Do NOT press Ctrl+N (that opens a new browser tab, NOT a new Google Doc)
- Do NOT try to click "Blank" or "File > New" — the create URL handles this

### Writing/composing content
When the task says "write a sentence about X" or "write about X":
1. You are a language model — COMPOSE the text yourself
2. Use `{"action":"type","text":"Your composed sentence here.","description":"typing composed content"}`
3. The text should be original, relevant, and well-written
4. After typing, verify the text appears in CDP PAGE CONTEXT
5. THEN declare done with the actual text as evidence

### With CDP (preferred)
- `cdp_type selector ".kix-appview-editor" text="content"` — type in document body
- OR just use `{"action":"type","text":"content"}` — keyboard input goes to focused doc
- `cdp_click by_text="File"` — open File menu
- `cdp_click by_text="Share"` — open share dialog

### Common mistakes (NEVER do these)
- Ctrl+N → opens browser tab, NOT Google Doc
- a11y_click anything → hangs/crashes (canvas rendering)
- Declaring done without typing content → BLOCKED by pipeline
- Typing the task instruction literally (e.g. "a sentence on dogs") instead of composing actual content

---

## Notepad -- process: `notepad`

### a11y tree
Rich and reliable. Edit field shows full content via ValuePattern.

### How to operate
Notepad has a full a11y tree. You CAN use a11y_click, a11y_set_value, and a11y_focus on its elements. But keyboard shortcuts are still faster for common operations.

### Keyboard Shortcuts
| Action | Shortcut |
|--------|----------|
| New file | Ctrl+N |
| Open | Ctrl+O |
| Save | Ctrl+S |
| Save As | Ctrl+Shift+S |
| Find | Ctrl+F |
| Replace | Ctrl+H |
| Select All | Ctrl+A |

---

## Paint -- process: `mspaint`

### a11y tree
Has toolbar buttons visible. Canvas is a single Pane element.

### How to draw
1. Select tool via a11y_click on toolbar button (e.g., "Pencil", "Brush")
2. Use mouse actions (click, drag) on the canvas coordinates
3. Color selection via a11y_click on color palette buttons

---

## File Explorer -- process: `explorer`

### How to operate
- Ctrl+L focuses the address bar (type a path and press Enter to navigate)
- Tab cycles between navigation pane, file list, and address bar
- F2 renames the selected file
- Delete moves selected file to Recycle Bin
- Enter opens the selected file/folder

---

## General Windows Shortcuts (work in all apps)

| Action | Shortcut |
|--------|----------|
| Copy | Ctrl+C |
| Cut | Ctrl+X |
| Paste | Ctrl+V |
| Undo | Ctrl+Z |
| Redo | Ctrl+Y |
| Select All | Ctrl+A |
| Save | Ctrl+S |
| Print | Ctrl+P |
| Close window | Alt+F4 |
| Switch app | Alt+Tab |
| Task Manager | Ctrl+Shift+Escape |
| Screenshot | Win+Shift+S |

---

## TripAdvisor -- process: `msedge`

### What it is
TripAdvisor (tripadvisor.com) is a React SPA. Its Flights tab redirects to Google Flights — EXPECTED behavior. Hotels, restaurants, and attractions are handled on TripAdvisor itself.

### Task: "Book cheapest flight from [city]"
TripAdvisor Flights opens Google Flights. Follow the Google Flights section below.
1. If already on tripadvisor.com — cdp_click by_text "Flights" or navigate directly to google.com/travel/flights
2. If redirected to google.com/flights — continue with the Google Flights flow
3. For "cheapest flight" with no destination → use Explore view (see Google Flights section)

### Task: "Find hotel / restaurant / attraction"
1. Use cdp_type by_label "Search" to enter the search query
2. Use cdp_click to select from autocomplete
3. Read CDP PAGE CONTEXT for results (ratings, prices, addresses)
4. done — report the top result with relevant details

### NEVER DO
- a11y_click or a11y_focus (React SPA, will hang)
- Return needs_human because destination is missing — use Explore on Google Flights

---

## Google Flights -- process: `msedge`

### What it is
Google Flights (google.com/flights or google.com/travel/explore) is a React SPA. The a11y tree will HANG if UIA calls are made on it. NEVER use a11y_click or a11y_focus — they time out (45 seconds). Use CDP or keyboard-only.

### IMPORTANT
- TripAdvisor Flights redirects to Google Flights — EXPECTED. Continue on Google Flights.
- The page loads in ~3 seconds. Give it time before interacting.
- NEVER call a11y_click or a11y_focus on any Google Flights element.
- NEVER call checkpoint when CDP is unavailable — it causes a loop.

### NO DESTINATION in the task?
If the task says "find flights from X" with NO destination specified:
- Use the **Explore view**: `cdp_click selector "[aria-label='Explore destinations']"` OR `cdp_click by_text "Explore"`
- Explore shows cheapest flights from your origin to ALL destinations — no destination required
- Set origin, read CDP PAGE CONTEXT for destination cards with prices and earliest dates
- Report the earliest departure in your `done` evidence
- Do NOT return needs_human and do NOT pick an arbitrary destination — Explore solves this

### WITH CDP PAGE CONTEXT (preferred)

**Origin + destination search:**
```
1. key_press "Escape"                               — dismiss any popup
2. cdp_type by_label "Where from?" "Los Angeles"    — set origin (city name)
3. key_press "Down" then "Return"                   — confirm autocomplete
4. cdp_type by_label "Where to?" "New York"         — set destination
5. key_press "Down" then "Return"                   — confirm autocomplete
6. cdp_click by_text "Search"                       — submit
7. Read CDP PAGE CONTEXT for flight results
8. done — report earliest/cheapest flight with price, airline, date
```

**No-destination (Explore) search:**
```
1. key_press "Escape"
2. cdp_click selector "[aria-label='Explore destinations']"  (OR cdp_click by_text "Explore")
3. cdp_type by_label "Where from?" "Los Angeles"
4. key_press "Down" then "Return"
5. Read CDP PAGE CONTEXT for destination cards
6. done — report top 3 results: destination, date, price
```

**Reading results:** CDP PAGE CONTEXT has flight cards with price, date, airline.
- "soonest flight" → report earliest departure date
- "cheapest flight" → report lowest price
- Report both if ambiguous

### WITHOUT CDP (keyboard fallback)

Only use if CDP PAGE CONTEXT is NOT shown.

```
1. key_press "Escape"
2. key_press "Tab" (×2)       — reach origin field
3. type "Los Angeles"
4. key_press "Down" then "Return"
5. key_press "Tab"            — move to destination
6. type "New York"            — REQUIRED — cannot leave blank on keyboard path
7. key_press "Down" then "Return"
8. key_press "Tab" (×4)       — reach Search button
9. key_press "Return"         — submit
10. key_press "Tab" (repeat)  — read FOCUSED ELEMENT for prices/times
```

Tab order: Round trip → Origin → Destination → Depart → Return → Passengers → Class → Search

### NEVER DO
- a11y_click / a11y_focus on any element (timeouts + UIA hangs)
- checkpoint when CDP is unavailable (loop)
- Leave destination blank on keyboard path (form errors)
- Pick an arbitrary destination — use Explore instead

---

## Unknown / Unlisted Apps

When you encounter an app not listed in this knowledge base, use this universal exploration strategy:

### Step 1 — Read the a11y tree
Look for:
- Named **Buttons** → a11y_click them
- Named **Edit** or **Document** fields → a11y_focus then type
- Named **MenuItem** or **Menu** → a11y_click to open
- Named **TabItem** → a11y_click to switch tab

### Step 2 — Open the menu bar
Press **Alt** or **F10** to open the app's menu bar. Then:
- Arrow keys navigate menu items
- Enter opens a submenu or activates an item
- Escape closes the menu

### Step 3 — Use Tab navigation
- **Tab** moves focus to the next interactive control
- **Shift+Tab** moves backwards
- **Enter** or **Space** activates the focused control
- Check FOCUSED ELEMENT after each Tab to know where you are

### Step 4 — Common universal shortcuts
| Action | Shortcut |
|--------|----------|
| Open menu | Alt or F10 |
| Find/Search | Ctrl+F |
| Save | Ctrl+S |
| Open | Ctrl+O |
| New | Ctrl+N |
| Close | Ctrl+W or Alt+F4 |
| Undo | Ctrl+Z |
| Select all | Ctrl+A |
| Copy | Ctrl+C |
| Paste | Ctrl+V |
| Help | F1 |
| Close dialog | Escape |

### Step 5 — Only then, need_visual
If you've tried a11y interaction, keyboard shortcuts, and Tab navigation and still cannot proceed, use need_visual with a concise target description.

---

## Error Recovery

### "Element not found" errors
The element doesn't exist in the a11y tree. This is NORMAL for WebView2 apps. Use keyboard shortcuts instead.

### Compose window won't open
1. The agent already tried to open it -- check IMPORTANT CONTEXT
2. If it says compose is open, trust it and start typing
3. If you must try Ctrl+N: press it ONCE only, wait 2 seconds, check FOCUSED ELEMENT

### Actions seem to go to the wrong app
Check the FOCUSED ELEMENT section -- the pid tells you which process has focus. If it's not the target app, report "unsure" so the agent can re-focus.

### Text typed but not visible in a11y tree
This is normal for WebView2 apps. The text IS in the field. Trust the keyboard and move to the next step.

### Action failed -- what to try next
1. If a11y_click failed -> try key_press with a keyboard shortcut instead
2. If key_press didn't work -> try a different shortcut (e.g., Ctrl+Enter vs Alt+S for send)
3. If type didn't work -> check FOCUSED ELEMENT to see if you're in the right field
4. After 2 failures on the same target -> report "unsure" to let the agent try a different approach

### Stuck in a loop
If you see the same UI state 3+ times, you are stuck. Do NOT repeat the same action.
Try: different keyboard shortcut, report "unsure", or report "done" if the task is actually complete.
