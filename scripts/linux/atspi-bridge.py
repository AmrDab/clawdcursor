#!/usr/bin/env python3
"""
AT-SPI bridge — read-only first pass (Tranche 4b).

Wraps GNOME's AT-SPI D-Bus a11y API via gobject-introspection's Atspi
binding. Used by LinuxAdapter to answer getUiTree / findElements /
getFocusedElement when the host is a Linux box with at-spi2 running
(every modern GNOME / KDE session with accessibility enabled).

Contract: same JSON shape as scripts/ps-bridge.ps1 (Windows) and
scripts/mac/*.jxa (macOS) — one JSON blob to stdout, exit 0 on
success, exit 1 with {"error": "..."} on failure.

Commands:
    --cmd get-tree [--process-id N]
        Walk the a11y tree of the active window (or the given process
        when --process-id is set). Returns a flat list of elements.

    --cmd find [--name N] [--role R] [--process-id N]
        Find elements matching a name substring and/or role. Returns
        a flat list.

    --cmd focused [--process-id N]
        Return the currently-focused a11y element (or null).

    --cmd invoke --action A [--name N] [--role R] [--process-id N] [--value V]
        Act on the best element matching name/role (exact name match
        preferred over substring, on-screen over hidden). A is one of click |
        focus | set-value | get-value | toggle | select | expand | collapse.
        Returns the element's screen bounds (when found and visible) so
        callers can fall back to a coordinate click: {"success": bool,
        "bounds": {...}, "value"?, "toggleState"?, "error"?, "notVisible"?}.

    Every command also takes --window-title T in place of --process-id for
    an active window that sets no _NET_WM_PID.

Dependencies:
    python3 (3.6+) with:
      - python3-gi          (Debian/Ubuntu) or equivalent
      - gir1.2-atspi-2.0    (Debian/Ubuntu) or libatspi / atspi

Dependency probe runs on the Node side (`hasBinary('python3')` +
a `python3 -c "from gi.repository import Atspi"` check). When the
probe fails, the LinuxAdapter's a11y methods keep returning empty
gracefully — same behavior as before this bridge existed.

Safety: every AT-SPI call is wrapped in try/except so one bad
element (stale reference, permission denial, app process died)
doesn't take down the whole tree walk.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Optional

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi  # type: ignore[import-not-found]
except Exception as exc:
    sys.stdout.write(json.dumps({
        "error": "pyatspi/gi.repository.Atspi not available",
        "detail": str(exc),
        "hint": "apt-get install python3-gi gir1.2-atspi-2.0  (or distro equivalent)",
    }))
    sys.exit(1)


# ── Helpers ────────────────────────────────────────────────────────

MAX_TREE_DEPTH = 12
MAX_TREE_NODES = 800   # stop after this many elements to bound cost
INTERACTIVE_ROLES = {
    # Roles whose state/value the agent is most likely to care about.
    # Used to prefer these over structural containers when truncating.
    'push button', 'toggle button', 'check box', 'radio button',
    'menu item', 'check menu item', 'radio menu item',
    'link', 'hyperlink',
    'text', 'entry', 'password text', 'editable text', 'combo box',
    'list item', 'tree item', 'tab',
    'slider', 'spin button', 'scroll bar',
}


INT_MIN = -2147483648   # AT-SPI extents of children scrolled out of a viewport
NAMELESS_NOISE_ROLES = {'list item', 'table row'}


def safe(fn, default=None):
    """Call fn(), return default if it raises (stale ref, perm denied, etc.)."""
    try:
        return fn()
    except Exception:
        return default


def read_text(acc: Any, limit: Optional[int] = None) -> Optional[str]:
    """Contents of the Text interface, or None when acc has none.

    PyGObject's get_text_iface() hands back the Accessible itself, and on an
    Accessible `.get_text` is the deprecated no-argument getter, not
    Text.get_text(start, end) — so `txt.get_text(0, n)` raised and every text
    view / entry read as empty. Call the interface functions explicitly."""
    if not safe(lambda: acc.get_text_iface()):
        return None
    count = safe(lambda: Atspi.Text.get_character_count(acc), 0) or 0
    if limit is not None:
        count = min(count, limit)
    if count <= 0:
        return ''
    return safe(lambda: Atspi.Text.get_text(acc, 0, count), '') or ''


def is_showing(acc: Any) -> bool:
    """On screen right now: SHOWING + VISIBLE (or an unknown/empty state set,
    GTK4) and a non-zero size. Closed menus and hidden toolbars fail this."""
    ss = safe(lambda: acc.get_state_set())
    if ss is not None and not safe(lambda: ss.is_empty(), False):
        if not (safe(lambda: ss.contains(Atspi.StateType.SHOWING), False)
                and safe(lambda: ss.contains(Atspi.StateType.VISIBLE), False)):
            return False
    (_, _, w, h), _ = element_bounds(acc)
    return w > 0 and h > 0


def toplevels_active_first(app: Any) -> list:
    """The app's toplevel windows, the ACTIVE one (the window the user is in,
    e.g. a Save dialog over its main window) first."""
    count = safe(lambda: app.get_child_count(), 0) or 0
    kids = [k for k in (safe(lambda i=i: app.get_child_at_index(i)) for i in range(count)) if k is not None]
    return ([k for k in kids if has_state(k, Atspi.StateType.ACTIVE)]
            + [k for k in kids if not has_state(k, Atspi.StateType.ACTIVE)])


def node_to_dict(acc: Any) -> Optional[dict]:
    """
    Convert an Atspi.Accessible node into the shared UiElement JSON shape.
    Returns None when the node lacks both a name AND a role — skip those.
    """
    if acc is None:
        return None
    name = safe(lambda: acc.get_name(), '') or ''
    role_name = safe(lambda: acc.get_role_name(), '') or ''
    if not name and not role_name:
        return None

    # Bounds via Component interface. Missing → zero rect.
    bounds, coord_type = element_bounds(acc)
    x, y, w, h = bounds

    # State flags
    focused = False
    enabled: Optional[bool] = True
    selected = False
    busy = False
    offscreen = False
    try:
        ss = acc.get_state_set()
        if ss is not None:
            if safe(lambda: ss.is_empty(), False):
                # Some toolkits (GTK4 under at-spi2 caching) answer with an
                # EMPTY state set rather than their real states. Report the
                # flags as unknown instead of "disabled + offscreen".
                enabled = None
            else:
                focused  = ss.contains(Atspi.StateType.FOCUSED)
                # ENABLED and SENSITIVE both mean "accepts input"; GTK3 sets
                # both, other toolkits set only one. Requiring both reported
                # every GTK4 widget as disabled.
                enabled  = ss.contains(Atspi.StateType.ENABLED) or ss.contains(Atspi.StateType.SENSITIVE)
                selected = ss.contains(Atspi.StateType.SELECTED)
                busy     = ss.contains(Atspi.StateType.BUSY)
                offscreen = not ss.contains(Atspi.StateType.VISIBLE) or not ss.contains(Atspi.StateType.SHOWING)
    except Exception:
        pass

    # Value via Value or Text interface (whichever applies).
    value = None
    try:
        v = acc.get_value_iface()
        if v:
            value = str(v.get_current_value())
    except Exception:
        pass
    if value is None:
        # A label's text IS its name; repeating it as the value is noise.
        value = read_text(acc, 512) or None
        if value is not None and value == name:
            value = None

    # Process id
    pid = None
    try:
        pid = acc.get_process_id()
    except Exception:
        pass

    # AutomationId analogue — Atspi exposes "accessible-id" on some apps.
    automation_id = safe(lambda: acc.get_accessible_id(), None)

    out = {
        "name": name,
        "controlType": role_name,
        "bounds": {"x": x, "y": y, "width": w, "height": h},
        "value": value,
        "enabled": enabled,
        "focused": focused,
        "selected": selected,
        "disabled": not enabled if enabled is not None else None,
        "busy": busy,
        "offscreen": offscreen,
        "processId": pid,
        "automationId": automation_id,
    }
    if coord_type == 'window':
        # Bounds are relative to the toplevel; LinuxAdapter offsets them by
        # the window origin it already knows from wmctrl.
        out["coordType"] = 'window'
    return out


def element_bounds(acc: Any):
    """(x, y, w, h), coord_type — SCREEN extents, falling back to WINDOW
    extents when the toolkit has no screen position (GTK4 on X11 answers
    SCREEN as all zeros, or as 0,0 with the real size). coord_type is
    'screen' or 'window'."""
    try:
        comp = acc.get_component_iface()
    except Exception:
        comp = None
    if not comp:
        return (0, 0, 0, 0), 'screen'
    rects = {}
    for ct, label in ((Atspi.CoordType.SCREEN, 'screen'), (Atspi.CoordType.WINDOW, 'window')):
        try:
            e = comp.get_extents(ct)
            rects[label] = (int(e.x), int(e.y), int(e.width), int(e.height))
        except Exception:
            pass
    screen, window = rects.get('screen'), rects.get('window')
    # A SCREEN origin of exactly 0,0 is GTK4 not knowing where its surface
    # is; WINDOW extents plus the window origin are right either way (for a
    # window really at the screen origin the offset is zero).
    if screen and any(screen) and not (screen[0] == 0 and screen[1] == 0 and window and any(window)):
        return screen, 'screen'
    if window and any(window):
        return window, 'window'
    return (0, 0, 0, 0), 'screen'


def walk(acc: Any, out: list, depth: int = 0) -> None:
    """Depth-first flatten with caps on depth + total node count."""
    if acc is None: return
    if depth > MAX_TREE_DEPTH: return
    if len(out) > MAX_TREE_NODES: return

    node = node_to_dict(acc)
    if node is not None:
        out.append(node)

    try:
        child_count = acc.get_child_count()
    except Exception:
        return
    for i in range(child_count):
        try:
            child = acc.get_child_at_index(i)
        except Exception:
            continue
        walk(child, out, depth + 1)
        if len(out) > MAX_TREE_NODES: return


def active_application(process_id: Optional[int] = None,
                       window_title: Optional[str] = None,
                       exclude_pids: Optional[set] = None) -> Optional[Any]:
    """Pick an Atspi.Accessible application root to walk.

    process_id wins. Else window_title (the active window's title, for a
    window that sets no _NET_WM_PID): the app owning a toplevel of that name,
    else the app owning the ACTIVE toplevel, else None — never some other
    app. With neither: the ACTIVE toplevel's app, then the legacy
    focused-descendant heuristic, then the first app. exclude_pids: apps that
    own a DIFFERENT window with the same title (xcalc and GNOME Calculator are
    both "Calculator") — never chosen by title.
    """
    try:
        desktop = Atspi.get_desktop(0)
    except Exception:
        return None
    try:
        n = desktop.get_child_count()
    except Exception:
        return None
    apps = [a for a in (safe(lambda i=i: desktop.get_child_at_index(i)) for i in range(n)) if a is not None]

    # If caller supplied a pid, match on it.
    if process_id is not None:
        for app in apps:
            pid = safe(lambda app=app: app.get_process_id())
            if pid == process_id:
                return app
        return None

    if window_title:
        if exclude_pids:
            apps = [a for a in apps if safe(lambda a=a: a.get_process_id()) not in exclude_pids]
        for app in apps:
            for top in toplevels_active_first(app):
                if (safe(lambda top=top: top.get_name(), '') or '') == window_title:
                    return app

    for app in apps:
        tops = toplevels_active_first(app)
        if tops and has_state(tops[0], Atspi.StateType.ACTIVE):
            return app
    if window_title:
        return None

    # Heuristic: find the app that has a FOCUSED descendant.
    for app in apps:
        if has_focused_descendant(app):
            return app

    # Fallback: first app.
    return apps[0] if apps else None


def has_focused_descendant(acc: Any, depth: int = 0) -> bool:
    if acc is None or depth > 6:
        return False
    try:
        ss = acc.get_state_set()
        if ss is not None and ss.contains(Atspi.StateType.FOCUSED):
            return True
    except Exception:
        pass
    try:
        n = acc.get_child_count()
    except Exception:
        return False
    for i in range(n):
        child = safe(lambda i=i: acc.get_child_at_index(i))
        if has_focused_descendant(child, depth + 1):
            return True
    return False


def focused_element(process_id: Optional[int] = None,
                    window_title: Optional[str] = None,
                    exclude_pids: Optional[set] = None) -> Optional[dict]:
    """The focused element of the active app (scoped by pid / window title
    when given), searching its ACTIVE window first. Toolkits keep FOCUSED on
    the last-focused widget of inactive windows and apps, so an unscoped
    first-hit search answered with another app's element."""
    if process_id is not None or window_title:
        app = active_application(process_id, window_title, exclude_pids)
        apps = [app] if app is not None else []
    else:
        try:
            desktop = Atspi.get_desktop(0)
            n = desktop.get_child_count()
        except Exception:
            return None
        apps = [a for a in (safe(lambda i=i: desktop.get_child_at_index(i)) for i in range(n)) if a is not None]
        active = active_application()
        if active is not None and active in apps:
            apps = [active] + [a for a in apps if a is not active]
    for app in apps:
        for top in toplevels_active_first(app):
            hit = _find_focused(top, 1)
            if hit is not None:
                return node_to_dict(hit)
    return None


