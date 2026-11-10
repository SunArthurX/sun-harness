# 022 — Browser automation, live view, takeover (phase 3)

Status: implemented. Code: `packages/core/src/browser/{cdp,browser,tools}.ts`, `host.ts` (browser methods), `docker/browser/`, desktop `Browser.tsx`, CLI `sun browser`. ADR 0008.

## Principle

Web tasks need a real browser (logins, JavaScript apps, forms), the model needs a compact text view of the page, and the human must be able to watch and take the wheel at any moment — without the agent fighting them.

## Protocol and backends

Raw Chrome DevTools Protocol over the platform WebSocket (`CdpConnection`, flat target sessions); no Playwright dependency. `BrowserManager` owns one browser per profile and one tab (own window) per harness session.

| `browser.mode` | Browser | Notes |
|---|---|---|
| `local` (default) | Chrome / Chromium / Edge / Brave found on the machine (`browser.chromePath` overrides) | `--remote-debugging-port=0`, port read from `DevToolsActivePort`; an already running browser on the same profile is reused; `headless` (default true) |
| `docker` | image `sun-harness/browser` (`docker/browser`): Debian, Chromium, Xvfb, fluxbox, x11vnc, noVNC/websockify, socat | Chromium binds DevTools to loopback; socat forwards 0.0.0.0:9223 → 127.0.0.1:9222; ports 9223 (CDP) and 6080 (noVNC) are published on 127.0.0.1 only; profile volume `~/.sun/browser/docker-profiles/<name>` |
| `cdp` | any DevTools endpoint (`browser.cdpUrl`) | e.g. a remote or self-managed browser |

Managed profiles persist cookies and logins under
`~/.sun/browser/profiles/<profile>` or `~/.sun/browser/docker-profiles/<profile>`
(hidden from sandboxed shell commands, spec 021). The execution host
reports profile ownership and its managed location. Local reuse verifies
the Chromium identity in the profile's endpoint file. Docker reuse and
stop require the expected owner label and the matching profile mount.
External DevTools endpoints retain the original browser's profile
ownership. The harness creates only its own session windows there.
`sun browser login [url]` opens a user-operated sign-in window for a
local or Docker profile.

## Browser permissions

Decision (T10): the execution host stores separate browse, upload, and
download decisions for normalized HTTP and HTTPS origins. Origin identity
includes the scheme, host, and effective port. New origin/action pairs
require explicit user approval. A denied or unapproved document request
is stopped before dispatch, including redirect destinations. The denied
operation reports the origin and action so the user can review it and
retry. Page observation and input also recheck the active document.
This includes embedded document requests. Popups opened by managed
documents are closed at target startup to preserve session ownership.
Ordinary page subresources retain the browser's own network behavior.
Origin rules and pending reviews are available in **Settings → Browser
permissions** and through `sun browser permissions`. Upload and download
execution follow the transfer contract below.

## Bounded file transfers

Decision (T10): file picking for managed tabs belongs to the harness
renderer. Chromium's native file chooser is suppressed in those tabs.
The renderer previews the selected file's name, size, and exact current
origin before confirmation. Confirmation sends the selected bytes over
the existing authenticated desktop or gateway channel. The execution
host retains at most one approved file per tab, up to 5 MiB, for five
minutes, with a total pending budget of 25 MiB. The approval is bound
to the session, normalized origin, tab generation, document, and control
lease. There is no filesystem-path tool argument. Tab replacement,
navigation, control change, expiry, and consumption invalidate the handle.
Browse and upload grants are rechecked before bytes enter the page.
The file is set on a current top-level file-input ref in a Chromium
isolated world. The website can read those bytes after delivery, including
through its input and change event handlers. The upload path
omits file bytes and browser credentials from logs, audits, and model
input.

