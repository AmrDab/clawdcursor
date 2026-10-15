// ax-helper.swift — macOS accessibility straight from the AX C API.
//
// One short-lived process per question. It prints ONE JSON object and exits 0, even
// when the question could not be answered: {"ok":false,"kind":…,"error":…}. The
// protocol is documented in src/platform/mac-ax.ts, which also falls back to the old
// osascript/JXA scripts while this binary is not built (or when swiftc is missing).
//
// Why this exists: JXA/System Events pays one Apple Event per attribute, so a window
// list took 9–10 s, a Calculator tree 25 s — long enough to blow the 8 s / 12 s
// timeouts, whose errors were swallowed into "Windows (0)" and "empty a11y tree".
// The AX C API reads the same data in tens of milliseconds, and it also sees what
// System Events cannot:
//   · AXIdentifier   — SwiftUI controls (the macOS 26 Calculator) expose nothing else
//   · AXFocusedWindow / AXMainWindow — the window that really has the keyboard
//   · NSWorkspace    — the system dialog or lock screen that owns the keyboard while
//                      System Events still names the app behind it
//
// Usage:
//   ax-helper windows   [--timeout-ms N]
//   ax-helper active    [--timeout-ms N]
//   ax-helper frontmost [--timeout-ms N]
//   ax-helper apps      [--name S] [--timeout-ms N]
//   ax-helper tree      [--pid N] [--max-depth N] [--max-nodes N] [--timeout-ms N]
//   ax-helper find      [--pid N] [--name S] [--role R] [--id S] [--max-results N] [--timeout-ms N]
//   ax-helper invoke    [--pid N] --action A [--name S] [--role R] [--id S] [--value V] [--timeout-ms N]
//   (every command also takes --ax-timeout-ms N: how long ONE call to ONE app may block)
//
// Secure text fields: their value is never read out of the process.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Output

func emit(_ object: [String: Any]) -> Never {
    let fallback = Data("{\"ok\":false,\"kind\":\"failed\",\"error\":\"could not encode the reply\"}".utf8)
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])) ?? fallback
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

func fail(_ kind: String, _ message: String) -> Never {
    emit(["ok": false, "kind": kind, "error": message])
}

// MARK: - Arguments and budgets

var argv = Array(CommandLine.arguments.dropFirst())
let command = argv.isEmpty ? "" : argv.removeFirst()
var opts: [String: String] = [:]
do {
    var i = 0
    while i < argv.count {
        let a = argv[i]
        if a.hasPrefix("--") {
            let key = String(a.dropFirst(2))
            if i + 1 < argv.count && !argv[i + 1].hasPrefix("--") { opts[key] = argv[i + 1]; i += 2 } else { opts[key] = ""; i += 1 }
        } else { i += 1 }
    }
}

let startedAt = Date()
let budgetMs = Int(opts["timeout-ms"] ?? "") ?? 8000
let deadline = startedAt.addingTimeInterval(Double(budgetMs) / 1000)
func timeUp() -> Bool { Date() >= deadline }
func elapsedMs() -> Int { Int(Date().timeIntervalSince(startedAt) * 1000) }
/// One call to one app may block this long (the AX default is 6 s — a single hung app would eat the whole budget).
let axTimeout: Float = Float(Double(opts["ax-timeout-ms"] ?? "") ?? 1500) / 1000
let ownPid = getpid()
/// clawdcursor's own windows are never "the active window".
let ownNames: Set<String> = ["clawd-overlay", "ClawdCursorHost", "ClawdCursor"]

// MARK: - Session

func screenLocked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}

/// Behind the lock screen every app's AX tree is an empty shell — reading it would return garbage, not an error.
func requireUsableSession() {
    if screenLocked() { fail("locked", "the screen is locked (the lock screen, loginwindow, owns the display and keyboard)") }
    if !AXIsProcessTrusted() { fail("permission", "Accessibility permission is not granted to the app running clawdcursor") }
}

// MARK: - Reading attributes

func appElement(_ pid: pid_t) -> AXUIElement {
    let el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, axTimeout)
    return el
}

func copyAttr(_ el: AXUIElement, _ name: String) -> (value: CFTypeRef?, error: AXError) {
    var v: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return (r == .success ? v : nil, r)
}

