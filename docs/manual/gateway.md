# Gateway and web UI

The gateway is one background process that owns all your sessions. The desktop app, the CLI and a browser all attach to it, so:

- schedules, auto-resume and background jobs keep running when every window is closed;
- a session is never driven by two programs at once;
- you get a web UI at `http://127.0.0.1:4471` (the same screens as the desktop, including English / Simplified Chinese).

## Run it

```sh
sun serve                       # foreground; prints the web URL with its token
sun gateway install             # as a login service (macOS launchd), always on
sun gateway status              # running? where? since when?
sun gateway url                 # web UI link including the token
sun gateway uninstall
```

`install` copies a self-contained CLI to `~/.sun/bin/sun.mjs` and the web UI to `~/.sun/web`. Run it again after upgrading sun-harness. Logs: `~/.sun/gateway.log`.

## Attaching

| Surface | Behavior when a gateway is running |
|---|---|
| CLI | `sun`, `sun run`, `sun resume`, `sun sessions` go through the gateway. Add `--local` to run in-process instead. |
| Desktop | attaches automatically to a same-machine gateway. Use **Settings → Connections** to select a separate execution host. |
| Browser | open the URL from `sun gateway url`. The gateway exchanges the fragment token for an HttpOnly session cookie and removes the token from the address bar. |

Without a gateway, the CLI and the desktop work on their own as before. Avoid running both in-process at the same time on the same session.

## Security

By default the gateway listens on `127.0.0.1` only, and every API call needs a token: the owner token in `~/.sun/gateway.json` (file mode 0600) or a device token.

## Remote access (other devices)

```sh
sun gateway install --tls --host 0.0.0.0      # HTTPS on your LAN; self-signed certificate in ~/.sun/tls
sun gateway token create laptop               # prints a device token once, plus ready-to-paste commands
```

On the other machine (with sun-harness installed):

```sh
sun remote add home https://192.168.1.20:4471 --token sund_… --fingerprint BC:03:55:…
sun remote list                               # * marks the default remote
sun run "Summarize today's intel report"       # runs on the home gateway
sun remote use home | sun remote off          # choose the default, or go back to local
sun run --remote home "…"                     # one-off
```

- The gateway refuses to listen on a non-loopback address without TLS (`--insecure` overrides; don't).
- Clients pin the certificate: `remote add` refuses a certificate whose fingerprint differs from `--fingerprint`, and later connections fail if it changes.
- Each device has its own token. `sun gateway token list` shows last use.
  `sun gateway token revoke laptop` stops new requests and disconnects live
  event streams. Pending approvals are denied if no authorized approver remains.
  The gateway stores only the device token hashes.
- In a browser, open `https://<host>:4471/#token=<device token>` and confirm the
  certificate fingerprint. Browser sessions expire within 24 hours or when
  the gateway restarts. Open the token link again to sign in.
- On a temporary response loss, current clients retry session creation, a
  message send, or an automation start with the same request ID. When the
  gateway instance changes, check the session or automation history before
  submitting the operation again.

### Select a separate execution host in desktop

1. Open **Settings → Connections** and enter the HTTPS gateway address.
2. Select **Preview certificate**. Compare the displayed fingerprint with
   the one printed on the execution host. Confirm the match.
3. Enter a connection name and a device token. Select **Trust and connect**.

The panel shows the selected profile and the authenticated host identity.
The desktop stores the device token in its private remote registry. The
desktop selection is separate from the CLI default. Use **Use this
computer** to return to the in-process host or same-machine gateway.

Appearance, language, notifications, shortcuts, read-aloud and Mini
preferences stay on the desktop computer when you select a separate host.
Runtime settings, workspaces and sessions belong to the selected host.
On a connection interruption, the desktop keeps visible settings and
drafts. It pauses host writes until the connection has refreshed.

## Chat bots

Telegram, DingTalk and webhook bots run inside the gateway; see [Chat bots](bots.md).

## Per-session approval

`sun run --approval full-auto "…"` sets the approval mode for that one session only, including when it runs through the gateway.

## Session transfer

`sun export --format bundle` and `sun import` transfer portable session
bundles as binary streams when attached to a gateway. The receiving host
validates the archive and assigns a new session ID. Use `--cwd` with an
absolute directory on the receiving host when the original workspace is
unavailable. The same owner and device credentials used for session calls
authorize bundle transfers.

## Remote jobs

Trusted gateway installations appear in [Execution targets](execution-targets.md).
Jobs use a session and workspace on the selected host. The controller
queries the same operation after a disconnect.