Decision (T10): explicit downloads use Chromium's authenticated network
in a separate ephemeral target for a current session and document. A
request-stage check authorizes the current page and each download URL,
including redirect destinations, before dispatch. A final response is
streamed to the execution host without navigating the session tab or
letting Chromium's ordinary download manager pick a path. The host allows up to five redirects and 20 MiB per download, with a
30-second transfer deadline and at most two concurrent downloads, one
per session. Staging uses server-owned
identifiers, exclusive creation and validated regular directories; the
site's suggested filename is display metadata. A session can retain
up to 20 staged files. Incomplete staging files left by a crash are
reclaimed on a later transfer after ten minutes. A partial file is removed
when the transfer fails or loses its permission or control lease. A
completed receipt names the session-owned staged file and its byte count.
Chromium's native downloads in managed browser contexts are blocked,
including links and blob downloads. An external browser context must be
explicitly delegated via `browser.cdpAllowDownloadPolicy: true` before
the harness applies context-wide download policy. A context without that delegation cannot run managed browser tools.
The host holds exclusive ownership while a managed profile or delegated
DevTools context is active. Another harness connection can reuse the
profile after release. Chromium versions that reset a download override
when a connection closes cannot weaken a concurrent harness connection.

Decision — disposing a host stops a Chromium it launched before releasing
the profile. It sends `SIGTERM`, waits up to five seconds for the process to
exit, then sends `SIGKILL`. A released profile is therefore no longer
written by the previous browser, so a restart, another harness connection,
or a storage purge cannot race its shutdown writes. A launch that does not
publish its DevTools port within 10 seconds stops the spawned Chromium the
same way before it reports the error, so a retry cannot orphan it.

## Tools

| Tool | Risk | Behavior |
|---|---|---|
| `browser_navigate(url)` | network | load, wait for `load` and network quiet (≤ 8 s), return snapshot |
| `browser_snapshot()` | read | accessibility snapshot |
| `browser_click(ref)` | network | scroll into view, click the box center, settle, snapshot |
| `browser_type(ref, text, submit?, clear?)` | network | focus, clear (default), insert text, optional Enter, snapshot |
| `browser_press_key(key)` | network | Enter, Tab, arrows, `Control+a`, … |
| `browser_scroll(direction, amount?)` | read | mouse wheel, snapshot |
| `browser_back()` | read | history back, snapshot |
| `browser_screenshot(path?, full_page?)` | read | PNG into the workspace (default `screenshots/<time>.png`) |
| `browser_uploads()` | read | list the current session’s user-approved upload handles |
| `browser_upload(ref, handle)` | network | consume an approved handle into a current top-level file input |
| `browser_download(url)` | network | GET through the browser profile into session-owned host staging |
| `browser_evaluate(expression)` | exec | JavaScript in the page, JSON result (≤ 20k chars) |

Snapshots render `Accessibility.getFullAXTree` as an indented outline with
opaque element refs and a 14,000-character limit. Refs are bound to one
tab generation and snapshot. Navigation, replacement, and takeover
invalidate them. Tools are available in coding, agent, and assistant mode
when the browser backend is available.

## Live view

`browserView(session, on)` starts `Page.startScreencast` (JPEG) for the session's tab and pushes one captured frame immediately (static pages send no repaint frames). Frames are broadcast as `LiveEvent {kind: 'browser'}` (≤ 4 per second per session) to the desktop, the web UI, and remote clients; they are not logged (not model-visible). Docker mode also exposes the full virtual desktop through noVNC (`vncUrl`).

## Takeover

Decision (T10): takeover binds a private control token to the current
managed tab and invalidates the agent's write lease. Agent calls made
during takeover fail without being queued for replay. Input requires the
control token and the current live frame from the owning session.
Handing back releases the control token and requires a fresh agent
snapshot before further actions. Takeover and handback remain durable
session events.

## Surfaces

Desktop: "◎ Browser" chip on sessions that used browser tools → live panel with **Take over** and **Hand back to agent**. The transcript shows takeover events. The CLI offers `sun browser status`, `login`, `stop` and `permissions`. Gateway methods include `browserInfo`, `browserView`, `browserTakeover`, `browserInput`, `browserPermissions` and `updateBrowserPermission`. Docker's noVNC sign-in window is opened through the CLI.
