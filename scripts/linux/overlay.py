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
                     The beam is Border Beam's pulse-inner (draw_beam): coloured
                     blobs that breathe just inside the window's edge, a 1 px ring
                     and a glow 28 px deep, about 10 frames a second.
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


# The border beam (#392): Border Beam as <BorderBeam size="pulse-inner" borderRadius={16}> - the library's defaults
# for the rest: colorVariant "colorful", theme "dark", duration 2.3 s - by Jakub Antalik (libraries.dev,
# github.com/Jakubantalik/Libraries.dev, packages/border-beam), MIT License, Copyright (c) 2026 Jakub Antalik. The
# library's numbers and its licence notice in full are at the top of scripts/window-outline.ps1.
# Inside the window's edge: an inner glow of coloured blobs (and four faint white ones at the corners) shown within
# 28 px of the edge, a 1 px ring of radius 16 lit by the same blobs, and a bloom on that ring; the blobs breathe (size,
# place, opacity) on the library's periods and the colours turn the whole wheel every 16 s. Here each blob is a cairo
# radial gradient and the glow's 28 px mask a gradient (a bilinear mesh in the corners), drawn 10 times a second.
BEAM_DURATION = 2.3
BEAM_RADIUS = 16
BEAM_BAND = 28  # the inner glow's mask: 1 at the edge, 0 this far in
_SP, _DR, _OP, _GH = 0.28, 33.0, 0.48, 0.34
_BS, _SS, _GHS = 1.9 * BEAM_DURATION / 2.3, 2.6 * BEAM_DURATION / 2.3, 2.4 * BEAM_DURATION / 2.3
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
# The palette's blobs, one per colour in its order: place x, y (% of the box), the ring's reach x, y (px), the inner
# glow's, region (1..3), quarter (0 tl, 1 tr, 2 bl, 3 br).
BEAM_BLOB = [(33, -7.4, 70, 40, 65, 35, 1, 0), (12, -5, 60, 35, 55, 30, 2, 0), (2.1, 68.3, 40, 70, 35, 65, 3, 2),
             (2.1, 68.3, 20, 35, 15, 30, 1, 2), (74.4, 100, 180, 32, 173, 28, 2, 3), (55, 100, 85, 26, 80, 22, 3, 3),
             (93.9, 0, 74, 32, 69, 28, 1, 1), (100, 27.1, 26, 42, 22, 38, 2, 1), (100, 27.1, 52, 48, 47, 44, 3, 1)]
# The bloom's blobs: colour, reach x, y (px), at that colour's place. They do not breathe.
BEAM_BLOOM = [(0, 84, 48), (1, 72, 42), (2, 48, 84), (4, 216, 38), (5, 102, 31), (6, 89, 38), (8, 62, 58)]
BEAM_COLORFUL = [(255, 50, 100), (40, 140, 255), (50, 200, 80), (30, 185, 170), (100, 70, 255), (40, 140, 255),
                 (255, 120, 40), (240, 50, 180), (180, 40, 240)]
BEAM_OCEAN = [(100, 80, 220), (60, 120, 255), (80, 100, 200), (50, 140, 220), (120, 80, 255), (70, 130, 255),
              (140, 100, 240), (90, 110, 230), (130, 70, 255)]


def _osc(k, t):
    a, b, period, delay = BEAM_OSC[k]
    return a + (b - a) * (1 - math.cos(2 * math.pi * (t - delay) / period)) / 2


