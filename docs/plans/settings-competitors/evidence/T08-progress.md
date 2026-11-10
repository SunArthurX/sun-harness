# T08 gateway and browser progress

This is the interim gateway and browser checkpoint. The final verification
of the desktop selection and reconnect work is in [T08.json](T08.json).

## Verified behavior

- `packages/core/test/remote.test.ts` opens a pinned HTTPS event stream,
  revokes the only device approver, and checks that its pending approval is
  denied and later events do not reach it. It rejects an incorrect prompt
  ID and a reply without a prompt ID.
- A second real TLS certificate at the same endpoint cannot replace the
  saved pin implicitly. The prior client rejects the replacement.
- A response socket is destroyed after a message has been accepted. The
  client's retry produces one host send and one durable user message.
  Concurrent automation starts with the same request ID produce one run.
- Request IDs cannot be replayed with different payloads, after expiration,
  or against a new gateway instance. Device IDs scope receipts. A gateway
  restart preserves the installation identity and issues a new instance ID.
- The authenticated handshake rejects missing authentication and an
  incompatible protocol. A browser session cookie authorizes a same-origin
  request and loses access on device revocation.
- The served renderer exchanges the fragment token for an opaque HttpOnly
  SameSite Strict cookie. The token is absent from the address bar and
  browser local storage. Navigation and reload retain the browser session.

## Commands

- `pnpm test`
- `pnpm build`
- `pnpm typecheck`
- `node apps/desktop/e2e/settings.mjs`
- `node scripts/check-settings-plan.mjs`
- `git diff --check`

The full test suite passed with 283 tests and one pre-existing skip. The
Electron and served-web checks ran on macOS.

## Acceptance checks carried into final verification

- Start a second execution host under a separate temporary home. Use
  Electron settings to preview its certificate, explicitly confirm the
  displayed fingerprint, authenticate, and switch execution hosts. Verify
  the host label and ID, selected capability set, and that no saved
  credential reaches a renderer response.
- Set different appearance values in the two homes before connecting.
  Edit a local user preference and a remote host preference while attached.
  Verify each write compares the revision of its own store and changes
  only that file. Keep the existing same-machine gateway behavior.
- Interrupt the connection while a session and a settings form are open.
  Keep the last visible state, block host mutations, then refresh identity,
  capabilities, session state, and approvals before re-enabling writes.
  Check that events and approval replies from the previous connection
  cannot target the newly selected host.
