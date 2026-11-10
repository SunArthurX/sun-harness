import AppKit
import ApplicationServices

private struct Probe: Encodable {
    let screenRecording: String
    let accessibility: String
    let foreground: String
    let windowRole: String
}

@main
private struct ComputerProbe {
    @MainActor
    static func main() throws {
        guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]), pid > 1 else { exit(2) }
        let screen = CGPreflightScreenCaptureAccess()
        let accessibility = AXIsProcessTrustedWithOptions(nil)
        let expected = NSRunningApplication(processIdentifier: pid)
        func ownsForeground() -> Bool {
            guard let expected, !expected.isTerminated, let front = NSWorkspace.shared.frontmostApplication else { return false }
            return expected.isEqual(front)
        }

        let foreground = ownsForeground()
        var role = "not-inspected"
        if foreground, accessibility {
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.1)
            var focused: CFTypeRef?
            if AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focused) == .success,
               let focused, CFGetTypeID(focused) == AXUIElementGetTypeID(), ownsForeground() {
                let window = focused as! AXUIElement
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(window, kAXRoleAttribute as CFString, &value) == .success, ownsForeground() {
                    role = value as? String == kAXWindowRole ? "window" : "unavailable"
                }
            }
        }
        let result = Probe(screenRecording: screen ? "available" : "permission-required",
                           accessibility: accessibility ? "available" : "permission-required",
                           foreground: foreground ? "matched" : "mismatch", windowRole: role)
        FileHandle.standardOutput.write(try JSONEncoder().encode(result))
    }
}
