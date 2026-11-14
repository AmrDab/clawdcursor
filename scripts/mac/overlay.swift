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
//                  a thin border around the window the agent works in, and nothing
//                  else: no fill, nothing on the rest of the screen; clicks pass
//                  straight through it. stdin: "TARGET <handle> <pid>" names the
//                  process (a bare "TARGET": none). The border is drawn around the
//                  process's frontmost window while that app is in front, and follows it.
//                  When the target app is in front with no window of its own (Finder's
//                  desktop), the border goes around the screen the pointer is on.
//                  The border: Border Beam's pulse-outside in sunset (below) - a warm glow
//                  outside the window's edge that breathes, drawn cheaply (windowOutline);
//                  --paused: the same glow in blue ("ocean"), still. With Reduce Motion on:
//                  still. (--color is accepted and not used.)
//
// The pill's orb is a port of Thinking Orbs, and the beam is Border Beam (size "pulse-outside", colorVariant "sunset",
// borderRadius 30), by Jakub Antalik (libraries.dev, github.com/Jakubantalik/Libraries.dev, packages/border-beam and
// packages/thinking-orbs), MIT License,
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
                } else if line == "TARGET" || line.hasPrefix("TARGET ") {
                    let parts = line.split(separator: " ")
                    let pid = parts.count > 2 ? Int(parts[2]) ?? 0 : 0
                    DispatchQueue.main.async { self?.targetPid = pid }
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

    /// The process whose window gets the outline ("TARGET <handle> <pid>" on stdin); 0: none.
    var targetPid = 0

    /// The screen the pointer is on (where the agent's last click went), in AppKit coordinates: the part of it below
    /// the menu bar and beside the Dock, which are above the outline and would hide a side of it.
    func pointerScreen() -> (frame: NSRect, screen: Bool)? {
        let at = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(at) }) ?? NSScreen.main else { return nil }
        return (frame: screen.visibleFrame, screen: true)
    }

    /// What the outline goes around, in AppKit coordinates, and whether that is a whole screen: the target process's
    /// frontmost ordinary window while that app is in front (the windows are listed only then; the list is front to
    /// back), or the pointer's screen when that app is in front with no window of its own (Finder's desktop). A window
    /// that covers its screen counts as the screen (the glow then goes inward).
    func targetFrame() -> (frame: NSRect, screen: Bool)? {
        guard targetPid != 0,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(targetPid),
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let primary = NSScreen.screens.first else { return nil }
        guard let front = list.first(where: {
                  ($0[kCGWindowOwnerPID as String] as? Int) == targetPid && ($0[kCGWindowLayer as String] as? Int) == 0
              }),
              let bounds = front[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return pointerScreen() }
        // Quartz measures down from the top of the primary display, AppKit up from its bottom.
        let frame = NSRect(x: rect.minX, y: primary.frame.height - rect.maxY, width: rect.width, height: rect.height)
        // A zoomed or full-screen window has no room outside it for the glow: it is outlined as its screen, inward.
        if let screen = NSScreen.screens.first(where: { frame.contains($0.visibleFrame) }) {
            return (frame: frame.intersection(screen.frame), screen: true)
        }
        return (frame: frame, screen: false)
    }

    /// The border beam (#392): Border Beam's pulse-outside in sunset, borderRadius 30, duration 1.96 s, by Jakub Antalik
    /// (libraries.dev, MIT; the library's numbers and its licence notice are at the top of scripts/window-outline.ps1).
    /// A glow outside the window's edge - a soft bloom, a tighter inner glow and patches of a 1 pt ring at radius 30 -
    /// made of warm blobs that breathe (size, place, opacity) on the library's periods, with a slow hue drift.
    /// Drawn for power (#414: window-sized layers with masks and filters once took 55% of an M1's GPU):
    ///   - each blob is one CAGradientLayer only as big as the blob: radial, half an ellipse lying outside the edge (the
    ///     blur is in its stops), or for the ring axial and 1 pt thick; four small CAShapeLayer arcs for the ring's
    ///     corners. So the GPU's work follows the edge band, not the window's area;
    ///   - no masks, shadows, filters or blurs, and no layer the size of the window;
    ///   - Core Animation moves them (startPoint / endPoint / opacity / colors, autoreversing on the library's periods,
    ///     at most 15 frames a second): no code of ours runs per frame.
    /// The window is the target's frame and a 48 pt margin round it; around a whole screen (the desktop, a zoomed or
    /// full-screen window) the glow is drawn inward from the edge instead.
    /// --paused: the same glow in the library's "ocean" blues, still. Reduce Motion on: still. Nothing changes once a
    /// still beam is drawn.
    func windowOutline() {
        let paused = CommandLine.arguments.contains("--paused")
        let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let turning = !paused && !still
        let margin: CGFloat = 48

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
        let duration = 1.96, sp = 0.28, dr = 14.0, op = 0.46, gh = 0.16
        let bs = duration, ss = 6.4 * duration / 2.3, ghs = 2.4 * duration / 2.3
        let osc: [[Double]] = [
            [1 - sp, 1 + sp * 1.1, ss * 0.9, 0], [1 + sp * 0.9, 1 - sp * 0.85, ss * 1.26, 0], [-dr, dr * 0.9, bs * 1.6, 0], [dr * 0.55, -dr * 0.7, bs * 1.6, 0],
            [1 + sp, 1 - sp * 0.85, ss * 1.1, 0], [1 - sp * 0.8, 1 + sp * 1.05, ss * 0.81, 0], [dr * 0.8, -dr * 0.9, bs * 1.88, 0], [-dr, dr * 0.65, bs * 1.88, 0],
            [1 - sp * 0.6, 1 + sp * 1.15, ss * 0.98, 0], [1 + sp * 0.75, 1 - sp, ss * 1.4, 0], [-dr * 0.6, dr, bs * 1.45, 0], [-dr * 0.85, dr * 0.45, bs * 1.45, 0],
            [1 - gh, 1 + gh, ghs, 0],
            [1 - op, 1, bs, 0], [1 - op, 1, bs * 1.32, bs * 0.28], [1 - op, 1, bs * 0.84, bs * 0.55], [1 - op, 1, bs * 1.58, bs * 0.83]]
        // The ring's and the inner glow's blobs: colour, region, quarter, reach x, y (px), place x, y (% of the box).
        let edgeBlobs: [[Double]] = [
            [0, 1, 0, 80, 19, 27, 0], [6, 2, 1, 74, 11, 73, -1], [7, 3, 1, 15, 44, 100, 33], [8, 1, 3, 19, 38, 101, 72],
            [4, 2, 3, 84, 13, 67, 100], [1, 3, 2, 60, 21, 24, 101], [2, 1, 2, 17, 40, 0, 60], [3, 2, 0, 13, 32, -1, 28]]
        // The bloom's blobs: colour, reach x, y, place x, y. They do not breathe.
        let bloomBlobs: [[Double]] = [
            [0, 110, 30, 27, 3], [6, 100, 20, 73, 1], [7, 26, 62, 100, 33], [8, 30, 56, 101, 72], [4, 120, 22, 67, 99],
            [1, 88, 32, 24, 99], [2, 28, 58, 0, 60]]
        let sunset: [[Double]] = [[255, 80, 50], [255, 160, 40], [255, 120, 60], [255, 200, 50], [255, 100, 80],
                                  [255, 180, 60], [255, 60, 60], [255, 140, 50], [255, 90, 70]]
        let ocean: [[Double]] = [[100, 80, 220], [60, 120, 255], [80, 100, 200], [50, 140, 220], [120, 80, 255],
                                 [70, 130, 255], [140, 100, 240], [90, 110, 230], [130, 70, 255]]
        let palette = paused ? ocean : sunset
        // Across the edge, how a blurred box edge falls off (a gaussian), sampled at six stops: the bloom's (blur 22.5,
        // its box 20 px out, faded out by 48) and the inner glow's (blur 3, its box 2 px out, about 10 px deep).
        let stops: [NSNumber] = [0, 0.2, 0.4, 0.6, 0.8, 1]
        let bloomFall: [Double] = [1, 0.83, 0.63, 0.43, 0.165, 0], innerFall: [Double] = [1, 0.67, 0.34, 0.12, 0.03, 0]
        let bloomDepth: CGFloat = 48, innerDepth: CGFloat = 10
        // The hue drifts 30 degrees either way over 14 s (twelve steps, Core Animation blends between them).
        let hueSteps = 12
        let hues: [Double] = turning ? (0...hueSteps).map { 30 * sin(2 * Double.pi * Double($0) / Double(hueSteps)) } : [0]

        func value(_ k: Int, _ t: Double) -> Double {
            let o = osc[k]
            return o[0] + (o[1] - o[0]) * (1 - cos(2 * Double.pi * (t - o[3]) / o[2])) / 2
        }
        // hue-rotate(deg) brightness(1.9) saturate(1.2), each clamped, as a browser does.
        func filtered(_ ci: Int, _ degrees: Double) -> [Double] {
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
            let rgb: [Double] = palette[ci].map { $0 / 255 }
            let bright: [Double] = apply(hue, rgb).map { clamp(1.9 * $0) }
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
            a.duration = 14
            a.repeatCount = .infinity
            a.beginTime = start
            capped(a)
            layer.add(a, forKey: "drift")
        }

        // The layers for a frame of this size (pt). `inward`: around a whole screen, the glow drawn inward.
        func layout(_ size: NSSize, inward: Bool) {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            stage.sublayers?.forEach { $0.removeFromSuperlayer() }
            let w = Double(size.width), h = Double(size.height)
            let off = Double(inward ? 0 : margin)
            stage.frame = CGRect(x: 0, y: 0, width: w + 2 * off, height: h + 2 * off)
            let gx = max(0.35, min(4, w / 350)), gy = max(0.35, min(4, h / 140)), rc = min(30, min(w, h) / 2)
            let scale = win.backingScaleFactor

            // Which side of the frame a blob placed at (fx, fy) % lies on: 0 top, 1 right, 2 bottom, 3 left.
            func side(_ fx: Double, _ fy: Double) -> Int {
                let d = [fy, 100 - fx, 100 - fy, fx]
                return d.firstIndex(of: d.min()!)!
            }
            // A point along a side (x for the top and bottom, y down from the top for the others) in the stage's
            // coordinates (y up), and the band beside that side, `depth` deep, outside (or inside) the frame.
            func stageAlong(_ s: Int, _ a: Double) -> Double { return s % 2 == 0 ? off + a : off + h - a }
            func band(_ s: Int, from a0: Double, to a1: Double, depth: Double) -> CGRect {
                let lo = min(stageAlong(s, a0), stageAlong(s, a1)), len = abs(a1 - a0)
                switch s {
                case 0: return CGRect(x: lo, y: inward ? off + h - depth : off + h, width: len, height: depth)
                case 2: return CGRect(x: lo, y: inward ? off : off - depth, width: len, height: depth)
                case 3: return CGRect(x: inward ? off : off - depth, y: lo, width: depth, height: len)
                default: return CGRect(x: inward ? off + w - depth : off + w, y: lo, width: depth, height: len)
                }
            }
            // Where the edge is across a band, in its unit coordinates (the side of it that touches the frame).
            func edgeAcross(_ s: Int) -> CGFloat {
                switch s {
                case 0: return inward ? 1 : 0
                case 2: return inward ? 0 : 1
                case 3: return inward ? 0 : 1
                default: return inward ? 1 : 0
                }
            }
            func unitPoint(_ s: Int, along: CGFloat, across: CGFloat) -> CGPoint {
                return s % 2 == 0 ? CGPoint(x: along, y: across) : CGPoint(x: across, y: along)
            }

            // A glow blob: half an ellipse lying against the edge, centred at `a` along side `s`, reaching `reach`
            // along it and `depth` across, with the colour's alpha falling off across as `fall`.
            func glow(_ s: Int, a: Double, reach: Double, room: Double, depth: Double, fall: [Double], peak: Double,
                      ci: Int) -> CAGradientLayer {
                let length = s % 2 == 0 ? w : h
                let a0 = max(-depth, a - room), a1 = min(length + depth, a + room)
                let layer = CAGradientLayer()
                layer.type = .radial
                layer.contentsScale = scale
                layer.frame = band(s, from: a0, to: max(a1, a0 + 1), depth: depth)
                let flen = Double(s % 2 == 0 ? layer.frame.width : layer.frame.height)
                let base = s % 2 == 0 ? Double(layer.frame.minX) : Double(layer.frame.minY)
                let u = CGFloat((stageAlong(s, a) - base) / flen), across = edgeAcross(s)
                layer.startPoint = unitPoint(s, along: u, across: across)
                layer.endPoint = unitPoint(s, along: u + CGFloat(reach / flen), across: across + 1)
                layer.locations = stops
                let colours = hues.map { hue -> [CGColor] in let rgb = filtered(ci, hue); return fall.map { cg(rgb, peak * $0) } }
                layer.colors = colours[0]
                drift(layer, "colors", colours)
                return layer
            }

            // The bloom: still, under everything; the first blob on top, as the library layers them.
            for blob in bloomBlobs.reversed() {
                let s = side(blob[3], blob[4]), alongX = s % 2 == 0
                let cx = -20 + blob[3] / 100 * (w + 40), cy = -20 + blob[4] / 100 * (h + 40)
                let rx = blob[1] * gx, ry = blob[2] * gy
                // How strong the blob is where it meets its box's edge (20 px out).
                let across = [abs(cy + 20), abs(cx - w - 20), abs(cy - h - 20), abs(cx + 20)][s]
                let edge = max(0, 1 - across / (alongX ? ry : rx))
                if edge <= 0 { continue }
                let reach = (alongX ? rx : ry) + 22.5
                stage.addSublayer(glow(s, a: alongX ? cx : cy, reach: reach, room: reach, depth: Double(bloomDepth),
                                       fall: bloomFall, peak: 0.30 * 0.77 * edge * 0.813, ci: Int(blob[0])))
            }

            // The ring's and the inner glow's blobs as they are at the start (t = 0).
            struct EdgeBlob { var s: Int; var ci: Int; var region: Int; var quarter: Int; var cx: Double; var cy: Double; var rx: Double; var ry: Double }
            func edgeBlob(_ blob: [Double], reach e: Double) -> EdgeBlob {
                let reg = Int(blob[1]) - 1
                return EdgeBlob(s: side(blob[5], blob[6]), ci: Int(blob[0]), region: reg, quarter: Int(blob[2]),
                                cx: -e + blob[5] / 100 * (w + 2 * e) + value(reg * 4 + 2, 0),
                                cy: -e + blob[6] / 100 * (h + 2 * e) + value(reg * 4 + 3, 0),
                                rx: blob[3] * value(reg * 4, 0) * gx, ry: blob[4] * value(reg * 4 + 1, 0) * value(12, 0) * gy)
            }
            // The breathing of a blob's gradient: its centre moves along the edge, its reach grows and shrinks, its
            // opacity pulses with its quarter. `perUnit`: unit coordinates per px along the layer.
            func animate(_ layer: CALayer, _ b: EdgeBlob, base: [Double], perUnit: Double, axial: Bool) {
                let alongX = b.s % 2 == 0
                let sign = alongX ? 1.0 : -1.0   // y down in the frame, y up on the stage
                let opacity = value(13 + b.quarter, 0)
                layer.opacity = Float(opacity)
                guard turning else { return }
                breathe(layer, "pulse", "opacity", 13 + b.quarter, from: osc[13 + b.quarter][0], to: osc[13 + b.quarter][1], additive: false)
                let move = alongX ? b.region * 4 + 2 : b.region * 4 + 3
                shift(layer, "moveStart", "startPoint", move, sign * perUnit, alongX: alongX)
                shift(layer, "moveEnd", "endPoint", move, sign * perUnit, alongX: alongX)
                // The reach: x times the region's width; y times its height and the glow's height (both, added).
                let grow = alongX ? [(b.region * 4, base[0])] : [(b.region * 4 + 1, base[1]), (12, base[2])]
                for (n, part) in grow.enumerated() {
                    shift(layer, "growEnd\(n)", "endPoint", part.0, part.1 * perUnit, alongX: alongX)
                    if axial { shift(layer, "growStart\(n)", "startPoint", part.0, -part.1 * perUnit, alongX: alongX) }
                }
            }

            // The inner glow (2 px out, blurred 3 px), over the bloom.
            for blob in edgeBlobs.reversed() {
                let b = edgeBlob(blob, reach: 2), alongX = b.s % 2 == 0
                let across = [abs(b.cy + 2), abs(b.cx - w - 2), abs(b.cy - h - 2), abs(b.cx + 2)][b.s]
                let edge = max(0, 1 - across / (alongX ? b.ry : b.rx))
                if edge <= 0 { continue }
                let reach = (alongX ? b.rx : b.ry) + 3
                let room = reach * 1.5 + dr
                let layer = glow(b.s, a: alongX ? b.cx : b.cy, reach: reach, room: room, depth: Double(innerDepth),
                                 fall: innerFall, peak: 0.34 * edge * 0.748, ci: b.ci)
                let flen = Double(alongX ? layer.frame.width : layer.frame.height)
                animate(layer, b, base: [blob[3] * gx, blob[4] * gy * value(12, 0), blob[4] * gy * value(b.region * 4 + 1, 0)],
                        perUnit: 1 / flen, axial: false)
                stage.addSublayer(layer)
            }

            // The ring, on top: the inner 1 pt of the frame, its sides lit where the blobs are (a line whose colour
            // falls off from the blob's centre as the radial gradient does along it), its corners arcs of radius 30.
            func ringAt(_ x: Double, _ y: Double, _ hue: Double) -> (rgb: [Double], alpha: Double) {
                var r = 0.0, g = 0.0, bl = 0.0, al = 0.0
                for blob in edgeBlobs.reversed() {
                    let b = edgeBlob(blob, reach: 0)
                    let dx = (x - b.cx) / b.rx, dy = (y - b.cy) / b.ry, d2 = dx * dx + dy * dy
                    if d2 >= 1 { continue }
                    let v = 1 - d2.squareRoot(), keep = 1 - v, c = filtered(b.ci, hue)   // (the quarter's pulse: opacity)
                    r = c[0] * v + r * keep; g = c[1] * v + g * keep; bl = c[2] * v + bl * keep; al = v + al * keep
                }
                return al > 0 ? ([r / al, g / al, bl / al], al * 0.94) : ([0, 0, 0], 0)
            }
            for blob in edgeBlobs.reversed() {
                let b = edgeBlob(blob, reach: 0), alongX = b.s % 2 == 0
                let length = alongX ? w : h
                let across = [abs(b.cy), abs(b.cx - w), abs(b.cy - h), abs(b.cx)][b.s]
                let edge = max(0, 1 - across / (alongX ? b.ry : b.rx))
                let a = alongX ? b.cx : b.cy, reach = alongX ? b.rx : b.ry
                let room = reach * 1.5 + dr
                let a0 = max(rc, a - room), a1 = min(length - rc, a + room)
                if edge <= 0 || a1 - a0 < 1 { continue }
                let layer = CAGradientLayer()
                layer.contentsScale = scale
                // The line: the inner 1 pt of the frame along this side.
                let line = band(b.s, from: a0, to: a1, depth: 1)
                let inside = CGFloat(inward ? 0 : 1)
                switch b.s {
                case 0: layer.frame = line.offsetBy(dx: 0, dy: -inside)
                case 2: layer.frame = line.offsetBy(dx: 0, dy: inside)
                case 3: layer.frame = line.offsetBy(dx: inside, dy: 0)
                default: layer.frame = line.offsetBy(dx: -inside, dy: 0)
                }
                let flen = Double(alongX ? layer.frame.width : layer.frame.height)
                let base = alongX ? Double(layer.frame.minX) : Double(layer.frame.minY)
                let u = (stageAlong(b.s, a) - base) / flen, du = reach / flen
                layer.startPoint = unitPoint(b.s, along: CGFloat(u - du), across: 0.5)
                layer.endPoint = unitPoint(b.s, along: CGFloat(u + du), across: 0.5)
                layer.locations = [0, 0.5, 1]
                let colours = hues.map { hue -> [CGColor] in
                    let rgb = filtered(b.ci, hue)
                    return [cg(rgb, 0), cg(rgb, 0.94 * edge), cg(rgb, 0)]
                }
                layer.colors = colours[0]
                drift(layer, "colors", colours)
                animate(layer, b, base: [blob[3] * gx, blob[4] * gy * value(12, 0), blob[4] * gy * value(b.region * 4 + 1, 0)],
                        perUnit: 1 / flen, axial: true)
                stage.addSublayer(layer)
            }
            // The corners: a quarter circle each (the inner 1 pt of the frame, radius 30), in the colour the blobs give
            // its middle, pulsing with its quarter. Points in the frame, y down: from a side, round the corner, to the next.
            let o = 0.5, d = 0.70710678
            let corners: [(from: CGPoint, corner: CGPoint, to: CGPoint, mid: CGPoint, quarter: Int)] = [
                (CGPoint(x: o, y: rc), CGPoint(x: o, y: o), CGPoint(x: rc, y: o), CGPoint(x: rc - rc * d, y: rc - rc * d), 0),
                (CGPoint(x: w - rc, y: o), CGPoint(x: w - o, y: o), CGPoint(x: w - o, y: rc), CGPoint(x: w - rc + rc * d, y: rc - rc * d), 1),
                (CGPoint(x: rc, y: h - o), CGPoint(x: o, y: h - o), CGPoint(x: o, y: h - rc), CGPoint(x: rc - rc * d, y: h - rc + rc * d), 2),
                (CGPoint(x: w - o, y: h - rc), CGPoint(x: w - o, y: h - o), CGPoint(x: w - rc, y: h - o), CGPoint(x: w - rc + rc * d, y: h - rc + rc * d), 3)]
            func onStage(_ p: CGPoint) -> CGPoint { return CGPoint(x: CGFloat(off) + p.x, y: CGFloat(off + h) - p.y) }
            for c in corners where rc >= 1 {
                let tones = hues.map { hue -> (rgb: [Double], alpha: Double) in ringAt(Double(c.mid.x), Double(c.mid.y), hue) }
                if tones[0].alpha < 0.01 { continue }
                let arc = CGMutablePath()
                arc.move(to: onStage(c.from))
                arc.addArc(tangent1End: onStage(c.corner), tangent2End: onStage(c.to), radius: CGFloat(rc - o))
                let shape = CAShapeLayer()
                shape.contentsScale = scale
                let box = arc.boundingBoxOfPath.insetBy(dx: -1, dy: -1)
                var move = CGAffineTransform(translationX: -box.minX, y: -box.minY)
                shape.frame = box
                shape.path = arc.copy(using: &move)
                shape.fillColor = nil
                shape.lineWidth = 1
                let strokes = tones.map { cg($0.rgb, $0.alpha) }
                shape.strokeColor = strokes[0]
                drift(shape, "strokeColor", strokes)
                let q = 13 + c.quarter
                shape.opacity = Float(value(q, 0))
                if turning { breathe(shape, "pulse", "opacity", q, from: osc[q][0], to: osc[q][1], additive: false) }
                stage.addSublayer(shape)
            }
            CATransaction.commit()
        }

        windows.append(win)
        listenForCommands()
        var laidOut: (NSSize, Bool)? = nil
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let target = self?.targetFrame(), target.frame.width > 8, target.frame.height > 8 else { win.orderOut(nil); return }
            let frame = target.screen ? target.frame : target.frame.insetBy(dx: -margin, dy: -margin)
            if win.frame != frame { win.setFrame(frame, display: true) }
            if laidOut == nil || laidOut!.0 != target.frame.size || laidOut!.1 != target.screen {
                layout(target.frame.size, inward: target.screen)
                laidOut = (target.frame.size, target.screen)
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
