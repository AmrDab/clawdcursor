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
//                  The border: an amber ring with a brighter run going round it (Border
//                  Beam's turn, below), drawn cheaply (windowOutline); --paused: the
//                  ring, still, in blue. With Reduce Motion on: the ring, still.
//
// The pill's orb is a port of Thinking Orbs, and the beam takes its turn from Border Beam, by Jakub Antalik (libraries.dev,
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
    /// back), or the pointer's screen when that app is in front with no window of its own (Finder's desktop).
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
        return (frame: NSRect(x: rect.minX, y: primary.frame.height - rect.maxY, width: rect.width, height: rect.height), screen: false)
    }

    /// The border beam (#392, #414): a thin ring at the edge of the frame, amber while the agent works and blue while it
    /// waits, and while it works a brighter run of the ring going round clockwise once in 1.96 s (Border Beam's turn).
    /// Drawn for power before looks (#414: the first port, a turning conic mask over window-sized gradient layers,
    /// rendered the whole area off screen every frame - 55% of an M1's GPU around a full screen). Here:
    ///   - the ring and its glow are layer borders, a 2 pt line over an 8 pt band at low alpha, rounded like the window:
    ///     no texture, nothing drawn again;
    ///   - the running part is two dashes, a soft 8 pt one with a bright 2 pt one in its middle, each on four
    ///     CAShapeLayers (a side and the corner after it), so a layer is only as big as its side's band; Core Animation
    ///     moves the dashes (lineDashPhase) with no code of ours running per frame;
    ///   - no masks, shadows, filters or window-sized gradients, so the GPU's work follows the edge, not the area.
    /// --paused, or Reduce Motion on: the ring alone, brighter and still: nothing changes once it is drawn.
    func windowOutline() {
        let paused = CommandLine.arguments.contains("--paused")
        let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let turning = !paused && !still

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

        let amber = rgb(245, 158, 11)
        let tint = paused ? blue : amber
        let glow = CALayer()
        glow.borderWidth = 8
        glow.borderColor = tint.withAlphaComponent(turning ? 0.08 : 0.16).cgColor
        let ring = CALayer()
        ring.borderWidth = 2
        ring.borderColor = tint.withAlphaComponent(turning ? 0.35 : 0.9).cgColor
        stage.addSublayer(glow)
        stage.addSublayer(ring)

        // The running part: each dash's line width, colour and share of the ring; the bright one is drawn last, on top.
        let dashes: [(width: CGFloat, color: NSColor, share: CGFloat)] = turning
            ? [(width: 8, color: amber.withAlphaComponent(0.3), share: 0.3), (width: 2, color: rgb(255, 200, 60), share: 0.12)]
            : []
        let runs: [[CAShapeLayer]] = dashes.map { dash -> [CAShapeLayer] in
            return (0..<4).map { _ -> CAShapeLayer in
                let side = CAShapeLayer()
                side.fillColor = nil
                side.strokeColor = dash.color.cgColor
                side.lineWidth = dash.width
                stage.addSublayer(side)
                return side
            }
        }
        let start = CACurrentMediaTime()

        // The layers for a frame of this size. A whole screen has square corners; a window's are rounded like its own,
        // or a wedge of what is behind shows at each one. The system does not give a window's radius: about 16 pt for a
        // standard window on macOS 26 (which reports itself as 16 to a binary built with an older SDK), about 10 pt before.
        let windowRadius: CGFloat = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 16 ? 16 : 10
        func layout(_ size: NSSize, screen: Bool) {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            let bounds = CGRect(origin: .zero, size: size)
            let radius = screen ? 0 : windowRadius
            for layer in [stage, glow, ring] {
                layer.frame = bounds
                layer.cornerRadius = radius
            }
            for (dash, sides) in zip(dashes, runs) {
                // The middle of the dash's line: inset by half its width, its corners to match.
                let rect = bounds.insetBy(dx: dash.width / 2, dy: dash.width / 2)
                let r = max(0, min(radius - dash.width / 2, min(rect.width, rect.height) / 2))
                // Clockwise from the end of the top-left corner (y grows upward here): a side and the corner after it each.
                let starts = [CGPoint(x: rect.minX + r, y: rect.maxY), CGPoint(x: rect.maxX, y: rect.maxY - r),
                              CGPoint(x: rect.maxX - r, y: rect.minY), CGPoint(x: rect.minX, y: rect.minY + r)]
                let corners = [CGPoint(x: rect.maxX, y: rect.maxY), CGPoint(x: rect.maxX, y: rect.minY),
                               CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.minX, y: rect.maxY)]
                let arc = CGFloat.pi * r / 2
                let lengths = [rect.width - 2 * r + arc, rect.height - 2 * r + arc, rect.width - 2 * r + arc, rect.height - 2 * r + arc]
                let perimeter = lengths.reduce(0, +)
                let lit = dash.share * perimeter
                var along: CGFloat = 0
                for (k, side) in sides.enumerated() {
                    let path = CGMutablePath()
                    path.move(to: starts[k])
                    if r > 0 {
                        path.addArc(tangent1End: corners[k], tangent2End: starts[(k + 1) % 4], radius: r)
                    } else {
                        path.addLine(to: corners[k])
                    }
                    // The layer is only as big as its piece of the ring.
                    let box = path.boundingBoxOfPath.insetBy(dx: -(dash.width / 2 + 1), dy: -(dash.width / 2 + 1))
                    var shift = CGAffineTransform(translationX: -box.minX, y: -box.minY)
                    side.contentsScale = win.backingScaleFactor   // added by hand, so 1 otherwise: soft on Retina
                    side.frame = box
                    side.path = path.copy(using: &shift)
                    // One dash per ring: a point `along` it is lit while (along + phase) mod perimeter < lit. The phase
                    // falls by a whole ring per turn (clockwise); both dashes keep their middle on the same share of it.
                    side.lineDashPattern = [NSNumber(value: Double(lit)), NSNumber(value: Double(perimeter - lit))]
                    let run = CABasicAnimation(keyPath: "lineDashPhase")
                    run.fromValue = Double(along + lit / 2 + perimeter)
                    run.toValue = Double(along + lit / 2)
                    run.duration = 1.96
                    run.beginTime = start   // the same clock for every layer and every size: the dash runs on unbroken
                    run.repeatCount = .infinity
                    side.add(run, forKey: "run")
                    along += lengths[k]
                }
            }
            CATransaction.commit()
        }

        windows.append(win)
        listenForCommands()
        var laidOut: (NSSize, Bool)? = nil
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let target = self?.targetFrame(), target.frame.width > 8, target.frame.height > 8 else { win.orderOut(nil); return }
            let frame = target.frame
            if win.frame != frame { win.setFrame(frame, display: true) }
            if laidOut == nil || laidOut!.0 != frame.size || laidOut!.1 != target.screen {
                layout(frame.size, screen: target.screen)
                laidOut = (frame.size, target.screen)
            }
            if !win.isVisible {
                win.orderFrontRegardless()
                if turning {
                    // Coming up: from clear to full over .6 s (a still ring, as on Windows, just appears).
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
