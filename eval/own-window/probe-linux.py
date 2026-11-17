#!/usr/bin/env python3
"""own-window probe, Linux X11 part (plan step 1; measurement only, no product change).

Question: which apps accept input addressed to a BACKGROUND window while a "user" window stays in front?

Setup: a "user" Mousepad window (/tmp/probe-user.txt, "user-was-here") is activated and in front.
Targets: a second Mousepad window, Chrome on a temp page, a tiny GTK3 app written by this script.
For each target x method it records whether the effect landed (AT-SPI readback or window title), whether the
active window changed, whether the real pointer moved and whether the user window's text changed.

Methods (text "hello@1!"):
  M0 AT-SPI EditableText.set_text_contents      (rung R0)
  M1 AT-SPI EditableText.insert_text at caret
  M2 xdotool type --window W                    (XSendEvent)
  M3 xdotool key  --window W, per char          (XSendEvent)
  M4 AT-SPI Action.do_action on the button      (rung R0 for clicks)
  M5 xdotool mousemove --window W x y; click --window W 1   (moves the REAL pointer; recorded honestly)
  C2/C5 CONTROL experiments: xdotool windowfocus --sync W, then plain type / click (XTEST). These are
        expected to change the active window; they show what a focus-taking burst (R2) costs.

Only processes launched here are touched (by pid / process group), and all are killed in a finally block.
Run on the Linux test VM, not on a dev box. See README-linux.md.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TEXT = "hello@1!"
USER_TEXT = "user-was-here"
USER_FILE = "/tmp/probe-user.txt"
TARGET_FILE = "/tmp/probe-target.txt"
SESSION_ENV = "/tmp/session.env"
SETTLE = 0.4  # seconds to let the app process synthetic input before reading back

# xdotool key names for the characters of TEXT
KEYSYM = {"@": "at", "!": "exclam"}

METHODS = [
    ("M0", "text", "AT-SPI set_text_contents (R0)"),
    ("M1", "text", "AT-SPI insert_text at caret"),
    ("M2", "text", "xdotool type --window (XSendEvent)"),
    ("M3", "text", "xdotool key --window per char (XSendEvent)"),
    ("M4", "click", "AT-SPI do_action click/press (R0)"),
    ("M5", "click", "xdotool mousemove --window + click --window"),
    ("C2", "text", "CONTROL: windowfocus --sync + xdotool type (XTEST)"),
    ("C5", "click", "CONTROL: windowfocus --sync + mousemove + click (XTEST)"),
]
X11_ONLY = {"M2", "M3", "M5", "C2", "C5"}

TARGETS = {
    "mousepad": {"label": "Mousepad (2nd window)", "hint": "probe-target.txt", "text": True, "click": False,
                 "multiline": True, "doc_scope": False},
    "chrome": {"label": "Chrome (HTML page)", "hint": "probe-page", "text": True, "click": True,
               "multiline": False, "doc_scope": True},
    "gtk3": {"label": "GTK3 test app", "hint": "probe-gtk", "text": True, "click": True,
             "multiline": False, "doc_scope": False},
}

HTML = """<!doctype html><title>probe-page</title>
<input id=t autofocus>
<button id=b onclick="document.title='CLICKED'">go</button>
<button id=r onclick="document.title='probe-page'">reset</button>
"""

GTK_APP = """import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
w = Gtk.Window(title="probe-gtk")
w.set_default_size(320, 140)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
w.add(box)
box.add(Gtk.Entry())
go = Gtk.Button(label="go")
go.connect("clicked", lambda *_: w.set_title("CLICKED"))
box.add(go)
rs = Gtk.Button(label="reset")
rs.connect("clicked", lambda *_: w.set_title("probe-gtk"))
box.add(rs)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"""


# --------------------------------------------------------------------------- environment / process helpers

def load_session_env():
    """Fill DISPLAY / DBUS_SESSION_BUS_ADDRESS from /tmp/session.env when unset."""
    if os.environ.get("DISPLAY") and os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        return
    try:
        for line in Path(SESSION_ENV).read_text().splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if "=" not in line or line.startswith("#"):
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'\"")
            if k in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS") and not os.environ.get(k):
                os.environ[k] = v
    except OSError:
        pass


def is_wayland():
    return os.environ.get("XDG_SESSION_TYPE") == "wayland" or (
        bool(os.environ.get("WAYLAND_DISPLAY")) and not os.environ.get("DISPLAY"))


def run(cmd, timeout=5):
    """Returns (rc, stdout). rc -9 on timeout, -1 if the binary is missing."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip()
    except subprocess.TimeoutExpired:
        return -9, ""
    except OSError:
        return -1, ""


