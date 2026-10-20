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
//   ax-helper focused   [--pid N] [--timeout-ms N]
//   ax-helper tree      [--pid N] [--max-depth N] [--max-nodes N] [--timeout-ms N]
//   ax-helper find      [--pid N] [--name S] [--role R] [--id S] [--max-results N] [--timeout-ms N]
//   ax-helper invoke    [--pid N] --action A [--name S] [--role R] [--id S] [--value V] [--timeout-ms N]
//   ax-helper type      --text S [--timeout-ms N]   (types into whatever has the keyboard; send --text via --args-stdin)
//   (every command also takes --ax-timeout-ms N: how long ONE call to ONE app may block, and
//    --args-stdin 1: read name / id / value / … as one JSON object of strings from stdin instead of argv — argv is
//    readable by every process on the Mac while this one runs)
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
            // Every option takes a value, and a value may itself start with "--" ("--- notes", "--force"): the next token is the value.
            let key = String(a.dropFirst(2))
            if i + 1 < argv.count { opts[key] = argv[i + 1]; i += 2 } else { opts[key] = ""; i += 1 }
        } else { i += 1 }
    }
}

// --args-stdin 1: what the caller typed or searches for (name, id, value) arrives as ONE JSON object on stdin. Anything that
// is not a string is ignored; unreadable input is a failed reply, never a guess.
if opts["args-stdin"] != nil {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        fail("failed", "--args-stdin: stdin is not a JSON object")
    }
    for (key, value) in object { if let text = value as? String { opts[key] = text } }
}

let startedAt = Date()
let budgetMs = Int(opts["timeout-ms"] ?? "") ?? 8000
let deadline = startedAt.addingTimeInterval(Double(budgetMs) / 1000)
func timeUp() -> Bool { Date() >= deadline }
func elapsedMs() -> Int { Int(Date().timeIntervalSince(startedAt) * 1000) }
/// One call to one app may block this long (the AX default is 6 s — a single hung app would eat the whole budget).
let axTimeout: Float = Float(Double(opts["ax-timeout-ms"] ?? "") ?? 1500) / 1000
// AXUIElementSetMessagingTimeout on an app element covers THAT element only ("not … other accessibility objects"), so a
// limit set per app never reached its windows and descendants — they kept the OS default (1.5 s here, 6 s on older macOS).
// The system-wide element sets it for every call this process makes.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), axTimeout)
let ownPid = getpid()
/// clawdcursor's own windows are never "the active window". The overlay is cached as clawd-overlay-<hash>.
func isOwnProcessName(_ name: String) -> Bool {
    name.hasPrefix("clawd-overlay") || name == "ClawdCursorHost" || name == "ClawdCursor"
}

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

/// Several attributes in ONE round trip. Missing attributes are simply absent; `error` says whether the whole read failed
/// (an element that answers nothing — hung, or gone — is not an element with no attributes).
func multiChecked(_ el: AXUIElement, _ names: [String]) -> (values: [String: CFTypeRef], error: AXError) {
    var out: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
    guard err == .success, let arr = out as? [AnyObject] else { return ([:], err == .success ? .failure : err) }
    var d: [String: CFTypeRef] = [:]
    for (i, v) in arr.enumerated() where i < names.count {
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
        d[names[i]] = v
    }
    return (d, .success)
}

func multi(_ el: AXUIElement, _ names: [String]) -> [String: CFTypeRef] { multiChecked(el, names).values }

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

/// Frames can be absurd (CGRectInfinite): Int(x.rounded()) would trap past Int.max, so clamp to what any screen could hold.
func finite(_ x: CGFloat) -> Int { x.isFinite ? Int(max(-1_000_000, min(1_000_000, x)).rounded()) : 0 }

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

/// Real apps announce themselves ("finished launching") within moments. WebKit's Web Content / Networking
/// processes (XPC services) and Electron's renderer helpers never do, never answer accessibility queries, and
/// System Events never listed them — reading them only costs a full timeout each and adds "not responding" noise.
/// `allowLaunching` keeps an app that started in the last 30 s: the launch check wants to see that one coming up.
func isRealApp(_ app: NSRunningApplication, allowLaunching: Bool) -> Bool {
    if app.bundleURL?.pathExtension == "xpc" { return false }
    if app.isFinishedLaunching { return true }
    guard allowLaunching, let started = app.launchDate else { return false }
    return Date().timeIntervalSince(started) < 30
}

/// clawdcursor's own processes (the overlay, cached as clawd-overlay-<hash>, and the native host) are not apps to list or drive.
func candidateApps(allowLaunching: Bool = false) -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        !$0.isTerminated && $0.activationPolicy != .prohibited && $0.processIdentifier != ownPid
            && !isOwnProcessName($0.localizedName ?? "") && isRealApp($0, allowLaunching: allowLaunching)
    }
}

