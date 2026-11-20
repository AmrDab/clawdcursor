// ClawdCursor on-screen overlay for macOS (AppKit).
//
// Same contract as scripts/banner.ps1 + scripts/window-outline.ps1 on Windows and
// scripts/linux/overlay.py, driven by src/core/banner.ts. Compiled once with
// `swiftc -O` into ~/.clawdcursor/bin (like the OCR helper).
//
//   overlay pill   the top-center pill. Running: a small dotted orb, "ClawdCursor",
//                  what the agent is doing (env CLAWD_BANNER_ACTIVITY, then
//                  "ACTIVITY <text>" lines on stdin), the time since it appeared
//                  and a Stop button; Stop or a double-click prints BANNER_STOP.
//                  Pause prints BANNER_PAUSE (the parent holds the agent); "HELD ON" on
//                  stdin turns it into Resume (BANNER_RESUME), "HELD OFF" back. The pill
//                  stays up for both. stdin also takes "HIDE <ms>". Paused (env CLAWD_BANNER_MODE=paused):
//                  a card with a blue outline, "waiting for you" (+ the app from
//                  CLAWD_BANNER_APP), the instruction from CLAWD_BANNER_MESSAGE, and
//                  Resume / Something else / End task -> prints BANNER_RESUME /
//                  BANNER_END; "Something else" opens a text field (the panel
//                  takes the keyboard only then) and Enter / Send prints
//                  BANNER_REPLY <base64 of the UTF-8 text>. Plays the
//                  "Glass" system sound when it appears (CLAWD_PAUSE_SOUND=0: off).
//                  The card: CLAWD_BANNER_CHOICES (JSON array of strings) adds a
//                  button per option, printing BANNER_CHOICE <index>;
//                  CLAWD_BANNER_INPUT (JSON {placeholder, multiline}) puts the
//                  text field on the card from the start (a click into it takes
//                  the keyboard; Esc gives it back), replacing "Something else".
//                  In a multiline field Return adds a line, Cmd+Return sends.
//   overlay outline [--color #RRGGBB]
//                  a thin border around each window the agent works in (background
//                  mode), and nothing else: no fill, nothing on the rest of the screen;
//                  clicks pass straight through it. stdin: "TARGET <handle> <pid>
//                  [<handle> <pid> ...]" names the windows (handle: a window number, or
//                  0 for the process's frontmost window; a bare "TARGET": none). Each
//                  border follows its window and sits just above it in the stacking
//                  order, so a window in front of the agent's still covers it. Also
//                  "GHOST <x> <y>": the agent's cursor (a retro pixel arrow, never the
//                  user's) drawn as a ghost cursor at that screen
//                  point (top-left origin, tip at the point) for 1.5 s; a bare "GHOST"
//                  hides it. Never moves the real cursor.
//   overlay glow   the foreground-mode indicator: a click-through amber glow along
//                  every screen's edges, pulsing. Starts hidden; stdin: "ON" / "OFF" /
//                  "HIDE <ms>". Never takes focus and is never part of a capture.
//                  Adapted from the glow proven live in PR #448.
//
// The pill's orb is a port of Thinking Orbs by Jakub Antalik (libraries.dev, github.com/Jakubantalik/Libraries.dev,
// packages/thinking-orbs), MIT License,
// Copyright (c) 2026 Jakub Antalik. The licence notice in full is at the top of scripts/banner.ps1, the Windows pill.
//
// When stdin closes (the parent is gone) the process exits.
//
// The parent kills the process to hide it. The app is an accessory (no Dock
// icon) and the pill is a non-activating panel, so neither may take focus from
// the app being driven or the field the user types in. macOS can still make a
// freshly launched process the active app (measured on macOS 26: the pill
// launch did), so whenever this app finds itself active it hands activation
// straight back to the app that was frontmost when it started.

import AppKit

func emit(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func hexColor(_ hex: String, alpha: CGFloat = 1) -> NSColor {
    var h = hex
    if h.hasPrefix("#") { h.removeFirst() }
    let v = UInt32(h, radix: 16) ?? 0xF59E0B
    return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                   blue: CGFloat(v & 0xFF) / 255, alpha: alpha)
}

func option(_ name: String, _ fallback: String) -> String {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return fallback
}

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor {
    return NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: 1)
}

let blue = rgb(59, 130, 246)
let background = rgb(22, 24, 29)
let outline = rgb(58, 62, 72)
let muted = rgb(140, 146, 158)
let headerBlue = rgb(147, 180, 245)
let rowBg = rgb(34, 38, 46)
let footerBg = rgb(44, 48, 57)
let endRed = rgb(248, 113, 113)

/// A panel that never becomes key or main: clicking it leaves focus where it was. The exceptions are a press on the
/// card's text box and a click on "Something else" (takeKeyboard): then it may become key (a non-activating panel takes
/// keystrokes without activating the app).
final class PillPanel: NSPanel {
    var allowKey = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }

    /// The text box under a press at `point` (window coordinates), also when the press is on the field editor inside
    /// it. Nil for any other press: a button must not take the keyboard on a press it may not complete.
    func keyboardTarget(at point: NSPoint) -> NSView? {
        guard let content = contentView else { return nil }
        let local = content.superview?.convert(point, from: nil) ?? point
        var view = content.hitTest(local)
        while let v = view {
            if v is ClickToTypeField { return v }
            view = v.superview
        }
        return nil
    }

    /// AppKit makes a clicked window key here, before the view's mouseDown, and drops that if canBecomeKey is false at
    /// that moment (Mac run 2026-11-16: no focus ring, clicks ignored with the Claude app in front).
    override func sendEvent(_ event: NSEvent) {
        guard event.type == .leftMouseDown, !isKeyWindow,
              let target = keyboardTarget(at: event.locationInWindow) else {
            super.sendEvent(event)
            return
        }
        typingReply = true
        allowKey = true
        super.sendEvent(event)   // for a text field this runs the mouse tracking until mouse-up
        if !isKeyWindow { takeKeyboard(self, target) }
    }
}

/// Set while the user types an answer: focus is not handed back then.
var typingReply = false

