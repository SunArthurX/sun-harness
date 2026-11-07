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

The gateway listens on `127.0.0.1` only, and every API call needs the token in `~/.sun/gateway.json` (file mode 0600). Don't expose it on other interfaces: `--host 0.0.0.0` has no TLS.

## Per-session approval

`sun run --approval full-auto "…"` sets the approval mode for that one session only, including when it runs through the gateway.