def _find_focused(acc: Any, depth: int) -> Optional[Any]:
    if acc is None or depth > 12: return None
    try:
        ss = acc.get_state_set()
        if ss is not None and ss.contains(Atspi.StateType.FOCUSED):
            return acc
    except Exception:
        pass
    try:
        n = acc.get_child_count()
    except Exception:
        return None
    for i in range(n):
        hit = _find_focused(safe(lambda i=i: acc.get_child_at_index(i)), depth + 1)
        if hit is not None:
            return hit
    return None


# ── Command: page-text ───────────────────────────────────────────
# The whole text of the active window's document — what a screen reader reads — with no keystrokes: nothing is
# selected and the clipboard is not touched (copy_all_text used Ctrl+A / Ctrl+C, which left the page highlighted).

EMBEDDED = '￼'
BLOCK_ROLES = ('paragraph', 'heading', 'section', 'list item', 'table row', 'form', 'article', 'block quote',
               'document web', 'document text', 'document frame', 'separator')


def full_text(acc: Any, depth: int = 0, budget: Optional[list] = None) -> str:
    """Text of `acc` with every embedded-object character replaced by its child's own text (Chromium and Gecko put
    links, paragraphs and frames into the parent's text as U+FFFC)."""
    if budget is None:
        budget = [200_000]                       # nodes, so a huge page cannot run away
    if acc is None or depth > 60 or budget[0] <= 0:
        return ''
    budget[0] -= 1
    text = read_text(acc, 2_000_000)
    n = safe(lambda: acc.get_child_count(), 0) or 0
    children = [safe(lambda i=i: acc.get_child_at_index(i)) for i in range(n)]
    if text is None:                              # no Text interface: concatenate the children
        parts = [full_text(c, depth + 1, budget) for c in children]
        return '\n'.join(p for p in parts if p)
    if EMBEDDED not in text:
        return text
    out, k = [], 0
    for ch in text:
        if ch == EMBEDDED and k < len(children):
            child = children[k]
            k += 1
            inner = full_text(child, depth + 1, budget)
            role = safe(lambda: child.get_role_name(), '') or ''
            out.append(f'\n{inner}\n' if role in BLOCK_ROLES else inner)
        elif ch != EMBEDDED:
            out.append(ch)
    return ''.join(out)