/// Several attributes in ONE round trip. Missing attributes are simply absent.
func multi(_ el: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
    var out: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
          let arr = out as? [AnyObject] else { return [:] }
    var d: [String: CFTypeRef] = [:]
    for (i, v) in arr.enumerated() where i < names.count {
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
        d[names[i]] = v
    }
    return d
}

func str(_ v: CFTypeRef?) -> String? {
    guard let v = v else { return nil }
    let id = CFGetTypeID(v)
    if id == CFStringGetTypeID() { return v as? String }
    if id == CFAttributedStringGetTypeID() { return (v as? NSAttributedString)?.string }
    if id == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) ? "1" : "0" }
    if id == CFNumberGetTypeID() { return (v as? NSNumber)?.stringValue }
    if id == CFURLGetTypeID() { return (v as? URL)?.absoluteString }
    return nil
}

func bool(_ v: CFTypeRef?) -> Bool? {
    guard let v = v, CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }
    return CFBooleanGetValue((v as! CFBoolean))
}

func axPoint(_ v: CFTypeRef?) -> CGPoint? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var out = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &out) ? out : nil
}

func axSize(_ v: CFTypeRef?) -> CGSize? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var out = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &out) ? out : nil
}

func finite(_ x: CGFloat) -> Int { x.isFinite ? Int(x.rounded()) : 0 }

func rect(_ p: CGPoint?, _ s: CGSize?) -> [String: Int] {
    ["x": finite(p?.x ?? 0), "y": finite(p?.y ?? 0), "width": finite(s?.width ?? 0), "height": finite(s?.height ?? 0)]
}

func isElement(_ v: CFTypeRef?) -> Bool { v != nil && CFGetTypeID(v!) == AXUIElementGetTypeID() }

func policyName(_ app: NSRunningApplication) -> String {
    switch app.activationPolicy {
    case .regular: return "regular"
    case .accessory: return "accessory"
    default: return "prohibited"
    }
}

// MARK: - Applications and windows

func candidateApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        !$0.isTerminated && $0.activationPolicy != .prohibited && $0.processIdentifier != ownPid
    }
}

/// The topmost window of an ordinary app, front to back — the answer when our own overlay holds NSWorkspace's "frontmost".
func topmostRegularApp() -> NSRunningApplication? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != ownPid,
              let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular,
              !ownNames.contains(app.localizedName ?? "") else { continue }
        return app
    }
    return nil
}

/// NSWorkspace's frontmost application (which, unlike System Events, includes system dialogs).
func activeApplication() -> NSRunningApplication? {
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    if ownNames.contains(front.localizedName ?? "") { return topmostRegularApp() ?? front }
    return front
}

func targetApplication() -> NSRunningApplication {
    if let p = opts["pid"], !p.isEmpty {
        guard let pid = Int32(p), let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
            fail("failed", "no such process: \(p)")
        }
        return app
    }
    guard let app = activeApplication() else { fail("failed", "there is no frontmost application") }
    return app
}

let windowAttrs = ["AXTitle", "AXPosition", "AXSize", "AXMinimized", "AXSubrole", "AXRole"]

func windowDict(_ w: AXUIElement, _ app: NSRunningApplication) -> [String: Any] {
    let a = multi(w, windowAttrs)
    return [
        "title": str(a["AXTitle"]) ?? "",
        "processName": app.localizedName ?? "unknown",
        "processId": Int(app.processIdentifier),
        "bounds": rect(axPoint(a["AXPosition"]), axSize(a["AXSize"])),
        "isMinimized": bool(a["AXMinimized"]) ?? false,
        "subrole": str(a["AXSubrole"]) ?? "",
    ]
}

/// Titled windows, plus untitled real windows (Calculator's has no title) — but not the
/// untitled helper panels menu-bar apps keep around.
func worthListing(_ w: [String: Any]) -> Bool {
    if !((w["title"] as? String) ?? "").isEmpty { return true }
    let b = w["bounds"] as? [String: Int] ?? [:]
    let sub = (w["subrole"] as? String) ?? ""
    return ["AXStandardWindow", "AXDialog", "AXSystemDialog"].contains(sub) && (b["width"] ?? 0) >= 40 && (b["height"] ?? 0) >= 40
}

