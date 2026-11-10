# 0014 — Private website credentials and sign-in isolation

## Context

The desktop can browse authenticated sites, and a website can reflect a
filled password into its DOM, accessibility tree, title, or pixels. The
browser also has a model-facing script tool. Masking a password input
alone cannot make that browser safe for broker-assisted sign-in.

## Decision

The macOS desktop main process uses Electron asynchronous `safeStorage`.
The system Keychain holds the encryption key. The private vault stores
ciphertext with an opaque reference and descriptive metadata. The
encrypted payload repeats the ID, revision, account label, and origin.
The broker verifies these values on decrypt so relabelling a vault
record cannot redirect a credential to another site. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

The desktop window and its trusted controls have distinct web contents
from the website. The site receives a sandboxed, temporary partition
and no preload, desktop API, or integration with the agent's browser
profile. The partition denies cross-origin requests, popups, downloads,
and device permissions. A single-use fill grant binds the reference's
revision and the observed top-level document. The broker rechecks after
decryption. The isolated renderer world checks the exact document and
origin again at the field write. The user submits the form privately.
[Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security)

Main-process IPC validates the sender, main frame, and settings protocol.
The private window exposes only its status, fill, and close methods.
The gateway and model never receive a vault method. Appshot capture
checks the private-window state both before and after native capture.

## Consequences

The workflow supports top-level HTTPS login forms on the reviewed origin.
The authenticated session stays isolated for the window's lifetime.
Agent browsing uses the established manual takeover flow when it needs
an authenticated profile. The normal application rollback preserves
the ciphertext and session data. Updating or deleting an entry
invalidates grants for that revision. A system-key failure denies save
and fill. The local user can still delete an encrypted entry.
