# 0012 — Appshot capture and replay

## Context

Appshots contain private screen and application data. Capture and image
editing need desktop APIs, while the execution host owns the session
log and all model-visible attachments. A long-lived screen stream would
increase the amount of private data the app handles.

## Decision

Use a narrow Electron adapter to launch a signed macOS helper. Select
one foreground window and ask ScreenCaptureKit for its pixels through a
desktop-independent window filter. Stop the stream after the first
complete frame and recheck the target. When macOS reports a new window
from the same process immediately after stopping the stream, wait briefly
for the capture indicator to clear and recheck the original window ID.
Use the available Accessibility
text only when the focused window matches the capture. A composer
request restricts the capture to the current desktop app process.
The global shortcut captures before raising Sun Harness.

Hold raw pixels and text in an expiring execution-host draft. Apply
opaque masking and cropping in the desktop process. Keep only the
prepared version for sending and remove captured text when image edits
are present. Persist the image, hash and actual capture metadata before
model dispatch. Replay checks the stored file and hash. Keep native
capture and its approval handles off gateway routes.

## Consequences

Appshots are local-only capture on supported macOS desktops. The
window metadata and edited image remain portable after the user
sends them. Denied Screen Recording, a missing foreground window,
and missing or modified replay bytes have distinct outcomes.
The first native implementation uses one frame from an SCStream so
the macOS 13 SDK can build the helper.
