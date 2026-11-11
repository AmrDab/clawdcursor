#!/usr/bin/env python3
"""The native benchmark fixture for Linux: a small GTK 3 app (python3-gi) that writes its own state to a JSON file.

    python3 bench_fixture.py --state <file> [--mode dialog|editor] [--pos x,y] [--selftest]

The same controls, names and state keys as the Windows (BenchFixture.cs) and macOS (BenchFixture.swift) fixtures.
"""
import argparse
import ctypes
import json
import os
import sys
import time


def name_process(name):
    """Name this process BenchFixture instead of python3: the benchmark's privacy guard allows no generic host name."""
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(15, name.encode()[:15], 0, 0, 0)  # PR_SET_NAME
    except Exception:
        pass  # the guard also checks the process id


class Recorder:
    def __init__(self, path):
        self.path = path
        self.state = {}
        self.events = []

    def event(self, kind, target):
        self.events.append({"t": int(time.time() * 1000), "type": kind, "target": target})
        self.write()

    def write(self):
        # Written beside the file and moved over it: a reader never sees half a file.
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"state": self.state, "events": self.events}, f)
        os.replace(tmp, self.path)


def build_dialog(Gtk, rec, selftest):
    win = Gtk.Window(title="Bench Dialog")
    win.set_resizable(False)
    win.set_border_width(12)
    grid = Gtk.Grid(row_spacing=8, column_spacing=8)
    win.add(grid)

    rec.state.update({"name": "", "email": "", "priority": None, "subscribe": False, "applied": None,
                      "billingEdit": 0, "shippingEdit": 0, "mainOk": 0, "mainCancel": 0,
                      "modalOpen": False, "modalResult": None})

    def labelled_entry(text, key, row):
        label = Gtk.Label(label=text + ":", xalign=0)
        entry = Gtk.Entry()
        entry.set_width_chars(34)
        label.set_mnemonic_widget(entry)
        entry.get_accessible().set_name(text)

        def changed(_w):
            rec.state[key] = entry.get_text()
            rec.event("input", key)

        entry.connect("changed", changed)
        entry.connect("focus-in-event", lambda *_: rec.event("focus", key))
        grid.attach(label, 0, row, 1, 1)
        grid.attach(entry, 1, row, 2, 1)
        return entry

    name = labelled_entry("Name", "name", 0)
    email = labelled_entry("Email", "email", 1)

    grid.attach(Gtk.Label(label="Priority:", xalign=0), 0, 2, 1, 1)
    priority = Gtk.ListBox()
    priority.set_selection_mode(Gtk.SelectionMode.SINGLE)
    priority.get_accessible().set_name("Priority")
    for item in ("Low", "Normal", "High"):
        row = Gtk.ListBoxRow()
        row.add(Gtk.Label(label=item, xalign=0))
        row.bench_value = item
        priority.add(row)
    priority.unselect_all()

    def selected(_box, row):
        rec.state["priority"] = row.bench_value if row is not None else None
        rec.event("select", "priority")

    priority.connect("row-selected", selected)
    grid.attach(priority, 1, 2, 2, 1)

    subscribe = Gtk.CheckButton(label="Subscribe")

    def toggled(_w):
        rec.state["subscribe"] = subscribe.get_active()
        rec.event("toggle", "subscribe")

    subscribe.connect("toggled", toggled)
    grid.attach(subscribe, 1, 3, 2, 1)

    def counter(key):
        def clicked(_w):
            rec.state[key] += 1
            rec.event("click", key)
        return clicked

    # Two buttons with the same name: only the group tells them apart.
    groups = Gtk.Box(spacing=8)
    edits = {}
    for title, key in (("Billing", "billingEdit"), ("Shipping", "shippingEdit")):
        frame = Gtk.Frame(label=title)
        button = Gtk.Button(label="Edit")
        button.set_border_width(8)
        button.connect("clicked", counter(key))
        frame.add(button)
        groups.pack_start(frame, True, True, 0)
        edits[key] = button
    grid.attach(groups, 0, 4, 3, 1)

    def close_modal(result, target):
        rec.state["modalResult"] = result
        rec.state["modalOpen"] = False
        rec.event("click", target)

    def delete_clicked(_w):
        rec.state["modalOpen"] = True
        rec.event("click", "delete")
        if selftest:
            return  # the self-test answers the dialog itself, with no window
        dialog = Gtk.Dialog(title="Confirm delete", transient_for=win, modal=True)
        dialog.get_content_area().add(Gtk.Label(label="Delete the selected record?", margin=16))
        dialog.add_button("OK", Gtk.ResponseType.OK)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.show_all()
        response = dialog.run()
        dialog.destroy()
        if response == Gtk.ResponseType.OK:
            close_modal("ok", "modalOk")
        else:
            close_modal("cancel", "modalCancel")

    delete = Gtk.Button(label="Delete...")
    delete.connect("clicked", delete_clicked)
    grid.attach(delete, 0, 5, 1, 1)

    def apply_clicked(_w):
        rec.state["applied"] = {"name": name.get_text().strip(), "email": email.get_text().strip(),
                                "priority": rec.state["priority"], "subscribe": subscribe.get_active()}
        rec.event("click", "apply")

    # OK and Cancel exist here and in the modal dialog.
    buttons = Gtk.Box(spacing=8, halign=Gtk.Align.END)
    apply_button = Gtk.Button(label="Apply")
    apply_button.connect("clicked", apply_clicked)
    main_ok = Gtk.Button(label="OK")
    main_ok.connect("clicked", counter("mainOk"))
    main_cancel = Gtk.Button(label="Cancel")
    main_cancel.connect("clicked", counter("mainCancel"))
    for b in (apply_button, main_ok, main_cancel):
        buttons.pack_start(b, False, False, 0)
    grid.attach(buttons, 0, 6, 3, 1)

    def run_selftest():
        name.set_text("Self Test")
        email.set_text("self@test.example")
        priority.select_row(priority.get_row_at_index(2))
        subscribe.set_active(True)
        edits["shippingEdit"].clicked()
        apply_button.clicked()
        delete.clicked()
        close_modal("ok", "modalOk")

    return win, run_selftest


