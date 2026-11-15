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
//                  stdin also takes "HIDE <ms>". Paused (env CLAWD_BANNER_MODE=paused):
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
//   overlay outline [--color #RRGGBB] [--paused]
//                  a thin border around the display, on every screen, and nothing
//                  else: no fill, nothing over the middle of a screen; clicks pass
//                  straight through it. It is up from the start and tracks no window
//                  (a "TARGET" line on stdin, from an older parent, is ignored); the
//                  screens are looked at again every 100 ms.
//                  The border: Border Beam's pulse-inner (below) - coloured blobs that
//                  breathe just inside the screen's edge, a 1 pt ring and a glow 28 pt
//                  deep, drawn cheaply (windowOutline); --paused: the same in blue
//                  ("ocean"), still. With Reduce Motion on: still. (--color is accepted
//                  and not used.)
//
// The pill's orb is a port of Thinking Orbs, and the beam is Border Beam (size "pulse-inner", colorVariant "gold",
// borderRadius 23, duration 3.9 s, the library's defaults otherwise), by Jakub Antalik (libraries.dev,
// github.com/Jakubantalik/Libraries.dev, packages/border-beam and packages/thinking-orbs), MIT License,
// Copyright (c) 2026 Jakub Antalik. The recipe table and the licence notice in full are at the top of
// scripts/window-outline.ps1, the Windows drawer.
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

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor {
    return NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: 1)
}

let blue = rgb(59, 130, 246)
let blueDim = rgb(25, 55, 110)
let background = rgb(22, 24, 29)
let outline = rgb(58, 62, 72)
let muted = rgb(140, 146, 158)
let headerBlue = rgb(147, 180, 245)
let rowBg = rgb(34, 38, 46)
let footerBg = rgb(44, 48, 57)
let endRed = rgb(248, 113, 113)

/// A panel that never becomes key or main: clicking it leaves focus where it was. The one exception is the user's own
/// click on "Something else": then it may become key (a non-activating panel takes keystrokes without activating the app).
final class PillPanel: NSPanel {
    var allowKey = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }
}

/// Set while the user types an answer: focus is not handed back then.
var typingReply = false

