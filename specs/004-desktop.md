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
| Settings | Default model, fallback chain, auto-resume, approval mode, deny-instead-of-prompting, max steps, providers, KB roots, company KB, intel time |

## Rendering rule

Every live event must be applied to the transcript; the chat view subscribes directly and merges by `seq` with its initial snapshot (a shared React state value drops batched events).

## Visual language

Warm dark "solar instrument" theme: ink background, single amber accent, Instrument Serif display, Hanken Grotesk body, JetBrains Mono for code. Fonts are bundled (offline).

## Verification

`apps/desktop/e2e/smoke.mjs` launches the built app with a temporary `SUN_HOME`, runs a live session that requires approvals, asserts the UI matches the log, pauses a session on a rejected key and recovers it with **Switch & resume**, and screenshots every screen.
