import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import ScreenCaptureKit

private enum CaptureError: String, Error {
    case permission = "APPSHOT_SCREEN_PERMISSION"
    case noWindow = "APPSHOT_NO_WINDOW"
    case foreground = "APPSHOT_FOREGROUND_CHANGED"
    case unavailable = "APPSHOT_WINDOW_UNAVAILABLE"
    case image = "APPSHOT_IMAGE_INVALID"
    case capture = "APPSHOT_CAPTURE_FAILED"
}

private struct WindowIdentity: Encodable {
    let appId: String
    let title: String
    let windowId: String
}

private struct Target {
    let id: CGWindowID
    let pid: pid_t
    let appId: String
    let title: String

    var identity: WindowIdentity { WindowIdentity(appId: appId, title: title, windowId: String(id)) }
}

private struct Result: Encodable {
    let appId: String
    let title: String
    let windowId: String
    let intendedWindow: WindowIdentity
    let mime: String
    let data: String
    let width: Int
    let height: Int
    let text: String?
    let textTruncated: Bool
}

@MainActor
private func frontWindow(expectedPid: pid_t? = nil) throws -> Target {
    guard let app = NSWorkspace.shared.frontmostApplication else { throw CaptureError.noWindow }
    guard expectedPid == nil || app.processIdentifier == expectedPid else { throw CaptureError.foreground }
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { throw CaptureError.noWindow }
    for info in windows {
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let dict = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: dict as CFDictionary),
              rect.width > 0, rect.height > 0,
              (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0
        else { continue }
        return Target(id: id, pid: app.processIdentifier,
                      appId: app.bundleIdentifier ?? app.localizedName ?? String(app.processIdentifier),
                      title: info[kCGWindowName as String] as? String ?? "")
    }
    throw CaptureError.noWindow
}

private final class OneFrame: NSObject, SCStreamOutput {
    private let lock = NSLock()
    private let context = CIContext()
    private var callback: CheckedContinuation<CGImage, Error>?

    func capture(_ stream: SCStream) async throws -> CGImage {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            callback = continuation
            lock.unlock()
            Task {
                do { try await stream.startCapture() }
                catch { finish(.failure(error)) }
            }
        }
    }

    private func finish(_ result: Swift.Result<CGImage, Error>) {
        lock.lock()
        let continuation = callback
        callback = nil
        lock.unlock()
        continuation?.resume(with: result)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        lock.lock()
        let waiting = callback != nil
        lock.unlock()
        guard waiting, type == .screen, sample.isValid,
              let attributes = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attributes.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue,
              let buffer = CMSampleBufferGetImageBuffer(sample)
        else { return }
        let frame = CIImage(cvPixelBuffer: buffer)
        guard let image = context.createCGImage(frame, from: frame.extent) else { finish(.failure(CaptureError.image)); return }
        finish(.success(image))
    }
}

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}

@MainActor
private func windowText(_ target: Target, _ window: SCWindow) -> (String?, Bool) {
    guard AXIsProcessTrusted(), (try? frontWindow().id) == target.id else { return (nil, false) }
    let app = AXUIElementCreateApplication(target.pid)
    AXUIElementSetMessagingTimeout(app, 0.05)
    guard let raw = attribute(app, kAXFocusedWindowAttribute),
          CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { return (nil, false) }
    let focused = raw as! AXUIElement
    guard let rawPosition = attribute(focused, kAXPositionAttribute), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
          let rawSize = attribute(focused, kAXSizeAttribute), CFGetTypeID(rawSize) == AXValueGetTypeID()
    else { return (nil, false) }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
          AXValueGetValue(rawSize as! AXValue, .cgSize, &size),
          abs(position.x - window.frame.origin.x) < 4, abs(position.y - window.frame.origin.y) < 4,
          abs(size.width - window.frame.width) < 4, abs(size.height - window.frame.height) < 4,
          (attribute(focused, kAXTitleAttribute) as? String ?? "") == (window.title ?? target.title)
    else { return (nil, false) }

    let deadline = ProcessInfo.processInfo.systemUptime + 0.3
    var stack = [focused]
    var entries = 0
    var text = ""
    while let node = stack.popLast() {
        guard ProcessInfo.processInfo.systemUptime < deadline, entries < 300, text.utf16.count < 20_001 else {
            return (String(decoding: text.utf16.prefix(20_000), as: UTF16.self), true)
        }
        entries += 1
        let role = attribute(node, kAXRoleAttribute) as? String
        let subrole = attribute(node, kAXSubroleAttribute) as? String
        if subrole == "AXSecureTextField" { continue }
        if role == kAXStaticTextRole || role == kAXTextAreaRole,
           let value = (attribute(node, kAXValueAttribute) ?? attribute(node, kAXTitleAttribute)) as? String,
           !value.isEmpty {
            if !text.isEmpty { text += "\n" }
            text += String(decoding: value.utf16.prefix(20_001 - text.utf16.count), as: UTF16.self)
        }
        if let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
            stack.append(contentsOf: children.prefix(300).reversed())
        }
    }
    guard (try? frontWindow().id) == target.id else { return (nil, false) }
    return (text.isEmpty ? nil : text, text.utf16.count > 20_000)
}