def build_editor(Gtk, rec):
    win = Gtk.Window(title="Bench Editor")
    win.set_default_size(520, 360)
    scroll = Gtk.ScrolledWindow()
    view = Gtk.TextView()
    view.set_monospace(True)
    view.get_accessible().set_name("Document")
    scroll.add(view)
    win.add(scroll)
    rec.state["text"] = ""
    buf = view.get_buffer()

    def changed(_b):
        rec.state["text"] = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), True)
        rec.event("input", "document")

    buf.connect("changed", changed)
    view.connect("focus-in-event", lambda *_: rec.event("focus", "document"))

    def run_selftest():
        buf.set_text("first line\nsecond line")

    return win, run_selftest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--mode", choices=["dialog", "editor"], default="dialog")
    parser.add_argument("--pos")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    name_process("BenchFixture")
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, GLib, Gtk
    GLib.set_prgname("BenchFixture")
    GLib.set_application_name("BenchFixture")

    rec = Recorder(args.state)
    win, run_selftest = build_dialog(Gtk, rec, args.selftest) if args.mode == "dialog" else build_editor(Gtk, rec)
    rec.write()
    if args.selftest:
        # No window is shown: the handlers a click or a keystroke reaches are run directly.
        run_selftest()
        return 0

    # Raw input, before any widget handles it: a click on empty space or a key no widget uses still reached the app, and
    # the scorer must not call the action that sent it a false success.
    raw_kinds = {Gdk.EventType.BUTTON_PRESS: "mouse", Gdk.EventType.KEY_PRESS: "key", Gdk.EventType.SCROLL: "wheel"}

    def raw_input(event, *_):
        kind = raw_kinds.get(event.type)
        if kind:
            rec.event(kind, "raw")
        Gtk.main_do_event(event)

    try:
        Gdk.event_handler_set(raw_input)
    except Exception:
        pass  # the widgets' own events are still recorded

    win.connect("destroy", Gtk.main_quit)
    win.connect("focus-in-event", lambda *_: rec.event("focus", "window"))
    if args.pos:
        x, y = (int(v) for v in args.pos.split(","))
        win.move(x, y)
    win.show_all()
    win.present()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
