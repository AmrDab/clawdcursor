// ax-node-count.swift — count the accessibility nodes an app exposes, straight
// from the AX C API (no System Events). Ground truth for scripts/verify-macos.mjs:
// it shows whether an Electron / Chromium tree actually woke up, independently of
// how much of that tree the JXA / System Events walk can read.
//
// Usage: ax-node-count <pid> [maxNodes=20000] [maxSeconds=10]
// Prints {"nodes":N,"maxDepth":D,"ms":T,"truncated":true|false}
import ApplicationServices
import Foundation

let args = CommandLine.arguments
guard args.count > 1, let pidValue = Int32(args[1]) else {
    print("{\"error\":\"usage: ax-node-count <pid> [maxNodes] [maxSeconds]\"}")
    exit(1)
}
let maxNodes = args.count > 2 ? (Int(args[2]) ?? 20000) : 20000
let maxSeconds = args.count > 3 ? (Double(args[3]) ?? 10) : 10

let app = AXUIElementCreateApplication(pid_t(pidValue))
var count = 0
var maxDepth = 0
var truncated = false
let start = Date()

func walk(_ element: AXUIElement, _ depth: Int) {
    if count >= maxNodes || Date().timeIntervalSince(start) > maxSeconds { truncated = true; return }
    count += 1
    if depth > maxDepth { maxDepth = depth }
    var children: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
       let kids = children as? [AXUIElement] {
        for kid in kids { walk(kid, depth + 1) }
    }
}

walk(app, 0)
let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
print("{\"nodes\":\(count),\"maxDepth\":\(maxDepth),\"ms\":\(elapsedMs),\"truncated\":\(truncated)}")
