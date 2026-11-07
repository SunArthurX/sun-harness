# Browser

In Agent, Assistant and Coding mode the agent can use a real browser: open pages, read them as an outline, click, type, scroll, take screenshots. You can watch it live and take over at any time.

```bash
sun browser status                  # which browser will be used
sun browser login https://github.com/login     # sign in once; the agent reuses the session
```

## Which browser

| `browser.mode` | What runs | Good for |
|---|---|---|
| `local` (default) | your installed Chrome, Chromium, Edge or Brave, headless, with its own profile | everyday tasks; uses your machine's network |
| `docker` | Chromium in a container with a virtual screen (Xvfb) and a web desktop (noVNC) | isolation from your machine; watching the full browser window |
| `cdp` | any browser you started with `--remote-debugging-port` (`browser.cdpUrl`) | special setups |

For Docker, build the image once (it is not on Docker Hub):

```bash
docker build -t sun-harness/browser docker/browser
# in mainland China: --build-arg APT_MIRROR=http://mirrors.aliyun.com
```

Then set `"browser": { "mode": "docker" }` in `~/.sun/config.json`.

Profiles keep logins between sessions: `~/.sun/browser/profiles/<name>` (`browser.profile`, default `default`). Use separate profiles for separate accounts: `sun browser login --profile work`. Shell commands the agent runs cannot read profiles (see [Shell sandbox](sandbox.md)).

## Watching and taking over (desktop)

A session that used the browser shows **◎ Browser** in its header. It opens a live view of the agent's tab.

- **Take over**: the agent's next browser action waits. Click, scroll and type directly in the live view (click it first to give it keyboard focus). Use it for logins, captchas, 2FA, or to show the agent something.
- **Hand back to agent**: the agent continues and is told that the page may have changed.
- **noVNC ↗** (Docker mode): the whole virtual desktop in your browser.

The transcript shows "you took over the browser" and "browser handed back to the agent".

## Tips

- Ask for screenshots as deliverables: "save a full-page screenshot to report/home.png".
- For pages you only need to read, the agent's `web_fetch` is faster than the browser.
- Browser clicks and typing count as network actions: in `auto-edit` approval they ask first. Use `full-auto` (or a schedule) only for sites you trust.
