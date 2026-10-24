// ClawdCursor on-screen overlay for macOS (AppKit).
//
// Same contract as scripts/banner.ps1 + scripts/edge-glow.ps1 on Windows and
// scripts/linux/overlay.py, driven by src/core/banner.ts. Compiled once with
// `swiftc -O` into ~/.clawdcursor/bin (like the OCR helper).
//
//   overlay pill   the top-center pill. Running: red blinking dot, "desktop
//                  control in progress - double-click to stop" -> prints
//                  BANNER_STOP. Paused (env CLAWD_BANNER_MODE=paused): blue
//                  dot, the instruction from CLAWD_BANNER_MESSAGE, and Resume /
//                  Something else / End task -> prints BANNER_RESUME /
//                  BANNER_END; "Something else" opens a text field (the panel
//                  takes the keyboard only then) and Enter / Send prints
//                  BANNER_REPLY <base64 of the UTF-8 text>. Plays the
//                  "Glass" system sound when it appears (CLAWD_PAUSE_SOUND=0: off).
//   overlay glow [--color #RRGGBB] [--duration SEC]
//                  a pulsing glow on every edge of every display; clicks pass
//                  straight through it.
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

let red = NSColor(srgbRed: 1, green: 59 / 255, blue: 48 / 255, alpha: 1)
let redDim = NSColor(srgbRed: 110 / 255, green: 25 / 255, blue: 20 / 255, alpha: 1)
let blue = NSColor(srgbRed: 59 / 255, green: 130 / 255, blue: 246 / 255, alpha: 1)
let blueDim = NSColor(srgbRed: 25 / 255, green: 55 / 255, blue: 110 / 255, alpha: 1)
let background = NSColor(srgbRed: 18 / 255, green: 18 / 255, blue: 26 / 255, alpha: 0.97)

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

final class PillView: NSView {
    var onDoubleClick: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onDoubleClick?() }
    }
}

func label(_ text: String, size: CGFloat, color: NSColor, bold: Bool = false) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.font = bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
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

