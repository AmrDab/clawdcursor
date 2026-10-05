// Ground-truth target app for clawdcursor live tests on macOS (AppKit).
// Logs JSON lines to /tmp/cc-target.log. All coordinates are GLOBAL POINTS
// with a TOP-LEFT origin (the space macOS accessibility and mouse APIs use).
import AppKit

let LOG = "/tmp/cc-target.log"
func log(_ ev: String, _ kv: [String: Any] = [:]) {
    var d = kv; d["ev"] = ev; d["t"] = Date().timeIntervalSince1970
    guard let data = try? JSONSerialization.data(withJSONObject: d) else { return }
    let line = data + "\n".data(using: .utf8)!
    if let h = FileHandle(forWritingAtPath: LOG) { h.seekToEndOfFile(); h.write(line); h.closeFile() }
    else { FileManager.default.createFile(atPath: LOG, contents: line) }
}
var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }
func topLeft(_ r: NSRect) -> [String: Double] {
    ["x": Double(r.minX), "y": Double(primaryHeight - r.maxY), "w": Double(r.width), "h": Double(r.height)]
}
func screenRect(_ v: NSView) -> NSRect? {
    guard let w = v.window else { return nil }
    return w.convertToScreen(v.convert(v.bounds, to: nil))
}

final class Act: NSObject {
    let f: () -> Void
    init(_ f: @escaping () -> Void) { self.f = f }
    @objc func go(_ sender: Any?) { f() }
}
var acts: [Act] = []
func button(_ title: String, _ f: @escaping () -> Void) -> NSButton {
    let a = Act(f); acts.append(a)
    return NSButton(title: title, target: a, action: #selector(Act.go(_:)))
}

let SQUARES: [(String, CGFloat, CGFloat, NSColor)] = [
    ("red", 20, 20, NSColor(srgbRed: 220/255, green: 40/255, blue: 40/255, alpha: 1)),
    ("green", 120, 20, NSColor(srgbRed: 40/255, green: 180/255, blue: 60/255, alpha: 1)),
    ("blue", 220, 20, NSColor(srgbRed: 40/255, green: 80/255, blue: 220/255, alpha: 1)),
    ("yellow", 20, 120, NSColor(srgbRed: 240/255, green: 200/255, blue: 30/255, alpha: 1)),
    ("magenta", 120, 120, NSColor(srgbRed: 200/255, green: 50/255, blue: 200/255, alpha: 1)),
    ("cyan", 220, 120, NSColor(srgbRed: 30/255, green: 200/255, blue: 210/255, alpha: 1)),
]
let RGB: [String: [Int]] = ["red": [220, 40, 40], "green": [40, 180, 60], "blue": [40, 80, 220],
                            "yellow": [240, 200, 30], "magenta": [200, 50, 200], "cyan": [30, 200, 210]]
let SQ: CGFloat = 60

final class Canvas: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        for (_, x, y, c) in SQUARES { c.setFill(); NSRect(x: x, y: y, width: SQ, height: SQ).fill() }
    }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let hit = SQUARES.first { p.x >= $0.1 && p.x < $0.1 + SQ && p.y >= $0.2 && p.y < $0.2 + SQ }?.0
        let g = NSEvent.mouseLocation
        log("canvas_click", ["x_root": Double(g.x), "y_root": Double(primaryHeight - g.y), "hit": hit ?? NSNull()])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 640),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
win.title = "CC Target"
let root = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 640))
win.contentView = root

let canvas = Canvas(frame: NSRect(x: 10, y: 430, width: 300, height: 200))
canvas.setAccessibilityLabel("Canvas")
root.addSubview(canvas)

