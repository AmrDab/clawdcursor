/**
 * PlatformAdapter — single contract for all platform-specific operations.
 *
 * Replaces scattered `if (IS_MAC) ... else ...` branching across 34 files.
 * Each platform implements this interface; business logic stays platform-free.
 *
 * Tranche 1A (v0.8.1-alpha): adds the primitives needed to unblock the
 * Tranche 1B / 2 MCP tools (mouseDown/mouseUp, keyDown/keyUp, middle click,
 * horizontal scroll, window-state / bounds control, display enumeration,
 * waitForElement, widened invokeElement actions, UI-element state flags).
 * Every change is ADDITIVE — existing signatures kept so no caller breaks.
 */

export interface ScreenSize {
  /** Physical pixels (what screenshots are captured at). */
  physicalWidth: number;
  physicalHeight: number;
  /** Logical pixels (what mouse coordinates use). */
  logicalWidth: number;
  logicalHeight: number;
  /** Physical / logical (e.g. 2.0 on Retina, 1.0 on standard). */
  dpiRatio: number;
}

/**
 * A physical display. `getScreenSize()` returns the primary display only —
 * `listDisplays()` returns every connected display so callers can target a
 * specific one for screenshots or mouse coordinates.
 */
export interface Display {
  /** Index (0 = primary). Stable per boot. */
  index: number;
  /** Human label (e.g. "Display 1", "Built-in Retina Display"). */
  label: string;
  /** Whether this is the primary / main display. */
  primary: boolean;
  /** Logical bounds — mouse-coordinate space. Can be negative for left-of-primary. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Physical (pixel) dimensions. */
  physicalSize: { width: number; height: number };
  /** Physical / logical scale. */
  dpiRatio: number;
}

export interface ScreenshotResult {
  /** PNG image buffer. */
  buffer: Buffer;
  /** Image dimensions (may differ from screen size if resized). */
  width: number;
  height: number;
  /** Multiplier to convert image coords back to physical screen coords. */
  scaleFactor: number;
  /** Top-left of the captured area, in the same capture pixels as `screenshot`'s `region` (physical: on a macOS Retina
   *  screen these are not the logical points mouse coordinates use); absent = (0,0). */
  origin?: { x: number; y: number };
}

export interface WindowInfo {
  title: string;
  processName: string;
  /** The app's own display name when the OS reports one apart from the process name (Windows: the exe's file
   *  description, "Designcenter NX" for ugraf.exe). macOS already gives the localized name as `processName`. */
  appName?: string;
  processId: number;
  /** Native window class when the platform reports it (Windows) — e.g. tells a
   *  console window from a GUI window owned by a shell process. */
  className?: string;
  bounds: { x: number; y: number; width: number; height: number };
  isMinimized: boolean;
  /** Platform-opaque handle for re-targeting. */
  handle?: number | string;
  /**
   * Windows: the app a frame window hosts. A UWP app's top-level window belongs to ApplicationFrameHost; the app
   * itself owns the `Windows.UI.Core.CoreWindow` child. Reported by the launch's Win32 window read, so the app is
   * known by identity and not by its (localized) title.
   */
  hostedProcessId?: number;
  hostedProcessName?: string;
  /** The hosted app's own display name ("Calculator"). `appName` carries it once the window is resolved (frame-host.ts). */
  hostedAppName?: string;
  /** True when this is the adapter's best guess at the window in front (Linux without xdotool), not what the OS said. */
  guessed?: boolean;
}

