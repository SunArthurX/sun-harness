# CLI

```text
sun [chat] [--mode coding|agent|assistant] [--model provider/model] [--cwd dir]
sun run "<prompt>" [--mode ..] [--model ..] [--approval suggest|auto-edit|full-auto] [--json]
sun resume <sessionId> [--model provider/model] [--chat]
sun sessions | sun show <sessionId>
sun models | sun modes
sun init
sun intel run [--force] | analyze <date> | list | show [date] | install-schedule | uninstall-schedule
sun kb search <query> | add <title> <file|-> | stats
sun evolve reflect <sessionId> | list [pending|accepted|rejected] | accept <id> | reject <id>
sun skills | sun mcp | sun plugins | sun schedules
sun doctor
sun desktop
```

## Exit codes (`run`, `resume`)

| Code | Meaning |
|---|---|
| 0 | finished (`idle`) |
| 3 | paused (quota, auth, rate limit, network, step limit) — resumable |
| 1 | error or aborted |

`--json` prints `{ sessionId, status, reason, text }` for scripting.

## Approvals in the terminal

In an interactive terminal, approvals prompt `[y]es / [n]o / [a]lways`. When stdin is not a TTY (pipes, cron, launchd), there is no approver: approvals are **denied with a reason** and the agent continues (see `specs/008-approval-policy.md`). Use `--approval full-auto` for trusted unattended runs.

## Chat slash commands

| Command | Effect |
|---|---|
| `/model [ref]` | list ready models, or switch this session |
| `/mode <id>` | switch mode |
| `/resume [model]` | resume a paused session, optionally on another model |
| `/abort` | stop the current run (Ctrl+C also aborts; Ctrl+C when idle exits) |
| `/reflect` | create evolution proposals from this session |
| `/sessions` | list sessions |
| `/exit` | quit |