def _first_document(acc: Any, depth: int) -> Optional[Any]:
    if acc is None or depth > 25:
        return None
    role = safe(lambda: acc.get_role_name(), '') or ''
    if role.startswith('document') and safe(lambda: acc.get_text_iface()):
        return acc
    n = safe(lambda: acc.get_child_count(), 0) or 0
    for i in range(n):
        hit = _first_document(safe(lambda i=i: acc.get_child_at_index(i)), depth + 1)
        if hit is not None:
            return hit
    return None


def cmd_page_text(process_id: Optional[int], window_title: Optional[str] = None,
                  exclude_pids: Optional[set] = None) -> dict:
    app = active_application(process_id, window_title, exclude_pids)
    if app is None:
        return {"error": "no active application"}
    tops = toplevels_active_first(app)
    if not tops:
        return {"error": "the active application has no window"}
    top = tops[0]
    focused = _find_focused(top, 1)
    # The document holding the focus. A text box on a web page is part of the page: the page is what is read.
    doc, a, hops = None, focused, 0
    while a is not None and hops < 60:
        role = safe(lambda: a.get_role_name(), '') or ''
        if role.startswith('document') and safe(lambda: a.get_text_iface()):
            doc = a
            break
        a = safe(lambda: a.get_parent())
        hops += 1
    # A native editor with the focus (not inside a page): its own text.
    if doc is None and focused is not None and has_state(focused, Atspi.StateType.EDITABLE) \
            and not has_state(focused, Atspi.StateType.SINGLE_LINE):
        text = read_text(focused, 2_000_000)
        if text:
            return {"text": text, "name": safe(lambda: focused.get_name(), '') or ''}
    if doc is None:
        doc = _first_document(top, 1)
    if doc is None:
        return {"error": "no document with text in the active window"}
    text = full_text(doc)
    if not text.strip():
        return {"error": "the document has no text"}
    return {"text": text.strip(), "name": safe(lambda: doc.get_name(), '') or ''}


