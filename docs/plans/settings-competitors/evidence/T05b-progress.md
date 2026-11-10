# T05b — Preference adapters checkpoint

T05 is in progress. T05b applies preferences to desktop and web behavior.
The Settings controls, permission status panel, full Mini panel, and usage
estimates remain T05c work.

- Startup respects the configured page and explicit section links. Theme,
  rendered text size, and reduced motion update from the settings snapshot.
  System media changes update the system settings without a restart.
- Notifications use live session status events. The tracker deduplicates by
  sequence, ignores historical snapshots, applies filters and quiet hours, and
  preserves in-app approvals.
- Denied microphone access prevents recording. Cancellation releases tracks
  and discards the buffer. In-flight transcription requests can be aborted,
  including cancellation that arrives before the request.
- Remapped in-app keys use the current settings. Electron stages OS registration
  before saving. An occupied key leaves the earlier registration and the saved
  configuration unchanged. The Mini global shortcut is wired to the main window
  until the full Mini panel is added in T05c.

Verification: [Vitest](T05b-test.txt), [focused tests](T05b-focused.txt),
[build](T05b-build.txt), [typecheck](T05b-typecheck.txt),
[Electron and gateway web smoke](T05b-e2e.txt). The UI test uses fake audio
and notification APIs and a real macOS global shortcut reservation. A separate
loopback ASR test verifies request abortion. No microphone recording, model
provider call, or system notification was needed by the tests.
