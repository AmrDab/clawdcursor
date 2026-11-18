// For full-macos.mjs: every 0.5 s, one line with the on-screen windows of clawdcursor's overlay processes (owner name
// starting "clawd-overlay") and the ordinary windows of the pids given as arguments (the agent's targets).
//   R|<ms since 1970>|<pid>,<layer>,<x>,<y>,<w>,<h>,<owner>;...
import Cocoa
setvbuf(stdout, nil, _IOLBF, 0)
let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int($0) })
while true {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    var out: [String] = []
    for w in list {
        let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
        let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? 0
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        guard owner.hasPrefix("clawd-overlay") || (pids.contains(pid) && layer == 0),
              let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { continue }
        out.append("\(pid),\(layer),\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height)),\(owner.replacingOccurrences(of: ";", with: " "))")
    }
    print("R|\(Int(Date().timeIntervalSince1970 * 1000))|\(out.joined(separator: ";"))")
    usleep(500_000)
}
