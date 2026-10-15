// AXFixture — a throwaway AppKit app with KNOWN accessibility data, for
// mac-ax-live.test.ts. It never takes focus (accessory policy) and quits by
// itself after 3 minutes if a test run dies.
//
//   window "Fixture A"  big, behind
//   window "Fixture B"  small, in front, the app's main window
//     "Save"            titled button         id saveButton
//     (no title)        button, id only       id One        <- what SwiftUI Calculator looks like
//     "hello world"     text field            id nameField
//     "hunter2"         secure text field     id secretField
//     "Enable"          checkbox              id enableBox
//     "idle"            label                 id status     <- shows which button was pressed
//
// Prints "READY <pid>" on stdout once both windows are on screen.
import AppKit

final class Delegate: NSObject, NSApplicationDelegate {
    var status: NSTextField!

    @objc func pressed(_ sender: NSButton) {
        status.stringValue = "pressed: \(sender.accessibilityIdentifier())"
    }

    func window(_ title: String, _ frame: NSRect) -> NSWindow {
        let w = NSWindow(contentRect: frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = title
        w.isReleasedWhenClosed = false
        return w
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        let a = window("Fixture A", NSRect(x: 80, y: 420, width: 700, height: 420))
        let b = window("Fixture B", NSRect(x: 160, y: 260, width: 440, height: 300))

        let view = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 300))
        func place<T: NSView>(_ v: T, id: String, y: CGFloat, w: CGFloat = 200) -> T {
            v.frame = NSRect(x: 20, y: y, width: w, height: 28)
            v.setAccessibilityIdentifier(id)
            view.addSubview(v)
            return v
        }
        let save = place(NSButton(title: "Save", target: self, action: #selector(pressed(_:))), id: "saveButton", y: 250)
        _ = save
        _ = place(NSButton(title: "", target: self, action: #selector(pressed(_:))), id: "One", y: 210, w: 60)
        _ = place(NSTextField(string: "hello world"), id: "nameField", y: 170)
        _ = place(NSSecureTextField(string: "hunter2"), id: "secretField", y: 130)
        _ = place(NSButton(checkboxWithTitle: "Enable", target: nil, action: nil), id: "enableBox", y: 90)
        status = place(NSTextField(labelWithString: "idle"), id: "status", y: 50, w: 300)
        b.contentView = view

        a.orderFront(nil)
        b.orderFront(nil)
        b.makeMain()
        print("READY \(ProcessInfo.processInfo.processIdentifier)")
        fflush(stdout)
        DispatchQueue.main.asyncAfter(deadline: .now() + 180) { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