/// Why one app could not be read: a call that waited out the whole messaging timeout means it is hung.
enum AppRead { case windows([[String: Any]]), unresponsive }

func readWindows(of app: NSRunningApplication) -> AppRead {
    let el = appElement(app.processIdentifier)
    let t0 = Date()
    let (value, err) = copyAttr(el, "AXWindows")
    if err != .success {
        let waited = Date().timeIntervalSince(t0)
        // Quick refusals (app without accessibility support) are ordinary; only a full timeout is a hang.
        return waited >= Double(axTimeout) * 0.8 && err == .cannotComplete ? .unresponsive : .windows([])
    }
    var out: [[String: Any]] = []
    for w in (value as? [AXUIElement]) ?? [] {
        if timeUp() { return .unresponsive }
        let t1 = Date()
        let d = windowDict(w, app)
        // Answered the list, then took a whole messaging timeout on one window: it is stalling.
        if Date().timeIntervalSince(t1) >= Double(axTimeout) * 0.8 { return .unresponsive }
        out.append(d)
    }
    return .windows(out)
}

/// Fan out across apps: one hung app costs its own timeout, not everyone's.
func readAllApps(_ apps: [NSRunningApplication]) -> (results: [Int: [[String: Any]]], unresponsive: [[String: Any]]) {
    let lock = NSLock()
    var results: [Int: [[String: Any]]] = [:]
    var unresponsive: [[String: Any]] = []
    DispatchQueue.concurrentPerform(iterations: apps.count) { i in
        let app = apps[i]
        if timeUp() {
            lock.lock(); unresponsive.append(["processId": Int(app.processIdentifier), "processName": app.localizedName ?? "unknown"]); lock.unlock()
            return
        }
        switch readWindows(of: app) {
        case .windows(let ws):
            lock.lock(); results[Int(app.processIdentifier)] = ws; lock.unlock()
        case .unresponsive:
            lock.lock(); unresponsive.append(["processId": Int(app.processIdentifier), "processName": app.localizedName ?? "unknown"]); lock.unlock()
        }
    }
    return (results, unresponsive)
}

/// The window that has the keyboard: the app's focused window, else its main window, else the first one.
func keyWindow(_ app: AXUIElement) -> (window: AXUIElement?, source: String, hung: Bool) {
    let t0 = Date()
    var sawCannotComplete = false
    for (attr, source) in [("AXFocusedWindow", "AXFocusedWindow"), ("AXMainWindow", "AXMainWindow")] {
        let (v, err) = copyAttr(app, attr)
        if let v = v, isElement(v) { return (v as! AXUIElement?, source, false) }
        if err == .cannotComplete { sawCannotComplete = true }
    }
    let (ws, err) = copyAttr(app, "AXWindows")
    if let first = (ws as? [AXUIElement])?.first { return (first, "AXWindows", false) }
    if err == .cannotComplete { sawCannotComplete = true }
    return (nil, "none", sawCannotComplete && Date().timeIntervalSince(t0) >= Double(axTimeout) * 0.8)
}

// MARK: - Roles

let leafRoles: Set<String> = [
    "AXButton", "AXStaticText", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXImage", "AXSlider",
    "AXValueIndicator", "AXIncrementor", "AXPopUpButton", "AXMenuButton", "AXScrollBar", "AXBusyIndicator",
    "AXProgressIndicator", "AXColorWell", "AXSplitter", "AXDisclosureTriangle", "AXSearchField", "AXComboBox",
]
/// Kept even without a name: you can act on them.
let alwaysKeepRoles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem",
    "AXPopUpButton", "AXMenuButton", "AXSearchField", "AXSlider", "AXTab", "AXSwitch", "AXDisclosureTriangle",
    "AXColorWell", "AXIncrementor", "AXWebArea", "AXTable", "AXOutline", "AXList", "AXToolbar", "AXTabGroup",
    "AXRadioGroup", "AXSheet", "AXMenu", "AXSegmentedControl",
]
/// Controls whose label is often a child AXStaticText rather than their own title.
let labelPeekRoles: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXTab", "AXLink", "AXPopUpButton"]

/// AppKit stamps generated ids ("_NS:833") on unlabeled elements; a node is not worth keeping just for one.
func isGeneratedIdentifier(_ id: String) -> Bool {
    id.hasPrefix("_NS:") && id.dropFirst(4).allSatisfy { $0.isNumber }
}

