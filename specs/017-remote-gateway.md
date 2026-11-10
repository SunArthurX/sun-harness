# 017 — Remote gateway: TLS, device tokens, pinned clients

Status: implemented (iteration 10). Extends `specs/012-gateway.md`. ADR `docs/adr/0006-pinned-self-signed-tls.md`.
Code: `packages/core/src/remote.ts`, `gateway.ts` (`startGateway` TLS + device auth, `pinnedFetch`), CLI `serve --tls`, `gateway token`, `remote`.

## Server

- `sun serve --tls [--host 0.0.0.0] [--port 4471]` serves HTTPS with `~/.sun/tls/{cert,key}.pem`, created on first use with openssl: EC P-256, 825 days, SAN = localhost, 127.0.0.1, LAN IPv4 addresses and `--host`. The key is mode 0600. The SHA-256 fingerprint is printed at start-up.
- Binding any non-loopback address **without TLS is refused**; `--insecure` overrides (documented as unsafe).
- `sun gateway install --tls --host 0.0.0.0` passes the flags to the launchd service.
- `gateway.json` records the certificate and fingerprint so local clients (desktop, CLI) can pin it too.

## Device tokens

- `sun gateway token create <device>` creates `sund_…` (24 random bytes, base64url), shows it **once**, and stores only its SHA-256 in `~/.sun/gateway-devices.json` (0600) with `id, name, createdAt, lastUsedAt`. It prints ready-to-paste `sun remote add` commands for each LAN address, including the fingerprint.
- `token list`, `token revoke <id|name>`. The gateway accepts the owner token or any non-revoked device token (constant-time hash comparison) on every request; revocation takes effect immediately.
- Decision (T08): device updates are atomic across cooperating processes. A revoked device loses active event streams and any approval that no remaining approver can answer. Gateway approvals require the current prompt ID. See spec 032 for connection identity and retry rules.

## Clients

- `sun remote add <name> <url> --token <t> [--fingerprint <sha256>]` fetches the server certificate without trusting it, compares it with `--fingerprint` (case and separators ignored) and refuses to save on mismatch. Without `--fingerprint` it trusts on first use and says so. Remotes live in `~/.sun/remotes.json` (0600) with the pinned certificate.
- Decision (T08): the CLI validates the authenticated protocol handshake before saving a remote. Saved profiles include the authenticated installation identity. Desktop selection is separate from the CLI default.
- Connections to an https remote trust **only** the pinned certificate (`ca`), verify its fingerprint in `checkServerIdentity` and again on the response socket, and never reuse pooled sockets.
- `sun remote list | use <name> | off | remove <name>`. Session commands pick: `--local` → `--remote <name>` → default remote → local gateway → in-process. A remote coding session without `--cwd` uses the gateway's `~/.sun/workspace`.
- Browsers: open `https://<host>:<port>/#token=<device token>` and accept the self-signed certificate after checking its fingerprint.