/// Buttons in a non-key panel must act on the first click.
final class FirstClickButton: NSButton {
    var line = ""
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The text box that is on the card from the start (pause_for_user's `input`): a press into it (or into its field
/// editor) makes the panel key in PillPanel.sendEvent, so the user can type; nothing else ever gives the panel the keyboard.
final class ClickToTypeField: NSTextField {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Give the card the keyboard for the user's answer ("Something else", and the fallback when a press on the box did not
/// make the panel key). A non-activating panel normally becomes key without activating this app; when the app in
/// front keeps the keyboard anyway (the Claude desktop app in front, Mac run 2026-11-15: no focus ring, keys went
/// nowhere), this app is activated for the answer. Focus goes back on Send (sendReply -> giveFocusBack), Esc
/// (releaseKeyboard) or a choice.
func takeKeyboard(_ panel: PillPanel, _ field: NSView) {
    typingReply = true
    panel.allowKey = true
    panel.makeKeyAndOrderFront(nil)
    if !panel.isKeyWindow {
        // The app in front kept the keyboard: ask for activation, inside the user's click (on macOS 14+ a request the
        // system may refuse). activate() is only in the macOS 14 SDK (Swift 5.9 / Xcode 15); an older toolchain
        // (macOS 12) must still build.
        #if compiler(>=5.9)
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
        #else
        NSApp.activate(ignoringOtherApps: true)
        #endif
        panel.makeKeyAndOrderFront(nil)
    }
    // A box already being edited keeps its field editor: making the box first responder again would select all of the
    // answer typed so far, and the next key would replace it.
    if (field as? NSControl)?.currentEditor() == nil { panel.makeFirstResponder(field) }
}

final class PillView: NSView {
    var onDoubleClick: (() -> Void)?
    var onDragged: (() -> Void)?
    var grab = NSPoint.zero   // where in the window the press landed
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onDoubleClick?() }
        grab = event.locationInWindow
    }
    /// Dragging the body moves the pill (the Stop button is a control: it takes its own clicks and never drags).
    override func mouseDragged(with event: NSEvent) {
        guard let w = window else { return }
        let m = NSEvent.mouseLocation
        w.setFrameOrigin(NSPoint(x: m.x - grab.x, y: m.y - grab.y))
        onDragged?()
    }
}

func label(_ text: String, size: CGFloat, color: NSColor, bold: Bool = false, semibold: Bool = false) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    if bold {
        l.font = NSFont.boldSystemFont(ofSize: size)
    } else if semibold {
        l.font = NSFont.systemFont(ofSize: size, weight: .semibold)
    } else {
        l.font = NSFont.systemFont(ofSize: size)
    }
    l.textColor = color
    l.backgroundColor = .clear
    l.isBezeled = false
    l.isEditable = false
    l.isSelectable = false
    return l
}

/// The app the user was last in (frontmost at start, then kept current as they
/// switch apps while the overlay is up): focus goes back there.
var previousApp: NSRunningApplication? = NSWorkspace.shared.frontmostApplication.flatMap { isOverlay($0) ? nil : $0 }

/// This process, or the other overlay process (the pill and the outline are this same binary, run twice). The other one
/// is never the user's app: activating it leaves no window that can take keys.
func isOverlay(_ app: NSRunningApplication) -> Bool {
    if app.processIdentifier == ProcessInfo.processInfo.processIdentifier { return true }
    guard let mine = Bundle.main.executableURL, let theirs = app.executableURL else { return false }
    return mine.resolvingSymlinksInPath() == theirs.resolvingSymlinksInPath()
}

/// Cooperative activation (macOS 14): yield, then activate, which is honoured while this app is active; deactivating
/// first gave that up. Refused anyway: this app still steps down, so it is never left active with nothing to type in.
/// yieldActivation(to:) is macOS 14 SDK, so it stays inside the compiler check (app.activate() is activate(options:)
/// with its default, in every SDK).
func handBack(to app: NSRunningApplication) {
    #if compiler(>=5.9)
    if #available(macOS 14.0, *) {
        NSApp.yieldActivation(to: app)
        if !app.activate() { NSApp.deactivate() }
        return
    }
    #endif
    NSApp.deactivate()
    app.activate(options: [])
}

func giveFocusBack() {
    guard !typingReply, NSApp.isActive else { return }
    guard let prev = previousApp, !prev.isTerminated, !isOverlay(prev) else { NSApp.deactivate(); return }
    handBack(to: prev)
}

/// Thinking Orbs' default state, "working", at its 20 pt size: particles running on tilted orbits around a slowly
/// turning dotted sphere, in amber ink (the library's tint) on the dark pill. The numbers are the library's (spec/orbs-spec.json,
/// src/engine/orbits.ts and core.ts); the Windows pill (scripts/banner.ps1, class Orb) lists them.
final class OrbView: NSView {
    let started = Date()
    var redraw: Timer?
    override var isFlipped: Bool { true }   // y grows downward, as on the canvas the numbers are for

