# 022 — Browser automation, live view, takeover (phase 3)

Status: implemented. Code: `packages/core/src/browser/{cdp,browser,tools}.ts`, `host.ts` (browser methods), `docker/browser/`, desktop `Browser.tsx`, CLI `sun browser`. ADR 0008.

## Principle

Web tasks need a real browser (logins, JavaScript apps, forms), the model needs a compact text view of the page, and the human must be able to watch and take the wheel at any moment — without the agent fighting them.

## Protocol and backends

Raw Chrome DevTools Protocol over the platform WebSocket (`CdpConnection`, flat target sessions); no Playwright dependency. `BrowserManager` owns one browser per profile and one tab (own window) per harness session.

| `browser.mode` | Browser | Notes |
|---|---|---|
| `local` (default) | Chrome / Chromium / Edge / Brave found on the machine (`browser.chromePath` overrides) | `--remote-debugging-port=0`, port read from `DevToolsActivePort`; an already running browser on the same profile is reused; `headless` (default true) |
| `docker` | image `sun-harness/browser` (`docker/browser`): Debian, Chromium, Xvfb, fluxbox, x11vnc, noVNC/websockify, socat | Chromium binds DevTools to loopback; socat forwards 0.0.0.0:9223 → 127.0.0.1:9222; ports 9223 (CDP) and 6080 (noVNC) are published on 127.0.0.1 only; profile volume `~/.sun/browser/docker-profiles/<name>` |
| `cdp` | any DevTools endpoint (`browser.cdpUrl`) | e.g. a remote or self-managed browser |

Profiles persist cookies and logins: `~/.sun/browser/profiles/<profile>` (hidden from sandboxed shell commands, spec 021). `sun browser login [url]` opens the profile visibly so the user signs in once.

## Tools

| Tool | Risk | Behavior |
|---|---|---|
| `browser_navigate(url)` | network | load, wait for `load` and network quiet (≤ 8 s), return snapshot |
| `browser_snapshot()` | read | accessibility snapshot |
| `browser_click(ref)` | network | scroll into view, click the box center, settle, snapshot |
| `browser_type(ref, text, submit?, clear?)` | network | focus, clear (default), insert text, optional Enter, snapshot |
| `browser_press_key(key)` | network | Enter, Tab, arrows, `Control+a`, … |
| `browser_scroll(direction, amount?)` | read | mouse wheel, snapshot |
| `browser_back()` | read | history back, snapshot |
| `browser_screenshot(path?, full_page?)` | read | PNG into the workspace (default `screenshots/<time>.png`) |
| `browser_evaluate(expression)` | exec | JavaScript in the page, JSON result (≤ 20k chars) |

Snapshots render `Accessibility.getFullAXTree` as an indented outline: page, landmarks, headings, text, and interactive elements with refs (`button "Pay" [ref=e12]`), ≤ 14k characters. Refs map to backend DOM node ids and are replaced by each snapshot; an unknown ref asks for a new snapshot. Tools are capability-gated (offered only when a backend is available). Modes: coding, agent, assistant (not plan).

## Live view

`browserView(session, on)` starts `Page.startScreencast` (JPEG) for the session's tab and pushes one captured frame immediately (static pages send no repaint frames). Frames are broadcast as `LiveEvent {kind: 'browser'}` (≤ 4 per second per session) to the desktop, the web UI, and remote clients; they are not logged (not model-visible). Docker mode also exposes the full virtual desktop through noVNC (`vncUrl`).

## Takeover

`browserTakeover(session, true)` logs `browser/takeover {on: true}`; from then on every browser tool call of that session waits (abortable) instead of acting. The human drives through `browserInput` (click, move, wheel, key, text → `Input.dispatch*` / `Input.insertText`), from the desktop live view, or through noVNC. Handing back logs `browser/takeover {on: false}`, releases the waiting calls, and the tool result tells the model the page may have changed and to take a snapshot.

## Surfaces

Desktop: "◎ Browser" chip on sessions that used browser tools → live panel with "Take over" / "Hand back to agent" and "noVNC ↗"; transcript dividers for takeover events. CLI: `sun browser status | login [url] [--profile] | stop`. Gateway methods: `browserInfo`, `browserView`, `browserTakeover`, `browserInput`.