# ── Command dispatch ─────────────────────────────────────────────

def on_screen(el: dict) -> bool:
    b = el.get("bounds") or {}
    return (not el.get("offscreen") and b.get("width", 0) > 0 and b.get("height", 0) > 0
            and b.get("x", 0) > INT_MIN and b.get("y", 0) > INT_MIN)


def cmd_get_tree(process_id: Optional[int], window_title: Optional[str] = None,
                 exclude_pids: Optional[set] = None) -> dict:
    app = active_application(process_id, window_title, exclude_pids)
    out: list = []
    if app is not None:
        root = node_to_dict(app)
        if root is not None:
            out.append(root)
        # The active window (a dialog over its main window) is walked first.
        for top in toplevels_active_first(app):
            walk(top, out, 1)
            if len(out) > MAX_TREE_NODES:
                break
    truncated = len(out) > MAX_TREE_NODES
    # Useful elements first: on-screen ones in document order, then the hidden
    # rest (closed menus and hidden toolbars report 0x0 and used to fill the
    # top of the list). Nameless, valueless rows carry nothing to act on —
    # their labelled children are kept.
    out = [e for e in out if not (e.get("controlType") in NAMELESS_NOISE_ROLES
                                  and not e.get("name") and not e.get("value"))]
    shown = [e for e in out if on_screen(e)]
    hidden = [e for e in out if not on_screen(e)]
    return {"elements": shown + hidden, "truncated": truncated}