    /// The library's state, as on Windows (banner.ps1 class Orb): "working" (the orbits, amber), "paused" (the library's
    /// `paused`: the frame stops where it was, in the pill's grey), "listening" (mode wave, lattice.ts frameWave, in the
    /// pause's blue: the agent waits for the user). "ORB <state>" on the pill's stdin sets it.
    var state = "working" {
        didSet {
            if state == oldValue { return }
            if state == "paused" { frozen = clock(oldValue) }
            needsDisplay = true
        }
    }
    var frozen = 0.6
    func clock(_ s: String) -> Double {
        redraw == nil ? 0.6 : Date().timeIntervalSince(started) * (s == "listening" ? 3.998 : 3.9)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        redraw?.invalidate()
        redraw = nil
        // With Reduce Motion on: the one still frame (t = .6).
        if window == nil || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }
        // About 10 frames a second, as on Windows (#414: 30 cost 3.7% of a core); a particle moves two or three points a frame.
        redraw = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.needsDisplay = true }
    }

    /// Deterministic hash in [0, 1) (core.ts hashD).
    func hash(_ a: Double, _ b: Double) -> Double {
        let h = sin(a * 12.9898 + b * 78.233) * 43758.5453
        return h - floor(h)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let box = 20.0, sized = 2.4
        let t = state == "paused" ? frozen : clock(state)
        let centre = box / 2, radius = centre * 0.82, scale = pow(box / 300, 0.6)
        var dots: [(x: Double, y: Double, z: Double, r: Double, ink: Double, alpha: Double)] = []
        if state == "listening" {
            // At 20 px: rings 15 and lonDensity 40 x sqrt(.105) = 5 and 13, radii x 1.6; turning .18 t, tilted .38.
            let r0 = centre * 0.874
            let yaw = t * 0.18, st = sin(0.38), ct = cos(0.38), sy = sin(yaw), cy = cos(yaw)
            for ri in 0...5 {
                let lat = -Double.pi / 2 + Double(ri) / 5 * Double.pi, cl = cos(lat), sl = sin(lat)
                let w = 0.62 * sin(t * 2.1 - Double(ri) * 0.52) + 0.38 * sin(t * 1.27 + Double(ri) * 0.83)   // two tempi
                let rr = r0 * (0.88 + 0.105 * w), crest = max(0, w)
                let lons = max(1, Int((abs(cl) * 13).rounded()))
                for lj in 0..<lons {
                    let lon = Double(lj) / Double(lons) * 2 * Double.pi
                    let x = cl * cos(lon) * rr, y = sl * rr, z = cl * sin(lon) * rr
                    let x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y1 = y * ct - z1 * st, z2 = y * st + z1 * ct
                    let depth = (z2 / r0 + 1) / 2
                    dots.append((x: centre + x1, y: centre - y1, z: z2,
                                 r: max(0.3, (0.6 + 1.7 * depth) * 1.6 * (1 + 0.4 * crest) * scale),
                                 ink: 0.66 - 0.56 * depth - 0.1 * crest, alpha: 1))
                }
            }
        }
        // The shared spin and tilt (core.ts makeProj).
        let yaw = t * 0.12, st = sin(0.3), ct = cos(0.3), sy = sin(yaw), cy = cos(yaw)
        for orbit in 0..<(state == "listening" ? 0 : 3) {
            let h1 = hash(Double(orbit), 1.7), h2 = hash(Double(orbit), 5.2), h3 = hash(Double(orbit), 8.9)
            let ro = radius * (0.45 + 0.52 * h1), th = h1 * 2 * Double.pi, phi = acos(2 * h2 - 1)
            // The orbit's plane: u and v at right angles to its normal.
            let nx = sin(phi) * cos(th), ny = cos(phi), nz = sin(phi) * sin(th)
            var ux = -ny, uy = nx
            let ul = max(1e-6, (ux * ux + uy * uy).squareRoot())
            ux /= ul
            uy /= ul
            let vx = -nz * uy, vy = nz * ux, vz = nx * uy - ny * ux
            let turn = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1)
            for k in 0..<13 {
                let ghost = k < 10   // ten dots along the path, then three particles
                let a = ghost ? Double(k) * 2 * Double.pi / 10 : t * turn + Double(k - 10) * 2 * Double.pi / 3 + h2 * 6
                let x = (ux * cos(a) + vx * sin(a)) * ro, y = (uy * cos(a) + vy * sin(a)) * ro, z = vz * sin(a) * ro
                let x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y1 = y * ct - z1 * st, z2 = y * st + z1 * ct
                let depth = (z2 / ro + 1) / 2
                dots.append((x: centre + x1, y: centre - y1, z: z2,
                             r: max(0.3, (ghost ? 0.9 * sized : (1.2 + 1.6 * depth) * sized) * scale),
                             ink: ghost ? 0.72 : 0.3 - 0.22 * depth,
                             alpha: ghost ? 0.5 * (0.4 + 0.6 * depth) : 1))
            }
        }
        // Far to near; on a dark ground the tint fades toward black with the ink (core.ts inkColor). The state's tint:
        // amber at work, the pill's grey when paused, the pause's blue when it waits for the user.
        let tint: (r: CGFloat, g: CGFloat, b: CGFloat) = state == "paused" ? (140, 146, 158) : state == "listening" ? (59, 130, 246) : (245, 158, 11)
        for d in dots.sorted(by: { $0.z < $1.z }) {
            let ink = CGFloat(1 - min(1, max(0, d.ink)))
            ctx.setFillColor(red: tint.r / 255 * ink, green: tint.g / 255 * ink, blue: tint.b / 255 * ink, alpha: CGFloat(d.alpha))
            ctx.fillEllipse(in: CGRect(x: d.x - d.r, y: d.y - d.r, width: 2 * d.r, height: 2 * d.r))
        }
    }
}

// The agent's ghost cursor: a retro pixel arrow, so it never looks like the user's cursor. One grid shared with the
// Windows drawer (scripts/agent-cursor.json: K rim, B body; the tip is the hotspot, 0,0).
// AGENT-CURSOR-BEGIN
let agentCursor: [String] = [
    "K..........",
    "KK.........",
    "KBK........",
    "KBBK.......",
    "KBBBK......",
    "KBBBBK.....",
    "KBBBBBK....",
    "KBBBBBBK...",
    "KBBBBBBBK..",
    "KBBBBBBBBK.",
    "KBBBBBKKKKK",
    "KBBKBBK....",
    "KBK.KBBK...",
    "KK..KBBK...",
    "K....KBBK..",
    ".....KBBK..",
    "......KK...",
]
// AGENT-CURSOR-END

/// The agent cursor as crisp filled squares (no interpolation). `cell` is points per grid square.
final class CursorView: NSView {
    let cell: CGFloat
    override var isFlipped: Bool { true }   // row 0 is the top, the tip (0,0) the top-left corner

    init(cell: CGFloat) {
        self.cell = cell
        super.init(frame: NSRect(x: 0, y: 0, width: CGFloat(agentCursor[0].count) * cell, height: CGFloat(agentCursor.count) * cell))
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.setShouldAntialias(false)   // squares on the pixel grid, no soft edges
        for (r, row) in agentCursor.enumerated() {
            for (c, ch) in row.enumerated() where ch != "." {
                ctx.setFillColor((ch == "K" ? hexColor("#C9DDF2") : hexColor("#1B2232")).cgColor)
                ctx.fill(CGRect(x: CGFloat(c) * cell, y: CGFloat(r) * cell, width: cell, height: cell))
            }
        }
    }
}