func normRole(_ r: String) -> String {
    var s = r.lowercased().replacingOccurrences(of: " ", with: "")
    if s.hasPrefix("ax") { s = String(s.dropFirst(2)) }
    return s
}

// MARK: - Tree

struct Walk {
    var nodes = 0
    let maxNodes: Int
    let maxDepth: Int
    var cut: String? = nil
}

let nodeAttrs = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXIdentifier", "AXValue", "AXPosition", "AXSize",
    "AXEnabled", "AXFocused", "AXSelected", "AXExpanded", "AXChildren",
]

func firstStaticTextValue(_ kids: [AXUIElement]) -> String {
    for k in kids.prefix(4) {
        let a = multi(k, ["AXRole", "AXValue", "AXTitle"])
        if str(a["AXRole"]) == "AXStaticText" {
            let t = str(a["AXValue"]) ?? str(a["AXTitle"]) ?? ""
            if !t.isEmpty { return t }
        }
    }
    return ""
}

func buildNode(_ el: AXUIElement, _ depth: Int, _ w: inout Walk) -> [String: Any]? {
    if timeUp() { if w.cut == nil { w.cut = "time" }; return nil }
    if w.nodes >= w.maxNodes { if w.cut == nil { w.cut = "nodes" }; return nil }
    w.nodes += 1

    let a = multi(el, nodeAttrs)
    let role = str(a["AXRole"]) ?? ""
    let subrole = str(a["AXSubrole"]) ?? ""
    let secure = subrole == "AXSecureTextField"
    let title = str(a["AXTitle"]) ?? ""
    let desc = str(a["AXDescription"]) ?? ""
    let ident = str(a["AXIdentifier"]) ?? ""
    let kids = (a["AXChildren"] as? [AXUIElement]) ?? []
    var name = title.isEmpty ? desc : title
    // A secure field's value never leaves this process — it is not even kept.
    let value: String? = secure ? nil : str(a["AXValue"])

    var children: [[String: Any]] = []
    if depth < w.maxDepth && !leafRoles.contains(role) {
        for k in kids {
            if let c = buildNode(k, depth + 1, &w) { children.append(c) }
            if w.cut == "time" { break }
        }
    }
    if name.isEmpty && (ident.isEmpty || isGeneratedIdentifier(ident)) && labelPeekRoles.contains(role) { name = firstStaticTextValue(kids) }

    let hasValue = !(value ?? "").isEmpty
    let keep = depth == 0 || !name.isEmpty || (!ident.isEmpty && !isGeneratedIdentifier(ident)) || hasValue
        || alwaysKeepRoles.contains(role) || !children.isEmpty
    if !keep { return nil }

    var node: [String: Any] = [
        "name": name,
        "automationId": ident,
        "controlType": role,
        "bounds": rect(axPoint(a["AXPosition"]), axSize(a["AXSize"])),
    ]
    if !subrole.isEmpty { node["subrole"] = subrole }
    if secure { node["secure"] = true } else if hasValue, let v = value { node["value"] = String(v.prefix(500)) }
    if !desc.isEmpty && desc != name { node["description"] = desc }
    if bool(a["AXEnabled"]) == false { node["enabled"] = false }
    if bool(a["AXFocused"]) == true { node["focused"] = true }
    if bool(a["AXSelected"]) == true { node["selected"] = true }
    if let ex = bool(a["AXExpanded"]) { node["expandable"] = true; node["expanded"] = ex }
    if !children.isEmpty { node["children"] = children }
    return node
}

// MARK: - Find / invoke

struct Hit {
    let element: AXUIElement
    let name: String
    let title: String
    let desc: String
    let ident: String
    let role: String
    let subrole: String
    let depth: Int
    let exact: Bool
}

struct Aim {
    let name: String?
    let role: String?
    let id: String?
    var isEmpty: Bool { name == nil && role == nil && id == nil }
}

func currentAim() -> Aim {
    func nonEmpty(_ k: String) -> String? { if let v = opts[k], !v.isEmpty { return v }; return nil }
    return Aim(name: nonEmpty("name"), role: nonEmpty("role"), id: nonEmpty("id"))
}

let searchAttrs = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXIdentifier", "AXChildren"]

