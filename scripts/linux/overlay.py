#!/usr/bin/env python3
"""ClawdCursor on-screen overlay for Linux (GTK 3).

Same contract as scripts/banner.ps1 + scripts/window-outline.ps1 on Windows, driven
by src/core/banner.ts:

  overlay.py pill    the top-center pill. Running: a pulsing amber dot,
                     "ClawdCursor", what the agent is doing (env
                     CLAWD_BANNER_ACTIVITY, then "ACTIVITY <text>" lines on
                     stdin), the time since it appeared and a Stop button; Stop
                     or a double-click anywhere -> prints BANNER_STOP. Paused
                     (env CLAWD_BANNER_MODE=paused): a card with a blue outline,
                     "ClawdCursor - waiting for you" (+ the app from
                     CLAWD_BANNER_APP), the instruction from CLAWD_BANNER_MESSAGE,
                     and Resume / Something else / End task -> prints
                     BANNER_RESUME / BANNER_END; "Something else" opens a small
                     text box under the pill and Enter / Send prints BANNER_REPLY
                     <base64 of the UTF-8 text>. Plays a
                     short system sound when it appears (CLAWD_PAUSE_SOUND=0: off).
                     The card: CLAWD_BANNER_CHOICES (JSON array of strings) adds a
                     row per option, printing BANNER_CHOICE <index>;
                     CLAWD_BANNER_INPUT (JSON {placeholder, multiline}) turns
                     "Something else" into "Type an answer", whose box has the
                     placeholder, a multiline field when asked, and a note not to
                     type passwords. (The pill is a popup that can never take the
                     keyboard, so the box is still a window opened by that click.)
                     stdin: "HIDE <ms>" steps aside for an agent's click;
                     "ACTIVITY <text>" replaces the activity text.
  overlay.py outline [--color #RRGGBB] [--paused]
                     the border beam around the window the agent works in, and
                     nothing else: no fill, nothing on the rest of the screen;
                     clicks pass straight through it. stdin: "TARGET <xid> <pid>"
                     names the window (a bare "TARGET": none); the beam is drawn
                     while that is the active window, and follows it. "HIDE <ms>"
                     steps aside for a screen capture.
                     The beam is Border Beam's pulse-outside in sunset (draw_beam):
                     a warm glow outside the window's edge that breathes, about 10
                     frames a second; inward on a window as wide as the screen.
                     --paused: the same in blue ("ocean"), still. Without a
                     compositor (no alpha): a plain steady line in --color.

When stdin closes (the parent is gone) the process exits.
  overlay.py --probe prints "ok" when GTK can open the display (banner.ts uses
                     this to decide whether the overlay is available).

The parent kills the process to hide it. Every window is override-redirect
(GTK "popup"): it never takes keyboard focus, so it can't steal keystrokes from
the app being driven or the field the user is typing in. Runs on X11, and on
Wayland through XWayland (GDK_BACKEND=x11).
"""
import base64
import json
import math
import os
import shutil
import subprocess
import sys
import time

os.environ.setdefault('GDK_BACKEND', 'x11')

import gi  # noqa: E402

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, GLib, Gtk, Pango  # noqa: E402
import cairo  # noqa: E402

AMBER = (245 / 255, 158 / 255, 11 / 255)
AMBER_DIM = (120 / 255, 78 / 255, 8 / 255)
BLUE = (59 / 255, 130 / 255, 246 / 255)
BLUE_DIM = (25 / 255, 55 / 255, 110 / 255)
BG = (22 / 255, 24 / 255, 29 / 255)
EDGE = (58 / 255, 62 / 255, 72 / 255)  # the 1px outline; blue on the paused card


def emit(line):
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


def hex_rgb(value):
    h = value.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def popup(width, height):
    """An override-redirect window: on top, no decorations, never focused."""
    win = Gtk.Window(type=Gtk.WindowType.POPUP)
    win.set_app_paintable(True)
    win.set_default_size(width, height)
    win.set_accept_focus(False)
    screen = win.get_screen()
    visual = screen.get_rgba_visual()
    composited = visual is not None and screen.is_composited()
    if composited:
        win.set_visual(visual)
    return win, composited


def primary_geometry():
    display = Gdk.Display.get_default()
    mon = display.get_primary_monitor() or display.get_monitor(0)
    return mon.get_workarea()