def cmd_find(name: Optional[str], role: Optional[str], process_id: Optional[int],
             window_title: Optional[str] = None, exclude_pids: Optional[set] = None) -> dict:
    # Implement find as a post-filter over the tree walk — simpler than
    # deep-diving the collection interface and more predictable.
    tree = cmd_get_tree(process_id, window_title, exclude_pids).get("elements", [])
    if name is None and role is None:
        return {"elements": tree}

    name_l = name.lower() if name else None
    roles = role_alternatives(role)

    def matches(el: dict) -> bool:
        if name_l is not None:
            el_name = (el.get("name") or "").lower()
            if name_l not in el_name:
                return False
        if roles is not None and not role_matches(roles, (el.get("controlType") or "").lower()):
            return False
        return True

    hits = [e for e in tree if matches(e)]
    return {"elements": hits}


def cmd_focused(process_id: Optional[int] = None, window_title: Optional[str] = None,
                exclude_pids: Optional[set] = None) -> dict:
    el = focused_element(process_id, window_title, exclude_pids)
    return {"element": el}


# ── Invoke (action dispatch) ─────────────────────────────────────

# Action-name preference per verb. AT-SPI action names are free-form per
# toolkit: GTK3 buttons expose "click"/"press"/"release", GTK4 "click",
# Qt "Press", Chromium "press"/"click"/"activate", menu items "click".
ACTION_NAMES = {
    'click':    ('click', 'press', 'activate', 'jump', 'toggle', 'select'),
    'toggle':   ('toggle', 'click', 'press', 'activate'),
    'select':   ('select', 'click', 'press', 'activate'),
    'expand':   ('expand', 'click', 'press', 'activate'),
    'collapse': ('collapse', 'click', 'press', 'activate'),
}


def role_alternatives(role: Optional[str]) -> Optional[list]:
    """--role "text|entry|password text" → ['text', 'entry', 'password text'].
    One clawdcursor type maps to several AT-SPI roles (Edit: a GTK text view is
    "text", a Chrome/GTK field is "entry"); a single substring missed some."""
    if not role:
        return None
    alts = [a.strip() for a in role.lower().split('|') if a.strip()]
    return alts or None


def role_matches(alts: list, role_name: str) -> bool:
    return any(a in role_name for a in alts)


