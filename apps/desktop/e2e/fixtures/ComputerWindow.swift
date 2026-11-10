import AppKit

@MainActor
private final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var editor: NSTextField?
    private let state: URL
    private var count = 0
    private var textSet = false

    init(state: URL) { self.state = state }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 360, y: 180, width: 420, height: 240),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Sun Computer Fixture"
        let button = NSButton(title: "Count fixture press", target: self, action: #selector(pressed))
        button.setAccessibilityIdentifier("sun-fixture-press")
        button.frame = NSRect(x: 28, y: 148, width: 200, height: 32)
        window.contentView?.addSubview(button)
        let password = NSSecureTextField(string: "PRIVATE_NATIVE_FIXTURE_SENTINEL")
        password.setAccessibilityLabel("Private fixture field")
        password.frame = NSRect(x: 28, y: 88, width: 240, height: 28)
        window.contentView?.addSubview(password)
        let editor = NSTextField(string: "")
        editor.setAccessibilityLabel("Editable fixture field")
        editor.setAccessibilityIdentifier("sun-fixture-editor")
        editor.frame = NSRect(x: 28, y: 38, width: 240, height: 28)
        window.contentView?.addSubview(editor)
        self.editor = editor
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        save()
        Timer.scheduledTimer(timeInterval: 0.1, target: self, selector: #selector(recordText), userInfo: nil, repeats: true)
    }

    @objc private func pressed() { count += 1; save() }

    @objc private func recordText() {
        let current = editor?.stringValue == "approved fixture text"
        if current != textSet { textSet = current; save() }
    }

    private func save() {
        let data = Data("{\"pid\":\(getpid()),\"count\":\(count),\"textSet\":\(textSet)}".utf8)
        try? data.write(to: state, options: .atomic)
    }
}

@main
private struct ComputerWindow {
    @MainActor
    static func main() {
        guard CommandLine.arguments.count == 2 else { exit(2) }
        let fixture = Fixture(state: URL(fileURLWithPath: CommandLine.arguments[1]))
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        app.delegate = fixture
        withExtendedLifetime(fixture) { app.run() }
    }
}
