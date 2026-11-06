# 006 — Evolution

Status: implemented (M4). Code: `packages/core/src/evolution.ts`.

## Principle

The harness improves from its own use and from the field, but **never silently**: every change is a proposal the owner accepts.

## Proposals

`~/.sun/evolution/proposals/<id>.json`: `{ type, title, content, rationale, source: {kind: session|intel|manual, ref}, status: pending|accepted|rejected }`. De-duplicated by type + title.

| Type | Accepting it… |
|---|---|
| `memory` | appends a fact to `~/.sun/memory/MEMORY.md` under `section` |
| `skill` | creates `~/.sun/skills/<skillName>/SKILL.md` (immediately loadable) |
| `rule` | appends to `~/.sun/AGENTS.md` (global rules for every session) |
| `feature` | appends to `~/.sun/evolution/backlog.md`; becomes a spec before code |

Every acceptance is journaled in `~/.sun/evolution/journal.md`.

## Reflection

`reflect(sessionId)` sends an abridged transcript to the session's model with: existing memory, already-proposed titles (to avoid repeats), and a context line stating which rules were injected into the system prompt and that the transcript itself is abridged (prevents false findings such as "never read AGENTS.md"). Output: at most 5 proposals as JSON.

Triggers: desktop Evolution page, `/reflect` in chat, `sun evolve reflect <id>`. Intel adds `feature` proposals daily.

## The research loop

```
intel (daily) → feature proposals → accept into backlog → spec (specs/NNN) → code + tests → manual + teaching page → intel again
```
