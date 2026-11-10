# 004 — Desktop app

Status: implemented (M3). Code: `apps/desktop`.

## Architecture

- Electron main process hosts one `HarnessHost` (core is bundled into the main bundle). The renderer never touches Node.
- IPC: one `sun:call` channel restricted to the allowlist in `src/shared/api.ts`; live events on `sun:live`. Preload uses `contextBridge` with `contextIsolation`, `sandbox`, no `nodeIntegration`.
- The desktop window registers as the approver; when it closes, runs become headless (approvals are denied, see 008).
- The background tick (60 s) runs auto-resume, due schedules, and the daily intel catch-up.
- Credentials: imported from `~/.sun/.env` and simple `export NAME=value` lines in shell rc files (see `env.ts`), because GUI apps do not inherit the login shell.

## Screens

| Screen | Purpose |
|---|---|
| Welcome | Pick mode (Coding / Agent / Assistant) and workspace, start a session |
| Session | Streaming transcript, reasoning, tool cards (expand for args/output), todo plan, approval cards (Allow / Always / Deny), paused/error banner with Resume and Switch-model-and-resume, mode and model selectors, token counter, queued follow-ups, Stop |
| Knowledge | Search all providers, add notes, edit memory |
| Skills · MCP · Plugins | Skills with scope, MCP server status/tools with reconnect, plugin status/contributions, schedules |
| Evolution | Pending proposals (accept/reject), history, reflect on current session |
| Harness Intel | Daily reports, run now, analyze pending |
| Settings | Language (system / English / Simplified Chinese), default model, fallback chain, auto-resume, approval mode, deny-instead-of-prompting, max steps, providers, KB roots, company KB, intel time |

## Rendering rule

Every live event must be applied to the transcript; the chat view subscribes directly and merges by `seq` with its initial snapshot (a shared React state value drops batched events).

Decision — The current task plan is pinned above the scrolling transcript on
desktop and gateway web. The plan has its own bounded scroll area so long
plans and short windows keep the transcript and approval actions reachable.
The chat header wraps its controls in narrow windows so the worktree button
remains reachable when titles or workspace paths are long.

Decision — Quitting the desktop app waits for host disposal before the
process exits, bounded to five seconds. Disposal closes browser tabs and
stops the managed Chromium, sandboxes, Python kernels and MCP servers, which
are not terminated with the Electron process on macOS. Without the wait, a
managed Chromium outlived the app and kept writing to its profile. Browser
disposal itself waits up to five seconds for the managed Chromium process to
exit after `SIGTERM`, then sends `SIGKILL`, and only then releases the
profile (see 022). After disposal, the app requests the quit again in a later
event-loop task. When the quit started from a `SIGTERM`, a quit requested in
the same task closed the windows but left the app running.

## Visual language

Warm dark "solar instrument" theme: ink background, single amber accent, Instrument Serif display, Hanken Grotesk body, JetBrains Mono for code. Fonts are bundled (offline).

## Verification

`apps/desktop/e2e/smoke.mjs` launches the built app with a temporary `SUN_HOME`, runs a live session that requires approvals, asserts the UI matches the log, pauses a session on a rejected key and recovers it with **Switch & resume**, and screenshots every screen.