def rounded(cr, w, h, r):
    cr.new_sub_path()
    cr.arc(w - r, r, r, -math.pi / 2, 0)
    cr.arc(w - r, h - r, r, 0, math.pi / 2)
    cr.arc(r, h - r, r, math.pi / 2, math.pi)
    cr.arc(r, r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


CSS = b"""
label { color: #ffffff; font-family: "Segoe UI", "Cantarell", "Ubuntu", sans-serif; }
label.brand { color: #8c929e; font-size: 9pt; font-weight: 600; }
label.activity { color: #ffffff; font-size: 9.5pt; font-weight: 600; }
label.clock { color: #8c929e; font-size: 9pt; }
label.head { color: #93b4f5; font-size: 9pt; font-weight: 600; }
label.msg { color: #e8eaed; font-size: 10.5pt; }
label.hint { color: #8c929e; font-size: 9pt; }
button { border: none; border-radius: 8px; padding: 0 12px; min-width: 96px; min-height: 30px;
         background-image: none; background-color: #2c3039; box-shadow: none; text-shadow: none; }
button label { color: #ffffff; font-size: 9.5pt; font-weight: 600; }
button:hover { background-color: #3a3f4b; }
button.resume { background-color: #3b82f6; }
button.resume:hover { background-color: #5b97f8; }
button.other { min-width: 132px; }
button.other label { color: #93b4f5; }
button.end label { color: #f87171; }
button.send { min-width: 76px; }
button.choice { min-width: 0; min-height: 34px; padding: 0 10px; background-color: #22262e; }
button.choice:hover { background-color: #2c3039; }
button.choice label { font-size: 10pt; font-weight: normal; }
button.stop { min-width: 52px; min-height: 24px; padding: 0; border-radius: 6px; background-color: #401e21; }
button.stop:hover { background-color: #5c262a; }
button.stop label { color: #fca5a5; font-size: 9pt; }
window.replywin { background-color: #16181d; }
.replywin entry, .replywin textview, .replywin textview text { background-color: #22262e; color: #ffffff; }
"""


def pause_chime():
    # A short system sound when the paused prompt appears, so a user who isn't
    # looking hears it's their turn (#237). CLAWD_PAUSE_SOUND=0 turns it off.
    # The player's output never reaches stdout: that is the answer channel.
    if os.environ.get('CLAWD_PAUSE_SOUND') == '0':
        return
    player = shutil.which('canberra-gtk-play')
    if player:
        try:
            subprocess.Popen([player, '-i', 'dialog-information'], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except OSError:
            pass
    display = Gdk.Display.get_default()
    if display is not None:
        display.beep()


def env_json(name):
    try:
        return json.loads(os.environ.get(name) or 'null')
    except ValueError:
        return None


def run_pill():
    paused = os.environ.get('CLAWD_BANNER_MODE') == 'paused'
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider,
                                             Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    pad = 18
    width = 460 if paused else 1  # the running pill sizes its width to its row
    pill_h = 38
    win, composited = popup(width, 1 if paused else pill_h)
    radius = 14 if paused else 19
    edge = BLUE if paused else EDGE

    def draw(_w, cr):
        alloc = win.get_allocation()
        w, h = alloc.width, alloc.height
        cr.set_operator(cairo.OPERATOR_SOURCE)
        if composited:
            cr.set_source_rgba(0, 0, 0, 0)
            cr.paint()
            r = min(radius, h / 2)
            rounded(cr, w, h, r)
        else:
            cr.rectangle(0, 0, w, h)
        cr.set_source_rgb(*BG)
        cr.fill()
        # The 1px outline, drawn inside the edge.
        cr.set_source_rgb(*edge)
        cr.set_line_width(1)
        if composited:
            cr.save()
            cr.translate(0.5, 0.5)
            rounded(cr, w - 1, h - 1, max(min(radius, h / 2) - 0.5, 0))
            cr.restore()
        else:
            cr.rectangle(0.5, 0.5, w - 1, h - 1)
        cr.stroke()
        return False

    win.connect('draw', draw)

    dot_size = 10 if paused else 12
    dot = Gtk.DrawingArea()
    dot.set_size_request(dot_size, dot_size)
    dot.set_valign(Gtk.Align.CENTER)
    state = {'bright': True}
    on, off = (BLUE, BLUE_DIM) if paused else (AMBER, AMBER_DIM)

    def draw_dot(_w, cr):
        cr.set_source_rgb(*(on if state['bright'] else off))
        cr.arc(dot_size / 2, dot_size / 2, dot_size / 2 - 1, 0, 2 * math.pi)
        cr.fill()
        return False

    dot.connect('draw', draw_dot)

    # Running pill: lay the row out and size the pill to it (the activity text changes), centred again each time.
    def layout():
        _min, nat = win.get_preferred_width()
        w = max(nat, 1)
        win.resize(w, pill_h)
        area = primary_geometry()
        win.move(area.x + (area.width - w) // 2, area.y + 8)
        win.queue_draw()

    activity_label = None  # set below in the running pill

    if paused:
        title_text = 'ClawdCursor · waiting for you'
        app = os.environ.get('CLAWD_BANNER_APP')
        if app:
            title_text += ' · ' + app
        title = Gtk.Label(label=title_text, xalign=0)  # plain text, never markup
        title.get_style_context().add_class('head')
        msg = Gtk.Label(label=os.environ.get('CLAWD_BANNER_MESSAGE', ''), xalign=0)
        msg.set_line_wrap(True)
        msg.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        msg.set_size_request(width - 2 * pad, -1)
        msg.get_style_context().add_class('msg')

        # The card (set by pause_for_user): choices -> one row each (BANNER_CHOICE <index>); input -> the reply box
        # below gets the agent's placeholder, a multiline field when asked, and a note not to type passwords.
        raw_choices = env_json('CLAWD_BANNER_CHOICES')
        choices = [c for c in raw_choices if isinstance(c, str) and c][:6] if isinstance(raw_choices, list) else []
        input_cfg = env_json('CLAWD_BANNER_INPUT')
        if not isinstance(input_cfg, dict):
            input_cfg = None
        placeholder = str(input_cfg.get('placeholder') or '') if input_cfg is not None else ''
        multiline = input_cfg is not None and input_cfg.get('multiline') is True

        def answer(line):
            emit(line)
            Gtk.main_quit()

        resume = Gtk.Button(label='Resume')
        if not choices:
            resume.get_style_context().add_class('resume')  # with choices they are the main answer, Resume stays gray
        resume.connect('clicked', lambda *_: answer('BANNER_RESUME'))
        end = Gtk.Button(label='End task')
        end.get_style_context().add_class('end')
        end.connect('clicked', lambda *_: answer('BANNER_END'))
        other = Gtk.Button(label='Type an answer' if input_cfg is not None else 'Something else…')
        other.get_style_context().add_class('other')
        other.connect('clicked', lambda *_: open_reply())
        for b in (resume, other, end):
            b.set_can_focus(False)
            b.set_focus_on_click(False)

        choice_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        for i, text in enumerate(choices):
            cb = Gtk.Button()
            lbl = Gtk.Label(label=text, xalign=0)  # plain text; left-aligned, full width
            lbl.set_ellipsize(Pango.EllipsizeMode.END)
            cb.add(lbl)
            cb.get_style_context().add_class('choice')
            cb.set_can_focus(False)
            cb.set_focus_on_click(False)
            cb.connect('clicked', lambda *_, i=i: answer('BANNER_CHOICE %d' % i))
            choice_box.pack_start(cb, False, False, 0)

        def open_reply():
            # "Something else" / "Type an answer": the user types an answer for the agent instead of doing the step.
            # The pill is an override-redirect popup that can never take the keyboard, so the text box is a small
            # normal window right under it - opened only on the user's own click.
            box = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
            box.get_style_context().add_class('replywin')
            box.set_decorated(False)
            box.set_keep_above(True)
            box.set_skip_taskbar_hint(True)
            box.set_type_hint(Gdk.WindowTypeHint.DIALOG)
            box.set_size_request(width, -1)
            if multiline:
                entry = Gtk.TextView()
                entry.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
                field = Gtk.ScrolledWindow()
                field.set_shadow_type(Gtk.ShadowType.IN)
                field.set_size_request(-1, 70)
                field.add(entry)

                def get_text():
                    buf = entry.get_buffer()
                    return buf.get_text(buf.get_start_iter(), buf.get_end_iter(), False)
            else:
                entry = Gtk.Entry()
                if input_cfg is None:
                    entry.set_placeholder_text('Tell the agent what to do instead')
                field = entry

                def get_text():
                    return entry.get_text()
            send = Gtk.Button(label='Send')
            send.get_style_context().add_class('resume')
            send.get_style_context().add_class('send')

            def send_reply(*_):
                text = get_text().strip()
                if not text:
                    return
                emit('BANNER_REPLY ' + base64.b64encode(text.encode('utf-8')).decode('ascii'))
                Gtk.main_quit()

            def key(_w, event):
                if event.keyval == Gdk.KEY_Escape:
                    box.destroy()
                    # Ask the parent to give the keyboard back to the user's window (the one active when the pause began).
                    emit('BANNER_REFOCUS')
                    return True
                # A longer answer: Enter adds a line, Ctrl+Enter (or Send) sends.
                if multiline and event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter) \
                        and event.state & Gdk.ModifierType.CONTROL_MASK:
                    send_reply()
                    return True
                return False

            if not multiline:
                entry.connect('activate', send_reply)
            send.connect('clicked', send_reply)
            box.connect('key-press-event', key)
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row.pack_start(field, True, True, 0)
            row.pack_start(send, False, False, 0)
            column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            column.set_margin_start(pad)
            column.set_margin_end(pad)
            column.set_margin_top(10)
            column.set_margin_bottom(10)
            if input_cfg is not None and placeholder:
                hint = Gtk.Label(label=placeholder, xalign=0)
                hint.get_style_context().add_class('hint')
                column.pack_start(hint, False, False, 0)
            column.pack_start(row, False, False, 0)
            if input_cfg is not None:
                warn = Gtk.Label(label="Don't type passwords here", xalign=0)
                warn.get_style_context().add_class('hint')
                column.pack_start(warn, False, False, 0)
            box.add(column)
            box.show_all()
            x, y = win.get_position()
            _w, h = win.get_size()
            box.move(x, y + h + 6)
            box.present()
            entry.grab_focus()

        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        head.pack_start(dot, False, False, 0)
        head.pack_start(title, False, False, 0)
        # "Something else..." (with `input`: "Type an answer", the only way to the box here, since this popup can never
        # take the keyboard) on the left; End task, then Resume on the right.
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        buttons.pack_start(other, False, False, 0)
        buttons.pack_end(resume, False, False, 0)
        buttons.pack_end(end, False, False, 0)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        body.set_margin_start(pad)
        body.set_margin_end(pad)
        body.set_margin_top(pad)
        body.set_margin_bottom(pad)
        body.pack_start(head, False, False, 0)
        body.pack_start(msg, False, False, 0)
        if choices:
            body.pack_start(choice_box, False, False, 4)
        body.pack_start(buttons, False, False, 4)
        win.add(body)
    else:
        start_time = time.monotonic()
        brand = Gtk.Label(label='ClawdCursor')
        brand.get_style_context().add_class('brand')
        activity_label = Gtk.Label(label=os.environ.get('CLAWD_BANNER_ACTIVITY') or 'Working')
        activity_label.get_style_context().add_class('activity')
        activity_label.set_ellipsize(Pango.EllipsizeMode.END)
        activity_label.set_max_width_chars(60)
        clock = Gtk.Label(label='0:00')
        clock.get_style_context().add_class('clock')
        stop = Gtk.Button(label='Stop')
        stop.get_style_context().add_class('stop')
        stop.set_can_focus(False)
        stop.set_focus_on_click(False)
        stop.set_valign(Gtk.Align.CENTER)

        def stop_now(*_):
            emit('BANNER_STOP')
            Gtk.main_quit()

        stop.connect('clicked', stop_now)
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        row.set_margin_start(12)
        row.set_margin_end(7)
        row.set_valign(Gtk.Align.CENTER)
        row.pack_start(dot, False, False, 0)
        row.pack_start(brand, False, False, 0)
        row.pack_start(activity_label, False, False, 0)
        row.pack_start(clock, False, False, 0)
        row.pack_start(stop, False, False, 0)
        events = Gtk.EventBox()
        events.set_visible_window(False)
        events.add(row)

        def press(_w, event):
            if event.type == Gdk.EventType._2BUTTON_PRESS:
                stop_now()
            return False

        events.connect('button-press-event', press)
        win.add(events)

        def tick_clock():
            s = int(time.monotonic() - start_time)
            t = '%d:%02d' % (s // 60, s % 60)
            if clock.get_text() != t:
                clock.set_text(t)
                layout()

    # The dot pulses (the running pill's clock counts on the same tick).
    def blink():
        state['bright'] = not state['bright']
        dot.queue_draw()
        if not paused:
            tick_clock()
        return True

    GLib.timeout_add(900 if paused else 700, blink)

    # stdin carries "HIDE <ms>" from the parent just before an agent's click: the pill steps aside so the click reaches
    # the app under it (it sits where browsers keep their tab strip and address bar), then comes back on its own.
    # "ACTIVITY <text>" replaces what the running pill says the agent is doing.
    hide_state = {'token': 0, 'buf': b''}

    def reshow(token):
        if hide_state['token'] == token:
            win.show()
        return False

    def on_line(line):
        if line.startswith('HIDE '):
            try:
                ms = max(50, min(int(line[5:]), 10000))
            except ValueError:
                return
            hide_state['token'] += 1
            win.hide()
            GLib.timeout_add(ms, reshow, hide_state['token'])
        elif line.startswith('ACTIVITY ') and activity_label is not None:
            text = line[9:].strip()
            if text:
                activity_label.set_text(text)
                layout()

    def on_stdin(fd, condition):
        # Raw reads, split here: a buffered readline() could keep a second line that arrived in the same read until
        # the NEXT write woke this watch, so that HIDE came one click late.
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return False
        if not chunk:
            Gtk.main_quit()  # EOF: the parent is gone, and a pill must not outlive it
            return False
        hide_state['buf'] += chunk
        while b'\n' in hide_state['buf']:
            raw, hide_state['buf'] = hide_state['buf'].split(b'\n', 1)
            on_line(raw.decode('utf-8', 'replace').strip())
        return True

    try:
        GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
    except Exception:
        pass  # no stdin: nothing to listen to

    # The paused card has a fixed width and its height follows its content (the message may wrap); the running pill is
    # a fixed 38 px high and its width follows its row.
    if paused:
        win.set_size_request(width, -1)
        win.show_all()
        area = primary_geometry()
        win.move(area.x + (area.width - width) // 2, area.y + 8)
        pause_chime()
    else:
        win.set_size_request(-1, pill_h)
        win.show_all()
        layout()


# The border beam (#392): Border Beam's pulse-outside in sunset, borderRadius 30, duration 1.96 s, by Jakub Antalik
# (libraries.dev, github.com/Jakubantalik/Libraries.dev, packages/border-beam), MIT License, Copyright (c) 2026 Jakub
# Antalik. The library's numbers and its licence notice in full are at the top of scripts/window-outline.ps1.
# A soft bloom and a tighter inner glow outside the window's edge and patches of a 1 px ring at radius 30, made of warm
# blobs that breathe (size, place, opacity) on the library's periods, with a slow hue drift. Here each blob is half of
# a cairo radial gradient lying against the edge (the blur is in its stops), drawn 10 times a second.
BEAM_DURATION = 1.96
_SP, _DR, _OP, _GH = 0.28, 14.0, 0.46, 0.16
_BS, _SS, _GHS = BEAM_DURATION, 6.4 * BEAM_DURATION / 2.3, 2.4 * BEAM_DURATION / 2.3
# from, to, period, delay: per blob region 1..3 its width, height, x, y; the glow's height; each quarter's opacity
# (top-left, top-right, bottom-left, bottom-right).
BEAM_OSC = [
    (1 - _SP, 1 + _SP * 1.1, _SS * 0.9, 0), (1 + _SP * 0.9, 1 - _SP * 0.85, _SS * 1.26, 0),
    (-_DR, _DR * 0.9, _BS * 1.6, 0), (_DR * 0.55, -_DR * 0.7, _BS * 1.6, 0),
    (1 + _SP, 1 - _SP * 0.85, _SS * 1.1, 0), (1 - _SP * 0.8, 1 + _SP * 1.05, _SS * 0.81, 0),
    (_DR * 0.8, -_DR * 0.9, _BS * 1.88, 0), (-_DR, _DR * 0.65, _BS * 1.88, 0),
    (1 - _SP * 0.6, 1 + _SP * 1.15, _SS * 0.98, 0), (1 + _SP * 0.75, 1 - _SP, _SS * 1.4, 0),
    (-_DR * 0.6, _DR, _BS * 1.45, 0), (-_DR * 0.85, _DR * 0.45, _BS * 1.45, 0),
    (1 - _GH, 1 + _GH, _GHS, 0),
    (1 - _OP, 1, _BS, 0), (1 - _OP, 1, _BS * 1.32, _BS * 0.28), (1 - _OP, 1, _BS * 0.84, _BS * 0.55),
    (1 - _OP, 1, _BS * 1.58, _BS * 0.83)]
# The ring's and the inner glow's blobs: colour, region, quarter, reach x, y (px), place x, y (% of the box).
BEAM_EDGE = [(0, 1, 0, 80, 19, 27, 0), (6, 2, 1, 74, 11, 73, -1), (7, 3, 1, 15, 44, 100, 33), (8, 1, 3, 19, 38, 101, 72),
             (4, 2, 3, 84, 13, 67, 100), (1, 3, 2, 60, 21, 24, 101), (2, 1, 2, 17, 40, 0, 60), (3, 2, 0, 13, 32, -1, 28)]
# The bloom's blobs: colour, reach x, y, place x, y. They do not breathe.
BEAM_BLOOM = [(0, 110, 30, 27, 3), (6, 100, 20, 73, 1), (7, 26, 62, 100, 33), (8, 30, 56, 101, 72),
              (4, 120, 22, 67, 99), (1, 88, 32, 24, 99), (2, 28, 58, 0, 60)]
BEAM_SUNSET = [(255, 80, 50), (255, 160, 40), (255, 120, 60), (255, 200, 50), (255, 100, 80), (255, 180, 60),
               (255, 60, 60), (255, 140, 50), (255, 90, 70)]
BEAM_OCEAN = [(100, 80, 220), (60, 120, 255), (80, 100, 200), (50, 140, 220), (120, 80, 255), (70, 130, 255),
              (140, 100, 240), (90, 110, 230), (130, 70, 255)]
BEAM_MARGIN = 48  # how far out the glow goes
# Across the edge, how a blurred box edge falls off (a gaussian) at six stops: the bloom's (blur 22.5, its box 20 px
# out, faded out by 48) and the inner glow's (blur 3, its box 2 px out, about 10 px deep).
_STOPS = (0, 0.2, 0.4, 0.6, 0.8, 1)
_BLOOM_FALL, _INNER_FALL = (1, 0.83, 0.63, 0.43, 0.165, 0), (1, 0.67, 0.34, 0.12, 0.03, 0)


def _osc(k, t):
    a, b, period, delay = BEAM_OSC[k]
    return a + (b - a) * (1 - math.cos(2 * math.pi * (t - delay) / period)) / 2


def _filtered(rgb, degrees):
    """hue-rotate(deg) brightness(1.9) saturate(1.2), each clamped, as a browser does."""
    c, s, t = math.cos(math.radians(degrees)), math.sin(math.radians(degrees)), 1.2
    r, g, b = (v / 255 for v in rgb)

    def clamp(v):
        return max(0.0, min(1.0, v))

    r1 = clamp(1.9 * clamp((0.213 + c * 0.787 - s * 0.213) * r + (0.715 - c * 0.715 - s * 0.715) * g + (0.072 - c * 0.072 + s * 0.928) * b))
    g1 = clamp(1.9 * clamp((0.213 - c * 0.213 + s * 0.143) * r + (0.715 + c * 0.285 + s * 0.140) * g + (0.072 - c * 0.072 - s * 0.283) * b))
    b1 = clamp(1.9 * clamp((0.213 - c * 0.213 - s * 0.787) * r + (0.715 - c * 0.715 + s * 0.715) * g + (0.072 + c * 0.928 + s * 0.072) * b))
    return (clamp((0.213 + 0.787 * t) * r1 + (0.715 - 0.715 * t) * g1 + (0.072 - 0.072 * t) * b1),
            clamp((0.213 - 0.213 * t) * r1 + (0.715 + 0.285 * t) * g1 + (0.072 - 0.072 * t) * b1),
            clamp((0.213 - 0.213 * t) * r1 + (0.715 - 0.715 * t) * g1 + (0.072 + 0.928 * t) * b1))


def _side(fx, fy):
    """Which side a blob placed at (fx, fy) % lies on: 0 top, 1 right, 2 bottom, 3 left."""
    d = (fy, 100 - fx, 100 - fy, fx)
    return d.index(min(d))


def draw_beam(cr, w, h, off, inward, t, palette):
    """The beam for a w x h frame whose top-left corner is at (off, off), as it is `t` seconds in."""
    gx, gy, rc = max(0.35, min(4, w / 350)), max(0.35, min(4, h / 140)), min(30, w / 2, h / 2)
    hue = 30 * math.sin(2 * math.pi * t / 14)  # 30 degrees either way over 14 s
    colours = [_filtered(c, hue) for c in palette]
    o = [_osc(k, t) for k in range(len(BEAM_OSC))]
    length = (w, h, w, h)

    def half_ellipse(s, a, reach, depth, fall, peak, rgb):
        """Half an ellipse against side s: centred `a` along it on the edge, `reach` along, `depth` across."""
        if peak <= 0.002:
            return
        if s == 0:
            cx, cy, rx, ry = off + a, off, reach, depth
        elif s == 2:
            cx, cy, rx, ry = off + a, off + h, reach, depth
        elif s == 3:
            cx, cy, rx, ry = off, off + a, depth, reach
        else:
            cx, cy, rx, ry = off + w, off + a, depth, reach
        pattern = cairo.RadialGradient(0, 0, 0, 0, 0, 1)
        for at, f in zip(_STOPS, fall):
            pattern.add_color_stop_rgba(at, rgb[0], rgb[1], rgb[2], peak * f)
        cr.save()
        cr.translate(cx, cy)
        cr.scale(rx, ry)
        cr.set_source(pattern)
        cr.arc(0, 0, 1, 0, 2 * math.pi)
        cr.fill()  # (before restore: the source is part of the saved state)
        cr.restore()

    # The glow: only outside the frame (or, inward, only inside it); the bloom under the inner glow.
    cr.save()
    if inward:
        cr.rectangle(off, off, w, h)
    else:
        cr.rectangle(0, 0, w + 2 * off, h + 2 * off)
        cr.rectangle(off, off, w, h)
        cr.set_fill_rule(cairo.FILL_RULE_EVEN_ODD)
    cr.clip()
    cr.set_fill_rule(cairo.FILL_RULE_WINDING)
    for ci, bw, bh, fx, fy in reversed(BEAM_BLOOM):  # the first blob on top
        s = _side(fx, fy)
        cx, cy, rx, ry = -20 + fx / 100 * (w + 40), -20 + fy / 100 * (h + 40), bw * gx, bh * gy
        across = (abs(cy + 20), abs(cx - w - 20), abs(cy - h - 20), abs(cx + 20))[s]
        edge = max(0.0, 1 - across / (ry if s % 2 == 0 else rx))
        half_ellipse(s, cx if s % 2 == 0 else cy, (rx if s % 2 == 0 else ry) + 22.5, BEAM_MARGIN,
                     _BLOOM_FALL, 0.30 * 0.77 * edge * 0.813, colours[ci])
    blobs = []
    for ci, reg, quarter, bw, bh, fx, fy in BEAM_EDGE:
        r = reg - 1
        blobs.append((_side(fx, fy), ci, quarter, fx, fy, bw * o[r * 4] * gx, bh * o[r * 4 + 1] * o[12] * gy,
                      o[r * 4 + 2], o[r * 4 + 3]))
    for s, ci, quarter, fx, fy, rx, ry, dx, dy in reversed(blobs):
        cx, cy = -2 + fx / 100 * (w + 4) + dx, -2 + fy / 100 * (h + 4) + dy
        across = (abs(cy + 2), abs(cx - w - 2), abs(cy - h - 2), abs(cx + 2))[s]
        edge = max(0.0, 1 - across / (ry if s % 2 == 0 else rx))
        half_ellipse(s, cx if s % 2 == 0 else cy, (rx if s % 2 == 0 else ry) + 3, 10,
                     _INNER_FALL, 0.34 * o[13 + quarter] * edge * 0.748, colours[ci])
    cr.restore()

    # The ring, on top: the inner 1 px of the frame, lit where the blobs are; its corners arcs of radius 30.
    def ring_at(x, y):
        r = g = b = a = 0.0
        for s, ci, quarter, fx, fy, rx, ry, dx, dy in reversed(blobs):
            ex, ey = (x - (fx / 100 * w + dx)) / rx, (y - (fy / 100 * h + dy)) / ry
            d2 = ex * ex + ey * ey
            if d2 >= 1:
                continue
            v = (1 - math.sqrt(d2)) * o[13 + quarter]
            c = colours[ci]
            r, g, b, a = c[0] * v + r * (1 - v), c[1] * v + g * (1 - v), c[2] * v + b * (1 - v), v + a * (1 - v)
        return ((r / a, g / a, b / a), a * 0.94) if a > 0 else ((0, 0, 0), 0)

    for s, ci, quarter, fx, fy, rx, ry, dx, dy in reversed(blobs):
        cx, cy = fx / 100 * w + dx, fy / 100 * h + dy
        along, reach = (cx, rx) if s % 2 == 0 else (cy, ry)
        across = (abs(cy), abs(cx - w), abs(cy - h), abs(cx))[s]
        edge = max(0.0, 1 - across / (ry if s % 2 == 0 else rx))
        a0, a1 = max(rc, along - reach), min(length[s] - rc, along + reach)
        peak = 0.94 * o[13 + quarter] * edge
        if a1 - a0 < 1 or peak <= 0.002:
            continue
        rgb = colours[ci]
        if s % 2 == 0:
            line = cairo.LinearGradient(off + along - reach, 0, off + along + reach, 0)
            cr.rectangle(off + a0, off if s == 0 else off + h - 1, a1 - a0, 1)
        else:
            line = cairo.LinearGradient(0, off + along - reach, 0, off + along + reach)
            cr.rectangle(off + w - 1 if s == 1 else off, off + a0, 1, a1 - a0)
        line.add_color_stop_rgba(0, rgb[0], rgb[1], rgb[2], 0)
        line.add_color_stop_rgba(0.5, rgb[0], rgb[1], rgb[2], peak)
        line.add_color_stop_rgba(1, rgb[0], rgb[1], rgb[2], 0)
        cr.set_source(line)
        cr.fill()
    if rc >= 1:
        cr.set_line_width(1)
        for (ccx, ccy, start) in ((rc, rc, math.pi), (w - rc, rc, 1.5 * math.pi), (w - rc, h - rc, 0), (rc, h - rc, 0.5 * math.pi)):
            mid = start + math.pi / 4
            rgb, alpha = ring_at(ccx + rc * math.cos(mid), ccy + rc * math.sin(mid))
            if alpha < 0.01:
                continue
            cr.set_source_rgba(rgb[0], rgb[1], rgb[2], alpha)
            cr.new_sub_path()
            cr.arc(off + ccx, off + ccy, rc - 0.5, start, start + math.pi / 2)
            cr.stroke()


def run_outline(color, paused):
    gi.require_version('GdkX11', '3.0')
    from gi.repository import GdkX11  # noqa: F401  (gives the active window its get_xid)
    screen = Gdk.Screen.get_default()
    win, composited = popup(1, 1)
    settings = Gtk.Settings.get_default()
    # Paused: the blues, still. Where the desktop is set to show no animations: one still frame.
    still = paused or (settings is not None and not settings.get_property('gtk-enable-animations'))
    palette = BEAM_OCEAN if paused else BEAM_SUNSET
    state = {'xid': 0, 'rect': None, 'hidden_until': 0.0, 'buf': b'', 'sized': None, 'shadow': (0, 0, 0, 0),
             'inward': False, 'start': time.monotonic()}

    def shadow(xid, scale):
        # A client-decorated GTK window draws its shadow inside its own X window and says how wide it is in
        # _GTK_FRAME_EXTENTS (left, right, top, bottom, device pixels). Without xprop the border sits outside the shadow.
        if not shutil.which('xprop'):
            return (0, 0, 0, 0)
        try:
            out = subprocess.run(['xprop', '-id', str(xid), '_GTK_FRAME_EXTENTS'],
                                 capture_output=True, text=True, timeout=1).stdout
            sides = tuple(int(v) // scale for v in out.split('=')[1].split(','))
            return sides if len(sides) == 4 else (0, 0, 0, 0)
        except Exception:
            return (0, 0, 0, 0)  # the property is not set: server-side decorations

    def draw(_w, cr):
        cr.set_operator(cairo.OPERATOR_SOURCE)
        if not composited:  # no alpha on this display: a plain steady line in the colour given
            cr.set_source_rgb(*hex_rgb(color))
            cr.paint()
            return False
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)
        if state['rect'] is not None:
            _x, _y, w, h = state['rect']
            draw_beam(cr, w, h, 0 if state['inward'] else BEAM_MARGIN, state['inward'],
                      0 if still else time.monotonic() - state['start'], palette)
        return False

    win.connect('draw', draw)

    def frame():
        """The target's visible frame (decorations included, a GTK shadow not) while it is the active window."""
        if not state['xid'] or time.monotonic() < state['hidden_until']:
            return None
        active = screen.get_active_window()
        if active is None or active.get_xid() != state['xid']:
            return None
        e = active.get_frame_extents()
        sized = (state['xid'], e.width, e.height)
        if sized != state['sized']:  # asked again only when the window changes or resizes (a maximized one has no shadow)
            state['sized'] = sized
            state['shadow'] = shadow(state['xid'], max(1, active.get_scale_factor()))
        left, right, top, bottom = state['shadow']
        w, h = e.width - left - right, e.height - top - bottom
        return (e.x + left, e.y + top, w, h) if w > 0 and h > 0 else None

    def bands():
        """Where the beam is in the window: the glow's band and the ring's corners (window coordinates)."""
        x, y, w, h = state['rect']
        m, c = (BEAM_MARGIN, 31) if not state['inward'] else (0, BEAM_MARGIN)
        ww, wh = w + 2 * m, h + 2 * m
        return [(0, 0, ww, m + c), (0, wh - m - c, ww, m + c), (0, m + c, m + c, wh - 2 * (m + c)),
                (ww - m - c, m + c, m + c, wh - 2 * (m + c))]

    def follow():
        rect = frame()
        if rect == state['rect']:
            return True
        state['rect'] = rect
        if rect is None:
            win.hide()
            return True
        x, y, w, h = rect
        root = screen.get_root_window()
        # A window as wide as the screen (maximized) has no room outside it: the glow goes inward.
        state['inward'] = root is not None and x <= 0 and x + w >= root.get_width()
        m = 0 if state['inward'] else BEAM_MARGIN
        if composited:
            # The window is cut to the beam's band: outside the frame (or, inward, inside its edge), and the ring's
            # corners; nothing lies over the content.
            shape = cairo.Region(cairo.RectangleInt(0, 0, w + 2 * m, h + 2 * m))
            if state['inward']:
                inner = min(BEAM_MARGIN, w // 2, h // 2)
                shape.subtract(cairo.RectangleInt(inner, inner, w - 2 * inner, h - 2 * inner))
            else:
                rc = int(min(30, w // 2, h // 2))
                shape.subtract(cairo.RectangleInt(m + 1, m + rc, max(0, w - 2), max(0, h - 2 * rc)))
                shape.subtract(cairo.RectangleInt(m + rc, m + 1, max(0, w - 2 * rc), max(0, h - 2)))
        else:
            t = min(3, w // 2, h // 2)
            shape = cairo.Region(cairo.RectangleInt(0, 0, w, h))
            shape.subtract(cairo.RectangleInt(t, t, w - 2 * t, h - 2 * t))
            m = 0
        win.move(x - m, y - m)
        win.resize(w + 2 * m, h + 2 * m)
        win.show_all()
        win.shape_combine_region(shape)
        # Click-through: an empty input shape sends every click to the window underneath.
        win.input_shape_combine_region(cairo.Region())
        win.queue_draw()
        return True

    def breathe():
        # About 10 frames a second, only the band the beam is in.
        if state['rect'] is not None and composited and not still:
            for bx, by, bw, bh in bands():
                if bw > 0 and bh > 0:
                    win.queue_draw_area(bx, by, bw, bh)
        return True

    def on_line(line):
        parts = line.split()
        if not parts:
            return
        try:
            if parts[0] == 'TARGET':
                state['xid'] = int(parts[1]) if len(parts) > 1 else 0
            elif parts[0] == 'HIDE' and len(parts) > 1:
                state['hidden_until'] = time.monotonic() + max(50, min(int(parts[1]), 10000)) / 1000
        except ValueError:
            return
        follow()

    def on_stdin(fd, condition):
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return False
        if not chunk:
            Gtk.main_quit()  # EOF: the parent is gone, and a border must not outlive it
            return False
        state['buf'] += chunk
        while b'\n' in state['buf']:
            raw, state['buf'] = state['buf'].split(b'\n', 1)
            on_line(raw.decode('utf-8', 'replace').strip())
        return True

    try:
        GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
    except Exception:
        pass  # no stdin: nothing to listen to
    GLib.timeout_add(100, follow)
    GLib.timeout_add(100, breathe)

def main(argv):
    if '--probe' in argv:
        ok = Gtk.init_check(sys.argv)[0] if hasattr(Gtk, 'init_check') else True
        print('ok' if ok and Gdk.Display.get_default() is not None else 'no-display')
        return 0 if ok else 1
    if not argv or argv[0] not in ('pill', 'outline'):
        sys.stderr.write('usage: overlay.py pill | outline [--color #RRGGBB] [--paused] | --probe\n')
        return 2
    if Gdk.Display.get_default() is None:
        return 1
    if argv[0] == 'pill':
        run_pill()
    else:
        run_outline(argv[argv.index('--color') + 1] if '--color' in argv else '#ff7a45', '--paused' in argv)
    Gtk.main()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
