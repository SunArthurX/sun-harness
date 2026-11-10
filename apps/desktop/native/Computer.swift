import AppKit
import ApplicationServices
import CryptoKit

private struct Target: Codable, Equatable {
    let appId: String
    let instance: String
    let windowId: String
}

private struct App: Encodable {
    let id: String
    let label: String
}

private struct Control: Encodable {
    let key: String
    let role: String
    let label: String
    let actions: [String]
}

private struct Request: Decodable {
    let command: String
    let hostId: String
    let hostPid: pid_t
    let target: Target?
    let key: String?
    let kind: String?
    let text: String?
}

private struct Window {
    let target: Target
    let application: NSRunningApplication
    let bounds: CGRect
}

private struct Response: Encodable {
    var authorized: Bool
    var hostFront: Bool? = nil
    var apps: [App]? = nil
    var target: Target? = nil
    var text: String? = nil
    var controls: [Control]? = nil
    var outcome: String? = nil
}

private enum NativeError: Error { case unavailable, invalid, uncertain }

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func axBounds(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: origin, size: dimensions)
}

@MainActor
private func foreground(excluding hostId: String) -> Window? {
    guard let app = NSWorkspace.shared.frontmostApplication, !app.isTerminated,
          let id = app.bundleIdentifier, id != hostId, let started = app.launchDate,
          let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for entry in entries {
        guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
              (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0,
              let number = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let dict = entry[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary), bounds.width > 0, bounds.height > 0 else { continue }
        let instance = "\(app.processIdentifier)-\(Int64(started.timeIntervalSince1970 * 1000))"
        return Window(target: Target(appId: id, instance: instance, windowId: String(number)), application: app, bounds: bounds)
    }
    return nil
}

@MainActor
private func stillCurrent(_ window: Window, _ hostId: String) -> Bool {
    guard AXIsProcessTrusted(), let current = foreground(excluding: hostId) else { return false }
    return window.application.isEqual(current.application) && window.target == current.target && window.bounds == current.bounds
}

private func focusedRoot(_ window: Window) -> AXUIElement? {
    let application = AXUIElementCreateApplication(window.application.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 0.05)
    guard let raw = attribute(application, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    let root = raw as! AXUIElement
    guard let bounds = axBounds(root),
          abs(bounds.minX - window.bounds.minX) < 4, abs(bounds.minY - window.bounds.minY) < 4,
          abs(bounds.width - window.bounds.width) < 4, abs(bounds.height - window.bounds.height) < 4 else { return nil }
    return root
}

private func controlActions(_ node: AXUIElement, _ role: String) -> [String] {
    guard (attribute(node, kAXEnabledAttribute) as? Bool) != false else { return [] }
    var supported: [String] = []
    var actions: CFArray?
    if AXUIElementCopyActionNames(node, &actions) == .success,
       (actions as? [String])?.contains(kAXPressAction) == true { supported.append("press") }
    if role == kAXTextFieldRole || role == kAXTextAreaRole {
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue { supported.append("set-text") }
    }
    return supported
}

private func secure(_ node: AXUIElement, _ role: String) -> Bool {
    let subrole = attribute(node, kAXSubroleAttribute) as? String ?? ""
    let kind = (role + subrole).lowercased()
    return kind.contains("secure") || kind.contains("password") || (attribute(node, "AXProtectedContent") as? Bool) == true
}

private struct Tree {
    var text: [String] = []
    var controls: [Control] = []
    var matching: AXUIElement?
    var matchingActions: [String] = []
}

@MainActor
private func scan(_ root: AXUIElement, in window: Window, hostId: String, key: String?) throws -> Tree {
    var tree = Tree()
    let deadline = ProcessInfo.processInfo.systemUptime + 0.9
    var pending: [(AXUIElement, String, String, Int)] = [(root, "0", "", 0)]
    var visited = 0
    while let (node, path, parent, depth) = pending.popLast(), visited < 140, ProcessInfo.processInfo.systemUptime < deadline {
        visited += 1
        if visited % 8 == 1 && !stillCurrent(window, hostId) { throw NativeError.unavailable }
        let role = attribute(node, kAXRoleAttribute) as? String ?? ""
        if secure(node, role) { continue }
        let title = (attribute(node, kAXTitleAttribute) as? String ?? attribute(node, kAXDescriptionAttribute) as? String ?? "")
        let label = String(title.prefix(240))
        let identifier = String((attribute(node, kAXIdentifierAttribute) as? String ?? "").prefix(128))
        let component = "\(parent)\u{0}\(path)\u{0}\(role)\u{0}\(identifier)\u{0}\(label)"
        let digest = SHA256.hash(data: Data(component.utf8)).map { String(format: "%02x", $0) }.joined()
        let actions = controlActions(node, role)
        if !actions.isEmpty {
            let bounds = axBounds(node).map { "\($0.minX),\($0.minY),\($0.width),\($0.height)" } ?? "unavailable"
            let fingerprint = SHA256.hash(data: Data("\(digest)\u{0}\(bounds)".utf8)).map { String(format: "%02x", $0) }.joined()
            tree.controls.append(Control(key: fingerprint, role: role, label: label, actions: actions))
            if fingerprint == key { tree.matching = node; tree.matchingActions = actions; break }
        } else if key == nil && role == kAXStaticTextRole {
            let text = label.isEmpty ? String((attribute(node, kAXValueAttribute) as? String ?? "").prefix(240)) : label
            if !text.isEmpty { tree.text.append(text) }
        }
        if depth < 12 {
            var children: CFArray?
            if AXUIElementCopyAttributeValues(node, kAXChildrenAttribute as CFString, 0, 32, &children) == .success,
               let elements = children as? [AXUIElement] {
                for (index, child) in elements.enumerated().reversed() { pending.append((child, "\(path).\(index)", digest, depth + 1)) }
            }
        }
    }
    return tree
}

@main
private struct Computer {
    @MainActor
    static func main() {
        do {
            var data = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
                data.append(chunk)
                if data.count > 24_000 { throw NativeError.invalid }
            }
            let request = try JSONDecoder().decode(Request.self, from: data)
            guard request.hostPid > 1, getppid() == request.hostPid else { throw NativeError.invalid }
            let authorized = AXIsProcessTrustedWithOptions(nil)
            var response = Response(authorized: authorized)
            switch request.command {
            case "inspect":
                response.apps = NSWorkspace.shared.runningApplications.compactMap { app in
                    guard let id = app.bundleIdentifier, id != request.hostId, app.activationPolicy == .regular else { return nil }
                    return App(id: id, label: String((app.localizedName ?? id).prefix(120)))
                }
            case "probe":
                if authorized {
                    response.hostFront = NSWorkspace.shared.frontmostApplication?.bundleIdentifier == request.hostId
                    response.target = foreground(excluding: request.hostId)?.target
                }
            case "snapshot", "act":
                guard authorized, let window = foreground(excluding: request.hostId), window.target == request.target,
                      let root = focusedRoot(window), stillCurrent(window, request.hostId) else { throw NativeError.unavailable }
                let tree = try scan(root, in: window, hostId: request.hostId, key: request.key)
                guard stillCurrent(window, request.hostId), let currentRoot = focusedRoot(window), CFEqual(root, currentRoot),
                      stillCurrent(window, request.hostId) else { throw NativeError.unavailable }
                if request.command == "snapshot" {
                    response.target = window.target
                    response.text = String(tree.text.joined(separator: "\n").prefix(12_000))
                    response.controls = Array(tree.controls.prefix(128))
                } else {
                    response.outcome = try act(request, tree, window)
                }
            default: throw NativeError.invalid
            }
            FileHandle.standardOutput.write(try JSONEncoder().encode(response))
        } catch { exit(1) }
    }

    @MainActor
    private static func act(_ request: Request, _ tree: Tree, _ window: Window) throws -> String {
        guard let node = tree.matching, let kind = request.kind, tree.matchingActions.contains(kind) else { return "refused" }
        var pid: pid_t = 0
        guard AXUIElementGetPid(node, &pid) == .success, pid == window.application.processIdentifier,
              let role = attribute(node, kAXRoleAttribute) as? String, !secure(node, role),
              controlActions(node, role).contains(kind), stillCurrent(window, request.hostId),
              getppid() == request.hostPid else { return "refused" }
        let result: AXError
        switch kind {
        case "press": result = AXUIElementPerformAction(node, kAXPressAction as CFString)
        case "set-text":
            guard let text = request.text, text.utf8.count <= 4096, !text.contains("\0") else { return "refused" }
            result = AXUIElementSetAttributeValue(node, kAXValueAttribute as CFString, text as CFString)
        default: return "refused"
        }
        guard result == .success else { throw NativeError.uncertain }
        return "applied"
    }
}
