# Gateway and web UI

The gateway is one background process that owns all your sessions. The desktop app, the CLI and a browser all attach to it, so:

- schedules, auto-resume and background jobs keep running when every window is closed;
- a session is never driven by two programs at once;
- you get a web UI at `http://127.0.0.1:4471`.

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
| Desktop | attaches automatically; the sidebar shows **via gateway**. Approval cards work as usual. |
| Browser | open the URL from `sun gateway url`. The token is stored in the browser and removed from the address bar. |

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
- Each device has its own token; `sun gateway token list` shows last use, `sun gateway token revoke laptop` cuts it off immediately. Only token hashes are stored.
- Browser: open `https://<host>:4471/#token=<device token>`, check the certificate warning shows the same fingerprint, and accept it.

## Chat bots

Telegram, DingTalk and webhook bots run inside the gateway; see [Chat bots](bots.md).

## Per-session approval

`sun run --approval full-auto "…"` sets the approval mode for that one session only, including when it runs through the gateway.