var widgets: [String: NSView] = [:]
for (i, n) in ["Alpha", "Bravo", "Charlie", "Delta"].enumerated() {
    let b = button(n) { log("button", ["name": n]) }
    b.frame = NSRect(x: 10 + CGFloat(i % 2) * 110, y: 385 - CGFloat(i / 2) * 36, width: 100, height: 30)
    root.addSubview(b); widgets[n] = b
}
let secret = NSTextField(labelWithString: "")
secret.frame = NSRect(x: 120, y: 280, width: 200, height: 22)
root.addSubview(secret)
let reveal = button("Reveal") {
    log("button", ["name": "Reveal"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { secret.stringValue = "Secret code: 4729" }
}
reveal.frame = NSRect(x: 10, y: 278, width: 100, height: 30)
root.addSubview(reveal); widgets["Reveal"] = reveal

func field(_ label: String, _ y: CGFloat) -> NSTextField {
    let l = NSTextField(labelWithString: label); l.frame = NSRect(x: 10, y: y, width: 90, height: 22); root.addSubview(l)
    let f = NSTextField(frame: NSRect(x: 105, y: y, width: 200, height: 24))
    f.setAccessibilityLabel(label); root.addSubview(f); widgets[label] = f
    return f
}
let first = field("First name", 235)
let email = field("Email", 200)
let sub = NSButton(checkboxWithTitle: "Subscribe", target: nil, action: nil)
sub.frame = NSRect(x: 105, y: 168, width: 200, height: 22); root.addSubview(sub); widgets["Subscribe"] = sub
let planLabel = NSTextField(labelWithString: "Plan"); planLabel.frame = NSRect(x: 10, y: 133, width: 90, height: 22); root.addSubview(planLabel)
let plan = NSPopUpButton(frame: NSRect(x: 105, y: 130, width: 200, height: 26), pullsDown: false)
plan.addItems(withTitles: ["Free", "Pro", "Team"]); plan.setAccessibilityLabel("Plan")
root.addSubview(plan); widgets["Plan"] = plan
let submit = button("Submit") {
    log("submit", ["first": first.stringValue, "email": email.stringValue,
                   "subscribe": sub.state == .on, "plan": plan.titleOfSelectedItem ?? ""])
}
submit.frame = NSRect(x: 105, y: 90, width: 200, height: 30)
root.addSubview(submit); widgets["Submit"] = submit

// 60-row list in a scroll view: rows past ~16 start offscreen.
let rowH: CGFloat = 26
let doc = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: rowH * 60))
for i in 1...60 {
    let name = String(format: "Row %02d", i)
    let b = button(name) { log("row", ["name": name]) }
    b.frame = NSRect(x: 4, y: doc.frame.height - CGFloat(i) * rowH, width: 220, height: rowH - 2)
    doc.addSubview(b)
}
let scroll = NSScrollView(frame: NSRect(x: 340, y: 20, width: 260, height: 420))
scroll.documentView = doc
scroll.hasVerticalScroller = true
scroll.setAccessibilityLabel("Row list")
root.addSubview(scroll)
doc.scroll(NSPoint(x: 0, y: doc.frame.height))

func logLayout() {
    guard let c = screenRect(canvas) else { return }
    let ct = topLeft(c)
    var squares: [String: Any] = [:]
    for (n, x, y, _) in SQUARES {
        squares[n] = ["x": ct["x"]! + Double(x), "y": ct["y"]! + Double(y), "w": Double(SQ), "h": Double(SQ), "rgb": RGB[n]!]
    }
    var ws: [String: Any] = [:]
    for (k, v) in widgets { if let r = screenRect(v) { ws[k] = topLeft(r) } }
    let s = NSScreen.screens.first!
    log("layout", ["canvas": ct, "squares": squares, "widgets": ws,
                   "screen": ["w": Double(s.frame.width), "h": Double(s.frame.height), "scale": Double(s.backingScaleFactor)]])
}
NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: win, queue: .main) { _ in logLayout() }
NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: win, queue: .main) { _ in logLayout() }

win.setFrameTopLeftPoint(NSPoint(x: 120, y: primaryHeight - 90))
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { logLayout() }
app.run()
