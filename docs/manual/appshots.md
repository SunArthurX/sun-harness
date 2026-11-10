# Appshots

Appshots capture a single foreground window on the macOS desktop app.
They require macOS 13 or later and a local execution host.

1. Open **Settings → Appshots** and enable Appshots. The first capture
   can ask for Screen Recording permission. If access is denied, grant
   it to Sun Harness in **System Settings → Privacy & Security → Screen & System
   Audio Recording**, then reopen the app.
2. Open the chat that should receive the Appshot. **Capture Appshot** in
   the composer captures a foreground Sun Harness window. For another
   app, set a **Global Appshot shortcut** in Settings and press it while
   that app's window is in front.
3. Verify the actual window name in **Review Appshot**. Use **Crop area**
   or **Cover area** and drag on the preview. Clear **Include captured
   text** to exclude it. Cropping or covering any part also excludes the
   captured text.
4. Choose **Attach prepared Appshot** to put the edited image in the
   composer. Review the thumbnail, then send the message. **Cancel** or
   **Remove Appshot** discards the private draft.

The app reads text from the matching focused window when macOS
Accessibility access is already available. Otherwise the preview labels
the capture as image-only. Text-only models receive the approved window
description and any included text. The image remains in the session
for later use with a vision model.

A draft expires after five minutes. Wait for a running response to
finish before sending the Appshot. After sending, the prepared image
is part of the chat and included in portable session bundles. The web
client and desktop sessions attached to a gateway can replay existing
attachments.

For native build and verification on macOS:

```bash
pnpm build
pnpm --filter @sun/desktop run package
node apps/desktop/e2e/appshot.mjs
```

The packaged verification uses a temporary chat and a synthetic
foreground window. It requires Screen Recording access for that build.
To test a bundle at another path, pass the `.app` path as the first
argument to `appshot.mjs` and grant Screen Recording to that bundle.

The supplemental `node apps/desktop/e2e/appshot.mjs --boundary-only`
checks package signing, the default-off state, OS shortcut registration
and native opaque redaction on synthetic pixels. It reports the
permission state and does not exercise foreground capture.