export interface UiElement {
  name: string;
  controlType: string;
  /** Platform subrole when present (macOS AX exposes e.g. "AXSecureTextField",
   *  "AXSearchField"); used to detect secureness and refine the role. */
  subrole?: string;
  /** Whether this is a password/secure field — its `value` is withheld. */
  secure?: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  /** Optional structured value (e.g. text field contents). */
  value?: string;
  /** The focused-element read only: `value` was read from the element itself, so an empty one is an empty field. */
  readable?: boolean;
  /** Whether the element is enabled and interactable. */
  enabled?: boolean;
  /** Whether the element currently has keyboard focus. */
  focused?: boolean;
  /** Whether the element is currently selected (list items, tabs, radios). */
  selected?: boolean;
  /** Element is in a disabled (grayed-out) state. Opposite of `enabled`. */
  disabled?: boolean;
  /** Element is marked busy (e.g. progress in-flight). */
  busy?: boolean;
  /** Element is off-screen / scrolled out of view. */
  offscreen?: boolean;
  /** Element supports expand/collapse (has an ExpandCollapse a11y pattern). */
  expandable?: boolean;
  /** Current expand state when `expandable` is true. */
  expanded?: boolean;
  /** Platform-opaque automation identifier (UIA AutomationId, AX identifier, AT-SPI name). */
  automationId?: string;
  /** Owning-process id when known. */
  processId?: number;
  /**
   * Human-readable description of the element when its primary `name` is
   * empty. UIA exposes this via `LocalizedControlType` / `HelpText`; AX
   * exposes it via `AXDescription` / `AXRoleDescription`; AT-SPI exposes
   * it via the `description` attribute. Many third-party macOS apps (Xcode
   * in particular) put their visible text in `AXDescription` rather than
   * `AXTitle`, so `name` arrives empty and the element looks anonymous to
   * the agent. Consumers should fall back through `name → description →
   * value → controlType` when rendering. Adapters populate when available;
   * undefined is acceptable (back-compat).
   *
   * Added 0.9.4 for issue #101 bug 5.
   */
  description?: string;
  /** What the app shows on hover, when the platform exposes it: UIA HelpText, AXHelp, the AT-SPI description. Set only when
   *  it differs from `name`; screen text, so quoted wherever it is shown (blind-hints.ts shownHelp). */
  help?: string;
  /** Checkbox / toggle state when the element supports toggling (UIA TogglePattern). */
  checked?: boolean | 'mixed';
  /**
   * Nesting depth in the tree getUiTree returned (0 = the window), when the
   * adapter knows it. Lets callers recover parent/child structure from the
   * flat list where geometry can't — e.g. scrolled-out elements with empty bounds.
   */
  depth?: number;
  /**
   * Inside an embedded document or web view (below a UIA Document, an AXWebArea, an AT-SPI document): its content, not the
   * app's own controls. read_tree lists the app's controls first (#383).
   */
  inDocument?: boolean;
}

export interface PermissionStatus {
  /** Can we send keyboard/mouse events to other apps? */
  input: boolean;
  /** Can we read window contents / accessibility tree? */
  accessibility: boolean;
  /** Can we capture the screen? */
  screenRecording: boolean;
}

/** Pointer button — extended in Tranche 1A to include middle click. */
export type MouseButton = 'left' | 'right' | 'middle';

/**
 * Result of the pre-click foreground promotion (Win32 WindowFromPoint +
 * SetForegroundWindow). `activated:false` means the OS refused to bring the
 * window at the click point to the foreground (foreground-lock) — the click
 * likely landed on a DIFFERENT window than intended, so the caller must warn
 * and not blindly send keystrokes next. `title`/`processName` identify the
 * window that was actually promoted/clicked.
 */
export interface FocusActivation {
  activated: boolean;
  title?: string;
  processName?: string;
  reason?: string;
  /** 'skipped-self-window' when the resolved window was a denylisted self/host
   *  window (agent hub, clawdcursor's own console) and was deliberately NOT
   *  raised — a stable code to branch on, vs. matching free-text `reason`. */
  action?: string;
}

/**
 * Scroll direction — extended in Tranche 1A to include horizontal. Windows
 * and macOS native wheel APIs support both axes; Linux X11 uses xdotool
 * buttons 6/7 or nut-js's `scrollLeft/scrollRight`; Wayland is iffy on
 * horizontal and degrades gracefully.
 */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Canonical window state verbs. `setWindowState('close')` is a polite
 * close request (WM_CLOSE / AXCloseAction / wmctrl -c) — the app MAY
 * prompt the user (e.g. "Save changes?") and refuse. Callers must not
 * assume the window was actually closed.
 */
