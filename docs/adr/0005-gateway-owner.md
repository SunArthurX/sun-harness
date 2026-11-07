# 0005 — A gateway process owns sessions; surfaces are clients

## Context

The CLI and the desktop each ran an in-process host. Two hosts over one `~/.sun` could drive the same session concurrently, and schedules, auto-resume and background jobs only ran while a window was open.

## Decision

`sun serve` hosts sessions behind a token-protected localhost HTTP + SSE API. Every surface (CLI, desktop, web) attaches when a gateway is reachable and falls back to in-process hosting when not. The method table (`hostMethods`) is shared by desktop IPC and the HTTP API so the two cannot drift. A launchd service keeps the gateway running at login.

## Consequences

- One writer per session log when the gateway is used; background work survives closing windows.
- A web UI comes for free (the renderer plus a fetch/EventSource bridge).
- Without a gateway, behavior is unchanged; running two in-process hosts at once remains possible and is documented as unsafe.
- Remote access beyond localhost is intentionally not offered yet (token auth only, no TLS).
