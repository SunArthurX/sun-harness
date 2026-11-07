# 0006 — Remote access uses a self-signed certificate pinned by fingerprint

## Context

The gateway must be reachable from other devices on the LAN (and later the internet). A personal machine has no public domain for a CA-issued certificate, and plain HTTP would expose tokens and transcripts.

## Decision

The gateway generates its own certificate (openssl, EC P-256). Clients trust exactly that certificate: they compare its SHA-256 fingerprint with the one the owner reads off the gateway (`sun gateway token create` prints it), store the certificate, and on every connection use it as the only CA and re-check the fingerprint. Non-loopback binding without TLS is refused. Each device has its own revocable token; only hashes are stored.

## Consequences

- No CA, no domain, no renewal service; trust is explicit and per device.
- Browsers show a certificate warning that the user must check against the fingerprint.
- A changed certificate (regenerated `~/.sun/tls`) breaks clients by design; they must be re-added.