def find_target(app: Any, name: Optional[str], role: Optional[str]):
    """(accessible, showing) for the best match under `app`: name exact
    (case-insensitive, padding ignored) before substring, role substring;
    ON-SCREEN matches before hidden ones, the ACTIVE window's before the
    rest. A hidden 0x0 duplicate (a hidden toolbar's "Save" vs the Save
    dialog's button) used to win just by coming first in the tree.
    (None, False) when nothing matches."""
    name_l = name.lower().strip() if name else None
    roles = role_alternatives(role)
    exact: list = []
    partial: list = []

    def visit(acc: Any, depth: int) -> bool:
        """True once the best possible hit (exact + showing) is found."""
        if acc is None or depth > MAX_TREE_DEPTH or len(partial) > MAX_TREE_NODES:
            return False
        n = (safe(lambda: acc.get_name(), '') or '').lower().strip()
        r = (safe(lambda: acc.get_role_name(), '') or '').lower()
        if (roles is None or role_matches(roles, r)) and name_l is not None:
            if n == name_l:
                exact.append(acc)
                if is_showing(acc):
                    return True
            elif name_l in n:
                partial.append(acc)
        elif roles is not None and name_l is None and role_matches(roles, r):
            partial.append(acc)
        count = safe(lambda: acc.get_child_count(), 0) or 0
        for i in range(count):
            if visit(safe(lambda i=i: acc.get_child_at_index(i)), depth + 1):
                return True
        return False

    # Active window first, so document order already ranks it ahead.
    for top in toplevels_active_first(app):
        if visit(top, 1):
            return exact[-1], True
    for group in (exact, partial):
        for acc in group:
            if is_showing(acc):
                return acc, True
    for group in (exact, partial):
        if group:
            return group[0], False
    return None, False


def do_named_action(acc: Any, verb: str) -> Optional[str]:
    """Run the first Action whose name matches the preference list for
    `verb`; falls back to action 0. Returns the action name used, or None
    when the element exposes no Action interface."""
    act = safe(lambda: acc.get_action_iface())
    if not act:
        return None
    count = safe(lambda: act.get_n_actions(), 0) or 0
    if count <= 0:
        return None
    names = [((safe(lambda i=i: act.get_action_name(i), '') or '').lower()) for i in range(count)]
    for want in ACTION_NAMES.get(verb, ACTION_NAMES['click']):
        for i, have in enumerate(names):
            if have == want:
                if safe(lambda i=i: act.do_action(i), False):
                    return have
                return None
    if safe(lambda: act.do_action(0), False):
        return names[0] or 'action0'
    return None


def has_state(acc: Any, state: Any) -> bool:
    ss = safe(lambda: acc.get_state_set())
    return bool(ss is not None and safe(lambda: ss.contains(state), False))


def perform_action(acc: Any, action: str, value: Optional[str]) -> dict:
    out: dict = {"success": False, "action": action}
    bounds, _ = element_bounds(acc)
    out["bounds"] = {"x": bounds[0], "y": bounds[1], "width": bounds[2], "height": bounds[3]}

    if action == 'click':
        used = do_named_action(acc, 'click')
        if used is None:
            out["error"] = "element exposes no Action interface"
        else:
            out["success"], out["method"] = True, used

    elif action == 'focus':
        comp = safe(lambda: acc.get_component_iface())
        if comp and safe(lambda: comp.grab_focus(), False):
            out["success"] = True
        else:
            out["error"] = "grab_focus failed"

    elif action == 'set-value':
        if value is None:
            out["error"] = "value required for set-value"
        else:
            et = safe(lambda: acc.get_editable_text_iface())
            if et and safe(lambda: et.set_text_contents(value), False):
                out["success"], out["method"] = True, "EditableText"
            else:
                vi = safe(lambda: acc.get_value_iface())
                try:
                    num = float(value)
                except ValueError:
                    num = None
                if vi and num is not None and safe(lambda: vi.set_current_value(num), False):
                    out["success"], out["method"] = True, "Value"
                else:
                    # Leave the field focused so the caller can type into it.
                    comp = safe(lambda: acc.get_component_iface())
                    if comp:
                        safe(lambda: comp.grab_focus())
                    out["error"] = "element exposes neither EditableText nor Value"

    elif action == 'get-value':
        vi = safe(lambda: acc.get_value_iface())
        if vi:
            out["success"], out["value"] = True, str(safe(lambda: vi.get_current_value(), ''))
        else:
            text = read_text(acc)
            if text is not None:
                out["success"], out["value"] = True, text
            else:
                # Combo boxes / lists: the value is the selected item's name. GTK
                # puts the Selection on the combo or on its popup-menu child.
                chosen = None
                for holder in (acc, safe(lambda: acc.get_child_at_index(0))):
                    sel = safe(lambda: holder.get_selection_iface()) if holder else None
                    if sel and (safe(lambda: sel.get_n_selected_children(), 0) or 0) > 0:
                        chosen = safe(lambda: sel.get_selected_child(0))
                        if chosen:
                            break
                if chosen:
                    out["success"], out["value"] = True, (safe(lambda: chosen.get_name(), '') or '')
                else:
                    out["error"] = "element exposes neither Value nor Text"

    elif action == 'toggle':
        used = do_named_action(acc, 'toggle')
        if used is None:
            out["error"] = "element exposes no Action interface"
        else:
            on = has_state(acc, Atspi.StateType.CHECKED) or has_state(acc, Atspi.StateType.PRESSED)
            out["success"], out["method"], out["toggleState"] = True, used, ("On" if on else "Off")

    elif action == 'select':
        parent = safe(lambda: acc.get_parent())
        sel = safe(lambda: parent.get_selection_iface()) if parent else None
        idx = safe(lambda: acc.get_index_in_parent(), -1)
        if sel and idx is not None and idx >= 0 and safe(lambda: sel.select_child(idx), False):
            out["success"], out["method"] = True, "Selection"
        else:
            used = do_named_action(acc, 'select')
            if used is None:
                out["error"] = "no Selection interface on parent and no Action"
            else:
                out["success"], out["method"] = True, used

    elif action in ('expand', 'collapse'):
        want = action == 'expand'
        if has_state(acc, Atspi.StateType.EXPANDED) == want:
            out["success"], out["method"] = True, "already"
        else:
            used = do_named_action(acc, action)
            if used is None:
                out["error"] = "element exposes no Action interface"
            else:
                out["success"], out["method"] = True, used

    else:
        out["error"] = f"unknown action: {action}"
    return out


