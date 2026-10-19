#!/usr/bin/env python3
"""ClawdCursor on-screen overlay for Linux (GTK 3).

Same contract as scripts/banner.ps1 + scripts/edge-glow.ps1 on Windows, driven
by src/core/banner.ts:

  overlay.py pill    the top-center pill. Running: red blinking dot, "desktop
                     control in progress - double-click to stop" -> prints
                     BANNER_STOP. Paused (env CLAWD_BANNER_MODE=paused): blue
                     dot, the instruction from CLAWD_BANNER_MESSAGE, and Resume
                     / Something else / End task -> prints BANNER_RESUME /
                     BANNER_END; "Something else" opens a small text box under
                     the pill and Enter / Send prints BANNER_REPLY <base64 of
                     the UTF-8 text>. Plays a
                     short system sound when it appears (CLAWD_PAUSE_SOUND=0: off).
  overlay.py glow [--color #RRGGBB] [--duration SEC]
                     a pulsing glow on every edge of every monitor; clicks pass
                     straight through it.
  overlay.py --probe prints "ok" when GTK can open the display (banner.ts uses
                     this to decide whether the overlay is available).

The parent kills the process to hide it. Every window is override-redirect
(GTK "popup"): it never takes keyboard focus, so it can't steal keystrokes from
the app being driven or the field the user is typing in. Runs on X11, and on
Wayland through XWayland (GDK_BACKEND=x11).
"""
import base64
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
from gi.repository import Gdk, GLib, Gtk  # noqa: E402
import cairo  # noqa: E402