final class Overlay: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    let mode: String
    init(mode: String) { self.mode = mode }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if mode == "pill" { pill() } else { glow() }
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
            if data.isEmpty { handle.readabilityHandler = nil; return }   // EOF: the parent closed the pipe
            pending += String(decoding: data, as: UTF8.self)
            while let nl = pending.firstIndex(of: "\n") {
                let line = pending[..<nl].trimmingCharacters(in: .whitespaces)
                pending = String(pending[pending.index(after: nl)...])
                guard line.hasPrefix("HIDE "), let ms = Int(line.dropFirst(5)) else { continue }
                DispatchQueue.main.async { self?.hide(for: ms) }
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

    /// Esc in the field: back to the buttons.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            replyField?.stringValue = ""
            showReply(false)
            return true
        }
        return false
    }

    func pill() {
        let paused = ProcessInfo.processInfo.environment["CLAWD_BANNER_MODE"] == "paused"
        let width: CGFloat = paused ? 560 : 430
        let content = PillView(frame: .zero)
        content.wantsLayer = true
        content.layer?.backgroundColor = background.cgColor
        content.layer?.cornerRadius = paused ? 14 : 18
        content.layer?.masksToBounds = true

        let dot = label("\u{25CF}", size: 16, color: paused ? blue : red, bold: true)
        var height: CGFloat = 40

        if paused {
            let message = ProcessInfo.processInfo.environment["CLAWD_BANNER_MESSAGE"] ?? ""
            let title = label("ClawdCursor paused - your turn", size: 13, color: .white, bold: true)
            let msg = NSTextField(wrappingLabelWithString: message)
            msg.font = NSFont.systemFont(ofSize: 13)
            msg.textColor = NSColor(srgbRed: 215 / 255, green: 215 / 255, blue: 225 / 255, alpha: 1)
            msg.preferredMaxLayoutWidth = 500
            let msgH = ceil(msg.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: 500, height: 10_000)).height)
            height = 38 + msgH + 12 + 30 + 14

            dot.frame = NSRect(x: 14, y: height - 34, width: 20, height: 22)
            title.frame = NSRect(x: 40, y: height - 31, width: 480, height: 18)
            msg.frame = NSRect(x: 40, y: height - 38 - msgH, width: 500, height: msgH)

            func button(_ text: String, _ line: String, x: CGFloat, color: NSColor) -> FirstClickButton {
                let b = FirstClickButton(frame: NSRect(x: x, y: 14, width: 110, height: 30))
                b.title = text
                b.line = line
                b.isBordered = false
                b.wantsLayer = true
                b.layer?.backgroundColor = color.cgColor
                b.layer?.cornerRadius = 4
                b.attributedTitle = NSAttributedString(string: text, attributes: [
                    .foregroundColor: NSColor.white, .font: NSFont.boldSystemFont(ofSize: 13)])
                b.target = self
                b.action = #selector(answer(_:))
                return b
            }
            let gray = NSColor(srgbRed: 60 / 255, green: 60 / 255, blue: 72 / 255, alpha: 1)
            let resume = button("Resume", "BANNER_RESUME", x: width - 380, color: blue)
            let other = button("Something else", "", x: width - 260, color: gray)
            other.frame.size.width = 120
            other.action = #selector(somethingElse(_:))
            let end = button("End task", "BANNER_END", x: width - 130, color: gray)
            choiceButtons = [resume, other, end]

            let field = NSTextField(frame: NSRect(x: 40, y: 16, width: width - 40 - 100, height: 26))
            field.font = NSFont.systemFont(ofSize: 13)
            field.textColor = .white
            field.backgroundColor = NSColor(srgbRed: 36 / 255, green: 36 / 255, blue: 48 / 255, alpha: 1)
            field.isBezeled = true
            field.bezelStyle = .squareBezel
            field.placeholderString = "Tell the agent what to do instead"
            field.target = self
            field.action = #selector(sendReply(_:))
            field.delegate = self
            field.isHidden = true
            replyField = field
            let send = button("Send", "", x: width - 90, color: blue)
            send.frame.size.width = 76
            send.action = #selector(sendReply(_:))
            send.isHidden = true
            sendButton = send

            [dot, title, msg, resume, other, end, field, send].forEach { content.addSubview($0) }
        } else {
            let brand = label("ClawdCursor", size: 13, color: .white, bold: true)
            let sub = label("desktop control in progress  -  double-click to stop", size: 12,
                            color: NSColor(srgbRed: 170 / 255, green: 170 / 255, blue: 185 / 255, alpha: 1))
            dot.frame = NSRect(x: 14, y: 8, width: 20, height: 22)
            brand.frame = NSRect(x: 40, y: 11, width: 90, height: 18)
            sub.frame = NSRect(x: 133, y: 11, width: 290, height: 17)
            [dot, brand, sub].forEach { content.addSubview($0) }
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
        timer = Timer.scheduledTimer(withTimeInterval: paused ? 0.9 : 0.6, repeats: true) { _ in
            bright.toggle()
            dot.textColor = bright ? (paused ? blue : red) : (paused ? blueDim : redDim)
        }
    }

    func glow() {
        let color = option("--color", "#f59e0b")
        let thickness = CGFloat(Double(option("--thickness", "80")) ?? 80)
        let period = (Double(option("--period", "1600")) ?? 1600) / 1000
        let minAlpha = Float((Double(option("--min-alpha", "60")) ?? 60) / 255)
        let peak = CGFloat((Double(option("--peak-alpha", "200")) ?? 200) / 255)
        let duration = Double(option("--duration", "0")) ?? 0
        let edge = hexColor(color, alpha: peak).cgColor
        let clear = hexColor(color, alpha: 0).cgColor

        for screen in NSScreen.screens {
            let f = screen.frame
            let win = NSWindow(contentRect: f, styleMask: .borderless, backing: .buffered, defer: false)
            win.isOpaque = false
            win.backgroundColor = .clear
            win.hasShadow = false
            win.ignoresMouseEvents = true // click-through
            win.level = .screenSaver
            win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            win.sharingType = .none  // the glow is not captured either
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
            win.setFrame(f, display: true)
            win.orderFrontRegardless()
            windows.append(win)
        }
        if duration > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) { NSApp.terminate(nil) }
        }
    }
}

let mode = CommandLine.arguments.dropFirst().first ?? ""
guard mode == "pill" || mode == "glow" else {
    FileHandle.standardError.write("usage: overlay pill | glow [--color #RRGGBB] [--duration SEC]\n".data(using: .utf8)!)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let overlay = Overlay(mode: mode)
app.delegate = overlay
app.run()