/// Breadth-first search of one window: shallow matches first, one batched read per element.
func search(_ root: AXUIElement, _ aim: Aim, maxDepth: Int, limit: Int, stopAtExactId: Bool = false, into hits: inout [Hit]) {
    let wantName = aim.name?.lowercased()
    let wantRole = aim.role.map(normRole)
    var level: [AXUIElement] = [root]
    var depth = 0
    while !level.isEmpty && depth <= maxDepth && !timeUp() && hits.count < limit {
        var next: [AXUIElement] = []
        for el in level {
            if timeUp() || hits.count >= limit { break }
            let a = multi(el, searchAttrs)
            let role = str(a["AXRole"]) ?? ""
            let title = str(a["AXTitle"]) ?? ""
            let desc = str(a["AXDescription"]) ?? ""
            let ident = str(a["AXIdentifier"]) ?? ""
            var matches = !role.isEmpty
            var exact = false
            if let w = wantName {
                let tl = title.lowercased(), dl = desc.lowercased(), il = ident.lowercased()
                matches = matches && (tl.contains(w) || dl.contains(w) || il.contains(w))
                exact = tl == w || dl == w || il == w
            }
            if let id = aim.id {
                let ok = ident == id || ident.lowercased() == id.lowercased()
                matches = matches && ok
                exact = exact || ident == id
            }
            if let r = wantRole { matches = matches && normRole(role).contains(r) }
            if matches {
                hits.append(Hit(element: el, name: title.isEmpty ? desc : title, title: title, desc: desc, ident: ident, role: role,
                                subrole: str(a["AXSubrole"]) ?? "", depth: depth, exact: exact))
                // An identifier names one element; walking the rest of a big window would only cost time.
                if stopAtExactId && exact && aim.name == nil && aim.role == nil { return }
            }
            if !leafRoles.contains(role), let kids = a["AXChildren"] as? [AXUIElement] { next.append(contentsOf: kids) }
        }
        level = next
        depth += 1
    }
}

/// Every window of the app, the key window first.
func windowsToSearch(_ app: NSRunningApplication) -> [AXUIElement] {
    let el = appElement(app.processIdentifier)
    var out: [AXUIElement] = []
    let key = keyWindow(el)
    if let k = key.window { out.append(k) }
    if let all = copyAttr(el, "AXWindows").value as? [AXUIElement] {
        for w in all where !out.contains(where: { CFEqual($0, w) }) { out.append(w) }
    }
    return out
}

func hitDict(_ h: Hit, pid: Int32) -> [String: Any] {
    let a = multi(h.element, ["AXPosition", "AXSize", "AXValue", "AXEnabled", "AXFocused", "AXSelected"])
    let secure = h.subrole == "AXSecureTextField"
    var d: [String: Any] = [
        "name": h.name, "automationId": h.ident, "controlType": h.role,
        "bounds": rect(axPoint(a["AXPosition"]), axSize(a["AXSize"])),
        "processId": Int(pid),
    ]
    if !h.subrole.isEmpty { d["subrole"] = h.subrole }
    if secure { d["secure"] = true } else if let v = str(a["AXValue"]), !v.isEmpty { d["value"] = String(v.prefix(500)) }
    if bool(a["AXEnabled"]) == false { d["enabled"] = false }
    if bool(a["AXFocused"]) == true { d["focused"] = true }
    if bool(a["AXSelected"]) == true { d["selected"] = true }
    return d
}

/// Roles each action should land on, best first (set-value must reach the editable field, not the label beside it).
let actionRoles: [String: [String]] = [
    "set-value": ["textfield", "textarea", "combobox", "searchfield"],
    "get-value": ["textfield", "textarea", "combobox", "searchfield", "statictext"],
    "toggle": ["checkbox", "radiobutton", "switch"],
    "click": ["button", "menuitem", "menubuttonitem", "link", "radiobutton", "checkbox", "popupbutton", "cell", "row", "tab"],
]

func rankHits(_ hits: [Hit], action: String?) -> [Hit] {
    let pref = actionRoles[action ?? ""] ?? []
    func score(_ h: Hit) -> Int {
        let rank = pref.firstIndex(of: normRole(h.role)) ?? -1
        return (h.exact ? 0 : 1000) + (rank == -1 ? 100 : rank) * 10 + h.depth
    }
    return hits.enumerated().sorted { (score($0.element), $0.offset) < (score($1.element), $1.offset) }.map { $0.element }
}