export type WindowState = 'maximize' | 'minimize' | 'normal' | 'close';

/**
 * Invoke-element action union. Expanded in Tranche 1A to cover the UIA
 * ExpandCollapse / Toggle / Selection patterns that `ps-bridge.ps1`
 * already implements on Windows and that `invoke-element.jxa` now
 * implements on macOS. Linux returns `{success:false}` until the
 * AT-SPI bridge lands.
 */
export type InvokeAction =
  | 'click'
  | 'focus'
  | 'set-value'
  | 'get-value'
  | 'expand'
  | 'collapse'
  | 'toggle'
  | 'select';

export interface WaitForElementQuery {
  name?: string;
  controlType?: string;
  processId?: number;
  /** Poll interval in ms (default 250). */
  intervalMs?: number;
}

/**
 * Platform-agnostic interface every supported OS implements.
 *
 * Business logic uses this interface and never touches `process.platform`.
 */
export interface PlatformAdapter {
  /** OS family this adapter handles. */
  readonly platform: 'darwin' | 'win32' | 'linux';

  /**
   * Optional environment hint — Linux sets this to 'wayland' or 'x11' so
   * callers can surface graceful "not supported on Wayland" errors for
   * known-broken primitives (cursor queries, some global hotkeys).
   * Undefined on Windows and macOS.
   */
  readonly environment?: 'wayland' | 'x11';

  /** One-time setup (warm caches, start helpers). */
  init(): Promise<void>;

  /** Cleanup on shutdown. */
  shutdown(): Promise<void>;

  // ─── PERMISSIONS ────────────────────────────────────────────────
  checkPermissions(): Promise<PermissionStatus>;
  requestPermissions(): Promise<PermissionStatus>;

  // ─── DISPLAY ────────────────────────────────────────────────────
  /** Get the primary display geometry. */
  getScreenSize(): Promise<ScreenSize>;
  /**
   * List ALL connected displays. Tranche 1A primitive — unblocks
   * multi-monitor-aware screenshot and mouse targeting. Primary display
   * is always at index 0.
   */
  listDisplays(): Promise<Display[]>;
  /**
   * Capture the full screen as PNG. Optionally resize to maxWidth.
   * `displayIndex` (Tranche 1A) selects a specific display — 0 (default)
   * is primary. Passing an out-of-range index falls back to primary.
   */
  /** `region` captures that rectangle, in capture (physical) pixels — on macOS the Retina capture's pixels, not logical
   *  points, as the caller (tools/desktop.ts) passes them; `displayIndex` one monitor. */
  screenshot(opts?: { maxWidth?: number; displayIndex?: number; region?: { x: number; y: number; width: number; height: number } }): Promise<ScreenshotResult>;
  /** Capture a region of the screen. */
  screenshotRegion(x: number, y: number, w: number, h: number): Promise<ScreenshotResult>;

  // ─── WINDOWS ────────────────────────────────────────────────────
  listWindows(): Promise<WindowInfo[]>;
  getActiveWindow(): Promise<WindowInfo | null>;
  /** `handle`: the exact window (Windows). When given, nothing else in the query is used. */
  focusWindow(query: { processName?: string; processId?: number; title?: string; handle?: number }): Promise<boolean>;
  /**
   * Why the last `focusWindow` returned false, when the platform knows more than "no match" (macOS: the focus went to another
   * app, which it names). Taken once: a second call is null.
   */
  takeFocusFailure?(): string | null;

  /**
   * Legacy shim — preserved for back-compat. New code should call
   * `setWindowState('maximize')`. Default behavior unchanged.
   */
  maximizeWindow(): Promise<void>;

