/// screenshot-helper - Isolated screen capture subprocess
/// Runs in separate process to:
/// 1. Isolate Screen Recording TCC permission
/// 2. Prevent ReplayKit CPU spin bug (19% idle CPU after capture)
///
/// Usage: screenshot-helper <windowId> <outputPath>
///        screenshot-helper --fullscreen <outputPath>
///
/// macOS Tahoe (26.0+) flash-free notes
/// ────────────────────────────────────
/// In macOS 26 Tahoe, the system added a "screen captured" white-flash
/// animation that fires whenever any process calls into the
/// `screencapture` coordinator daemon — including the deprecated
/// `CGWindowListCreateImage` path. The flash is a privacy/awareness
/// feature, not a bug, but it makes silent background captures
/// (the kind agent tools do dozens of times a session) visually
/// disruptive.
///
/// `ScreenCaptureKit.SCScreenshotManager.captureImage` uses a different
/// pipeline that Tahoe's flash hook does NOT intercept. On macOS 14+
/// (Sonoma and later) we prefer that path; on 12-13 (Monterey/Ventura)
/// we fall back to the legacy CG path which is silent on those OS
/// versions anyway.

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import AppKit
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

// MARK: - macOS 14+ path (ScreenCaptureKit, flash-free on Tahoe)

#if canImport(ScreenCaptureKit)
@available(macOS 14.0, *)
func captureFullScreenSCK(outputPath: String) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var captured: CGImage? = nil
    var captureError: Error? = nil

    Task {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                captureError = NSError(domain: "ScreenshotHelper", code: 10, userInfo: [NSLocalizedDescriptionKey: "no displays"])
                semaphore.signal()
                return
            }
            // clawdcursor's own on-screen overlay (the pill and the glow, the `clawd-overlay` process) is for the person
            // at the screen, never part of what the agent sees: it sat over apps' toolbars and hid them in captures.
            // (The overlay also sets sharingType = .none, which the older CGWindowList path honours.)
            let ownOverlay = content.applications.filter {
                $0.applicationName.hasPrefix("clawd-overlay") || $0.bundleIdentifier.contains("clawd-overlay")
            }
            let filter = SCContentFilter(display: display, excludingApplications: ownOverlay, exceptingWindows: [])
            let config = SCStreamConfiguration()
            // Capture at native resolution. SCK reports display size in
            // points; multiply by the display's backingScaleFactor so
            // the resulting PNG matches the pixel dimensions the legacy
            // CG path produced. Without this, downstream code that
            // reads .width/.height on a retina capture would see
            // half-resolution images.
            let scale = NSScreen.main?.backingScaleFactor ?? 2.0
            config.width = Int(CGFloat(display.width) * scale)
            config.height = Int(CGFloat(display.height) * scale)
            config.scalesToFit = false
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            captured = image
        } catch {
            captureError = error
        }
        semaphore.signal()
    }

    _ = semaphore.wait(timeout: .now() + 15)
    if let err = captureError {
        fputs("error: ScreenCaptureKit failed: \(err.localizedDescription)\n", stderr)
        return false
    }
    guard let image = captured else {
        fputs("error: ScreenCaptureKit returned no image\n", stderr)
        return false
    }
    return saveImage(image, to: outputPath)
}

@available(macOS 14.0, *)
func captureWindowSCK(windowId: CGWindowID, outputPath: String) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var captured: CGImage? = nil
    var captureError: Error? = nil

    Task {
        do {
            let content = try await SCShareableContent.current
            // Find the SCWindow whose windowID matches the caller's CGWindowID.
            // SCWindow.windowID is the same CGWindowID under the hood, so
            // direct equality holds.
            guard let scwindow = content.windows.first(where: { $0.windowID == windowId }) else {
                captureError = NSError(domain: "ScreenshotHelper", code: 11, userInfo: [NSLocalizedDescriptionKey: "window \(windowId) not in shareable content"])
                semaphore.signal()
                return
            }
            let filter = SCContentFilter(desktopIndependentWindow: scwindow)
            let config = SCStreamConfiguration()
            let scale = NSScreen.main?.backingScaleFactor ?? 2.0
            // Use the window's frame for sizing — SCK requires explicit
            // pixel dimensions on the SCStreamConfiguration.
            config.width = Int(scwindow.frame.width * scale)
            config.height = Int(scwindow.frame.height * scale)
            config.scalesToFit = false
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            captured = image
        } catch {
            captureError = error
        }
        semaphore.signal()
    }

    _ = semaphore.wait(timeout: .now() + 15)
    if let err = captureError {
        fputs("error: ScreenCaptureKit window capture failed: \(err.localizedDescription)\n", stderr)
        return false
    }
    guard let image = captured else {
        fputs("error: ScreenCaptureKit returned no image\n", stderr)
        return false
    }
    return saveImage(image, to: outputPath)
}
#endif

// MARK: - macOS 12-13 path (CGWindowListCreateImage, silent on those versions)

func captureWindow(windowId: CGWindowID, outputPath: String) -> Bool {
#if canImport(ScreenCaptureKit)
    if #available(macOS 14.0, *) {
        return captureWindowSCK(windowId: windowId, outputPath: outputPath)
    }
#endif
    guard let image = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        windowId,
        [.boundsIgnoreFraming, .nominalResolution]
    ) else {
        fputs("error: failed to capture window \(windowId)\n", stderr)
        return false
    }
    return saveImage(image, to: outputPath)
}

func captureFullScreen(outputPath: String) -> Bool {
#if canImport(ScreenCaptureKit)
    if #available(macOS 14.0, *) {
        return captureFullScreenSCK(outputPath: outputPath)
    }
#endif
    guard let image = CGWindowListCreateImage(
        CGRect.infinite,
        .optionOnScreenOnly,
        kCGNullWindowID,
        [.nominalResolution]
    ) else {
        fputs("error: failed to capture screen\n", stderr)
        return false
    }
    return saveImage(image, to: outputPath)
}

// MARK: - Shared encoding path

func saveImage(_ image: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path)
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        fputs("error: failed to create image destination\n", stderr)
        return false
    }

    CGImageDestinationAddImage(destination, image, nil)

    if CGImageDestinationFinalize(destination) {
        print("{\"success\": true, \"path\": \"\(path)\", \"width\": \(image.width), \"height\": \(image.height)}")
        return true
    } else {
        fputs("error: failed to write image\n", stderr)
        return false
    }
}

// MARK: - Entry

// Check Screen Recording permission first
if !CGPreflightScreenCaptureAccess() {
    fputs("{\"error\": \"screen_recording_denied\", \"message\": \"Grant Screen Recording permission in System Settings > Privacy & Security > Screen & System Audio Recording\"}\n", stderr)
    exit(2)
}

// Parse arguments
let args = CommandLine.arguments
// The permission probe: granted (the check above passed).
if args.count == 2 && args[1] == "--preflight" { exit(0) }
guard args.count >= 3 else {
    fputs("usage: screenshot-helper <windowId|--fullscreen> <outputPath>\n", stderr)
    exit(1)
}

let success: Bool
if args[1] == "--fullscreen" {
    success = captureFullScreen(outputPath: args[2])
} else if let windowId = UInt32(args[1]) {
    success = captureWindow(windowId: CGWindowID(windowId), outputPath: args[2])
} else {
    fputs("error: invalid window ID\n", stderr)
    exit(1)
}

exit(success ? 0 : 1)