func elementRect(_ el: AXUIElement) -> (rect: [String: Int], point: [String: Int])? {
    let a = multi(el, ["AXPosition", "AXSize"])
    guard let p = axPoint(a["AXPosition"]), let s = axSize(a["AXSize"]) else { return nil }
    return (rect(p, s), ["x": finite(p.x + s.width / 2), "y": finite(p.y + s.height / 2)])
}

func miss(_ action: String, _ message: String, element el: AXUIElement? = nil) -> [String: Any] {
    var r: [String: Any] = ["ok": true, "success": false, "action": action, "error": message]
    if let el = el, let g = elementRect(el) { r["bounds"] = g.rect; r["clickPoint"] = g.point }
    return r
}

func settable(_ el: AXUIElement, _ attr: String) -> Bool {
    var s: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(el, attr as CFString, &s) == .success && s.boolValue
}

func perform(_ action: String, _ h: Hit) -> [String: Any] {
    let el = h.element
    switch action {
    case "click":
        let r = AXUIElementPerformAction(el, "AXPress" as CFString)
        if r == .success { return ["ok": true, "success": true, "action": action, "method": "AXPress"] }
        return miss(action, "the element does not support AXPress (AXError \(r.rawValue)) — click its coordinates instead", element: el)
    case "focus":
        let r = AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
        return r == .success ? ["ok": true, "success": true, "action": action] : miss(action, "could not focus the element (AXError \(r.rawValue))", element: el)
    case "set-value":
        guard let v = opts["value"] else { return miss(action, "set-value needs --value") }
        if h.subrole == "AXSecureTextField" { return miss(action, "refusing to write to a secure text field") }
        if !settable(el, "AXValue") { return miss(action, "the element's value is not settable", element: el) }
        let r = AXUIElementSetAttributeValue(el, "AXValue" as CFString, v as CFString)
        return r == .success ? ["ok": true, "success": true, "action": action, "method": "AXValue", "value": v] : miss(action, "could not set the value (AXError \(r.rawValue))", element: el)
    case "get-value":
        if h.subrole == "AXSecureTextField" { return miss(action, "the element is a secure text field — its value is withheld") }
        let a = multi(el, ["AXValue", "AXTitle", "AXDescription"])
        for (key, method) in [("AXValue", "AXValue"), ("AXTitle", "name"), ("AXDescription", "name")] {
            if let v = str(a[key]), !v.isEmpty { return ["ok": true, "success": true, "action": action, "value": v, "method": method] }
        }
        return ["ok": true, "success": true, "action": action, "value": "", "method": "empty"]
    case "expand", "collapse":
        let want = action == "expand"
        if settable(el, "AXExpanded"), AXUIElementSetAttributeValue(el, "AXExpanded" as CFString, want ? kCFBooleanTrue : kCFBooleanFalse) == .success {
            return ["ok": true, "success": true, "action": action, "method": "AXExpanded"]
        }
        if want, AXUIElementPerformAction(el, "AXShowMenu" as CFString) == .success {
            return ["ok": true, "success": true, "action": action, "method": "AXShowMenu"]
        }
        return miss(action, "the element does not support \(action) (no AXExpanded)", element: el)
    case "toggle":
        let r = AXUIElementPerformAction(el, "AXPress" as CFString)
        if r != .success { return miss(action, "the element does not support toggle (no AXPress; AXError \(r.rawValue))", element: el) }
        Thread.sleep(forTimeInterval: 0.05)
        let after = str(copyAttr(el, "AXValue").value)
        let state = after == nil ? "unknown" : (after == "0" ? "Off" : "On")
        return ["ok": true, "success": true, "action": action, "method": "AXPress", "data": ["toggleState": state]]
    case "select":
        if settable(el, "AXSelected"), AXUIElementSetAttributeValue(el, "AXSelected" as CFString, kCFBooleanTrue) == .success {
            return ["ok": true, "success": true, "action": action, "method": "AXSelected"]
        }
        if AXUIElementPerformAction(el, "AXPress" as CFString) == .success {
            return ["ok": true, "success": true, "action": action, "method": "AXPress"]
        }
        return miss(action, "the element does not support select (no AXSelected / AXPress)", element: el)
    default:
        return miss(action, "unknown action: \(action)")
    }
}