  /**
   * Canonical window-state control. Semantics (Tranche 1A):
   *   - 'maximize' — full-working-area size
   *   - 'minimize' — hide to taskbar/Dock
   *   - 'normal'   — restore from minimized/maximized to previous bounds
   *   - 'close'    — polite close request; app may prompt / refuse
   *
   * Target: the currently-focused window unless `query` is supplied.
   * Returns true when the request was accepted, NOT when the state
   * transition completed.
   */
  setWindowState(
    state: WindowState,
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean>;

  /**
   * Set the foreground (or matched) window's logical-pixel bounds.
   * Returns true when the request was accepted. No-op where the WM
   * refuses programmatic move/resize (some tiling Linux WMs).
   */
  setWindowBounds(
    bounds: { x?: number; y?: number; width?: number; height?: number },
    query?: { processName?: string; processId?: number; title?: string },
  ): Promise<boolean>;

  // ─── ACCESSIBILITY ──────────────────────────────────────────────
  getUiTree(processId?: number): Promise<UiElement[]>;
  /**
   * `automationId` (optional) matches the element's platform identifier exactly —
   * UIA AutomationId, macOS AXIdentifier. Adapters without the concept ignore it.
   */
  findElements(query: { name?: string; controlType?: string; automationId?: string; processId?: number }): Promise<UiElement[]>;
  /** Optional: the window scope(s) the last findElements searched, in order,
   *  so a "(no elements found)" result can say where it looked. */
  lastFindScope?: Array<{ processId?: number; processName?: string; title?: string }> | null;
  /** Optional: why the last findElements / getUiTree came back short, so tools
   *  can say "timed out" / "partial" instead of a bare "(no elements found)" —
   *  an empty-looking blind read is exactly when agents abandon a11y. */
  lastFindError?: 'timeout' | 'error' | 'partial' | null;
  /** Optional: the wording for a `partial` find (macOS: not found in the readable part of the window, N elements did not answer). */
  lastFindNote?: string | null;
  lastTreeTruncated?: boolean;
  /**
   * Optional: set when the last `listWindows` came back incomplete — a ready-to-print one-line note naming the apps whose
   * windows are missing (the time budget ran out before they were read; on macOS, also windows on another Space, #278).
   * Null/absent: the list is complete.
   */
  lastWindowListPartial?: string | null;
  /**
   * Optional (macOS): the warning, if any, from the keystrokes sent since it was last taken — e.g. that a modal dialog of
   * another app had the keyboard, so the keys went there. Taking it clears it. Tools append it to what they report.
   */
  takeInputWarning?(): string | null;
  /**
   * Optional: false when typeText would expose the text outside this process — e.g. a typing helper that takes it as a
   * command-line argument, visible in the process list. Callers then paste (verified, clipboard restored) instead of
   * typing anything sensitive. Absent = private.
   */
  typingIsPrivate?(): boolean;
  getFocusedElement(): Promise<UiElement | null>;
  /**
   * Optional: the whole text of the foreground window's document (a web page, an editor) read through accessibility
   * (Windows: UIA TextPattern) — no keystrokes, nothing selected, clipboard untouched. Null when it can't be read.
   */
  getPageText?(): Promise<{ text: string; name?: string } | null>;
  /**
   * Invoke an accessibility action on a named element. Action union
   * widened in Tranche 1A. Platforms that don't support a given action
   * return `{ success:false }` — no throw.
   */
  invokeElement(query: {
    name?: string;
    controlType?: string;
    /** Exact platform identifier (macOS AXIdentifier); adapters without it ignore it. */
    automationId?: string;
    processId?: number;
    action?: InvokeAction;
    value?: string;
    /** Of several elements of that name, the one inside the window / dialog / pane whose name contains this (#382). */
    within?: string;
  }): Promise<{
    success: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
    /** Action-specific payload, e.g. `{ value }` for get-value, `{ toggleState }` for toggle. On a by-name success, `target`:
     *  the element acted on and how its name matched (core/miss-text.ts targetOf). */
    data?: Record<string, unknown>;
  }>;

  /**
   * Optional: scroll an element that is inside its window but outside the visible part of it (below the fold of a web
   * page, past the end of a list) into view, using the platform's own call — UIA ScrollItemPattern.ScrollIntoView on
   * Windows, AXScrollToVisible on macOS, Component.scroll_to on Linux. Sends no input and never changes the foreground
   * window. The search is limited to the ACTIVE window (`windowHandle`, when known, must be it). `bounds` (screen space,
   * as last seen) picks the nearest of several elements that share a name; with several and no `bounds`, or a tie, the
   * platform REFUSES rather than pick one. On success `bounds` is where the element is NOW, and `name` / `role` are what
   * was scrolled, so the caller can check it is the element it meant. Absent: the platform cannot scroll an element
   * into view, and the caller says so instead of guessing.
   */
  scrollIntoView?(query: {
    name?: string;
    processId?: number;
    windowHandle?: number | string;
    bounds?: { x: number; y: number; width: number; height: number };
  }): Promise<{
    success: boolean;
    method?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    /** The scrolled element's accessibility name and role, as the platform reports them. */
    name?: string;
    role?: string;
    error?: string;
  }>;

  /**
   * Poll for an element to appear. Returns the first matching element or
   * null when `timeoutMs` elapses. Useful for waiting out transient UI
   * (dialogs, spinners). Tranche 1A primitive — lifted from
   * `action-router.ts`'s internal `waitForElement` helper.
   */
  waitForElement(query: WaitForElementQuery, timeoutMs: number): Promise<UiElement | null>;

  // ─── INPUT (mouse) ──────────────────────────────────────────────
  /** All coords are in LOGICAL pixels (mouse coordinate space).
   *  Returns a FocusActivation describing the window brought to the foreground
   *  at the click point (when the platform verifies it) so callers can WARN on
   *  a failed/ wrong-window activation; void/undefined when not verifiable. */
  mouseClick(x: number, y: number, opts?: { button?: MouseButton; count?: number }): Promise<FocusActivation | void>;
  mouseMove(x: number, y: number): Promise<void>;
  /**
   * Move relative to the current cursor position. On Wayland where
   * cursor-position queries are blocked, implementations SHOULD cache
   * the last target from `mouseMove`/`mouseClick` and offset from there;
   * if no cache is available, they return without error and log a
   * graceful-degradation warning.
   */
  mouseMoveRelative(dx: number, dy: number): Promise<void>;
  mouseDrag(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  mouseScroll(x: number, y: number, direction: ScrollDirection, amount?: number): Promise<void>;

  /**
   * Press a button without releasing. Pairs with `mouseUp`. Enables:
   *   - Hold modifier + click (Ctrl+click, Shift+click selection)
   *   - Multi-point drags (mouseDown at A, mouseMove through path, mouseUp at B)
   *   - Press-and-hold gestures
   */
  mouseDown(button?: MouseButton): Promise<void>;
  /** Release a previously-pressed button. No-op if nothing pressed. */
  mouseUp(button?: MouseButton): Promise<void>;

  // ─── INPUT (keyboard) ───────────────────────────────────────────
  typeText(text: string): Promise<void>;
  keyPress(combo: PortableKeyCombo): Promise<void>;

  /**
   * Press a key without releasing. Pairs with `keyUp`. Enables:
   *   - Hold shift while clicking
   *   - Gaming-style chord input
   *   - OS shortcuts that require precise down/up timing
   *
   * `key` accepts the same tokens as `keyPress` (e.g. "shift", "Return",
   * "F5", "a"). macOS implementation uses `System Events` "key down"; Win
   * and Linux use nut-js `keyboard.pressKey`.
   */
  keyDown(key: PortableKeyCombo): Promise<void>;
  /** Release a previously-pressed key. No-op if not currently down. */
  keyUp(key: PortableKeyCombo): Promise<void>;

  // ─── CLIPBOARD ──────────────────────────────────────────────────
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;

  // ─── APPS ───────────────────────────────────────────────────────
  /**
   * Convenience wrapper around `launchApp`. Platform adapters keep this
   * alias-data-agnostic — they DO NOT consult `APP_ALIASES`. Cross-OS
   * name mapping (e.g. Windows "Notepad" → mac "TextEdit") and UWP /
   * executable / searchTerm hints belong in the caller (the agent's
   * `open_app` tool, the router's `handleOpenApp`), which resolves the
   * alias and forwards the data through `launchApp` opts.
   */
  openApp(name: string, opts?: { alwaysNewInstance?: boolean }): Promise<{ pid?: number; title?: string }>;
  launchApp(name: string, opts?: {
    /**
     * `name` is an app name an agent typed, not one from the alias table: start it only if it resolves to an APP the OS
     * knows (Windows: PATH / the Start menu; macOS: LaunchServices; Linux: PATH / a .desktop entry). Never hand it to a shell that could read it as a URI or a file, and never type it into a launcher search
     * (Start menu, Spotlight), which opens the best match for the text — possibly a document. Not found → `{}`.
     */
    nameOnly?: boolean;
    alwaysNewInstance?: boolean;
    url?: string;
    cwd?: string;
    /** Windows UWP AppsFolder ID. Ignored on macOS and Linux. */
    uwpAppId?: string;
    /**
     * Human-friendly term used when the platform falls back to its native
     * search launcher (Windows Start Menu, macOS Spotlight). When omitted,
     * the launcher uses `name` with the `.exe` / `.app` suffix stripped —
     * which works for most apps but fails for cases like `msedge.exe`
     * where the binary name isn't indexed (Windows Search would surface
     * Microsoft Store as the closest match instead of Microsoft Edge).
     * `APP_ALIASES` provides a curated `searchTerm` per app for this.
     */
    searchTerm?: string;
    /**
     * Skip the Start-Menu / search-launcher fallback (Windows). When the
     * direct launch doesn't surface a window, return `{}` instead of typing
     * the name into the OS search box. Used by `open_file` for a path, where
     * the fallback would type "explorer" and open File Explorer at **Home**
     * instead of the requested folder — a false "Opened" with a side effect.
     */
    noStartMenuFallback?: boolean;
    /**
     * The app's known process names (the alias row's `processNames`: Calculator → CalculatorApp, Outlook → olk).
     * A window is reported as the app's — already running, or just launched — only by identity (app-identity.ts):
     * its process is `name` or one of these. Never because its title contains the name.
     */
    processNames?: readonly string[];
    /**
     * `name` only starts something else (open_file: explorer.exe opens the file with its own program). The
     * launcher's windows are then never the result: only a window of `processNames` is, and with none given no
     * window is reported at all. Implies `noStartMenuFallback`.
     */
    viaLauncher?: boolean;
    /**
     * `pid` without `title`: the app's process is running but it has shown no window yet (a slow starter) — started,
     * not failed. `processName` is that process when the adapter knows it, so the caller can point to a later focus.
     * `alreadyRunning`: that process was there before this launch, which was handed to it — running, not started.
     */
  }): Promise<{ pid?: number; title?: string; handle?: number | string; processName?: string; alreadyRunning?: boolean }>;
}

/**
 * Portable key combo spec — uses semantic modifiers, not platform names.
 *
 * "mod" resolves to Cmd on macOS, Ctrl on Windows/Linux.
 * "alt" stays "alt" on Windows/Linux, becomes "option" on macOS at the OS level.
 *
 * Examples:
 *   "mod+s"       — save (Cmd+S on mac, Ctrl+S elsewhere)
 *   "mod+shift+t" — reopen tab
 *   "Return"      — single key
 *   "shift+Tab"   — modifier + key
 */
export type PortableKeyCombo = string;
