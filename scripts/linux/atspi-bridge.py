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

    --cmd focused
        Return the currently-focused a11y element (or null).

    --cmd invoke --action A [--name N] [--role R] [--process-id N] [--value V]
        Act on the first element matching name/role (exact name match
        preferred over substring). A is one of click | focus | set-value |
        get-value | toggle | select | expand | collapse. Always returns the
        element's screen bounds (when found) so callers can fall back to a
        coordinate click: {"success": bool, "bounds": {...}, "value"?,
        "toggleState"?, "error"?}.

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


def safe(fn, default=None):
    """Call fn(), return default if it raises (stale ref, perm denied, etc.)."""
    try:
        return fn()
    except Exception:
        return default


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
        try:
            txt = acc.get_text_iface()
            if txt:
                char_count = txt.get_character_count()
                if char_count > 0:
                    value = txt.get_text(0, min(char_count, 512))
        except Exception:
            pass

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
    extents when the toolkit answers all zeros for SCREEN (seen with GTK4
    on X11). coord_type is 'screen' or 'window'."""
    try:
        comp = acc.get_component_iface()
    except Exception:
        comp = None
    if not comp:
        return (0, 0, 0, 0), 'screen'
    for ct, label in ((Atspi.CoordType.SCREEN, 'screen'), (Atspi.CoordType.WINDOW, 'window')):
        try:
            e = comp.get_extents(ct)
            rect = (int(e.x), int(e.y), int(e.width), int(e.height))
        except Exception:
            continue
        if any(rect):
            return rect, label
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


def active_application(process_id: Optional[int] = None) -> Optional[Any]:
    """Pick an Atspi.Accessible application root to walk.

    Without process_id: prefer the app whose name matches the active
    window title (heuristic — AT-SPI doesn't have a direct 'active app'
    concept). Fall back to the first app.
    """
    try:
        desktop = Atspi.get_desktop(0)
    except Exception:
        return None
    try:
        n = desktop.get_child_count()
    except Exception:
        return None

    # If caller supplied a pid, match on it.
    if process_id is not None:
        for i in range(n):
            app = safe(lambda i=i: desktop.get_child_at_index(i))
            if app is None:
                continue
            pid = safe(lambda app=app: app.get_process_id())
            if pid == process_id:
                return app
        return None

    # Heuristic: find the app that has a FOCUSED descendant.
    for i in range(n):
        app = safe(lambda i=i: desktop.get_child_at_index(i))
        if app is None:
            continue
        if has_focused_descendant(app):
            return app

    # Fallback: first app.
    return safe(lambda: desktop.get_child_at_index(0))


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


def focused_element() -> Optional[dict]:
    try:
        desktop = Atspi.get_desktop(0)
        n = desktop.get_child_count()
    except Exception:
        return None
    for i in range(n):
        app = safe(lambda i=i: desktop.get_child_at_index(i))
        if app is None: continue
        hit = _find_focused(app, 0)
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


# ── Command dispatch ─────────────────────────────────────────────

def cmd_get_tree(process_id: Optional[int]) -> dict:
    app = active_application(process_id)
    out: list = []
    if app is not None:
        walk(app, out)
    return {"elements": out, "truncated": len(out) > MAX_TREE_NODES}


def cmd_find(name: Optional[str], role: Optional[str], process_id: Optional[int]) -> dict:
    # Implement find as a post-filter over the tree walk — simpler than
    # deep-diving the collection interface and more predictable.
    tree = cmd_get_tree(process_id).get("elements", [])
    if name is None and role is None:
        return {"elements": tree}

    name_l = name.lower() if name else None
    role_l = role.lower() if role else None

    def matches(el: dict) -> bool:
        if name_l is not None:
            el_name = (el.get("name") or "").lower()
            if name_l not in el_name:
                return False
        if role_l is not None:
            el_role = (el.get("controlType") or "").lower()
            if role_l not in el_role:
                return False
        return True

    hits = [e for e in tree if matches(e)]
    return {"elements": hits}


def cmd_focused() -> dict:
    el = focused_element()
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


def find_target(app: Any, name: Optional[str], role: Optional[str]) -> Optional[Any]:
    """First accessible under `app` matching name (exact, else substring,
    case-insensitive) and role substring. Same depth/node caps as walk()."""
    name_l = name.lower() if name else None
    role_l = role.lower() if role else None
    exact: list = []
    partial: list = []

    def visit(acc: Any, depth: int) -> None:
        if acc is None or depth > MAX_TREE_DEPTH or exact or len(partial) > MAX_TREE_NODES:
            return
        n = (safe(lambda: acc.get_name(), '') or '').lower()
        r = (safe(lambda: acc.get_role_name(), '') or '').lower()
        if (role_l is None or role_l in r) and name_l is not None:
            if n == name_l:
                exact.append(acc)
                return
            if name_l in n:
                partial.append(acc)
        elif role_l is not None and name_l is None and role_l in r:
            partial.append(acc)
        count = safe(lambda: acc.get_child_count(), 0) or 0
        for i in range(count):
            visit(safe(lambda i=i: acc.get_child_at_index(i)), depth + 1)
            if exact:
                return

    visit(app, 0)
    if exact:
        return exact[0]
    return partial[0] if partial else None


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
            txt = safe(lambda: acc.get_text_iface())
            if txt:
                count = safe(lambda: txt.get_character_count(), 0) or 0
                out["success"], out["value"] = True, (safe(lambda: txt.get_text(0, count), '') or '')
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
               action: str, value: Optional[str]) -> dict:
    if not name and not role:
        return {"success": False, "action": action, "error": "name or role required"}
    app = active_application(process_id)
    if app is None:
        return {"success": False, "action": action, "error": "application not found"}
    target = find_target(app, name, role)
    if target is None:
        return {"success": False, "action": action, "error": f"element not found: {name or role}"}
    return perform_action(target, action, value)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--cmd', required=True, choices=['get-tree', 'find', 'focused', 'invoke'])
    p.add_argument('--name', default=None)
    p.add_argument('--role', default=None)
    p.add_argument('--process-id', type=int, default=None)
    p.add_argument('--action', default='click',
                   choices=['click', 'focus', 'set-value', 'get-value', 'toggle', 'select', 'expand', 'collapse'])
    p.add_argument('--value', default=None)
    args = p.parse_args()

    try:
        if args.cmd == 'get-tree':
            result = cmd_get_tree(args.process_id)
        elif args.cmd == 'find':
            result = cmd_find(args.name, args.role, args.process_id)
        elif args.cmd == 'focused':
            result = cmd_focused()
        elif args.cmd == 'invoke':
            result = cmd_invoke(args.name, args.role, args.process_id, args.action, args.value)
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