final class Overlay: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let mode: String
    init(mode: String) { self.mode = mode }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if mode == "pill" { pill() } else if mode == "glow" { glow() } else { windowOutline() }
        giveFocusBack()
        // Activation can also land a moment after launch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { giveFocusBack() }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification,
                                               object: nil, queue: .main) { _ in giveFocusBack() }
        // Follow the user: if they switch apps while the pill is up (to sign in,
        // say), that app — not the launch-time one — is where focus goes back.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { note in
            if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
               !isOverlay(app) {
                previousApp = app
            }
        }
    }

    var windows: [NSWindow] = []
    var timer: Timer?
    var chime: NSSound?   // held so the sound isn't released mid-play

    @objc func answer(_ sender: FirstClickButton) {
        emit(sender.line)
        NSApp.terminate(nil)
    }

    /// The running pill's Pause / Resume: one line on stdout, and the pill stays (the parent answers HELD ON / HELD OFF).
    @objc func holdClicked(_ sender: FirstClickButton) {
        emit(sender.line)
    }

    /// A flat rounded button; a click prints `line` (see answer) unless the caller changes the action.
    func makeButton(_ text: String, _ line: String, frame: NSRect, color: NSColor, textColor: NSColor = .white,
                    fontSize: CGFloat = 13, semibold: Bool = true, radius: CGFloat = 8, left: Bool = false) -> FirstClickButton {
        let b = FirstClickButton(frame: frame)
        b.title = text
        b.line = line
        b.isBordered = false
        b.wantsLayer = true
        b.layer?.backgroundColor = color.cgColor
        b.layer?.cornerRadius = radius
        let weight: NSFont.Weight = semibold ? .semibold : .regular
        var attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: textColor,
            .font: NSFont.systemFont(ofSize: fontSize, weight: weight)]
        if left {
            let ps = NSMutableParagraphStyle()
            ps.alignment = .left
            ps.firstLineHeadIndent = 10
            ps.lineBreakMode = .byTruncatingTail
            attrs[.paragraphStyle] = ps
            b.alignment = .left
        }
        b.attributedTitle = NSAttributedString(string: text, attributes: attrs)
        b.target = self
        b.action = #selector(answer(_:))
        return b
    }

    /// The running pill's orb (#392), in place of the blinking dot: Thinking Orbs' "working" state (OrbView).
    func makeOrb() -> NSView {
        return OrbView(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
    }

    // The running pill: [orb] ClawdCursor  <activity>  m:ss  [Pause] [Stop]
    var runDot: NSView?
    var userMoved = false   // the user dragged the pill: layoutRunning keeps it where it was dropped
    var runActivity: NSTextField?
    var runTrack: NSView?               // the activity's window: as wide as "running in background", the text runs through it
    var marqueeWidth: CGFloat = 0
    var marqueeLoop: CGFloat = 0        // points from one copy of the text to the next; 0: it fits and stands still
    var marqueeStill = Date()           // a new text stands still a moment before it runs
    var marqueeTimer: Timer?
    var runClock: NSTextField?
    var runBrand: NSTextField?
    var runStop: NSButton?
    var runHold: FirstClickButton?
    var runStart = Date()

    /// Lays the row out left to right, sizes the pill to it and puts it back at the top centre.
    func layoutRunning() {
        guard let panel = pillPanel, let dot = runDot, let brand = runBrand, let act = runActivity, let track = runTrack,
              let clock = runClock, let hold = runHold, let stop = runStop else { return }
        let rowH: CGFloat = 38
        // `fixed`: always that width (owner, 2026-11-19: the pill must not grow and shrink as its text changes).
        func place(_ l: NSTextField, _ x: CGFloat, _ maxWidth: CGFloat, fixed: Bool = false) -> CGFloat {
            l.sizeToFit()
            let w = fixed ? maxWidth : min(ceil(l.frame.width), maxWidth)
            let h = ceil(l.frame.height)
            l.frame = NSRect(x: x, y: floor((rowH - h) / 2), width: w, height: h)
            return w
        }
        var x: CGFloat = 14
        dot.frame = NSRect(x: x - 2, y: (rowH - dot.frame.height) / 2, width: dot.frame.width, height: dot.frame.height)
        x += dot.frame.width + 2
        x += place(brand, x, 200) + 6
        let actH = ceil(act.frame.height)
        track.frame = NSRect(x: x, y: floor((rowH - actH) / 2), width: marqueeWidth, height: actH)
        x += marqueeWidth + 8
        x += place(clock, x, 40, fixed: true) + 12
        hold.frame = NSRect(x: x, y: 7, width: 60, height: 24)
        x += 60 + 6
        stop.frame = NSRect(x: x, y: 7, width: 52, height: 24)
        x += 52 + 7
        let width = ceil(x)
        let screen = NSScreen.screens.first ?? NSScreen.main!
        let area = screen.visibleFrame
        if userMoved {   // grow and shrink from the top-left corner it was dropped at
            let old = panel.frame
            panel.setFrame(NSRect(x: old.minX, y: old.maxY - rowH, width: width, height: rowH), display: true)
        } else {
            let y = ProcessInfo.processInfo.environment["CLAWD_BANNER_POS"] == "bottom" ? area.minY + 8 : area.maxY - rowH - 8
            panel.setFrame(NSRect(x: area.midX - width / 2, y: y, width: width, height: rowH), display: true)
        }
    }

    /// The pill keeps one small size (owner, 2026-11-19: never growing with its text, and "small like it was before"):
    /// text that does not fit runs through the activity's window like an LED marquee sign, round and round.
    func setActivity(_ text: String) {
        guard let act = runActivity else { return }
        act.stringValue = text
        act.sizeToFit()
        let one = act.frame.width
        if one <= marqueeWidth {
            marqueeLoop = 0
        } else {
            act.stringValue = text + "      " + text
            act.sizeToFit()
            marqueeLoop = act.frame.width - one
        }
        act.setFrameOrigin(NSPoint(x: 0, y: 0))
        marqueeStill = Date()
        layoutRunning()
    }

    func stepMarquee() {
        guard marqueeLoop > 0, let act = runActivity, Date().timeIntervalSince(marqueeStill) >= 1.2 else { return }
        var x = act.frame.origin.x - 1
        if x <= -marqueeLoop { x += marqueeLoop }
        act.setFrameOrigin(NSPoint(x: x, y: act.frame.origin.y))
    }

    /// "HELD ON": the user holds the agent, so the button offers Resume (blue); "HELD OFF": Pause again.
    func setHeld(_ on: Bool) {
        guard let hold = runHold else { return }
        let text = on ? "Resume" : "Pause"
        hold.line = on ? "BANNER_RESUME" : "BANNER_PAUSE"
        hold.layer?.backgroundColor = (on ? rgb(37, 99, 235) : rgb(58, 62, 72)).cgColor
        hold.attributedTitle = NSAttributedString(string: text, attributes: [
            .foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 11, weight: .semibold)])
    }

    func updateClock() {
        guard let clock = runClock else { return }
        let s = Int(Date().timeIntervalSince(runStart))
        let t = String(format: "%d:%02d", s / 60, s % 60)
        if clock.stringValue != t {
            clock.stringValue = t
            layoutRunning()
        }
    }

    // "Something else": the user types an answer for the agent instead of doing the step.
    var pillPanel: PillPanel?
    var choiceButtons: [NSView] = []
    var replyField: NSTextField?
    var sendButton: NSButton?

    func showReply(_ on: Bool) {
        choiceButtons.forEach { $0.isHidden = on }
        replyField?.isHidden = !on
        sendButton?.isHidden = !on
        typingReply = on
        if on, let panel = pillPanel, let field = replyField {
            takeKeyboard(panel, field)
        } else {
            releaseKeyboard()   // the panel may be key while this app is not active: giveFocusBack() alone did nothing
        }
    }

    @objc func somethingElse(_ sender: Any?) { showReply(true) }

    /// stdin carries "HIDE <ms>" from the parent just before an agent's click: the pill steps aside so the click reaches
    /// the app under it (it sits where browsers keep their tab strip and address bar), then comes back on its own.
    var hideToken = 0
    func listenForCommands() {
        var pending = ""
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {   // EOF: the parent is gone, and neither the pill nor the outline may outlive it
                handle.readabilityHandler = nil
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            pending += String(decoding: data, as: UTF8.self)
            while let nl = pending.firstIndex(of: "\n") {
                let line = pending[..<nl].trimmingCharacters(in: .whitespaces)
                pending = String(pending[pending.index(after: nl)...])
                if line.hasPrefix("HIDE "), let ms = Int(line.dropFirst(5)) {
                    DispatchQueue.main.async { self?.hide(for: ms) }
                } else if line.hasPrefix("ACTIVITY ") {
                    let text = String(line.dropFirst(9))
                    DispatchQueue.main.async { self?.setActivity(text) }
                } else if line == "HELD ON" || line == "HELD OFF" {
                    let on = line == "HELD ON"
                    DispatchQueue.main.async { self?.setHeld(on) }
                } else if line.hasPrefix("ORB ") {
                    let state = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                    DispatchQueue.main.async { (self?.runDot as? OrbView)?.state = state }
                } else if line == "TARGET" || line.hasPrefix("TARGET ") {
                    // Pairs after the word: <window number or 0> <pid>.
                    let parts = line.split(separator: " ")
                    var found: [(num: Int, pid: Int)] = []
                    var i = 1
                    while i + 1 < parts.count {
                        if let pid = Int(parts[i + 1]), pid != 0 { found.append((num: Int(parts[i]) ?? 0, pid: pid)) }
                        i += 2
                    }
                    DispatchQueue.main.async { self?.targets = found }
                } else if line == "ON" || line == "OFF" {
                    DispatchQueue.main.async { self?.glowOn = line == "ON" }
                } else if line == "GHOST" || line.hasPrefix("GHOST ") {
                    let parts = line.split(separator: " ")
                    let point = parts.count > 2 ? Double(parts[1]).flatMap { x in Double(parts[2]).map { y in CGPoint(x: x, y: y) } } : nil
                    DispatchQueue.main.async { self?.showGhost(point) }
                }
            }
        }
    }

    func hide(for ms: Int) {
        if mode == "glow" { glowHideUntil = Date().addingTimeInterval(Double(max(50, min(ms, 10_000))) / 1000); return }
        guard let panel = pillPanel else { return }
        hideToken += 1
        let token = hideToken
        panel.orderOut(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(50, min(ms, 10_000)))) { [weak self] in
            guard let self = self, self.hideToken == token else { return }   // a later HIDE extends the hiding
            panel.orderFrontRegardless()
        }
    }

    /// Enter in the field or the Send button. One line on stdout: BANNER_REPLY <base64 of the UTF-8 text>.
    @objc func sendReply(_ sender: Any?) {
        let text = (replyField?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        emit("BANNER_REPLY " + Data(text.utf8).base64EncodedString())
        typingReply = false
        giveFocusBack()
        NSApp.terminate(nil)
    }

    /// The card's own text box (`input`) rather than "Something else"; a longer answer takes Enter for a new line.
    var inlineInput = false
    var multilineInput = false

    /// Esc in the card's own box (what was typed stays), or in "Something else" (back to the buttons): the panel stops
    /// being key and the user's app gets the keyboard back. A key non-activating panel never made this app active, so giveFocusBack() (guarded by NSApp.isActive)
    /// would do nothing here: the panel has to leave the screen to resign key, then come back, and the app is activated
    /// directly. Deferred a turn so it does not run inside the field editor's own command handling.
    func releaseKeyboard() {
        typingReply = false
        pillPanel?.makeFirstResponder(nil)
        pillPanel?.allowKey = false
        DispatchQueue.main.async { [weak self] in
            if let panel = self?.pillPanel {
                panel.orderOut(nil)
                panel.orderFrontRegardless()
            }
            if let prev = previousApp, !prev.isTerminated, !isOverlay(prev) { handBack(to: prev) } else { NSApp.deactivate() }
        }
    }

    /// Esc in the field: back to the buttons ("Something else"), or the keyboard back to the user's app (the card's own
    /// box). Return in a multiline box adds a line; Cmd+Return sends.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            if inlineInput {
                releaseKeyboard()
            } else {
                replyField?.stringValue = ""
                showReply(false)
            }
            return true
        }
        if multilineInput && selector == #selector(NSResponder.insertNewline(_:)) {
            if NSApp.currentEvent?.modifierFlags.contains(.command) == true {
                sendReply(nil)
            } else {
                textView.insertNewlineIgnoringFieldEditor(nil)
            }
            return true
        }
        return false
    }

    func pill() {
        let paused = ProcessInfo.processInfo.environment["CLAWD_BANNER_MODE"] == "paused"
        // The running pill sizes itself to its row (layoutRunning); 300 is only the starting width.
        let width: CGFloat = paused ? 460 : 300
        let content = PillView(frame: .zero)
        content.wantsLayer = true
        content.layer?.backgroundColor = background.cgColor
        // Rounded without clipping (everything on it sits inside the corners): a rounded clip renders the pill off screen
        // again on each frame of the orb (#414).
        content.layer?.cornerRadius = paused ? 14 : 19
        content.layer?.borderWidth = 1
        content.layer?.borderColor = (paused ? blue : outline).cgColor

        // The paused card's orb: the library's "listening" state, in the pause's blue (the running pill's is makeOrb()).
        let dot = OrbView(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        dot.state = "listening"
        var height: CGFloat = 38

        if paused {
            let pad: CGFloat = 18
            let inner = width - 2 * pad
            let env = ProcessInfo.processInfo.environment
            let message = env["CLAWD_BANNER_MESSAGE"] ?? ""
            let app = env["CLAWD_BANNER_APP"] ?? ""
            var titleText = "ClawdCursor \u{00B7} waiting for you"
            if !app.isEmpty { titleText += " \u{00B7} " + app }
            let title = label(titleText, size: 11, color: headerBlue, semibold: true)
            title.lineBreakMode = .byTruncatingTail
            let msg = NSTextField(wrappingLabelWithString: message)
            msg.font = NSFont.systemFont(ofSize: 13)
            msg.textColor = NSColor(srgbRed: 232 / 255, green: 234 / 255, blue: 237 / 255, alpha: 1)
            msg.preferredMaxLayoutWidth = inner
            let msgH = ceil(msg.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: inner, height: 10_000)).height)
            let msgTop: CGFloat = 40
            let afterMsg: CGFloat = msgTop + msgH + 14

            // The card (set by pause_for_user): CLAWD_BANNER_CHOICES = JSON array of strings -> one button each, printing
            // BANNER_CHOICE <index>; CLAWD_BANNER_INPUT = JSON {placeholder, multiline} -> a text box (BANNER_REPLY).
            // Neither set = the plain prompt. They sit above the usual Resume / End task row.
            func envJSON(_ name: String) -> Any? {
                guard let s = ProcessInfo.processInfo.environment[name], !s.isEmpty, let d = s.data(using: .utf8) else { return nil }
                return try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
            }
            let choices: [String] = Array(((envJSON("CLAWD_BANNER_CHOICES") as? [Any]) ?? [])
                .compactMap { $0 as? String }.filter { !$0.isEmpty }.prefix(6))
            let inputCfg = envJSON("CLAWD_BANNER_INPUT") as? [String: Any]
            let hasInput = inputCfg != nil
            let multiline = (inputCfg?["multiline"] as? Bool) == true
            let placeholder = (inputCfg?["placeholder"] as? String) ?? ""
            inlineInput = hasInput
            multilineInput = multiline
            let boxH: CGFloat = multiline ? 66 : 26
            let choicesH: CGFloat = choices.isEmpty ? 0 : CGFloat(choices.count) * 40 + 6
            let hintH: CGFloat = placeholder.isEmpty ? 0 : 20
            let boxRowH: CGFloat = max(boxH, 30) + 2
            let inputH: CGFloat = hasInput ? hintH + boxRowH + 26 : 0
            // Offsets below are from the top of the card; the footer row (Something else / End task / Resume) starts at `rowTop`.
            let rowTop: CGFloat = afterMsg + choicesH + inputH
            height = rowTop + 30 + 16

            dot.frame = NSRect(x: pad - 4, y: height - 16 - 18, width: 20, height: 20)
            title.frame = NSRect(x: pad + 20, y: height - 16 - 16, width: inner - 20, height: 16)
            msg.frame = NSRect(x: pad, y: height - msgTop - msgH, width: inner, height: msgH)

            let gray = footerBg
            let dim = muted
            var cardViews: [NSView] = []

            // One full-width row per option, top to bottom.
            var cy = afterMsg
            for (i, text) in choices.enumerated() {
                let row = makeButton(text, "BANNER_CHOICE \(i)",
                                     frame: NSRect(x: pad, y: height - cy - 34, width: inner, height: 34),
                                     color: rowBg, semibold: false, left: true)
                cardViews.append(row)
                cy += 40
            }

            // The text box: on the card from the start with `input` (a click into it takes the keyboard); otherwise
            // it is "Something else" and stays hidden until that button is clicked.
            var boxTop = rowTop + 2   // "Something else": over the Resume row
            if hasInput {
                var iy = afterMsg + choicesH
                if !placeholder.isEmpty {
                    let hint = label(placeholder, size: 12, color: dim)
                    hint.lineBreakMode = .byTruncatingTail
                    hint.frame = NSRect(x: pad, y: height - iy - 16, width: inner, height: 16)
                    cardViews.append(hint)
                    iy += 20
                }
                boxTop = iy
                iy += boxRowH
                let warn = label("Don't type passwords here", size: 12, color: dim)
                warn.frame = NSRect(x: pad, y: height - iy - 16, width: inner, height: 16)
                cardViews.append(warn)
            }

            // Footer: "Something else..." on the left (not with `input`); End task then Resume on the right.
            let footerY: CGFloat = 16
            let resume = makeButton("Resume", "BANNER_RESUME",
                                    frame: NSRect(x: width - pad - 96, y: footerY, width: 96, height: 30),
                                    color: choices.isEmpty ? blue : gray)
            let end = makeButton("End task", "BANNER_END",
                                 frame: NSRect(x: width - pad - 96 - 8 - 96, y: footerY, width: 96, height: 30),
                                 color: gray, textColor: endRed)
            var other: FirstClickButton? = nil
            if !hasInput {
                let o = makeButton("Something else\u{2026}", "",
                                   frame: NSRect(x: pad, y: footerY, width: 132, height: 30),
                                   color: gray, textColor: headerBlue)
                o.action = #selector(somethingElse(_:))
                other = o
            }
            if let other = other { choiceButtons = [resume, other, end] } else { choiceButtons = [resume, end] }

            let boxHeight: CGFloat = hasInput ? boxH : 26
            let field = ClickToTypeField(frame: NSRect(x: pad, y: height - boxTop - boxHeight, width: inner - 84, height: boxHeight))
            field.font = NSFont.systemFont(ofSize: 13)
            field.textColor = .white
            field.backgroundColor = rowBg
            field.isBezeled = true
            field.bezelStyle = .squareBezel
            if multiline {
                field.cell?.usesSingleLineMode = false
                field.cell?.wraps = true
                field.cell?.isScrollable = false
                field.lineBreakMode = .byWordWrapping
            }
            if !hasInput { field.placeholderString = "Tell the agent what to do instead" }
            field.target = self
            field.action = #selector(sendReply(_:))
            field.delegate = self
            field.isHidden = !hasInput
            replyField = field
            let send = makeButton("Send", "",
                                  frame: NSRect(x: width - pad - 76, y: hasInput ? height - boxTop - 30 : footerY, width: 76, height: 30),
                                  color: blue)
            send.action = #selector(sendReply(_:))
            send.isHidden = !hasInput
            sendButton = send

            var views: [NSView] = [dot, title, msg]
            views.append(contentsOf: cardViews)
            let bottom: [NSView] = [resume, end, field, send]
            views.append(contentsOf: bottom)
            if let other = other { views.append(other) }
            views.forEach { content.addSubview($0) }
        } else {
            let brand = label("ClawdCursor", size: 11, color: muted, semibold: true)
            let initial = ProcessInfo.processInfo.environment["CLAWD_BANNER_ACTIVITY"] ?? ""
            let activity = label(initial.isEmpty ? "Working" : initial, size: 12, color: .white, semibold: true)
            activity.lineBreakMode = .byClipping
            let probe = label("running in background", size: 12, color: .white, semibold: true)
            probe.sizeToFit()
            marqueeWidth = ceil(probe.frame.width)
            let track = NSView()
            track.wantsLayer = true
            track.layer?.masksToBounds = true
            track.addSubview(activity)
            let clock = label("0:00", size: 11, color: muted)
            clock.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            let stop = makeButton("Stop", "BANNER_STOP", frame: NSRect(x: 0, y: 7, width: 52, height: 24),
                                  color: rgb(64, 30, 33), textColor: rgb(252, 165, 165), fontSize: 11, radius: 6)
            // Pause: the agent waits, background work included, until Resume here (owner, 2026-11-18).
            let hold = makeButton("Pause", "BANNER_PAUSE", frame: NSRect(x: 0, y: 7, width: 60, height: 24),
                                  color: rgb(58, 62, 72), fontSize: 11, radius: 6)
            hold.action = #selector(holdClicked(_:))
            runHold = hold
            let orb = makeOrb()
            let rowViews: [NSView] = [orb, brand, track, clock, hold, stop]
            rowViews.forEach { content.addSubview($0) }
            runDot = orb
            runBrand = brand
            runActivity = activity
            runTrack = track
            setActivity(initial.isEmpty ? "Working" : initial)
            runClock = clock
            runStop = stop
            runStart = Date()
            content.onDoubleClick = {
                emit("BANNER_STOP")
                NSApp.terminate(nil)
            }
            content.onDragged = { [weak self] in self?.userMoved = true }
            // No amber ring when the pill appears (owner, 2026-11-19: an amber ring round the pill read as the agent
            // outlining it): the usual thin outline from the start.
            content.layer?.borderColor = rgb(58, 62, 72).cgColor
            content.layer?.borderWidth = 1
        }

        let screen = NSScreen.screens.first ?? NSScreen.main!
        let area = screen.visibleFrame
        // CLAWD_BANNER_POS=bottom: at the bottom of the screen (default: the top, which a notch can cover).
        let y = ProcessInfo.processInfo.environment["CLAWD_BANNER_POS"] == "bottom" ? area.minY + 8 : area.maxY - height - 8
        let frame = NSRect(x: area.midX - width / 2, y: y, width: width, height: height)
        let panel = PillPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        // For the person at the screen only: never part of a screenshot or OCR capture (it sat over apps' toolbars).
        panel.sharingType = .none
        panel.hidesOnDeactivate = false
        content.frame = NSRect(x: 0, y: 0, width: width, height: height)
        panel.contentView = content
        panel.orderFrontRegardless()
        windows.append(panel)
        pillPanel = panel
        if !paused { layoutRunning() }
        listenForCommands()

        // A short system sound when the prompt appears, so a user who isn't
        // looking hears it's their turn (#237). CLAWD_PAUSE_SOUND=0 turns it off.
        if paused && ProcessInfo.processInfo.environment["CLAWD_PAUSE_SOUND"] != "0" {
            if let sound = NSSound(named: "Glass") {
                chime = sound
                sound.play()
            } else {
                NSSound.beep()
            }
        }

        // The running pill's clock; the card's orb moves by itself.
        if !paused {
            timer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in self?.updateClock() }
            marqueeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.stepMarquee() }
        }
    }

    /// The windows that get an outline ("TARGET <handle> <pid> [...]" on stdin): a window number (0: the process's
    /// frontmost ordinary window) and its process. Empty: none.
    var targets: [(num: Int, pid: Int)] = []
    var outlineWindows: [NSWindow] = []
    var outlineColor = "#f59e0b"

    /// A window nobody sees is passed over: one that is see-through (alpha 0), or a sliver under 40 pt that an app keeps
    /// for itself. Returns its AppKit frame (Quartz measures down from the top of the primary display, AppKit up from its
    /// bottom) and its window number.
    func seenFrame(_ w: [String: Any]) -> (frame: NSRect, number: Int)? {
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01,
              let number = w[kCGWindowNumber as String] as? Int,
              let bounds = w[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              rect.width >= 40, rect.height >= 40,
              let primary = NSScreen.screens.first else { return nil }
        return (NSRect(x: rect.minX, y: primary.frame.height - rect.maxY, width: rect.width, height: rect.height), number)
    }

    /// One (frame, window number) per target that is on screen now, in the same order as `targets`. The window list is
    /// front to back; with a window number the target is that window, with 0 the process's frontmost ordinary one.
    func targetFrames() -> [(frame: NSRect, number: Int)] {
        guard !targets.isEmpty,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return [] }
        var found: [(frame: NSRect, number: Int)] = []
        for t in targets {
            for w in list where (w[kCGWindowOwnerPID as String] as? Int) == t.pid {
                if t.num != 0 && (w[kCGWindowNumber as String] as? Int) != t.num { continue }
                if let v = seenFrame(w) {
                    if !found.contains(where: { $0.number == v.number }) { found.append(v) }
                    break
                }
            }
        }
        return found
    }

    func makeOutlineWindow() -> NSWindow {
        let win = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
        win.isOpaque = false
        win.backgroundColor = .clear   // only the border is drawn: nothing over the window's content
        win.hasShadow = false
        win.ignoresMouseEvents = true
        // Ordinary level, ordered just above the agent's window (see windowOutline): a window in front of the agent's
        // covers the border, and the user's front window is never covered by it.
        win.level = .normal
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        win.sharingType = .none  // the outline is not captured either
        let view = NSView()
        view.wantsLayer = true
        view.layer?.borderColor = hexColor(outlineColor).cgColor
        view.layer?.borderWidth = 3   // points: AppKit scales it for each display
        // Rounded like the window's own corners, or a wedge of what is behind shows at each one. The system does not
        // give a window's radius: about 16 pt for a standard window on macOS 26 (which reports itself as 16 to a
        // binary built with an older SDK), about 10 pt before.
        view.layer?.cornerRadius = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 16 ? 16 : 10
        win.contentView = view
        return win
    }

    func windowOutline() {
        outlineColor = option("--color", "#f59e0b")
        listenForCommands()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let frames = self.targetFrames()
            while self.outlineWindows.count < frames.count {
                let w = self.makeOutlineWindow()
                self.outlineWindows.append(w)
                self.windows.append(w)
            }
            for (i, win) in self.outlineWindows.enumerated() {
                guard i < frames.count else { win.orderOut(nil); continue }
                if win.frame != frames[i].frame { win.setFrame(frames[i].frame, display: true) }
                // Just above the agent's window, wherever it is in the stack.
                win.order(.above, relativeTo: frames[i].number)
            }
            self.updateGhost()
        }
    }

    // The ghost cursor: a retro pixel arrow where the agent's pointer would be, about 1.5 s after the last GHOST. Click-through,
    // never in a capture, and the real cursor is never moved.
    var ghostWindow: NSWindow?
    var ghostUntil = Date.distantPast

    /// `point`: screen coordinates, origin at the top-left of the primary display, the tip of the arrow at the point.
    func showGhost(_ point: CGPoint?) {
        guard let p = point, let primary = NSScreen.screens.first else { ghostUntil = .distantPast; updateGhost(); return }
        let m = ghostWindow?.contentView as? CursorView ?? CursorView(cell: 2)
        if ghostWindow == nil {
            let win = NSWindow(contentRect: m.frame, styleMask: .borderless, backing: .buffered, defer: false)
            win.isOpaque = false
            win.backgroundColor = .clear
            win.hasShadow = false
            win.ignoresMouseEvents = true
            win.level = .statusBar
            win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            win.sharingType = .none
            win.contentView = m
            ghostWindow = win
            windows.append(win)
        }
        ghostWindow?.setFrameOrigin(NSPoint(x: p.x, y: primary.frame.height - p.y - m.frame.height))
        ghostUntil = Date().addingTimeInterval(1.5)
        updateGhost()
    }

    func updateGhost() {
        guard let win = ghostWindow else { return }
        if Date() < ghostUntil { if !win.isVisible { win.orderFrontRegardless() } } else if win.isVisible { win.orderOut(nil) }
    }

    // The full-screen edge glow (foreground mode): starts hidden; "ON" / "OFF" / "HIDE <ms>" on stdin show and hide it.
    // Adapted from the glow proven live in PR #448: one window per screen, four gradient bands, a pulsing opacity.
    var glowWindows: [NSWindow] = []
    var glowOn = false { didSet { updateGlow() } }
    var glowHideUntil = Date.distantPast { didSet { updateGlow() } }

    func updateGlow() {
        let want = glowOn && Date() >= glowHideUntil
        for win in glowWindows {
            if want && !win.isVisible { win.orderFrontRegardless() } else if !want && win.isVisible { win.orderOut(nil) }
        }
    }

    func glow() {
        let color = option("--color", "#f59e0b")
        let thickness = CGFloat(Double(option("--thickness", "80")) ?? 80)
        let period = (Double(option("--period", "1600")) ?? 1600) / 1000
        let minAlpha = Float((Double(option("--min-alpha", "60")) ?? 60) / 255)
        let peak = CGFloat((Double(option("--peak-alpha", "200")) ?? 200) / 255)
        let edge = hexColor(color, alpha: peak).cgColor
        let clear = hexColor(color, alpha: 0).cgColor

        for screen in NSScreen.screens {
            let f = screen.frame
            let win = NSWindow(contentRect: f, styleMask: .borderless, backing: .buffered, defer: false)
            win.isOpaque = false
            win.backgroundColor = .clear
            win.hasShadow = false
            win.ignoresMouseEvents = true // click-through
            win.level = .statusBar // above apps and the menu bar, below the pill (.screenSaver)
            win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            win.sharingType = .none // for the person at the screen only: not in a screenshot
            let view = NSView(frame: NSRect(origin: .zero, size: f.size))
            view.wantsLayer = true
            let root = CALayer()
            root.frame = view.bounds
            let t = min(thickness, f.width / 2, f.height / 2)
            let w = f.width, h = f.height
            // Layer unit coordinates on macOS: (0,0) is bottom-left.
            let bands: [(CGRect, CGPoint, CGPoint)] = [
                (CGRect(x: 0, y: h - t, width: w, height: t), CGPoint(x: 0.5, y: 1), CGPoint(x: 0.5, y: 0)), // top
                (CGRect(x: 0, y: 0, width: w, height: t), CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: 1)),     // bottom
                (CGRect(x: 0, y: 0, width: t, height: h), CGPoint(x: 0, y: 0.5), CGPoint(x: 1, y: 0.5)),     // left
                (CGRect(x: w - t, y: 0, width: t, height: h), CGPoint(x: 1, y: 0.5), CGPoint(x: 0, y: 0.5)), // right
            ]
            for (rect, start, end) in bands {
                let g = CAGradientLayer()
                g.frame = rect
                g.colors = [edge, clear]
                g.startPoint = start
                g.endPoint = end
                root.addSublayer(g)
            }
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = minAlpha
            pulse.toValue = Float(1)
            pulse.duration = period / 2
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            root.add(pulse, forKey: "pulse")
            view.layer?.addSublayer(root)
            win.contentView = view
            win.setFrame(f, display: false)
            glowWindows.append(win)   // starts hidden: ON shows it
            windows.append(win)
        }
        listenForCommands()   // stdin: ON / OFF / HIDE <ms>, and its EOF ends the glow
        // A HIDE runs out by itself: the glow comes back if it is still wanted.
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.updateGlow() }
    }
}

let mode = CommandLine.arguments.dropFirst().first ?? ""
guard mode == "pill" || mode == "outline" || mode == "glow" else {
    FileHandle.standardError.write("usage: overlay pill | outline [--color #RRGGBB] | glow\n".data(using: .utf8)!)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let overlay = Overlay(mode: mode)
app.delegate = overlay
app.run()
