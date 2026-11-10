# T11 Appshot implementation history

T11 passed the refreshed signed macOS fixture. See the
[final acceptance record](T11.json).

## Evidence

- The fake adapter exercises actual-target metadata, permission denial,
  cancellation without session writes, cross-session rejection,
  expiration, text limits and exclusion after image edits.
- The model fixture reads the SHA-256 receipt and the prepared bytes
  from disk before dispatch. Reopening the session and importing a
  portable bundle preserve the receipt and prepared image. Changed
  bytes produce an unavailable attachment. A text-only provider
  receives the approved fallback without pixels.
- The macOS package includes the Swift helper and passes
  `codesign --verify --deep --strict`. The packaged UI defaults to off
  and registers the configured OS shortcut only after enablement.
  The supplemental fixture executes the Electron mask implementation
  on synthetic pixels and checks the expected size and opaque black
  result. See [package output](T11-package.txt) and
  [supplemental output](T11-boundary.txt).
- The regular suite and TypeScript checks pass. See [unit tests](T11-test.txt),
  [type checks](T11-types.txt), and [settings regression](T11-e2e.txt).

## Native verification sequence

The packaged fixture is launched through macOS LaunchServices with an
isolated data directory. Its in-process helper probe returned
`permission-required`. A helper started by the terminal can receive a
different macOS permission result and does not establish permission
for the packaged app. The strict run exited before taking a frame.
See [strict fixture output](T11-native-gate.txt).
An earlier check on 2026-11-09 after T13 and T14 passed returned
`permission-required` on the original package.

After the original bundle received permission, the strict fixture
reached native capture. ScreenCaptureKit briefly added a window to
the captured app's on-screen window list after stopping the stream.
The helper now waits 200 ms when this happens and requires the actual
captured window to match the subsequent foreground identity. The new
helper from the refreshed signed package captured the real synthetic
window when launched from the already-authorized original desktop
process. It returned the matching window ID and a valid image, and
created no attachment. See [helper regression](T11-helper-refresh.txt).

The refreshed ad-hoc signature initially required a new Screen Recording
grant. After authorization, the [strict fixture](T11-native-refresh.txt)
and its [repeat run](T11-native-repeat.txt) both passed.
The original authorized bundle is preserved.
The current build passed the [desktop and gateway settings regression](T11-settings-refresh.txt),
including the web explanation for the unavailable native capture route.

Authorize `apps/desktop/release/appshot-verified/mac-arm64/sun-harness.app`
in macOS **Privacy & Security → Screen & System Audio Recording**.
Run `node apps/desktop/e2e/appshot.mjs apps/desktop/release/appshot-verified/mac-arm64/sun-harness.app`.
The strict fixture checks a
synthetic foreground window, actual window identity, cropped and
opaque masked pixels, cancellation without persistence, the normal
composer preview and send, and the resulting owned attachment.
See [Apple's permission
instructions](https://support.apple.com/en-am/guide/mac-help/mchld6aa7d23/mac).

The native implementation uses one desktop-independent ScreenCaptureKit
window stream. It stops at the first complete frame and rechecks the
foreground identity before producing the preview. See [Apple's
window filter API](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init%28desktopindependentwindow%3A%29).