// MARK: - Commands

func cmdFrontmost() -> Never {
    let locked = screenLocked()
    guard let app = NSWorkspace.shared.frontmostApplication else {
        emit(["ok": true, "locked": locked, "frontmost": NSNull()])
    }
    var windows: [[String: Any]] = []
    // Only a non-ordinary app can be a dialog that owns the keyboard; read what it shows so the caller can tell.
    if !locked && app.activationPolicy != .regular && AXIsProcessTrusted() {
        let el = appElement(app.processIdentifier)
        for w in ((copyAttr(el, "AXWindows").value as? [AXUIElement]) ?? []).prefix(6) {
            if timeUp() { break }
            let a = multi(w, ["AXTitle", "AXSubrole", "AXRole", "AXModal"])
            var d: [String: Any] = ["title": str(a["AXTitle"]) ?? "", "subrole": str(a["AXSubrole"]) ?? "", "role": str(a["AXRole"]) ?? ""]
            if bool(a["AXModal"]) == true { d["modal"] = true }
            windows.append(d)
        }
    }
    var info: [String: Any] = [
        "name": app.localizedName ?? "unknown",
        "processId": Int(app.processIdentifier),
        "activationPolicy": policyName(app),
        "windows": windows,
    ]
    if let b = app.bundleIdentifier { info["bundleId"] = b }
    emit(["ok": true, "locked": locked, "frontmost": info])
}

func cmdWindows() -> Never {
    requireUsableSession()
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let apps = candidateApps().sorted { a, b in
        if a.processIdentifier == front { return true }
        if b.processIdentifier == front { return false }
        return a.processIdentifier < b.processIdentifier
    }
    let (results, unresponsive) = readAllApps(apps)
    var windows: [[String: Any]] = []
    for app in apps {
        for w in results[Int(app.processIdentifier)] ?? [] where worthListing(w) {
            var d = w
            d.removeValue(forKey: "subrole")
            windows.append(d)
        }
    }
    emit(["ok": true, "windows": windows, "unresponsive": unresponsive, "elapsedMs": elapsedMs()])
}

func cmdActive() -> Never {
    requireUsableSession()
    guard let app = activeApplication() else { emit(["ok": true, "active": NSNull()]) }
    let el = appElement(app.processIdentifier)
    let key = keyWindow(el)
    if key.hung { fail("timeout", "the frontmost app (\(app.localizedName ?? "unknown")) is not responding") }
    var d: [String: Any]
    if let w = key.window {
        d = windowDict(w, app)
    } else {
        d = ["title": "", "processName": app.localizedName ?? "unknown", "processId": Int(app.processIdentifier),
             "bounds": rect(nil, nil), "isMinimized": false, "subrole": ""]
    }
    d["source"] = key.source
    d["activationPolicy"] = policyName(app)
    if let b = app.bundleIdentifier { d["bundleId"] = b }
    emit(["ok": true, "active": d, "elapsedMs": elapsedMs()])
}

func appNames(_ app: NSRunningApplication) -> [String] {
    var names: [String] = []
    if let n = app.localizedName { names.append(n) }
    if let url = app.bundleURL {
        names.append(url.deletingPathExtension().lastPathComponent)
        if let info = Bundle(url: url)?.infoDictionary {
            for k in ["CFBundleName", "CFBundleDisplayName"] { if let v = info[k] as? String { names.append(v) } }
        }
    }
    if let n = app.executableURL?.lastPathComponent { names.append(n) }
    return names.map { $0.lowercased() }
}

func cmdApps() -> Never {
    requireUsableSession()
    let want = (opts["name"] ?? "").lowercased()
    let apps = candidateApps().filter { want.isEmpty || appNames($0).contains { $0.contains(want) } }
    let (results, unresponsive) = readAllApps(apps)
    var out: [[String: Any]] = []
    for app in apps {
        var d: [String: Any] = [
            "name": app.localizedName ?? "unknown",
            "processId": Int(app.processIdentifier),
            "finishedLaunching": app.isFinishedLaunching,
            "active": app.isActive,
            "activationPolicy": policyName(app),
            "windows": (results[Int(app.processIdentifier)] ?? []).filter(worthListing).map { w -> [String: Any] in
                var x = w; x.removeValue(forKey: "subrole"); return x
            },
        ]
        if let b = app.bundleIdentifier { d["bundleId"] = b }
        if let t = app.launchDate { d["launchDate"] = t.timeIntervalSince1970 }
        out.append(d)
    }
    emit(["ok": true, "apps": out, "unresponsive": unresponsive, "elapsedMs": elapsedMs()])
}