@MainActor
private func captureForeground(expectedPid: pid_t?) async throws -> (Target, SCWindow, CGImage) {
    for _ in 0..<2 {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let target = try frontWindow(expectedPid: expectedPid)
        guard let window = content.windows.first(where: { $0.windowID == target.id && $0.owningApplication?.processID == target.pid })
        else { continue }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = min(2, 3000 / max(window.frame.width, window.frame.height))
        config.width = max(1, Int(window.frame.width * scale))
        config.height = max(1, Int(window.frame.height * scale))
        config.showsCursor = false
        config.capturesAudio = false
        let output = OneFrame()
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "sun.appshot.frame"))
        let image = try await output.capture(stream)
        try await stream.stopCapture()
        var current = try frontWindow(expectedPid: expectedPid)
        if current.pid == target.pid && current.id != target.id {
            // macOS briefly reports its capture indicator as another window of the captured app.
            try await Task.sleep(nanoseconds: 200_000_000)
            current = try frontWindow(expectedPid: expectedPid)
        }
        if current.id == target.id && current.pid == target.pid { return (target, window, image) }
    }
    throw CaptureError.unavailable
}

@main
private struct Appshot {
    @MainActor
    static func main() async {
        do {
            let expectedPid = CommandLine.arguments.dropFirst().dropFirst().first.flatMap(Int32.init)
            if CommandLine.arguments.dropFirst().first == "probe" {
                guard CGPreflightScreenCaptureAccess() else { print("permission-required"); return }
                if let expectedPid { _ = try frontWindow(expectedPid: expectedPid) }
                print("available")
                return
            }
            if let expectedPid { _ = try frontWindow(expectedPid: expectedPid) }
            guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else { throw CaptureError.permission }
            let intended = try frontWindow(expectedPid: expectedPid)
            let (target, window, image) = try await captureForeground(expectedPid: expectedPid)
            let bitmap = NSBitmapImageRep(cgImage: image)
            let maxBytes = 10 * 1024 * 1024
            let png = bitmap.representation(using: .png, properties: [:])
            let mime = (png?.count ?? Int.max) <= maxBytes ? "image/png" : "image/jpeg"
            guard let bytes = mime == "image/png" ? png : bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]),
                  bytes.count <= maxBytes
            else { throw CaptureError.image }
            let (text, truncated) = windowText(target, window)
            let result = Result(appId: target.appId, title: window.title ?? target.title, windowId: String(target.id),
                                intendedWindow: intended.identity, mime: mime, data: bytes.base64EncodedString(),
                                width: image.width, height: image.height, text: text, textTruncated: truncated)
            FileHandle.standardOutput.write(try JSONEncoder().encode(result))
        } catch {
            let code = (error as? CaptureError)?.rawValue ?? (CGPreflightScreenCaptureAccess() ? CaptureError.capture.rawValue : CaptureError.permission.rawValue)
            FileHandle.standardError.write(Data(code.utf8))
            exit(1)
        }
    }
}
