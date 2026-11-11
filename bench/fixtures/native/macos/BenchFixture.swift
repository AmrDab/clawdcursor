// The native benchmark fixture for macOS: a small AppKit app that writes its own state to a JSON file.
//
//   swiftc -O BenchFixture.swift -o BenchFixture
//   ./BenchFixture --state <file> [--mode dialog|editor] [--pos x,y] [--selftest]
//
// The same controls, names and state keys as the Windows (BenchFixture.cs) and Linux (bench_fixture.py) fixtures.
import AppKit
import Foundation

final class Recorder {
    var state: [String: Any] = [:]
    private var events: [[String: Any]] = []
    private let path: String

    init(path: String) { self.path = path }

    func event(_ type: String, _ target: String) {
        events.append(["t": Int(Date().timeIntervalSince1970 * 1000), "type": type, "target": target])
        write()
    }

    func write() {
        let root: [String: Any] = ["state": state, "events": events]
        guard let data = try? JSONSerialization.data(withJSONObject: root, options: []) else { return }
        // Atomic: written beside the file and moved over it, so a reader never sees half a file.
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

func makeButton(_ title: String, _ frame: NSRect, _ target: AnyObject, _ action: Selector) -> NSButton {
    let b = NSButton(frame: frame)
    b.title = title
    b.bezelStyle = .rounded
    b.target = target
    b.action = action
    return b
}

func makeLabel(_ text: String, _ frame: NSRect) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.frame = frame
    return l
}

final class DialogController: NSObject, NSTextFieldDelegate, NSWindowDelegate {
    let rec: Recorder
    let selftest: Bool
    let window: NSWindow
    let nameField = NSTextField(frame: NSRect(x: 100, y: 350, width: 300, height: 24))
    let emailField = NSTextField(frame: NSRect(x: 100, y: 316, width: 300, height: 24))
    let priority = NSPopUpButton(frame: NSRect(x: 100, y: 280, width: 300, height: 26), pullsDown: false)
    let subscribe = NSButton(checkboxWithTitle: "Subscribe", target: nil, action: nil)
    var confirmPanel: NSWindow?

    init(rec: Recorder, selftest: Bool) {
        self.rec = rec
        self.selftest = selftest
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 400),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Bench Dialog"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let content = window.contentView!

        content.addSubview(makeLabel("Name:", NSRect(x: 16, y: 352, width: 80, height: 20)))
        nameField.setAccessibilityLabel("Name")
        nameField.delegate = self
        content.addSubview(nameField)

        content.addSubview(makeLabel("Email:", NSRect(x: 16, y: 318, width: 80, height: 20)))
        emailField.setAccessibilityLabel("Email")
        emailField.delegate = self
        content.addSubview(emailField)

        content.addSubview(makeLabel("Priority:", NSRect(x: 16, y: 284, width: 80, height: 20)))
        // The first item means "nothing chosen": the state stays null until Low, Normal or High is picked.
        priority.addItems(withTitles: ["(none)", "Low", "Normal", "High"])
        priority.setAccessibilityLabel("Priority")
        priority.target = self
        priority.action = #selector(priorityChanged)
        content.addSubview(priority)

        subscribe.frame = NSRect(x: 100, y: 248, width: 200, height: 22)
        subscribe.target = self
        subscribe.action = #selector(subscribeChanged)
        content.addSubview(subscribe)

