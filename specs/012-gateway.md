# 012 — Gateway: one owner for every session

Status: implemented (iteration 5). Source: Hermes Agent 0.23 (one gateway process owns every session; CLI, TUI, desktop and bots attach as clients). It also closes the MVP gap that schedules ran only while the desktop was open.
Code: `packages/core/src/gateway.ts` (`hostMethods`, `startGateway`, `findGateway`, `GatewayClient`, `RemoteHost`), CLI `serve` / `gateway`, desktop `main/index.ts` (attach), renderer `web-bridge.ts`.

## Problem

Each surface used to run its own `HarnessHost`. Two hosts on one `SUN_HOME` can run the same session at once (double appends, lost approvals), and background work (schedules, auto-resume, jobs) lived and died with whichever window was open.

## Design

- `sun serve [--port 4471] [--host 127.0.0.1]` runs one `HarnessHost` with the background tick (auto-resume, schedules, intel catch-up) and jobs, behind HTTP:
  - `POST /api/call {method, args}` → `{ok, result}` | `{ok: false, error}`. The method table is `hostMethods(host)`, shared with the desktop IPC.
  - `GET /api/events` → Server-Sent Events of every `LiveEvent`; the first event is `{kind: "notice", text: "connected"}` and clients wait for it before sending, so no early output is missed. `?approver=1` registers the connection as an approver until it closes.
  - `GET /api/health` → `{ok, home, version, pid}`.
  - Any other path serves the built web UI (`apps/desktop/out/renderer`, or `~/.sun/web`), with path traversal blocked.
- Security: binds `127.0.0.1` by default; every API request needs the bearer token (header, or `?token=` for EventSource). The gateway writes `~/.sun/gateway.json` (`url`, `token`, `pid`, mode 0600) and removes it on clean shutdown.
- Discovery: `findGateway()` reads `gateway.json` and requires a healthy response **for the same `SUN_HOME`**; stale files are ignored. `SUN_NO_GATEWAY=1` disables attaching.

## Clients

- **CLI**: `chat`, `run`, `resume`, `sessions` attach through `RemoteHost` when a gateway is found (`--local` forces in-process). Interactive terminals connect as approvers.
- **Desktop**: on start, attaches if a gateway is found (handlers proxy to `GatewayClient`; events stream with `approver=1`), otherwise hosts in-process as before. The sidebar shows "via gateway".
- **Web**: opening `http://127.0.0.1:4471/#token=…` loads the same React app; `web-bridge.ts` implements `window.sun` over fetch + EventSource, stores the token in `localStorage` and clears it from the URL. Folder picking is a text prompt; "open path" copies the path.

## Per-session approval

`createSession({ approval })` stores the mode in `session/meta.approval`; it overrides `config.approval` for that session and its subagents. `sun run --approval …` uses this (it no longer mutates global config).

## Service

`sun gateway install` copies the CLI bundle to `~/.sun/bin/sun.mjs` and the web UI to `~/.sun/web`, and installs `~/Library/LaunchAgents/com.sun-harness.gateway.plist` (`RunAtLoad`, `KeepAlive`, log `~/.sun/gateway.log`). `sun gateway status | url | uninstall`.