func cmdTree() -> Never {
    requireUsableSession()
    let app = targetApplication()
    let el = appElement(app.processIdentifier)
    let key = keyWindow(el)
    if key.hung { fail("timeout", "\(app.localizedName ?? "the app") is not responding") }
    var reply: [String: Any] = ["ok": true, "processId": Int(app.processIdentifier), "processName": app.localizedName ?? "unknown"]
    guard let win = key.window else {
        reply["tree"] = NSNull(); reply["truncated"] = false; reply["reason"] = NSNull(); reply["nodeCount"] = 0; reply["elapsedMs"] = elapsedMs()
        emit(reply)
    }
    var walk = Walk(maxNodes: Int(opts["max-nodes"] ?? "") ?? 3000, maxDepth: Int(opts["max-depth"] ?? "") ?? 12)
    let root = buildNode(win, 0, &walk)
    // Out of time before even the window itself was read: that is a timeout, not an empty window.
    if root == nil && walk.cut == "time" { fail("timeout", "ran out of time before reading the window") }
    reply["tree"] = root ?? NSNull()
    reply["truncated"] = walk.cut != nil
    reply["reason"] = walk.cut ?? NSNull()
    reply["nodeCount"] = walk.nodes
    reply["window"] = ["source": key.source]
    reply["elapsedMs"] = elapsedMs()
    emit(reply)
}

func cmdFind() -> Never {
    requireUsableSession()
    let app = targetApplication()
    let aim = currentAim()
    let limit = Int(opts["max-results"] ?? "") ?? 200
    var hits: [Hit] = []
    let idOnly = aim.id != nil && aim.name == nil && aim.role == nil
    for w in windowsToSearch(app) where !timeUp() && hits.count < limit {
        search(w, aim, maxDepth: 12, limit: limit * 4, stopAtExactId: idOnly, into: &hits)
        if idOnly && hits.contains(where: { $0.exact }) { break }
    }
    if hits.isEmpty && timeUp() { fail("timeout", "the element search ran out of time") }
    let ranked = rankHits(hits, action: nil).prefix(limit)
    emit(["ok": true, "elements": ranked.map { hitDict($0, pid: app.processIdentifier) }, "truncated": timeUp(), "elapsedMs": elapsedMs()])
}

func cmdInvoke() -> Never {
    requireUsableSession()
    guard let action = opts["action"], !action.isEmpty else { emit(miss("", "invoke needs --action")) }
    let aim = currentAim()
    // With nothing to aim at every element matches and "best" is arbitrary — never act on that.
    if aim.isEmpty { emit(miss(action, "invoke needs a name, role or id to aim at — refusing to act on an arbitrary element")) }
    let app = targetApplication()
    var hits: [Hit] = []
    for w in windowsToSearch(app) where !timeUp() {
        search(w, aim, maxDepth: 12, limit: 60, into: &hits)
        if hits.contains(where: { $0.exact }) { break }
    }
    guard let best = rankHits(hits, action: action).first else {
        if timeUp() { fail("timeout", "the element search ran out of time") }
        var what = ""
        if let n = aim.name { what += "name=\"\(n)\" " }
        if let r = aim.role { what += "role=\"\(r)\" " }
        if let i = aim.id { what += "id=\"\(i)\" " }
        emit(miss(action, "Element not found: \(what.trimmingCharacters(in: .whitespaces))"))
    }
    emit(perform(action, best))
}

switch command {
case "frontmost": cmdFrontmost()
case "windows": cmdWindows()
case "active": cmdActive()
case "apps": cmdApps()
case "tree": cmdTree()
case "find": cmdFind()
case "invoke": cmdInvoke()
default: fail("failed", "usage: ax-helper windows|active|frontmost|apps|tree|find|invoke [options] (got \"\(command)\")")
}