def _filtered(rgb, degrees):
    """hue-rotate(deg) brightness(.75) saturate(1.2), each clamped, as a browser does."""
    c, s, t = math.cos(math.radians(degrees)), math.sin(math.radians(degrees)), 1.2
    r, g, b = (v / 255 for v in rgb)

    def clamp(v):
        return max(0.0, min(1.0, v))

    r1 = clamp(0.75 * clamp((0.213 + c * 0.787 - s * 0.213) * r + (0.715 - c * 0.715 - s * 0.715) * g + (0.072 - c * 0.072 + s * 0.928) * b))
    g1 = clamp(0.75 * clamp((0.213 - c * 0.213 + s * 0.143) * r + (0.715 + c * 0.285 + s * 0.140) * g + (0.072 - c * 0.072 - s * 0.283) * b))
    b1 = clamp(0.75 * clamp((0.213 - c * 0.213 - s * 0.787) * r + (0.715 - c * 0.715 + s * 0.715) * g + (0.072 + c * 0.928 + s * 0.072) * b))
    return (clamp((0.213 + 0.787 * t) * r1 + (0.715 - 0.715 * t) * g1 + (0.072 - 0.072 * t) * b1),
            clamp((0.213 - 0.213 * t) * r1 + (0.715 + 0.285 * t) * g1 + (0.072 - 0.072 * t) * b1),
            clamp((0.213 - 0.213 * t) * r1 + (0.715 - 0.715 * t) * g1 + (0.072 + 0.928 * t) * b1))


def draw_beam(cr, w, h, t, palette):
    """The beam inside a w x h frame at (0, 0), as it is `t` seconds in."""
    rc, band = min(BEAM_RADIUS, w / 2, h / 2), min(BEAM_BAND, w / 2, h / 2)
    hue = 360 * (t / 16 % 1)  # the whole wheel every 16 s
    colours = [_filtered(c, hue) for c in palette]
    o = [_osc(k, t) for k in range(len(BEAM_OSC))]

    def blob(cx, cy, rx, ry, rgb, alpha):
        """A radial-gradient ellipse: `alpha` of the colour in the middle, clear at its edge."""
        if alpha <= 0.002 or rx <= 0 or ry <= 0:
            return
        pattern = cairo.RadialGradient(0, 0, 0, 0, 0, 1)
        pattern.add_color_stop_rgba(0, rgb[0], rgb[1], rgb[2], alpha)
        pattern.add_color_stop_rgba(1, rgb[0], rgb[1], rgb[2], 0)
        cr.save()
        cr.translate(cx, cy)
        cr.scale(rx, ry)
        cr.set_source(pattern)
        cr.arc(0, 0, 1, 0, 2 * math.pi)
        cr.fill()  # (before restore: the source is part of the saved state)
        cr.restore()

    def reaches(b, x0, y0, x1, y1):
        cx, cy, rx, ry = b[:4]
        return cx + rx > x0 and cx - rx < x1 and cy + ry > y0 and cy - ry < y1

    # This frame's blobs (centre, reach, colour, alpha), the first on top: the ring's, and the inner glow's with its
    # four white corners (radius 60, clear at 70%) under them.
    ring, inner = [], []
    for ci, (fx, fy, rw, rh, iw, ih, reg, quarter) in enumerate(BEAM_BLOB):
        r = reg - 1
        cx, cy = fx / 100 * w + o[r * 4 + 2], fy / 100 * h + o[r * 4 + 3]
        ring.append((cx, cy, rw * o[r * 4], rh * o[r * 4 + 1] * o[12], colours[ci], o[13 + quarter]))
        inner.append((cx, cy, iw * o[r * 4], ih * o[r * 4 + 1] * o[12], colours[ci], o[13 + quarter]))
    white = _filtered((255, 255, 255), hue)
    inner += [(w if q % 2 else 0, h if q >= 2 else 0, 42, 42, white, 0.18 * o[13 + q]) for q in range(4)]

    def mesh(pattern, x0, y0, x1, y1, alphas):
        """A patch whose opacity (x .44) is bilinear between its corners (top-left, top-right, bottom-right, bottom-left)."""
        pattern.begin_patch()
        pattern.move_to(x0, y0)
        pattern.line_to(x1, y0)
        pattern.line_to(x1, y1)
        pattern.line_to(x0, y1)
        for i, a in enumerate(alphas):
            pattern.set_corner_color_rgba(i, 0, 0, 0, a * 0.44)
        pattern.end_patch()

    cr.save()
    rounded(cr, w, h, rc)
    cr.clip()
    # The inner glow, opacity .44, in four bands: the top and bottom with the corners (where the two masks add up to
    # 1 - (1 - a)(1 - b): bilinear), the left and right between them.
    for x0, y0, x1, y1 in ((0, 0, w, band), (0, h - band, w, h), (0, band, band, h - band), (w - band, band, w, h - band)):
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        cr.save()
        cr.rectangle(x0, y0, x1 - x0, y1 - y0)
        cr.clip()
        cr.push_group()
        for b in reversed(inner):
            if reaches(b, x0, y0, x1, y1):
                blob(*b)
        cr.pop_group_to_source()
        if y0 == 0 and x1 - x0 == w:  # the top
            pattern = cairo.MeshPattern()
            mesh(pattern, 0, 0, band, band, (1, 1, 0, 1))
            mesh(pattern, band, 0, w - band, band, (1, 1, 0, 0))
            mesh(pattern, w - band, 0, w, band, (1, 1, 1, 0))
        elif x1 - x0 == w:  # the bottom
            pattern = cairo.MeshPattern()
            mesh(pattern, 0, h - band, band, h, (1, 0, 1, 1))
            mesh(pattern, band, h - band, w - band, h, (0, 0, 1, 1))
            mesh(pattern, w - band, h - band, w, h, (0, 1, 1, 1))
        else:
            pattern = cairo.LinearGradient(x0, 0, x1, 0)
            pattern.add_color_stop_rgba(0, 0, 0, 0, 0.44 if x0 == 0 else 0)
            pattern.add_color_stop_rgba(1, 0, 0, 0, 0 if x0 == 0 else 0.44)
        cr.mask(pattern)
        cr.restore()

    # The ring (the inner 1 px, radius 16; opacity 1.54, which a browser takes as 1) and the bloom over it: its seven
    # blobs at alpha .76, at the half of their 8 px blur that falls inside the window (.52), opacity .66.
    if w <= 2 or h <= 2:
        cr.restore()
        return
    rounded(cr, w, h, rc)
    cr.save()
    cr.translate(1, 1)
    rounded(cr, w - 2, h - 2, max(0, rc - 1))
    cr.restore()
    cr.set_fill_rule(cairo.FILL_RULE_EVEN_ODD)
    cr.clip()
    cr.set_fill_rule(cairo.FILL_RULE_WINDING)
    for b in reversed(ring):
        if reaches(b, 0, 0, w, h):
            blob(*b)
    for ci, bw, bh in reversed(BEAM_BLOOM):
        blob(BEAM_BLOB[ci][0] / 100 * w, BEAM_BLOB[ci][1] / 100 * h, bw, bh, colours[ci], 0.76 * 0.52 * 0.66)
    cr.restore()


