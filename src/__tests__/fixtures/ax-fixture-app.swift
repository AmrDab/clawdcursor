// AXFixture — a throwaway AppKit app with KNOWN accessibility data, for
// mac-ax-live.test.ts. It never takes focus (accessory policy — except the zoomed / minimized modes) and quits by
// itself after 3 minutes if a test run dies.
//
//   window "Fixture A"  big, behind
//   window "Fixture B"  small, in front, the app's main window
//     "Save"            titled button         id saveButton
//     (no title)        button, id only       id One        <- what SwiftUI Calculator looks like
//     (no title)        button whose label is a CHILD static text "Peeked"   id peekButton
//     "Open modal"      button whose action runs a modal alert for 3 s       id modalButton
//     "Hang"            button whose action BLOCKS the main thread for 4 s   id hangButton  (the app stops answering AX)
//     "Cafe"            button whose id is non-ASCII, precomposed (NFC)      id "caf\u{E9}"
//     "hello world"     text field            id nameField
//     "hunter2"         secure text field     id secretField
//     "Enable"          checkbox              id enableBox
//     "idle"            label                 id status     <- shows which button was pressed
//
// AXFIXTURE_MODE=zoomed / minimized: the same windows, but "Fixture B" is zoomed to fill the screen /
// minimized into the Dock — for checking that focusing a window leaves its size alone and brings a minimized one back.
//
// AXFIXTURE_MODE=slow instead opens one window "Fixture Slow" with a "Save As…" button, a
// status label and an element whose title takes 3 s to answer (the app's main thread is busy,
// so every AX request behind it waits) — a hung subtree inside a live app.
//
// Prints "READY <pid>" on stdout once the windows are on screen.
import AppKit

let fixtureMode = ProcessInfo.processInfo.environment["AXFIXTURE_MODE"] ?? "normal"

/// A control with the button role whose only label is a child AXStaticText — how some apps name their controls.
final class PeekButton: NSView {
    var onPress: (() -> Void)?
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }
}

/// An accessibility element of its own whose title takes 3 s to answer. The app's main thread serves every AX request, so
/// reading THIS element blocks the ones behind it — a hung subtree inside a live app. (A plain container would be flattened
/// into its parent by AppKit and stall the very first read of the window instead.)
final class SlowView: NSView {
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityTitle() -> String? {
        Thread.sleep(forTimeInterval: 3)
        return nil
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var status: NSTextField!

    @objc func pressed(_ sender: NSButton) {
        status.stringValue = "pressed: \(sender.accessibilityIdentifier())"
    }

    /// Runs a modal alert inside the action, so the accessibility press does not return until it ends.
    @objc func openModal(_ sender: NSButton) {
        status.stringValue = "modal: open"
        let alert = NSAlert()
        alert.messageText = "AXFixture modal"
        alert.addButton(withTitle: "OK")
        let timer = Timer(timeInterval: 3, repeats: false) { _ in NSApp.abortModal() }
        RunLoop.main.add(timer, forMode: .common)
        _ = alert.runModal()
        status.stringValue = "modal: closed"
    }

    /// Blocks the main thread inside the action: unlike a modal loop (which keeps answering accessibility requests), the app
    /// answers nothing until it is over — a hung app, hung while the press was running.
    @objc func hang(_ sender: NSButton) {
        status.stringValue = "hang: started"
        Thread.sleep(forTimeInterval: 4)
        status.stringValue = "hang: over"
    }

    func window(_ title: String, _ frame: NSRect) -> NSWindow {
        let w = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.title = title
        w.isReleasedWhenClosed = false
        return w
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        let slow = fixtureMode == "slow"
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 340))
        func place<T: NSView>(_ v: T, id: String, y: CGFloat, w: CGFloat = 200, x: CGFloat = 20) -> T {
            v.frame = NSRect(x: x, y: y, width: w, height: 28)
            v.setAccessibilityIdentifier(id)
            view.addSubview(v)
            return v
        }

        if slow {
            let w = window("Fixture Slow", NSRect(x: 160, y: 260, width: 440, height: 340))
            _ = place(NSButton(title: "Save As…", target: self, action: #selector(pressed(_:))), id: "saveAsButton", y: 280)
            status = place(NSTextField(labelWithString: "idle"), id: "status", y: 240, w: 300)
            _ = place(SlowView(frame: .zero), id: "slowView", y: 200)
            w.contentView = view
            w.orderFront(nil)
            w.makeMain()
        } else {
            let a = window("Fixture A", NSRect(x: 80, y: 420, width: 700, height: 420))
            let b = window("Fixture B", NSRect(x: 160, y: 260, width: 440, height: 340))
            _ = place(NSButton(title: "Save", target: self, action: #selector(pressed(_:))), id: "saveButton", y: 300)
            _ = place(NSButton(title: "", target: self, action: #selector(pressed(_:))), id: "One", y: 262, w: 60)
            let peek = place(PeekButton(frame: .zero), id: "peekButton", y: 224, w: 90)
            peek.setAccessibilityElement(true)
            peek.setAccessibilityRole(.button)
            peek.onPress = { [weak self] in self?.status.stringValue = "pressed: peekButton" }
            let peekLabel = NSTextField(labelWithString: "Peeked")
            peekLabel.frame = NSRect(x: 0, y: 0, width: 90, height: 28)
            peek.addSubview(peekLabel)
            _ = place(NSButton(title: "Open modal", target: self, action: #selector(openModal(_:))), id: "modalButton", y: 186)
            _ = place(NSButton(title: "Hang", target: self, action: #selector(hang(_:))), id: "hangButton", y: 186, w: 90, x: 240)
            _ = place(NSButton(title: "Cafe", target: self, action: #selector(pressed(_:))), id: "caf\u{E9}", y: 262, w: 90, x: 240)
            _ = place(NSTextField(string: "hello world"), id: "nameField", y: 148)
            _ = place(NSSecureTextField(string: "hunter2"), id: "secretField", y: 110)
            _ = place(NSButton(checkboxWithTitle: "Enable", target: nil, action: nil), id: "enableBox", y: 72)
            status = place(NSTextField(labelWithString: "idle"), id: "status", y: 34, w: 300)
            b.contentView = view
            a.orderFront(nil)
            b.orderFront(nil)
            b.makeMain()
            // AXFIXTURE_MODE=zoomed / minimized: window B starts zoomed (fills the screen) or put away in the Dock
            if fixtureMode == "zoomed" { b.zoom(nil) }
            if fixtureMode == "minimized" { b.miniaturize(nil) }
        }
        print("READY \(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 180) { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
// zoomed / minimized are driven through System Events (scripts/mac/focus-window.jxa), which only sees ordinary apps —
// and an ordinary app takes the keyboard focus when it starts. The tests that use them wait for an idle machine.
app.setActivationPolicy(fixtureMode == "zoomed" || fixtureMode == "minimized" ? .regular : .accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