RED = (1.0, 59 / 255, 48 / 255)
RED_DIM = (110 / 255, 25 / 255, 20 / 255)
BLUE = (59 / 255, 130 / 255, 246 / 255)
BLUE_DIM = (25 / 255, 55 / 255, 110 / 255)
BG = (18 / 255, 18 / 255, 26 / 255)


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
label.sub { color: #aaaab9; font-size: 9pt; }
label.title { font-weight: bold; font-size: 10pt; }
label.msg { color: #d7d7e1; font-size: 10pt; }
button { border: none; border-radius: 4px; padding: 4px 18px; min-width: 74px; min-height: 22px;
         color: #ffffff; font-weight: bold; background-image: none; box-shadow: none; text-shadow: none; }
button.resume { background-color: #3b82f6; }
button.resume:hover { background-color: #5b97f8; }
button.end { background-color: #3c3c48; }
button.end:hover { background-color: #4c4c5a; }
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


def run_pill():
    paused = os.environ.get('CLAWD_BANNER_MODE') == 'paused'
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider,
                                             Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    width = 560 if paused else 430
    win, composited = popup(width, 1)
    radius = 14 if paused else 18

    def draw(_w, cr):
        alloc = win.get_allocation()
        cr.set_operator(cairo.OPERATOR_SOURCE)
        if composited:
            cr.set_source_rgba(0, 0, 0, 0)
            cr.paint()
            rounded(cr, alloc.width, alloc.height, min(radius, alloc.height / 2))
        else:
            cr.rectangle(0, 0, alloc.width, alloc.height)
        cr.set_source_rgb(*BG)
        cr.fill()
        return False

    win.connect('draw', draw)

    dot = Gtk.DrawingArea()
    dot.set_size_request(18, 18)
    dot.set_valign(Gtk.Align.CENTER)
    state = {'bright': True}
    on, off = (BLUE, BLUE_DIM) if paused else (RED, RED_DIM)

    def draw_dot(_w, cr):
        cr.set_source_rgb(*(on if state['bright'] else off))
        cr.arc(9, 9, 6, 0, 2 * math.pi)
        cr.fill()
        return False

    dot.connect('draw', draw_dot)

    def blink():
        state['bright'] = not state['bright']
        dot.queue_draw()
        return True

    GLib.timeout_add(900 if paused else 600, blink)

    if paused:
        title = Gtk.Label(label='ClawdCursor paused - your turn', xalign=0)
        title.get_style_context().add_class('title')
        msg = Gtk.Label(label=os.environ.get('CLAWD_BANNER_MESSAGE', ''), xalign=0)
        msg.set_line_wrap(True)
        msg.set_max_width_chars(62)
        msg.get_style_context().add_class('msg')

        def answer(line):
            emit(line)
            Gtk.main_quit()

        resume = Gtk.Button(label='Resume')
        resume.get_style_context().add_class('resume')
        resume.connect('clicked', lambda *_: answer('BANNER_RESUME'))
        end = Gtk.Button(label='End task')
        end.get_style_context().add_class('end')
        end.connect('clicked', lambda *_: answer('BANNER_END'))
        other = Gtk.Button(label='Something else')
        other.get_style_context().add_class('end')
        other.connect('clicked', lambda *_: open_reply())
        for b in (resume, other, end):
            b.set_can_focus(False)

        def open_reply():
            # "Something else": the user types an answer for the agent instead of doing the step. The pill is an
            # override-redirect popup that can never take the keyboard, so the text box is a small normal window
            # right under it — opened only on the user's own click.
            box = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
            box.set_decorated(False)
            box.set_keep_above(True)
            box.set_skip_taskbar_hint(True)
            box.set_type_hint(Gdk.WindowTypeHint.DIALOG)
            entry = Gtk.Entry()
            entry.set_placeholder_text('Tell the agent what to do instead')
            entry.set_width_chars(52)
            send = Gtk.Button(label='Send')
            send.get_style_context().add_class('resume')

            def send_reply(*_):
                text = entry.get_text().strip()
                if not text:
                    return
                emit('BANNER_REPLY ' + base64.b64encode(text.encode('utf-8')).decode('ascii'))
                Gtk.main_quit()

            def key(_w, event):
                if event.keyval == Gdk.KEY_Escape:
                    box.destroy()
                    return True
                return False

            entry.connect('activate', send_reply)
            send.connect('clicked', send_reply)
            box.connect('key-press-event', key)
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            row.set_margin_start(10)
            row.set_margin_end(10)
            row.set_margin_top(8)
            row.set_margin_bottom(8)
            row.pack_start(entry, True, True, 0)
            row.pack_start(send, False, False, 0)
            box.add(row)
            box.show_all()
            x, y = win.get_position()
            _w, h = win.get_size()
            box.move(x, y + h + 6)
            box.present()
            entry.grab_focus()

        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        head.pack_start(dot, False, False, 0)
        head.pack_start(title, False, False, 0)
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        buttons.pack_end(end, False, False, 0)
        buttons.pack_end(other, False, False, 0)
        buttons.pack_end(resume, False, False, 0)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        body.set_margin_start(14)
        body.set_margin_end(18)
        body.set_margin_top(10)
        body.set_margin_bottom(12)
        body.pack_start(head, False, False, 0)
        body.pack_start(msg, False, False, 0)
        body.pack_start(buttons, False, False, 4)
        win.add(body)
    else:
        brand = Gtk.Label(label='ClawdCursor')
        brand.get_style_context().add_class('title')
        sub = Gtk.Label(label='desktop control in progress  -  double-click to stop')
        sub.get_style_context().add_class('sub')
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        row.set_margin_start(14)
        row.set_margin_end(14)
        row.pack_start(dot, False, False, 0)
        row.pack_start(brand, False, False, 0)
        row.pack_start(sub, False, False, 4)
        events = Gtk.EventBox()
        events.set_visible_window(False)
        events.add(row)

        def press(_w, event):
            if event.type == Gdk.EventType._2BUTTON_PRESS:
                emit('BANNER_STOP')
                Gtk.main_quit()
            return False

        events.connect('button-press-event', press)
        win.add(events)

    # stdin carries "HIDE <ms>" from the parent just before an agent's click: the pill steps aside so the click reaches
    # the app under it (it sits where browsers keep their tab strip and address bar), then comes back on its own.
    hide_state = {'token': 0}

    def reshow(token):
        if hide_state['token'] == token:
            win.show()
        return False

    def on_stdin(source, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            return False
        line = sys.stdin.readline()
        if not line:
            return False  # EOF: the parent closed the pipe
        line = line.strip()
        if line.startswith('HIDE '):
            try:
                ms = max(50, min(int(line[5:]), 10000))
            except ValueError:
                return True
            hide_state['token'] += 1
            win.hide()
            GLib.timeout_add(ms, reshow, hide_state['token'])
        return True

    try:
        GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
    except Exception:
        pass  # no stdin: nothing to listen to

    # Fixed width; the paused pill's height follows its content (the message
    # may wrap), the running pill is a fixed 40 px like on Windows.
    win.set_size_request(width, -1 if paused else 40)
    win.show_all()
    area = primary_geometry()
    win.move(area.x + (area.width - width) // 2, area.y + 8)
    if paused:
        pause_chime()


def run_glow(color, thickness, period_ms, min_alpha, peak_alpha, duration):
    r, g, b = hex_rgb(color)
    display = Gdk.Display.get_default()
    windows = []
    for i in range(display.get_n_monitors()):
        geo = display.get_monitor(i).get_geometry()
        for edge in ('top', 'bottom', 'left', 'right'):
            win, composited = popup(1, 1)
            t = min(thickness, geo.width // 2, geo.height // 2) if composited else 6
            if edge == 'top':
                x, y, w, h = geo.x, geo.y, geo.width, t
            elif edge == 'bottom':
                x, y, w, h = geo.x, geo.y + geo.height - t, geo.width, t
            elif edge == 'left':
                x, y, w, h = geo.x, geo.y, t, geo.height
            else:
                x, y, w, h = geo.x + geo.width - t, geo.y, t, geo.height

            def draw(_w, cr, edge=edge, w=w, h=h, composited=composited):
                cr.set_operator(cairo.OPERATOR_SOURCE)
                if not composited:
                    cr.set_source_rgb(r, g, b)
                    cr.paint()
                    return False
                coords = {'top': (0, 0, 0, h), 'bottom': (0, h, 0, 0),
                          'left': (0, 0, w, 0), 'right': (w, 0, 0, 0)}[edge]
                grad = cairo.LinearGradient(*coords)
                grad.add_color_stop_rgba(0, r, g, b, peak_alpha / 255)
                grad.add_color_stop_rgba(1, r, g, b, 0)
                cr.set_source(grad)
                cr.paint()
                return False

            win.connect('draw', draw)
            win.set_default_size(w, h)
            win.move(x, y)
            win.show_all()
            win.resize(w, h)
            # Click-through: an empty input shape sends every click to the
            # window underneath.
            win.input_shape_combine_region(cairo.Region())
            windows.append((win, composited))

    start = time.monotonic()

    def pulse():
        elapsed = (time.monotonic() - start) * 1000
        if duration > 0 and elapsed >= duration * 1000:
            Gtk.main_quit()
            return False
        phase = (elapsed % period_ms) / period_ms
        wave = (1 - math.cos(phase * 2 * math.pi)) / 2
        opacity = (min_alpha + wave * (255 - min_alpha)) / 255
        for win, composited in windows:
            if composited:
                win.set_opacity(opacity)
        return True

    GLib.timeout_add(30, pulse)


def main(argv):
    if '--probe' in argv:
        ok = Gtk.init_check(sys.argv)[0] if hasattr(Gtk, 'init_check') else True
        print('ok' if ok and Gdk.Display.get_default() is not None else 'no-display')
        return 0 if ok else 1
    if not argv or argv[0] not in ('pill', 'glow'):
        sys.stderr.write('usage: overlay.py pill | glow [--color #RRGGBB] [--duration SEC] | --probe\n')
        return 2
    if Gdk.Display.get_default() is None:
        return 1
    if argv[0] == 'pill':
        run_pill()
    else:
        def opt(name, default):
            return argv[argv.index(name) + 1] if name in argv else default
        run_glow(opt('--color', '#f59e0b'), int(opt('--thickness', 80)), int(opt('--period', 1600)),
                 int(opt('--min-alpha', 60)), int(opt('--peak-alpha', 200)), float(opt('--duration', 0)))
    Gtk.main()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