/// Buttons in a non-key panel must act on the first click.
final class FirstClickButton: NSButton {
    var line = ""
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The text box that is on the card from the start (pause_for_user's `input`): a click into it makes the panel key, so
/// the user can type; nothing else ever gives the panel the keyboard.
final class ClickToTypeField: NSTextField {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if let panel = window as? PillPanel, !panel.allowKey {
            typingReply = true
            panel.allowKey = true
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(self)
        }
        super.mouseDown(with: event)
    }
}

final class PillView: NSView {
    var onDoubleClick: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onDoubleClick?() }
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
var previousApp = NSWorkspace.shared.frontmostApplication

func giveFocusBack() {
    guard !typingReply, NSApp.isActive, let prev = previousApp,
          prev.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
    NSApp.deactivate()
    if #available(macOS 14.0, *) { prev.activate() } else { prev.activate(options: []) }
}

/// Thinking Orbs' default state, "working", at its 20 pt size: particles running on tilted orbits around a slowly
/// turning dotted sphere, in amber ink (the library's tint) on the dark pill. The numbers are the library's (spec/orbs-spec.json,
/// src/engine/orbits.ts and core.ts); the Windows pill (scripts/banner.ps1, class Orb) lists them.
final class OrbView: NSView {
    let started = Date()
    var redraw: Timer?
    override var isFlipped: Bool { true }   // y grows downward, as on the canvas the numbers are for

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
        let box = 20.0, speed = 3.9, sized = 2.4
        let t = redraw == nil ? 0.6 : Date().timeIntervalSince(started) * speed
        let centre = box / 2, radius = centre * 0.82, scale = pow(box / 300, 0.6)
        // The shared spin and tilt (core.ts makeProj).
        let yaw = t * 0.12, st = sin(0.3), ct = cos(0.3), sy = sin(yaw), cy = cos(yaw)
        var dots: [(x: Double, y: Double, z: Double, r: Double, ink: Double, alpha: Double)] = []
        for orbit in 0..<3 {
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
        // Far to near; on a dark ground the tint (amber, #f59e0b) fades toward black with the ink (core.ts inkColor).
        for d in dots.sorted(by: { $0.z < $1.z }) {
            let ink = CGFloat(1 - min(1, max(0, d.ink)))
            ctx.setFillColor(red: 245 / 255 * ink, green: 158 / 255 * ink, blue: 11 / 255 * ink, alpha: CGFloat(d.alpha))
            ctx.fillEllipse(in: CGRect(x: d.x - d.r, y: d.y - d.r, width: 2 * d.r, height: 2 * d.r))
        }
    }
}

final class Overlay: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let mode: String
    init(mode: String) { self.mode = mode }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if mode == "pill" { pill() } else { windowOutline() }
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
               app.processIdentifier != ProcessInfo.processInfo.processIdentifier {
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

    // The running pill: [orb] ClawdCursor  <activity>  m:ss  [Stop]
    var runDot: NSView?
    var runActivity: NSTextField?
    var runClock: NSTextField?
    var runBrand: NSTextField?
    var runStop: NSButton?
    var runStart = Date()

    /// Lays the row out left to right, sizes the pill to it and puts it back at the top centre.
    func layoutRunning() {
        guard let panel = pillPanel, let dot = runDot, let brand = runBrand, let act = runActivity,
              let clock = runClock, let stop = runStop else { return }
        let rowH: CGFloat = 38
        func place(_ l: NSTextField, _ x: CGFloat, _ maxWidth: CGFloat) -> CGFloat {
            l.sizeToFit()
            let w = min(ceil(l.frame.width), maxWidth)
            let h = ceil(l.frame.height)
            l.frame = NSRect(x: x, y: floor((rowH - h) / 2), width: w, height: h)
            return w
        }
        var x: CGFloat = 14
        dot.frame = NSRect(x: x - 2, y: (rowH - 20) / 2, width: 20, height: 20)
        x += 20 + 2
        x += place(brand, x, 200) + 6
        x += place(act, x, 360) + 8
        x += place(clock, x, 100) + 12
        stop.frame = NSRect(x: x, y: 7, width: 52, height: 24)
        x += 52 + 7
        let width = ceil(x)
        let screen = NSScreen.screens.first ?? NSScreen.main!
        let area = screen.visibleFrame
        panel.setFrame(NSRect(x: area.midX - width / 2, y: area.maxY - rowH - 8, width: width, height: rowH), display: true)
    }

    func setActivity(_ text: String) {
        guard let act = runActivity else { return }
        act.stringValue = text
        layoutRunning()
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
            panel.allowKey = true
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(field)
        } else {
            pillPanel?.allowKey = false
            giveFocusBack()
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
                }
            }
        }
    }

    func hide(for ms: Int) {
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

    /// Esc in the card's own box: the panel stops being key and the user's app gets the keyboard back (what was typed
    /// stays). A key non-activating panel never made this app active, so giveFocusBack() (guarded by NSApp.isActive)
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
            if let prev = previousApp, prev.processIdentifier != ProcessInfo.processInfo.processIdentifier {
                if #available(macOS 14.0, *) { prev.activate() } else { prev.activate(options: []) }
            }
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

        let dot = label("\u{25CF}", size: 9, color: blue)   // the paused card's dot; the running pill has the orb
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

            dot.frame = NSRect(x: pad, y: height - 16 - 16, width: 12, height: 16)
            title.frame = NSRect(x: pad + 14, y: height - 16 - 16, width: inner - 14, height: 16)
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
            activity.lineBreakMode = .byTruncatingTail
            let clock = label("0:00", size: 11, color: muted)
            clock.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            let stop = makeButton("Stop", "BANNER_STOP", frame: NSRect(x: 0, y: 7, width: 52, height: 24),
                                  color: rgb(64, 30, 33), textColor: rgb(252, 165, 165), fontSize: 11, radius: 6)
            let orb = makeOrb()
            let rowViews: [NSView] = [orb, brand, activity, clock, stop]
            rowViews.forEach { content.addSubview($0) }
            runDot = orb
            runBrand = brand
            runActivity = activity
            runClock = clock
            runStop = stop
            runStart = Date()
            content.onDoubleClick = {
                emit("BANNER_STOP")
                NSApp.terminate(nil)
            }
        }

        let screen = NSScreen.screens.first ?? NSScreen.main!
        let area = screen.visibleFrame
        let frame = NSRect(x: area.midX - width / 2, y: area.maxY - height - 8, width: width, height: height)
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

        var bright = true
        timer = Timer.scheduledTimer(withTimeInterval: paused ? 0.9 : 0.7, repeats: true) { [weak self] _ in
            bright.toggle()
            if paused { dot.textColor = bright ? blue : blueDim } else { self?.updateClock() }
        }
    }

    /// What the beam on screen `index` goes around, in AppKit coordinates: the part of that screen below the menu bar
    /// and beside the Dock, which are above the beam and would hide a side of it. nil: there is no such screen (now).
    func screenFrame(_ index: Int) -> NSRect? {
        let screens = NSScreen.screens
        return screens.indices.contains(index) ? screens[index].visibleFrame : nil
    }

    /// The border beam (#392): Border Beam as <BorderBeam size="pulse-inner" colorVariant="gold" borderRadius={23}
    /// duration={3.9} hueRange={46}> - the library's defaults for the rest, theme "dark" - by Jakub Antalik (libraries.dev,
    /// MIT; the library's numbers and its licence notice are at the top of scripts/window-outline.ps1).
    /// Inside the screen's edge: an inner glow of coloured blobs (and faint white ones at the corners) within 28 pt of
    /// the edge, a 1 pt ring of radius 23 lit by the same blobs, and a bloom on that ring; the blobs breathe (size,
    /// place, opacity) on the library's periods and the colours turn the whole wheel every 16 s (hueRange does
    /// nothing for the pulse sizes, in the web library or its React Native port).
    /// Drawn for power (#414: window-sized layers with masks and filters once took 55% of an M1's GPU):
    ///   - each blob is one CAGradientLayer only as big as the blob: radial, half an ellipse lying inside the edge
    ///     whose stops are the glow there (the blob times the 28 pt mask) averaged round each of its rings, or for the
    ///     ring and the bloom axial and 1 pt thick; eight small CAShapeLayer arcs for the corners. So the GPU's work
    ///     follows the edge band, not the window's area;
    ///   - no masks, shadows, filters or blurs, and no layer the size of the window;
    ///   - Core Animation moves them (startPoint / endPoint / opacity / colors, autoreversing on the library's periods,
    ///     at most 15 frames a second): no code of ours runs per frame.
    /// The window is the screen's frame (one beam window per screen, see windowOutline): the beam lies over the
    /// screen's edge.
    /// --paused: the same in the library's "ocean" blues, still. Reduce Motion on: still. Nothing changes once a still
    /// beam is drawn.
    func beamOn(_ index: Int) {
        let paused = CommandLine.arguments.contains("--paused")
        let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let turning = !paused && !still
        let band = 28.0, radius = 23.0

        let win = NSWindow(contentRect: .zero, styleMask: .borderless, backing: .buffered, defer: false)
        win.isOpaque = false
        win.backgroundColor = .clear   // only the beam is drawn: nothing over the middle of the window
        win.hasShadow = false
        win.ignoresMouseEvents = true // click-through
        win.level = .floating   // above ordinary windows, below the pill and the menu bar
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        win.sharingType = .none  // the outline is not captured either
        let view = NSView()
        view.wantsLayer = true
        win.contentView = view

        let stage = CALayer()
        stage.allowsGroupOpacity = false   // the fade in applies to each layer: no off-screen pass over the frame
        view.layer?.addSublayer(stage)
        let start = CACurrentMediaTime()

        // Border Beam's numbers (the table is in window-outline.ps1). The oscillators: from, to, period, delay - per
        // blob region 1..3 its width, height, x, y; then the glow's height; then the opacity of each quarter (top-left,
        // top-right, bottom-left, bottom-right).
        let duration = 3.9, sp = 0.28, dr = 33.0, op = 0.48, gh = 0.34
        let bs = 1.9 * duration / 2.3, ss = 2.6 * duration / 2.3, ghs = 2.4 * duration / 2.3
        let osc: [[Double]] = [
            [1 - sp, 1 + sp * 1.1, ss * 0.9, 0], [1 + sp * 0.9, 1 - sp * 0.85, ss * 1.26, 0], [-dr, dr * 0.9, bs * 1.6, 0], [dr * 0.55, -dr * 0.7, bs * 1.6, 0],
            [1 + sp, 1 - sp * 0.85, ss * 1.1, 0], [1 - sp * 0.8, 1 + sp * 1.05, ss * 0.81, 0], [dr * 0.8, -dr * 0.9, bs * 1.88, 0], [-dr, dr * 0.65, bs * 1.88, 0],
            [1 - sp * 0.6, 1 + sp * 1.15, ss * 0.98, 0], [1 + sp * 0.75, 1 - sp, ss * 1.4, 0], [-dr * 0.6, dr, bs * 1.45, 0], [-dr * 0.85, dr * 0.45, bs * 1.45, 0],
            [1 - gh, 1 + gh, ghs, 0],
            [1 - op, 1, bs, 0], [1 - op, 1, bs * 1.32, bs * 0.28], [1 - op, 1, bs * 0.84, bs * 0.55], [1 - op, 1, bs * 1.58, bs * 0.83]]
        // The palette's blobs, one per colour in its order: place x, y (% of the box), the ring's reach x, y (pt), the
        // inner glow's, region (1..3), quarter (0 tl, 1 tr, 2 bl, 3 br).
        let blobs: [[Double]] = [
            [33, -7.4, 70, 40, 65, 35, 1, 0], [12, -5, 60, 35, 55, 30, 2, 0], [2.1, 68.3, 40, 70, 35, 65, 3, 2],
            [2.1, 68.3, 20, 35, 15, 30, 1, 2], [74.4, 100, 180, 32, 173, 28, 2, 3], [55, 100, 85, 26, 80, 22, 3, 3],
            [93.9, 0, 74, 32, 69, 28, 1, 1], [100, 27.1, 26, 42, 22, 38, 2, 1], [100, 27.1, 52, 48, 47, 44, 3, 1]]
        // The bloom's blobs: colour, reach x, y (pt), at that colour's place. They do not breathe.
        let bloomBlobs: [[Double]] = [[0, 84, 48], [1, 72, 42], [2, 48, 84], [4, 216, 38], [5, 102, 31], [6, 89, 38], [8, 62, 58]]
        let gold: [[Double]] = [[240, 190, 60], [255, 210, 90], [225, 165, 40], [250, 200, 70], [255, 225, 120],
                                [230, 175, 50], [245, 205, 85], [215, 155, 35], [255, 215, 100]]
        let ocean: [[Double]] = [[100, 80, 220], [60, 120, 255], [80, 100, 200], [50, 140, 220], [120, 80, 255],
                                 [70, 130, 255], [140, 100, 240], [90, 110, 230], [130, 70, 255]]
        let palette = paused ? ocean : gold
        // The hue turns the whole wheel every 16 s (24 steps, Core Animation blends between them).
        let hueSteps = 24
        let hues: [Double] = turning ? (0...hueSteps).map { 360 * Double($0) / Double(hueSteps) } : [0]

        func value(_ k: Int, _ t: Double) -> Double {
            let o = osc[k]
            return o[0] + (o[1] - o[0]) * (1 - cos(2 * Double.pi * (t - o[3]) / o[2])) / 2
        }
        // hue-rotate(deg) brightness(.75) saturate(1.2), each clamped, as a browser does.
        func filtered(_ colour: [Double], _ degrees: Double) -> [Double] {
            let c: Double = cos(degrees * Double.pi / 180), s: Double = sin(degrees * Double.pi / 180), t: Double = 1.2
            let hue: [Double] = [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
                                 0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
                                 0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
            let sat: [Double] = [0.213 + 0.787 * t, 0.715 - 0.715 * t, 0.072 - 0.072 * t,
                                 0.213 - 0.213 * t, 0.715 + 0.285 * t, 0.072 - 0.072 * t,
                                 0.213 - 0.213 * t, 0.715 - 0.715 * t, 0.072 + 0.928 * t]
            func clamp(_ v: Double) -> Double { return max(0, min(1, v)) }
            func apply(_ m: [Double], _ v: [Double]) -> [Double] {
                return (0..<3).map { (row: Int) -> Double in
                    let x: Double = m[3 * row] * v[0]
                    let y: Double = m[3 * row + 1] * v[1]
                    let z: Double = m[3 * row + 2] * v[2]
                    return clamp(x + y + z)
                }
            }
            let rgb: [Double] = colour.map { $0 / 255 }
            let bright: [Double] = apply(hue, rgb).map { clamp(0.75 * $0) }
            return apply(sat, bright)
        }
        func cg(_ rgb: [Double], _ alpha: Double) -> CGColor {
            return NSColor(srgbRed: CGFloat(rgb[0]), green: CGFloat(rgb[1]), blue: CGFloat(rgb[2]), alpha: CGFloat(alpha)).cgColor
        }
        func capped(_ a: CAAnimation) {
            if #available(macOS 12.0, *) { a.preferredFrameRateRange = CAFrameRateRange(minimum: 8, maximum: 15, preferred: 12) }
        }
        // An oscillator on a layer: from `from` to `to` and back over its period, in its phase (already under way).
        func breathe(_ layer: CALayer, _ key: String, _ path: String, _ k: Int, from: Any, to: Any, additive: Bool) {
            let a = CABasicAnimation(keyPath: path)
            a.fromValue = from
            a.toValue = to
            a.duration = osc[k][2] / 2
            a.autoreverses = true
            a.repeatCount = .infinity
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            a.isAdditive = additive
            a.beginTime = start + osc[k][3] - osc[k][2]
            capped(a)
            layer.add(a, forKey: key)
        }
        // An oscillator moving a gradient's point along the edge, by `scale` (unit coordinates) per unit it changes.
        func shift(_ layer: CALayer, _ key: String, _ path: String, _ k: Int, _ scale: Double, alongX: Bool) {
            let d = CGFloat((osc[k][1] - osc[k][0]) * scale)
            breathe(layer, key, path, k, from: NSValue(point: .zero),
                    to: NSValue(point: alongX ? CGPoint(x: d, y: 0) : CGPoint(x: 0, y: d)), additive: true)
        }
        func drift(_ layer: CALayer, _ path: String, _ values: [Any]) {
            guard values.count > 1 else { return }
            let a = CAKeyframeAnimation(keyPath: path)
            a.values = values
            a.duration = 16
            a.repeatCount = .infinity
            a.beginTime = start
            capped(a)
            layer.add(a, forKey: "drift")
        }

        // The layers for a frame of this size (pt).
        func layout(_ size: NSSize) {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            stage.sublayers?.forEach { $0.removeFromSuperlayer() }
            let w = Double(size.width), h = Double(size.height)
            stage.frame = CGRect(x: 0, y: 0, width: w, height: h)
            let rc = min(radius, min(w, h) / 2), depth = min(band, min(w, h) / 2)
            let scale = win.backingScaleFactor

            // Which side of the frame a blob placed at (fx, fy) % lies on: 0 top, 1 right, 2 bottom, 3 left.
            func side(_ fx: Double, _ fy: Double) -> Int {
                let d = [fy, 100 - fx, 100 - fy, fx]
                return d.firstIndex(of: d.min()!)!
            }
            // A point along a side (x for the top and bottom, y down from the top for the others) in the stage's
            // coordinates (y up), and the strip beside that side, `deep` deep inside the frame.
            func stageAlong(_ s: Int, _ a: Double) -> Double { return s % 2 == 0 ? a : h - a }
            func strip(_ s: Int, from a0: Double, to a1: Double, deep: Double) -> CGRect {
                let lo = min(stageAlong(s, a0), stageAlong(s, a1)), len = abs(a1 - a0)
                switch s {
                case 0: return CGRect(x: lo, y: h - deep, width: len, height: deep)
                case 2: return CGRect(x: lo, y: 0, width: len, height: deep)
                case 3: return CGRect(x: 0, y: lo, width: deep, height: len)
                default: return CGRect(x: w - deep, y: lo, width: deep, height: len)
                }
            }
            // Where the edge is across such a strip, in its unit coordinates (the side of it that touches the edge).
            func edgeAcross(_ s: Int) -> CGFloat { return s == 0 || s == 1 ? 1 : 0 }
            func unitPoint(_ s: Int, along: CGFloat, across: CGFloat) -> CGPoint {
                return s % 2 == 0 ? CGPoint(x: along, y: across) : CGPoint(x: across, y: along)
            }
            // A blob's value at (x, y) (frame, y down): 1 in its middle to 0 at its edge.
            func cone(_ x: Double, _ y: Double, _ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double) -> Double {
                let dx = (x - cx) / rx, dy = (y - cy) / ry
                return max(0, 1 - (dx * dx + dy * dy).squareRoot())
            }
            // The inner glow's mask: 1 at each edge to 0 28 pt in, the four added.
            func edgeMask(_ x: Double, _ y: Double) -> Double {
                let mv = min(1, max(0, max(1 - y / band, 1 - (h - y) / band))), mh = min(1, max(0, max(1 - x / band, 1 - (w - x) / band)))
                return 1 - (1 - mv) * (1 - mh)
            }
            // A radial gradient's seven stops round (px, py) with radii ax, ay (frame, y down): the mean of `glow` round
            // each of its rings, inside the frame.
            func ringMeans(_ px: Double, _ py: Double, _ ax: Double, _ ay: Double, _ glow: (Double, Double) -> Double) -> [Double] {
                return (0...6).map { (i: Int) -> Double in
                    var sum = 0.0, n = 0.0
                    for k in 0..<24 {
                        let a = 2 * Double.pi * Double(k) / 24
                        let x = px + Double(i) / 6 * ax * cos(a), y = py + Double(i) / 6 * ay * sin(a)
                        if x < 0 || y < 0 || x > w || y > h { continue }
                        sum += glow(x, y)
                        n += 1
                    }
                    return n > 0 ? sum / n : 0
                }
            }
            let ringStops: [NSNumber] = (0...6).map { NSNumber(value: Double($0) / 6) }

            // The blobs as they are at the start (t = 0); x, y down from the frame's top-left corner.
            struct Blob { var s: Int; var ci: Int; var region: Int; var quarter: Int; var cx: Double; var cy: Double; var rx: Double; var ry: Double }
            func blob(_ ci: Int, inner: Bool) -> Blob {
                let b = blobs[ci], reg = Int(b[6]) - 1
                return Blob(s: side(b[0], b[1]), ci: ci, region: reg, quarter: Int(b[7]),
                            cx: b[0] / 100 * w + value(reg * 4 + 2, 0), cy: b[1] / 100 * h + value(reg * 4 + 3, 0),
                            rx: b[inner ? 4 : 2] * value(reg * 4, 0), ry: b[inner ? 5 : 3] * value(reg * 4 + 1, 0) * value(12, 0))
            }
            // The breathing of a blob's gradient: its centre moves along the edge, its reach along it grows and
            // shrinks, its opacity pulses with its quarter. `perUnit`: unit coordinates per pt along the layer.
            func animate(_ layer: CALayer, _ b: Blob, inner: Bool, perUnit: Double, axial: Bool) {
                let alongX = b.s % 2 == 0
                let sign = alongX ? 1.0 : -1.0   // y down in the frame, y up on the stage
                layer.opacity = Float(value(13 + b.quarter, 0))
                guard turning else { return }
                breathe(layer, "pulse", "opacity", 13 + b.quarter, from: osc[13 + b.quarter][0], to: osc[13 + b.quarter][1], additive: false)
                let move = alongX ? b.region * 4 + 2 : b.region * 4 + 3
                shift(layer, "moveStart", "startPoint", move, sign * perUnit, alongX: alongX)
                shift(layer, "moveEnd", "endPoint", move, sign * perUnit, alongX: alongX)
                // The reach: x times the region's width; y times its height and the glow's height (both, added).
                let base = blobs[b.ci], bw = base[inner ? 4 : 2], bh = base[inner ? 5 : 3]
                let grow = alongX ? [(b.region * 4, bw)] : [(b.region * 4 + 1, bh * value(12, 0)), (12, bh * value(b.region * 4 + 1, 0))]
                for (n, part) in grow.enumerated() {
                    shift(layer, "growEnd\(n)", "endPoint", part.0, part.1 * perUnit, alongX: alongX)
                    if axial { shift(layer, "growStart\(n)", "startPoint", part.0, -part.1 * perUnit, alongX: alongX) }
                }
            }
            // Where along its side a blob's middle meets the edge, and how far along it reaches.
            func along(_ b: Blob) -> (a: Double, reach: Double) {
                return b.s % 2 == 0 ? (min(w, max(0, b.cx)), b.rx) : (min(h, max(0, b.cy)), b.ry)
            }
            func edgePoint(_ s: Int, _ a: Double) -> (x: Double, y: Double) {
                let points: [(x: Double, y: Double)] = [(a, 0), (w, a), (a, h), (0, a)]
                return points[s]
            }

            // The inner glow, opacity .44: per blob half an ellipse inside the edge, as deep as the mask, under the
            // four white corners' (radius 60, clear at 70%: 42 pt; alpha .18).
            for ci in (0..<9).reversed() {
                let b = blob(ci, inner: true), alongX = b.s % 2 == 0
                let (a, reach) = along(b)
                let p = edgePoint(b.s, a)
                let fall = ringMeans(p.x, p.y, alongX ? reach : depth, alongX ? depth : reach) {
                    0.44 * cone($0, $1, b.cx, b.cy, b.rx, b.ry) * edgeMask($0, $1)
                }
                if fall.max()! < 0.004 { continue }
                let length = alongX ? w : h, room = reach * 1.5 + dr
                let layer = CAGradientLayer()
                layer.type = .radial
                layer.contentsScale = scale
                let a0 = max(0, a - room), a1 = min(length, a + room)
                layer.frame = strip(b.s, from: a0, to: max(a1, a0 + 1), deep: depth)
                let flen = Double(alongX ? layer.frame.width : layer.frame.height)
                let base = alongX ? Double(layer.frame.minX) : Double(layer.frame.minY)
                let u = CGFloat((stageAlong(b.s, a) - base) / flen), across = edgeAcross(b.s)
                layer.startPoint = unitPoint(b.s, along: u, across: across)
                layer.endPoint = unitPoint(b.s, along: u + CGFloat(reach / flen), across: across + 1)
                layer.locations = ringStops
                let colours = hues.map { hue -> [CGColor] in let rgb = filtered(palette[ci], hue); return fall.map { cg(rgb, $0) } }
                layer.colors = colours[0]
                drift(layer, "colors", colours)
                animate(layer, b, inner: true, perUnit: 1 / flen, axial: false)
                stage.addSublayer(layer)
            }
            let grey = filtered([255, 255, 255], 0)   // white through the filter: the same at every hue
            for q in 0..<4 where depth >= 1 {
                let x = q % 2 == 1 ? w : 0, y = q >= 2 ? h : 0, r = min(42, w, h)
                let fall = ringMeans(x, y, r, r) { 0.44 * 0.18 * cone($0, $1, x, y, 42, 42) * edgeMask($0, $1) }
                let layer = CAGradientLayer()
                layer.type = .radial
                layer.contentsScale = scale
                layer.frame = CGRect(x: q % 2 == 1 ? w - r : 0, y: q >= 2 ? 0 : h - r, width: r, height: r)
                let corner = CGPoint(x: q % 2 == 1 ? 1 : 0, y: q >= 2 ? 0 : 1)
                layer.startPoint = corner
                layer.endPoint = CGPoint(x: corner.x == 1 ? 0 : 1, y: corner.y == 1 ? 0 : 1)
                layer.locations = ringStops
                layer.colors = fall.map { cg(grey, $0) }
                layer.opacity = Float(value(13 + q, 0))
                if turning { breathe(layer, "pulse", "opacity", 13 + q, from: osc[13 + q][0], to: osc[13 + q][1], additive: false) }
                stage.addSublayer(layer)
            }

            // A 1 pt line along a side, inside the edge, between the corners: lit as a blob's radial gradient is along
            // it (`peak` at `a`, clear `reach` either side).
            func line(_ s: Int, a: Double, reach: Double, room: Double, peak: Double, ci: Int) -> CAGradientLayer? {
                let length = s % 2 == 0 ? w : h
                let a0 = max(rc, a - room), a1 = min(length - rc, a + room)
                if peak < 0.004 || a1 - a0 < 1 { return nil }
                let layer = CAGradientLayer()
                layer.contentsScale = scale
                layer.frame = strip(s, from: a0, to: a1, deep: 1)
                let flen = Double(s % 2 == 0 ? layer.frame.width : layer.frame.height)
                let base = s % 2 == 0 ? Double(layer.frame.minX) : Double(layer.frame.minY)
                let u = (stageAlong(s, a) - base) / flen, du = reach / flen
                layer.startPoint = unitPoint(s, along: CGFloat(u - du), across: 0.5)
                layer.endPoint = unitPoint(s, along: CGFloat(u + du), across: 0.5)
                layer.locations = [0, 0.5, 1]
                let colours = hues.map { hue -> [CGColor] in let rgb = filtered(palette[ci], hue); return [cg(rgb, 0), cg(rgb, peak), cg(rgb, 0)] }
                layer.colors = colours[0]
                drift(layer, "colors", colours)
                return layer
            }
            // The ring (opacity 1.54, which a browser takes as 1): the inner 1 pt, its sides lit where the blobs meet
            // the edge, its corners arcs of radius 23.
            for ci in (0..<9).reversed() {
                let b = blob(ci, inner: false)
                let (a, reach) = along(b)
                let p = edgePoint(b.s, a)
                guard let layer = line(b.s, a: a, reach: reach, room: reach * 1.5 + dr, peak: cone(p.x, p.y, b.cx, b.cy, b.rx, b.ry), ci: ci) else { continue }
                animate(layer, b, inner: false, perUnit: 1 / Double(b.s % 2 == 0 ? layer.frame.width : layer.frame.height), axial: true)
                stage.addSublayer(layer)
            }
            // The bloom over it: its seven blobs at alpha .76, at the half of their 8 pt blur that falls inside the
            // window (.52), opacity .66; still.
            let bloomPeak = 0.76 * 0.52 * 0.66
            for entry in bloomBlobs.reversed() {
                let ci = Int(entry[0]), s = side(blobs[ci][0], blobs[ci][1])
                let cx = blobs[ci][0] / 100 * w, cy = blobs[ci][1] / 100 * h
                let a = s % 2 == 0 ? min(w, max(0, cx)) : min(h, max(0, cy)), reach = s % 2 == 0 ? entry[1] : entry[2]
                let p = edgePoint(s, a)
                if let layer = line(s, a: a, reach: reach, room: reach, peak: bloomPeak * cone(p.x, p.y, cx, cy, entry[1], entry[2]), ci: ci) {
                    stage.addSublayer(layer)
                }
            }
            // The corners: a quarter circle each (the inner 1 pt, radius 23), in the colour the ring's blobs give its
            // middle, pulsing with its quarter, and over it the bloom's colour there. Points in the frame, y down: from
            // a side, round the corner, to the next.
            func composite(_ layers: [(rgb: [Double], v: Double)]) -> (rgb: [Double], alpha: Double) {
                var r = 0.0, g = 0.0, bl = 0.0, al = 0.0
                for l in layers.reversed() {   // the first on top
                    let keep = 1 - l.v
                    r = l.rgb[0] * l.v + r * keep; g = l.rgb[1] * l.v + g * keep; bl = l.rgb[2] * l.v + bl * keep; al = l.v + al * keep
                }
                return al > 0 ? ([r / al, g / al, bl / al], al) : ([0, 0, 0], 0)
            }
            let o = 0.5, d = 0.70710678
            let corners: [(from: CGPoint, corner: CGPoint, to: CGPoint, mid: CGPoint, quarter: Int)] = [
                (CGPoint(x: o, y: rc), CGPoint(x: o, y: o), CGPoint(x: rc, y: o), CGPoint(x: rc - rc * d, y: rc - rc * d), 0),
                (CGPoint(x: w - rc, y: o), CGPoint(x: w - o, y: o), CGPoint(x: w - o, y: rc), CGPoint(x: w - rc + rc * d, y: rc - rc * d), 1),
                (CGPoint(x: rc, y: h - o), CGPoint(x: o, y: h - o), CGPoint(x: o, y: h - rc), CGPoint(x: rc - rc * d, y: h - rc + rc * d), 2),
                (CGPoint(x: w - o, y: h - rc), CGPoint(x: w - o, y: h - o), CGPoint(x: w - rc, y: h - o), CGPoint(x: w - rc + rc * d, y: h - rc + rc * d), 3)]
            func onStage(_ p: CGPoint) -> CGPoint { return CGPoint(x: p.x, y: CGFloat(h) - p.y) }
            func arc(_ c: (from: CGPoint, corner: CGPoint, to: CGPoint, mid: CGPoint, quarter: Int), _ strokes: [CGColor]) -> CAShapeLayer {
                let path = CGMutablePath()
                path.move(to: onStage(c.from))
                path.addArc(tangent1End: onStage(c.corner), tangent2End: onStage(c.to), radius: CGFloat(rc - o))
                let shape = CAShapeLayer()
                shape.contentsScale = scale
                let box = path.boundingBoxOfPath.insetBy(dx: -1, dy: -1)
                var move = CGAffineTransform(translationX: -box.minX, y: -box.minY)
                shape.frame = box
                shape.path = path.copy(using: &move)
                shape.fillColor = nil
                shape.lineWidth = 1
                shape.strokeColor = strokes[0]
                drift(shape, "strokeColor", strokes)
                return shape
            }
            for c in corners where rc >= 1 {
                let x = Double(c.mid.x), y = Double(c.mid.y)
                let ring = hues.map { hue in composite((0..<9).map { ci -> (rgb: [Double], v: Double) in
                    let b = blob(ci, inner: false)
                    return (filtered(palette[ci], hue), cone(x, y, b.cx, b.cy, b.rx, b.ry))
                }) }
                if ring[0].alpha >= 0.01 {
                    let shape = arc(c, ring.map { cg($0.rgb, $0.alpha) })
                    let q = 13 + c.quarter
                    shape.opacity = Float(value(q, 0))
                    if turning { breathe(shape, "pulse", "opacity", q, from: osc[q][0], to: osc[q][1], additive: false) }
                    stage.addSublayer(shape)
                }
                let bloom = hues.map { hue in composite(bloomBlobs.map { entry -> (rgb: [Double], v: Double) in
                    let ci = Int(entry[0])
                    return (filtered(palette[ci], hue), 0.76 * cone(x, y, blobs[ci][0] / 100 * w, blobs[ci][1] / 100 * h, entry[1], entry[2]))
                }) }
                if bloom[0].alpha * 0.52 * 0.66 >= 0.01 { stage.addSublayer(arc(c, bloom.map { cg($0.rgb, $0.alpha * 0.52 * 0.66) })) }
            }
            CATransaction.commit()
        }

        windows.append(win)
        var laidOut: NSSize? = nil
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let frame = self?.screenFrame(index), frame.width > 8, frame.height > 8 else { win.orderOut(nil); return }
            if win.frame != frame { win.setFrame(frame, display: true) }
            if laidOut != frame.size {
                layout(frame.size)
                laidOut = frame.size
            }
            if !win.isVisible {
                win.orderFrontRegardless()
                if turning {
                    // Coming up: from clear to full over .6 s (a still beam, as on Windows, just appears).
                    let rise = CABasicAnimation(keyPath: "opacity")
                    rise.fromValue = 0
                    rise.toValue = 1
                    rise.duration = 0.6
                    stage.add(rise, forKey: "rise")
                }
            }
        }
    }

    /// The beam on every screen: one beamOn window per screen, built as screens appear (one plugged in later gets its
    /// own); a beam whose screen is gone hides itself and comes back if that index is used again.
    func windowOutline() {
        listenForCommands()
        var built = 0
        let add = {
            while built < NSScreen.screens.count { self.beamOn(built); built += 1 }
        }
        add()
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in add() }
    }
}

let mode = CommandLine.arguments.dropFirst().first ?? ""
guard mode == "pill" || mode == "outline" else {
    FileHandle.standardError.write("usage: overlay pill | outline [--color #RRGGBB] [--paused]\n".data(using: .utf8)!)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let overlay = Overlay(mode: mode)
app.delegate = overlay
app.run()
