// macOS helper for eval/own-window (probe-macos.mjs, live-macos.mjs). Compiled at run time with swiftc. Measurement only.
// One command per run, one JSON line out: {"ok":true,"value":...} or {"ok":false,"err":"..."}.
// `watch` and `win` keep running (the caller kills them). Only the pids the caller passes are touched.
import Cocoa
import ApplicationServices

func reply(_ d: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) { print(s); fflush(stdout) }
}
func ok(_ v: Any = "") -> Never { reply(["ok": true, "value": v]); exit(0) }
func bad(_ m: String) -> Never { reply(["ok": false, "err": m]); exit(1) }
func pump(_ s: Double = 0.001) { RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: s)) }

// ---- accessibility
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success, let r = v else { return nil }
    return r as AnyObject
}
func sattr(_ e: AXUIElement, _ a: String) -> String { (attr(e, a) as? String) ?? "" }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
var budget = 8000
func walk(_ e: AXUIElement, _ depth: Int, _ f: (AXUIElement) -> Bool) -> AXUIElement? {
    if budget <= 0 || depth > 30 { return nil }
    budget -= 1
    if f(e) { return e }
    for c in kids(e) { if let r = walk(c, depth + 1, f) { return r } }
    return nil
}
/// Where to search: the page (AXWebArea) when the app has one, so a browser's address bar is never picked; else the app.
func searchRoot(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 3)
    budget = 8000
    return walk(app, 0, { sattr($0, "AXRole") == "AXWebArea" }) ?? app
}
func findText(_ pid: pid_t) -> AXUIElement? {
    let r = searchRoot(pid)
    budget = 8000
    return walk(r, 0, { ["AXTextArea", "AXTextField", "AXComboBox"].contains(sattr($0, "AXRole")) })
}
func findButton(_ pid: pid_t, _ name: String) -> AXUIElement? {
    let r = searchRoot(pid)
    budget = 8000
    return walk(r, 0, { e in
        sattr(e, "AXRole") == "AXButton" && (sattr(e, "AXTitle") + " " + sattr(e, "AXDescription")).localizedCaseInsensitiveContains(name)
    })
}
func center(_ el: AXUIElement) -> CGPoint? {
    guard let p = attr(el, "AXPosition"), let s = attr(el, "AXSize") else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGPoint(x: pt.x + sz.width / 2, y: pt.y + sz.height / 2)
}

// ---- input addressed to a pid (the posted-event route, M2 / M3)
func postKeys(_ pid: pid_t, _ text: String) -> Bool {
    let src = CGEventSource(stateID: .privateState)
    for ch in text {
        let u = Array(String(ch).utf16)
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { return false }
            e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
            e.postToPid(pid)
        }
        usleep(10_000)
    }
    return true
}
func postClick(_ pid: pid_t, _ pt: CGPoint) -> Bool {
    let src = CGEventSource(stateID: .privateState)
    for t in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
        guard let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: pt, mouseButton: .left) else { return false }
        e.setIntegerValueField(.mouseEventClickState, value: 1)
        e.postToPid(pid)
        usleep(40_000)
    }
    return true
}

// ---- processes
func launch(_ appPath: String, _ file: String?) -> pid_t {
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.createsNewApplicationInstance = true
    cfg.activates = false
    var pid: pid_t = 0
    var finished = false
    let done: (NSRunningApplication?, Error?) -> Void = { app, _ in pid = app?.processIdentifier ?? 0; finished = true }
    let appURL = URL(fileURLWithPath: appPath)
    if let f = file { NSWorkspace.shared.open([URL(fileURLWithPath: f)], withApplicationAt: appURL, configuration: cfg, completionHandler: done) }
    else { NSWorkspace.shared.openApplication(at: appURL, configuration: cfg, completionHandler: done) }
    let deadline = Date(timeIntervalSinceNow: 15)
    while !finished && Date() < deadline { pump(0.05) }
    return pid
}