/// The topmost window of an ordinary app, front to back — the answer when our own overlay holds NSWorkspace's "frontmost".
func topmostRegularApp() -> NSRunningApplication? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != ownPid,
              let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular,
              !isOwnProcessName(app.localizedName ?? "") else { continue }
        return app
    }
    return nil
}

/// NSWorkspace's frontmost application (which, unlike System Events, includes system dialogs).
func activeApplication() -> NSRunningApplication? {
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    if isOwnProcessName(front.localizedName ?? "") { return topmostRegularApp() ?? front }
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
/// untitled helper panels menu-bar apps keep around. An accessory (menu-bar / system UI) app
/// only counts with a real window or a dialog: Notification Center keeps desktop widgets and a
/// full-screen overlay that are windows to the AX API but not something to drive.
func worthListing(_ w: [String: Any], _ app: NSRunningApplication) -> Bool {
    let sub = (w["subrole"] as? String) ?? ""
    let realWindow = ["AXStandardWindow", "AXDialog", "AXSystemDialog"].contains(sub)
    if app.activationPolicy != .regular && !realWindow { return false }
    if !((w["title"] as? String) ?? "").isEmpty { return true }
    let b = w["bounds"] as? [String: Int] ?? [:]
    return realWindow && (b["width"] ?? 0) >= 40 && (b["height"] ?? 0) >= 40
}

/// How one app read went. A call that waited out the whole messaging timeout means the app is hung (`unresponsive`). Running
/// out of the overall time budget is NOT that: it leaves an app unread (never reached) or `partial` (cut short) — a sign the
/// Mac was slow, not that anything is wrong with the app.
enum AppRead { case windows([[String: Any]]), partial([[String: Any]]), unresponsive }

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
        if timeUp() { return .partial(out) }
        let t1 = Date()
        let d = windowDict(w, app)
        // Answered the list, then took a whole messaging timeout on one window: it is stalling.
        if Date().timeIntervalSince(t1) >= Double(axTimeout) * 0.8 { return .unresponsive }
        out.append(d)
    }
    return .windows(out)
}

struct AppReads {
    /// Windows read, by pid.
    var windows: [Int: [[String: Any]]] = [:]
    /// Apps that waited out a whole messaging timeout: hung.
    var unresponsive: [[String: Any]] = []
    /// Apps the time budget never reached, or cut short. Nothing is wrong with them — the list is just incomplete.
    var skipped: [[String: Any]] = []
}

/// Fan out across apps: one hung app costs its own timeout, not everyone's.
func readAllApps(_ apps: [NSRunningApplication]) -> AppReads {
    let lock = NSLock()
    var reads = AppReads()
    DispatchQueue.concurrentPerform(iterations: apps.count) { i in
        let app = apps[i]
        let who: [String: Any] = ["processId": Int(app.processIdentifier), "processName": app.localizedName ?? "unknown"]
        if timeUp() {
            lock.lock(); reads.skipped.append(who); lock.unlock()
            return
        }
        let read = readWindows(of: app)
        lock.lock()
        switch read {
        case .windows(let ws): reads.windows[Int(app.processIdentifier)] = ws
        case .partial(let ws): reads.windows[Int(app.processIdentifier)] = ws; reads.skipped.append(who)
        case .unresponsive: reads.unresponsive.append(who)
        }
        lock.unlock()
    }
    return reads
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
    /// Elements that answered nothing (a hung subtree): the tree is real but incomplete.
    var unreadable = 0
    /// Set when the window itself could not be read — there is no tree to return.
    var rootError: AXError? = nil
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

    let (a, readError) = multiChecked(el, nodeAttrs)
    if readError != .success {
        if depth == 0 { w.rootError = readError } else { w.unreadable += 1 }
        return nil
    }
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
    // The text on the control beats its identifier as a name: that is what an agent matches against what it sees.
    if name.isEmpty && labelPeekRoles.contains(role) { name = firstStaticTextValue(kids) }

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
    // A name of only spaces is no name: it would substring-match the shallowest control whose label has a space in it.
    func nonEmpty(_ k: String) -> String? { if let v = opts[k], !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return v }; return nil }
    return Aim(name: nonEmpty("name"), role: nonEmpty("role"), id: nonEmpty("id"))
}

let searchAttrs = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXIdentifier", "AXChildren"]

