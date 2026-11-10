# Browser

In Agent, Assistant and Coding mode the agent can use a real browser: open pages, read them as an outline, click, type, scroll, take screenshots. You can watch it live and take over at any time.

```bash
sun browser status                  # which browser will be used
sun browser login https://github.com/login     # sign in to the managed profile
sun browser permissions                       # list rules and pending origin reviews
```

## Which browser

| `browser.mode` | What runs | Good for |
|---|---|---|
| `local` (default) | your installed Chrome, Chromium, Edge or Brave, headless, with its own profile | everyday tasks; uses your machine's network |
| `docker` | Chromium in a container with a virtual screen (Xvfb) and a web desktop (noVNC) | isolation from your machine; watching the full browser window |
| `cdp` | a dedicated Chromium DevTools browser with a delegated download policy | special setups |

For Docker, build the image once (it is not on Docker Hub):

```bash
docker build -t sun-harness/browser docker/browser
# in mainland China: --build-arg APT_MIRROR=http://mirrors.aliyun.com
```

Then set `"browser": { "mode": "docker" }` in `~/.sun/config.json`.

Managed profiles keep logins between sessions. Open **Settings → Browser
permissions** to see the profile owner and location on the execution
host. For a separate local profile, use `sun browser login --profile work`
and configure `browser.profile` to select it. Docker manual sign-in uses
the noVNC URL printed by `sun browser login`. Sign in to external DevTools
profiles in the browser that owns them. Set `browser.cdpAllowDownloadPolicy`
to `true` for the dedicated external profile. This gives Sun Harness
control of the Chromium context's native download setting, including
other windows in that context. A profile has one active Sun Harness
controller. The next controller can reuse the profile after the first
releases it. See [Shell sandbox](sandbox.md) for profile storage
isolation.

## Website permissions

An origin includes the protocol, hostname, and effective port. For
example, `http://localhost:3000` and `http://localhost:8080` require
separate review. When a new document origin needs approval, open
**Settings → Browser permissions**, review the pending request and
choose **Allow** or **Deny**. Retry the browser action after allowing it.
A redirect can require its own review. **Reset to Ask** clears a saved rule.

```bash
sun browser permissions set https://github.com browse allow
sun browser permissions set https://github.com browse ask
```

Browse, upload, and download each have independent rules.

## Uploading a file

1. Open the website in the session's **◎ Browser** panel.
2. Use **Choose a browser upload**. Review the file name, size, and website
   in the preview. Select **Approve file for this page**.
3. Ask the agent to use the approved file. The agent can select it in
   the site's current file input once. The site can read the selected file
   as soon as the input receives it.

Uploads are limited to 5 MiB. Select the file again if the page changes,
control changes, an origin rule changes, or five minutes pass. If the
site needs an upload grant, review the origin in **Browser permissions**
before selecting the file again. In the gateway web UI, the picker
selects a file from the client and sends the approved bytes to the
execution host. The browser and host can run on different machines.

## Downloading a file

Ask the agent to download an HTTP or HTTPS link. Approve the download
action for the current website and any new redirect destinations. The
agent reports the staged file's name, size, and location on the execution
host. Download requests use the browser profile's existing login.
Files are limited to 20 MiB each, with at most 20 staged files per session.
They appear under `$SUN_HOME/browser/downloads/<session-id>/`. Move or
remove completed files there when you no longer need them. Website
filenames appear in the download receipt. The host generates the actual
staging filename.

Chromium's native download manager is disabled in managed profiles. Use
the agent download action for supported HTTP and HTTPS links.

## Watching and taking over

A session that used the browser shows **◎ Browser** in its header. It
opens a live view of the session's tab.

- **Take over** gives one viewer control. Click the live view to give it
  keyboard focus. Browser actions submitted by the agent during takeover
  stop and can be retried after handback.
- **Hand back to agent** releases control. The agent takes a fresh
  snapshot before using browser controls again.

The transcript shows "you took over the browser" and "browser handed back to the agent".

## Tips

- Ask for screenshots as deliverables: "save a full-page screenshot to report/home.png".
- For pages you only need to read, the agent's `web_fetch` is faster than the browser.
- Browser clicks and typing count as network actions: in `auto-edit` approval they ask first. Use `full-auto` (or a schedule) only for sites you trust.
