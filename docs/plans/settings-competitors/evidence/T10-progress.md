# T10 browser permissions and ownership checkpoint

This checkpoint records the first part of T10. It covers the
execution-host origin policy, managed profile identity, and tab control.
[T10.json](T10.json) records the completed file-transfer acceptance.

## Behavior exercised

- Local Chromium completed navigation, history, typing, clicking, and
  screenshots. A denied redirect destination received zero requests.
  Allowing upload at that destination did not allow browsing. After
  the browse grant was saved the same redirect succeeded. Revoking the
  grant prevented further observation.
- Embedded document requests also hit the origin gate. Chromium could
  send a popup's initial request before an ordinary target-close event.
  The target is now paused at startup and closed while paused. The
  unapproved popup destination received zero requests in the fixture.
- Two sessions had separate targets. A frame from one session could not
  acquire the other session's control. A queued action, old element
  reference, old frame, or released control token could not act.
  An agent command after handback needed a new snapshot.
- Electron and gateway web each saved an independent upload rule from a
  URL containing a path and query, verified its normalized origin,
  and reset the rule to Ask.
- A real Docker Chromium fixture denied a new origin, allowed it after
  review, and confirmed that a second connection could reuse the same
  managed profile without closing the original connection's tab.

The implementation uses Chromium's
[Fetch domain](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Fetch.pdl)
and
[target startup throttling](https://chromium.googlesource.com/chromium/src/+/74af9a4f8f0ba7531aaa5cb3c62e311b3c2104e1/content/browser/devtools/protocol/target_handler.cc).
Policy governs browser documents and future harness file transfers.
Ordinary subresources continue to use Chromium's networking.

## Reproduction

- `pnpm exec vitest run packages/core/test/browser.test.ts` exercises the
  local Chromium fixtures and the revisioned origin store.
- `node apps/desktop/e2e/settings.mjs` exercises the desktop and web
  settings routes after `pnpm build`.
- `sun browser permissions set https://example.com download allow --local`
  followed by the same command with `ask` exercises the CLI state
  transitions in an isolated `SUN_HOME`.

## Acceptance checklist carried into the transfer slice

1. Define the bounded transfer contract in spec 022 before wiring it
   into the browser tools. State the supported transfer adapters,
   cancellation behavior, byte and time budgets, and staging lifecycle.
2. Make upload authorization a human operation for the exact file,
   session, origin, and current document. Bind an opaque single-use
   handle to the reviewed bytes and the current tab generation and
   lease. Reject raw paths in tool arguments. Recheck the current
   origin, decision, ownership, and lease before setting a file input.
   Exercise missing, expired, reused, cross-session, replaced-file,
   symlink, revoked-origin, and takeover cases. For remote execution,
   prove where approved bytes live before advertising upload capability.
3. Route downloads through bounded staging on the execution host.
   Separate the browse decision from the download decision. Recheck the
   request and every redirect before dispatch, including the actual
   source origin. Prove that ambient browser downloads cannot bypass
   the action decision. Generate a server-owned name and write
   exclusively to an owned directory. Treat advertised names as display
   metadata. Stream with byte, time, and concurrency limits and remove
   partial files after a rejection, timeout, disconnect, or takeover.
   Cover traversal, symlinks, oversized and chunked responses, and
   permission changes during a transfer.
4. Exercise approved transfers and failure paths in real Chromium,
   and exercise unsupported backend states on the desktop and web.
   Keep any credentials or transfer data out of permission audits.
5. Record the complete AC-11 results in T10.json. Update the browser
   manual, teaching page and index, roadmap, and changelog before
   marking T10 done.

Rollback for the checkpoint is a version rollback of the runtime and
clients. Existing session logs and browser profiles stay in place.
Origin decisions are stored separately in
`$SUN_HOME/settings/browser-permissions.json`.