def proc_table():
    """{pid: (ppid, pgrp)} from /proc."""
    out = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            rest = Path(f"/proc/{name}/stat").read_text().rsplit(")", 1)[1].split()
            out[int(name)] = (int(rest[1]), int(rest[2]))
        except (OSError, IndexError, ValueError):
            pass
    return out


def family_pids(root_pid):
    """root_pid, its process group and all descendants: everything this script launched."""
    table = proc_table()
    pids = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, pgrp) in table.items():
            if pid not in pids and (ppid in pids or pgrp == root_pid):
                pids.add(pid)
                changed = True
    return pids


class Launched:
    def __init__(self, cmd, env=None):
        self.cmd = cmd
        self.p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, start_new_session=True, env=env)
        self.seen = {self.p.pid}

    def pids(self):
        self.seen |= family_pids(self.p.pid)
        return set(self.seen)

    def kill(self):
        self.pids()
        try:
            os.killpg(self.p.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        end = time.time() + 2
        while time.time() < end and self.p.poll() is None:
            time.sleep(0.1)
        for pid in sorted(self.seen):  # only pids we derived from our own launch
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            self.p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


# --------------------------------------------------------------------------- xdotool wrapper

class Xdo:
    def __init__(self, enabled):
        self.enabled = enabled

    def _o(self, *a, timeout=4):
        if not self.enabled:
            return None
        rc, out = run(["xdotool", *a], timeout)
        return out if rc == 0 else None

    def active(self):
        return self._o("getactivewindow")

    def pointer(self):
        out = self._o("getmouselocation", "--shell")
        if not out:
            return None
        kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
        try:
            return (int(kv["X"]), int(kv["Y"]))
        except (KeyError, ValueError):
            return None

    def name(self, win):
        return self._o("getwindowname", win) if win else None

    def search_pid(self, pid):
        out = self._o("search", "--onlyvisible", "--pid", str(pid))
        return out.split() if out else []

    def search_name(self, hint):
        out = self._o("search", "--onlyvisible", "--name", hint)
        return out.split() if out else []

    def geometry(self, win):
        out = self._o("getwindowgeometry", "--shell", win)
        if not out:
            return None
        kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
        try:
            return {k: int(kv[k]) for k in ("X", "Y", "WIDTH", "HEIGHT")}
        except (KeyError, ValueError):
            return None

    def display_size(self):
        out = self._o("getdisplaygeometry")
        try:
            w, h = out.split()
            return int(w), int(h)
        except (AttributeError, ValueError):
            return 1280, 800

    def activate(self, win):
        self._o("windowactivate", "--sync", win, timeout=4)
        return self.active() == win

    def place(self, win, left):
        sw, sh = self.display_size()
        w, h = max(300, sw // 2 - 40), max(240, sh // 2)
        self._o("windowsize", win, str(w), str(h))
        self._o("windowmove", win, str(10 if left else sw // 2 + 10), "30")

    def find_window(self, launched, hint, timeout):
        end = time.time() + timeout
        while time.time() < end:
            for pid in sorted(launched.pids())[:12]:
                for w in self.search_pid(pid):
                    if hint in (self.name(w) or ""):
                        return w
            hits = self.search_name(hint)
            if hits:
                return hits[0]
            time.sleep(0.3)
        return None


# --------------------------------------------------------------------------- AT-SPI wrapper

class Spi:
    def __init__(self):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        self.A = Atspi
        try:
            Atspi.init()
        except Exception:
            pass

    def roots(self, pids):
        A, found = self.A, []
        desk = A.get_desktop(0)
        for i in range(desk.get_child_count()):
            try:
                app = desk.get_child_at_index(i)
                if app is not None and app.get_process_id() in pids:
                    found.append(app)
            except Exception:
                pass
        return found

    def walk(self, root, max_nodes=6000):
        stack, n = [root], 0
        while stack and n < max_nodes:
            node = stack.pop()
            n += 1
            yield node
            try:
                cnt = node.get_child_count()
            except Exception:
                continue
            kids = []
            for i in range(cnt):
                try:
                    k = node.get_child_at_index(i)
                    if k is not None:
                        kids.append(k)
                except Exception:
                    pass
            stack.extend(reversed(kids))

    def _state(self, node, st):
        try:
            return node.get_state_set().contains(st)
        except Exception:
            return False

    def find_text(self, roots, multiline, doc_scope):
        A = self.A
        cands = []
        for root in roots:
            scope = root
            if doc_scope:
                scope = next((n for n in self.walk(root) if n.get_role() == A.Role.DOCUMENT_WEB), None)
                if scope is None:
                    continue
            for n in self.walk(scope):
                try:
                    if n.get_role() in (A.Role.TEXT, A.Role.ENTRY, A.Role.DOCUMENT_TEXT) \
                            and n.get_editable_text_iface() is not None:
                        cands.append(n)
                except Exception:
                    pass
        shown = [n for n in cands if self._state(n, A.StateType.SHOWING)] or cands
        pref = [n for n in shown if self._state(n, A.StateType.MULTI_LINE) == multiline]
        return (pref or shown or [None])[0]

    def find_button(self, roots, name):
        A = self.A
        for root in roots:
            for n in self.walk(root):
                try:
                    if n.get_role() == A.Role.PUSH_BUTTON and (n.get_name() or "").strip().lower() == name \
                            and self._state(n, A.StateType.SHOWING):
                        return n
                except Exception:
                    pass
        return None

    def get_text(self, node):
        ti = node.get_text_iface()
        return ti.get_text(0, ti.get_character_count())

    def set_text(self, node, text):
        return bool(node.get_editable_text_iface().set_text_contents(text))

    def insert_text(self, node, text):
        pos = node.get_text_iface().get_caret_offset()
        return bool(node.get_editable_text_iface().insert_text(pos, text, len(text)))

    def press(self, node):
        act = node.get_action_iface()
        names = [act.get_action_name(i) for i in range(act.get_n_actions())]
        idx = next((i for i, n in enumerate(names) if (n or "").lower() in ("click", "press", "activate", "jump")), 0)
        return bool(act.do_action(idx)), names

    def center_screen(self, node):
        ext = node.get_component_iface().get_extents(self.A.CoordType.SCREEN)
        return ext.x + ext.width // 2, ext.y + ext.height // 2


# --------------------------------------------------------------------------- plan / dry run

def plan_lines(targets, methods, wayland):
    lines = [f"session: {'Wayland (only M0/M1/M4 apply)' if wayland else 'X11'}",
             f"user window: mousepad --disable-server {USER_FILE}  (text '{USER_TEXT}', activated and in front)"]
    for t in targets:
        s = TARGETS[t]
        lines.append(f"target {t}: {s['label']} (window title hint '{s['hint']}')")
        for mid, kind, desc in METHODS:
            if mid not in methods:
                continue
            if kind == "text" and not s["text"] or kind == "click" and not s["click"]:
                lines.append(f"    {mid} n/a (no {kind} element)")
            elif wayland and mid in X11_ONLY:
                lines.append(f"    {mid} n/a on Wayland")
            else:
                lines.append(f"    {mid} {desc}")
    return lines


# --------------------------------------------------------------------------- measuring

class Run:
    def __init__(self, args, xdo, spi, user, out):
        self.args, self.xdo, self.spi, self.user, self.out = args, xdo, spi, user, out
        self.rows = []

    def user_text(self):
        try:
            return self.spi.get_text(self.user["node"]) if self.user.get("node") else None
        except Exception:
            return None

    def emit(self, rec):
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.rows.append(rec)
        self.out.write(json.dumps(rec) + "\n")
        self.out.flush()


class TargetCtx:
    def __init__(self, run, tid, launched, win):
        self.run, self.tid, self.spec, self.launched, self.win = run, tid, TARGETS[tid], launched, win
        self.roots, self._text, self._btn = [], None, {}
        self.deadline = time.time() + run.args.timebox

    def refresh(self):
        self.roots = self.run.spi.roots(self.launched.pids())
        self._text, self._btn = None, {}

    def text_node(self):
        if self._text is None and self.roots:
            self._text = self.run.spi.find_text(self.roots, self.spec["multiline"], self.spec["doc_scope"])
        return self._text

    def button(self, name):
        if name not in self._btn:
            self._btn[name] = self.run.spi.find_button(self.roots, name) if self.roots else None
        return self._btn[name]

    def read_text(self):
        n = self.text_node()
        if n is None:
            return None
        try:
            return self.run.spi.get_text(n).rstrip("\n")
        except Exception:
            self._text = None  # stale node: re-find next time
            return None

    def title(self):
        t = self.run.xdo.name(self.win)
        return t if t is not None else ""

    def remaining(self):
        return self.deadline - time.time()

    def tmo(self):
        return max(1.0, min(5.0, self.remaining()))


def keyseq():
    return [KEYSYM.get(c, c) for c in TEXT]


def do_method(ctx, mid):
    """Perform the input. Returns a detail string. May raise."""
    spi, xdo, W = ctx.run.spi, ctx.run.xdo, ctx.win
    if mid == "M0":
        return f"set_text_contents -> {spi.set_text(ctx.text_node(), TEXT)}"
    if mid == "M1":
        return f"insert_text -> {spi.insert_text(ctx.text_node(), TEXT)}"
    if mid == "M2":
        rc, _ = run(["xdotool", "type", "--window", W, "--delay", "20", TEXT], ctx.tmo())
        return f"rc={rc}"
    if mid == "M3":
        rc, _ = run(["xdotool", "key", "--window", W, *keyseq()], ctx.tmo())
        return f"rc={rc}"
    if mid == "C2":
        r1, _ = run(["xdotool", "windowfocus", "--sync", W], ctx.tmo())
        r2, _ = run(["xdotool", "type", "--delay", "20", TEXT], ctx.tmo())
        return f"windowfocus rc={r1}, type rc={r2}"
    if mid == "M4":
        ok, names = spi.press(ctx.button("go"))
        return f"do_action -> {ok} (actions {names})"
    if mid in ("M5", "C5"):
        sx, sy = spi.center_screen(ctx.button("go"))
        g = xdo.geometry(W)
        if not g:
            raise RuntimeError("no window geometry")
        rx, ry = sx - g["X"], sy - g["Y"]
        detail = f"screen=({sx},{sy}) rel=({rx},{ry})"
        if mid == "C5":
            r0, _ = run(["xdotool", "windowfocus", "--sync", W], ctx.tmo())
            detail += f"; windowfocus rc={r0}"
        r1, _ = run(["xdotool", "mousemove", "--window", W, str(rx), str(ry)], ctx.tmo())
        r2, _ = run(["xdotool", "click", *(["--window", W] if mid == "M5" else []), "1"], ctx.tmo())
        return f"{detail}; mousemove rc={r1}, click rc={r2}"
    raise RuntimeError("unknown method " + mid)


def ensure_reset(ctx, kind):
    """Bring the target back to empty text / un-clicked. Returns an error string or None."""
    spi = ctx.run.spi
    if kind == "text":
        if ctx.text_node() is None:
            return "no AT-SPI text element (cannot read back)"
        cur = ctx.read_text()
        if cur not in ("", None):
            try:
                spi.set_text(ctx.text_node(), "")
            except Exception as e:
                return f"reset failed: {e!r}"
            time.sleep(0.2)
            if ctx.read_text() not in ("", None):
                return "reset failed: text still present"
        return None
    if "CLICKED" in ctx.title():
        try:
            spi.press(ctx.button("reset"))
        except Exception as e:
            return f"reset failed: {e!r}"
        time.sleep(0.3)
        if "CLICKED" in ctx.title():
            return "reset failed: title still CLICKED"
    return None


def measure(ctx, mid, kind, desc):
    run_, xdo = ctx.run, ctx.run.xdo
    rec = {"target": ctx.tid, "method": mid, "desc": desc, "kind": kind, "outcome": "error", "detail": "",
           "activeChanged": None, "pointerMoved": None, "userTextChanged": None}

    if ctx.remaining() <= 0:
        rec["detail"] = f"timebox {run_.args.timebox}s exceeded"
        return rec
    err = ensure_reset(ctx, kind)
    if err:
        rec["detail"] = err
        return rec
    if mid in ("M0", "M1") and ctx.text_node() is None or mid in ("M4", "M5", "C5") and ctx.button("go") is None:
        rec["detail"] = "AT-SPI element not found"
        return rec

    user_ok = xdo.activate(run_.user["win"]) if xdo.enabled else None
    xdo._o("mousemove", "8", "8")
    before = {"active": xdo.active(), "ptr": xdo.pointer(), "user": run_.user_text()}
    rec["userWindowActiveAtStart"] = user_ok

    t0 = time.time()
    try:
        rec["detail"] = do_method(ctx, mid)
    except Exception as e:
        rec["detail"] = f"exception: {e!r}"
        rec["elapsedMs"] = int((time.time() - t0) * 1000)
        return rec
    time.sleep(SETTLE)
    rec["elapsedMs"] = int((time.time() - t0) * 1000)

    after = {"active": xdo.active(), "ptr": xdo.pointer(), "user": run_.user_text()}
    if xdo.enabled:
        rec["activeChanged"] = before["active"] != after["active"]
        rec["pointerMoved"] = before["ptr"] != after["ptr"]
    rec["userTextChanged"] = before["user"] != after["user"] if before["user"] is not None else None
    rec["activeBefore"], rec["activeAfter"] = before["active"], after["active"]
    rec["pointerBefore"], rec["pointerAfter"] = before["ptr"], after["ptr"]

    if kind == "text":
        got = ctx.read_text()
        rec["readback"] = got
        if got is None:
            rec["detail"] += "; no readback"
        elif got == TEXT:
            rec["outcome"] = "ok"
        elif got == "":
            rec["outcome"] = "no-effect"
        else:
            rec["outcome"] = "partial"
    else:
        title = ctx.title()
        rec["readback"] = title
        rec["outcome"] = "ok" if "CLICKED" in title else "no-effect"

    if after["user"] is not None and after["user"] != USER_TEXT:
        try:
            run_.spi.set_text(run_.user["node"], USER_TEXT)  # restore so later rows start clean
        except Exception:
            pass
    return rec


def run_target(run_, tid):
    spec, args = TARGETS[tid], run_.args
    tmp = Path(tempfile.mkdtemp(prefix="probe-" + tid + "-"))
    launched = None
    try:
        if tid == "mousepad":
            Path(TARGET_FILE).write_text("")
            cmd = ["mousepad", "--disable-server", TARGET_FILE]
        elif tid == "chrome":
            (tmp / "page.html").write_text(HTML)
            cmd = ["google-chrome", f"--user-data-dir={tmp / 'profile'}", "--force-renderer-accessibility",
                   "--no-first-run", "--no-default-browser-check", "--new-window", (tmp / "page.html").as_uri()]
            if os.geteuid() == 0:
                cmd.insert(1, "--no-sandbox")
        else:
            (tmp / "app.py").write_text(GTK_APP)
            cmd = ["python3", str(tmp / "app.py")]
        env = dict(os.environ, NO_AT_BRIDGE="0", GTK_A11Y="atspi", QT_ACCESSIBILITY="1")
        launched = Launched(cmd, env)

        win = None
        if run_.xdo.enabled:
            win = run_.xdo.find_window(launched, spec["hint"], args.launch_timeout)
            if win is None:
                run_.emit({"target": tid, "method": "*", "outcome": "error", "detail": "target window not found"})
                return
            run_.xdo.place(win, left=False)
            run_.xdo.place(run_.user["win"], left=True)
        ctx = TargetCtx(run_, tid, launched, win)
        # wait for the AT-SPI app and a usable text element
        end = time.time() + args.launch_timeout
        while time.time() < end:
            ctx.refresh()
            if ctx.roots and (ctx.text_node() is not None or not spec["text"]):
                break
            time.sleep(0.5)
        ctx.deadline = time.time() + args.timebox  # box covers the methods; launch wait is separate

        for mid, kind, desc in METHODS:
            if mid not in args.method_set:
                continue
            if kind == "text" and not spec["text"] or kind == "click" and not spec["click"]:
                run_.emit({"target": tid, "method": mid, "outcome": "n/a", "detail": f"target has no {kind} element"})
                continue
            if run_.wayland and mid in X11_ONLY:
                run_.emit({"target": tid, "method": mid, "outcome": "n/a", "detail": "no window-addressed input on Wayland"})
                continue
            run_.emit(measure(ctx, mid, kind, desc))
        if run_.xdo.enabled:
            run_.xdo.activate(run_.user["win"])
    except Exception as e:
        run_.emit({"target": tid, "method": "*", "outcome": "error", "detail": f"target aborted: {e!r}"})
    finally:
        if launched:
            launched.kill()
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------- output

def tables(rows, targets, methods):
    cols = [m for m, _, _ in METHODS if m in methods]
    idx = {(r["target"], r["method"]): r for r in rows}

    def table(cell):
        out = ["| target | " + " | ".join(cols) + " |", "|---|" + "---|" * len(cols)]
        for t in targets:
            out.append(f"| {TARGETS[t]['label']} | " + " | ".join(cell(idx.get((t, c))) for c in cols) + " |")
        return "\n".join(out)

    def flags(r):
        if r is None:
            return "-"
        if r["outcome"] == "n/a":
            return "n/a"
        f = ("A" if r.get("activeChanged") else "") + ("P" if r.get("pointerMoved") else "") \
            + ("U" if r.get("userTextChanged") else "")
        unknown = r.get("activeChanged") is None and r["outcome"] != "error"
        return (f or "none") + ("?" if unknown else "")

    return ("Outcome (ok / no-effect / partial / error / n/a):\n\n" + table(lambda r: r["outcome"] if r else "-")
            + "\n\nSide effects (A = active window changed, P = real pointer moved, U = user text changed):\n\n"
            + table(flags))


def main():
    ap = argparse.ArgumentParser(description="own-window probe, Linux X11 (run on the test VM)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, launch nothing")
    ap.add_argument("--targets", default="mousepad,chrome,gtk3")
    ap.add_argument("--methods", default=",".join(m for m, _, _ in METHODS))
    ap.add_argument("--timebox", type=float, default=20.0, help="seconds per target for the methods")
    ap.add_argument("--launch-timeout", type=float, default=15.0, help="seconds to wait for window + AT-SPI")
    ap.add_argument("--results-dir", default=str(Path(__file__).resolve().parent / "results"))
    args = ap.parse_args()

    load_session_env()
    targets = [t for t in args.targets.split(",") if t]
    bad = [t for t in targets if t not in TARGETS]
    if bad:
        ap.error("unknown targets: " + ",".join(bad))
    args.method_set = set(m for m in args.methods.split(",") if m)
    wayland = is_wayland()

    if args.dry_run:
        print("\n".join(plan_lines(targets, args.method_set, wayland)))
        print(f"results would go to {args.results_dir}/linux-<timestamp>.jsonl; each target boxed to {args.timebox}s")
        return 0

    missing = [b for b in ("mousepad", "xdotool") if not shutil.which(b)]
    if "chrome" in targets and not shutil.which("google-chrome"):
        missing.append("google-chrome")
    if not wayland and not os.environ.get("DISPLAY"):
        missing.append("DISPLAY (source /tmp/session.env)")
    if missing:
        print("missing prerequisites: " + ", ".join(missing), file=sys.stderr)
        return 2

    spi, xdo = Spi(), Xdo(enabled=not wayland)
    Path(args.results_dir).mkdir(parents=True, exist_ok=True)
    out_path = Path(args.results_dir) / f"linux-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    user_proc = None
    try:
        with open(out_path, "w") as out:
            Path(USER_FILE).write_text(USER_TEXT)
            run_ = Run(args, xdo, spi, {}, out)
            run_.wayland = wayland
            user_proc = Launched(["mousepad", "--disable-server", USER_FILE], dict(os.environ, NO_AT_BRIDGE="0"))
            win = xdo.find_window(user_proc, "probe-user.txt", args.launch_timeout) if xdo.enabled else None
            node, end = None, time.time() + args.launch_timeout
            while node is None and time.time() < end:
                roots = spi.roots(user_proc.pids())
                node = spi.find_text(roots, True, False) if roots else None
                time.sleep(0.4)
            if xdo.enabled and win is None or node is None:
                print("user window / its AT-SPI text element not found; aborting", file=sys.stderr)
                return 3
            run_.user.update(win=win, node=node)
            if node is not None and spi.get_text(node).strip() != USER_TEXT:
                spi.set_text(node, USER_TEXT)
            if xdo.enabled:
                xdo.place(win, left=True)
                if not xdo.activate(win):
                    print("warning: user window did not become active; rows record userWindowActiveAtStart",
                          file=sys.stderr)
            for t in targets:
                run_target(run_, t)
        print(f"results: {out_path}\n")
        print(tables(run_.rows, targets, args.method_set))
        return 0
    finally:
        if user_proc:
            user_proc.kill()
        for f in (USER_FILE, TARGET_FILE):
            try:
                os.remove(f)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
