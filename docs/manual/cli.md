# CLI

```text
sun [chat] [--mode coding|plan|agent|assistant] [--model provider/model] [--cwd dir] [--worktree]
sun run "<prompt>" [--mode ..] [--model ..] [--approval suggest|auto-edit|full-auto] [--worktree] [--json]
sun run "<prompt>" --best-of N [--model a,b] [--apply]     parallel worktree attempts judged by your tests
sun resume <sessionId> [--model provider/model] [--chat]
sun undo <sessionId> [--steps n]                         revert the last edit steps (checkpoints)
sun sessions | sun show <sessionId>
sun models | sun modes
sun init
sun intel run [--force] | analyze <date> | list | show [date] | install-schedule | uninstall-schedule
sun kb search <query> | add <title> <file|-> | index | stats
sun evolve reflect <sessionId> | list [pending|accepted|rejected] | accept <id> | reject <id>
sun worktree list | status <id> | diff <id> | merge <id> [--strategy squash|merge] | discard <id>
sun skills | sun mcp | sun plugins | sun schedules
sun serve [--port 4471] [--host 127.0.0.1]
sun serve --tls [--host 0.0.0.0] [--insecure]
sun gateway status | url | install [--tls --host ..] | uninstall
sun gateway token create <device> | list | revoke <id|name>
sun remote add <name> <url> --token <t> [--fingerprint <sha256>] | list | use <name> | off | remove <name>
sun doctor
sun desktop
```

Session commands (`chat`, `run`, `resume`, `sessions`) use `--remote <name>`, else the default remote, else a running local gateway; `--local` runs them in-process. See [Gateway](gateway.md).

## Exit codes (`run`, `resume`)

| Code | Meaning |
|---|---|
| 0 | finished (`idle`) |
| 3 | paused (quota, auth, rate limit, network, step limit) — resumable |
| 1 | error or aborted |

`--json` prints `{ sessionId, status, reason, text }` for scripting.

## Approvals in the terminal

In an interactive terminal, approvals prompt `[y]es / [n]o / [a]lways`. Anything typed before the prompt appeared is discarded (you are asked again), so a half-written message or a stray Enter can never approve a command. When stdin is not a TTY (pipes, cron, launchd), there is no approver: approvals are **denied with a reason** and the agent continues (see `specs/008-approval-policy.md`). Use `--approval full-auto` for trusted unattended runs.

## Chat slash commands

| Command | Effect |
|---|---|
| `/model [ref]` | list ready models, or switch this session |
| `/mode <id>` | switch mode (`coding`, `plan`, `agent`, `assistant`) |
| `/undo [n]` | revert the last n edit steps (default 1); see [Coding](coding.md#undo) |
| `/resume [model]` | resume a paused session, optionally on another model |
| `/abort` | stop the current run (Ctrl+C also aborts; Ctrl+C when idle exits) |
| `/reflect` | create evolution proposals from this session |
| `/sessions` | list sessions |
| `/exit` | quit |