// ---- a window of our own: "user" (text field holding user-was-here) or "target" (field, ClawdGo, ClawdReset, status label)
final class Ctl: NSObject {
    let field = NSTextField(frame: NSRect(x: 20, y: 150, width: 260, height: 24))
    let label = NSTextField(labelWithString: "")
    @objc func go() { label.stringValue = "CLICKED" }
    @objc func reset() { label.stringValue = ""; field.stringValue = "" }
}
func runWindow(_ kind: String) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let w = NSWindow(contentRect: NSRect(x: 200, y: 300, width: 300, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    w.title = kind == "user" ? "ClawdUser" : "ClawdTarget"
    let c = Ctl()
    c.field.stringValue = kind == "user" ? "user-was-here" : ""
    c.label.frame = NSRect(x: 20, y: 110, width: 260, height: 24)
    w.contentView?.addSubview(c.field)
    if kind == "target" {
        let go = NSButton(title: "ClawdGo", target: c, action: #selector(Ctl.go))
        go.frame = NSRect(x: 20, y: 70, width: 120, height: 30)
        let rs = NSButton(title: "ClawdReset", target: c, action: #selector(Ctl.reset))
        rs.frame = NSRect(x: 160, y: 70, width: 120, height: 30)
        w.contentView?.addSubview(c.label)
        w.contentView?.addSubview(go)
        w.contentView?.addSubview(rs)
    }
    w.makeKeyAndOrderFront(nil)
    w.makeFirstResponder(c.field)
    app.activate(ignoringOtherApps: true)
    reply(["ok": true, "value": Int(ProcessInfo.processInfo.processIdentifier)])
    withExtendedLifetime(c) { app.run() }
    exit(0)
}

// ---- commands
let a = CommandLine.arguments
guard a.count >= 2 else { bad("usage: macos-helper <command> ...") }
func pidArg(_ i: Int) -> pid_t { guard a.count > i, let p = Int32(a[i]) else { bad("pid missing") }; return p }
func arg(_ i: Int) -> String { a.count > i ? a[i] : "" }

switch a[1] {
case "trusted": ok(AXIsProcessTrusted())
case "win": runWindow(arg(2))
case "launch":
    let p = launch(arg(2), a.count > 3 ? a[3] : nil)
    if p == 0 { bad("launch failed") }
    ok(Int(p))
case "quit":
    guard let r = NSRunningApplication(processIdentifier: pidArg(2)) else { ok("gone") }
    ok(r.forceTerminate())
case "activate":
    ok(NSRunningApplication(processIdentifier: pidArg(2))?.activate(options: [.activateIgnoringOtherApps]) ?? false)
case "frontmost":
    _ = NSApplication.shared
    pump(0.1)
    let f = NSWorkspace.shared.frontmostApplication
    ok("\(f?.processIdentifier ?? 0)|\(f?.localizedName ?? "")")
case "watch":
    // S|epoch-ms|frontmost pid|cursor x|cursor y|frontmost name, every a[2] ms (default 50). Timestamps come from here, so a busy caller loses nothing.
    _ = NSApplication.shared
    let ms = Double(arg(2)) ?? 50
    while true {
        usleep(UInt32(ms * 1000))
        pump()
        let f = NSWorkspace.shared.frontmostApplication
        let p = CGEvent(source: nil)?.location ?? CGPoint.zero
        print("S|\(Int(Date().timeIntervalSince1970 * 1000))|\(f?.processIdentifier ?? 0)|\(Int(p.x))|\(Int(p.y))|\((f?.localizedName ?? "").replacingOccurrences(of: "|", with: "/"))")
        fflush(stdout)
    }
case "getvalue":
    guard let el = findText(pidArg(2)) else { bad("no text element") }
    ok((attr(el, "AXValue") as? String) ?? "")
case "getlabel":
    var out: [String] = []
    let r = searchRoot(pidArg(2))
    budget = 8000
    _ = walk(r, 0, { e in if sattr(e, "AXRole") == "AXStaticText" { out.append(sattr(e, "AXValue")) }; return false })
    ok(out.joined(separator: "\n"))
case "setvalue":
    guard let el = findText(pidArg(2)) else { bad("no text element") }
    let r = AXUIElementSetAttributeValue(el, "AXValue" as CFString, arg(3) as CFString)
    if r != .success { bad("AXError \(r.rawValue)") }
    ok()
case "press":
    guard let el = findButton(pidArg(2), arg(3)) else { bad("no button \(arg(3))") }
    let r = AXUIElementPerformAction(el, "AXPress" as CFString)
    if r != .success { bad("AXError \(r.rawValue)") }
    ok()
case "center":
    guard let el = findButton(pidArg(2), arg(3)), let c = center(el) else { bad("no button \(arg(3))") }
    ok("\(Int(c.x)),\(Int(c.y))")
case "key":
    ok(postKeys(pidArg(2), arg(3)))
case "click":
    ok(postClick(pidArg(2), CGPoint(x: Double(arg(3)) ?? 0, y: Double(arg(4)) ?? 0)))
default: bad("unknown command \(a[1])")
}