        // Two buttons with the same name: only the group tells them apart.
        let billing = NSBox(frame: NSRect(x: 16, y: 168, width: 190, height: 70))
        billing.title = "Billing"
        billing.addSubview(makeButton("Edit", NSRect(x: 10, y: 8, width: 90, height: 30), self, #selector(billingEdit)))
        content.addSubview(billing)
        let shipping = NSBox(frame: NSRect(x: 214, y: 168, width: 190, height: 70))
        shipping.title = "Shipping"
        shipping.addSubview(makeButton("Edit", NSRect(x: 10, y: 8, width: 90, height: 30), self, #selector(shippingEdit)))
        content.addSubview(shipping)

        content.addSubview(makeButton("Delete...", NSRect(x: 12, y: 120, width: 110, height: 30), self, #selector(deletePressed)))
        content.addSubview(makeButton("Apply", NSRect(x: 126, y: 16, width: 90, height: 30), self, #selector(applyPressed)))
        // OK and Cancel exist here and in the modal dialog.
        content.addSubview(makeButton("OK", NSRect(x: 220, y: 16, width: 90, height: 30), self, #selector(mainOk)))
        content.addSubview(makeButton("Cancel", NSRect(x: 314, y: 16, width: 90, height: 30), self, #selector(mainCancel)))

        rec.state["name"] = ""
        rec.state["email"] = ""
        rec.state["priority"] = NSNull()
        rec.state["subscribe"] = false
        rec.state["applied"] = NSNull()
        for key in ["billingEdit", "shippingEdit", "mainOk", "mainCancel"] { rec.state[key] = 0 }
        rec.state["modalOpen"] = false
        rec.state["modalResult"] = NSNull()
    }

    private func count(_ key: String) {
        rec.state[key] = ((rec.state[key] as? Int) ?? 0) + 1
        rec.event("click", key)
    }

    private func currentPriority() -> Any {
        return priority.indexOfSelectedItem > 0 ? (priority.titleOfSelectedItem ?? "") as Any : NSNull()
    }

    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? NSTextField else { return }
        textChanged(field)
    }

    func textChanged(_ field: NSTextField) {
        let key = field === nameField ? "name" : "email"
        rec.state[key] = field.stringValue
        rec.event("input", key)
    }

    func windowDidBecomeKey(_ notification: Notification) { rec.event("focus", "window") }
    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    @objc func priorityChanged() { rec.state["priority"] = currentPriority(); rec.event("select", "priority") }
    @objc func subscribeChanged() { rec.state["subscribe"] = subscribe.state == .on; rec.event("toggle", "subscribe") }
    @objc func billingEdit() { count("billingEdit") }
    @objc func shippingEdit() { count("shippingEdit") }
    @objc func mainOk() { count("mainOk") }
    @objc func mainCancel() { count("mainCancel") }

    @objc func applyPressed() {
        let applied: [String: Any] = [
            "name": nameField.stringValue.trimmingCharacters(in: .whitespaces),
            "email": emailField.stringValue.trimmingCharacters(in: .whitespaces),
            "priority": currentPriority(),
            "subscribe": subscribe.state == .on,
        ]
        rec.state["applied"] = applied
        rec.event("click", "apply")
    }

    @objc func deletePressed() {
        rec.state["modalOpen"] = true
        rec.event("click", "delete")
        if selftest { return }   // the self-test answers the dialog itself, with no window
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 110), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "Confirm delete"
        let content = panel.contentView!
        content.addSubview(makeLabel("Delete the selected record?", NSRect(x: 16, y: 66, width: 268, height: 20)))
        content.addSubview(makeButton("OK", NSRect(x: 56, y: 14, width: 90, height: 30), self, #selector(modalOk)))
        content.addSubview(makeButton("Cancel", NSRect(x: 156, y: 14, width: 90, height: 30), self, #selector(modalCancel)))
        panel.center()
        confirmPanel = panel
        NSApp.runModal(for: panel)
    }

    private func closeModal(_ result: String, _ target: String) {
        rec.state["modalResult"] = result
        rec.state["modalOpen"] = false
        rec.event("click", target)
        if let panel = confirmPanel {
            NSApp.stopModal()
            panel.orderOut(nil)
            confirmPanel = nil
        }
    }

    @objc func modalOk() { closeModal("ok", "modalOk") }
    @objc func modalCancel() { closeModal("cancel", "modalCancel") }

    /** Off screen and with no window shown: the same handlers a click or a keystroke reaches. */
    func runSelftest() {
        nameField.stringValue = "Self Test"
        textChanged(nameField)
        emailField.stringValue = "self@test.example"
        textChanged(emailField)
        priority.selectItem(withTitle: "High")
        priorityChanged()
        subscribe.state = .on
        subscribeChanged()
        shippingEdit()
        applyPressed()
        deletePressed()
        modalOk()
    }
}

final class EditorController: NSObject, NSTextViewDelegate, NSWindowDelegate {
    let rec: Recorder
    let window: NSWindow
    let textView: NSTextView

    init(rec: Recorder) {
        self.rec = rec
        // Locals until super.init(): no property of self is read before it.
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 360),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        let scroll = NSScrollView(frame: win.contentView!.bounds)
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        let view = NSTextView(frame: scroll.bounds)
        view.autoresizingMask = [.width]
        view.isRichText = false
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.font = NSFont.userFixedPitchFont(ofSize: 13)
        view.setAccessibilityLabel("Document")
        window = win
        textView = view
        super.init()
        window.title = "Bench Editor"
        window.delegate = self
        window.isReleasedWhenClosed = false
        textView.delegate = self
        scroll.documentView = textView
        window.contentView!.addSubview(scroll)
        rec.state["text"] = ""
    }

    func textDidChange(_ notification: Notification) { changed() }

    func changed() {
        rec.state["text"] = textView.string
        rec.event("input", "document")
    }

    func windowDidBecomeKey(_ notification: Notification) { rec.event("focus", "window") }
    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    func runSelftest() {
        textView.string = "first line\nsecond line"
        changed()
    }
}

// ── main ────────────────────────────────────────────────────────────────────

var statePath: String?
var mode = "dialog"
var pos: (x: CGFloat, y: CGFloat)?
var selftest = false
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let a = args.removeFirst()
    if a == "--state", !args.isEmpty { statePath = args.removeFirst() }
    else if a == "--mode", !args.isEmpty { mode = args.removeFirst() }
    else if a == "--pos", !args.isEmpty {
        let xy = args.removeFirst().split(separator: ",").compactMap { Double($0) }
        if xy.count == 2 { pos = (CGFloat(xy[0]), CGFloat(xy[1])) }
    }
    else if a == "--selftest" { selftest = true }
}
guard let path = statePath, mode == "dialog" || mode == "editor" else { exit(2) }

let app = NSApplication.shared
let rec = Recorder(path: path)
let dialog: DialogController? = mode == "dialog" ? DialogController(rec: rec, selftest: selftest) : nil
let editor: EditorController? = mode == "editor" ? EditorController(rec: rec) : nil
rec.write()

if selftest {
    dialog?.runSelftest()
    editor?.runSelftest()
    exit(0)
}

// Raw input, before any control handles it: a click on empty space or a key no control uses still reached the app, and the
// scorer must not call the action that sent it a false success.
NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { event in
    switch event.type {
    case .keyDown: rec.event("key", "raw")
    case .scrollWheel: rec.event("wheel", "raw")
    default: rec.event("mouse", "raw")
    }
    return event
}

app.setActivationPolicy(.regular)
let window = (dialog?.window ?? editor?.window)!
if let p = pos, let screen = NSScreen.screens.first {
    // --pos is the top-left corner, measured from the top of the main screen like on the other OSes.
    window.setFrameTopLeftPoint(NSPoint(x: p.x, y: screen.frame.height - p.y))
} else {
    window.center()
}
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