def cmd_invoke(name: Optional[str], role: Optional[str], process_id: Optional[int],
               action: str, value: Optional[str], window_title: Optional[str] = None,
               exclude_pids: Optional[set] = None) -> dict:
    if not name and not role:
        return {"success": False, "action": action, "error": "name or role required"}
    app = active_application(process_id, window_title, exclude_pids)
    if app is None:
        return {"success": False, "action": action, "error": "application not found"}
    target, showing = find_target(app, name, role)
    if target is None:
        return {"success": False, "action": action, "error": f"element not found: {name or role}"}
    if not showing and action != 'get-value':
        # Acting on a hidden element (closed menu, hidden toolbar, 0x0) and
        # calling it a success is how a Save dialog went unsaved. No bounds:
        # a coordinate fallback onto a hidden element is just as wrong.
        return {"success": False, "action": action, "notVisible": True,
                "error": f"element '{name or role}' exists but is not visible on screen "
                         "(hidden or 0x0, e.g. in a closed menu) — nothing was done"}
    return perform_action(target, action, value)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--cmd', required=True, choices=['get-tree', 'find', 'focused', 'invoke', 'page-text'])
    p.add_argument('--name', default=None)
    p.add_argument('--role', default=None)
    p.add_argument('--process-id', type=int, default=None)
    # Scope for an active window that sets no _NET_WM_PID (no pid to pass).
    p.add_argument('--window-title', default=None)
    # With --window-title: pids of OTHER windows that carry the same title.
    p.add_argument('--exclude-pids', default='')
    p.add_argument('--action', default='click',
                   choices=['click', 'focus', 'set-value', 'get-value', 'toggle', 'select', 'expand', 'collapse'])
    p.add_argument('--value', default=None)
    args = p.parse_args()
    excl = {int(x) for x in args.exclude_pids.split(',') if x.strip().isdigit()}

    try:
        if args.cmd == 'get-tree':
            result = cmd_get_tree(args.process_id, args.window_title, excl)
        elif args.cmd == 'find':
            result = cmd_find(args.name, args.role, args.process_id, args.window_title, excl)
        elif args.cmd == 'focused':
            result = cmd_focused(args.process_id, args.window_title, excl)
        elif args.cmd == 'page-text':
            result = cmd_page_text(args.process_id, args.window_title, excl)
        elif args.cmd == 'invoke':
            result = cmd_invoke(args.name, args.role, args.process_id, args.action, args.value,
                                args.window_title, excl)
        else:
            result = {"error": f"unknown command: {args.cmd}"}
    except Exception as exc:
        result = {"error": str(exc)}
        sys.stdout.write(json.dumps(result))
        return 1

    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
