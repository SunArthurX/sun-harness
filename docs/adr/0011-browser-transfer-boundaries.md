# 0011 — Browser transfer boundaries

## Context

The browser retains logins across harness sessions and supports Chromium
on the execution host, in Docker, or behind an external DevTools
endpoint. Giving a browser an arbitrary filesystem path would couple
the browser and host filesystems. Ordinary Chromium downloads choose
their own destination and are not bounded by harness session policy.

## Decision

Use revisioned, independent origin grants for browse, upload, and
download. Bind agent actions to one managed tab generation and the
current lease. For upload, transmit the user-reviewed bytes over
DevTools to an isolated world and set a current file input. Consume
the host's in-memory approval before dispatch.

For download, intercept a dedicated Chromium target's GET and every
redirect, using the original profile's network and login. Stream its
final response to an exclusively created host staging file. Block
native downloads in managed Chromium contexts. Apply the
context-wide policy to an external browser only after explicit
delegation. An exclusive owner record is held for each managed
profile and endpoint. Older Chromium builds restore the default
download behavior on DevTools disconnect. A second controller could
otherwise reset the first controller's policy.

## Consequences

Transfers work when the harness and browser filesystems differ.
The runtime never imports or returns browser cookies. After upload
dispatch, the approved website can read the file. Downloads support
HTTP and HTTPS links and return receipts for host-owned staged
files. Approval is short-lived and transfers can be retried after
a new review. Existing external browser deployments must explicitly
delegate a dedicated context before using the managed browser.