/// Identifiers are compared byte for byte. Swift's `==` calls canonically equivalent strings equal (NFC "é" and NFD "e" + U+0301),
/// while the caller's own `===` does not: such an id would be found here and dropped there.
func sameId(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

/// What a search collected, and how much of the window it could not read.
struct SearchCtx {
    var hits: [Hit] = []
    /// Elements that answered nothing. A name that is absent from what WAS read may be hiding there.
    var unreadable = 0
}

/// Breadth-first search of one window: shallow matches first, one batched read per element.
func search(_ root: AXUIElement, _ aim: Aim, maxDepth: Int, limit: Int, stopAtExactId: Bool = false, ctx: inout SearchCtx) {
    let wantName = aim.name?.lowercased()
    let wantRole = aim.role.map(normRole)
    var level: [AXUIElement] = [root]
    var depth = 0
    while !level.isEmpty && depth <= maxDepth && !timeUp() && ctx.hits.count < limit {
        var next: [AXUIElement] = []
        for el in level {
            if timeUp() || ctx.hits.count >= limit { break }
            let (a, readError) = multiChecked(el, searchAttrs)
            if readError != .success { ctx.unreadable += 1; continue }
            let role = str(a["AXRole"]) ?? ""
            let title = str(a["AXTitle"]) ?? ""
            let desc = str(a["AXDescription"]) ?? ""
            let ident = str(a["AXIdentifier"]) ?? ""
            // A control the tree shows as Button "Save" (its text is a child) must be findable by that name too.
            var label = ""
            if wantName != nil && title.isEmpty && desc.isEmpty && labelPeekRoles.contains(role), let kids = a["AXChildren"] as? [AXUIElement] {
                label = firstStaticTextValue(kids)
            }
            var matches = !role.isEmpty
            var exact = false
            if let w = wantName {
                let tl = title.lowercased(), dl = desc.lowercased(), il = ident.lowercased(), ll = label.lowercased()
                matches = matches && (tl.contains(w) || dl.contains(w) || il.contains(w) || ll.contains(w))
                exact = tl == w || dl == w || il == w || ll == w
            }
            if let id = aim.id {
                // An identifier is exact, case included: find_element filters this reply with === afterwards, so a looser
                // match here would be found and then silently dropped ("savebutton" finding "SaveButton" and printing nothing).
                matches = matches && sameId(ident, id)
                exact = exact || sameId(ident, id)
            }
            if let r = wantRole { matches = matches && normRole(role).contains(r) }
            if matches {
                ctx.hits.append(Hit(element: el, name: !title.isEmpty ? title : (!desc.isEmpty ? desc : label), title: title, desc: desc, ident: ident, role: role,
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

/// Every window of the app, the key window first. `hung`: the app did not answer at all (not "it has no windows").
func windowsToSearch(_ app: NSRunningApplication) -> (windows: [AXUIElement], hung: Bool) {
    let el = appElement(app.processIdentifier)
    var out: [AXUIElement] = []
    let key = keyWindow(el)
    if let k = key.window { out.append(k) }
    if let all = copyAttr(el, "AXWindows").value as? [AXUIElement] {
        for w in all where !out.contains(where: { CFEqual($0, w) }) { out.append(w) }
    }
    return (out, key.hung)
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

/// The helper declined to act and touched nothing — as opposed to trying and failing. Callers that fall back to guessing (a
/// keyboard heuristic that picks the widest field) must not route around it.
func refuse(_ action: String, _ message: String) -> [String: Any] {
    var r = miss(action, message)
    r["refused"] = true
    return r
}

func settable(_ el: AXUIElement, _ attr: String) -> Bool {
    var s: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(el, attr as CFString, &s) == .success && s.boolValue
}

/// AXUIElementPerformAction. The SDK: kAXErrorCannotComplete "does not necessarily mean that the function has failed" — an
/// action that runs a modal loop (a button that opens a panel or an alert) does not return before the timeout. After a full
/// timeout it was started and is still running: report it as pending, not as a failure to click (callers click again).
///
/// A full timeout also looks like that when the app froze in the middle of the action. The two differ in what happens next: a
/// modal loop keeps answering accessibility requests, a frozen app answers nothing. So after a full timeout, one cheap read of
/// the same element: a second full timeout means `hung`.
func press(_ el: AXUIElement, _ action: String = "AXPress") -> (done: Bool, pending: Bool, hung: Bool, code: Int32) {
    let t0 = Date()
    let r = AXUIElementPerformAction(el, action as CFString)
    if r == .success { return (true, false, false, 0) }
    if r == .cannotComplete && Date().timeIntervalSince(t0) >= Double(axTimeout) * 0.8 {
        let t1 = Date()
        let (_, probe) = copyAttr(el, "AXRole")
        let hung = probe == .cannotComplete && Date().timeIntervalSince(t1) >= Double(axTimeout) * 0.8
        return (!hung, !hung, hung, r.rawValue)
    }
    return (false, false, false, r.rawValue)
}

/// The app stopped answering while an action ran: whether the action happened is not known, and neither "pending" nor
/// "could not click" would be true.
func hungDuringAction(_ action: String, _ appName: String) -> Never {
    // `acted`: the only timeout that may have changed something. A timeout while still searching did nothing.
    emit(["ok": false, "kind": "timeout", "acted": true,
          "error": "\(appName) stopped responding while the \(action) was running — it may or may not have been performed"])
}

func pressed(_ action: String, method: String, pending: Bool, extra: [String: Any] = [:]) -> [String: Any] {
    var d = extra
    if pending { d["pending"] = true }
    var r: [String: Any] = ["ok": true, "success": true, "action": action, "method": method]
    if !d.isEmpty { r["data"] = d }
    return r
}

/// A label inside a selectable row. SwiftUI sidebars (System Settings) accept AXPress on the label's text and do nothing: the
/// selection lives on the ROW. Returns that row — only when it can be selected — or nil for any other element.
func selectableRowAbove(_ el: AXUIElement) -> AXUIElement? {
    guard let role = str(copyAttr(el, "AXRole").value), ["AXStaticText", "AXImage", "AXGroup", "AXCell"].contains(role) else { return nil }
    var cur = el
    for _ in 0..<4 {
        guard let p = copyAttr(cur, "AXParent").value, isElement(p) else { return nil }
        let parent = p as! AXUIElement
        if str(copyAttr(parent, "AXRole").value) == "AXRow" { return settable(parent, "AXSelected") ? parent : nil }
        cur = parent
    }
    return nil
}

/// Select the row and check that it took: the effect, not the call, is the answer. A press that "succeeded" on the label and
/// changed nothing was reported as a click; now a selection that did not happen is a miss, and the caller clicks coordinates.
func selectRow(_ row: AXUIElement, action: String) -> [String: Any] {
    if bool(copyAttr(row, "AXSelected").value) == true { return pressed(action, method: "AXSelected", pending: false, extra: ["alreadySelected": true]) }
    AXUIElementSetAttributeValue(row, "AXSelected" as CFString, kCFBooleanTrue)
    for _ in 0..<6 {
        Thread.sleep(forTimeInterval: 0.05)
        if bool(copyAttr(row, "AXSelected").value) == true { return pressed(action, method: "AXSelected", pending: false) }
    }
    return miss(action, "selecting the row did not take effect — click its coordinates instead", element: row)
}

func perform(_ action: String, _ h: Hit, appName: String) -> [String: Any] {
    let el = h.element
    switch action {
    case "click":
        if let row = selectableRowAbove(el) { return selectRow(row, action: action) }
        let p = press(el)
        if p.hung { hungDuringAction(action, appName) }
        if p.done { return pressed(action, method: "AXPress", pending: p.pending) }
        return miss(action, "the element does not support AXPress (AXError \(p.code)) — click its coordinates instead", element: el)
    case "focus":
        let r = AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
        return r == .success ? ["ok": true, "success": true, "action": action] : miss(action, "could not focus the element (AXError \(r.rawValue))", element: el)
    case "set-value":
        guard let v = opts["value"] else { return miss(action, "set-value needs --value") }
        if h.subrole == "AXSecureTextField" { return refuse(action, "refusing to write to a secure text field") }
        if !settable(el, "AXValue") { return miss(action, "the element's value is not settable", element: el) }
        let r = AXUIElementSetAttributeValue(el, "AXValue" as CFString, v as CFString)
        return r == .success ? ["ok": true, "success": true, "action": action, "method": "AXValue", "value": v] : miss(action, "could not set the value (AXError \(r.rawValue))", element: el)
    case "get-value":
        if h.subrole == "AXSecureTextField" { return refuse(action, "the element is a secure text field — its value is withheld") }
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
        if want {
            let p = press(el, "AXShowMenu")
            if p.hung { hungDuringAction(action, appName) }
            if p.done { return pressed(action, method: "AXShowMenu", pending: p.pending) }
        }
        return miss(action, "the element does not support \(action) (no AXExpanded)", element: el)
    case "toggle":
        let p = press(el)
        if p.hung { hungDuringAction(action, appName) }
        if !p.done { return miss(action, "the element does not support toggle (no AXPress; AXError \(p.code))", element: el) }
        if p.pending { return pressed(action, method: "AXPress", pending: true, extra: ["toggleState": "unknown"]) }
        Thread.sleep(forTimeInterval: 0.05)
        let after = str(copyAttr(el, "AXValue").value)
        let state = after == nil ? "unknown" : (after == "0" ? "Off" : "On")
        return ["ok": true, "success": true, "action": action, "method": "AXPress", "data": ["toggleState": state]]
    case "select":
        if let row = selectableRowAbove(el) { return selectRow(row, action: action) }
        if settable(el, "AXSelected"), AXUIElementSetAttributeValue(el, "AXSelected" as CFString, kCFBooleanTrue) == .success {
            return ["ok": true, "success": true, "action": action, "method": "AXSelected"]
        }
        let p = press(el)
        if p.hung { hungDuringAction(action, appName) }
        if p.done { return pressed(action, method: "AXPress", pending: p.pending) }
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
    let reads = readAllApps(apps)
    var windows: [[String: Any]] = []
    for app in apps {
        for w in reads.windows[Int(app.processIdentifier)] ?? [] where worthListing(w, app) {
            var d = w
            d.removeValue(forKey: "subrole")
            windows.append(d)
        }
    }
    emit(["ok": true, "windows": windows, "unresponsive": reads.unresponsive, "skipped": reads.skipped,
          "truncated": !reads.skipped.isEmpty, "elapsedMs": elapsedMs()])
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
    let apps = candidateApps(allowLaunching: true).filter { want.isEmpty || appNames($0).contains { $0.contains(want) } }
    let reads = readAllApps(apps)
    var out: [[String: Any]] = []
    for app in apps {
        var d: [String: Any] = [
            "name": app.localizedName ?? "unknown",
            "processId": Int(app.processIdentifier),
            "finishedLaunching": app.isFinishedLaunching,
            "active": app.isActive,
            "activationPolicy": policyName(app),
            "windows": (reads.windows[Int(app.processIdentifier)] ?? []).filter { worthListing($0, app) }.map { w -> [String: Any] in
                var x = w; x.removeValue(forKey: "subrole"); return x
            },
        ]
        if let b = app.bundleIdentifier { d["bundleId"] = b }
        if let t = app.launchDate { d["launchDate"] = t.timeIntervalSince1970 }
        out.append(d)
    }
    emit(["ok": true, "apps": out, "unresponsive": reads.unresponsive, "skipped": reads.skipped,
          "truncated": !reads.skipped.isEmpty, "elapsedMs": elapsedMs()])
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
    // The window itself unreadable (hung, or gone): an error, not an empty window.
    if let e = walk.rootError {
        fail(e == .cannotComplete ? "timeout" : "failed", "could not read the window of \(app.localizedName ?? "the app") (AXError \(e.rawValue))")
    }
    // Out of time before even the window itself was read: that is a timeout, not an empty window.
    if root == nil && walk.cut == "time" { fail("timeout", "ran out of time before reading the window") }
    reply["tree"] = root ?? NSNull()
    reply["truncated"] = walk.cut != nil || walk.unreadable > 0
    reply["reason"] = walk.cut ?? (walk.unreadable > 0 ? "unreadable" : NSNull())
    reply["unreadable"] = walk.unreadable
    reply["nodeCount"] = walk.nodes
    reply["window"] = ["source": key.source]
    reply["elapsedMs"] = elapsedMs()
    emit(reply)
}

func cmdFocused() -> Never {
    requireUsableSession()
    let app = targetApplication()
    let appEl = appElement(app.processIdentifier)
    guard let focused = copyAttr(appEl, "AXFocusedUIElement").value, isElement(focused) else {
        emit(["ok": true, "focused": NSNull(), "elapsedMs": elapsedMs()])
    }
    let el = focused as! AXUIElement
    let a = multi(el, ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXIdentifier", "AXValue", "AXPosition", "AXSize", "AXEnabled"])
    let secure = str(a["AXSubrole"]) == "AXSecureTextField"
    let title = str(a["AXTitle"]) ?? ""
    var d: [String: Any] = [
        "name": title.isEmpty ? (str(a["AXDescription"]) ?? "") : title,
        "automationId": str(a["AXIdentifier"]) ?? "",
        "controlType": str(a["AXRole"]) ?? "",
        "bounds": rect(axPoint(a["AXPosition"]), axSize(a["AXSize"])),
        "processId": Int(app.processIdentifier),
    ]
    if secure { d["secure"] = true } else if let v = str(a["AXValue"]), !v.isEmpty { d["value"] = String(v.prefix(500)) }
    if bool(a["AXEnabled"]) == false { d["enabled"] = false }
    emit(["ok": true, "focused": d, "elapsedMs": elapsedMs()])
}

func cmdFind() -> Never {
    requireUsableSession()
    let app = targetApplication()
    let aim = currentAim()
    let limit = Int(opts["max-results"] ?? "") ?? 200
    let idOnly = aim.id != nil && aim.name == nil && aim.role == nil
    var found = SearchCtx()
    let (windows, hung) = windowsToSearch(app)
    if hung { fail("timeout", "\(app.localizedName ?? "the app") is not responding") }
    for w in windows where !timeUp() && found.hits.count < limit {
        search(w, aim, maxDepth: 12, limit: limit * 4, stopAtExactId: idOnly, ctx: &found)
        if idOnly && found.hits.contains(where: { $0.exact }) { break }
    }
    if found.hits.isEmpty && timeUp() {
        fail("timeout", "the element search ran out of time before it had read the whole window (\(found.unreadable) element(s) did not answer) — not \"nothing found\"")
    }
    if found.hits.isEmpty && found.unreadable > 0 {
        fail("partial", "not found in the readable part of the window (\(found.unreadable) element\(found.unreadable == 1 ? "" : "s") did not answer)")
    }
    let ranked = rankHits(found.hits, action: nil).prefix(limit)
    emit(["ok": true, "elements": ranked.map { hitDict($0, pid: app.processIdentifier) }, "truncated": timeUp() || found.unreadable > 0, "elapsedMs": elapsedMs()])
}

/// Actions that press or change something. Aimed at a role alone ("Button") they would act on whichever match ranks first —
/// the shallowest button in the window.
let pressingActions: Set<String> = ["click", "toggle", "select", "expand", "collapse"]

/// What an agent can do when the helper declines to act on an incomplete read.
let wayForward = " — read the tree (accessibility read_tree), then click the element's centre with computer click space:\"screen\""

func cmdInvoke() -> Never {
    requireUsableSession()
    guard let action = opts["action"], !action.isEmpty else { emit(miss("", "invoke needs --action")) }
    let aim = currentAim()
    // With nothing to aim at every element matches and "best" is arbitrary — never act on that.
    if aim.isEmpty { emit(refuse(action, "invoke needs a name, role or id to aim at — refusing to act on an arbitrary element")) }
    // A role is something, but not enough to press: there is rarely only one button.
    let byRoleOnly = aim.name == nil && aim.id == nil
    if byRoleOnly && pressingActions.contains(action) {
        let role = aim.role ?? ""
        emit(refuse(action, "\(action) needs a name or id to aim at — role=\"\(role)\" alone would act on whichever \(role) comes first"))
    }
    let app = targetApplication()
    var found = SearchCtx()
    let (windows, hung) = windowsToSearch(app)
    if hung { fail("timeout", "\(app.localizedName ?? "the app") is not responding") }
    for w in windows where !timeUp() {
        search(w, aim, maxDepth: 12, limit: 400, ctx: &found)
        if found.hits.contains(where: { $0.exact }) { break }
    }
    guard let best = rankHits(found.hits, action: action).first else {
        if timeUp() || found.unreadable > 0 { fail("timeout", "the element search could not read part of the window — not \"Element not found\"") }
        var what = ""
        if let n = aim.name { what += "name=\"\(n)\" " }
        if let r = aim.role { what += "role=\"\(r)\" " }
        if let i = aim.id { what += "id=\"\(i)\" " }
        emit(miss(action, "Element not found: \(what.trimmingCharacters(in: .whitespaces))"))
    }
    // Aimed at a role alone (set-value / focus / get-value), the role must pick exactly one element.
    if byRoleOnly {
        if found.hits.count > 1 {
            let ranked = rankHits(found.hits, action: action)
            let who = ranked.prefix(6).map { h -> String in
                let label = h.name.isEmpty ? h.ident : h.name
                return "\"\(label)\"" + (!h.name.isEmpty && !h.ident.isEmpty ? " (id \(h.ident))" : "")
            }.joined(separator: ", ")
            emit(refuse(action, "role=\"\(aim.role ?? "")\" matches \(found.hits.count) elements — \(who)\(ranked.count > 6 ? ", …" : "") — add a name or id to pick one"))
        }
        if timeUp() || found.unreadable > 0 {
            fail("timeout", "the search could not read the whole window (\(found.unreadable) element(s) did not answer) — cannot tell that only one element has this role\(wayForward)")
        }
    }
    // A name that is only a substring of the best hit ("Save As…" for "Save") may be hiding its exact match in the part of the
    // window that did not answer or past the deadline: acting on that would press the wrong control.
    if !best.exact && (aim.name != nil || aim.id != nil) && (timeUp() || found.unreadable > 0) {
        fail("timeout", "the search could not read the whole window (\(found.unreadable) element(s) did not answer) — refusing to act on a partial match (\"\(best.name.isEmpty ? best.ident : best.name)\")\(wayForward)")
    }
    emit(perform(action, best, appName: app.localizedName ?? "the app"))
}

// MARK: - type

/// Types `text` into whatever has the keyboard, one character per key event, with the character itself attached to the event
/// (CGEventKeyboardSetUnicodeString). System Events' `keystroke` maps each character to a key of the current layout and
/// types key code 0 ("a") for any it cannot find, so "café 日本語" came out as "cafa aaa" (#242). Newline and tab are sent as
/// the Return and Tab keys, which is what a text field expects.
/// Bring one window of ONE process to the front, by pid. System Events names an app's windows by process NAME, so with two
/// processes of one app (the user's Chrome and the agent's own) focus-window.jxa read the first one's windows: it raised the
/// wrong window while saying "focused", and found no window for a title the other process had. This talks to the process it
/// was given, looks a title up among ITS windows only, and checks who really is frontmost afterwards.
/// A focus never changes a window's size, position, zoom or full-screen state; it only clears AXMinimized.
func cmdFocus() -> Never {
    requireUsableSession()
    guard opts["pid"] != nil else { fail("failed", "focus: no --pid given") }
    let app = targetApplication()
    let name = app.localizedName ?? "unknown"
    let pid = app.processIdentifier
    let el = appElement(pid)
    let t0 = Date()
    let (value, err) = copyAttr(el, "AXWindows")
    if err == .cannotComplete && Date().timeIntervalSince(t0) >= Double(axTimeout) * 0.8 { fail("timeout", "\(name) is not responding") }
    let windows = (value as? [AXUIElement]) ?? []
    let wanted = opts["title"] ?? ""
    let needle = wanted.lowercased()

    var target: AXUIElement? = nil
    var best = Int.min
    for w in windows {
        let a = multi(w, windowAttrs)
        let size = axSize(a["AXSize"]) ?? .zero
        if size.width * size.height <= 0 { continue }                      // not a window that can be raised
        let title = str(a["AXTitle"]) ?? ""
        if !needle.isEmpty {
            if title.lowercased().contains(needle) { target = w; break }
            continue
        }
        // No title: the window to work in — a standard window beats a popover, an on-screen one beats a minimized one.
        var score = Int(size.width * size.height)
        if bool(a["AXMinimized"]) == true { score -= 100_000_000 }
        switch str(a["AXSubrole"]) ?? "" {
        case "AXStandardWindow": score += 2_000_000
        case "AXFloatingWindow": score -= 5_000_000
        case "AXDialog", "AXSystemDialog": score -= 3_000_000
        default: break
        }
        if ["downloads", "notifications", "updates", "inspector", "activity"].contains(title.trimmingCharacters(in: .whitespaces).lowercased()) { score -= 1_500_000 }
        if score > best { best = score; target = w }
    }
    if target == nil && !needle.isEmpty {
        fail("failed", "\(name) (pid \(pid)) has no window with a title containing \"\(wanted)\"")
    }

    // A minimized window cannot take focus; clearing AXMinimized puts it back exactly as it was.
    if let w = target, bool(copyAttr(w, "AXMinimized").value) == true {
        AXUIElementSetAttributeValue(w, "AXMinimized" as CFString, kCFBooleanFalse)
    }
    // Frontmost through the accessibility API: it needs no activation handshake from a background process.
    AXUIElementSetAttributeValue(el, "AXFrontmost" as CFString, kCFBooleanTrue)
    if let w = target {
        AXUIElementPerformAction(w, "AXRaise" as CFString)
        AXUIElementSetAttributeValue(w, "AXMain" as CFString, kCFBooleanTrue)
    }
    func frontmostPid() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    func waitFront(_ tenths: Int) { var n = 0; while frontmostPid() != pid && n < tenths { usleep(100_000); n += 1 } }
    waitFront(8)
    if frontmostPid() != pid {
        if #available(macOS 14.0, *) { app.activate() } else { app.activate(options: [.activateIgnoringOtherApps]) }
        waitFront(5)
    }
    if let now = NSWorkspace.shared.frontmostApplication, now.processIdentifier != pid {
        fail("failed", "focus went to \(now.localizedName ?? "another app") (pid \(now.processIdentifier)), not to \(name) (pid \(pid))")
    }
    var d: [String: Any] = target.map { windowDict($0, app) }
        ?? ["title": "", "processName": name, "processId": Int(pid), "bounds": rect(nil, nil), "isMinimized": false, "subrole": ""]
    d.removeValue(forKey: "isMinimized")
    d["ok"] = true
    d["success"] = true
    d["elapsedMs"] = elapsedMs()
    emit(d)
}

func cmdType() -> Never {
    requireUsableSession()
    guard let text = opts["text"], !text.isEmpty else { fail("failed", "type: no text given") }
    if #available(macOS 10.15, *), !CGPreflightPostEventAccess() {
        fail("permission", "the app running clawdcursor may not post keyboard events (System Settings → Privacy & Security → Accessibility)")
    }
    let source = CGEventSource(stateID: .hidSystemState)
    func post(_ code: CGKeyCode, _ units: [UniChar]?) {
        for down in [true, false] {
            guard let ev = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            ev.flags = []   // a modifier the user happens to hold must not turn "a" into ⌘A
            if var u = units { ev.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u) }
            ev.post(tap: .cghidEventTap)
        }
        usleep(4_000)   // apps drop key events that arrive faster than they are read
    }
    let total = text.count
    var typed = 0
    for ch in text {
        if timeUp() {
            // `acted` when some of the text is already in the target: a caller that retries blind would type it twice. Out of
            // time before the first key, nothing was typed and a retry is safe.
            let partial = typed > 0
            var reply: [String: Any] = ["ok": false, "kind": "timeout",
                "error": "typed \(typed) of \(total) characters before the deadline" + (partial ? " — those \(typed) are already in the target" : "")]
            if partial { reply["acted"] = true }
            emit(reply)
        }
        switch ch {
        case "\n", "\r", "\r\n": post(36, nil)   // Return
        case "\t": post(48, nil)                 // Tab
        default: post(0, Array(String(ch).utf16))
        }
        typed += 1
    }
    emit(["ok": true, "typed": typed])
}

// MARK: - pagetext

/// The whole text of the frontmost app's document — what VoiceOver reads — with no keystrokes: nothing is selected and
/// the clipboard is not touched (copy_all_text pressed Cmd+A / Cmd+C, which left the page highlighted). An editor with the
/// focus (AXTextArea): its value. A web page (AXWebArea holding the focus): AXStringForTextMarkerRange over the whole area.
/// A password field is never read.
func cmdPageText() -> Never {
    requireUsableSession()
    let app = targetApplication()
    let appEl = appElement(app.processIdentifier)
    let maxChars = Int(opts["max-chars"] ?? "") ?? 2_000_000
    let focusedRef = copyAttr(appEl, "AXFocusedUIElement").value
    let focused: AXUIElement? = focusedRef.flatMap { isElement($0) ? ($0 as! AXUIElement) : nil }
    // The page first, as on Windows and Linux: a text box on a web page (a comment box, a compose field) is part of the
    // page, so its draft alone is not the page's text.
    var web: AXUIElement? = nil
    var cur: AXUIElement? = focused
    var hops = 0
    while let c = cur, hops < 60, !timeUp() {
        if str(copyAttr(c, "AXRole").value) == "AXWebArea" { web = c; break }
        guard let p = copyAttr(c, "AXParent").value, isElement(p) else { break }
        cur = (p as! AXUIElement)
        hops += 1
    }
    // A native editor (TextEdit, Notes): its text is the document.
    if web == nil, let f = focused {
        let a = multi(f, ["AXRole", "AXSubrole", "AXValue"])
        if str(a["AXRole"]) == "AXTextArea", str(a["AXSubrole"]) != "AXSecureTextField",
           let v = str(a["AXValue"]), !v.isEmpty {
            emit(["ok": true, "text": String(v.prefix(maxChars)), "source": "AXTextArea", "elapsedMs": elapsedMs()])
        }
    }
    // The focus is outside the page (the address bar, a toolbar): the window's first web page.
    if web == nil, let win = keyWindow(appEl).window {
        var queue: [AXUIElement] = [win]
        var seen = 0
        while !queue.isEmpty, seen < 1500, !timeUp() {
            let el = queue.removeFirst()
            seen += 1
            let a = multi(el, ["AXRole", "AXChildren"])
            if str(a["AXRole"]) == "AXWebArea" { web = el; break }
            if let kids = a["AXChildren"] as? [AXUIElement] { queue.append(contentsOf: kids) }
        }
    }
    guard let area = web else { fail("failed", "no web page or text document has the focus") }
    var range: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(area, "AXTextMarkerRangeForUIElement" as CFString, area, &range) == .success,
          let markers = range else {
        fail("failed", "the page does not expose its text range")
    }
    var out: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(area, "AXStringForTextMarkerRange" as CFString, markers, &out) == .success,
          let text = out as? String, !text.isEmpty else {
        fail("failed", "the page did not return its text")
    }
    emit(["ok": true, "text": String(text.prefix(maxChars)), "source": "AXWebArea", "elapsedMs": elapsedMs()])
}

switch command {
case "frontmost": cmdFrontmost()
case "windows": cmdWindows()
case "active": cmdActive()
case "apps": cmdApps()
case "focused": cmdFocused()
case "tree": cmdTree()
case "find": cmdFind()
case "invoke": cmdInvoke()
case "type": cmdType()
case "focus": cmdFocus()
case "pagetext": cmdPageText()
default: fail("failed", "usage: ax-helper windows|active|frontmost|apps|focused|tree|find|invoke|type|focus|pagetext [options] (got \"\(command)\")")
}