def run_outline(color, paused):
    gi.require_version('GdkX11', '3.0')
    from gi.repository import GdkX11  # noqa: F401  (gives the active window its get_xid)
    screen = Gdk.Screen.get_default()
    win, composited = popup(1, 1)
    settings = Gtk.Settings.get_default()
    # Paused: the blues, still. Where the desktop is set to show no animations: one still frame.
    still = paused or (settings is not None and not settings.get_property('gtk-enable-animations'))
    palette = BEAM_OCEAN if paused else BEAM_COLORFUL
    state = {'xid': 0, 'rect': None, 'hidden_until': 0.0, 'buf': b'', 'sized': None, 'shadow': (0, 0, 0, 0),
             'start': time.monotonic()}

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
            draw_beam(cr, w, h, 0 if still else time.monotonic() - state['start'], palette)
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
        """Where the beam is in the window: the band just inside the frame's edge."""
        x, y, w, h = state['rect']
        c = min(BEAM_BAND, w // 2, h // 2)
        return [(0, 0, w, c), (0, h - c, w, c), (0, c, c, h - 2 * c), (w - c, c, c, h - 2 * c)]

    def follow():
        rect = frame()
        if rect == state['rect']:
            return True
        state['rect'] = rect
        if rect is None:
            win.hide()
            return True
        x, y, w, h = rect
        # The window is the frame, cut to the beam's band just inside its edge (or, without a compositor, to the plain
        # line): nothing lies over the middle of it.
        t = min(BEAM_BAND if composited else 3, w // 2, h // 2)
        shape = cairo.Region(cairo.RectangleInt(0, 0, w, h))
        shape.subtract(cairo.RectangleInt(t, t, w - 2 * t, h - 2 * t))
        win.move(x, y)
        win.resize(w, h)
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
